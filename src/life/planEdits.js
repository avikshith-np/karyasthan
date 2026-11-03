import { dateKey, dayStart, addDays, atLocal, hhmm as clockHhmm, weekday as weekdayOf } from './clock.js';
import { planTrip } from './travel.js';
import { weatherFor } from './weather.js';
import { rainMode, rainGearOn } from './commute.js';
import { availabilityFor, checkPlan, routineOf, planDay } from './routine.js';
import { isLockedOuting, oneBeingOn, chatMadeDecision, heldPlan, INTERVIEW_MIN } from './planWeight.js';

export { chatMadeDecision };

// Schedule edits (spec 014 §A5, sched builder): the owner's overrides of his
// routine — a day off, working from home or the office, a stretch at home /
// out / at the gym / on an errand, sleeping in or an early night, a routine
// block removed or moved. Pure: no I/O, no clock reads, no rng (planDay's own
// rolls stay keyed by purpose, so an edit never shifts another roll).
//
// One `schedule.override_set` event = one override (R34): a background
// (off | work_home | work_office over [from, to), or the whole day) plus ≤ 3
// ranges, or one remove / move of a routine block. Folded by the projector into
// s.scheduleOverrides[id] (id = the event's id).
//
//   normalize(payload)                  the override as the fold keeps it, or null
//   overridesFor(state, date)           active overrides on that local date
//   overridesForPlan(state, plan, tz)   …plus tomorrow's sleep-in (it ends tonight's sleep)
//   activeRanges(state, from, to)       busy intervals for the other planners (R21)
//   wholeDayOf(overrides)               the whole-day background (routine.dayType)
//   sleepInFor(state, date, base)       the sleep-in end covering a wake, or null
//   fitAnchors(blocks, overrides, ctx)  place overrides into unix plan blocks
//   replanToday(state, at, world, o)    splice into the plan in force (R26) → plan.made payload
//   scheduleDrift(state, world)         the pulse's `schedule` item: what to re-plan, or null
//   conflictsOf(state, ov, ctx)         the preview's conflict rows (§A5.5)
//   divergeAt(a, b)                     the first time two plans differ
//   blockCause(plan, block)             THE cause of a block's events (R29)
//
// Every new step is gated on overrides being present, so a log without a
// schedule event plans exactly as before (golden-inert).

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

export const OVERRIDES_MAX = 12;           // active at once
export const PER_DATE_MAX = 4;
export const RANGES_MAX = 3;
export const RANGE_MIN_SEC = 15 * MIN;
export const RANGE_MAX_SEC = 16 * HOUR;
export const DAYS_AHEAD_MAX = 7;
export const PRUNE_DAYS = 2;
export const OPS = Object.freeze(['set', 'remove', 'move']);
export const BACKGROUND_ACTIVITIES = Object.freeze(['off', 'work_home', 'work_office']);
export const RANGE_ACTIVITIES = Object.freeze(['home', 'out', 'sleep', 'errand', 'gym', 'work_office', 'work_home']);
export const CONFLICT_TYPES = Object.freeze(['decision', 'goal', 'commitment', 'meeting', 'invite']);
export const RESOLUTIONS = Object.freeze(['cancel', 'reopen', 'keep', 'drop']);
/** Busy for other planners: everything but a background that only removes or moves work. */
export const BUSY_ACTIVITIES = Object.freeze(['home', 'out', 'sleep', 'errand', 'gym', 'work_office', 'work_home']);
const BG_DAY_TYPE = Object.freeze({ off: 'off', work_home: 'wfh', work_office: 'office' });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const MEALS = new Set(['breakfast', 'lunch', 'dinner']);
const MEAL_MIN = { breakfast: 20, lunch: 45, dinner: 40 };
const WORK_KINDS = new Set(['work', 'meeting', 'break']);
const SHOP_KINDS = ['shop', 'grocery', 'supermarket', 'market', 'mall'];
const SKIPPED_MAX = 16;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

// ── The override shape ────────────────────────────────────────────────────

/**
 * A `schedule.override_set` payload as the fold keeps it (§A5.1), or null when
 * malformed. Times are unix seconds; ranges sorted by start; ≤ 3 ranges; ≤ 4 cast
 * per range; labels ≤ 80. `conflicts` carries the preview's resolutions
 * ({type, id, resolution}, ≤ 16) for the record only.
 */
