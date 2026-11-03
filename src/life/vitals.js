import { localParts } from './clock.js';

// His body and mood (spec 009 plan §R3). Pure: no I/O, no RNG, no LLM.
//
// Two kinds of change, kept apart on purpose:
//   - integrate(vitals, activity, dtMin, world, ctx) — the CONTINUOUS part: per-hour
//     rates for the current activity, context modifiers (weekend, hour, rain, work
//     pressure) and couplings. It never moves a vital faster than MAX_RATE_PER_HOUR,
//     so on any 15-minute tick |Δ| ≤ PER_TICK_LIMITS. Sleep debt does not change here.
//   - applyEvent(vitals, event, world) — the DISCRETE part: an explained jump from a
//     logged event (meal → hunger 10, woke → sleep debt settled, work.late → stress +8,
//     salary in, money spent, sick on/off). The projector calls it once per event.
// The pulse rolls the random parts (sick, work.late) itself with rngFor(); this
// module only supplies the probabilities.
//
// Activity vocabulary — integrate() takes a kind string or {kind, placeId, social,
// withCast}. Kinds map to a rate class; unknown kinds fall back to 'awake' (never
// throws). 'work' becomes 'office' at the world's office place, else 'wfh'.
//   sleep   sleep, asleep
//   rest    rest, tv, idle, break, nap, ig, phone, read, gaming, sick, free
//   leisure leisure, walk, cafe, groceries, errand, shopping, chores, cook
//   social  social, eat-out, movie, party, outing, plan, hangout, visit, family-call
//   meal    meal, breakfast, lunch, dinner, snack
//   wfh     wfh            office  office         meeting  meeting, standup
//   commute commute, travel, drive, ride            gym      gym, workout, run, sport
// `social: true` or a non-empty `withCast` on any activity also drains the social
// battery (meals with others, a café with the flatmate) — not a meeting's
// attendees (companyOf).
//
// Vitals shape (the projection's `vitals`):
//   { energy, sleepDebt, stress, mood: { valence, arousal }, hunger, socialBattery,
//     workPressure, sick, money, night: { awakeMin, sleptMin } }
// `night` counts minutes since the last wake, so the woke event can settle the
// night as  debt += need × cycle/24h − slept  (need 8 h: a normal 16 h day + 8 h
// sleep settles to 0; each hour short adds one; each extra hour repays one).

export const VITAL_RANGES = {
  energy: [0, 100],
  sleepDebt: [0, 20],
  stress: [0, 100],
  valence: [-1, 1],
  arousal: [0, 1],
  hunger: [0, 100],
  socialBattery: [0, 100],
  workPressure: [0, 100],
};

/** Hard ceiling on continuous change per hour — integrate() never exceeds it. */
export const MAX_RATE_PER_HOUR = {
  energy: 20,
  sleepDebt: 0, // only woke settles it (an event)
  stress: 12,
  valence: 0.25,
  arousal: 0.5,
  hunger: 12,
  socialBattery: 16,
  workPressure: 10,
};

/** Largest |Δ| a vital may show over `tickMinutes` without an event (default 15). */
export function perTickLimits(tickMinutes = 15) {
  const out = {};
  for (const [k, v] of Object.entries(MAX_RATE_PER_HOUR)) out[k] = (v * tickMinutes) / 60;
  return out;
}
export const PER_TICK_LIMITS = Object.freeze(perTickLimits(15));

/** Per-hour base rates per activity class (overridable under world.vitals.rates). */
export const DEFAULT_RATES = {
  sleep:   { energy: 9, stress: -3, hunger: 3, socialBattery: 2.5, workPressure: 0 },
  rest:    { energy: 1, stress: -3, hunger: 7, socialBattery: 4, workPressure: 0 },
  leisure: { energy: -2, stress: -4, hunger: 7, socialBattery: 2, workPressure: 0 },
  social:  { energy: -5, stress: -4, hunger: 7, socialBattery: -10, workPressure: 0 },
  meal:    { energy: 1, stress: -2, hunger: 0, socialBattery: 0, workPressure: 0 },
  wfh:     { energy: -4, stress: 1, hunger: 7, socialBattery: 0.5, workPressure: 1.5 },
  office:  { energy: -5, stress: 1.5, hunger: 7, socialBattery: -4, workPressure: 1.5 },
  meeting: { energy: -6, stress: 2, hunger: 7, socialBattery: -7, workPressure: 1 },
  commute: { energy: -6, stress: 1.5, hunger: 7, socialBattery: -1, workPressure: 0 },
  gym:     { energy: -15, stress: -6, hunger: 9, socialBattery: 1, workPressure: 0 },
  awake:   { energy: -3, stress: 0, hunger: 7, socialBattery: 0, workPressure: 0 },
};

