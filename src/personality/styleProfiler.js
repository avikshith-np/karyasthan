import { getDb } from '../memory/db.js';
import { getPerson } from '../memory/peopleStore.js';
import { resolveAudience, recallExemplars, recallNicknames } from '../memory/recall.js';
import { resolvePerson, identitiesOf, bareJid } from '../memory/identity.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { callRole } from '../brain/llm.js';
import { extractEmojis } from '../utils/emoji.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Imitate-mode style capture. Zero LLM on the hot path: a statistical "style
// card" computed in plain JS plus verbatim exemplar messages retrieved from the
// target's own history. Nothing is frozen — a silent provider fallback cannot
// corrupt the captured voice, only the final reply generation.
//
// Spec 006 R13: every verbatim input (corpus, topical and spoken exemplars,
// catchphrases, the LLM descriptor) comes from the CURRENT group only, read
// through recall.js — another chat's words never reach this group.

// Same intent as systemPrompt's STOP_WORDS but scoped to catchphrase mining:
// filler that is common to everyone shouldn't read as someone's signature.
const COMMON_WORDS = new Set([
  'this', 'that', 'what', 'with', 'from', 'have', 'been', 'were', 'will',
  'would', 'could', 'should', 'about', 'there', 'their', 'they', 'them',
  'then', 'than', 'these', 'those', 'your', 'youre', 'dont', 'didnt',
  'isnt', 'arent', 'wont', 'cant', 'just', 'like', 'know', 'some',
  'also', 'when', 'here', 'very', 'more', 'much', 'only', 'even',
  'back', 'come', 'came', 'goes', 'going', 'gone', 'well', 'good',
  'yeah', 'okay', 'sure', 'alla', 'aanu', 'enna', 'entha', 'alle',
  'pole', 'njan', 'ente', 'inte', 'ille', 'illa', 'okke', 'undo',
  'pinne', 'athalle', 'entho', 'because', 'really', 'where', 'which',
]);

const CARD_CACHE_TTL_MS = 5 * 60 * 1000;
const cardCache = new Map(); // `${groupJid}|${personJid}` → { card, at }

const EXEMPLAR_MAX_COUNT = 25;
const EXEMPLAR_MAX_CHARS = 2500;

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Compute a no-LLM statistical style card from a person's messages.
 * `messages` are messageStore rows (content non-null, text only).
 */