export function normalize(p) {
  if (!isObj(p)) return null;
  const op = OPS.includes(p.op) ? p.op : 'set';
  const date = typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : null;
  if (!date) return null;
  const out = { op, date };
  if (isObj(p.background)) {
    const a = p.background.activity;
    const from = time(p.background.from);
    const to = time(p.background.to);
    if (!BACKGROUND_ACTIVITIES.includes(a) || !from || !to || to <= from) return null;
    out.background = { activity: a, from, to, ...(p.background.wholeDay === true ? { wholeDay: true } : {}) };
  }
  const ranges = [];
  for (const r of Array.isArray(p.ranges) ? p.ranges.slice(0, RANGES_MAX) : []) {
    if (!isObj(r) || !RANGE_ACTIVITIES.includes(r.activity)) return null;
    const from = time(r.from);
    const to = time(r.to);
    if (!from || !to || to <= from) return null;
    const x = { activity: r.activity, from, to };
    if (typeof r.placeId === 'string' && PLACE_ID_RE.test(r.placeId)) x.placeId = r.placeId;
    const cast = Array.isArray(r.castIds) ? [...new Set(r.castIds.filter(id => typeof id === 'string' && CAST_ID_RE.test(id)))].slice(0, 4) : [];
    if (cast.length) x.castIds = cast;
    if (typeof r.label === 'string' && r.label.trim()) x.label = r.label.trim().slice(0, 80);
    ranges.push(x);
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  if (ranges.length) out.ranges = ranges;
  if (op !== 'set') {
    if (typeof p.blockKind !== 'string' || !KIND_RE.test(p.blockKind)) return null;
    out.blockKind = p.blockKind;
    if (op === 'move') {
      const moveTo = time(p.moveTo);
      if (!moveTo) return null;
      out.moveTo = moveTo;
    }
  } else if (!out.background && !out.ranges) return null;
  const conflicts = [];
  for (const c of Array.isArray(p.conflicts) ? p.conflicts.slice(0, 16) : []) {
    if (!isObj(c) || !CONFLICT_TYPES.includes(c.type) || !RESOLUTIONS.includes(c.resolution)) continue;
    const id = posInt(c.id);
    if (id) conflicts.push({ type: c.type, id, resolution: c.resolution });
  }
  out.conflicts = conflicts;
  return out;
}

/** Earliest instant an override touches (its background, a range, a move). */
export function firstFrom(o) {
  const list = [o?.background?.from, ...(Array.isArray(o?.ranges) ? o.ranges.map(r => r.from) : []), o?.moveTo].filter(finite);
  return list.length ? Math.min(...list) : null;
}

/** Latest instant an override touches. */
export function lastTo(o) {
  const list = [o?.background?.to, ...(Array.isArray(o?.ranges) ? o.ranges.map(r => r.to) : []), o?.moveTo].filter(finite);
  return list.length ? Math.max(...list) : null;
}

const byStart = (a, b) => ((firstFrom(a) ?? 0) - (firstFrom(b) ?? 0)) || a.id - b.id;

/** Every override the projection holds (active and cleared), or {}. */
function overrideMap(state) {
  return isObj(state?.scheduleOverrides) ? state.scheduleOverrides : null;
}

/** Does the projection carry any schedule state at all? (the gate for every new step) */
export function hasSchedule(state) {
  const m = overrideMap(state);
  return (!!m && Object.keys(m).length > 0) || Array.isArray(state?.plan?.overrides);
}

/** Active overrides on the local date `date`, ordered by first start, then id. */
export function overridesFor(state, date) {
  const m = overrideMap(state);
  if (!m || typeof date !== 'string') return [];
  return Object.values(m).filter(o => isObj(o) && o.status === 'active' && o.date === date).sort(byStart);
}

/** All active overrides, ordered by first start, then id. */
export function activeOverrides(state) {
  const m = overrideMap(state);
  if (!m) return [];
  return Object.values(m).filter(o => isObj(o) && o.status === 'active').sort(byStart);
}

/**
 * The overrides a plan should carry: those on its date, plus a sleep-in on the
 * next date (it sets tonight's wake, R32).
 */
export function overridesForPlan(state, plan, tz) {
  if (!plan || typeof plan.date !== 'string') return [];
  const own = overridesFor(state, plan.date);
  const next = nextDate(plan.date, tz);
  // A next-date morning sleep-in (R32), or a next-date stretch before his wake
  // ("stays up late tonight"): both belong to tonight's plan.
  const tonight = overridesFor(state, next).filter(o => morningSleep(o, state, next, tz) || nightPart(o, plan));
  return [...own, ...tonight];
}

/**
 * The part of a next-date override that falls in tonight's plan: its stretches
 * (not sleep) that start before the plan's wake, as an override with nothing
 * else (no whole-day background, no remove / move: those are the next day's).
 * Null when it has none.
 */
export function nightPart(o, plan) {
  if (!isObj(o) || !finite(plan?.nextWakeAt) || o.date === plan.date) return null;
  const ranges = (o.ranges || []).filter(r => r?.activity !== 'sleep' && finite(r.from) && r.from < plan.nextWakeAt);
  if (!ranges.length) return null;
  const { background, op, blockKind, moveTo, ...rest } = o;
  void background; void op; void blockKind; void moveTo;
  return { ...rest, ranges };
}

function nextDate(date, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  void tz;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// A morning sleep range: it starts before noon of its date and ends after its start
// (the Director checks it covers the routine wake).
function morningRange(r, d0) {
  return r?.activity === 'sleep' && finite(r.from) && finite(r.to) && r.from < d0 + 12 * HOUR && r.to <= d0 + 14 * HOUR;
}

function morningSleep(o, state, date, tz) {
  const d0 = dayOf(date, tz);
  return finite(d0) && (o.ranges || []).some(r => morningRange(r, d0));
}

function dayOf(date, tz) {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  // noon UTC of that date → its local midnight
  const noon = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) / 1000;
  return dayStart(noon, tz);
}

/** The whole-day background activity among `overrides` (the newest wins), or null. */
export function wholeDayOf(overrides) {
  let best = null;
  for (const o of Array.isArray(overrides) ? overrides : []) {
    if (o?.background?.wholeDay === true && BACKGROUND_ACTIVITIES.includes(o.background.activity) && (!best || o.id > best.id)) best = o;
  }
  return best ? best.background.activity : null;
}

/**
 * The end of a sleep range covering `baseWake` (unix) on `date`, or null. The
 * routine wake moves to it (no jitter, no debt).
 */
export function sleepInFor(state, date, baseWake, tz) {
  let to = null;
  const d0 = dayOf(date, tz);
  for (const o of overridesFor(state, date)) {
    for (const r of o.ranges || []) {
      if (morningRange(r, d0) && r.from <= baseWake && r.to > baseWake && (to === null || r.to > to)) to = r.to;
    }
  }
  return to;
}

/** The sleep-in on the day after `date` that ends tonight's sleep: { to, id } | null (R32). */
export function nextSleepIn(state, date, tz) {
  const nd = nextDate(date, tz);
  const d0 = dayOf(nd, tz);
  let best = null;
  for (const o of overridesFor(state, nd)) {
    for (const r of o.ranges || []) if (morningRange(r, d0) && (!best || r.to > best.to)) best = { to: r.to, id: o.id };
  }
  return best;
}

/**
 * Busy intervals of the active overrides overlapping [from, to): every range,
 * and an office-day background (work moved to the office). → [{ from, to, overrideId, activity }]
 */
export function activeRanges(state, from = -Infinity, to = Infinity) {
  const out = [];
  for (const o of activeOverrides(state)) {
    for (const r of o.ranges || []) {
      if (BUSY_ACTIVITIES.includes(r.activity) && r.from < to && from < r.to) out.push({ from: r.from, to: r.to, overrideId: o.id, activity: r.activity });
    }
    const bg = o.background;
    if (bg?.activity === 'work_office' && bg.from < to && from < bg.to) out.push({ from: bg.from, to: bg.to, overrideId: o.id, activity: bg.activity });
  }
  return out.sort((a, b) => a.from - b.from || a.overrideId - b.overrideId);
}

/** Is [from, to) inside an override's busy range? */
export function busyByOverride(state, from, to) {
  return hasSchedule(state) && activeRanges(state, from, to).length > 0;
}

/**
 * THE cause of a plan block's events (R29): the block's own cause first (a chat
 * outing kept as an anchor through a re-plan), then the plan that made it (an
 * amendment's outing, an override's anchor), else the morning plan.
 */
export function blockCause(plan, block) {
  if (posInt(block?.causeEventId)) return block.causeEventId;
  if (block?.fromAmendment || block?.fromOverride) return plan?.eventId;
  return plan?.basePlanEventId ?? plan?.eventId;
}

// ── Block surgery (unix-second plan blocks) ───────────────────────────────

const placeAfter = (b) => (b.kind === 'commute' ? b.to : b.placeId);
const hm4 = (at, tz) => clockHhmm(at, tz).replace(':', '');
const code = (what, at, tz) => `override:${what}:${hm4(at, tz)}`.slice(0, 32);

function placesOf(world) {
  const p = world?.places;
  return p instanceof Map ? [...p.values()] : (Array.isArray(p) ? p : []);
}

function homeOf(world) {
  return world?.self?.homePlaceId ?? placesOf(world).find(p => p?.kind === 'home')?.id ?? null;
}

function officeOf(world) {
  return world?.self?.job?.officePlaceId ?? world?.self?.officePlaceId ?? placesOf(world).find(p => p?.kind === 'office')?.id ?? null;
}

/** The place kind of `id` in `world`. */
function kindOfPlace(world, id) {
  return placesOf(world).find(p => p?.id === id)?.kind ?? null;
}

/** The routine gym place (a gym leisure item's place, else a gym-kind place), or null. */
export function gymPlaceOf(world) {
  const item = routineOf(world).leisure.find(l => l.kind === 'gym' && typeof l.placeId === 'string');
  return item?.placeId ?? placesOf(world).find(p => p?.kind === 'gym')?.id ?? null;
}

/** The shop-kind place nearest home, or null. */
export function errandPlaceOf(world) {
  const home = placesOf(world).find(p => p?.id === homeOf(world));
  const shops = placesOf(world).filter(p => SHOP_KINDS.includes(p?.kind) && finite(p.lat) && finite(p.lon));
  if (!shops.length) return null;
  if (!home) return shops[0].id;
  const d = (p) => (p.lat - home.lat) ** 2 + (p.lon - home.lon) ** 2;
  return shops.slice().sort((a, b) => d(a) - d(b) || (a.id < b.id ? -1 : 1))[0].id;
}

/** The activity kind for an outing at a place (all known to vitals.KIND_TO_CLASS). */
export function outingKind(world, placeId, from, to, tz) {
  const kind = kindOfPlace(world, placeId);
  switch (kind) {
    case 'cafe': return 'cafe';
    case 'restaurant': {
      const r = routineOf(world);
      const d0 = dayStart(from, tz);
      const meal = [r.lunch.start, r.dinner].some(m => { const at = atLocal(d0, m, tz); return from <= at + HOUR && at - HOUR < to; });
      return meal ? 'eat-out' : 'outing';
    }
    case 'bar': case 'pub': return 'social';
    case 'cinema': return 'movie';
    case 'park': return 'walk';
    case 'mall': case 'shop': case 'grocery': case 'market': return 'shopping';
    case 'gym': return 'gym';
    default: return 'outing';
  }
}

// Non-commute blocks straddling `t` are split there (a trip can't be cut).
function splitAt(blocks, t) {
  const out = [];
  for (const b of blocks) {
    if (b.kind !== 'commute' && b.start < t && t < b.end) out.push({ ...b, end: t }, { ...b, start: t });
    else out.push(b);
  }
  return out;
}

function sleepBlock(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'sleep') return blocks[i];
  return null;
}

