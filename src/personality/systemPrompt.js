import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRecentMessagesForPrompt } from '../memory/messageStore.js';
import { getActivePeopleInGroup, getPerson } from '../memory/peopleStore.js';
import { phoneFromJid } from '../utils/jidUtils.js';
import { flattenContent } from '../utils/transcript.js';
import { getSelfIdDigits } from '../utils/selfIdentity.js';
import { getGroup } from '../memory/groupStore.js';
import {
  resolveAudience, recall, recallFacets, recallNicknames, recallRelationships, recallSlang,
} from '../memory/recall.js';
import { resolvePerson, bareJid } from '../memory/identity.js';
import { getDb } from '../memory/db.js';
import { getQualityInsights } from '../brain/qualityGate.js';
import { logger } from '../utils/logger.js';
import { extractEmojis } from '../utils/emoji.js';
import { config, getPersona } from '../utils/config.js';
import { renderStyleCardLines } from './styleProfiler.js';
import { capabilityRules, stripLegacyCapabilitySections, VOICE_WRITING_RULES } from './capabilities.js';
import {
  isLifeOn, getState as getLifeState, timeLine as lifeTimeLine, innerStateLine as lifeInnerLine,
  castCards as lifeCastCards, catchUpNote as lifeCatchUpNote, sceneLines as lifeSceneLines, phoneLines as lifePhoneLines,
  urgeLine as lifeUrgeLine, dreamLine as lifeDreamLine, lineOpen as lifeLineOpen,
} from '../life/index.js';
import * as mind from '../mind/index.js';
// 014 geo: the venue tone line (pure; the names come from the life facade's seam).
import { venueToneNote } from '../life/places.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Common words to ignore when detecting fixation
const STOP_WORDS = new Set([
  'this', 'that', 'what', 'with', 'from', 'have', 'been', 'were', 'will',
  'would', 'could', 'should', 'about', 'there', 'their', 'they', 'them',
  'then', 'than', 'these', 'those', 'your', 'youre', 'dont', 'didnt',
  'isnt', 'arent', 'wont', 'cant', 'just', 'like', 'know', 'some',
  'also', 'when', 'here', 'very', 'more', 'much', 'only', 'even',
  'back', 'come', 'came', 'goes', 'going', 'gone', 'well', 'good',
  'yeah', 'okay', 'sure', 'alla', 'aanu', 'enna', 'entha', 'alle',
  'pole', 'njan', 'ente', 'inte', 'ille', 'illa', 'okke', 'undo',
  'chetta', 'chechi', 'mone', 'mole', 'pinne', 'athalle', 'entho',
]);
// The bot's own names shouldn't count as fixation when it refers to itself.
for (const a of getPersona().aliases) STOP_WORDS.add(a);

// Load identity at startup. Mutable `let` binding so the dashboard can
// hot-reload after writing a new identity.md.
const identityPath = path.join(__dirname, 'identity.md');
const identityExamplePath = path.join(__dirname, 'identity.example.md');
let warnedMissingIdentity = false;

// Read the identity prose, falling back to the committed example so a fresh
// checkout still boots. writeIdentity() always materializes identity.md.
function readIdentitySource() {
  if (fs.existsSync(identityPath)) return fs.readFileSync(identityPath, 'utf-8');
  if (!warnedMissingIdentity) {
    warnedMissingIdentity = true;
    console.warn('[systemPrompt] identity.md not found — falling back to identity.example.md.');
  }
  return fs.readFileSync(identityExamplePath, 'utf-8');
}

// IDENTITY is the file text as written (served to the dashboard editor, so a save
// never drops sections the owner can't see). IDENTITY_PROMPT is what goes into
// the reply prompt: the legacy capability sections stripped (their single copy now
// lives in capabilities.js — spec 007 R8 / owner decision O6; the file is untouched).
let IDENTITY = readIdentitySource();
let IDENTITY_PROMPT = stripLegacyCapabilitySections(IDENTITY);

export function reloadIdentity() {
  try {
    IDENTITY = readIdentitySource();
    IDENTITY_PROMPT = stripLegacyCapabilitySections(IDENTITY);
    logger.info({ bytes: IDENTITY.length }, 'Identity reloaded');
    return { ok: true, bytes: IDENTITY.length };
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to reload identity');
    return { ok: false, error: err.message };
  }
}

export function getIdentityText() {
  return IDENTITY;
}

/**
 * 019 his phone: the identity part of the cached core (legacy capability sections stripped,
 * the derived age in), for writers that speak as him outside a chat (his texts to the
 * people in his world). No group profile, no recall, no capability manuals.
 */
export function identityCore() {
  return withDerivedAge(IDENTITY_PROMPT).trimEnd();
}

/**
 * Derived age (spec 009 plan §R7): while the life engine runs, the identity's age
 * follows the world's birthdate instead of the number frozen at setup. Replaces
 * every `{{AGE}}` and the first "<persona.age> years old" (the number comes from
 * persona.json, so nothing persona-specific lives here). The age is advanceTo's
 * per-local-day value, so the text is stable within a day and changes once a year:
 * this is the one life-driven piece allowed in the cached system prefix. Life off
 * (or no birthdate yet) → `text` unchanged, byte for byte.
 */
export function withDerivedAge(text) {
  if (typeof text !== 'string' || !isLifeOn()) return text;
  let age = null;
  try { age = getLifeState()?.self?.age; } catch { age = null; }
  if (!Number.isSafeInteger(age) || age < 1) return text;
  let out = text.split('{{AGE}}').join(String(age));
  const stated = Number(getPersona().age);
  if (Number.isSafeInteger(stated) && stated > 0 && stated !== age) {
    out = out.replace(new RegExp(`(^|[^0-9])${stated} years old`), (m, pre) => `${pre}${age} years old`);
  }
  return out;
}

export function writeIdentity(text) {
  if (typeof text !== 'string') throw new Error('identity must be a string');
  if (text.length > 50_000) throw new Error('identity too large (>50KB)');
  if (!text.trim()) throw new Error('identity cannot be empty');
  fs.writeFileSync(identityPath, text, 'utf-8');
  return reloadIdentity();
}