export function buildStyleCard(messages) {
  const texts = messages.map(m => m.content).filter(Boolean);
  if (!texts.length) return null;

  const lengths = texts.map(t => t.length).sort((a, b) => a - b);
  const wordCounts = texts.map(t => t.split(/\s+/).filter(Boolean).length);

  let emojiMsgs = 0;
  const emojiFreq = {};
  let lowercaseMsgs = 0;
  let terminalPunctMsgs = 0;
  let allCapsTokens = 0;
  let totalTokens = 0;
  let latinChars = 0;
  let malayalamChars = 0;
  const tokenFreq = {};

  for (const t of texts) {
    const emojis = extractEmojis(t);
    if (emojis.length) emojiMsgs++;
    for (const e of emojis) emojiFreq[e] = (emojiFreq[e] || 0) + 1;

    const letters = t.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3 && letters === letters.toLowerCase()) lowercaseMsgs++;
    if (/[.!?]\s*$/.test(t)) terminalPunctMsgs++;

    for (const ch of t) {
      if (/[A-Za-z]/.test(ch)) latinChars++;
      else if (/[ഀ-ൿ]/.test(ch)) malayalamChars++;
    }

    for (const raw of t.split(/\s+/)) {
      const word = raw.toLowerCase().replace(/[^a-zഀ-ൿ]/g, '');
      if (!word) continue;
      totalTokens++;
      if (raw.length >= 3 && /[A-Z]/.test(raw) && raw === raw.toUpperCase() && /[A-Z]{3,}/.test(raw)) {
        allCapsTokens++;
      }
      if (word.length >= 3 && !COMMON_WORDS.has(word)) {
        tokenFreq[word] = (tokenFreq[word] || 0) + 1;
      }
    }
  }

  // Signature phrases: tokens used in a meaningful share of messages.
  const catchphrases = Object.entries(tokenFreq)
    .filter(([, c]) => c >= 3 && c / texts.length >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  // Characteristic multi-word phrases (bigrams/trigrams): single tokens tell
  // the model WHAT words the person uses; phrases capture HOW they combine
  // them — the strongest slang-fidelity signal short of the raw exemplars.
  const ngramFreq = {};
  for (const t of texts) {
    const tokens = t.toLowerCase().split(/\s+/)
      .map(w => w.replace(/[^a-zഀ-ൿ]/g, ''))
      .filter(w => w.length >= 2);
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const parts = tokens.slice(i, i + n);
        if (!parts.some(w => w.length >= 3 && !COMMON_WORDS.has(w))) continue;
        const gram = parts.join(' ');
        if (gram.length < 6) continue;
        ngramFreq[gram] = (ngramFreq[gram] || 0) + 1;
      }
    }
  }
  const rankedGrams = Object.entries(ngramFreq)
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const phrases = [];
  for (const [gram] of rankedGrams) {
    if (phrases.length >= 6) break;
    // Skip a bigram already covered by a chosen longer phrase.
    if (phrases.some(p => p.includes(gram))) continue;
    phrases.push(gram);
  }

  const topEmojis = Object.entries(emojiFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e]) => e);

  // Behavioral features (consumed by the decision/timing layers in v3):
  // active-hour histogram in the configured timezone + burst propensity.
  const hourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hour: 'numeric', hour12: false,
  });
  const activeHours = new Array(24).fill(0);
  for (const m of messages) {
    if (!m.timestamp) continue;
    const h = parseInt(hourFmt.format(new Date(m.timestamp * 1000)), 10);
    if (h >= 0 && h < 24) activeHours[h]++;
  }
  let bursts = 0;
  const byTimeAsc = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 1; i < byTimeAsc.length; i++) {
    if (byTimeAsc[i].timestamp - byTimeAsc[i - 1].timestamp <= 120) bursts++;
  }

  const scriptChars = latinChars + malayalamChars;
  return {
    count: texts.length,
    medianLen: median(lengths),
    avgLen: Math.round(lengths.reduce((s, n) => s + n, 0) / lengths.length),
    avgWords: Math.round(wordCounts.reduce((s, n) => s + n, 0) / wordCounts.length * 10) / 10,
    emojiRate: Math.round((emojiMsgs / texts.length) * 100) / 100,
    topEmojis,
    pctLowercase: Math.round((lowercaseMsgs / texts.length) * 100),
    pctTerminalPunct: Math.round((terminalPunctMsgs / texts.length) * 100),
    allCapsRate: totalTokens ? Math.round((allCapsTokens / totalTokens) * 1000) / 1000 : 0,
    catchphrases,
    phrases,
    latinRatio: scriptChars ? Math.round((latinChars / scriptChars) * 100) : 100,
    malayalamRatio: scriptChars ? Math.round((malayalamChars / scriptChars) * 100) : 0,
    activeHours,
    burstiness: byTimeAsc.length > 1 ? Math.round((bursts / (byTimeAsc.length - 1)) * 100) / 100 : 0,
  };
}

/**
 * Retrieve the imitation corpus for a person in a group: their own text messages
 * in THIS group only (R13; no top-up from other chats), newest first. Content is
 * already sanitized by recallExemplars.
 */
export function getImitationCorpus(groupJid, personJid, limit = 200) {
  return recallExemplars(resolveAudience({ chatJid: groupJid }), personJid, { limit });
}

