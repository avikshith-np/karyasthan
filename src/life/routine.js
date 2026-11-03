import { leanedLeisure } from './stanceSeam.js';
import { atLocal, dateKey, dayStart, parseHhmm, weekday as weekdayOf, zonedToUnix } from './clock.js';
import { rngFor } from './rng.js';
import { planTrip, routedFields } from './travel.js';
import { lateWakeMinutes, nightDebtDelta, vitalsConfig, workLateChance } from './vitals.js';
import { weatherFor } from './weather.js';
import { umbrellaFor, rainMode, rainGearOn } from './commute.js';
import { overridesFor, wholeDayOf, sleepInFor, fitAnchors, hasSchedule, nextSleepIn } from './planEdits.js';   // 014 sched

// His day, planned in code (spec 009 plan §R4, FR-008). Pure: no I/O, no clock
// reads (no now() — the pulse passes the day), no LLM. Random parts are rolled
// from rngFor(dateKey, purpose) with one generator per roll, so the same day
// always plans the same way and a catch-up after downtime lands on the plan an
// uninterrupted run would have made.
//
//   planDay(state, day, world, opts) → plan = the `plan.made` payload:
//     { date, dayType: 'office'|'wfh'|'weekend'|'sick', wakeAt, lateBy, sleepAt,
//       nextWakeAt, workLate: { minutes, p, normalEnd, end } | null, skipped: [kind],
//       blocks: [{ kind, placeId, start, end, availability, ...extras }] }
//
// Blocks are contiguous from wakeAt to sleepAt (gaps are 'free' at the current
// place, so blockAt() always resolves while he's awake), then one 'sleep' block
// to a NOMINAL next-day wake (the pulse wakes him by wakeTime(), not by it).
// Kinds are the vocabulary vitals.js classifies: 'work' (+ placeId → office or
// wfh), 'meeting', 'breakfast'/'lunch'/'dinner', 'commute', 'free', 'break' (a WFH
// break between work stretches), 'idle',
// 'sick', 'sleep' and the world's leisure kinds. Commute blocks have placeId
// null and carry planTrip()'s { from, to, mode, km, minutes, cost } — every
// place change gets one, so travel.started/arrived and the Map come from them.
//
// Rolls (purposes): 'wake' (jitter), 'meetings', 'meeting.cast:<start minute>',
// 'work.late', 'leisure:afternoon', 'leisure:evening', 'commute:umbrella' (011).
// Adding a roll never shifts the others.
//
// Rain gear (spec 011, commute.js): the plan rolls once whether he packs an
// umbrella (`plan.gear = { umbrella, p }`, from the forecast at his usual
// departure times) and each trip's mode comes from commute.rainMode — dry trips
// exactly as before; in rain a walkable trip is a walk under the umbrella, a cab,
// or (money tight) a walk without one. Commute blocks carry `gear` (umbrella with
// him) and `exposed` (on foot / two wheels); the pulse checks for a soak at departure.
//
// Meetings carry their attendees: withCast = 1–3 of the work cast (relation
// manager/coworker; the manager sits in on about half), not social — a
// meeting's attendees are not company (vitals.companyOf: no shared time, no
// social drain). No work cast → no withCast. Plans made before this have
// meetings without it and fold as such (the plan is the payload, never re-rolled).
//
// work.late: rollWorkLate() is a separate export so the pulse can key it the
// same way; planDay bakes the outcome in (work block longer, the rest of the
// evening after it, sleep pushed) and records it in `plan.workLate`. The pulse
// appends the `work.late` event at workLate.normalEnd (cause: plan.made) and the
// later `sleep.started` with cause = that event → the FR-008 chain.

// ── Availability (plan §R9 mapping; availability.js reads blocks' values) ──

/** Every value a block's `availability` can take, freest first. */
export const AVAILABILITY_STATES = ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep'];

/** Fixed availability per kind (kinds not listed fall back by rules in availabilityFor). */
export const AVAILABILITY_FOR = Object.freeze({
  sleep: 'asleep', asleep: 'asleep',
  meeting: 'meeting', standup: 'meeting',
  gym: 'busy', workout: 'busy', run: 'busy', sport: 'busy', drive: 'busy',
  movie: 'dnd', 'family-call': 'dnd',
  free: 'free', idle: 'free', break: 'free', tv: 'free', rest: 'free', ig: 'free', phone: 'free',
  sick: 'light',
  'career:interview': 'busy',   // 020 §A5: he doesn't answer chats mid-interview
});