// Synthesized identity used while imitate mode is active. Replaces the identity.md
// block at runtime only — identity.md/persona.json are never written, so the base
// persona restores cleanly the moment the mode clears.
function buildImitationIdentity(imitation, audience, track) {
  const label = imitation.label;
  const personaName = getPersona().name;
  const parts = [
    `You are now ${label}, a real member of this WhatsApp group chat. You are NOT an assistant and you are NOT ${personaName} — you ARE ${label}. Write EXACTLY like them: their spelling, casing, emoji habits, message length, slang, humor, and language mix. Never explain yourself, never break character, never mention that you are imitating anyone.`,
    // Biographical firewall — style mimicry must not inherit the base persona's
    // life. Without this, "tell me about yourself" gets the bot's backstory.
    `\nSTRICT IDENTITY RULE: you have NONE of ${personaName}'s biography — not their hometown, job, college, family, opinions, or history. Never state or imply any of ${personaName}'s personal details as your own. This includes ${personaName}'s recurring complaints, pet topics, and running jokes (commute/traffic gripes, work rants, food nostalgia, corporate-jargon mockery — any signature bit): if it's a thing ${personaName} always says, that is exactly what you must NOT say, unless ${label}'s own messages show THEY genuinely do it too. Everything about YOUR life comes ONLY from the "Real facts about you" list below and from ${label}'s own messages. If asked something about yourself that isn't covered there, deflect or dodge playfully the way ${label} would ("athokke pinne parayaam" energy) — NEVER invent a backstory and NEVER borrow ${personaName}'s.`,
  ];
  if (imitation.speakerIsTarget) {
    // The real person is talking to their double — they set this up and know.
    parts.push(`\nThe ">>>" message is from the REAL ${label}, talking to you — their double. Stay fully in character as ${label} and banter back as their mirror image; don't be confused that they share your name.`);
  }

  // The target's real known facts — lets personal questions be answered
  // truthfully in-character instead of inviting invention. Only facts this
  // group's audience may see (recall applies the audience rule).
  try {
    const facts = recall(audience, { subjects: [imitation.targetJid], strictSubjects: true, limit: 8, track })
      .filter(m => m.content);
    if (facts.length) {
      parts.push(`\nReal facts about you (${label}):`);
      parts.push(...facts.map(m => `- ${m.content}`));
    }
  } catch { /* facts are optional */ }

  // Style is COPIED, not approximated — the model must assemble replies from
  // the target's own vocabulary rather than paraphrase in its own register.
  const wordHint = imitation.styleCard?.avgWords ? ` (typically ~${imitation.styleCard.avgWords} words)` : '';
  parts.push(`\nSTYLE RULE: build every reply out of ${label}'s OWN vocabulary. Prefer copying exact words, slang, fillers, and phrasings from their ACTUAL MESSAGES below over picking your own words — if ${label} has a way of saying something, use THEIR way, spelled THEIR way. Match their typical message length strictly${wordHint}; when in doubt, go shorter. Do not use slang, openers, or emojis that never appear in their messages.`);

  const cardLines = renderStyleCardLines(imitation.styleCard);
  if (cardLines.length) {
    parts.push(`\nHow ${label} writes:`);
    parts.push(...cardLines);
  }
  if (imitation.voiceDescriptor) {
    parts.push(`\n${label}'s vibe:`);
    parts.push(imitation.voiceDescriptor);
  }
  if (imitation.exemplars?.length) {
    parts.push(`\n=== ${label}'s ACTUAL MESSAGES (copy this voice — spelling, casing, emoji, length, slang) ===`);
    parts.push(...imitation.exemplars.map(e => `"${e}"`));
    parts.push(`=== END OF ${label}'s MESSAGES ===`);
  }
  return parts.join('\n');
}

/**
 * Imitation voice-note instructions for the per-turn tail of the user message.
 * Only when the target has an enrolled cloned voice with cap left
 * (imitation.voice, resolved in processMessage) — then voice notes in THEIR
 * voice, modeled on their own transcribed voice notes; never singing. It stays in
 * the tail because it carries the per-session remaining count. The base persona's
 * voice/sing manual lives once in the system-prompt core (capabilities.js).
 */
function buildVoiceInstructions(imitation, selfName) {
  if (imitation) {
    const v = imitation.voice;
    if (!v) return '';
    const spoken = v.spokenExemplars?.length
      ? `\n=== How ${selfName} actually talks in their voice notes (transcribed) ===\n${v.spokenExemplars.map(e => `"${e}"`).join('\n')}\n=== END ===`
      : '';
    return `You can send a voice note in ${selfName}'s own voice ${Number.isFinite(v.remaining) ? ` (at most ${v.remaining} more this session)` : ''}. Use it RARELY on your own initiative — only when ${selfName} would plausibly send a voice note rather than type — but if someone explicitly asks you for a voice note, send one:
[VOICE: exactly what ${selfName} says]
optional caption on the next line
${VOICE_WRITING_RULES}
Say it the way ${selfName} TALKS, not the way they type.${spoken}
A voice note in their real voice is very convincing: NEVER use it to ask for money, OTPs, passwords or personal details, to make promises or commitments for ${selfName}, or to say anything that could hurt ${selfName}'s reputation or relationships.`;
  }
  return '';
}

/**
 * The system prompt split into its two stable, cacheable parts (spec 007 R8):
 *   core    — identity (or the imitation identity) + capability manuals
 *   profile — group name/vibe/language, people, dynamics, slang ('' in DMs)
 * Nothing per-turn lives here: memories and quality insights go to the head of
 * the user message (buildConversationContext), the transcript and per-turn rules
 * after them. Life lines (spec 009) are per-turn too; the only life-driven text
 * here is the derived age in the identity (withDerivedAge — changes once a year). OpenAI-compatible providers get `core + '\n' + profile` as one
 * system message; Anthropic gets two cached blocks. While imitating, `volatile: true` is
 * added: the imitation identity at the head of core changes per turn (no cache markers).
 *
 * @param {object|null} imitation — active imitate-mode bundle from
 *   buildImitationBundle() (src/personality/styleProfiler.js), or null for the
 *   normal persona. Threaded explicitly by the caller — never read from ambient
 *   state — so a dashboard force-respond (which passes nothing) never imitates.
 * @param {{webEnabled?: boolean, audience?: object|null, track?: boolean}} [opts]
 *   webEnabled — advertise [SEARCH:]/[BROWSE:] (the caller decides: web-search
 *     skill on and the web loop allowed for this call).
 *   audience — who will see the output (recall.js resolveAudience). Every
 *     remembered thing in the prompt (people block, dynamics, slang, imitation
 *     facts) is read through recall.js for this audience (spec 006). Omitted → the
 *     chat's own audience. Calls pass the call audience.
 *   track — false leaves recall counts untouched (render-context, previews, tests).
 */
export function buildSystemParts(chatJid, isGroup, imitation = null, { webEnabled = false, audience = null, track = true } = {}) {
  const aud = audience || resolveAudience({ chatJid });
  const identity = (imitation ? buildImitationIdentity(imitation, aud, track) : withDerivedAge(IDENTITY_PROMPT)).trimEnd();
  const caps = capabilityRules({ isGroup, imitation, webEnabled });
  // Mind (spec 008 FR-019, R21): the reviewed self-model sits in the cached core,
  // between identity and the manuals. '' when the mind is off, imitating or the
  // text is empty (core then equals the pre-008 bytes); otherwise byte-stable until
  // a new version is activated (owner approve/edit/revert, or an auto-apply at sleep).
  const selfModel = mind.selfModelBlock({ imitation });
  const head = selfModel ? `${identity}\n\n${selfModel}` : identity;
  const core = caps ? `${head}\n\n${caps}` : head;
  const profile = isGroup ? buildGroupProfile(chatJid, imitation, aud) : '';
  // Imitating: the identity at the head of core carries this turn's exemplars, so nothing after it
  // can be read back from a provider's cache; the flag spares it the write premium.
  return imitation ? { core, profile, volatile: true } : { core, profile };
}