/** Where he is just before unix `t` by the plan (null before the first block). */
function placeAt(blocks, t, fallback) {
  let p = fallback;
  for (const b of blocks) {
    if (b.start >= t) break;
    p = placeAfter(b) ?? p;
  }
  return p;
}

/**
 * Remove [s, e) from the blocks after `floor`: stays are clipped (a routine
 * leisure block that overlaps goes whole, R22), trips inside go. → { kept, removed }
 */
function carve(blocks, s, e, floor) {
  const kept = [];
  const removed = [];
  for (const b of blocks) {
    if (b.end <= s || b.start >= e || b.start < floor || b.kind === 'sleep') { kept.push(b); continue; }
    if (b.kind === 'commute' || b.leisure === true) { removed.push(b); continue; }
    if (MEALS.has(b.kind)) {
      // A meal is all or nothing: the longer piece left outside the range stays the
      // meal when it is long enough; else the whole meal moves (never a stub AND a
      // moved meal: two dinners).
      const pre = b.start < s ? s - b.start : 0;
      const post = b.end > e ? b.end - e : 0;
      const min = (MEAL_MIN[b.kind] ?? 20) * MIN;
      if (Math.max(pre, post) >= min) kept.push(pre >= post ? { ...b, end: s } : { ...b, start: e });
      else removed.push({ ...b });
      continue;
    }
    if (b.start < s) kept.push({ ...b, end: s });
    if (b.end > e) kept.push({ ...b, start: e });
    removed.push({ ...b, start: Math.max(b.start, s), end: Math.min(b.end, e) });
  }
  return { kept, removed };
}

/**
 * Make the blocks after `c.floor` a sound day again: trips that lead nowhere
 * go, a trip is added wherever he must change place (leaving in time when the
 * gap allows, else the stay starts on arrival), gaps fill with free time where
 * he is, and the night's sleep is at home. Blocks before the floor are untouched.
 */
function repair(blocks, c) {
  const list = blocks.filter(b => b && b.end > b.start).sort((a, b) => a.start - b.start || (a.kind === 'sleep') - (b.kind === 'sleep'));
  const keep = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.kind === 'commute' && b.start >= c.floor) {
      // A trip leads somewhere: to the stay at its end, or into the next trip from there.
      const n = list[i + 1];
      if (!n || (n.kind === 'commute' ? n.from !== b.to : n.placeId !== b.to)) continue;
      if (n.kind === 'commute' && n.to === b.from) continue;          // there and straight back: no stay left
    }
    keep.push(b);
  }
  const out = [];
  let place = c.startPlace ?? c.home;
  let walkedPast = false;
  let t = null;
  const made = c.fillMark ?? c.touch;   // an override's own fills and trips are its blocks
  const fill = (from, to) => {
    if (to <= from) return;
    out.push(made({ kind: c.sick ? 'sick' : 'free', placeId: place, start: from, end: to, withCast: [] }));
  };
  for (const b0 of keep) {
    if (b0.start < c.floor) {           // past, or in progress at the floor: as it is
      out.push(b0);
      t = Math.max(t ?? b0.end, b0.end);
      place = placeAfter(b0) ?? place;
      walkedPast = true;
      continue;
    }
    if (walkedPast && c.currentPlace) { place = c.currentPlace; walkedPast = false; }
    if (t === null) t = b0.start;
    if (b0.kind === 'commute') {
      if (b0.from !== place || b0.to === place) continue;
      const start = Math.max(t, b0.start);
      if (start > t) fill(t, start);
      out.push(start === b0.start ? b0 : c.touch({ ...b0, start, end: start + (b0.end - b0.start) }));
      t = start + (b0.end - b0.start);
      place = b0.to;
      continue;
    }
    const b = { ...b0 };
    let P = b.placeId ?? place;
    if (P !== place) {
      const tr = c.trip(place, P, Math.max(t, b.start - 30 * MIN));
      if (!tr || !(tr.minutes >= 0)) {
        if (b.kind === 'sleep') return null;      // can't get home to sleep: unfit
        b.placeId = place;
        P = place;
        c.touch(b);
      } else {
        const m = Math.round(tr.minutes * MIN);
        if (b.kind === 'sleep' && b.start - m < t) {
          const prev = out[out.length - 1];
          if (prev && prev.kind !== 'commute' && prev.start >= c.floor && prev.end === t && prev.end - m >= prev.start + 5 * MIN) {
            prev.end -= m;
            c.touch(prev);
            t = prev.end;
          }
        }
        const leave = Math.max(t, b.start - m);
        fill(t, leave);
        if (m > 0) out.push(made(commuteOf(tr, leave, place, P)));
        t = leave + m;
        place = P;
      }
    }
    if (b.start > t) { fill(t, b.start); t = b.start; }
    if (b.start < t) {
      if (b.kind !== 'sleep' && b.end - t < 5 * MIN) {
        if (b.end > t) { fill(t, b.end); t = b.end; }
        continue;
      }
      b.start = t;
      c.touch(b);
    }
    out.push(b);
    t = b.end;
    place = P;
  }
  // Adjacent free time at one place, both after the floor, is one block.
  const merged = [];
  for (const b of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.start >= c.floor && b.start >= c.floor && (b.kind === 'free' || b.kind === 'sick') && prev.kind === b.kind
        && prev.placeId === b.placeId && prev.end === b.start && !b.leisure && !prev.leisure
        && !!prev.fromOverride === !!b.fromOverride && (prev.overrideId ?? null) === (b.overrideId ?? null)) {
      prev.end = b.end;
      c.touch(prev);
      continue;
    }
    merged.push(b);
  }
  return merged;
}

function commuteOf(tr, start, from, to) {
  return {
    kind: 'commute', placeId: null, start, end: start + Math.round(tr.minutes * MIN),
    from: tr.from ?? from, to: tr.to ?? to, mode: tr.mode, km: tr.km, minutes: tr.minutes, cost: tr.cost,
    ...(typeof tr.gear === 'boolean' ? { gear: tr.gear, exposed: tr.exposed === true } : {}),
  };
}

/** A trip function in the routine's way: weather at departure, the day's umbrella (011). */
export function tripFn(state, world, { gear = null } = {}) {
  const v = state?.vitals || {};
  const gearCtx = { umbrella: gear?.umbrella === true, money: v.money, salary: world?.money?.salary, valence: v.mood?.valence, energy: v.energy };
  return (from, to, at) => {
    if (from === to) return { from, to, mode: 'walk', km: 0, minutes: 0, cost: 0 };
    try {
      const w = weatherFor(state, at, world);
      const est = planTrip(from, to, at, w, world);
      if (!gear || !rainGearOn()) return est;
      const rm = rainMode(est.km, w, world, gearCtx);
      const tr = rm.mode === est.mode || est.km === 0 ? est : planTrip(from, to, at, w, world, { mode: rm.mode });
      return est.km === 0 ? tr : { ...tr, gear: rm.gear, exposed: rm.exposed };
    } catch { return null; }
  };
}

function backgroundInto(blocks, bg, f, t, c, skipped) {
  const { home, office } = c;
  const list = splitAt(splitAt(blocks, f), t);
  const out = [];
  for (const b of list) {
    if (b.end <= f || b.start >= t || b.start < c.floor || b.kind === 'sleep') { out.push(b); continue; }
    const officeTrip = b.kind === 'commute' && office && (b.to === office || b.from === office);
    if (bg === 'off') {
      if (WORK_KINDS.has(b.kind)) {
        if (b.kind === 'meeting') skipped.push(code('meeting', b.start, c.tz));
        out.push(c.mark({ kind: c.sick ? 'sick' : 'free', placeId: home, start: b.start, end: b.end, withCast: [] }));
      } else if (officeTrip) continue;
      else if (b.placeId === office && office !== home) out.push(c.mark({ ...stripCompany(b), placeId: home }));
      else out.push(b);
    } else if (bg === 'work_home') {
      if (officeTrip) continue;
      if (b.placeId === office && office !== home) out.push(c.mark({ ...(b.kind === 'meeting' ? b : stripCompany(b)), placeId: home }));
      else out.push(b);
    } else {                            // work_office
      if (b.kind === 'commute') continue;
      if (MEALS.has(b.kind)) out.push(c.mark({ ...stripCompany(b), placeId: office }));
      else if (b.kind === 'meeting' || b.kind === 'work') out.push(c.mark({ ...b, placeId: office }));
      else {
        if (b.leisure === true) skipped.push(code(b.kind, b.start, c.tz));
        out.push(c.mark({ kind: 'work', placeId: office, start: b.start, end: b.end, withCast: [] }));
      }
    }
  }
  return out;
}

