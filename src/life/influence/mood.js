// Chat mood (spec 012 plan §P1.2): the delta table, damping, the overlay's
// safety caps and the reason phrases. Pure — no DB, no clock, no logging.
//
// A perceived affect (roast, praise, …) becomes ONE bounded `mood.chat` event:
// table delta × intensity × the owner's moodScale × same-sender damping, then
// clamped per event. The projector folds those into state.chatMood (never into
// the integrated vitals) and every view adds the decayed sum (half-life 30 min),
// clamped as a whole. The caps here are code constants, not config: the owner
// can only soften them (moodScale ≤ 1), and nothing reaches them from the mind.

export const HALF_LIFE_SEC = 1800;
export const WINDOW_SEC = 4 * 3600;        // entries older than this are pruned at fold time
export const ENTRIES_MAX = 32;
export const DAMP_WINDOW_SEC = 3600;       // same sender within an hour: ½, then ¼
export const LIVE_MIN_VALENCE = 0.02;      // a reason phrase needs this much of the blip left

/** Per-event caps (absolute). */
export const EVENT_CAP = Object.freeze({ valence: 0.06, stress: 4, social: 3 });
/** Overlay totals: [min, max] per field. */
export const TOTAL_CAP = Object.freeze({ valence: [-0.15, 0.15], stress: [-5, 10], social: [-6, 6] });

export const AFFECTS = Object.freeze(['roast', 'praise', 'argument', 'support', 'good_news', 'bad_news', 'flirt']);
export const INTENSITIES = Object.freeze(['low', 'mid', 'high']);

const DELTAS = Object.freeze({
  roast: { valence: -0.04, stress: 2, social: 0 },
  argument: { valence: -0.05, stress: 4, social: -2 },
  bad_news: { valence: -0.05, stress: 2, social: 0 },
  praise: { valence: 0.05, stress: 0, social: 0 },
  support: { valence: 0.04, stress: -2, social: 1 },
  good_news: { valence: 0.06, stress: 0, social: 0 },
  flirt: { valence: 0.04, stress: 0, social: 2 },
});
const INTENSITY_FACTOR = Object.freeze({ low: 0.5, mid: 0.75, high: 1 });

// Code-built, chat-neutral phrases: shown only in the chat the blip came from.
export const REASON_PHRASES = Object.freeze({
  roast: 'still a bit stung by the ribbing here',
  argument: 'still a bit annoyed after that argument',
  bad_news: 'a bit down about the news here',
  praise: 'chuffed about what was said here',
  support: 'feeling looked after',
  good_news: 'happy about the news here',
  flirt: 'a little flustered',
});
export const LATE_PHRASE = 'up late chatting';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Damping for the n-th blip (0-based count of earlier ones) from the same sender: 1, ½, then ¼. */
export function dampFor(earlier) {
  return earlier <= 0 ? 1 : earlier === 1 ? 0.5 : 0.25;
}

/**
 * The bounded delta of one perceived affect. scale = config moodScale (0..1).
 * → { valence, stress, social } (rounded, clamped per event) or null for an unknown affect.
 */
export function deltaFor(affect, intensity, { scale = 1, damp = 1 } = {}) {
  const base = DELTAS[affect];
  if (!base) return null;
  const k = (INTENSITY_FACTOR[intensity] ?? INTENSITY_FACTOR.low) * clamp(finite(scale) ? scale : 1, 0, 1)
    * clamp(finite(damp) ? damp : 1, 0, 1);
  return {
    valence: r3(clamp(base.valence * k, -EVENT_CAP.valence, EVENT_CAP.valence)),
    stress: r3(clamp(base.stress * k, -EVENT_CAP.stress, EVENT_CAP.stress)),
    social: r3(clamp(base.social * k, -EVENT_CAP.social, EVENT_CAP.social)),
  };
}

/** True when the delta moves nothing (a zero scale). */
export function isZero(delta) {
  return !delta || (delta.valence === 0 && delta.stress === 0 && delta.social === 0);
}

/** How much of a blip from `t` is left at `at` (1 at t, ½ after 30 min); 0 for a future blip. */
export function decay(t, at) {
  if (!finite(t) || !finite(at) || at < t) return 0;
  return 2 ** (-(at - t) / HALF_LIFE_SEC);
}

/**
 * The overlay at `at` from state.chatMood entries ({at, dv, ds, dsoc}): the
 * decayed sum, clamped as a whole. → { valence, stress, social } or null when
 * nothing is left.
 */
export function overlayAt(entries, at) {
  if (!Array.isArray(entries) || !entries.length || !finite(at)) return null;
  let v = 0, s = 0, soc = 0;
  for (const e of entries) {
    if (!finite(e?.at) || at - e.at > WINDOW_SEC) continue;          // gone (≤ 0.4 % left)
    const k = decay(e.at, at);
    if (!k) continue;
    v += (finite(e.dv) ? e.dv : 0) * k;
    s += (finite(e.ds) ? e.ds : 0) * k;
    soc += (finite(e.dsoc) ? e.dsoc : 0) * k;
  }
  // Nothing left worth a view (an old list must not keep re-coupling the vitals).
  if (Math.abs(v) < 1e-4 && Math.abs(s) < 1e-3 && Math.abs(soc) < 1e-3) return null;
  return {
    valence: clamp(v, ...TOTAL_CAP.valence),
    stress: clamp(s, ...TOTAL_CAP.stress),
    social: clamp(soc, ...TOTAL_CAP.social),
  };
}

/** Earlier blips in `entries` from the same sender key within the damping window before `at`. */
export function earlierFromSame(entries, key, at) {
  if (!Array.isArray(entries) || !key) return 0;
  return entries.filter(e => (e.subjectJid ?? e.originJid) === key && finite(e.at) && e.at <= at && at - e.at < DAMP_WINDOW_SEC).length;
}