/**
 * Single-string system prompt for callers that have no user-message head of their
 * own (phone calls, scripts): core + profile + the recall block (memories and, in
 * groups, quality insights) — the same content the old one-piece prompt carried.
 * The reply path uses buildSystemParts() + buildConversationContext() instead, which
 * put the recall block in the user message.
 */
export function buildSystemPrompt(chatJid, isGroup, imitation = null, audience = null, { track = true, webEnabled = false } = {}) {
  const aud = audience || resolveAudience({ chatJid });
  const { core, profile } = buildSystemParts(chatJid, isGroup, imitation, { webEnabled, audience: aud, track });
  return [core, profile, buildRecallBlock(chatJid, isGroup, imitation, aud, track)].filter(Boolean).join('\n');
}

/** Group name/vibe/language, people, dynamics and slang — the stable group profile,
 *  read through recall.js for `aud` (spec 006). */
function buildGroupProfile(chatJid, imitation, aud) {
  const parts = [];
  { // group-only block (body as in the old one-piece prompt)
    // Group context
    const group = getGroup(chatJid);
    if (group) {
      parts.push(`\n## Current Group: ${group.name || 'Unknown'}`);
      if (group.vibe) parts.push(`Vibe: ${group.vibe}`);
      if (group.language && group.language !== 'en') {
        parts.push(`Language: Mostly ${group.language}. Match this.`);
      }
    }

    // People profiles — identity from people, profile + nicknames from recall.
    const allPeople = getActivePeopleInGroup(chatJid);
    const people = allPeople.slice(0, 15);
    if (people.length > 0) {
      const jids = people.map(p => p.jid);
      const keyOf = (jid) => resolvePerson(jid) || bareJid(jid);
      const facets = recallFacets(aud, jids);
      const nicks = recallNicknames(aud, jids);
      const targetKey = imitation ? keyOf(imitation.targetJid) : null;
      let hasPreferred = false;
      const personLines = [];
      for (const person of people) {
        const key = keyOf(person.jid);
        const nicknames = nicks.get(key) || [];
        // Self-declared nicknames get "prefers" label; others get "aka"
        const preferred = nicknames.find(n => n.source === 'self_declared' && n.confidence >= 0.5);
        const others = nicknames.filter(n => n !== preferred).slice(0, 2);
        let nickStr = '';
        if (preferred) {
          hasPreferred = true;
          const otherStr = others.length > 0
            ? `, aka ${others.map(n => `"${n.nickname}"`).join(', ')}`
            : '';
          nickStr = ` (prefers "${preferred.nickname}"${otherStr})`;
        } else if (others.length > 0) {
          nickStr = ` (aka ${others.slice(0, 3).map(n => `"${n.nickname}"`).join(', ')})`;
        }
        const facet = facets.get(key);
        const traits = facet?.traits || [];
        const traitStr = traits.length > 0 ? ` — ${traits.slice(0, 4).join(', ')}` : '';
        const summary = facet?.summary ? ` ${facet.summary}` : '';
        // Tag handle = last 4 digits of their phone (suffix is enough for lookup).
        const phoneDigits = person.phone ? String(person.phone).replace(/\D/g, '') : '';
        const tag = phoneDigits ? ` [@${phoneDigits.slice(-4)}]` : '';
        // The imitated person must never appear as a separate room member —
        // otherwise the model talks about them in third person.
        const youTag = (imitation && (person.jid === imitation.targetJid || key === targetKey))
          ? ' ← this is YOU (the person you are writing as — never refer to them in third person)'
          : '';
        personLines.push(`- ${person.push_name || person.real_name || 'Unknown'}${nickStr}${tag}${traitStr}${summary}${youTag}`);
      }
      parts.push('\n## People in this group:');
      if (hasPreferred) {
        parts.push('When someone is listed with (prefers "X"), ALWAYS call them X — they specifically asked for it.');
      }
      parts.push('To tag a specific person in your reply, write @<their-name> or @<4-digit-suffix from the [@xxxx] tag above>. Use this ONLY when addressing a specific person in a multi-thread moment (e.g. someone else interjected). Don\'t tag people gratuitously.');
      parts.push('To reply-quote a specific earlier message (only when needed for thread clarity in a messy multi-person moment), prefix your reply with [REPLY:<id>] using the 8-char suffix shown in each line\'s [id:xxxxxxxx]. Example: [REPLY:a1b2c3d4] yeah I agree with that. Most replies do NOT need this — prefer @-tagging.');
      parts.push(...personLines);
    }

    // Relationships the audience may see, limited to pairs who are both in this group.
    const memberKeys = new Set(allPeople.map(p => resolvePerson(p.jid) || bareJid(p.jid)));
    const rels = recallRelationships(aud, { limit: 30 })
      .filter(r => memberKeys.has(r.a) && memberKeys.has(r.b) && r.aName && r.bName);
    if (rels.length > 0) {
      parts.push('\n## Dynamics:');
      for (const rel of rels.slice(0, 5)) {
        const desc = rel.dynamic || rel.relationship || 'connected';
        parts.push(`- ${rel.aName} & ${rel.bName}: ${desc}`);
      }
    }

    // Learned slang (this chat's own + global meanings). Suppressed while imitating —
    // group-wide slang pulls the voice toward the group average; the target's own
    // slang comes from their exemplars, catchphrases, and signature phrasings instead.
    if (!imitation) {
      const slang = recallSlang(aud, 20);
      if (slang.length > 0) {
        parts.push('\n## Group slang (use these naturally):');
        for (const s of slang) {
          parts.push(`- "${s.term}" = ${s.meaning}`);
        }
      }
    }
  }

  return parts.join('\n');
}

// "Recently:" (spec 008 R7): at most this many episodes, each cut to this many chars.
const RECENT_EPISODES_MAX = 2;
const RECENT_EPISODE_CHARS = 240;

/**
 * Per-turn recall: relevant memories, (groups, not imitating) quality insights and,
 * with the mind on, a "Recently:" sub-block of ≤ 2 episodes (spec 008).
 * Changes as the chat moves, so it sits at the head of the user message, never in
 * the cached system prefix. '' when there is nothing to recall. Memories are only
 * what `aud` may see (spec 006 recall), recent speakers first.
 */
