import { rngFor } from './rng.js';
import { now, addDays, dayStart, dateKey, minuteOfDay, weekday as weekdayOf } from './clock.js';
import { AVAILABILITY_STATES, availabilityFor, blockAt, planDay, routineOf, wakeTime } from './routine.js';
import { hasSchedule } from './planEdits.js';   // 014 sched

// Availability and the reply gate (spec 009 plan §R9, FR-019/020). Pure: every
// function takes the projection (or an advanceTo() view — read only, never
// mutated or projected onto) and the world time explicitly; the only
// randomness is a per-message / per-check generator from rng.js, so the same
// message gated twice gets the same outcome. No I/O, no LLM, no Jev.
//
//   availabilityAt(state, at, world)   → { state, onPhone, since, until, source, kind }
//   gateMessage(state, msg, ctx, opts) → { outcome, state, delayHintMs, scoreFactor, reason, … }
//   nextCheckAt(state, at, world)      → the phone-check cadence phone.js schedules
//   isAwakeAt / freeWindows            → replace the fixed sleep hours (§R16)
//
// Activity → state is routine.js availabilityFor() (planDay stamps it on every
// block; the projector copies it onto the activity). Here we only decide which
// of those values is in force at `at`, and what the gate does with it.

export { AVAILABILITY_STATES };

/** Freest first; a higher rank is more restrictive. */
export const AVAILABILITY_RANK = Object.freeze(Object.fromEntries(AVAILABILITY_STATES.map((s, i) => [s, i])));

export const OUTCOMES = Object.freeze(['now', 'sneak', 'defer', 'react', 'ignore']);

/**
 * The §R9 outcome matrix: availability → column → outcome weights. Columns:
 * `dm`, `mention` (a group message that tags/replies to him), `chatter` (any
 * other group message). Weights need not sum to 1. Override per call with
 * gateMessage(…, { matrix }) — cells merge over these defaults.
 */
export const GATE_MATRIX = Object.freeze({
  free: { dm: { now: 1 }, mention: { now: 1 }, chatter: { now: 1 } },
  light: {
    dm: { now: 0.5, sneak: 0.3, defer: 0.2 },
    mention: { now: 0.4, sneak: 0.4, defer: 0.2 },
    chatter: { react: 0.1, defer: 0.3, ignore: 0.6 },
  },
  busy: {
    dm: { sneak: 0.25, defer: 0.75 },
    mention: { sneak: 0.2, defer: 0.8 },
    chatter: { ignore: 0.9, defer: 0.1 },
  },
  meeting: {
    dm: { sneak: 0.1, defer: 0.9 },
    mention: { sneak: 0.1, defer: 0.9 },
    chatter: { ignore: 1 },
  },
  dnd: { dm: { defer: 1 }, mention: { defer: 1 }, chatter: { ignore: 1 } },
  asleep: { dm: { defer: 1 }, mention: { defer: 1 }, chatter: { ignore: 1 } },
});

/**
 * Multiplier for decide()'s group score on a `now` turn (plan §R9: logged as
 * factors.availability). A busier state makes a group reply less likely even
 * when the gate let the message through; `sneak` turns get SNEAK_SCORE_FACTOR
 * on top, so a sneak in a group can still be skipped. Mentions bypass scoring
 * in decide() anyway.
 */
export const SCORE_FACTOR = Object.freeze({ free: 1, light: 0.8, busy: 0.6, meeting: 0.5, dnd: 0.4, asleep: 0.3 });
export const SNEAK_SCORE_FACTOR = 0.5;

/** Social battery below this tilts group chatter toward react/ignore (§R3). */
export const LOW_SOCIAL_BATTERY = 25;
/** At an empty battery, this share of group chatter's now/sneak/defer mass moves to react (30%) / ignore (70%). */
const SOCIAL_SHIFT_MAX = 0.5;
/** A group question (not a mention) moves this share of `ignore` to `defer`: he'd look at it later. */
export const QUESTION_DEFER_SHIFT = 1 / 3;

/** Delay hints (ms) handed to waitResponseDelay (§R11): now while light, sneak. */
export const DELAY_HINTS = Object.freeze({ nowLight: [0, 20_000], sneak: [5_000, 30_000] });