// Topical query text for recallExemplars: the conversation's non-filler words
// (recall.js tokenizes and quotes them for FTS). Null when nothing usable survives.
function topicText(text) {
  if (!text) return null;
  const words = [...new Set(
    String(text).toLowerCase().split(/\s+/)
      .map(w => w.replace(/[^a-z0-9ഀ-ൿ]/g, ''))
      .filter(w => w.length >= 4 && !COMMON_WORDS.has(w))
  )].slice(0, 6);
  return words.length ? words.join(' ') : null;
}

/**
 * Build the per-turn imitation bundle: { targetJid, label, aliases, styleCard,
 * voiceDescriptor, exemplars }. Returns null when there is nothing to imitate
 * from (corpus effectively empty).
 *
 * Exemplars are the target's real messages — untrusted chat text — so each one
 * is scrubbed with sanitizeWebContent before it can enter the prompt. Without
 * that, a member message containing a literal [IMAGE:]/[SEARCH:] marker would be
 * re-emitted by the LLM and trigger a real send/lookup (index.js extracts
 * markers BEFORE postProcess strips them).
 */
export function buildImitationBundle(groupJid, targetJid, label, opts = {}) {
  const audience = resolveAudience({ chatJid: groupJid });
  const corpus = recallExemplars(audience, targetJid, { limit: 200 });
  if (corpus.length < 5) {
    logger.warn({ groupJid, targetJid, corpus: corpus.length }, 'Imitation corpus too thin — skipping imitation this turn');
    return null;
  }

  // Style card (cached ~5 min — repeated turns in an active group reuse it).
  const cacheKey = `${groupJid}|${targetJid}`;
  const cached = cardCache.get(cacheKey);
  let styleCard;
  if (cached && Date.now() - cached.at < CARD_CACHE_TTL_MS) {
    styleCard = cached.card;
  } else {
    styleCard = buildStyleCard(corpus);
    cardCache.set(cacheKey, { card: styleCard, at: Date.now() });
  }

  // Exemplars: topical FTS hits for the current conversation first (their own
  // words about what the group is discussing right now), then recency fill.
  let picked = [];
  const seen = new Set();
  const topic = topicText(opts.topicHint);
  if (topic) {
    for (const m of recallExemplars(audience, targetJid, { query: topic, limit: 6 })) {
      if (!seen.has(m.id)) { seen.add(m.id); picked.push(m); }
    }
  }
  for (const m of corpus) {
    if (picked.length >= EXEMPLAR_MAX_COUNT) break;
    if (!seen.has(m.id)) { seen.add(m.id); picked.push(m); }
  }

  const exemplars = [];
  const seenTexts = new Set();
  let chars = 0;
  for (const m of picked) {
    const clean = sanitizeWebContent(m.content).slice(0, 300);
    if (!clean) continue;
    if (seenTexts.has(clean)) continue; // duplicates waste exemplar budget
    if (chars + clean.length > EXEMPLAR_MAX_CHARS) break;
    seenTexts.add(clean);
    chars += clean.length;
    exemplars.push(clean);
  }
  if (!exemplars.length) return null;

  // Names the target answers to — used by the decision engine so the bot
  // responds when addressed by the name it is wearing. ≥3 chars to avoid
  // false-triggering on tiny substrings. Nicknames: only ones this group may see.
  const person = getPerson(targetJid);
  const targetKey = resolvePerson(targetJid) || bareJid(targetJid);
  const nicknames = recallNicknames(audience, [targetJid]).get(targetKey) || [];
  const aliases = [...new Set(
    [
      label,
      person?.push_name,
      person?.real_name,
      ...(person?.push_name || '').split(/\s+/).slice(0, 1),
      ...nicknames.slice(0, 4).map(n => n.nickname),
    ]
      .filter(Boolean)
      .map(s => String(s).toLowerCase().trim())
      .filter(s => s.length >= 3)
  )];

  return {
    targetJid,
    label: label || person?.push_name || person?.real_name || 'them',
    aliases,
    styleCard,
    voiceDescriptor: storedDescriptor(targetJid, groupJid),
    exemplars,
  };
}