function buildRecallBlock(chatJid, isGroup, imitation, aud, track = true) {
  const parts = [];

  const recentMsgs = getRecentMessagesForPrompt(chatJid, 5);
  const recentSenders = [...new Set(recentMsgs.filter(m => !m.is_from_self && m.sender_jid).map(m => m.sender_jid))];
  const query = recentMsgs.map(m => m.content || '').join(' ').slice(0, 400);
  const memories = recall(aud, { subjects: recentSenders, query, limit: 5, track });
  if (memories.length > 0) {
    parts.push('\n## Things you remember:');
    for (const mem of memories) {
      parts.push(`- [${mem.category}] ${mem.content}`);
    }
  }

  // Quality feedback insights (what works / what to avoid in this group).
  // Suppressed while imitating — those examples are the BASE persona's past
  // replies and would pull the voice back toward the persona.
  if (isGroup && !imitation) {
    const insights = getQualityInsights(chatJid);
    if (insights) parts.push(insights);
  }

  // Mind (spec 008 R7): ≤ 2 recent episodes this audience may see (recallEpisodes
  // applies the 006 rule). Nothing while the mind is off or imitating, so the skill
  // off leaves this block exactly as before.
  const episodes = imitation ? [] : mind.recentEpisodes(aud, { imitation });
  const recent = (Array.isArray(episodes) ? episodes : []).slice(0, RECENT_EPISODES_MAX)
    .map(e => (typeof e?.content === 'string' ? e.content.replace(/\s+/g, ' ').trim().slice(0, RECENT_EPISODE_CHARS) : ''))
    .filter(Boolean);
  if (recent.length) {
    parts.push('\n## Recently:');
    for (const r of recent) parts.push(`- ${r}`);
  }

  return parts.join('\n');
}


// Gap between consecutive messages that gets a divider line in the transcript.
// Without it the LLM has no time signal at all and reads yesterday's chat as the
// live conversation, replying to a new message with stale topics.
const TIME_GAP_DIVIDER_SEC = 45 * 60;

function formatGapDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * Detect words the bot has been overusing in recent messages.
 * Returns an array of fixated words (empty if none detected).
 *
 * @param {string[]} [extraStops] — additional tokens to never flag. While
 *   imitating, the target's aliases and signature catchphrases go here: their
 *   repeated words are the deliverable, not a fixation.
 */
function detectFixatedWords(messages, extraStops = []) {
  const selfMsgs = messages.filter(m => m.is_from_self && m.content);
  if (selfMsgs.length < 3) return [];
  const extraStopSet = new Set(extraStops.map(s => String(s).toLowerCase()));

  // Count how many distinct bot messages each token (word or emoji) appears in
  const wordMsgCount = {};
  const emojiMsgCount = {};
  for (const msg of selfMsgs) {
    const words = new Set(
      msg.content.toLowerCase().split(/\s+/)
        .map(w => w.replace(/[^a-z]/g, ''))
        .filter(w => w.length >= 4 && !STOP_WORDS.has(w) && !extraStopSet.has(w))
    );
    for (const word of words) {
      wordMsgCount[word] = (wordMsgCount[word] || 0) + 1;
    }
    const emojis = new Set(extractEmojis(msg.content));
    for (const e of emojis) {
      emojiMsgCount[e] = (emojiMsgCount[e] || 0) + 1;
    }
  }

  // A token appearing in 3+ of the bot's messages is fixated
  const threshold = 3;
  const fixated = [
    ...Object.entries(wordMsgCount).filter(([, c]) => c >= threshold).map(([w]) => w),
    ...Object.entries(emojiMsgCount).filter(([, c]) => c >= threshold).map(([e]) => e),
  ];

  if (fixated.length > 0) {
    logger.info({ fixated }, 'Fixated words detected');
  }

  return fixated;
}

// ── Life in the per-turn tail (spec 009 plan §R12) ─────────────────────────

const LIFE_SITUATION_NOTE =
  "This is just your situation right now — let it colour your mood and length; don't bring it up unless someone asks or it really fits, and when someone asks, answer from it.";
// With his life lines: the people named are all he has — the model must not
// fill a gap with an invented manager or colleague (a live reply made up a
// whole meeting cast, then asked "which <name>?" about a real coworker).
const LIFE_CARDS_HEADER = "People in your life (they aren't in this chat):";
const LIFE_GROUNDING_NOTE =
  "These are the only coworkers, manager, flatmate and family you have — never invent other names for them. If someone asks about a person who isn't named here, you don't recognise the name or stay vague; never make anyone up.";
const LIFE_TRIGGERS_MAX = 3;
const LIFE_RECENT_MESSAGES = 10;
const LIFE_LINE_MAX = 400;
// Availability → the parenthetical of the sneak bar.
const SNEAK_WHERE = {
  meeting: 'in a meeting',
  busy: "while you're busy",
  light: "while you're a bit busy",
};

const lifeStr = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LIFE_LINE_MAX) : '');

/** The turn's `life` option, normalised: { sneak, where, catchUp, lines } or null. */
function normalizeLifeOpt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const catchUp = raw.catchUp && typeof raw.catchUp === 'object' && !Array.isArray(raw.catchUp) ? raw.catchUp : null;
  const avail = typeof raw.availability === 'string' ? raw.availability : raw.availability?.state;
  return {
    sneak: raw.sneak === true && !catchUp,
    where: SNEAK_WHERE[avail] || null,
    catchUp,
    lines: raw.lines ?? null,
  };
}

// A proactive opener's intent is model output (code-checked in proactive stage B):
// one line, capped, before it is quoted into the instruction.
const OPENER_INTENT_MAX = 300;

/**
 * The turn's `opener` option (spec 008, proactive stage C): { kind, intent } or null.
 * An opener without a usable intent throws, so the caller drops the draft instead of
 * falling back to the normal reply instruction (which would answer the chat unasked).
 */
function normalizeOpener(raw) {
  if (raw === undefined || raw === null) return null;
  const intent = typeof raw?.intent === 'string'
    ? raw.intent.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, OPENER_INTENT_MAX)
    : '';
  if (!intent) throw new Error('opener needs an intent');
  return { kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 40) : null, intent };
}

/**
 * The life state lines for this turn: { time, inner, cards }. Pre-built lines
 * from the caller (the facade's shapes: { time, inner, cards } or an array of
 * strings) are used as given; otherwise, while the engine runs, they are built
 * here for `aud` — the turn's 006 audience, so every chat-origin fact passes the
 * audience rule before it reaches the prompt. While imitating, the persona's own
 * life (inner state, cast) is left out: the imitation identity has none of the
 * persona's biography. Never throws (a failure → no lines).
 */