/** Phone-check cadence (§R9), minutes until the next check. */
export const CHECK_GAP_MIN = Object.freeze({ free: [2, 10], light: [5, 20], busy: [20, 45] });
export const CHECK_DURATION_SEC = Object.freeze([60, 240]);
/** Night checks: p per night, 1–2 of them, read only. */
export const NIGHT_CHECK_P = 0.1;

const STATE_SET = new Set(AVAILABILITY_STATES);
const MIN_GAP_SEC = 60;
const RECHECK_MIN = [15, 30];   // re-evaluate when a block's end is unknown or already past

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validState = (v) => (typeof v === 'string' && STATE_SET.has(v) ? v : null);

function worldTz(state, world) {
  return state?.world?.timezone ?? world?.timezone;
}

function timeOf(state, at) {
  if (finite(at)) return Math.floor(at);
  if (finite(state?.viewAt)) return state.viewAt;
  return now();
}

// ── Availability in force ─────────────────────────────────────────────────

/**
 * His availability at world time `at`. The projection is the truth while it
 * holds: an activity's availability until its `until`; asleep until a `woke`
 * (the pulse decides the wake, so a passed nominal end doesn't wake him). Once
 * a non-sleep `until` has passed and the pulse hasn't ticked yet, today's plan
 * block for `at` stands in, else 'free'. Sick caps free at light. `onPhone` is
 * true inside a phone check (bounded: inPhoneCheck), except while asleep (night
 * checks read only).
 * → { state, onPhone, since, until, source: 'projection'|'plan'|'default', kind }
 */
export function availabilityAt(state, at, world) {
  const t = timeOf(state, at);
  const av = isObj(state?.availability) ? state.availability : {};
  const act = isObj(state?.activity) ? state.activity : {};
  const sick = !!(state?.vitals?.sick || state?.sick);
  let out;
  const projected = validState(av.state);
  if (act.kind === 'sleep' && (!finite(act.startAt) || t >= act.startAt)) {
    out = { state: 'asleep', since: act.startAt ?? av.since ?? null, until: act.endAt ?? av.until ?? null, source: 'projection', kind: 'sleep' };
  } else if (projected && (!finite(av.until) || t < av.until)) {
    out = { state: projected, since: av.since ?? null, until: finite(av.until) ? av.until : null, source: 'projection', kind: act.kind ?? null };
  } else {
    const block = blockAt(state?.plan, t);
    const fromPlan = validState(block?.availability)
      ?? (block ? availabilityFor(block, world, { sick }) : null);
    out = fromPlan
      ? { state: fromPlan, since: block.start, until: block.end, source: 'plan', kind: block.kind }
      : { state: 'free', since: null, until: null, source: 'default', kind: null };
  }
  if (sick && out.state === 'free') out.state = 'light';
  out.onPhone = inPhoneCheck(state, t) && out.state !== 'asleep';
  return out;
}

// A check the projection shows open counts only until its planned end plus a
// grace for the drain's turns. A process that died mid-check never wrote
// phone.check.ended; without the bound he'd be "on the phone" (the free row)
// until the next check ended. Older snapshots carry no checkUntil: 10 min.
export const PHONE_CHECK_GRACE_SEC = 15 * 60;
const PHONE_CHECK_DEFAULT_SEC = 10 * 60;

export function inPhoneCheck(state, at) {
  const ph = isObj(state?.phone) ? state.phone : {};
  const started = ph.checkStartedAt;
  if (!finite(started)) return false;
  const until = finite(ph.checkUntil) ? ph.checkUntil : started + PHONE_CHECK_DEFAULT_SEC;
  return at < until + PHONE_CHECK_GRACE_SEC;
}

// ── The gate ──────────────────────────────────────────────────────────────

function columnOf(ctx) {
  if (ctx?.isDm) return 'dm';
  if (ctx?.isGroup) return ctx.isMention ? 'mention' : 'chatter';
  return null;
}

/** Clean one weight cell: known outcomes, finite ≥ 0. */
function cleanCell(cell) {
  const out = {};
  if (!isObj(cell)) return out;
  for (const o of OUTCOMES) if (finite(cell[o]) && cell[o] > 0) out[o] = cell[o];
  return out;
}