/** Modes where his hands are busy (driving/riding) → busy; others (cab, metro, walk) → light. */
export const DRIVING_MODES = new Set(['scooter', 'bike', 'motorbike', 'car', 'drive', 'cycle', 'bicycle']);

const MEALS = new Set(['breakfast', 'lunch', 'dinner', 'meal', 'snack']);

/**
 * Availability of one block. Rules beyond AVAILABILITY_FOR: work at the office
 * desk → light, work elsewhere (WFH focus) → busy; commute → busy when he's
 * driving, else light; a meal or leisure with others (social / withCast) →
 * light, alone → free; any other kind → free. `sick` caps free at light.
 */
export function availabilityFor(block, world, { sick = false } = {}) {
  const kind = String(block?.kind ?? '').toLowerCase();
  let a;
  if (kind === 'work') a = block.placeId && block.placeId === officeOf(world) ? 'light' : 'busy';
  else if (kind === 'commute') a = DRIVING_MODES.has(block.mode) ? 'busy' : 'light';
  else if (AVAILABILITY_FOR[kind]) a = AVAILABILITY_FOR[kind];
  else if (block?.social === true || (Array.isArray(block?.withCast) && block.withCast.length)) a = 'light';
  else if (kind === 'eat-out') a = 'light';
  else a = 'free';
  return sick && a === 'free' ? 'light' : a;
}

// ── World access (works on normalized and minimal worlds alike) ───────────

// Same defaults as world.js validateRoutine — generic, not a persona.
const ROUTINE_DEFAULTS = {
  officeDays: [2, 3, 4], wfhDays: [1, 5], weekend: [0, 6],
  baseWake: '07:30', weekendWake: '09:00', baseSleep: '23:30',
  workStart: '09:30', workEnd: '18:00', prepMinutes: 20, breakfast: '08:00',
  lunch: { start: '13:00', minutes: 45 }, dinner: '20:30',
  meetings: { count: [1, 3], typicalTimes: [], minutes: 45 },
};
const BREAKFAST_MIN = 20;
const DINNER_MIN = 40;
const WIND_DOWN_MIN = 30;   // free time kept before sleep when placing leisure
const WFH_BREAK_AFTER = 150; // a WFH work stretch this long gets a short break
const WFH_BREAK_MIN = 15;
const LOW_ENERGY = 30;       // below: only leisure at home
const LOW_SOCIAL = 20;       // below: only leisure at home

const routineCache = new WeakMap();
const finite = v => typeof v === 'number' && Number.isFinite(v);

function minutesOf(v, dflt) {
  if (finite(v)) return Math.round(v);
  try { return parseHhmm(v); } catch { return dflt == null ? NaN : parseHhmm(dflt); }
}

function dayList(v, dflt) {
  return Array.isArray(v) && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ? v : dflt;
}

/** world.routine with defaults filled and times as minutes since midnight. Cached per world. */
export function routineOf(world) {
  if (world && typeof world === 'object' && routineCache.has(world)) return routineCache.get(world);
  const r = world?.routine && typeof world.routine === 'object' ? world.routine : {};
  const d = ROUTINE_DEFAULTS;
  const lunch = r.lunch && typeof r.lunch === 'object' ? r.lunch : {};
  const meetings = r.meetings && typeof r.meetings === 'object' ? r.meetings : {};
  const count = Array.isArray(meetings.count) && meetings.count.length === 2 && meetings.count.every(Number.isInteger)
    ? [Math.max(0, Math.min(...meetings.count)), Math.max(0, ...meetings.count)] : d.meetings.count;
  const out = {
    officeDays: dayList(r.officeDays, d.officeDays),
    wfhDays: dayList(r.wfhDays, d.wfhDays),
    weekend: dayList(r.weekend, d.weekend),
    baseWake: minutesOf(r.baseWake, d.baseWake),
    weekendWake: minutesOf(r.weekendWake, d.weekendWake),
    baseSleep: minutesOf(r.baseSleep, d.baseSleep),
    sleepNeedHours: vitalsConfig(world).sleepNeedHours,
    workStart: minutesOf(r.workStart, d.workStart),
    workEnd: minutesOf(r.workEnd, d.workEnd),
    prepMinutes: finite(r.prepMinutes) ? Math.max(0, Math.round(r.prepMinutes)) : d.prepMinutes,
    breakfast: minutesOf(r.breakfast, d.breakfast),
    lunch: { start: minutesOf(lunch.start, d.lunch.start), minutes: finite(lunch.minutes) ? Math.max(5, Math.round(lunch.minutes)) : d.lunch.minutes },
    dinner: minutesOf(r.dinner, d.dinner),
    meetings: {
      count,
      typicalTimes: (Array.isArray(meetings.typicalTimes) ? meetings.typicalTimes : []).map(t => minutesOf(t, null)).filter(finite),
      minutes: finite(meetings.minutes) ? Math.max(5, Math.round(meetings.minutes)) : d.meetings.minutes,
    },
    leisure: (Array.isArray(r.leisure) ? r.leisure : []).filter(l => l && typeof l.kind === 'string'),
  };
  // A sleep time before noon means "after midnight" (e.g. 00:30 → 24:30).
  if (out.baseSleep < 12 * 60) out.baseSleep += 1440;
  if (world && typeof world === 'object') routineCache.set(world, out);
  return out;
}