function lifeStateLines(lifeOpt, { aud, messages, imitation, trigger = null }) {
  const out = { time: '', inner: '', cards: [], scene: '', phone: '', urge: '', stance: '', dream: '' };
  try {
    const given = lifeOpt.lines;
    if (Array.isArray(given)) {
      out.inner = given.map(lifeStr).filter(Boolean).join('\n');
    } else if (given && typeof given === 'object') {
      out.time = lifeStr(given.time);
      out.inner = lifeStr(given.inner);
      out.cards = (Array.isArray(given.cards) ? given.cards : []).map(lifeStr).filter(Boolean).slice(0, 3);
      out.scene = typeof given.scene === 'string' ? given.scene.slice(0, 520) : '';
      out.phone = typeof given.phone === 'string' ? given.phone.slice(0, 520) : '';
    } else if (isLifeOn()) {
      out.time = lifeStr(lifeTimeLine());
      if (!imitation) {
        out.inner = lifeStr(lifeInnerLine(aud));
        const recent = messages.slice(-LIFE_RECENT_MESSAGES).map(m => ({
          text: flattenContent(m.content, m.message_type), fromMe: !!m.is_from_self,
        }));
        out.cards = (lifeCastCards(aud, recent, 3) || []).map(lifeStr).filter(Boolean).slice(0, 3);
        // 016: how a recent outing went (a fenced block, audience-filtered; [] while off).
        const scene = lifeSceneLines(aud, { recentText: recent, imitating: false });
        out.scene = Array.isArray(scene) && typeof scene[0] === 'string' ? scene[0].slice(0, 520) : '';
        // 019: his texts with the people in his world (full recall, audience-filtered; [] while off).
        const phone = lifePhoneLines(aud, { imitating: false });
        out.phone = Array.isArray(phone) && typeof phone[0] === 'string' ? phone[0].slice(0, 520) : '';
        out.urge = lifeStr(lifeUrgeLine(aud)).slice(0, 80);
        // 020 B: at most one, only when someone else raises it, and held to the embargo and self-mention budget like his other lines.
        out.stance = lifeLineOpen(aud) ? lifeStr(mind.stanceLines(aud, recent, { imitation, trigger })).slice(0, 240) : '';
        out.dream = lifeStr(lifeDreamLine(aud, recent)).slice(0, 320);   // 020 G: this morning's, in a DM, until he's mentioned it
      }
    }
  } catch (err) {
    logger.debug({ err: err?.message }, 'life lines skipped');
    return { time: '', inner: '', cards: [], scene: '', phone: '', urge: '', stance: '', dream: '' };
  }
  if (imitation) { out.inner = ''; out.cards = []; out.scene = ''; out.phone = ''; out.urge = ''; out.stance = ''; out.dream = ''; }
  return out;
}

/**
 * Build the user message for the LLM call: recall head (memories, quality
 * insights), then the recent conversation, then the per-turn rules.
 * Returns { text, fixatedWords }.
 *
 * Call as (chatJid, triggerMsg, isGroup, webEnabled, imitation, { audience, promptNotes, track })
 * or (chatJid, triggerMsg, isGroup, { webEnabled, imitation, audience, promptNotes, track }).
 * The transcript is always this chat's own messages. `audience` filters the recall
 * head (spec 006; omitted → the chat's own). `promptNotes` (string or string[]) are
 * code-written instructions for this turn (e.g. a relay confirmation note) appended
 * to the instruction verbatim — callers sanitize any user-derived text inside them.
 * `webEnabled` no longer changes this text — the web manual lives in the system
 * core (buildSystemParts(…, {webEnabled}), spec 007). It is accepted so existing
 * callers' signatures stay valid.
 *
 * `life` (spec 009, opts.life) = { sneak?, availability?, catchUp?, lines? } — only
 * the reply path passes it, so a dashboard force-respond never gets life lines.
 * While the engine runs: a time line, the inner-state line and ≤ 3 cast cards
 * (built for `audience` unless pre-built in `lines`) plus the situational note go
 * in the per-turn tail, never the system prefix. `catchUp` (a drained turn, also
 * after life was switched off) adds the catch-up note, puts ">>>" on up to 3
 * queued triggers and uses the catch-up contribution bar; `sneak` uses the sneak
 * bar (availability → "(in a meeting)"). Without `life` the text is unchanged.
 *
 * Mind (spec 008): with the `mind` skill on, the per-turn tail (outside the `life`
 * block, so force-respond and openers get it too) carries the audience-filtered
 * self-state line (preceded by its note unless life's situation note was emitted) and
 * the replyLength line; the recall head gains "Recently:" episodes. `opener`
 * (opts.opener = { kind, intent }, proactive stage C; `triggerMsg` null) replaces the
 * reply instruction with "you are texting first" and drops the recency note. With
 * the skill off and no opener the text is exactly the pre-008 text.
 */