// Rebalance (2026-10-31, owner report "battery always full, energy always full",
// confirmed on a replay of the live log): the 009 table regained social battery
// in every class but office/meeting/social and energy in rest, so both sat at
// 100; stress drained to 0 every evening and work pressure leaked −3 per work
// block (6–7 blocks a day) down to 0 in two days. Now: social battery comes back
// only alone (rest/sleep/leisure), and chats drain it (012's chat.load); energy
// is flat at rest and falls with time awake (FATIGUE_*), a post-lunch dip and
// late nights, and sleep refills fast while low, slowly past SLEEP_TAPER_AT, so
// a normal night wakes him at ~85–90 and only extra sleep tops him up; stress
// rests on a floor set by work pressure; work pressure mean-reverts to a
// baseline instead of draining.
/** Sleep refills energy at the class rate up to here, then at SLEEP_TAPER_RATE. */
export const SLEEP_TAPER_AT = 70;
export const SLEEP_TAPER_RATE = 4;
/** Awake longer than this (minutes since he woke) → energy −FATIGUE_RATE/h more. */
export const FATIGUE_AFTER_MIN = 14 * 60;
export const FATIGUE_RATE = 3;
/** Extra energy drain awake in the post-lunch dip and late at night (per hour). */
export const DIP_RATE = 2;
export const NIGHT_RATE = 2;
/** Stress floor = STRESS_FLOOR_BASE + STRESS_FLOOR_PER_WP × workPressure; below it he drifts up at STRESS_FLOOR_PULL/h. */
export const STRESS_FLOOR_BASE = 8;
export const STRESS_FLOOR_PER_WP = 0.3;
export const STRESS_FLOOR_PULL = 1;
/** Work pressure drifts this share of the gap per hour toward its baseline (weekend: baseline − WP_WEEKEND_DROP). */
export const WP_BASELINE = 40;
export const WP_WEEKEND_DROP = 15;
export const WP_REVERT_PER_HOUR = 0.01;
export const WP_REVERT_WEEKEND_PER_HOUR = 0.04;

export const ACTIVITY_CLASSES = Object.keys(DEFAULT_RATES);
export const WORK_CLASSES = new Set(['wfh', 'office', 'meeting']);
const LEISURE_CLASSES = new Set(['rest', 'leisure', 'social']);

const KIND_TO_CLASS = {};
for (const [cls, kinds] of Object.entries({
  sleep: ['sleep', 'asleep'],
  rest: ['rest', 'tv', 'idle', 'break', 'nap', 'ig', 'phone', 'read', 'gaming', 'sick', 'free'],
  leisure: ['leisure', 'walk', 'cafe', 'groceries', 'errand', 'shopping', 'chores', 'cook'],
  social: ['social', 'eat-out', 'movie', 'party', 'outing', 'plan', 'hangout', 'visit', 'family-call'],
  meal: ['meal', 'breakfast', 'lunch', 'dinner', 'snack'],
  wfh: ['wfh'],
  office: ['office'],
  meeting: ['meeting', 'standup', 'career:interview'],
  commute: ['commute', 'travel', 'drive', 'ride'],
  gym: ['gym', 'workout', 'run', 'sport'],
})) for (const k of kinds) KIND_TO_CLASS[k] = cls;

/** Rate class of an activity (kind string or {kind, placeId}). Unknown → 'awake'. */
export function activityClass(activity, world) {
  const kind = String((typeof activity === 'string' ? activity : activity?.kind) ?? '').toLowerCase();
  if (kind === 'work') {
    const office = world?.self?.job?.officePlaceId ?? world?.self?.officePlaceId;
    return office && activity?.placeId === office ? 'office' : 'wfh';
  }
  return KIND_TO_CLASS[kind] || 'awake';
}

function isSocial(activity) {
  return typeof activity === 'object' && activity !== null
    && (activity.social === true || companyOf(activity).length > 0);
}