function placeIds(world) {
  const p = world?.places;
  return new Set(p instanceof Map ? p.keys() : (Array.isArray(p) ? p.map(x => x?.id) : []));
}

function placeKindOf(world, kind) {
  const p = world?.places;
  const list = p instanceof Map ? [...p.values()] : (Array.isArray(p) ? p : []);
  return list.find(x => x?.kind === kind)?.id ?? null;
}

function homeOf(world) {
  return world?.self?.homePlaceId ?? placeKindOf(world, 'home');
}

function officeOf(world) {
  if (world?.self?.employed === false) return null;   // 015: out of work — no office, before any fallback
  return world?.self?.job?.officePlaceId ?? world?.self?.officePlaceId ?? placeKindOf(world, 'office');
}

function tzOf(world) {
  return world?.timezone;
}

// `day` = unix seconds on that local day, or 'YYYY-MM-DD'. → local midnight.
function dayStartOf(day, world) {
  const tz = tzOf(world);
  if (typeof day === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) throw new Error(`routine: bad day "${day}"`);
    return dayStart(zonedToUnix(Number(m[1]), Number(m[2]), Number(m[3]), 12, 0, tz), tz);
  }
  if (!finite(day)) throw new Error('routine: day must be unix seconds or YYYY-MM-DD');
  return dayStart(day, tz);
}

// ── Day type, wake, work.late ───────────────────────────────────────────

/**
 * 'weekend' | 'sick' | 'office' | 'wfh' | 'off' for the local day containing `day`.
 * 014 sched: opts.overrides (that date's schedule overrides) — a whole-day
 * background decides the day after sick: off → 'off' (planned like a weekend
 * day), work_home → 'wfh', work_office → 'office' (also on a weekend; no office → 'wfh').
 */
export function dayType(day, world, vitals = {}, opts = {}) {
  const d0 = dayStartOf(day, world);
  const r = routineOf(world);
  const wd = weekdayOf(d0, tzOf(world));
  if (vitals?.sick) return 'sick';
  // 014 sched (absent overrides → the routine's type, as before)
  const whole = Array.isArray(opts?.overrides) && opts.overrides.length ? wholeDayOf(opts.overrides) : null;
  if (whole === 'off') return 'off';
  // 015: out of work — a weekday is 014's 'off' (no work, no meetings, no commute);
  // a work background in a schedule edit has no job to apply to.
  if (world?.self?.employed === false) return r.weekend.includes(wd) ? 'weekend' : 'off';
  if (whole === 'work_home') return 'wfh';
  if (whole === 'work_office') return officeOf(world) && officeOf(world) !== homeOf(world) ? 'office' : 'wfh';
  if (r.weekend.includes(wd)) return 'weekend';
  if (r.officeDays.includes(wd) && officeOf(world) && officeOf(world) !== homeOf(world)) return 'office';
  return 'wfh';
}

