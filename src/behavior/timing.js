import { sendTyping, stopTyping, markRead } from '../whatsapp/actions.js';
import { logger } from '../utils/logger.js';

/**
 * Wait a random human-like delay before responding.
 * Returns the delay in ms actually waited.
 *
 * opts.alreadyElapsedMs — time already spent generating this turn (e.g. a web
 * lookup). It is credited against the delay so a researched reply isn't double-
 * penalized and the whole turn stays under the 60s in-flight budget (events.js).
 * Default 0 → existing callers unchanged; can only ever reduce the delay.
 */
export async function waitResponseDelay(context, opts = {}) {
  let minMs, maxMs;

  if (context.isMention) {
    // Direct mention: quick attention
    minMs = 3000; maxMs = 10000;
  } else if (context.isQuestion) {
    // Thinking about a question
    minMs = 5000; maxMs = 20000;
  } else if (context.isDeadChat) {
    // Reviving dead chat (longer delay)
    minMs = 120000; maxMs = 600000;
  } else if (context.isDm) {
    // DM: moderate delay
    minMs = 3000; maxMs = 15000;
  } else {
    // General humor / opportunistic
    minMs = 10000; maxMs = 45000;
  }

  let delay = randomBetween(minMs, maxMs);
  const elapsed = Math.max(0, opts.alreadyElapsedMs || 0);
  if (elapsed > 0) {
    delay = Math.max(1500, delay - elapsed); // credit research time, keep a small floor
  }
  logger.debug({ delayMs: delay, elapsedMs: elapsed }, 'Response delay');
  await sleep(delay);
  return delay;
}

/**
 * Simulate typing indicator for a duration proportional to message length.
 */
export async function simulateTyping(sock, jid, textLength) {
  // ~35ms per character + jitter, clamped 1.5-12s
  const baseTime = textLength * 35;
  const jitter = baseTime * (Math.random() * 0.6 - 0.2); // -20% to +40%
  const thinkPause = randomBetween(500, 2000);
  let total = thinkPause + baseTime + jitter;

  // For very short messages ("lol", "nah"): quick reaction
  if (textLength <= 5) {
    total = randomBetween(800, 2000);
  }

  total = Math.max(1500, Math.min(12000, total));

  await sendTyping(sock, jid);

  // Refresh typing indicator every 7s if needed
  if (total > 7000) {
    const intervals = Math.floor(total / 7000);
    for (let i = 0; i < intervals; i++) {
      await sleep(7000);
      await sendTyping(sock, jid);
    }
    const remaining = total % 7000;
    if (remaining > 0) await sleep(remaining);
  } else {
    await sleep(total);
  }

  await stopTyping(sock, jid);
}

/**
 * Delay then mark a message as read (with random human-like timing).
 */
export async function delayedReadReceipt(sock, msgKey) {
  const roll = Math.random();
  let delay;

  if (roll < 0.60) {
    delay = randomBetween(2000, 8000);      // Was already looking at phone
  } else if (roll < 0.85) {
    delay = randomBetween(15000, 60000);     // Picked up phone
  } else if (roll < 0.95) {
    delay = randomBetween(120000, 300000);   // Busy, checked later
  } else {
    return; // 5%: don't send read receipt at all
  }

  setTimeout(async () => {
    try {
      await markRead(sock, [msgKey]);
    } catch (err) {
      logger.debug({ err }, 'Read receipt failed (non-critical)');
    }
  }, delay);
}

/**
 * Pause between split messages (when a response is split into 2 parts).
 */
export async function interMessagePause() {
  await sleep(randomBetween(1000, 4000));
}

// ── Helpers ──

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