/**
 * The cast an activity counts as company (social drain here, shared time and
 * contact in 010's reducer, a decision's new_info): its withCast, except a work
 * meeting's attendees (routine.js, `social` not set) — colleagues at a table,
 * not time together. Pre-attendee logs never had cast on a meeting, so no
 * history reads differently.
 */
export function companyOf(activity) {
  if (typeof activity !== 'object' || activity === null || !Array.isArray(activity.withCast)) return [];
  if (activity.social !== true && activityClass(activity) === 'meeting') return [];
  return activity.withCast;
}

// ── Config (defaults + world.vitals overrides, cached per world object) ──────

const configCache = new WeakMap();
const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

/** Effective constants for a world: { rates, sleepNeedHours, baselineSpendPerHour }. */
export function vitalsConfig(world) {
  if (world && typeof world === 'object' && configCache.has(world)) return configCache.get(world);
  const over = world?.vitals && typeof world.vitals === 'object' ? world.vitals : {};
  const rates = {};
  for (const cls of ACTIVITY_CLASSES) {
    rates[cls] = {};
    for (const [vital, dflt] of Object.entries(DEFAULT_RATES[cls])) {
      const cap = MAX_RATE_PER_HOUR[vital];
      rates[cls][vital] = num(over.rates?.[cls]?.[vital], -cap, cap, dflt);
    }
  }
  const monthly = num(world?.money?.monthlyBaseline, 0, 1e9, 0);
  const cfg = {
    rates,
    sleepNeedHours: num(over.sleepNeedHours ?? world?.routine?.sleepNeedHours, 4, 12, 8),
    baselineSpendPerHour: over.baselineSpend === false ? 0 : monthly / (30 * 24),
    workPressureBaseline: num(over.workPressureBaseline, 0, 100, WP_BASELINE),
  };
  if (world && typeof world === 'object') configCache.set(world, cfg);
  return cfg;
}

// ── State helpers ───────────────────────────────────────────────────────

const DEFAULT_INITIAL = {
  energy: 75, sleepDebt: 0, stress: 30, valence: 0.2, arousal: 0.4,
  hunger: 30, socialBattery: 70, workPressure: 40,
};

/** Starting vitals for a world (genesis). `world.vitals.initial` may override. */
export function initialVitals(world) {
  const init = world?.vitals?.initial && typeof world.vitals.initial === 'object' ? world.vitals.initial : {};
  const pick = k => num(init[k] ?? init.mood?.[k], VITAL_RANGES[k][0], VITAL_RANGES[k][1], DEFAULT_INITIAL[k]);
  const salary = num(world?.money?.salary, 0, 1e9, 0);
  return applyCouplings({
    energy: pick('energy'),
    sleepDebt: pick('sleepDebt'),
    stress: pick('stress'),
    mood: { valence: pick('valence'), arousal: pick('arousal') },
    hunger: pick('hunger'),
    socialBattery: pick('socialBattery'),
    workPressure: pick('workPressure'),
    sick: false,
    money: num(world?.money?.startBalance, -1e9, 1e9, Math.round(salary * 0.5)),
    night: { awakeMin: 0, sleptMin: 0 },
  });
}

function clone(v) {
  return {
    ...v,
    mood: { valence: v?.mood?.valence, arousal: v?.mood?.arousal },
    night: { awakeMin: v?.night?.awakeMin ?? 0, sleptMin: v?.night?.sleptMin ?? 0 },
  };
}

/** Read a vital by name ('valence'/'arousal' live under mood). */
export function getVital(v, name) {
  return name === 'valence' || name === 'arousal' ? v?.mood?.[name] : v?.[name];
}

function setVital(v, name, value) {
  if (name === 'valence' || name === 'arousal') v.mood[name] = value;
  else v[name] = value;
}

/** Energy ceiling from couplings: −4 per hour of sleep debt past 1 h (6 h → 80), > 6 h → 60, sick → 50. */
export function energyCap(v) {
  const debt = v?.sleepDebt ?? 0;
  let cap = debt > 6 ? 60 : 100 - 4 * Math.max(0, debt - 1);
  if (v?.sick) cap = Math.min(cap, 50);
  return cap;
}