/**
 * Sleep debt he will have on waking at `wakeAt`. While he's asleep
 * (state.activity.kind 'sleep' with a startAt), tonight counts too: the night is
 * settled as if he slept from startAt to wakeAt, the way vitals' woke event
 * will settle it — so a late night shows up in THIS morning's wake, not the
 * next one. Otherwise the current state.vitals.sleepDebt. Stable across ticks
 * while he sleeps (depends only on the sleep start).
 */
export function expectedSleepDebt(state, wakeAt, world) {
  const v = state?.vitals || {};
  const debt = finite(v.sleepDebt) ? v.sleepDebt : 0;
  const act = state?.activity;
  if (act?.kind !== 'sleep' || !finite(act.startAt) || !finite(wakeAt) || !finite(v.night?.awakeMin)) return debt;
  const sleptMin = Math.max(0, (wakeAt - act.startAt) / 60);
  const delta = nightDebtDelta(sleptMin, v.night.awakeMin + sleptMin, routineOf(world).sleepNeedHours);
  return Math.min(20, Math.max(0, debt + delta));
}

/**
 * When he wakes on `day`: base (weekendWake on weekend days) + lateWakeMinutes(debt)
 * + a ±10 min jitter rolled from rngFor(date, 'wake'). → { at, base, lateBy, jitter, debt }.
 * lateBy is the woke payload's `lateBy`.
 */
export function wakeTime(state, day, world) {
  const tz = tzOf(world);
  const d0 = dayStartOf(day, world);
  const r = routineOf(world);
  // 015: out of work he sleeps in like a weekend (so does a 014 day off, below).
  const unemployed = world?.self?.employed === false;
  let baseMin = r.weekend.includes(weekdayOf(d0, tz)) || unemployed ? r.weekendWake : r.baseWake;
  // 014 sched: a day off wakes like a weekend day, an office day on a weekend like
  // a workday (R32); a sleep range covering the wake moves it to the range's end.
  if (hasSchedule(state)) {
    const date = dateKey(d0, tz);
    const type = dayType(d0, world, {}, { overrides: overridesFor(state, date) });
    if (type === 'off') baseMin = r.weekendWake;
    else if ((type === 'office' || type === 'wfh') && r.weekend.includes(weekdayOf(d0, tz))) baseMin = r.baseWake;
    const until = sleepInFor(state, date, atLocal(d0, baseMin, tz), tz);
    if (until) {
      const base0 = atLocal(d0, baseMin, tz);
      return { at: until, base: base0, lateBy: Math.max(0, Math.round((until - base0) / 60)), jitter: 0, debt: 0, overridden: true };
    }
  }
  const base = atLocal(d0, baseMin, tz);
  const debt = expectedSleepDebt(state, base, world);
  const lateBy = lateWakeMinutes(debt);
  const jitter = rngFor(dateKey(d0, tz), 'wake').int(-10, 10);
  return { at: atLocal(d0, baseMin + lateBy + jitter, tz), base, lateBy, jitter, debt: Math.round(debt * 100) / 100 };
}

/**
 * Does work run late on `date` (dateKey)? p = workLateChance(vitals) (0 unless
 * work pressure > 70); the extra is 30–120 min in 30-min steps. → { minutes, p } | null.
 */
export function rollWorkLate(vitals, date) {
  const p = workLateChance(vitals);
  if (!(p > 0)) return null;
  const r = rngFor(date, 'work.late');
  const roll = r();
  const steps = r.int(1, 4);
  return roll < p ? { minutes: 30 * steps, p: Math.round(p * 1000) / 1000 } : null;
}

// ── planDay ───────────────────────────────────────────────────────────────

/**
 * Plan the local day containing `day` (unix seconds or 'YYYY-MM-DD') from
 * world.routine and the projection `state` (reads vitals.{sleepDebt, sick,
 * energy, socialBattery, workPressure, night}, activity, weather).
 * opts:
 *   wakeAt       the actual wake (the pulse's woke time); default wakeTime().at
 *   lateBy       recorded with an explicit wakeAt (the woke payload's lateBy)
 *   workLateMin  force work.late minutes (0 = not late); default rollWorkLate()
 *   weather      (unixAt) → weather for commute mode; default weather.weatherFor(state, at,
 *                world): an owner window, else state.weather inside [from, until), else climatology
 */
