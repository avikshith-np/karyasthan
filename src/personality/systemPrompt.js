import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRecentMessages } from '../memory/messageStore.js';
import { getActivePeopleInGroup, getNicknames } from '../memory/peopleStore.js';
import { getGroup, getTopSlang, getActiveTopics } from '../memory/groupStore.js';
import { getGroupRelationships } from '../memory/relationshipStore.js';
import { getRelevantMemories } from '../memory/relationshipStore.js';
import { getDb } from '../memory/db.js';
import { getQualityInsights } from '../brain/qualityGate.js';
import { logger } from '../utils/logger.js';
import { extractEmojis } from '../utils/emoji.js';
import { getPersona } from '../utils/config.js';

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

let IDENTITY = readIdentitySource();

export function reloadIdentity() {
  try {
    IDENTITY = readIdentitySource();
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

export function writeIdentity(text) {
  if (typeof text !== 'string') throw new Error('identity must be a string');
  if (text.length > 50_000) throw new Error('identity too large (>50KB)');
  if (!text.trim()) throw new Error('identity cannot be empty');
  fs.writeFileSync(identityPath, text, 'utf-8');
  return reloadIdentity();
}

/**
 * Build the full system prompt for an LLM call.
 */
export function buildSystemPrompt(chatJid, isGroup) {
  const parts = [IDENTITY];

  if (isGroup) {
    // Group context
    const group = getGroup(chatJid);
    if (group) {
      parts.push(`\n## Current Group: ${group.name || 'Unknown'}`);
      if (group.vibe) parts.push(`Vibe: ${group.vibe}`);
      if (group.language && group.language !== 'en') {
        parts.push(`Language: Mostly ${group.language}. Match this.`);
      }
    }

    // People profiles
    const people = getActivePeopleInGroup(chatJid);
    if (people.length > 0) {
      let hasPreferred = false;
      const personLines = [];
      for (const person of people.slice(0, 15)) {
        const nicknames = getNicknames(person.jid);
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
        const traits = person.traits_json ? JSON.parse(person.traits_json) : [];
        const traitStr = traits.length > 0 ? ` — ${traits.slice(0, 4).join(', ')}` : '';
        const summary = person.summary ? ` ${person.summary}` : '';
        // Tag handle = last 4 digits of their phone (suffix is enough for lookup).
        const phoneDigits = person.phone ? String(person.phone).replace(/\D/g, '') : '';
        const tag = phoneDigits ? ` [@${phoneDigits.slice(-4)}]` : '';
        personLines.push(`- ${person.push_name || person.real_name || 'Unknown'}${nickStr}${tag}${traitStr}${summary}`);
      }
      parts.push('\n## People in this group:');
      if (hasPreferred) {
        parts.push('When someone is listed with (prefers "X"), ALWAYS call them X — they specifically asked for it.');
      }
      parts.push('To tag a specific person in your reply, write @<their-name> or @<4-digit-suffix from the [@xxxx] tag above>. Use this ONLY when addressing a specific person in a multi-thread moment (e.g. someone else interjected). Don\'t tag people gratuitously.');
      parts.push('To reply-quote a specific earlier message (only when needed for thread clarity in a messy multi-person moment), prefix your reply with [REPLY:<id>] using the 8-char suffix shown in each line\'s [id:xxxxxxxx]. Example: [REPLY:a1b2c3d4] yeah I agree with that. Most replies do NOT need this — prefer @-tagging.');
      parts.push(...personLines);
    }

    // Relationships
    const rels = getGroupRelationships(chatJid);
    if (rels.length > 0) {
      parts.push('\n## Dynamics:');
      for (const rel of rels.slice(0, 5)) {
        const desc = rel.dynamic || rel.relationship || 'connected';
        parts.push(`- ${rel.person_a_name} & ${rel.person_b_name}: ${desc}`);
      }
    }

    // Learned slang
    const slang = getTopSlang(chatJid, 20);
    if (slang.length > 0) {
      parts.push('\n## Group slang (use these naturally):');
      for (const s of slang) {
        parts.push(`- "${s.term}" = ${s.meaning || 'unknown meaning'}`);
      }
    }
  }

  // Relevant memories
  const recentMsgs = getRecentMessages(chatJid, 5);
  const recentSenders = [...new Set(recentMsgs.map(m => m.sender_jid))];
  const memories = getRelevantMemories(recentSenders, chatJid, 5);
  if (memories.length > 0) {
    parts.push('\n## Things you remember:');
    for (const mem of memories) {
      parts.push(`- [${mem.category}] ${mem.content}`);
    }
  }

  // Quality feedback insights (what works / what to avoid in this group)
  if (isGroup) {
    const insights = getQualityInsights(chatJid);
    if (insights) parts.push(insights);
  }

  return parts.join('\n');
}

/**
 * Detect words the bot has been overusing in recent messages.
 * Returns an array of fixated words (empty if none detected).
 */
function detectFixatedWords(messages) {
  const selfMsgs = messages.filter(m => m.is_from_self && m.content);
  if (selfMsgs.length < 3) return [];

  // Count how many distinct bot messages each token (word or emoji) appears in
  const wordMsgCount = {};
  const emojiMsgCount = {};
  for (const msg of selfMsgs) {
    const words = new Set(
      msg.content.toLowerCase().split(/\s+/)
        .map(w => w.replace(/[^a-z]/g, ''))
        .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
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

/**
 * Build the user message (recent conversation) for the LLM call.
 * Returns { text, fixatedWords }.
 */
export function buildConversationContext(chatJid, triggerMsg, isGroup) {
  const messages = getRecentMessages(chatJid, isGroup ? 50 : 30);

  // Build a lookup of message id → sender name for resolving reply attribution
  const msgIdToSender = new Map();
  for (const msg of messages) {
    const senderName = msg.is_from_self ? `${getPersona().name} (you)` : (msg.sender_name || 'Unknown');
    msgIdToSender.set(msg.id, senderName);
  }

  const triggerId = triggerMsg?.id || null;
  const lines = [];
  for (const msg of messages) {
    const name = msg.is_from_self ? `${getPersona().name} (you)` : (msg.sender_name || 'Unknown');
    let prefix = '';
    if (msg.quoted_content && msg.quoted_id) {
      // Resolve who was being replied to
      let quotedSender = msgIdToSender.get(msg.quoted_id);
      if (!quotedSender) {
        // Not in the recent window — quick DB lookup
        const row = getDb().prepare('SELECT sender_name, is_from_self FROM messages WHERE id = ?').get(msg.quoted_id);
        quotedSender = row ? (row.is_from_self ? `${getPersona().name} (you)` : (row.sender_name || 'Unknown')) : 'someone';
      }
      prefix = `(replying to ${quotedSender}: "${msg.quoted_content.slice(0, 50)}") `;
    } else if (msg.quoted_content) {
      prefix = `(replying to: "${msg.quoted_content.slice(0, 50)}") `;
    }
    const content = msg.content || `[${msg.message_type}]`;
    const mediaTag =
      (msg.message_type === 'audio' && msg.content) ? '(voice) ' :
      (msg.message_type === 'image' && msg.content) ? '(image) ' :
      (msg.message_type === 'sticker' && msg.content) ? '(sticker) ' : '';
    const marker = (triggerId && msg.id === triggerId) ? '>>> ' : '';
    const idTag = msg.id ? ` [id:${String(msg.id).slice(-8)}]` : '';
    lines.push(`${marker}[${name}]${idTag}: ${prefix}${mediaTag}${content}`);
  }

  const context = lines.join('\n');

  // Recency note — warn the LLM that it JUST replied, to prevent restating.
  const lastSelf = [...messages].reverse().find(m => m.is_from_self);
  const nowSec = Math.floor(Date.now() / 1000);
  let recencyNote = '';
  if (lastSelf && lastSelf.content && (nowSec - lastSelf.timestamp) < 45) {
    const snippet = lastSelf.content.slice(0, 120).replace(/\s+/g, ' ').trim();
    const ago = Math.max(1, nowSec - lastSelf.timestamp);
    recencyNote = `\n\nIMPORTANT: You already sent a message ~${ago}s ago: "${snippet}". The user has sent more messages since. Do NOT repeat the same greeting, advice, topic, or phrasing. Either build meaningfully on what you just said, or respond with [SKIP] if nothing new is warranted.`;
  }

  // Detect fixation
  const fixatedWords = detectFixatedWords(messages);

  // Detect if the last several messages are a back-and-forth between 2 people
  let twoPersonNote = '';
  if (isGroup) {
    const nonSelfRecent = messages.filter(m => !m.is_from_self).slice(-5);
    const senderNames = new Set(nonSelfRecent.map(m => m.sender_name || 'Unknown'));
    if (senderNames.size === 2 && nonSelfRecent.length >= 3) {
      const names = [...senderNames];
      twoPersonNote = `\nNote: The last several messages are a conversation between ${names[0]} and ${names[1]}. Only jump in if you have something genuinely relevant, funny, or valuable to add. Otherwise respond with [SKIP].`;
    }
  }

  let instruction;
  if (isGroup) {
    instruction = `Reply as ${getPersona().name} in this group chat. Keep it SHORT — one or two lines max. Match the group's language and tone. Reply with ONLY the message text — do NOT include any name prefix like "[${getPersona().name}]:" or "[${getPersona().name} (you)]:".

The line marked with ">>>" is the message that triggered this turn — address THAT person (don't include the ">>>" yourself, it's just a pointer for you). Other interleaved messages from different senders are context only. If a different person interjected between your last message and the ">>>" trigger, stick with the ">>>" sender unless they explicitly handed off.

IMPORTANT: Most messages in this group are NOT about you or directed at you. You are reading a conversation between other people. Do NOT assume "you" or pronouns refer to you unless your name is explicitly used. Do NOT insert yourself into conversations between other people. Do NOT relate everything back to yourself or your experiences. If someone is talking about another person, do NOT assume they mean you.

If two people are having a back-and-forth, stay out of it unless you have something genuinely funny or valuable to add. Silence is better than a forced response.

Only respond if you have a genuinely witty, funny, or meaningful contribution. Generic responses like "haha", "nice", "same", "true" are worthless — if that's all you'd say, respond with exactly: [SKIP]

If the latest messages genuinely have zero relevance to you and you'd have absolutely nothing to add, respond with exactly: [SKIP]

Do NOT repeat yourself or fixate on the same word/topic across multiple replies. Follow the conversation's flow.${twoPersonNote}

If someone asks you to draw, create, generate, or make an image/picture/meme — ALWAYS do it, never [SKIP]. Use the format:
[IMAGE: detailed description]
optional caption on the next line
You can also spontaneously generate images when something would be genuinely funny, but do this rarely.

If you want to send a voice note in Malayalam (use VERY rarely — only when genuinely fun or natural), use:
[VOICE: text in Malayalam script]
optional Manglish caption
Keep voice notes SHORT — 1-2 sentences only.

If you want to sing a song snippet (use EXTREMELY rarely — only when someone asks you to sing, or the moment genuinely calls for it), use:
[SING: song lyrics]
optional Manglish caption
Keep it to 2-4 lines max. You can sing Malayalam, Hindi, or English songs.

If you want to send a sticker (use EXTREMELY RARELY — maybe once every 50+ messages, only when a sticker would land perfectly), use:
[STICKER: short search query, 1-4 words]
No caption needed — stickers stand alone.

If you want to send a GIF (use EXTREMELY RARELY — only when a GIF would genuinely land), use:
[GIF: short search query, 1-4 words]
optional caption on the next line

For both stickers and GIFs: keep queries simple and visual ("crying laughing", "shocked pikachu", "thumbs up", "side eye", "facepalm"). These are GIPHY search terms — keep them under 50 characters. Use only one media marker per message.`;
  } else {
    instruction = `Reply as ${getPersona().name} in this DM conversation. Be natural and conversational. Keep it short. Reply with ONLY the message text — do NOT include any name prefix like "[${getPersona().name}]:" or "[${getPersona().name} (you)]:". Always reply to DMs.

Important:
- Follow the conversation's flow. If the other person changes the topic, move on with them.
- Do NOT repeat yourself or keep bringing up the same word/topic across multiple replies.
- Read the conversation as a whole — respond to the LATEST message, not to earlier parts of the chat.
- If someone asks you to draw, create, generate, or make an image, ALWAYS do it. Use the format: [IMAGE: detailed description]
  optional caption on the next line. You can also generate images spontaneously when genuinely funny, but do this rarely.
If you want to send a voice note in Malayalam (use VERY rarely), use:
[VOICE: text in Malayalam script]
optional Manglish caption
Keep voice notes SHORT — 1-2 sentences only.

If you want to sing a song snippet (use EXTREMELY rarely — only when asked or the moment genuinely calls for it), use:
[SING: song lyrics]
optional Manglish caption
Keep it to 2-4 lines max. You can sing Malayalam, Hindi, or English songs.

If you want to send a sticker (use EXTREMELY RARELY — maybe once every 50+ messages, only when a sticker would land perfectly), use:
[STICKER: short search query, 1-4 words]
No caption needed — stickers stand alone.

If you want to send a GIF (use EXTREMELY RARELY — only when a GIF would genuinely land), use:
[GIF: short search query, 1-4 words]
optional caption on the next line

For both stickers and GIFs: keep queries simple and visual ("crying laughing", "shocked pikachu", "thumbs up", "side eye", "facepalm"). These are GIPHY search terms — keep them under 50 characters. Use only one media marker per message.`;
  }

  // Universal output discipline — output is sent to the chat verbatim, so any
  // reasoning/draft narration would leak. Keep this terse to avoid inviting it.
  instruction += `\n\nOutput ONLY the final message, exactly as it should appear in the chat. Never show your reasoning, never quote a draft of your own reply, never comment on or list your word choices, and never add bullet points or asterisks around it.`;

  // Append recency note (from above) — warns the bot not to restate its prior reply
  if (recencyNote) instruction += recencyNote;

  // Inject anti-fixation override when detected. Phrased as a plain constraint —
  // a "CRITICAL / non-negotiable" framing made the model narrate its compliance
  // ("I used X instead. Good."), which leaked into replies.
  if (fixatedWords.length > 0) {
    const wordList = fixatedWords.map(w => `"${w}"`).join(', ');
    instruction += `\n\nAvoid these recently-overused words: ${wordList}. Phrase it differently — but reply with the message only, don't explain or mention which words you swapped.`;
  }

  return { text: `${context}\n\n===END OF CONVERSATION===\n${instruction}`, fixatedWords };
}
