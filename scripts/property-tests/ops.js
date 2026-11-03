// Property tests (plan 020 §E5): the seeded PRNG and the operation generator. Pure — an
// operation list is plain data, so a failing run can be printed, saved and replayed
// (run.js --seed S --ops '<json>'), and shrunk by dropping operations.
//
// Operations (applied by child.js against the real engine):
//   pass      { h }                          time passes (15-min ticks)
//   outing    { place, inMin, minutes, cast } a Director outing (scene shape 'outing')
//   schedule  { day, activity, from, to, place? }  a schedule edit (one range)
//   text      { cast }                       the owner's SEND A TEXT
//   money     { mode, amount }               a 015 money change
//   wake      { }                            WAKE HIM (refused unless asleep)
//   revert    { pick }                       REVERT THIS CHANGE of an applied change (pick ∈ [0,1))
//   reapply   { }                            apply the last reverted change's action again
//   rewind    { back }                       a rewind to an event `back` ∈ (0,1) of the way back through this run's log
//   attend    { inMin }                      case-only (never generated): a family occasion committed to 'attend'

/** mulberry32: a small, fast, seeded PRNG → () => [0, 1). */
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PLACES = Object.freeze(['place:cafe', 'place:park', 'place:restaurant', 'place:cinema', 'place:gym']);
export const CAST = Object.freeze(['cast:flatmate', 'cast:coworker-a', 'cast:coworker-b', 'cast:manager', 'cast:sibling']);
export const ACTIVITIES = Object.freeze(['home', 'out', 'errand', 'gym', 'sleep']);

const WEIGHTS = [['pass', 30], ['outing', 18], ['schedule', 10], ['text', 8], ['money', 5], ['wake', 4], ['revert', 12], ['reapply', 6], ['rewind', 7]];
const TOTAL = WEIGHTS.reduce((a, [, w]) => a + w, 0);
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** One operation from `r`. */
export function nextOp(r) {
  const pickOf = (list) => list[Math.floor(r() * list.length)];
  let x = r() * TOTAL;
  let t = WEIGHTS[0][0];
  for (const [name, w] of WEIGHTS) { if (x < w) { t = name; break; } x -= w; }
  switch (t) {
    case 'pass': return { t, h: [0.25, 0.5, 1, 2, 3, 5, 8, 12][Math.floor(r() * 8)] };
    case 'outing': {
      const cast = [pickOf(CAST)];
      if (r() < 0.3) cast.push(pickOf(CAST.filter(c => c !== cast[0])));
      return { t, place: pickOf(PLACES), inMin: 15 * (2 + Math.floor(r() * 120)), minutes: 15 * (2 + Math.floor(r() * 12)), cast };
    }
    case 'schedule': {
      const from = 15 * Math.floor(r() * 96);
      const activity = pickOf(ACTIVITIES);
      return { t, day: Math.floor(r() * 3), activity, from: hhmm(from), to: hhmm(Math.min(from + 15 * (2 + Math.floor(r() * 16)), 23 * 60 + 45)),
        ...(activity === 'out' ? { place: pickOf(PLACES) } : {}) };
    }
    case 'text': return { t, cast: pickOf(CAST) };
    case 'money': return { t, mode: r() < 0.5 ? 'income' : 'expense', amount: 50 * (1 + Math.floor(r() * 40)) };
    case 'wake': return { t };
    case 'revert': return { t, pick: Math.round(r() * 1000) / 1000 };
    case 'reapply': return { t };
    case 'rewind': return { t, back: Math.round((0.05 + r() * 0.5) * 1000) / 1000 };
    default: return { t: 'pass', h: 1 };
  }
}

/** The operation list of a seed: `n` operations, always ending with a day passing (so consequences land). */
export function opsFor(seed, n) {
  const r = prng(seed);
  const ops = [];
  for (let i = 0; i < n; i++) ops.push(nextOp(r));
  ops.push({ t: 'pass', h: 24 });
  return ops;
}