export function planDay(state, day, world, opts = {}) {
  const tz = tzOf(world);
  const d0 = dayStartOf(day, world);
  const date = dateKey(d0, tz);
  const r = routineOf(world);
  const v = state?.vitals || {};
  const sick = !!v.sick;
  // 014 sched: that date's overrides (opts.overrides wins; none → exactly as before)
  const overrides = Array.isArray(opts.overrides) ? opts.overrides : overridesFor(state, date);
  const type = dayType(d0, world, v, overrides.length ? { overrides } : undefined);
  const wd = weekdayOf(d0, tz);
  const working = type === 'office' || type === 'wfh';
  const home = homeOf(world);
  const office = officeOf(world);
  const known = placeIds(world);
  if (!home || !known.has(home)) throw new Error('routine: world has no home place');

  const wake = finite(opts.wakeAt)
    ? { at: Math.round(opts.wakeAt), lateBy: finite(opts.lateBy) ? opts.lateBy : 0 }
    : wakeTime(state, d0, world);
  const toMin = unix => Math.round((unix - d0) / 60);
  const unixOf = m => atLocal(d0, m, tz);

  // 011: weatherFor = owner windows, then state.weather within [from, until), then climatology.
  const weatherFn = typeof opts.weather === 'function' ? opts.weather : (at) => weatherFor(state, at, world);
  // 011 rain gear: one umbrella roll for the day (R24: from the usual departure
  // times, before any trip is planned), then each trip's actual mode. Base vitals (R23).
  const gear = rainGearOn() ? umbrellaFor(state, [r.workStart - 45, r.workEnd, r.dinner - 90].map(m => unixOf(m)), date, world) : null;
  const gearCtx = { umbrella: gear?.umbrella === true, money: v.money, salary: world?.money?.salary, valence: v.mood?.valence, energy: v.energy };
  const trip = (from, to, m) => {
    if (!gear) {
      try { return planTrip(from, to, unixOf(m), weatherFn(unixOf(m)), world); } catch { return null; }
    }
    try {
      const at = unixOf(m);
      const w = weatherFn(at);
      const est = planTrip(from, to, at, w, world);
      const rm = rainMode(est.km, w, world, gearCtx);
      const tr = rm.mode === est.mode || est.km === 0 ? est : planTrip(from, to, at, w, world, { mode: rm.mode });
      return est.km === 0 ? tr : { ...tr, gear: rm.gear, exposed: rm.exposed };
    } catch { return null; }
  };

  // ── timeline builder (minutes since local midnight) ──
  const blocks = [];
  const skipped = [];
  let t = toMin(wake.at);
  let place = home; // he always wakes at home (the night's sleep block is there)
  const fillKind = sick ? 'sick' : 'free';

  const push = (kind, endM, extra = {}) => {
    if (endM <= t) return;
    blocks.push({ kind, placeId: place, start: t, end: endM, ...extra });
    t = endM;
  };
  const fillUntil = (endM) => push(fillKind, endM);
  // Travel from the current place to `to`, leaving now. Returns false when no route.
  const goNow = (to) => {
    if (to === place) return true;
    const tr = trip(place, to, t);
    if (!tr) return false;
    const { from: f, to: dest, mode, km, minutes, cost } = tr;
    if (minutes > 0) {
      blocks.push({ kind: 'commute', placeId: null, start: t, end: t + minutes, from: f ?? place, to: dest ?? to, mode, km, minutes, cost,
        ...(typeof tr.gear === 'boolean' ? { gear: tr.gear, exposed: tr.exposed === true } : {}), ...routedFields(tr) });
      t += minutes;
    }
    place = to;
    return true;
  };
  // Minute to leave `from` to arrive at `to` by arriveM (recomputed once for the peak factor).
  const departFor = (from, to, arriveM) => {
    const first = trip(from, to, arriveM - 30);
    if (!first) return null;
    const second = trip(from, to, arriveM - first.minutes);
    return arriveM - (second ?? first).minutes;
  };
  const meal = (kind, atM, minutes, extra = {}) => {
    if (atM > t) fillUntil(atM);
    push(kind, t + minutes, extra);
  };

  // Sleep tonight: base (+30 before a weekend day), pushed by half a late work block.
  let workLate = null;
  if (working) {
    const forced = opts.workLateMin;
    workLate = finite(forced) ? (forced > 0 ? { minutes: Math.round(forced), p: null } : null) : rollWorkLate(v, date);
  }
  const nextWd = (wd + 1) % 7;
  let sleepM = r.baseSleep + (r.weekend.includes(nextWd) ? 30 : 0) + (workLate ? Math.round(workLate.minutes / 2) : 0);

  // ── morning ──
  let workStartM = null;
  if (type === 'office') {
    const dep = departFor(home, office, r.workStart);
    if (dep === null) {
      // No route to the office: treat the day as WFH rather than fail the plan.
      return planDay(state, d0, { ...world, self: { ...world.self, job: { ...(world.self?.job || {}), officePlaceId: home } } }, opts);
    }
    const leave = Math.max(dep, t + r.prepMinutes);
    const bAt = Math.max(r.breakfast, t + 10);
    if (bAt + BREAKFAST_MIN <= leave - 5) meal('breakfast', bAt, BREAKFAST_MIN);
    else skipped.push('breakfast');
    fillUntil(leave);
    goNow(office);
    workStartM = t;
  } else if (type === 'wfh') {
    const ws = Math.max(r.workStart, t + r.prepMinutes);
    const bAt = Math.max(r.breakfast, t + 10);
    if (bAt + BREAKFAST_MIN <= ws) meal('breakfast', bAt, BREAKFAST_MIN);
    else skipped.push('breakfast');
    fillUntil(ws);
    workStartM = t;
  } else {
    // weekend / sick: a slow breakfast at home
    meal('breakfast', Math.max(r.breakfast, t + 20), 30);
  }

  // ── work ──
  let normalEndM = null;
  if (workStartM !== null) {
    normalEndM = Math.max(r.workEnd, workStartM + 60);
    const endM = normalEndM + (workLate ? workLate.minutes : 0);
    const atOffice = type === 'office';
    const fixed = [];
    // lunch
    const lunchAt = Math.max(r.lunch.start, workStartM);
    if (lunchAt + r.lunch.minutes <= endM) {
      const coworkers = atOffice ? coworkerIds(world) : [];
      fixed.push({ kind: 'lunch', start: lunchAt, end: lunchAt + r.lunch.minutes,
        ...(coworkers.length ? { social: true, withCast: coworkers } : {}) });
    } else skipped.push('lunch');
    // meetings: count from meetings.count, times without replacement from typicalTimes
    const mr = rngFor(date, 'meetings');
    const count = mr.int(r.meetings.count[0], r.meetings.count[1]);
    for (const at of mr.shuffle(r.meetings.typicalTimes)) {
      if (fixed.filter(f => f.kind === 'meeting').length >= count) break;
      const m = { kind: 'meeting', start: at, end: at + r.meetings.minutes };
      if (m.start < workStartM || m.end > normalEndM) continue;
      if (fixed.some(f => m.start < f.end && f.start < m.end)) continue;
      const who = meetingCast(world, date, m.start);
      if (who.length) Object.assign(m, { withCast: who, social: false });
      fixed.push(m);
    }
    fixed.sort((a, b) => a.start - b.start);
    const workSegment = (untilM) => {
      if (!atOffice && untilM - t >= WFH_BREAK_AFTER) {
        const mid = t + Math.round((untilM - t - WFH_BREAK_MIN) / 2);
        push('work', mid);
        push('break', mid + WFH_BREAK_MIN);   // a short break mid-stretch, not a gap in the plan
      }
      push('work', untilM);
    };
    for (const f of fixed) {
      workSegment(f.start);
      const { kind, start, end, ...extra } = f;
      push(kind, end, extra);
    }
    workSegment(endM);
    if (workLate) blocks[blocks.length - 1].lateBy = workLate.minutes;
    workLate = workLate && { ...workLate, normalEnd: unixOf(normalEndM), end: unixOf(t) };
    if (atOffice) goNow(home);
  } else if (type === 'weekend' || type === 'sick' || type === 'off') {
    meal('lunch', Math.max(r.lunch.start, t), r.lunch.minutes);
  }

  // ── afternoon (weekend only) and evening ──
  const leisureOk = !sick && !workLate;
  const lowFuel = (finite(v.energy) && v.energy < LOW_ENERGY) || (finite(v.socialBattery) && v.socialBattery < LOW_SOCIAL);
  const pool = r.leisure.filter(l => known.has(l.placeId) && (!lowFuel || l.placeId === home));

  // Try one leisure item between t and latestEndM (travel there and back). Places it and returns true on fit.
  const tryLeisure = (item, latestEndM) => {
    if (!item) return false;
    const minutes = finite(item.minutes) ? item.minutes : 60;
    let out = 0;
    if (item.placeId !== place) {
      const tr = trip(place, item.placeId, t);
      if (!tr) return false;
      out = tr.minutes;
    }
    const back = item.placeId === home ? 0 : (trip(item.placeId, home, t + out + minutes)?.minutes ?? Infinity);
    if (t + out + minutes + back > latestEndM) return false;
    goNow(item.placeId);
    push(item.kind, t + minutes, { leisure: true });
    goNow(home);
    return true;
  };

  let afternoonKind = null;
  if ((type === 'weekend' || type === 'off') && leisureOk && pool.length) {
    const item = rngFor(date, 'leisure:afternoon').weighted(leanedLeisure(pool.filter(l => l.kind !== 'eat-out')));
    if (tryLeisure(item, r.dinner - 30)) afternoonKind = item.kind;
    else skipped.push('leisure:afternoon');
  }

  let dinnerDone = false;
  const eveningPool = pool.filter(l => l.kind !== afternoonKind); // not the same thing twice in a day
  if (leisureOk && eveningPool.length) {
    const item = rngFor(date, 'leisure:evening').weighted(leanedLeisure(eveningPool));
    if (item?.kind === 'eat-out') {
      // eating out is dinner: be at the place at dinner time
      const dep = item.placeId === place ? r.dinner : departFor(place, item.placeId, r.dinner);
      if (dep !== null && dep >= t) {
        fillUntil(dep);
        if (tryLeisure(item, sleepM - WIND_DOWN_MIN)) {
          const b = blocks.findLast(x => x.kind === 'eat-out');
          if (b) Object.assign(b, { social: true, meal: 'dinner' });
          dinnerDone = true;
        }
      }
      if (!dinnerDone) skipped.push('leisure:evening');
    } else if (item) {
      // before dinner if it fits, else after
      let placed = tryLeisure(item, r.dinner);
      if (!placed) {
        if (r.dinner > t) fillUntil(r.dinner);
        meal('dinner', t, DINNER_MIN);
        dinnerDone = true;
        placed = tryLeisure(item, sleepM - WIND_DOWN_MIN);
      }
      if (!placed) skipped.push('leisure:evening');
    }
  }
  if (!dinnerDone) {
    if (place !== home) goNow(home);
    meal('dinner', Math.max(r.dinner, t), DINNER_MIN);
  }

  // ── night ──
  if (place !== home) goNow(home);
  sleepM = Math.max(sleepM, t + 15);
  fillUntil(sleepM);
  const nextDay = d0 + 36 * 3600; // any instant on the next local day
  const nextBase = r.weekend.includes(nextWd) || world?.self?.employed === false ? r.weekendWake : r.baseWake;   // 015: unemployed sleeps in
  const nominalWakeM = toMin(atLocal(dayStartOf(nextDay, world), nextBase, tz));
  push('sleep', Math.max(nominalWakeM, t + 4 * 60));

  const out = blocks.map(b => {
    const block = { ...b, start: unixOf(b.start), end: unixOf(b.end) };
    block.availability = availabilityFor(block, world, { sick });
    return block;
  });
  const plan = {
    date,
    dayType: type,
    wakeAt: out[0]?.start ?? wake.at,
    lateBy: wake.lateBy ?? 0,
    sleepAt: unixOf(sleepM),
    nextWakeAt: out[out.length - 1].end,
    workLate,
    skipped,
    blocks: out,
    ...(gear ? { gear } : {}),
  };
  const sleepIn = !Array.isArray(opts.overrides) && hasSchedule(state) ? nextSleepIn(state, date, tz) : null;
  return overrides.length || sleepIn ? withOverrides(plan, overrides, sleepIn, { world, tz, sick, trip, home }) : plan;
}