/** Copy with every vital clamped into range (non-numbers → defaults); no couplings. */
export function normalizeVitals(vitals) {
  const v = clone(vitals);
  for (const [name, [lo, hi]] of Object.entries(VITAL_RANGES)) {
    setVital(v, name, num(getVital(v, name), lo, hi, DEFAULT_INITIAL[name]));
  }
  v.sick = v.sick === true;
  v.money = num(v.money, -1e12, 1e12, 0);
  v.night.awakeMin = num(v.night.awakeMin, 0, 1e7, 0);
  v.night.sleptMin = num(v.night.sleptMin, 0, 1e7, 0);
  return v;
}

/** normalizeVitals + the energy cap applied at once (after an explained event). */
export function applyCouplings(vitals) {
  const v = normalizeVitals(vitals);
  v.energy = Math.min(v.energy, energyCap(v));
  return v;
}

/** True when every vital is inside its declared range. */
export function inRange(v) {
  return Object.entries(VITAL_RANGES).every(([name, [lo, hi]]) => {
    const x = getVital(v, name);
    return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  });
}

// ── Continuous integration ──────────────────────────────────────────────

const VALENCE_PULL_PER_HOUR = 0.1; // "moves 10%/h toward a target"
const AROUSAL_PULL_PER_HOUR = 0.3;
const SUBSTEP_MIN = 5;

function dayCurve(hour) {
  if (hour >= 7 && hour < 22) return 1;
  if (hour >= 6 && hour < 7) return 0.3 + 0.7 * (hour - 6);
  if (hour >= 22 && hour < 23) return 1 - 0.7 * (hour - 22);
  return 0.3;
}

/** Where mood.valence drifts to, given the rest of the state. */
export function valenceTarget(v, cls, ctx = {}) {
  let t = 0.15;
  if (ctx.weekend) t += 0.15;
  if (LEISURE_CLASSES.has(cls)) t += 0.1;
  if (ctx.social) t += 0.1;
  t -= (Math.max(0, v.stress - 40) / 60) * 0.3;
  if (v.stress > 70) t -= 0.2;
  if (v.hunger > 70) t -= 0.2;
  if (v.sick) t -= 0.3;
  if (v.energy < 20) t -= 0.15;
  else if (v.energy < 35) t -= 0.07;
  if (v.socialBattery < 15) t -= 0.1;
  else if (v.socialBattery < 30) t -= 0.05;
  if (ctx.rain && cls === 'commute') t -= 0.15;
  return Math.max(-1, Math.min(1, t));
}

/** Where mood.arousal drifts to: energy × time of day, lifted by company, travel, deadlines. */
export function arousalTarget(v, cls, ctx = {}) {
  if (cls === 'sleep') return 0.05;
  const hour = typeof ctx.hour === 'number' ? ctx.hour : 12;
  let t = 0.15 + 0.55 * (v.energy / 100) * dayCurve(hour);
  if (ctx.social || cls === 'social') t += 0.15;
  if (cls === 'commute') t += 0.1;
  if (v.workPressure > 70 && WORK_CLASSES.has(cls)) t += 0.1;
  return Math.max(0, Math.min(1, t));
}