function stripCompany(b) {
  const { social, ...rest } = b;
  void social;
  return { ...rest, withCast: [] };
}

function anchorOf(r, c) {
  const place = (r.activity === 'home' || r.activity === 'work_home') ? c.home
    : r.activity === 'work_office' ? c.office
      : r.placeId ?? (r.activity === 'gym' ? gymPlaceOf(c.world) : r.activity === 'errand' ? errandPlaceOf(c.world) : null);
  if (!place || !placesOf(c.world).some(p => p?.id === place)) return null;
  const kind = r.activity === 'home' ? (c.sick ? 'sick' : 'free')
    : r.activity === 'out' ? outingKind(c.world, place, r.from, r.to, c.tz)
      : r.activity === 'errand' ? 'errand'
        : r.activity === 'gym' ? 'gym' : 'work';
  const cast = Array.isArray(r.castIds) ? r.castIds.slice(0, 4) : [];
  return { kind, placeId: place, start: r.from, end: r.to, withCast: cast, ...(cast.length ? { social: true } : {}) };
}

function anchorInto(blocks, a, c, skipped, meals) {
  const s = Math.max(a.start, c.floor);
  const e = Math.min(a.end, sleepBlock(blocks)?.start ?? a.end);
  if (e - s < 5 * MIN) return blocks;
  // Leave in time: carve the trip there too, when what sits before can give way.
  const from = placeAt(blocks, s, c.startPlace ?? c.home);
  let cs = s;
  if (from && from !== a.placeId) {
    const tr = c.trip(from, a.placeId, s - 30 * MIN);
    const m = tr ? Math.round(tr.minutes * MIN) : 0;
    const fixed = blocks.some(b => b.start < s && b.end > s - m && b.start >= c.floor
      && (b.kind === 'commute' || b.kind === 'sleep' || posInt(b.decisionId) || b.fromAmendment
        || (b.fromOverride && b.overrideId !== c.id && b.kind !== 'free' && b.kind !== 'sick')));
    if (m > 0 && s - m >= c.floor && !fixed) cs = s - m;
    else if (m > 0) skipped.push(code('late_start', s, c.tz));
  }
  const { kept, removed } = carve(blocks, cs, e, c.floor);
  for (const r of removed) {
    if (r.kind === 'meeting') skipped.push(code('meeting', r.start, c.tz));
    else if (r.leisure === true) skipped.push(code(r.kind, r.start, c.tz));
    else if (MEALS.has(r.kind)) {
      if (a.kind === 'eat-out' && r.kind !== 'breakfast') a.meal = r.kind;
      else if (!meals.some(m => m.kind === r.kind)) meals.push({ kind: r.kind, at: r.start, minutes: Math.round((r.end - r.start) / MIN) || MEAL_MIN[r.kind] });
    }
  }
  kept.push(c.mark({ ...a, start: s, end: e }));
  return kept;
}

// A stretch over his bedtime ("stays up late"): the night's sleep (not yet
// started) moves to the stretch's end, the gap up at home until the stretch is
// placed over it. Only while the sleep still leaves him NIGHT_MIN_SLEEP before his wake.
const NIGHT_MIN_SLEEP = 60 * MIN;
function lateNightInto(blocks, r, c) {
  const sb = sleepBlock(blocks);
  if (!sb || sb !== blocks[blocks.length - 1] || sb.start < c.floor) return blocks;
  if (!(r.to > sb.start && r.from < sb.end) || r.to > sb.end - NIGHT_MIN_SLEEP) return blocks;
  const out = blocks.slice(0, -1);
  const up = c.mark({ kind: c.sick ? 'sick' : 'free', placeId: c.home, start: sb.start, end: r.to, withCast: [] });
  out.push(up, c.mark({ ...sb, start: r.to }));
  return out;
}

function earlyNightInto(blocks, from, c, skipped) {
  const s = Math.max(from, c.floor);
  const sleep = sleepBlock(blocks);
  if (!sleep || s >= sleep.start) return blocks;
  const out = [];
  for (const b of blocks) {
    if (b === sleep) { out.push(c.mark({ ...b, start: s })); continue; }
    if (b.end <= s || b.start < c.floor) { out.push(b); continue; }
    if (b.leisure === true) { skipped.push(code(b.kind, b.start, c.tz)); continue; }
    if (b.kind === 'commute') continue;
    if (b.start < s) { out.push({ ...b, end: s }); continue; }
    if (MEALS.has(b.kind)) skipped.push(code(b.kind, b.start, c.tz));
  }
  return out;
}

function removeInto(blocks, kind, c) {
  const out = [];
  let first = null;
  for (const b of blocks) {
    if (b.kind === kind && b.start >= c.floor && b.kind !== 'sleep' && b.kind !== 'commute') {
      if (!first) first = b;
      continue;
    }
    out.push(b);
  }
  return { blocks: out, first };
}

function mealsBack(blocks, meals, c, skipped) {
  let list = blocks;
  for (const m of meals) {
    const need = m.minutes * MIN;
    const slot = list.find(b => (b.kind === 'free' || b.kind === 'sick') && b.start >= c.floor && b.end - Math.max(b.start, m.at) >= need
      && b.placeId === c.home);
    if (!slot) { skipped.push(code(m.kind, m.at, c.tz)); continue; }
    const at = Math.max(slot.start, m.at);
    const next = [];
    for (const b of list) {
      if (b !== slot) { next.push(b); continue; }
      if (at > b.start) next.push({ ...b, end: at });
      next.push(c.mark({ kind: m.kind, placeId: b.placeId, start: at, end: at + need, withCast: [] }));
      if (b.end > at + need) next.push({ ...b, start: at + need });
    }
    list = next;
  }
  return list;
}

/** One override into a copy of the blocks. → { blocks, skipped, dayType } | null (unfit) */
function applyOverride(blocks, ov, ctx) {
  const touched = ctx.touched;
  const c = {
    ...ctx,
    touch: (b) => { touched.add(b); return b; },
    id: ov.id,
    mark: (b) => { const x = { ...b, fromOverride: true, overrideId: ov.id }; touched.add(x); return x; },
  };
  c.fillMark = c.mark;
  const skipped = [];
  const meals = [];
  let bl = blocks.map(b => ({ ...b }));
  // The blocks were copied: carry the touched marks over by identity of position.
  blocks.forEach((b, i) => { if (touched.has(b)) touched.add(bl[i]); });
  let dayType = null;
  const sleep0 = sleepBlock(bl);
  const sleepStart = sleep0 ? sleep0.start : Infinity;
  if (ov.background && !(ov.background.wholeDay && ctx.skipWholeDay)) {
    const f = Math.max(ov.background.wholeDay ? -Infinity : ov.background.from, ctx.floor, bl[0]?.start ?? ctx.floor);
    const t = Math.min(ov.background.wholeDay ? Infinity : ov.background.to, sleepStart);
    if (t > f) bl = backgroundInto(bl, ov.background.activity, f, t, c, skipped);
    if (ov.background.wholeDay) dayType = BG_DAY_TYPE[ov.background.activity];
  }
  for (const r of ov.ranges || []) {
    if (r.activity === 'sleep') {
      const d0 = dayOf(ov.date, ctx.tz);
      if (morningRange(r, d0)) continue;               // the wake (routine.wakeTime / replanToday)
      const sb = sleepBlock(bl);
      if (sb && r.to >= sb.start - 15 * MIN) { bl = earlyNightInto(bl, r.from, c, skipped); continue; }
      bl = anchorInto(bl, { kind: 'nap', placeId: ctx.home, start: r.from, end: r.to, withCast: [] }, c, skipped, meals);
      continue;
    }
    const a = anchorOf(r, c);
    if (!a) return null;
    bl = lateNightInto(bl, r, c);
    bl = anchorInto(bl, a, c, skipped, meals);
  }
  if (ov.op === 'remove' || ov.op === 'move') {
    const { blocks: rest, first } = removeInto(bl, ov.blockKind, c);
    if (!first) return null;
    bl = rest;
    if (ov.op === 'move') {
      const minutes = first.end - first.start;
      bl = anchorInto(bl, { kind: first.kind, placeId: first.placeId, start: ov.moveTo, end: ov.moveTo + minutes,
        withCast: first.withCast || [], ...(first.social ? { social: true } : {}) }, c, skipped, meals);
    }
  }
  let fixed = repair(bl, c);
  if (!fixed) return null;
  if (meals.length) fixed = repair(mealsBack(fixed, meals, c, skipped), c);
  if (!fixed) return null;
  return { blocks: fixed, skipped, dayType };
}