// 014 sched (§A5.3): the day's ranges, partial backgrounds and remove/move placed
// into the planned blocks (the whole-day background already chose the day type).
// A sleep-in on the next day ends tonight's sleep block there (R32).
function withOverrides(plan, overrides, sleepIn, { world, tz, sick, trip, home }) {
  const fit = fitAnchors(plan.blocks, overrides, {
    world, tz, floor: plan.wakeAt, sick, home, startPlace: home, skipWholeDay: true,
    trip: (from, to, at) => trip(from, to, Math.round((at - dayStartOf(plan.date, world)) / 60)),
  });
  let blocks = fit.blocks;
  const last = blocks[blocks.length - 1];
  if (sleepIn && last?.kind === 'sleep' && sleepIn.to > last.start) {
    blocks = [...blocks.slice(0, -1), { ...last, end: sleepIn.to, fromOverride: true, overrideId: sleepIn.id }];
  }
  const workLate = plan.workLate && blocks.some(b => b.kind === 'work' && b.end >= plan.workLate.normalEnd) ? plan.workLate : null;
  const ids = [...overrides.map(o => o.id), ...(sleepIn ? [sleepIn.id] : [])];
  return {
    ...plan,
    sleepAt: fit.sleepAt ?? plan.sleepAt,
    nextWakeAt: blocks[blocks.length - 1]?.end ?? plan.nextWakeAt,
    workLate,
    skipped: [...plan.skipped, ...fit.skipped].slice(-16),
    blocks,
    overrides: [...new Set(ids)].sort((a, b) => a - b),
  };
}