function step(v, cls, dt, cfg, ctx) {
  const h = dt / 60;
  const rates = cfg.rates[cls];
  const prev = clone(v);
  const next = clone(v);
  const hour = typeof ctx.hour === 'number' ? ctx.hour : null;

  let energy = rates.energy;
  if (cls === 'sleep') {
    if (v.energy >= SLEEP_TAPER_AT) energy = Math.min(energy, SLEEP_TAPER_RATE);
  } else {
    if ((v.night?.awakeMin ?? 0) > FATIGUE_AFTER_MIN) energy -= FATIGUE_RATE;
    if (hour !== null && hour >= 13.5 && hour < 15.5) energy -= DIP_RATE;
    if (hour !== null && (hour >= 23 || hour < 5)) energy -= NIGHT_RATE;
  }

  let stress = rates.stress;
  if (WORK_CLASSES.has(cls) && v.workPressure > 60) stress += 4;
  // A deadline he can't switch off from: off work, stress drains at half speed
  // while work pressure is over 70 — so a crunch week builds up instead of
  // resetting every night (what lets stress > 70 and its couplings happen).
  else if (v.workPressure > 70 && stress < 0) stress *= 0.5;
  if (v.hunger > 80) stress += 2;
  if (ctx.weekend) stress -= 2;
  // Work is never fully off his mind: rest drains stress only down to a floor
  // set by work pressure, and below it (a sleep, a weekend) it creeps back.
  const floor = STRESS_FLOOR_BASE + STRESS_FLOOR_PER_WP * v.workPressure;
  if (v.stress <= floor && cls !== 'sleep') stress = Math.max(stress, STRESS_FLOOR_PULL);

  let work = rates.workPressure;
  if (ctx.weekday === 5 && ctx.hour >= 17) work -= 2;
  if (ctx.weekday === 1 && ctx.hour < 12 && WORK_CLASSES.has(cls)) work += 4;
  const base = cfg.workPressureBaseline - (ctx.weekend ? WP_WEEKEND_DROP : 0);
  work += (base - v.workPressure) * (ctx.weekend ? WP_REVERT_WEEKEND_PER_HOUR : WP_REVERT_PER_HOUR);

  let social = rates.socialBattery;
  if (ctx.social && cls !== 'social') social -= 6;

  next.energy += energy * h;
  next.stress += stress * h;
  if (stress < 0) next.stress = Math.max(next.stress, Math.min(v.stress, floor));   // drains stop at the floor
  next.hunger += rates.hunger * h;
  next.socialBattery += social * h;
  next.workPressure += work * h;
  next.mood.valence = valenceTarget(v, cls, ctx)
    + (v.mood.valence - valenceTarget(v, cls, ctx)) * (1 - VALENCE_PULL_PER_HOUR) ** h;
  next.mood.arousal = arousalTarget(v, cls, ctx)
    + (v.mood.arousal - arousalTarget(v, cls, ctx)) * (1 - AROUSAL_PULL_PER_HOUR) ** h;
  // 018: after the wallet's cut-over the baseline is itemized as money.spent events instead.
  if (!ctx.itemized) next.money -= cfg.baselineSpendPerHour * h;
  if (cls === 'sleep') next.night.sleptMin += dt; else next.night.awakeMin += dt;

  // Per-step limits and ranges. The energy cap is a ceiling the rate can't push
  // through; if energy sits above it (an event forgot couplings), it drains at
  // the max rate instead of jumping.
  for (const [name, [lo, hi]] of Object.entries(VITAL_RANGES)) {
    const maxStep = MAX_RATE_PER_HOUR[name] * h;
    const before = getVital(prev, name);
    let x = getVital(next, name);
    x = Math.max(before - maxStep, Math.min(before + maxStep, x));
    setVital(next, name, Math.max(lo, Math.min(hi, x)));
  }
  const cap = energyCap(next);
  if (prev.energy <= cap) next.energy = Math.min(next.energy, cap);
  else next.energy = Math.max(cap, prev.energy - MAX_RATE_PER_HOUR.energy * h);
  return next;
}

/**
 * Advance vitals by `dtMin` minutes of `activity`. Pure: returns a new object.
 * `ctx` (all optional): { at (unix, start of the interval — derives hour/weekday in
 * world.timezone), hour, weekday (0 = Sun), weekend, rain, social }. Long intervals
 * are integrated in ≤5-minute sub-steps, so one 60-minute call equals four
 * 15-minute calls.
 */
export function integrate(vitals, activity, dtMin, world, ctx = {}) {
  let v = normalizeVitals(vitals);
  if (!(dtMin > 0)) return v;
  const cfg = vitalsConfig(world);
  const cls = activityClass(activity, world);
  const weekendDays = Array.isArray(world?.routine?.weekend) ? world.routine.weekend : [0, 6];
  const social = ctx.social ?? isSocial(activity);
  let elapsed = 0;
  while (elapsed < dtMin - 1e-9) {
    const dt = Math.min(SUBSTEP_MIN, dtMin - elapsed);
    let local;
    if (typeof ctx.at === 'number') {
      const p = localParts(ctx.at + elapsed * 60, world?.timezone);
      local = { hour: p.hour + p.minute / 60, weekday: p.weekday };
    } else {
      local = {
        hour: typeof ctx.hour === 'number' ? (ctx.hour + elapsed / 60) % 24 : undefined,
        weekday: ctx.weekday,
      };
    }
    const weekend = ctx.weekend ?? (typeof local.weekday === 'number' ? weekendDays.includes(local.weekday) : false);
    v = step(v, cls, dt, cfg, { ...local, weekend, rain: !!ctx.rain, social, ...(ctx.itemized ? { itemized: true } : {}) });
    elapsed += dt;
  }
  return v;
}

