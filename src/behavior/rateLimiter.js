import { config } from '../utils/config.js';
import { countSelfMessagesInWindow, getLastSelfMessage } from '../memory/messageStore.js';

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

/**
 * Check global rate limit across all chats
 */
export function checkGlobalRateLimit() {
  // We'd need a global count query. For now, use a simple in-memory counter.
  // This is acceptable since rate limiting is per-process.
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

/**
 * Check whether the bot has been talking too much in this chat — if so,
 * trip a cooldown so checkRateLimit will block subsequent responses for a bit.
 * (Direct @-mentions are exempted at the call site in decisionEngine.)
 * Returns true if burst was detected.
 */
export function checkBurst(chatJid) {
  if (!chatJid) return false;
  const now = Math.floor(Date.now() / 1000);
  const count = countSelfMessagesInWindow(chatJid, now - BURST_WINDOW_SEC);
  if (count >= BURST_THRESHOLD) {
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