function castList(world) {
  const cast = world?.cast;
  return cast instanceof Map ? [...cast.values()] : (Array.isArray(cast) ? cast : []);
}

function coworkerIds(world) {
  return castList(world).filter(c => c?.relation === 'coworker' && typeof c.id === 'string').slice(0, 2).map(c => c.id);
}

const MEETING_CAST_MAX = 3;
const MANAGER_IN_MEETING_P = 0.5;

/** One meeting's attendees, manager first: 1–3 work cast rolled from (date, start minute); [] with no work cast. */
function meetingCast(world, date, startM) {
  const ids = (rel) => castList(world).filter(c => c?.relation === rel && typeof c.id === 'string').map(c => c.id);
  const managers = ids('manager');
  const coworkers = ids('coworker');
  if (!managers.length && !coworkers.length) return [];
  const r = rngFor(date, `meeting.cast:${startM}`);
  const want = r.int(1, MEETING_CAST_MAX);
  const boss = managers.length && r.chance(MANAGER_IN_MEETING_P) ? [r.pick(managers)] : [];
  const out = [...boss, ...r.shuffle(coworkers).slice(0, Math.max(0, want - boss.length))];
  return out.length ? out : managers.slice(0, 1);
}

// ── Lookups and checks ───────────────────────────────────────────────────