function finish(blocks, ctx) {
  return blocks.map((b) => {
    if (!ctx.touched.has(b) && typeof b.availability === 'string') return b;
    const out = { ...b };
    out.availability = availabilityFor(out, ctx.world, { sick: ctx.sick });
    return out;
  });
}

/**
 * Place `overrides` (in order) into unix plan blocks. ctx: { world, tz, floor
 * (nothing before it moves), sick, trip(from, to, at), startPlace, currentPlace,
 * skipWholeDay (future days: the day type already did it) }. An override that
 * doesn't fit leaves the blocks as they were and adds `override:unfit:<id>`.
 * → { blocks, sleepAt, nextWakeAt, skipped, applied:[ids], dayType }
 */
export function fitAnchors(blocks, overrides, ctx) {
  const c = {
    tz: ctx.tz, world: ctx.world, floor: finite(ctx.floor) ? ctx.floor : -Infinity, sick: ctx.sick === true,
    trip: ctx.trip, home: ctx.home ?? homeOf(ctx.world), office: ctx.office ?? officeOf(ctx.world),
    startPlace: ctx.startPlace ?? null, currentPlace: ctx.currentPlace ?? null, skipWholeDay: ctx.skipWholeDay === true,
    touched: ctx.touched ?? new WeakSet(),
  };
  let cur = blocks;
  const skipped = [];
  const applied = [];
  let dayType = null;
  for (const ov of Array.isArray(overrides) ? overrides : []) {
    let next = null;
    try { next = applyOverride(cur, ov, c); } catch { next = null; }
    const sound = next && sleepBlock(next.blocks) === next.blocks[next.blocks.length - 1]
      && !checkPlan({ wakeAt: next.blocks[0]?.start, sleepAt: sleepBlock(next.blocks)?.start, blocks: finish(next.blocks, c) }, ctx.world).length;
    if (sound) {
      cur = next.blocks;
      skipped.push(...next.skipped);
      if (next.dayType) dayType = next.dayType;
    } else skipped.push(`override:unfit:${ov.id}`.slice(0, 32));
    applied.push(ov.id);
  }
  const out = finish(cur, c);
  const sb = sleepBlock(out);
  return { blocks: out, sleepAt: sb?.start ?? null, nextWakeAt: out[out.length - 1]?.end ?? null, skipped, applied, dayType };
}

// ── Today: splice into the plan in force (R26) ────────────────────────────

function tzOf(state, world) {
  return state?.world?.timezone || world?.timezone;
}

/**
 * The committed decision a chat-outing block belongs to (by place and window).
 * `also` (015 dropDecisionIds): those decisions match whatever their status (a
 * cancel may have closed one just before its re-plan).
 */
function decisionOfBlock(state, b, also = null) {
  if (posInt(b.decisionId)) return b.decisionId;
  for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if ((d?.status !== 'committed' && !also?.has(d?.id)) || d.subject?.placeId !== b.placeId) continue;
    const from = d.subject?.eventAt;
    if (finite(from) && b.start < from + 6 * HOUR && from - 2 * HOUR < b.end) return d.id;
  }
  return null;
}

/** Is this anchor's decision gone or its cause out of the projection? (R20) */
export function anchorExcluded(state, b, isExcludedId) {
  if (posInt(b?.decisionId)) {
    const d = state?.decisions instanceof Map ? state.decisions.get(b.decisionId) : null;
    if (!d || d.status !== 'committed') return true;
  }
  if (posInt(b?.causeEventId) && typeof isExcludedId === 'function' && isExcludedId(state, b.causeEventId)) return true;
  return false;
}

/**
 * The start of the first block of the plan in force he hasn't started; every block from there on is
 * still to come, however late he is running (Infinity when none). The rule of pulse.pendingBlock: the
 * newest block at or before the current activity's start, unless that activity is it. Not `b.start`
 * against the clock: a trip that overruns a departure leaves that block in the past and not started,
 * and on arrival he would still set off for it.
 */
export function firstUnstartedAt(state) {
  const blocks = Array.isArray(state?.plan?.blocks) ? state.plan.blocks : [];
  const act = state?.activity || {};
  const actAt = finite(act.startAt) ? act.startAt : -Infinity;
  let i0 = -1;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= actAt) i0 = i;
  const cur = blocks[i0];
  if (cur && cur.end > actAt && !(act.availability != null && act.kind === cur.kind)) return cur.start;
  return blocks[i0 + 1]?.start ?? Infinity;
}

/**
 * The plan in force re-planned from `at` with the active overrides (§A5.4):
 * blocks before `at` stay as they are, the current block is cut at `at`
 * (travelling → the arrival), every block outside the edits — and the day's
 * gear, workLate, wake — is kept. Committed chat outings stay anchors that point
 * at their decision and the plan they came from (R20); an anchor whose decision
 * is gone is dropped, as is the stretch of an override no longer active — both
 * refilled from his routine. → the plan.made payload, or null (no plan).
 * opts: { isExcludedId, routinePlan (tests),
 *   dropDecisionIds (015): the amended blocks of these decisions go too (refilled
 *     from his routine) — an owner cancel / pick-stay of an outing already in the plan,
 *   rebase (015): his routine itself changed (`world` is the new overlay: hired,
 *     fired, moved home, sick) → everything from the floor but the kept anchors
 *     is refilled from a fresh planDay under `world` (the date's overrides fitted
 *     by planDay itself), and the night's sleep is the routine's. Null while asleep
 *     or past bedtime (tomorrow's morning plan picks the change up). }
 */