/** The weights for (row, column), override merged cell-wise over GATE_MATRIX. */
export function cellWeights(row, column, matrix) {
  const base = cleanCell(GATE_MATRIX[row]?.[column]);
  const over = isObj(matrix?.[row]) && isObj(matrix[row][column]) ? cleanCell(matrix[row][column]) : null;
  const w = over && Object.keys(over).length ? over : base;
  return Object.keys(w).length ? w : { now: 1 };
}

function socialShift(w, battery) {
  if (!finite(battery) || battery >= LOW_SOCIAL_BATTERY) return w;
  const k = SOCIAL_SHIFT_MAX * Math.min(1, (LOW_SOCIAL_BATTERY - Math.max(0, battery)) / LOW_SOCIAL_BATTERY);
  const out = { ...w };
  let moved = 0;
  for (const o of ['now', 'sneak', 'defer']) {
    if (!out[o]) continue;
    const m = out[o] * k;
    out[o] -= m;
    moved += m;
  }
  out.react = (out.react ?? 0) + moved * 0.3;
  out.ignore = (out.ignore ?? 0) + moved * 0.7;
  return out;
}

function questionShift(w) {
  if (!w.ignore) return w;
  const m = w.ignore * QUESTION_DEFER_SHIFT;
  return { ...w, ignore: w.ignore - m, defer: (w.defer ?? 0) + m };
}

/** Normalized probabilities over OUTCOMES (zeros dropped). */
function normalize(w) {
  const total = OUTCOMES.reduce((s, o) => s + (w[o] ?? 0), 0);
  const out = {};
  if (!(total > 0)) return { now: 1 };
  for (const o of OUTCOMES) if (w[o] > 0) out[o] = w[o] / total;
  return out;
}

function pickOutcome(probs, roll) {
  let acc = 0;
  let last = 'now';
  for (const o of OUTCOMES) {
    if (!probs[o]) continue;
    acc += probs[o];
    last = o;
    if (roll < acc) return o;
  }
  return last;
}

/**
 * The weights the gate would roll for a message: the §R9 cell for (row,
 * column), then a group question's ignore→defer shift (not when free), then the
 * low-social-battery tilt for group chatter. Exposed for tests and the dashboard.
 */
export function gateProbabilities(row, column, { isQuestion = false, socialBattery = null, matrix } = {}) {
  let w = cellWeights(row, column, matrix);
  if (column === 'chatter') {
    if (isQuestion && row !== 'free') w = questionShift(w);
    w = socialShift(w, socialBattery);
  }
  return normalize(w);
}

/** decide()'s group-score factor for a gate result (0 for outcomes that never reach decide()). */
export function scoreFactorFor(outcome, row, { socialBattery = null, isGroup = false } = {}) {
  if (outcome !== 'now' && outcome !== 'sneak') return 0;
  let f = SCORE_FACTOR[row] ?? 1;
  if (outcome === 'sneak') f *= SNEAK_SCORE_FACTOR;
  if (isGroup && finite(socialBattery) && socialBattery < LOW_SOCIAL_BATTERY) {
    f *= 0.6 + 0.4 * Math.max(0, socialBattery) / LOW_SOCIAL_BATTERY;
  }
  return Math.round(Math.min(1, Math.max(0.05, f)) * 1000) / 1000;
}

/**
 * The reply gate (FR-020). Sync, pure on the projection + one per-message
 * generator (rngFor(`${chat}|${msg.id}`, 'gate')): the same message always
 * gets the same outcome. Precedence: not a group/DM → now (not gated);
 * ctx.catchUp → now (a drained turn); ctx.hasActiveFlow → now (something he's
 * already doing); in a phone check (not asleep) → the free row; else the §R9
 * matrix for his availability.
 *
 * msg: { id, groupJid? } (only the id/chat feed the roll — text is never read).
 * ctx: { isDm, isGroup, isMention, isQuestion, hasActiveFlow, catchUp? }.
 * opts: { at, world, rng (a generator or () → [0,1), tests), matrix }.
 * → { outcome, state, onPhone, until, delayHintMs, scoreFactor, reason, column, probs }
 */