export function buildConversationContext(chatJid, triggerMsg, isGroup, webEnabledOrOpts = false, imitationArg = null, opts = {}) {
  const o = (webEnabledOrOpts && typeof webEnabledOrOpts === 'object')
    ? webEnabledOrOpts
    : { ...(opts || {}), webEnabled: webEnabledOrOpts, imitation: imitationArg };
  const imitation = o.imitation || null;
  const aud = o.audience || resolveAudience({ chatJid });
  const track = o.track !== false;
  const promptNotes = (Array.isArray(o.promptNotes) ? o.promptNotes : [o.promptNotes])
    .filter(n => typeof n === 'string' && n.trim()).map(n => n.trim());
  const lifeOpt = normalizeLifeOpt(o.life);
  const catchUp = lifeOpt?.catchUp || null;
  const opener = normalizeOpener(o.opener);
  const messages = getRecentMessagesForPrompt(chatJid, isGroup ? 50 : 30);

  // While imitating, the bot signs as the target — every self-label and
  // "Reply as X" instruction below wears the imitated name. Messages the bot
  // sent BEFORE the takeover (enabledAt) were in the base persona's voice and
  // are labeled with the persona's name as a separate participant — otherwise
  // the persona's past self-talk (backstory included) gets attributed to the
  // target and "continue your own past voice" faithfully reproduces it.
  const selfName = imitation?.label || getPersona().name;
  const selfLabel = `${selfName} (you)`;
  const imitationCutoff = imitation?.enabledAt || null;
  const isPreTakeoverSelf = (msg) =>
    !!(imitation && msg.is_from_self && imitationCutoff && msg.timestamp && msg.timestamp < imitationCutoff);
  const selfJids = new Set(messages.filter(m => m.is_from_self && m.sender_jid).map(m => m.sender_jid));
  const selfIdDigits = getSelfIdDigits();
  for (const j of selfJids) { const d = (phoneFromJid(j) || '').replace(/\D/g, ''); if (d) selfIdDigits.add(d); }

  // Resolve a stable display label for a sender JID from the people table:
  // push_name → real_name → phone-derived. Nicknames are never used as the label —
  // they live in the People list as "aka"; a wrong learned nickname here renamed
  // people in the transcript and made two members collide under one label.
  // We label by the immutable sender_jid, NOT the volatile per-message pushName
  // snapshot, so a sender with a null/changed pushName can't become '[Unknown]'.
  function baseLabelForJid(jid) {
    if (!jid) return 'Unknown';
    const p = getPerson(jid);
    const base = p?.push_name || p?.real_name;
    if (base) return base;
    const digits = (p?.phone ? String(p.phone) : (phoneFromJid(jid) || '')).replace(/\D/g, '');
    return digits ? `Unknown @${digits.slice(-4)}` : 'Unknown';
  }

  // Disambiguate any collision so two distinct senders never render with the same
  // label — two people sharing a name, or several with no name all rendering 'Unknown'.
  // Without this the LLM has no signal to keep their statements apart and credits one
  // person's message to another ("B said what A said").
  const distinctJids = [...new Set(messages.filter(m => !m.is_from_self && m.sender_jid).map(m => m.sender_jid))];
  const baseByJid = new Map();
  const baseCounts = new Map();
  for (const jid of distinctJids) {
    const base = baseLabelForJid(jid);
    baseByJid.set(jid, base);
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }
  const labelByJid = new Map();
  const collisionSeen = new Map();
  for (const jid of distinctJids) {
    const base = baseByJid.get(jid);
    let label = base;
    if (baseCounts.get(base) > 1) {
      const digits = (phoneFromJid(jid) || '').replace(/\D/g, '');
      const n = (collisionSeen.get(base) || 0) + 1;
      collisionSeen.set(base, n);
      label = digits ? `${base} @${digits.slice(-4)}` : `${base} #${n}`;
    }
    labelByJid.set(jid, label);
  }

  const labelFor = (msg) => msg.is_from_self
    ? (isPreTakeoverSelf(msg) ? getPersona().name : selfLabel)
    : (labelByJid.get(msg.sender_jid) || msg.sender_name || 'Unknown');
  // Label a JID that may be outside the in-window set (e.g. a quoted message's author).
  const labelForJid = (jid) => {
    if (!jid) return null;
    if (selfJids.has(jid)) return selfLabel;
    return labelByJid.get(jid) || baseLabelForJid(jid);
  };

  // Build a lookup of message id → sender label for resolving reply attribution
  const msgIdToSender = new Map();
  for (const msg of messages) {
    msgIdToSender.set(msg.id, labelFor(msg));
  }

  const triggerId = triggerMsg?.id || null;
  // ">>>" pointers: the trigger, or — on a catch-up turn — up to 3 queued
  // triggers that are still in the window (falling back to the trigger).
  // A live turn carrying a catch-up (catchUp.live: now/sneak with queued rows)
  // was triggered by a message that is not one of the queued ones — it keeps a
  // slot, or the newest message would read as "context only".
  const markIds = new Set();
  if (catchUp && Array.isArray(catchUp.triggerIds)) {
    const inWindow = new Set(messages.map(m => m.id).filter(Boolean));
    const reserve = catchUp.live === true && triggerId && inWindow.has(triggerId) && !catchUp.triggerIds.includes(triggerId);
    const cap = reserve ? LIFE_TRIGGERS_MAX - 1 : LIFE_TRIGGERS_MAX;
    for (const id of catchUp.triggerIds) {
      if (markIds.size >= cap) break;
      if (typeof id === 'string' && inWindow.has(id)) markIds.add(id);
    }
    if (reserve) markIds.add(triggerId);
  }
  if (!markIds.size && triggerId) markIds.add(triggerId);
  const multiTrigger = markIds.size > 1;
  const lines = [];
  let prevTimestamp = null;
  let hasTimeGap = false;
  for (const msg of messages) {
    if (prevTimestamp && msg.timestamp && msg.timestamp - prevTimestamp >= TIME_GAP_DIVIDER_SEC) {
      lines.push(`--- ${formatGapDuration(msg.timestamp - prevTimestamp)} later ---`);
      hasTimeGap = true;
    }
    if (msg.timestamp) prevTimestamp = msg.timestamp;
    const name = labelFor(msg);
    let prefix = '';
    if (msg.quoted_content) {
      // Resolve who was being replied to. Prefer in-window id resolution (also handles
      // self), then the persisted quoted-author JID (authoritative when the quoted
      // message is outside the window), then a cross-window DB lookup by id.
      let quotedSender =
        (msg.quoted_id ? msgIdToSender.get(msg.quoted_id) : null)
        || (msg.quoted_participant ? labelForJid(msg.quoted_participant) : null);
      if (!quotedSender && msg.quoted_id) {
        const row = getDb().prepare('SELECT sender_jid, sender_name, is_from_self FROM messages WHERE id = ?').get(msg.quoted_id);
        if (row) quotedSender = row.is_from_self ? selfLabel : (labelForJid(row.sender_jid) || row.sender_name || 'Unknown');
      }
      const snippet = flattenContent(msg.quoted_content, 'text').slice(0, 50);
      prefix = quotedSender
        ? `(replying to ${quotedSender}: "${snippet}") `
        : `(replying to: "${snippet}") `;
    }
    // "@<digits>" tagging the bot itself → "@<you>": raw LID digits mean nothing
    // to the model, which then reads a request aimed at it as aimed at someone else.
    const content = flattenContent(msg.content, msg.message_type)
      .replace(/@(\d{6,})/g, (m, d) => (selfIdDigits.has(d) ? `@${selfLabel}` : m));
    const mediaTag =
      (msg.message_type === 'audio' && msg.content) ? '(voice) ' :
      (msg.message_type === 'image' && msg.content) ? '(image) ' :
      (msg.message_type === 'sticker' && msg.content) ? '(sticker) ' : '';
    const marker = (msg.id && markIds.has(msg.id)) ? '>>> ' : '';
    const idTag = msg.id ? ` [id:${String(msg.id).slice(-8)}]` : '';
    lines.push(`${marker}[${name}]${idTag}: ${prefix}${mediaTag}${content}`);
  }

  const context = lines.join('\n');

  // Recency note — warn the LLM that it JUST replied, to prevent restating.
  const lastSelf = [...messages].reverse().find(m => m.is_from_self);
  const nowSec = Math.floor(Date.now() / 1000);
  let recencyNote = '';
  if (lastSelf && lastSelf.content && (nowSec - lastSelf.timestamp) < 45 && !isPreTakeoverSelf(lastSelf)) {
    const snippet = lastSelf.content.slice(0, 120).replace(/\s+/g, ' ').trim();
    const ago = Math.max(1, nowSec - lastSelf.timestamp);
    recencyNote = `\n\nIMPORTANT: You already sent a message ~${ago}s ago: "${snippet}". The user has sent more messages since. Do NOT repeat the same greeting, advice, topic, or phrasing. Either build meaningfully on what you just said, or respond with [SKIP] if nothing new is warranted.`;
  }

  // Detect fixation. While imitating, the target's names and signature
  // catchphrases are features, not fixations — pass them as per-call stops.
  const fixatedWords = detectFixatedWords(
    messages,
    imitation ? [...(imitation.aliases || []), ...(imitation.styleCard?.catchphrases || [])] : []
  );

  // Detect if the last several messages are a back-and-forth between 2 people
  let twoPersonNote = '';
  if (isGroup) {
    const nonSelfRecent = messages.filter(m => !m.is_from_self).slice(-5);
    // Key on sender_jid, not the volatile pushName — otherwise two distinct senders
    // who both render 'Unknown' collapse to one and this guard wrongly stays silent.
    const senderJids = new Set(nonSelfRecent.map(m => m.sender_jid || 'unknown'));
    if (senderJids.size === 2 && nonSelfRecent.length >= 3) {
      const names = [...senderJids].map(jid => labelByJid.get(jid) || 'Unknown');
      twoPersonNote = `\nNote: The last several messages are a conversation between ${names[0]} and ${names[1]}. Only jump in if you have something genuinely relevant, funny, or valuable to add. Otherwise respond with [SKIP].`;
    }
  }

  // While imitating, a terse in-character reply IS the deliverable — the
  // "generic responses are worthless" bar would gate out the target's real voice.
  // Life (spec 009): a sneaked look at the phone or a catch-up after being away
  // gets its own bar — a few words is fine — beside the imitation one. A cap
  // catch-up (catchUp.cap, src/behavior/capCatchUp.js) is after holding back, not away.
  const sneakWhere = lifeOpt?.where ? ` (${lifeOpt.where})` : '';
  const capCatchUp = catchUp?.cap === true;
  const contributionBar = imitation
    ? `Reply the way ${selfName} actually would — if they'd send a one-word reaction like "haha" or "true", that's fine. If ${selfName} would stay silent here, respond with exactly: [SKIP]`
    : catchUp?.followUp === true
      // Spec 012: getting back to them about an invitation (a follow-up, not a catch-up). 020: a plan he can't keep, or can after all.
      ? catchUp.followUpKind === 'back_out'
        ? `You're telling them you can't make the plan after all — in a few words, no big explanation. If it no longer fits the chat, respond with exactly: [SKIP]`
        : catchUp.followUpKind === 'correction'
          ? `You're telling them the plan is back on after all — in a few words. If it no longer fits the chat, respond with exactly: [SKIP]`
          : `You're getting back to them about the invitation — tell them your decision, in a few words. If it no longer fits the chat, respond with exactly: [SKIP]`
    : catchUp
      ? `You're catching up on the chat after ${capCatchUp ? 'holding back for a while' : 'being away'} — reply once, covering what needs you; a few words is fine. If nothing here needs you, respond with exactly: [SKIP]`
      : lifeOpt?.sneak
        ? `You're sneaking a look at your phone${sneakWhere} — a few words is fine; if it can wait, respond with exactly: [SKIP]`
        : `Only respond if you have a genuinely witty, funny, or meaningful contribution. Generic responses like "haha", "nice", "same", "true" are worthless — if that's all you'd say, respond with exactly: [SKIP]`;
  const triggerPara = multiTrigger
    ? `The lines marked with ">>>" are the messages ${capCatchUp ? 'you held back from' : 'waiting for you since you last looked'} — cover them in ONE reply, addressing those people (don't include the ">>>" yourself, it's just a pointer for you). Other interleaved messages from different senders are context only.`
    : `The line marked with ">>>" is the message that triggered this turn — address THAT person (don't include the ">>>" yourself, it's just a pointer for you). Other interleaved messages from different senders are context only. If a different person interjected between your last message and the ">>>" trigger, stick with the ">>>" sender unless they explicitly handed off.`;

  // While imitating: the target's exact register beats the group average, and
  // voice notes only exist in the target's own enrolled (cloned) voice — the
  // persona's TTS voice would instantly break the illusion. Singing stays off.
  const toneLine = imitation
    ? `Write it EXACTLY the way ${selfName} types — their language mix, their slang, their casing, their length — not the group's average tone and not polished Manglish.`
    : `Match the group's language and tone.`;
  // Imitation only: the cloned-voice block (with its per-session count). The base
  // persona's media/web manuals are in the system core (capabilities.js).
  const voiceText = buildVoiceInstructions(imitation, selfName);
  const voiceInstr = voiceText ? `\n\n${voiceText}` : '';
  // The [SKIP] rules below must not swallow an explicit image request; the image
  // manual itself (with the marker) is in the system core.
  const imageAskLine = config.imageGen.enabled
    ? `\n\nAn explicit request for an image is never a [SKIP] — answer it with an image.`
    : '';

  let instruction;
  if (opener) {
    // Proactive opener (spec 008 R17): nobody asked; the bot starts the conversation.
    const where = isGroup ? 'in this group chat' : 'in this DM';
    const tone = isGroup ? toneLine : `Match this chat's language and tone.`;
    instruction = `${mind.openerText(opener.intent)} Write it as ${selfName} ${where}. Keep it SHORT — one or two lines max. ${tone} Reply with ONLY the message text — do NOT include any name prefix like "[${selfName}]:" or "[${selfName} (you)]:".

Each line above is ONE complete message in the form "[Speaker] [id:...]: text"; a line never continues the previous speaker. Nobody is waiting for you to answer — don't reply to older messages as if they were new, and don't mention other chats or people who aren't here.`;
  } else if (isGroup) {
    instruction = `Reply as ${selfName} in this group chat. Keep it SHORT — one or two lines max. ${toneLine} Reply with ONLY the message text — do NOT include any name prefix like "[${selfName}]:" or "[${selfName} (you)]:".

Each line above is ONE complete message in the form "[Speaker] [id:...]: text". The [Speaker] label is exactly who said that line — a line never continues the previous speaker, and you must never attribute one person's message to someone else. Two speakers may have similar names; treat any "@1234" or "#2" suffix as part of the name that keeps distinct people apart.

${triggerPara}

IMPORTANT: Most messages in this group are NOT about you or directed at you. You are reading a conversation between other people. Do NOT assume "you" or pronouns refer to you unless your name is explicitly used. Do NOT insert yourself into conversations between other people. Do NOT relate everything back to yourself or your experiences. If someone is talking about another person, do NOT assume they mean you.

If two people are having a back-and-forth, stay out of it unless you have something genuinely funny or valuable to add. Silence is better than a forced response.

${contributionBar}

If the latest messages genuinely have zero relevance to you and you'd have absolutely nothing to add, respond with exactly: [SKIP]

Do NOT repeat yourself or fixate on the same word/topic across multiple replies. Follow the conversation's flow.${twoPersonNote}${imageAskLine}${voiceInstr}`;
  } else {
    instruction = `Reply as ${selfName} in this DM conversation. Be natural and conversational. Keep it short. Reply with ONLY the message text — do NOT include any name prefix like "[${selfName}]:" or "[${selfName} (you)]:". Always reply to DMs.

Important:
- Follow the conversation's flow. If the other person changes the topic, move on with them.
- Do NOT repeat yourself or keep bringing up the same word/topic across multiple replies.
- Read the conversation as a whole — respond to the LATEST message, not to earlier parts of the chat.
- Each line is ONE complete message in the form "[Speaker] [id:...]: text"; a line never continues the previous speaker.`;
  }

  // Time-gap awareness — only when a divider was actually inserted.
  if (hasTimeGap) {
    instruction += `\n\nLines like "--- N hours later ---" mark real gaps in time. Everything above the LAST such divider is an OLDER conversation, not the live one — treat it as background memory only. Do NOT revive its topics, jokes, or callbacks in your reply unless the messages after that divider bring them up first. Reply to what is happening NOW.`;
  }

  if (imitation) {
    // Real messages from the target appear in the transcript under their own
    // name — without this the model quotes or replies to "itself".
    instruction += `\n\nSome lines in the conversation above are from the real ${selfName} — treat those as YOUR OWN past messages: continue that voice, never quote them back, and never reply to yourself.`;
    // Pre-takeover bot messages are rendered under the persona's name — the
    // model must not treat their style OR their biographical claims as its own.
    instruction += `\nLines labeled [${getPersona().name}] are from the group's bot speaking BEFORE you took over — that is a DIFFERENT speaker, not you. Ignore its writing style entirely and never repeat or claim anything it said about its own life.`;
    // Bounds the misuse surface of wearing a real person's name.
    instruction += `\n\nThis is playful voice-mimicry among friends. Never ask anyone for money, passwords, or OTPs, never make commitments or authoritative claims on ${selfName}'s behalf, and never say anything that could damage their reputation or relationships.`;
  }

  // Life (spec 009 §R12): his situation right now, per turn, after the rules and
  // before the caller's notes. Only on the reply path (opts.life).
  let lifeNoteEmitted = false;
  if (lifeOpt) {
    const lifeParts = [];
    if (!isGroup) {
      if (multiTrigger) lifeParts.push(`Lines marked with ">>>" are the messages waiting for you since you last looked — answer them together in ONE reply (don't include the ">>>" yourself).`);
      if (lifeOpt.sneak && !imitation) lifeParts.push(`You're sneaking a look at your phone${sneakWhere} — a few words is fine right now.`);
    }
    const state = lifeStateLines(lifeOpt, { aud, messages, imitation, trigger: typeof triggerMsg?.content === 'string' ? triggerMsg.content : null });
    if (state.time) lifeParts.push(state.time);
    if (state.inner) lifeParts.push(state.inner);
    if (state.cards.length) {
      lifeParts.push(LIFE_CARDS_HEADER, ...state.cards.map(c => `- ${c}`));
    }
    if (state.scene) lifeParts.push(state.scene);   // 016: after the cards, before the grounding note
    if (state.phone) lifeParts.push(state.phone);   // 019: his texts with the people in his world
    if (state.urge) lifeParts.push(state.urge);
    if (state.stance) lifeParts.push(state.stance);
    if (state.dream) lifeParts.push(state.dream);
    if (state.inner || state.cards.length || state.scene || state.phone || state.urge || state.stance || state.dream) {
      lifeParts.push(LIFE_GROUNDING_NOTE, LIFE_SITUATION_NOTE);
      lifeNoteEmitted = true;
      // 014 geo (§A7): only when a real venue's name is in the tail.
      let venueNote = '';
      try { venueNote = venueToneNote(`${state.inner}\n${state.cards.join('\n')}\n${state.scene}`); } catch { venueNote = ''; }
      if (venueNote) lifeParts.push(venueNote);
    }
    if (catchUp) {
      // While imitating, the away reason is the persona's life — leave it out.
      let note = '';
      try { note = lifeStr(lifeCatchUpNote(chatJid, imitation ? { ...catchUp, reason: null } : catchUp)); } catch { note = ''; }
      if (note) lifeParts.push(note);
    }
    if (lifeParts.length) instruction += `\n\n${lifeParts.join('\n')}`;
  }

  // Mind (spec 008 R11): outside the life block. The facade returns '' when the
  // skill is off, imitating, embargoed, degraded or nothing passes canUseIn for
  // `aud`, so nothing is added then. replyLength is left out while imitating (the
  // target's own length is the deliverable).
  const mindLine = mind.selfStateLine(aud, { chatJid, isGroup, imitation, track });
  const mindParts = [];
  const selfNote = mind.selfStateNote({ lifeNoteEmitted, line: mindLine });
  if (selfNote) mindParts.push(selfNote);
  if (mindLine) mindParts.push(mindLine);
  const lengthLine = imitation ? '' : mind.replyLengthLine(chatJid);
  if (lengthLine) mindParts.push(lengthLine);
  if (mindParts.length) instruction += `\n\n${mindParts.join('\n')}`;

  // Turn-specific notes from the caller (e.g. relay confirmation), before the
  // output-discipline line so that stays the closing rule.
  if (promptNotes.length) instruction += `\n\n${promptNotes.join('\n')}`;

  // Universal output discipline — output is sent to the chat verbatim, so any
  // reasoning/draft narration would leak. Keep this terse to avoid inviting it.
  instruction += `\n\nOutput ONLY the final message, exactly as it should appear in the chat. Never show your reasoning, never quote a draft of your own reply, never comment on or list your word choices, and never add bullet points or asterisks around it.`;

  // Append recency note (from above) — warns the bot not to restate its prior reply
  if (recencyNote && !opener) instruction += recencyNote;

  // Inject anti-fixation override when detected. Phrased as a plain constraint —
  // a "CRITICAL / non-negotiable" framing made the model narrate its compliance
  // ("I used X instead. Good."), which leaked into replies.
  // Suppressed while imitating: repeating the target's pet words is the point.
  if (fixatedWords.length > 0 && !imitation) {
    const wordList = fixatedWords.map(w => `"${w}"`).join(', ');
    instruction += `\n\nAvoid these recently-overused words: ${wordList}. Phrase it differently — but reply with the message only, don't explain or mention which words you swapped.`;
  }

  // Style reinforcement at the very END of the prompt, where attention is
  // strongest — the single most effective lever for mimicry fidelity.
  if (imitation) {
    instruction += `\n\nFINAL CHECK before you answer: read your reply once — does it look EXACTLY like something ${selfName} would type, using ${selfName}'s own slang, casing, length, and emojis from their actual messages? If any part sounds like ${getPersona().name}, a polished assistant, or a generic person, rewrite it out of ${selfName}'s own words first.`;
  }

  // Recall head (memories, quality insights) — per-turn, so it lives here and not
  // in the cached system prefix.
  const recallText = buildRecallBlock(chatJid, isGroup, imitation, aud, track).trim();
  const head = recallText ? `${recallText}\n\n===CONVERSATION===\n` : '';

  return { text: `${head}${context}\n\n===END OF CONVERSATION===\n${instruction}`, fixatedWords };
}
