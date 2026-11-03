import { sendTyping, stopTyping, markRead } from '../whatsapp/actions.js';
import { logger } from '../utils/logger.js';

/**
 * Wait a random human-like delay before responding.
 * Returns the delay in ms actually waited.
 *
 * opts.alreadyElapsedMs — time already spent generating this turn (e.g. a web
 * lookup). It is credited against the delay so a researched reply isn't double-
 * penalized and the whole turn stays under the 90s in-flight budget (events.js).
 * Default 0 → existing callers unchanged; can only ever reduce the delay.
 *
 * opts.availabilityDelayMs — life's delay hint for this turn (spec 009 §R9/R11:
 * `now` while light 0–20 s, `sneak` 5–30 s: he's slow to look at the phone). It
 * does not stack with the normal band (FR-024): the wait is the longer of the two
 * — the band's own time runs while he's away from the phone — and the generation
 * credit above then applies to that, with the same 1.5 s floor.
 *
 * opts.catchUp — a drained catch-up turn (he has already opened the chat and is
 * reading it): the normal 3–45 s band is replaced by 1.5–6 s.
 *
 * Both default off → the delay distribution is exactly what it was before.
 */
export async function waitResponseDelay(context, opts = {}) {
  const delay = computeResponseDelay(context, opts);
  logger.debug({
    delayMs: delay,
    elapsedMs: Math.max(0, opts.alreadyElapsedMs || 0),
    ...(opts.availabilityDelayMs ? { availabilityDelayMs: opts.availabilityDelayMs } : {}),
    ...(opts.catchUp ? { catchUp: true } : {}),
  }, 'Response delay');
  await sleep(delay);
  return delay;
}

/** The delay waitResponseDelay would wait (ms), without waiting. Exported for tests. */
export function computeResponseDelay(context = {}, opts = {}) {
  let minMs, maxMs;

  if (opts.catchUp) {
    // Catch-up after a phone check: he's already in the chat.
    minMs = 1500; maxMs = 6000;
  } else if (context.isMention) {
    // Direct mention: quick attention
    minMs = 3000; maxMs = 10000;
  } else if (context.isQuestion) {
    // Thinking about a question
    minMs = 5000; maxMs = 20000;
  } else if (context.isDm) {
    // DM: moderate delay
    minMs = 3000; maxMs = 15000;
  } else {
    // General humor / opportunistic
    minMs = 10000; maxMs = 45000;
  }

  let delay = randomBetween(minMs, maxMs);
  const hint = Number.isFinite(opts.availabilityDelayMs) ? Math.max(0, opts.availabilityDelayMs) : 0;
  if (hint > delay) delay = Math.round(hint); // the hint and the band overlap, never stack
  const elapsed = Math.max(0, opts.alreadyElapsedMs || 0);
  if (elapsed > 0) {
    delay = Math.max(1500, delay - elapsed); // credit research time, keep a small floor
  }
  return delay;
}

/**
 * Simulate typing indicator for a duration proportional to message length.
 *
 * opts.speedFactor — scales the per-character typing time (imitate mode passes
 * the target's derived factor: bursty short-message senders type faster).
 * Default 1 → existing callers unchanged.
 */
export async function simulateTyping(sock, jid, textLength, opts = {}) {
  const speed = opts.speedFactor > 0 ? opts.speedFactor : 1;
  // ~35ms per character + jitter, clamped 1.5-12s
  const baseTime = textLength * 35 * speed;
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