export function gateMessage(state, msg, ctx = {}, opts = {}) {
  const at = timeOf(state, opts.at);
  const avail = availabilityAt(state, at, opts.world);
  const base = { state: avail.state, onPhone: avail.onPhone, until: avail.until };
  const column = columnOf(ctx);
  const pass = (reason) => ({ ...base, outcome: 'now', delayHintMs: 0, scoreFactor: 1, reason, column, probs: { now: 1 } });

  if (!column) return pass('not_gated');
  if (ctx.catchUp) return pass('catch_up');
  if (ctx.hasActiveFlow) return pass('active_flow');

  let row = avail.onPhone ? 'free' : avail.state;
  // 012: a sleep pushed by a live chat — reachable there, a little less elsewhere
  // (opts.liveChat: the facade's "is this message's chat the live one?").
  const delayed = state?.sleep?.delayedFor;
  if (delayed && finite(delayed.until) && at < delayed.until && row !== 'asleep') {
    if (opts.liveChat === true) row = 'free';
    else if (row === 'free') row = 'light';
  }
  const battery = state?.vitals?.socialBattery;
  const probs = gateProbabilities(row, column, { isQuestion: !!ctx.isQuestion, socialBattery: battery, matrix: opts.matrix });

  const chat = String(msg?.groupJid ?? msg?.chatJid ?? '');
  const key = msg?.id ? `${chat}|${msg.id}` : `${chat}|${at}`;
  const r = typeof opts.rng === 'function' ? opts.rng : rngFor(key, 'gate');
  const outcome = pickOutcome(probs, r());

  let delayHintMs = 0;
  if (outcome === 'now' && row === 'light') delayHintMs = randInt(r, DELAY_HINTS.nowLight);
  else if (outcome === 'sneak') delayHintMs = randInt(r, DELAY_HINTS.sneak);

  return {
    ...base,
    outcome,
    delayHintMs,
    scoreFactor: scoreFactorFor(outcome, row, { socialBattery: battery, isGroup: !!ctx.isGroup }),
    reason: `${avail.onPhone ? 'on_phone' : row}:${column}${ctx.isQuestion && column === 'chatter' ? ':question' : ''}`,
    column,
    probs,
  };
}

function randInt(r, [lo, hi]) {
  return typeof r.int === 'function' ? r.int(lo, hi) : lo + Math.floor(r() * (hi - lo + 1));
}

// ── Phone-check cadence ───────────────────────────────────────────────────

/** How long one check lasts, in seconds (1–4 min). */
export function checkDurationSec(r) {
  return randInt(r, CHECK_DURATION_SEC);
}

/**
 * The read-only night checks of one sleep (start → wake): with p = 0.1 per
 * night, 1–2 checks spread over the night's middle (an hour clear of each
 * end). Rolled from rngFor(`${startAt}`, 'phone.night'), so every caller agrees.
 */
export function nightChecks(startAt, wakeAt) {
  if (!finite(startAt) || !finite(wakeAt) || wakeAt - startAt < 3 * 3600) return [];
  const r = rngFor(String(Math.floor(startAt)), 'phone.night');
  if (!(r() < NIGHT_CHECK_P)) return [];
  const n = r.int(1, 2);
  const lo = startAt + 3600;
  const hi = wakeAt - 3600;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(lo + r() * (hi - lo)));
  return out.sort((a, b) => a - b);
}

/**
 * When he next looks at his phone, from world time `at` (§R9 cadence): free
 * 2–10 min, light 5–20, busy 20–45; meeting → its end + 0–5 min; dnd → the
 * block's end + 0–2; asleep → a read-only night check if one is due, else the
 * wake + 0–5 min. An unknown or already-passed end re-evaluates in 15–30 min
 * (read only while asleep). Rolled from rngFor(String(at), 'phone.gap') unless
 * `rng` is given; phone.js writes the outcome into `phone.check.ended`.
 * → { at, reason, readOnly, state }
 */
