import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Name prefix patterns to strip (LLM copies the conversation context format)
const NAME_PREFIX = /^\[.*?\]:\s*/;

// Trigger marker the system prompt uses internally; if the LLM echoes it, drop it.
const TRIGGER_MARKER = /^>>>\s*/;

// [id:abcdefgh] tokens that context lines carry — model occasionally copies them.
const CONTEXT_ID_TAG = /\s*\[id:[A-Za-z0-9]{4,}\]\s*/g;

// Leading [REPLY:<id>] marker — captured separately so the caller can thread the reply.
const REPLY_MARKER = /^\s*\[REPLY:([A-Za-z0-9_-]{4,})\]\s*/i;

// @-mention tokens the LLM can emit. Supports:
//   @Name     — alphanumeric/dash-underscore name
//   @9876     — phone-digit suffix
//   @+919...  — full international
const MENTION_TOKEN = /@(\+?[0-9]{4,15}|[A-Za-z][\w-]{1,30})/g;

// AI-isms to strip
const AI_PATTERNS = [
  /^(as an ai|as a language model|i('m| am) an ai)/i,
  /^(i('d| would) be happy to|i('d| would) love to help)/i,
  /^(great question|that's a great|excellent question|good question)/i,
  /^(sure|of course|absolutely|certainly)[!,.]?\s*/i,
  /^(let me|allow me to|i can help)/i,
  /^(hello|hi there|hey there)[!,.]?\s+/i,
  /^(i understand|i see what you mean)/i,
  /\b(however|furthermore|additionally|moreover|in conclusion)\b/gi,
];

// Thinking / reasoning blocks emitted by reasoning-capable models.
// Stripped before anything else so their inner content isn't treated as real reply text.
const THINKING_BLOCK_PATTERNS = [
  /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<analysis>[\s\S]*?<\/analysis>/gi,
  /\[thinking\][\s\S]*?\[\/thinking\]/gi,
];

// Unclosed thinking tag (model truncated mid-reason, or emitted only an opener).
const UNCLOSED_THINKING = /<(?:think(?:ing)?|reasoning|analysis)>[\s\S]*$/i;

// Leading reasoning preamble like "Thought: ...\n\n" emitted as plain prose by some models.
// Anchored to start so we don't eat real content mid-reply.
const LEADING_REASONING_PREFIX = /^\s*(?:\*{0,2}(?:thought|thinking|reasoning|internal (?:monologue|reasoning)|analysis)\*{0,2}\s*:[\s\S]*?\n\s*\n)/i;

// Self-narration / meta-commentary tells — a real chat reply never talks about
// its own word choices, instructions, or formatting. Thinking-model chain-of-thought
// leaking into the content field shows up as these. Used both to decide whether to
// salvage a quoted draft (postProcess) and to hard-fail the quality gate.
const ARTIFACT_TELLS = [
  /\bI (?:used|avoided|chose|picked|went with|replaced|swapped|kept|added)\b/i,
  /\bas (?:instructed|requested|required|asked)\b/i,
  /\bthis (?:works|is good|fits|nails it|is better|sounds)\b/i,
  /\b(?:let me|i'?ll|i will|i should|i need to)\b[\s\S]{0,40}\b(?:reply|respond|say|use|avoid|keep)\b/i,
  /(?:^|\n)\s*[-*]\s+/,                 // bullet scaffolding (indented or not)
  /(?:^|\n)\s*(?:good|perfect|nice|done|great)[.!]?\s*\*?\s*$/i, // trailing self-approval
  /\b(?:non-negotiable|do not use any of these words|the trigger|the message that triggered)\b/i,
];

/**
 * Detect chain-of-thought / draft-leak artifacts that must never reach a chat.
 * Deterministic and cheap — safe to call on every response.
 * @returns {boolean}
 */
export function hasReasoningArtifact(text) {
  if (!text) return false;
  return ARTIFACT_TELLS.some(p => p.test(text));
}

// Quoted blocks the model might wrap its draft in: "...", “...”, '...'
const QUOTED_BLOCK = /"([^"]{6,})"|“([^”]{6,})”|'([^']{8,})'/g;

/**
 * When artifact tells are present, the model has leaked its reasoning around a
 * quoted draft of the real message. Try to salvage that draft (salvage-then-verify):
 *   - no tells           → return text unchanged (clean reply, zero behavior change)
 *   - tells + one clear   → return the dominant quoted block, commentary discarded
 *     quoted draft
 *   - tells, no clear     → return null (reject; pipeline downgrades to silence/reaction)
 *     single draft
 */
function salvageFromArtifacts(text) {
  if (!hasReasoningArtifact(text)) return text;

  const blocks = [];
  for (const m of text.matchAll(QUOTED_BLOCK)) {
    const inner = (m[1] || m[2] || m[3] || '').trim();
    // A real draft has letters/emoji/@mention — skip bare punctuation/numbers.
    if (inner.length >= 6 && /[\p{L}\p{Emoji_Presentation}@]/u.test(inner)) {
      blocks.push(inner);
    }
  }

  // A leaked draft reads like a message — multiple words or a long phrase.
  // Exclude: single quoted words (the model quoting which words it swapped:
  // "nallatha", "chilidathe") and phantom spans captured *between* two such
  // quotes (e.g. `". I used "`) which are themselves commentary.
  const draftLike = [...new Set(blocks)]
    .filter(b => /\s/.test(b) || b.length >= 25)
    .filter(b => !hasReasoningArtifact(b));

  // Exactly one draft-like block → that's the message. None or several ambiguous
  // ones → reject (no confident salvage).
  const salvaged = draftLike.length === 1 ? draftLike[0] : null;

  logger.warn(
    { original: text.slice(0, 200), salvaged, draftBlocks: draftLike.length },
    'Artifact leak detected in LLM output',
  );

  return salvaged; // null → reject
}

// Markdown patterns to strip
const MARKDOWN_PATTERNS = [
  /\*\*(.*?)\*\*/g,   // **bold** → text
  /\*(.*?)\*/g,        // *italic* → text
  /__(.*?)__/g,        // __underline__ → text
  /_(.*?)_/g,          // _italic_ → text
  /`(.*?)`/g,          // `code` → text
  /^\s*[-*]\s+/gm,     // bullet points (also indented)
  /^\d+\. /gm,         // numbered lists
  /^#{1,6} /gm,        // headers
];

/**
 * Post-process LLM output to make it feel human.
 *
 * @param {string} text - Raw LLM output
 * @param {string[]} [fixatedWords] - Words the bot has been overusing (will be stripped)
 * @param {object} [opts]
 * @param {boolean} [opts.isGroup]
 * @param {(token:string)=>({jid:string, displayText:string}|null)} [opts.peopleResolver]
 *    Resolver for @-mention tokens. Receives the bare token (no '@'), returns jid+displayText or null.
 * @returns {string|{text:string, replyToId:(string|null), mentions:string[]}|null}
 *    If `opts.peopleResolver` is provided, returns the rich object; otherwise returns a plain string
 *    (legacy signature) for backward-compat with callers like bill-split.skill that expect a string.
 */
export function postProcess(text, fixatedWords = [], opts = null) {
  if (!text) return null;

  let result = text;
  let replyToId = null;

  // Extract [REPLY:<id>] marker before any other stripping (only in group context).
  if (opts?.isGroup) {
    const m = result.match(REPLY_MARKER);
    if (m) {
      replyToId = m[1];
      result = result.replace(REPLY_MARKER, '');
    }
  } else {
    // Strip without keeping — no threading in DMs.
    result = result.replace(REPLY_MARKER, '');
  }

  // Strip leading trigger marker ">>>" if the model echoed it
  result = result.replace(TRIGGER_MARKER, '');

  // Strip any echoed [id:xxxxxxxx] context tags
  result = result.replace(CONTEXT_ID_TAG, ' ');

  // Strip name prefix like "[Karyasthan (you)]:" or "[Karyasthan]:"
  result = result.replace(NAME_PREFIX, '');

  // Strip thinking/reasoning blocks first so their content isn't matched by later patterns
  for (const pattern of THINKING_BLOCK_PATTERNS) {
    result = result.replace(pattern, '');
  }
  result = result.replace(UNCLOSED_THINKING, '');
  result = result.replace(LEADING_REASONING_PREFIX, '');
  result = result.trim();

  // Salvage the real message if reasoning/draft-leak artifacts surround it.
  // Returns null when there's no clean draft to recover → bail (caller downgrades to silence/reaction).
  result = salvageFromArtifacts(result);
  if (!result) return null;

  // Strip AI-isms
  for (const pattern of AI_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Strip markdown formatting
  for (const pattern of MARKDOWN_PATTERNS) {
    result = result.replace(pattern, '$1');
  }

  // Strip system markers that should never appear in chat
  result = result.replace(/\[(?:IMAGE|IMG|VOICE|SING|STICKER|STKR|GIF):[^\]]*\]/gi, '');
  // Also strip unclosed markers (LLM output truncated before `]`)
  result = result.replace(/\[(?:IMAGE|IMG|VOICE|SING|STICKER|STKR|GIF):[\s\S]*$/i, '');

  // Trim whitespace
  result = result.trim();

  // If stripping left nothing useful, bail
  if (result.length < 2) return null;

  // Strip sentences containing fixated words (safety net)
  if (fixatedWords.length > 0) {
    result = stripFixatedWords(result, fixatedWords);
    if (!result) return null;
  }

  // Filter out low-value generic responses — a reaction is better than "haha nice"
  if (isGenericResponse(result)) return null;

  // ── Inject humanity ──

  // 8% chance: drop trailing period
  if (Math.random() < 0.08 && result.endsWith('.')) {
    result = result.slice(0, -1);
  }

  // 5% chance: all lowercase
  if (Math.random() < 0.05) {
    result = result.toLowerCase();
  }

  // 3% chance: introduce a minor typo
  if (Math.random() < 0.03 && result.length > 10) {
    result = introduceTypo(result);
  }

  // ── Resolve @-mentions (only when caller opts in and this is a group) ──
  const mentions = [];
  if (opts?.peopleResolver && opts?.isGroup) {
    result = result.replace(MENTION_TOKEN, (match, token) => {
      const resolved = opts.peopleResolver(token);
      if (!resolved || !resolved.jid) {
        // Unresolved pure-digit token (e.g. @6457) is a hallucinated phone suffix —
        // useless and ugly as plain text, so drop it. Keep unresolved @Name literals,
        // which still read naturally even when the person isn't in our DB.
        return /^\+?\d+$/.test(token) ? '' : match;
      }
      if (!mentions.includes(resolved.jid)) mentions.push(resolved.jid);
      return `@${resolved.displayText}`;
    });
    // Collapse whitespace left by any dropped tokens.
    result = result.replace(/\s{2,}/g, ' ').trim();
  } else if (!opts?.isGroup) {
    // In DMs, strip bare @tokens that reference phone digits (noise); keep @Name literals.
    result = result.replace(/@\+?\d{4,15}\b/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  // Caller opted into the rich shape → return an object. Otherwise keep the
  // legacy plain-string shape so bill-split and other callers don't break.
  if (opts) {
    return { text: result, replyToId, mentions };
  }
  return result;
}

/**
 * Check if a long response should be split into two messages.
 * Returns an array of 1 or 2 strings.
 */
export function maybeSplit(text) {
  if (!text) return [];

  // Only split if > 200 chars AND 15% chance
  if (text.length <= 200 || Math.random() > 0.15) return [text];

  // Find a natural split point (period, question mark, newline)
  const midpoint = Math.floor(text.length / 2);
  const searchWindow = text.slice(midpoint - 30, midpoint + 30);
  const splitChars = ['. ', '? ', '! ', '\n'];

  for (const ch of splitChars) {
    const idx = searchWindow.indexOf(ch);
    if (idx !== -1) {
      const splitAt = midpoint - 30 + idx + ch.length;
      return [text.slice(0, splitAt).trim(), text.slice(splitAt).trim()].filter(Boolean);
    }
  }

  return [text];
}

/**
 * Pick a contextually appropriate reaction emoji
 */
export function pickReactionEmoji(content) {
  if (!content) return '👀';
  const lower = content.toLowerCase();

  if (/haha|lol|lmao|😂|🤣|rofl/i.test(lower)) return randomChoice(['💀', '😂', '🤣']);
  if (/love|❤|miss you|proud/i.test(lower)) return randomChoice(['❤️', '🫂', '🤝']);
  if (/nice|awesome|great|pwoli|adipoli|kidu|mass/i.test(lower)) return randomChoice(['🔥', '👑', '💪']);
  if (/really|serious|sathyam/i.test(lower)) return randomChoice(['🤨', '👀']);
  if (/sad|kashtam|😢|😭/i.test(lower)) return randomChoice(['🫂', '😔']);
  if (/cap|lie|fake|false/i.test(lower)) return randomChoice(['🤡', '🧢']);

  return randomChoice(['👀', '💯', '🔥', '😂', '👆']);
}

// ── Internal helpers ──

// Patterns that indicate a low-value generic response
const GENERIC_PATTERNS = [
  /^(ha(ha)+|lol|lmao|rofl|nice|same|true|exactly|ikr|fr|real|mood|damn|bruh|bro)\.?!?$/i,
  /^(that's|thats) (so )?(true|right|funny|nice|real)\.?!?$/i,
  /^oh (really|damn|nice|wow|man)\.?!?$/i,
  /^(interesting|hmm+|ah+|oh+)\.?!?$/i,
];

function isGenericResponse(text) {
  const trimmed = text.trim();
  // Very short filler responses (under 10 chars and no real substance)
  if (trimmed.length < 10 && /^[a-z\s!?.]+$/i.test(trimmed)) {
    if (GENERIC_PATTERNS.some(p => p.test(trimmed))) return true;
  }
  // Also catch slightly longer generic patterns
  if (GENERIC_PATTERNS.some(p => p.test(trimmed))) return true;
  return false;
}

function stripFixatedWords(text, fixatedWords) {
  const lower = text.toLowerCase();
  const hasFixated = fixatedWords.some(w => lower.includes(w));
  if (!hasFixated) return text;

  // Split into sentences and remove ones containing fixated words
  const sentences = text.split(/(?<=[.!?])\s+|(?<=\n)/);
  const kept = sentences.filter(s => {
    const sLower = s.toLowerCase();
    return !fixatedWords.some(w => sLower.includes(w));
  });

  const result = kept.join(' ').trim();
  return result.length >= 2 ? result : null;
}

function truncateAtSentence(text, maxLen) {
  const truncated = text.slice(0, maxLen);
  const lastSentEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('\n'),
  );

  if (lastSentEnd > maxLen * 0.4) {
    return truncated.slice(0, lastSentEnd + 1).trim();
  }
  // No good split point — just cut at word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

function introduceTypo(text) {
  // Swap two adjacent characters at a random position
  const words = text.split(' ');
  if (words.length < 3) return text;
  const wordIdx = Math.floor(Math.random() * (words.length - 1)) + 1;
  const word = words[wordIdx];
  if (word.length < 3) return text;
  const charIdx = Math.floor(Math.random() * (word.length - 1));
  const chars = word.split('');
  [chars[charIdx], chars[charIdx + 1]] = [chars[charIdx + 1], chars[charIdx]];
  words[wordIdx] = chars.join('');
  return words.join(' ');
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