// ── Discrete effects (events) ───────────────────────────────────────────

/** Sleep-debt change for one wake cycle: need × cycle/24 h − slept (hours). */
export function nightDebtDelta(sleptMin, cycleMin, needHours = 8) {
  return (needHours * cycleMin) / 1440 - sleptMin / 60;
}

/** How much later than base he wakes with this much debt: min(90, 20 × debt) minutes. */
export function lateWakeMinutes(sleepDebt) {
  return Math.min(90, Math.max(0, Math.round(20 * (Number(sleepDebt) || 0))));
}

/** Daily sick-roll probability: 0.01 + 0.02·(debt > 6) + 0.01·(stress > 70). */
export function sickChance(v) {
  return 0.01 + ((v?.sleepDebt ?? 0) > 6 ? 0.02 : 0) + ((v?.stress ?? 0) > 70 ? 0.01 : 0);
}

/** Chance a work block runs late (rolled by the pulse): 0 at ≤ 70 work pressure. */
export function workLateChance(v) {
  const wp = v?.workPressure ?? 0;
  return wp > 70 ? Math.min(0.6, 0.15 + (wp - 70) / 100) : 0;
}

const WORK_KINDS = new Set(['work', 'wfh', 'office', 'meeting', 'standup']);
/** Relief per finished work block (meetings split a day into 6–7 blocks; 3 each drained him to 0 in two days). */
export const WORK_BLOCK_RELIEF = 1;
// 010 bounded nudges (data-model §2.6 vitals.nudged, §2.3 family.call).
export const NUDGE_MAX = 30;
export const NUDGE_VALENCE_MAX = 0.4;
export const FAMILY_CALL_STRESS_MAX = 10;
export const WORK_BEHIND_MAX = 10;
// 012 chat.load (one event per ≥ 30 min window of chatting).
export const CHAT_LOAD_PER_SENT = 0.5;
export const CHAT_LOAD_PER_RECEIVED = 0.1;
export const CHAT_LOAD_SOCIAL_MAX = 8;
export const CHAT_LOAD_AROUSAL_MAX = 0.1;
export const CHAT_LOAD_VALENCE_MAX = 0.06;
const amount = x => num(x, 0, 1e9, 0);
/** 015: what an owner-set outcome does to him (plan §P1.1). */
export const OUTCOME_VITALS = Object.freeze({
  well: Object.freeze({ valence: 0.2, stress: -10, energy: 0, socialBattery: 5 }),
  badly: Object.freeze({ valence: -0.25, stress: 15, energy: -5, socialBattery: 0 }),
});

/**
 * Apply one logged event's explained jump. `event` = { type, payload }. Unknown
 * types return the vitals unchanged (a fresh copy). Pure.
 *   meal              hunger → payload.hunger ?? 10; valence +0.03 (+0.1 if payload.good)
 *   woke              settle the night into sleepDebt (payload.sleptMin / cycleMin
 *                     override the counters); reset night counters
 *   work.late         stress +8            work.crunch  workPressure + (payload.amount ?? 20), stress +4
 *   activity.ended    workPressure −1 after a work block (WORK_BLOCK_RELIEF)
 *   decision.reversed stress +5            decision.committed  valence +0.1 if payload.wanted
 *   sick.started / sick.ended             money.salary / money.spent  ± payload.amount
 *   reply.sent        socialBattery −0.5 (never a world event: chat.load carries it, counted per window)
 *   vitals.nudged     (010) bounded deltas: energy/stress/socialBattery/workPressure ±30, valence ±0.4
 *   family.call       (010) stress + min(10, intensity × pressure × 10); pressure (0..2) from the payload
 *                     (the story's pressureFactor at call time, so replay is deterministic; default 1)
 *   work.behind       (012) workPressure + min(10, payload.workPressure)
 *   chat.load         (012) socialBattery − min(8, 0.5 × sent + 0.1 × received); arousal up;
 *                     valence + (battery ≥ 40) or − (battery < 25), ≤ 0.06
 *   commute.soaked    (011) valence −0.08 (heavy −0.12), stress +4, energy −3
 * `activity.recorded` (010) has no case on purpose (FR-030: a record moves no vitals).
 * 012's mood.chat is not here either: a chat blip never enters the integrated
 * vitals — it is a decaying overlay on views (projector.withChatMood).
 */