/**
 * The target's own transcribed voice notes in THIS group (R13 — never other groups,
 * never DMs, which hold voice-enrollment recordings) — how they actually talk out
 * loud, which differs from how they type. Scrubbed like text exemplars. No group →
 * nothing (fail closed). Excludes no_learn / disappearing rows.
 */
export function getSpokenExemplars(personJid, limit = 6, groupJid = null) {
  if (typeof groupJid !== 'string' || !groupJid.endsWith('@g.us')) {
    logger.debug('getSpokenExemplars without a group — none');
    return [];
  }
  const p = resolvePerson(personJid) || bareJid(personJid);
  if (!p) return [];
  const forms = identitiesOf(p);
  const n = Math.max(1, Math.min(Number(limit) || 6, 20));
  const rows = getDb().prepare(`
    SELECT content FROM messages
    WHERE group_jid = ? AND sender_jid IN (${forms.map(() => '?').join(',')})
      AND message_type = 'audio' AND COALESCE(is_from_self, 0) = 0
      AND COALESCE(no_learn, 0) = 0 AND (expires_at IS NULL OR expires_at > unixepoch())
      AND content IS NOT NULL AND length(content) BETWEEN 8 AND 400
    ORDER BY timestamp DESC LIMIT ?
  `).all(groupJid, ...forms, n * 2);
  const out = [];
  for (const r of rows) {
    const clean = sanitizeWebContent(r.content).slice(0, 250);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Render the style card as system-prompt bullets.
 */
export function renderStyleCardLines(card) {
  if (!card) return [];
  const lines = [];
  lines.push(`- Message length: usually ~${card.medianLen} chars (~${card.avgWords} words). Match this — never write more than they would.`);
  if (card.pctLowercase >= 60) lines.push(`- They write in lowercase ${card.pctLowercase}% of the time. Do the same.`);
  else if (card.pctLowercase <= 20) lines.push(`- They use normal capitalization.`);
  lines.push(card.pctTerminalPunct <= 25
    ? `- They almost never end messages with a period/punctuation (${card.pctTerminalPunct}% do).`
    : `- ${card.pctTerminalPunct}% of their messages end with punctuation.`);
  if (card.emojiRate >= 0.2 && card.topEmojis.length) {
    lines.push(`- Emojis in ~${Math.round(card.emojiRate * 100)}% of messages; favorites: ${card.topEmojis.join(' ')}`);
  } else if (card.emojiRate < 0.05) {
    lines.push(`- They rarely use emojis. Don't add any unless they would.`);
  }
  if (card.allCapsRate >= 0.02) lines.push(`- They sometimes go ALL CAPS for emphasis.`);
  if (card.catchphrases.length) lines.push(`- Words they actually use a lot: ${card.catchphrases.join(', ')}`);
  if (card.phrases?.length) lines.push(`- Their signature phrasings (use these, exactly as written): ${card.phrases.map(p => `"${p}"`).join(', ')}`);
  if (card.malayalamRatio >= 30) lines.push(`- They mix in Malayalam script heavily (~${card.malayalamRatio}% of their text).`);
  else if (card.malayalamRatio >= 5) lines.push(`- They occasionally use Malayalam script (~${card.malayalamRatio}%), mostly Manglish/English otherwise.`);
  return lines;
}

/**
 * v3 reaction mimicry: pick one of the target's own most-used emojis.
 * Returns null when the card has no emoji signal (caller falls back to the
 * generic contextual picker).
 */
export function pickImitationReaction(card) {
  if (!card?.topEmojis?.length) return null;
  return card.topEmojis[Math.floor(Math.random() * card.topEmojis.length)];
}

/**
 * v3 typing mimicry: derive a typing-speed factor from the target's habits.
 * <1 = faster than the bot's default cadence (bursty, short-message senders),
 * >1 = slower (long-form writers). Consumed by simulateTyping's speedFactor.
 */
export function imitationTypingFactor(card) {
  if (!card) return 1;
  let f = 1;
  if (card.burstiness >= 0.4) f -= 0.25;
  if (card.medianLen <= 40) f -= 0.15;
  else if (card.medianLen >= 150) f += 0.2;
  return Math.max(0.5, Math.min(1.3, f));
}

// ── Persistent style card (optional LLM voice descriptor) ──────────────────

export function getStoredStyleCard(personJid, groupJid) {
  try {
    return getDb().prepare(
      `SELECT * FROM person_style_card WHERE person_jid = ? AND group_jid = ?`
    ).get(personJid, groupJid) || null;
  } catch {
    return null;
  }
}

// The stored descriptor, only if it records that it was built from this group's
// messages alone (card_json.sourceOrigins). Pre-006 descriptors were cleared by
// the migration; anything without the record is ignored (fail closed).
function storedDescriptor(personJid, groupJid) {
  const stored = getStoredStyleCard(personJid, groupJid);
  if (!stored?.voice_descriptor) return null;
  try {
    const origins = JSON.parse(stored.card_json || '{}')?.sourceOrigins;
    if (Array.isArray(origins) && origins.length === 1 && origins[0] === groupJid) return stored.voice_descriptor;
  } catch { /* unreadable card → ignore the descriptor */ }
  return null;
}

/**
 * Build and persist an LLM voice descriptor for a person — a few prose bullets
 * capturing what the stat card can't (humor style, attitude, topics). Recorded
 * with the generation model so a descriptor built during a silent provider
 * fallback is diagnosable. Optional: imitation works without it.
 */
export async function buildVoiceDescriptor(groupJid, targetJid, label) {
  // This group's messages only (R13); the source origin is recorded in card_json.
  const corpus = getImitationCorpus(groupJid, targetJid, 120);
  if (corpus.length < 10) return null;

  const sample = corpus.slice(0, 60).map(m => sanitizeWebContent(m.content).slice(0, 200)).filter(Boolean);
  const systemPrompt = 'You analyze WhatsApp chat style. Output 3-5 short plain-text bullets (starting with "- ") describing how this person writes: their humor, attitude, topics they gravitate to, and any verbal tics. No preamble, no analysis of content sensitivity, bullets only.';
  const userMessage = `Messages written by ${label || 'this person'}:\n\n${sample.join('\n')}`;

  const res = await callRole('clerk', systemPrompt, userMessage, { caller: 'imitate.descriptor', maxTokens: 400, temperature: 0.3 });
  if (!res?.text) return null;
  const descriptor = res.text.trim().slice(0, 1200);
  // The model that actually answered (the fallback's, when the clerk fell back — FR-052).
  const builtWith = `${res.provider}/${res.model}`;

  const card = { ...buildStyleCard(corpus), sourceOrigins: [groupJid], corpusCount: corpus.length };
  try {
    getDb().prepare(
      `INSERT INTO person_style_card (person_jid, group_jid, card_json, voice_descriptor, model, built_at, message_count_at_build)
       VALUES (?, ?, ?, ?, ?, unixepoch(), ?)
       ON CONFLICT(person_jid, group_jid) DO UPDATE SET
         card_json = excluded.card_json, voice_descriptor = excluded.voice_descriptor,
         model = excluded.model, built_at = unixepoch(),
         message_count_at_build = excluded.message_count_at_build`
    ).run(targetJid, groupJid, JSON.stringify(card), descriptor, builtWith, corpus.length);
  } catch (err) {
    logger.warn({ err: err.message, targetJid }, 'Failed to persist style card');
  }
  logger.info({ targetJid, groupJid, model: builtWith, fellBack: res.fellBack, corpus: corpus.length }, 'Voice descriptor built');
  return descriptor;
}