export function replanToday(state, at, world, opts = {}) {
  const plan = state?.plan;
  if (!plan || !Array.isArray(plan.blocks) || !plan.blocks.length) return null;
  const rebase = opts.rebase === true;
  if (rebase && (state.activity?.kind === 'sleep' || (finite(plan.sleepAt) && at >= plan.sleepAt))) return null;
  const drop = new Set((Array.isArray(opts.dropDecisionIds) ? opts.dropDecisionIds : []).filter(x => posInt(x)));
  const tz = tzOf(state, world);
  let floor = at;
  const travel = state.position?.travel;
  if (travel && finite(travel.endAt) && travel.endAt > floor) floor = travel.endAt;
  const want = overridesForPlan(state, plan, tz);
  const wantIds = want.map(o => o.id).sort((a, b) => a - b);
  const have = Array.isArray(plan.overrides) ? plan.overrides : [];
  const home = homeOf(world) ?? state.self?.homePlaceId;
  const touched = new WeakSet();
  const sick = state.vitals?.sick === true;
  const trip = tripFn(state, world, { gear: isObj(plan.gear) ? plan.gear : null });
  const unstarted = firstUnstartedAt(state);
  let blocks = splitAt(plan.blocks.map(b => ({ ...b })), floor);

  // Chat outings: anchors tied to their decision and the amended plan (R20).
  const amended = blocks.filter(b => b.fromAmendment && b.start >= floor);
  for (const b of amended) {
    if (b.kind === 'commute') continue;
    const id = decisionOfBlock(state, b, drop.size ? drop : null);
    if (id) b.decisionId = id;
    if (!posInt(b.causeEventId) && posInt(plan.eventId)) b.causeEventId = plan.eventId;
  }
  for (const b of amended) {
    if (b.kind !== 'commute') continue;
    const near = amended.find(x => x.kind !== 'commute' && (x.placeId === b.to || x.placeId === b.from) && posInt(x.decisionId));
    if (near) b.decisionId = near.decisionId;
    if (!posInt(b.causeEventId) && posInt(plan.eventId)) b.causeEventId = plan.eventId;
  }

  // What goes: anchors whose decision / cause is gone, stretches of overrides no longer wanted.
  const windows = [];
  let restoreSleep = false;
  const kept = [];
  for (const b of blocks) {
    // 015: an outing called off. 020: also a block he hasn't started that a late trip has overrun (kept,
    // he would set off for it on arrival); only the part from the floor is refilled.
    if (posInt(b.decisionId) && drop.has(b.decisionId) && (b.start >= floor || b.start >= unstarted)) {
      if (b.end > floor) windows.push([Math.max(b.start, floor), b.end]);
      continue;
    }
    if (b.start >= floor && (posInt(b.decisionId) || posInt(b.causeEventId)) && anchorExcluded(state, b, opts.isExcludedId)) {
      windows.push([b.start, b.end]);
      continue;
    }
    if (b.fromOverride && posInt(b.overrideId) && !wantIds.includes(b.overrideId) && b.end > floor) {
      if (b.kind === 'sleep') { restoreSleep = true; kept.push(b); continue; }
      windows.push([Math.max(b.start, floor), b.end]);
      continue;
    }
    kept.push(b);
  }
  blocks = kept;
  const ctx = { tz, world, floor, sick, trip, home, startPlace: home, currentPlace: state.position?.travel ? null : (state.position?.placeId ?? null), touched };
  if (rebase) return rebaseToday(state, plan, blocks, floor, world, ctx, wantIds);
  if (windows.length || restoreSleep) {
    let routine = opts.routinePlan ?? null;
    if (!routine) {
      try {
        routine = planDay({ ...state, scheduleOverrides: {} }, plan.date, world, {
          wakeAt: plan.wakeAt, lateBy: plan.lateBy ?? 0, workLateMin: plan.workLate?.minutes ?? 0, overrides: [],
        });
      } catch { routine = null; }
    }
    const rb = Array.isArray(routine?.blocks) ? routine.blocks : [];
    for (const [ws, we] of windows) {
      for (const r of rb) {
        if (r.kind === 'sleep' || r.kind === 'commute' || r.end <= ws || r.start >= we) continue;
        const x = { ...r, start: Math.max(r.start, ws), end: Math.min(r.end, we) };
        if (x.end - x.start >= 5 * MIN) blocks.push(x);
      }
    }
    if (restoreSleep) {
      const rs = sleepBlock(rb);
      blocks = blocks.map((b) => {
        if (!(b.kind === 'sleep' && b.fromOverride)) return b;
        const { fromOverride, overrideId, ...rest } = b;
        void fromOverride; void overrideId;
        const x = { ...rest, start: Math.max(floor, rs?.start ?? b.start), end: rs?.end ?? b.end };
        touched.add(x);
        return x;
      });
    }
    const fixed = repair(blocks, { ...ctx, touch: (b) => { touched.add(b); return b; } });
    if (fixed) blocks = fixed;
    blocks.forEach(b => touched.add(b));
  }
  // The date's own, and a next-date stretch before his wake (its night part only).
  const add = want.filter(o => !have.includes(o.id)).map(o => (o.date === plan.date ? o : nightPart(o, plan))).filter(Boolean);
  const fit = fitAnchors(blocks, add, ctx);
  let out = fit.blocks;
  // A sleep-in tomorrow ends tonight's sleep (R32).
  const nd = nextDate(plan.date, tz);
  const ndStart = dayOf(nd, tz);
  let wakeTo = null;
  let wakeId = null;
  for (const o of want) {
    if (o.date !== nd) continue;
    for (const r of o.ranges || []) if (morningRange(r, ndStart) && (wakeTo === null || r.to > wakeTo)) { wakeTo = r.to; wakeId = o.id; }
  }
  const last = out[out.length - 1];
  if (last?.kind === 'sleep' && wakeTo && wakeTo > last.start) {
    out = [...out.slice(0, -1), { ...last, end: wakeTo, fromOverride: true, overrideId: wakeId }];
  } else if (last?.kind === 'sleep' && last.fromOverride && !wantIds.includes(last.overrideId)) {
    const { fromOverride, overrideId, ...rest } = last;
    void fromOverride; void overrideId;
    out = [...out.slice(0, -1), rest];
  }
  out = unsplit(out);
  const sleep = sleepBlock(out);
  const workLate = isObj(plan.workLate) && out.some(b => b.kind === 'work' && b.end >= (plan.workLate.normalEnd ?? Infinity)) ? plan.workLate : null;
  const oldSkipped = Array.isArray(plan.skipped) ? plan.skipped : [];
  const newSkipped = fit.skipped.slice(0, SKIPPED_MAX);
  return {
    date: plan.date, dayType: fit.dayType ?? plan.dayType, wakeAt: plan.wakeAt, lateBy: plan.lateBy ?? 0,
    sleepAt: sleep?.start ?? plan.sleepAt, nextWakeAt: out[out.length - 1]?.end ?? plan.nextWakeAt,
    workLate, skipped: [...oldSkipped.slice(0, SKIPPED_MAX - newSkipped.length), ...newSkipped],
    blocks: out,
    basePlanEventId: Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : (plan.eventId ?? null),
    overrides: wantIds,
    ...(isObj(plan.gear) ? { gear: { ...plan.gear } } : {}),
  };
}

/**
 * 015 (replanToday `rebase`): the rest of today from a fresh planDay under the
 * changed `world`. Blocks before the floor and the kept chat / outing anchors
 * stay; every other stretch from the floor to the routine's bedtime is the
 * routine's (its own override blocks included: planDay fitted the date's
 * overrides), then repaired into a sound day; the night is the routine's.
 */
function rebaseToday(state, plan, blocks, floor, world, ctx, wantIds) {
  let routine;
  try {
    routine = planDay(state, plan.date, world, { wakeAt: plan.wakeAt, lateBy: plan.lateBy ?? 0, workLateMin: 0 });
  } catch {
    return null;
  }
  const rb = Array.isArray(routine?.blocks) ? routine.blocks : [];
  const rs = sleepBlock(rb);
  if (!rs || rs.start <= floor) return null;
  const before = blocks.filter(b => b.start < floor);
  // A locked outing (owner pick, goal, adopted: pulse.isLockedOuting) is no anchor:
  // its fit (when he leaves, from where, any wait there) belonged to the old day, so
  // its blocks go and the pulse fits it again into the new one (its next tick).
  const locked = (id) => isLockedOuting(state?.decisions?.get?.(id));
  const anchors = blocks.filter(b => b.start >= floor && b.kind !== 'sleep' && posInt(b.decisionId) && b.end <= rs.start && !locked(b.decisionId));
  const free = [];
  let t = floor;
  for (const a of [...anchors].sort((x, y) => x.start - y.start)) {
    if (a.start > t) free.push([t, a.start]);
    t = Math.max(t, a.end);
  }
  if (rs.start > t) free.push([t, rs.start]);
  const out = [...before, ...anchors];
  for (const [ws, we] of free) {
    for (const r of rb) {
      if (r.kind === 'sleep' || r.kind === 'commute' || r.end <= ws || r.start >= we) continue;
      const x = { ...r, start: Math.max(r.start, ws), end: Math.min(r.end, we) };
      if (x.end - x.start >= 5 * MIN) out.push(x);
    }
  }
  const night = { ...rs, start: Math.max(floor, rs.start) };
  out.push(night);
  const touched = ctx.touched;
  const fixed = repair(out, { ...ctx, touch: (b) => { touched.add(b); return b; } });
  let list = fixed ?? out;
  list.forEach(b => touched.add(b));
  list = unsplit(finish(list, ctx));
  const sleep = sleepBlock(list);
  return {
    date: plan.date, dayType: routine.dayType ?? plan.dayType, wakeAt: plan.wakeAt, lateBy: plan.lateBy ?? 0,
    sleepAt: sleep?.start ?? routine.sleepAt, nextWakeAt: list[list.length - 1]?.end ?? routine.nextWakeAt,
    workLate: null, skipped: Array.isArray(plan.skipped) ? plan.skipped.slice(0, SKIPPED_MAX) : [], blocks: list,
    basePlanEventId: Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : (plan.eventId ?? null),
    overrides: wantIds,
    ...(isObj(plan.gear) ? { gear: { ...plan.gear } } : {}),
  };
}