export function applyEvent(vitals, event, world) {
  const v = applyCouplings(vitals);
  const p = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  switch (event?.type) {
    case 'meal':
      v.hunger = num(p.hunger, 0, 100, 10);
      v.mood.valence += p.good ? 0.1 : 0.03;
      break;
    case 'woke': {
      // Wake him (owner): a night wake leaves the night open — the morning's woke
      // settles the whole broken night (the awake gap counts as awake time).
      if (p.interrupted === true) break;
      const slept = num(p.sleptMin, 0, 1e7, v.night.sleptMin);
      const cycle = num(p.cycleMin, 0, 1e7, v.night.awakeMin + v.night.sleptMin);
      v.sleepDebt += nightDebtDelta(slept, cycle, vitalsConfig(world).sleepNeedHours);
      v.night = { awakeMin: 0, sleptMin: 0 };
      break;
    }
    case 'work.late':
      v.stress += 8;
      break;
    case 'work.crunch':
      v.workPressure += num(p.amount, 0, 100, 20);
      v.stress += 4;
      break;
    case 'activity.ended': {
      const kind = String(p.kind ?? p.activity?.kind ?? '').toLowerCase();
      if (WORK_KINDS.has(kind)) v.workPressure -= WORK_BLOCK_RELIEF;
      break;
    }
    case 'decision.reversed':
      v.stress += 5;
      break;
    case 'decision.committed':
      if (p.wanted) v.mood.valence += 0.1;
      break;
    case 'sick.started':
      v.sick = true;
      break;
    case 'sick.ended':
      v.sick = false;
      break;
    case 'money.salary':
      v.money += amount(p.amount);
      break;
    case 'money.spent':
      v.money -= amount(p.amount);
      break;
    case 'reply.sent':
      v.socialBattery -= 0.5;
      break;
    case 'vitals.nudged': {
      const d = p.delta && typeof p.delta === 'object' && !Array.isArray(p.delta) ? p.delta : {};
      v.energy += num(d.energy, -NUDGE_MAX, NUDGE_MAX, 0);
      v.stress += num(d.stress, -NUDGE_MAX, NUDGE_MAX, 0);
      v.socialBattery += num(d.socialBattery, -NUDGE_MAX, NUDGE_MAX, 0);
      v.workPressure += num(d.workPressure, -NUDGE_MAX, NUDGE_MAX, 0);
      v.mood.valence += num(d.valence, -NUDGE_VALENCE_MAX, NUDGE_VALENCE_MAX, 0);
      break;
    }
    case 'chat.load': {
      // 012 (2026-10-31): talking in chats wears his social battery down (each of
      // his messages −0.5, as R3 always said, each reply he reads there −0.1, ≤ 8 a
      // window); company lifts arousal; with battery to spare a lively chat is a
      // small lift, drained it grates.
      const sent = num(p.sent, 0, 1000, 0);
      const got = num(p.received, 0, 5000, 0);
      const battery = v.socialBattery;
      v.socialBattery -= Math.min(CHAT_LOAD_SOCIAL_MAX, CHAT_LOAD_PER_SENT * sent + CHAT_LOAD_PER_RECEIVED * got);
      v.mood.arousal += Math.min(CHAT_LOAD_AROUSAL_MAX, 0.005 * (sent + got));
      if (battery >= 40) v.mood.valence += Math.min(CHAT_LOAD_VALENCE_MAX, 0.006 * sent);
      else if (battery < 25) v.mood.valence -= Math.min(CHAT_LOAD_VALENCE_MAX, 0.004 * (sent + got));
      break;
    }
    case 'work.behind':
      // 012: chatting through a work hour — a little more work pressure (counts only).
      v.workPressure += num(p.workPressure, 0, WORK_BEHIND_MAX, 0);
      break;
    case 'family.call':
      v.stress += Math.min(FAMILY_CALL_STRESS_MAX, num(p.intensity, 0, 1, 0) * num(p.pressure, 0, 2, 1) * FAMILY_CALL_STRESS_MAX);
      break;
    case 'money.adjusted': {
      // 015: the owner's money change — set is exact at fold time (no drift between preview and apply).
      const n = Number(p.amount);
      if (!Number.isFinite(n)) break;
      if (p.mode === 'set') v.money = Math.max(-1e9, Math.min(1e9, n));
      else if (p.mode === 'income') v.money += amount(n);
      else if (p.mode === 'expense') v.money -= amount(n);
      break;
    }
    case 'outcome.happened': {
      // 015: how an outing went, as the owner set it (bounded code constants).
      const d = OUTCOME_VITALS[p.outcome];
      if (!d) break;
      v.mood.valence += d.valence;
      v.stress += d.stress;
      v.energy += d.energy;
      v.socialBattery += d.socialBattery;
      break;
    }
    case 'commute.soaked':
      // 011: caught in the rain without an umbrella — bounded, a small comfort hit.
      v.mood.valence -= p.intensity === 'heavy' ? 0.12 : 0.08;
      v.stress += 4;
      v.energy -= 3;
      break;
    default:
      break;
  }
  return applyCouplings(v);
}

