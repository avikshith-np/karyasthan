import { config } from '../utils/config.js';
import { countSelfMessagesInWindow, countSelfGroupMessagesSince, getLastSelfMessage } from '../memory/messageStore.js';

// In-memory tracking for fast lookups (reset on restart is fine)
const groupCooldowns = new Map(); // groupJid → timestamp when cooldown expires

const BURST_WINDOW_SEC = 90;     // look-back window for self messages
const BURST_THRESHOLD = 3;       // 3 self messages within window → burst
const BURST_COOLDOWN_SEC = 30;   // suppress non-mention responses for 30s after burst

/**
 * Check if we're rate-limited for a group/chat.
 * Honours a cooldown set by checkBurst.
 * Returns { allowed, reason }.
 */
export function checkRateLimit(chatJid) {
  const expiresAt = groupCooldowns.get(chatJid);
  if (expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    if (now < expiresAt) {
      return { allowed: false, reason: `cooldown: ${expiresAt - now}s remaining` };
    }
    groupCooldowns.delete(chatJid);
  }
  return { allowed: true, reason: null };
}

const HOUR_SEC = 3600;

/** A cap of 0, a negative number or NaN means "no cap" (the same convention as budget 0). */
function capOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Hourly caps (R10). Counts the bot's own stored messages in the last hour:
 *  - per group (config.maxPerGroupHour): this group only; direct mentions are exempt.
 *  - global (config.maxGlobalHour): all group chats together; applies to mentions too.
 * DMs are never counted (the global query only sees '@g.us' chats) and never capped
 * (decide() returns for DMs before this is called). Caps are read at call time, so a
 * dashboard PATCH takes effect on the next message.
 * Returns { allowed, reason }.
 */
export function checkHourlyCaps(chatJid, { isMention = false } = {}) {
  if (!chatJid) return { allowed: true, reason: null };
  const since = Math.floor(Date.now() / 1000) - HOUR_SEC;

  const groupCap = capOf(config.maxPerGroupHour);
  if (groupCap && !isMention && countSelfMessagesInWindow(chatJid, since) >= groupCap) {
    return { allowed: false, reason: 'hourly cap (group)' };
  }

  const globalCap = capOf(config.maxGlobalHour);
  if (globalCap && countSelfGroupMessagesSince(since) >= globalCap) {
    return { allowed: false, reason: 'hourly cap (global)' };
  }

  return { allowed: true, reason: null };
}

/**
 * Get seconds since our last message in a chat
 */
export function getSecondsSinceLastResponse(chatJid) {
  const last = getLastSelfMessage(chatJid);
  if (!last) return Infinity;
  return Math.floor(Date.now() / 1000) - last.timestamp;
}

/**
 * Set a cooldown for a group (e.g., after burst detection)
 */
export function setCooldown(chatJid, durationSec) {
  const now = Math.floor(Date.now() / 1000);
  groupCooldowns.set(chatJid, now + durationSec);
}

/** Is he in a burst in this chat right now? Side-effect free (checkBurst also starts the cooldown). */
export function inBurst(chatJid) {
  if (!chatJid) return false;
  const now = Math.floor(Date.now() / 1000);
  return countSelfMessagesInWindow(chatJid, now - BURST_WINDOW_SEC) >= BURST_THRESHOLD;
}

/**
 * Check whether the bot has been talking too much in this chat — if so,
 * trip a cooldown so checkRateLimit will block subsequent responses for a bit.
 * (Direct @-mentions are exempted at the call site in decisionEngine.)
 * Returns true if burst was detected.
 */
export function checkBurst(chatJid) {
  if (inBurst(chatJid)) {
    setCooldown(chatJid, BURST_COOLDOWN_SEC);
    return true;
  }
  return false;
}

export function getAllCooldowns() {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const [jid, expiresAt] of groupCooldowns.entries()) {
    if (expiresAt > now) {
      out.push({ jid, expiresAt, secondsRemaining: expiresAt - now });
    }
  }
  return out;
}