// A block cut at the floor that came through unchanged is one block again.
function unsplit(blocks) {
  const out = [];
  const key = (b) => JSON.stringify({ ...b, start: 0, end: 0 });
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.end === b.start && prev.kind !== 'commute' && key(prev) === key(b)) { out[out.length - 1] = { ...prev, end: b.end }; continue; }
    out.push(b);
  }
  return out;
}

/** The exclusion signature of a schedule re-plan (R37; projector.exclusionSig). */
export function scheduleSigKey(date, ids) {
  return `schedule:${date}:${[...ids].sort((a, b) => a - b).join(',')}`;
}

// A part of the override still to come at `at`?
function relevantAt(o, at) {
  const end = lastTo(o);
  return o?.background?.wholeDay === true || (finite(end) && end > at);
}

/**
 * The pulse's `schedule` item (§A5.4, R25): the plan in force differs from the
 * active overrides that still have a part to come — one missing, one no longer
 * active (cleared, reverted, rewound) whose stretch is still ahead — or a chat
 * anchor's decision is gone. → { at, causeId, payload, sigKey, expire:[…] } | null.
 * opts: { at, isExcludedId, isUndone(key) }
 */
export function scheduleDrift(state, world, opts = {}) {
  const plan = state?.plan;
  if (!plan || !Array.isArray(plan.blocks) || !hasSchedule(state)) return null;
  const at = finite(opts.at) ? opts.at : state.at;
  if (!finite(at)) return null;
  const tz = tzOf(state, world);
  const want = overridesForPlan(state, plan, tz);
  const wantIds = want.map(o => o.id);
  const have = Array.isArray(plan.overrides) ? plan.overrides : [];
  const missing = want.filter(o => !have.includes(o.id) && relevantAt(o, at));
  const gone = have.filter(id => !wantIds.includes(id))
    .filter(id => plan.blocks.some(b => b.fromOverride && b.overrideId === id && b.end > at));
  const anchors = plan.blocks.some(b => b.end > at && (posInt(b.decisionId) || posInt(b.causeEventId)) && anchorExcluded(state, b, opts.isExcludedId));
  if (!missing.length && !gone.length && !anchors) return null;
  const sigKey = scheduleSigKey(plan.date, wantIds);
  if (typeof opts.isUndone === 'function' && opts.isUndone(sigKey)) return null;
  // R21: a committed outing (not a story decision) inside a new range → expired 'schedule'.
  const expire = [];
  for (const o of missing) {
    // What the owner kept at apply (a 'keep' row) and locked outings are never expired here:
    // a cancel comes only from the owner's own pick, appended by the Director at apply.
    const kept = new Set((Array.isArray(o.conflicts) ? o.conflicts : []).filter(c => c?.resolution === 'keep').map(c => c.id));
    for (const d of state.decisions instanceof Map ? state.decisions.values() : []) {
      if (d?.status !== 'committed' || storyFamily(d) || !finite(d.subject?.eventAt)) continue;
      if (lockedOuting(d) || kept.has(d.id)) continue;
      const w = decisionWindow(d);
      const hit = (o.ranges || []).some(r => r.from < w.to && w.from < r.to);
      if (hit && w.to > at && !expire.some(x => x.decisionId === d.id)) {
        expire.push({ decisionId: d.id, overrideId: o.id, subjectJid: typeof d.subjectJid === 'string' ? d.subjectJid : null });
      }
    }
  }
  const s1 = expire.length ? { ...state, decisions: new Map([...state.decisions].map(([k, d]) => [k, expire.some(x => x.decisionId === k) ? { ...d, status: 'cancelled' } : d])) } : state;
  const payload = replanToday(s1, at, world, { isExcludedId: opts.isExcludedId });
  if (!payload) return null;
  const newest = [...missing.map(o => o.id), ...gone.map(id => overrideMap(state)?.[id]?.clearedEventId).filter(posInt)];
  const causeId = newest.length ? Math.max(...newest) : null;
  return { at, causeId, payload, sigKey, expire };
}

// ── Conflicts (§A5.5) ─────────────────────────────────────────────────────

const STORY_KIND_RE = /^(?:career|family|romance|heavy|arc)(?:[:_.-]|$)/;

/** A story-family decision (career interview/appraisal, arc decisions): keep-only (R31). */
export function storyFamily(d) {
  return (typeof d?.category === 'string' && d.category !== '' && d.category !== 'social') || STORY_KIND_RE.test(String(d?.kind ?? ''));
}

/**
 * A plan MADE in a chat — the owner-control classification (never a god target,
 * keep-only in a conflict, "a plan from a chat" in owner text): adopted from a
 * claim, an invitation or his reply's commit, a real person as its subject, or a
 * decision.opened that itself carried a chat origin (projector `chatOpened`). A
 * routine plan a chat only nudged (a lean caused by a chat.trigger: `origins`)
 * is his own plan here; its chat origin still gates every prompt (innerState).
 */
const goLabel = (d) => (typeof d?.options?.find?.(o => o?.id === 'go')?.label === 'string'
  ? d.options.find(o => o.id === 'go').label.slice(0, 80) : (d?.kind ?? 'plan'));

/**
 * The plans an owner outing / visit set up for [from, to) runs into (Director
 * scene, 2026-11-02): open / committed decisions whose window overlaps it and
 * hasn't ended. Rows in conflictsOf's shape. The owner's new plan wins by
 * default: cancel (a goal's outing: reopen); keep leaves both committed and the
 * pulse's locked-wins rule decides on the day (no trimming, no refusal). Plans
 * made in a chat, story-family decisions and a plan already under way (past its
 * point of no return, or started) are keep-only.
 */
export function outingConflicts(state, win, ctx = {}) {
  const rows = [];
  const res = isObj(ctx.resolutions) ? ctx.resolutions : {};
  if (!finite(win?.from) || !finite(win?.to)) return rows;
  for (const d of state?.decisions instanceof Map ? [...state.decisions.values()].sort((a, b) => a.id - b.id) : []) {
    if ((d?.status !== 'open' && d?.status !== 'committed') || !finite(d.subject?.eventAt)) continue;
    const w = decisionWindow(d);
    if (w.to <= (ctx.now ?? -Infinity) || !(w.from < win.to && win.from < w.to)) continue;
    const chat = chatMadeDecision(d);
    const story = storyFamily(d);
    const now = finite(ctx.now) ? ctx.now : -Infinity;
    const underway = d.status === 'committed' && ((finite(d.ponrAt) && d.ponrAt <= now) || d.subject.eventAt <= now);
    const goal = !chat && !story && posInt(d.goalId);
    const type = d.invite === true && d.status === 'open' ? 'invite' : goal ? 'goal' : 'decision';
    // 020: a plan made in a chat competes like any other (the owner may cancel it; he then tells them).
    const choices = (chat && !oneBeingOn()) || story || underway ? ['keep'] : goal ? ['reopen', 'keep'] : ['cancel', 'keep'];
    const r = choices.includes(res[`${type}:${d.id}`]) ? res[`${type}:${d.id}`] : choices[0];
    rows.push({ type, id: d.id, label: goLabel(d), at: w.from, resolution: r, choices, outcome: r === 'keep' ? 'kept' : 'cancelled',
      ...(lockedOuting(d) || heldPlan(d) ? { locked: true } : {}), ...(chat ? { fromChat: true } : {}), ...(story ? { story: true } : {}),
      ...(underway ? { underway: true } : {}), ...(typeof d.subjectJid === 'string' ? { subjectJid: d.subjectJid } : {}) });
  }
  return rows;
}

/**
 * A decision's time window, half-open [from, to): its event to its end — the
 * late option's expiry, which is the outing's end (pulse.js decisionWindow; the
 * projector keeps no subject minutes) — else + its minutes (default 2 h). The trip
 * home after it is not part of it: a range from the outing's end never touches it.
 */