export function nextCheckAt(state, at, world, { rng } = {}) {
  const t = timeOf(state, at);
  const r = typeof rng === 'function' ? rng : rngFor(String(t), 'phone.gap');
  const avail = availabilityAt(state, t, world);
  const s = avail.state;
  const min = (lo, hi) => randInt(r, [lo, hi]) * 60;
  const done = (when, reason, readOnly = false) =>
    ({ at: Math.max(t + MIN_GAP_SEC, Math.floor(when)), reason, readOnly, state: s });

  if (CHECK_GAP_MIN[s]) return done(t + min(...CHECK_GAP_MIN[s]), `gap:${s}`);
  if (s === 'meeting' || s === 'dnd') {
    if (finite(avail.until) && avail.until > t) {
      return done(avail.until + (s === 'meeting' ? min(0, 5) : min(0, 2)), `${s}_end`);
    }
    return done(t + min(...RECHECK_MIN), `recheck:${s}`);
  }
  // asleep
  const act = state?.activity?.kind === 'sleep' ? state.activity : null;
  const wake = [act?.endAt, avail.until, state?.plan?.nextWakeAt].find(v => finite(v) && v > t);
  const night = nightChecks(act?.startAt ?? avail.since, wake ?? (finite(act?.endAt) ? act.endAt : null))
    .find(x => x > t && (!wake || x < wake));
  if (night) return done(night, 'night', true);
  if (wake) return done(wake + min(0, 5), 'wake');
  return done(t + min(...RECHECK_MIN), 'recheck:asleep', true);
}

// ── Sleep hours replacement (§R16) ────────────────────────────────────────

/**
 * Is he awake at `at`? The current sleep (until a woke) is asleep; otherwise
 * the plan block covering `at`; with no block (another day, no plan yet) the
 * routine's wake/sleep times stand in.
 */
export function isAwakeAt(state, at, world) {
  const t = timeOf(state, at);
  const act = state?.activity;
  const ref = finite(state?.viewAt) ? state.viewAt : (finite(state?.at) ? state.at : t);
  // The sleep in force now: asleep from its start until a woke, for "now"-ish
  // questions; beyond its nominal end the plan/routine decides.
  if (act?.kind === 'sleep' && finite(act.startAt) && t >= act.startAt
      && (!finite(act.endAt) || t < act.endAt || t <= ref + 15 * 60)) return false;
  const block = blockAt(state?.plan, t);
  if (block) return (validState(block.availability) ?? availabilityFor(block, world)) !== 'asleep';
  return routineAwake(t, world ?? null, worldTz(state, world), state);
}

function routineAwake(t, world, tz, state = null) {
  const r = routineOf(world);
  const m = minuteOfDay(t, tz);
  let wake = r.weekend.includes(weekdayOf(t, tz)) ? r.weekendWake : r.baseWake;
  // 014 sched (R32): the day's wake as routine.wakeTime sees it (a day off, a
  // weekend office day, a sleep-in) — only when the projection has overrides.
  if (hasSchedule(state)) {
    try {
      const w = wakeTime(state, t, world);
      wake = minuteOfDay(w.at, tz) - (w.overridden ? 0 : (w.lateBy ?? 0) + (w.jitter ?? 0));
    } catch { /* the routine's wake */ }
  }
  const sleep = r.baseSleep;               // may be ≥ 1440 (after midnight)
  if (sleep >= 1440) return m >= wake || m < sleep - 1440;
  return m >= wake && m < sleep;
}

/**
 * Free windows of the local day containing `dayStartUnix`: merged contiguous
 * plan blocks whose availability is in `states` (default free), clipped to the
 * day. Today's plan if the projection has it, else a predicted planDay() for
 * that day (pure, deterministic). → [{ from, to }]
 */
export function freeWindows(state, dayStartUnix, world, { states = ['free'], minMinutes = 0 } = {}) {
  const tz = worldTz(state, world);
  const d0 = dayStart(timeOf(null, dayStartUnix), tz);
  const d1 = addDays(d0, 1, tz);
  const want = new Set(states);
  let plan = state?.plan?.date === dateKey(d0, tz) ? state.plan : null;
  if (!plan) {
    try { plan = planDay(state, d0, world); } catch { plan = null; }
  }
  const out = [];
  for (const b of plan?.blocks || []) {
    const a = validState(b.availability) ?? availabilityFor(b, world);
    if (!want.has(a)) continue;
    const from = Math.max(d0, b.start);
    const to = Math.min(d1, b.end);
    if (to <= from) continue;
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out.filter(w => w.to - w.from >= minMinutes * 60);
}