// ── Thresholds ──────────────────────────────────────────────────────────

/** Threshold crossings the pulse turns into events or triggers. */
export const THRESHOLDS = [
  { vital: 'hunger', at: 80 },
  { vital: 'energy', at: 20 },
  { vital: 'stress', at: 70 },
  { vital: 'socialBattery', at: 25 },
  { vital: 'workPressure', at: 70 },
  { vital: 'sleepDebt', at: 6 },
];

// Sexual urge, 0–100. NOT a vital: integrate() and initialVitals() never touch
// it, so pre-change logs and the 012 goldens fold byte for byte. Callers compute
// it at read time. A relationship stage is not an input — the rise is the same
// dating, committed, or married. Sleep sits near the morning baseline. A recent
// release (lastReleaseAt) starts the climb again from a low floor.
export const URGE = Object.freeze({
  MORNING: 25,
  AFTER_RELEASE: 15,
  TAU_H: 14,
  NIGHT: 90,    // local hour ≥ 21 or < 2
  EVENING: 70,  // local hour ≥ 18
  DAY: 48,
  SLEEP: 25,
});

/**
 * Urge at one instant. ctx: { now, tz, asleep, lastReleaseAt, stress,
 * socialBattery, romanceAppetite (0–1, default 0.5), sawInterest }.
 */
export function urgeValue(ctx = {}) {
  const now = finiteUrge(ctx.now) ? ctx.now : 0;
  const hour = localParts(now, ctx.tz).hour ?? 12;
  const releasedAgoH = finiteUrge(ctx.lastReleaseAt) && now >= ctx.lastReleaseAt
    ? (now - ctx.lastReleaseAt) / 3600 : null;
  if (ctx.asleep) return releasedAgoH !== null && releasedAgoH < 1 ? URGE.AFTER_RELEASE : URGE.SLEEP;

  let ceiling = hour >= 21 || hour < 2 ? URGE.NIGHT : hour >= 18 ? URGE.EVENING : URGE.DAY;
  if ((finiteUrge(ctx.stress) ? ctx.stress : 0) > 70) ceiling -= 12;
  if ((finiteUrge(ctx.socialBattery) ? ctx.socialBattery : 100) < 20) ceiling -= 10;
  ceiling = Math.max(20, ceiling);
  const appetite = finiteUrge(ctx.romanceAppetite) ? Math.min(1, Math.max(0, ctx.romanceAppetite)) : 0.5;
  const scale = 0.6 + 0.8 * appetite; // 0.5 → 1
  const floor = releasedAgoH !== null ? URGE.AFTER_RELEASE : URGE.MORNING;
  const climbHours = releasedAgoH !== null ? releasedAgoH : (hour >= 7 ? hour - 7 : hour + 17);
  const climb = 1 - Math.exp(-climbHours / URGE.TAU_H);
  let urge = floor + (ceiling * scale - floor) * climb;
  if (ctx.sawInterest) urge += 8;
  return Math.round(Math.max(0, Math.min(100, urge)));
}

function finiteUrge(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Crossings between two states: [{ vital, at, dir: 'up'|'down', value }]. */
export function crossings(prev, next) {
  const out = [];
  for (const { vital, at } of THRESHOLDS) {
    const a = getVital(prev, vital);
    const b = getVital(next, vital);
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (a <= at && b > at) out.push({ vital, at, dir: 'up', value: b });
    else if (a > at && b <= at) out.push({ vital, at, dir: 'down', value: b });
  }
  return out;
}