export function decisionWindow(d) {
  const from = d?.subject?.eventAt;
  const late = Array.isArray(d?.options) ? d.options.find(o => o?.id === 'late')?.expiresAt : null;
  // 020: an interview runs its own length (the projector keeps no subject minutes).
  const mins = finite(d?.subject?.minutes) ? d.subject.minutes : oneBeingOn() && d?.kind === 'career:interview' ? INTERVIEW_MIN : 120;
  const to = finite(late) && late > from ? late : from + mins * MIN;
  return { from, to };
}

/**
 * A locked outing (pulse.isLockedOuting, kept here so this module stays pure of
 * the pulse): a committed go the owner picked, a goal fitted or a chat adopted.
 * A schedule edit keeps it by default (a cancel only when the owner picks it).
 */
export function lockedOuting(d) {
  return isLockedOuting(d);
}

/** The busy spans of an override: its ranges, an office background, a remove/move's slot. */
export function spansOf(ov) {
  const out = [];
  for (const r of ov.ranges || []) out.push({ from: r.from, to: r.to, activity: r.activity });
  if (ov.background?.activity === 'work_office') out.push({ from: ov.background.from, to: ov.background.to, activity: 'work_office' });
  return out;
}

/**
 * The preview's conflict rows (§A5.5). ctx: { now, tz, plan (the plan for the
 * date: today's in force or a predicted planDay), resolutions: {'<type>:<id>': r},
 * commitments } → { rows, refusal|null, clipped (the override with kept items
 * clipped around) }. Rows: { type, id, label, at, resolution, choices, outcome,
 * locked?, trimmed? }. Windows are half-open: a range from an outing's end is no
 * conflict. A locked outing (owner / goal / adopted) is kept by default; any
 * other evening plan is cancelled by default (014). A kept plan the range covers
 * splits the range around it (pieces under RANGE_MIN_SEC go; at most RANGES_MAX
 * stay, the longest); story decisions and commitments inside a range still refuse.
 */
export function conflictsOf(state, ov, ctx = {}) {
  const rows = [];
  const res = isObj(ctx.resolutions) ? ctx.resolutions : {};
  const spans = spansOf(ov);
  const pick = (key, dflt, choices) => (choices.includes(res[key]) ? res[key] : dflt);
  let refusal = null;
  const keepWindows = [];
  const overlaps = (w) => spans.some(s => s.from < w.to && w.from < s.to);
  for (const d of state?.decisions instanceof Map ? [...state.decisions.values()].sort((a, b) => a.id - b.id) : []) {
    if ((d?.status !== 'open' && d?.status !== 'committed') || !finite(d.subject?.eventAt)) continue;
    const w = decisionWindow(d);
    if (w.to <= (ctx.now ?? -Infinity) || !overlaps(w)) continue;
    const label = typeof d.options?.find?.(o => o?.id === 'go')?.label === 'string' ? d.options.find(o => o.id === 'go').label.slice(0, 80) : (d.kind ?? 'plan');
    if (storyFamily(d)) {
      rows.push({ type: 'decision', id: d.id, label, resolution: 'keep', choices: ['keep'], outcome: 'kept', story: true });
      keepWindows.push({ ...w, reason: 'conflict_story' });
      continue;
    }
    const goal = posInt(d.goalId);
    const invite = d.invite === true && d.status === 'open';
    const type = goal ? 'goal' : invite ? 'invite' : 'decision';
    const choices = goal ? ['reopen', 'keep'] : ['cancel', 'keep'];
    // 020: a promise he'll be late for is kept like one he'll be on time for (a late promise is no weaker).
    const locked = lockedOuting(d) || heldPlan(d);
    const r = pick(`${type}:${d.id}`, locked ? 'keep' : choices[0], choices);
    const trimmed = r === 'keep' && (ov.ranges || []).some(x => x.from < w.to && w.from < x.to);
    rows.push({ type, id: d.id, label, at: w.from, resolution: r, choices, outcome: r === 'keep' ? 'kept' : 'cancelled',
      ...(locked ? { locked: true } : {}), ...(trimmed ? { trimmed: true } : {}),
      ...(chatMadeDecision(d) ? { fromChat: true } : {}),
      ...(typeof d.subjectJid === 'string' ? { subjectJid: d.subjectJid } : {}) });
    if (r === 'keep') keepWindows.push({ ...w, split: true });
  }
  for (const c of Array.isArray(ctx.commitments) ? ctx.commitments : []) {
    if (!finite(c?.dueAt)) continue;
    const w = { from: c.dueAt, to: c.dueAt + HOUR };
    if (w.to <= (ctx.now ?? -Infinity) || !overlaps(w)) continue;
    rows.push({ type: 'commitment', id: c.eventId, label: 'something he said he would do', resolution: 'keep', choices: ['keep'], outcome: 'kept' });
    keepWindows.push({ ...w, reason: 'conflict_commitment' });
  }
  const plan = ctx.plan;
  const removesWork = ov.background && (ov.background.activity === 'off' || ov.background.activity === 'work_home');
  for (const b of Array.isArray(plan?.blocks) ? plan.blocks : []) {
    if (b.kind !== 'meeting' || b.end <= (ctx.now ?? -Infinity)) continue;
    const inBg = removesWork && ov.background.activity === 'off' && (ov.background.wholeDay || (b.start < ov.background.to && ov.background.from < b.end));
    const inRange = (ov.ranges || []).some(r => r.from < b.end && b.start < r.to);
    if (!inBg && !inRange) continue;
    rows.push({ type: 'meeting', id: b.start, label: `meeting at ${clockHhmm(b.start, ctx.tz)}`, resolution: 'drop', choices: ['drop'], outcome: 'dropped' });
  }
  // Clip the ranges around what stays; a kept plan inside a range splits it, a
  // story decision / commitment inside one → refused.
  let ranges = (ov.ranges || []).map(r => ({ ...r }));
  for (const w of keepWindows) {
    const next = [];
    for (const r of ranges) {
      if (!(r.from < w.to && w.from < r.to)) { next.push(r); continue; }
      if (w.from > r.from && w.to < r.to) {
        if (w.split) { next.push({ ...r, to: w.from }, { ...r, from: w.to }); continue; }
        refusal = refusal ?? w.reason; next.push(r); continue;
      }
      if (w.from <= r.from && w.to >= r.to) continue;           // the whole range goes
      if (w.from <= r.from) next.push({ ...r, from: w.to }); else next.push({ ...r, to: w.from });
    }
    ranges = next.filter(r => r.to - r.from >= RANGE_MIN_SEC);
  }
  if (ranges.length > RANGES_MAX) {
    const longest = new Set([...ranges].sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from).slice(0, RANGES_MAX));
    ranges = ranges.filter(r => longest.has(r));
  }
  const clipped = { ...ov, ...(ranges.length ? { ranges } : {}) };
  if (!ranges.length) delete clipped.ranges;
  return { rows, refusal, clipped };
}

/** The first unix time at which two plans' blocks differ (kind, place, start, end), or null. */
export function divergeAt(a, b) {
  const x = Array.isArray(a?.blocks) ? a.blocks : [];
  const y = Array.isArray(b?.blocks) ? b.blocks : [];
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i];
    const q = y[i];
    if (!p || !q) return (p ?? q).start;
    if (p.kind !== q.kind || p.placeId !== q.placeId || p.start !== q.start || p.end !== q.end) return Math.min(p.start, q.start);
  }
  return null;
}

// ── Day helpers for the Director / prompt ────────────────────────────────

/** Local midnight of `date` ('YYYY-MM-DD') in tz. */
export function dateStart(date, tz) {
  return dayOf(date, tz);
}

/** The local date `n` days after the day of `now`. */
export function dateAfter(now, n, tz) {
  return dateKey(addDays(dayStart(now, tz), n, tz), tz);
}

/** Weekday (0–6) of a local date. */
export function weekdayOfDate(date, tz) {
  const d0 = dayOf(date, tz);
  return finite(d0) ? weekdayOf(d0 + 12 * HOUR, tz) : null;
}

export const __test = { repair, carve, splitAt, morningRange, nextDate, DAY };