/** The plan block covering unix `at` (start ≤ at < end), or null. */
export function blockAt(plan, at) {
  for (const b of plan?.blocks || []) if (b.start <= at && at < b.end) return b;
  return null;
}

/**
 * Structural problems in a plan (empty = sound): blocks sorted, contiguous and
 * non-empty; known places (null only for commutes); a valid availability;
 * awake from wakeAt to sleepAt; one final sleep block.
 */
export function checkPlan(plan, world) {
  const problems = [];
  const known = placeIds(world);
  const blocks = plan?.blocks || [];
  if (!blocks.length) return ['no blocks'];
  if (blocks[0].start !== plan.wakeAt) problems.push('first block does not start at wakeAt');
  blocks.forEach((b, i) => {
    if (!(b.end > b.start)) problems.push(`block ${i} (${b.kind}) is empty`);
    if (i > 0 && b.start !== blocks[i - 1].end) problems.push(`gap/overlap before block ${i} (${b.kind})`);
    if (!AVAILABILITY_STATES.includes(b.availability)) problems.push(`block ${i} has availability ${b.availability}`);
    if (b.kind === 'commute') {
      if (b.placeId !== null || !known.has(b.from) || !known.has(b.to)) problems.push(`commute ${i} has bad places`);
    } else if (!known.has(b.placeId)) problems.push(`block ${i} (${b.kind}) at unknown place ${b.placeId}`);
    if (b.kind === 'sleep' && i !== blocks.length - 1) problems.push(`sleep block ${i} is not last`);
  });
  const last = blocks[blocks.length - 1];
  if (last.kind !== 'sleep' || last.start !== plan.sleepAt) problems.push('plan does not end in sleep at sleepAt');
  return problems;
}
