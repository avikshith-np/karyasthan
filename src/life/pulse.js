import { leanedLeisure } from './stanceSeam.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { now as clockNow, dateKey, dayStart, addDays, localParts, atLocal } from './clock.js';
import { rngFor } from './rng.js';
import { planDay, wakeTime, routineOf, blockAt, availabilityFor, dayType } from './routine.js';
import { activityClass, crossings, sickChance } from './vitals.js';
import { weatherAt, weatherFor, sameWeather, nextWeatherChangeAt } from './weather.js';
import { planTrip, routedFields } from './travel.js';
// 014 geo (§A7): a venue whose name collides with a real person's is worded by its kind.
import { safePlaceName } from './places.js';
// 018: his wallet (itemized spending, the salary catch-up).
import { walletEnabled, activitySpend, recurringDue, salaryDue } from './spending.js';
import { rainMode, soakedAt, rainGearOn } from './commute.js';
import { advanceTo, vitalsAt } from './projector.js';
import { evaluate as evaluateDecisions, openDecision as openDecisionDefault } from './decisions.js';
import { endIfDue } from './embargo.js';
import { getEvent as getEventDefault, eventsAfter as eventsAfterDefault } from './eventLog.js';
import { worldHash } from './world.js';
import { isLockedOuting, outranks, oneBeingOn, neverRethought, planWeight, goingTo, chatMadeDecision, WEIGHT, INTERVIEW_MIN } from './planWeight.js';
import { isExcludedId } from './projector.js';
import {
  hasSchedule, overridesFor, busyByOverride, scheduleDrift, anchorExcluded, blockCause as planEditsBlockCause, replanToday, firstUnstartedAt,
} from './planEdits.js';   // 014 sched

// The pulse (spec 009 plan §R2, FR-007/008): the clock that moves his life
// forward. In code only — no LLM, no network; Jev is reached only through
// decisions.js on a trigger. One tick = advance the world from the last tick
// to now in fixed grid steps of LIFE_TICK_MINUTES (15), each step:
//
//   1. everything DUE by the step, in time order, each event dated at its own
//      scheduled time (never the tick's): wake → (sick/birthday/salary/
//      deadline crunch/checkpoint) → plan.made; travel arrivals; work.late at the work block's
//      normal end; weather per 3-hour block; embargo end; a committed evening
//      plan rewriting the evening at its point of no return; the next plan block
//      (activity.ended → activity.started / travel.started / sleep.started,
//      meals); the day's evening invitation opening a timed decision;
//   2. grid checks at the step time: hunger over 80 → a snack (the only
//      threshold with an event type; the rest feed decisions and onTick);
//   3. decisions.evaluate() with the events appended since the last
//      evaluation (no trigger → no Jev call);
//   then, once per tick, onTick subscribers (008 subscribes; no second timer).
//
// Because every outcome is dated by the schedule and every check runs on the
// same grid, a catch-up after downtime (≤ LIFE_CATCHUP_HOURS, default 72)
// writes the log an uninterrupted run would have written. Beyond the cap it
// appends `world.reanchored` and the day is planned from now. Each step is a
// pure function of the projection (idempotent): re-running a step whose
// events are already folded in appends nothing, so a restart can re-walk a
// few steps from the projection's time without a stored tick cursor.
//
// The consequence chain (FR-008): routine.planDay bakes `work.late` into the
// plan; the pulse appends `work.late` at workLate.normalEnd (cause plan.made),
// the night's `sleep.started` with cause = that work.late, and the next
// morning's `woke` with cause = the sleep.started and `lateBy` from the debt
// (routine.wakeTime) — explain(woke) walks back to the late evening.
//
// Provenance: a plan rewritten by a chat-nudged decision inherits that chat's
// origin through its cause (eventLog). So that one chat can't taint every
// later day, `woke` (and so the next plan) links to its sleep.started only
// when that event is self-origin; otherwise the chain stops there.
//
// Owner reverts: the projection forgets an excluded event, so anything
// derived from it would come due again; isUndone() checks the projector's
// signatures of what was undone (a reverted block start, work.late, evening
// invitation or outing rewrite stays undone). Structural events (plan, wake,
// sleep, trips, weather) are not revertible in 009 — the facade refuses them.
//
// Writes go through deps.append (the facade's: eventLog.appendEvent + fold
// into the projection), which must return the stored event; deps.getState
// returns the live projection (not a view). Nothing here owns timers except
// start()/stop(), which the facade calls with unref'd intervals.

export const DEFAULT_TICK_MINUTES = 15;
export const SNACK_HUNGER = 80;          // hunger crossing → a snack (vitals THRESHOLDS)
export const SNACK_TO = 35;
export const PROPOSAL_P = 0.4;           // chance of an evening invitation on a plain day
export const MAX_ITEMS_PER_STEP = 200;
export const REPEAT_SAME = 3;            // the same item, the same rows, in a row in one step: it changes nothing
export const REPEAT_ANY = 25;            // ... or this often in one step, whatever it wrote
// Deadlines (plan §R3 workPressure "deadlines/crunch events, Mon morning"): on a
// work day morning, with p rolled from rngFor(date, 'work.crunch') — higher on
// Monday, when the week's deadlines land — a `work.crunch` raises work pressure
// by CRUNCH_AMOUNT. That is what can push it past 70 (work.late's threshold);
// the routine's own inflow only offsets finishing work blocks.
export const CRUNCH_P = 0.12;
export const CRUNCH_P_MONDAY = 0.3;
export const CRUNCH_AMOUNT = Object.freeze([60, 90]);

const H = 3600;
const MIN = 60;
const MEAL_KINDS = new Set(['breakfast', 'lunch', 'dinner', 'meal', 'snack', 'eat-out']);
const ERRANDS = new Set(['groceries', 'errand', 'shopping', 'chores']);
const EVENING_OPTIONS = ['go', 'late', 'stay'];
const DINNER_MIN = 40;
const WIND_DOWN_MIN = 30;

// Same-time items run in this order: wake first (everything else needs him
// up), arrivals before the next block, a decision's rewrite before the block
// it replaces, a new invitation after the block that was due.
const PRIO = { wake: 0, arrive: 1, workLate: 2, weather: 3, embargo: 4, decision: 5, block: 6, proposal: 7, plan: 8, story: 9 };
// 014 sched: the schedule re-plan runs after a decision's rewrite, before the block it replaces.
PRIO.schedule = 5.5;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tzOf = (state, world) => state?.world?.timezone || world?.timezone;
const asleep = (s) => s?.activity?.kind === 'sleep';
// 015 (plan §1.5): a departed cast member is no one's company any more. A no-op
// (same array) while nobody has departed, so pre-015 logs fold byte-identically.
const activeCast = (s, ids) => {
  const gone = s?.story?.departed;
  if (!isObj(gone) || !Object.keys(gone).length || !Array.isArray(ids)) return ids;
  return ids.filter(id => !Object.prototype.hasOwnProperty.call(gone, id));
};
// 011: an owner window that hasn't ended before the projected weather began.
// Without one the weather walk is 009's, step for step.
const windowsAhead = (s) => {
  const since = finite(s?.weather?.from) ? s.weather.from : s?.at;
  return Array.isArray(s?.weatherWindows) && s.weatherWindows.some(w => finite(w?.to) && w.to > since);
};

/**
 * Was an event of this type/time/key reverted by the owner? The projection
 * then looks as if it never happened, and the pulse would derive it as due
 * again on the next tick; the projector keeps signatures of what was undone
 * (projector.exclusionSig) so a matching item is "happened and undone".
 * `at` null matches any time (decision.opened is keyed by its subject).
 */
export function isUndone(state, type, at, key = null) {
  const sigs = state?.excludedSigs;
  if (!Array.isArray(sigs) || !sigs.length) return false;
  return sigs.some(x => x?.type === type && (at === null || x.at === at) && (x.key ?? null) === (key ?? null));
}

// ── Genesis ───────────────────────────────────────────────────────────────

/**
 * First start on an empty log: `genesis` (world hash + source + timezone + a
 * copy of world.self, so a later world.json edit can't rewrite history), then
 * one `place.created` / `cast.created` per entry, all caused by genesis.
 * opts.vitals overrides starting vitals (tests, dry run). Returns the genesis event.
 */
export function genesis(append, world, at, { vitals } = {}) {
  if (!world || !Array.isArray(world.places)) throw new Error('pulse: genesis needs a loaded world');
  const self = isObj(world.self) ? world.self : {};
  const g = append({
    type: 'genesis', at, actor: 'engine',
    payload: {
      worldHash: world.hash ?? worldHash(world),
      source: world.source ?? null,
      timezone: world.timezone,
      self: { ...self, officePlaceId: self.officePlaceId ?? self.job?.officePlaceId ?? null },
      ...(isObj(vitals) ? { vitals } : {}),
    },
  });
  for (const p of world.places) {
    append({ type: 'place.created', at, actor: 'engine', causeId: g.id, payload: { id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon } });
  }
  for (const c of Array.isArray(world.cast) ? world.cast : []) {
    append({ type: 'cast.created', at, actor: 'engine', causeId: g.id, payload: c });
  }
  return g;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Is the projected plan the one in force at `t`? (Yesterday's plan covers the night until its nominal wake.) */
export function planCurrent(state, t) {
  const p = state?.plan;
  return !!p && Array.isArray(p.blocks) && p.blocks.length > 0 && finite(p.nextWakeAt) && t < p.nextWakeAt;
}

/**
 * When he wakes from the sleep in force: routine.wakeTime() for the morning
 * after the sleep started (start + 6 h names the day; a wake that would come
 * before he fell asleep — an early-evening sleep — moves to the next day).
 * → { at, lateBy, debt, base }
 */
export function wakeFor(state, world) {
  const tz = tzOf(state, world);
  const start = state?.activity?.startAt ?? state?.sleep?.startedAt;
  if (!finite(start)) return null;
  let w = wakeTime(state, dayStart(start + 6 * H, tz), world);
  if (w.at <= start) w = wakeTime(state, addDays(start + 6 * H, 1, tz), world);
  return w;
}

function sameKind(act, block) {
  if (block.kind === 'commute') return act.kind === 'commute';
  if (block.kind === 'sleep') return act.kind === 'sleep';
  return act.kind === block.kind;
}


/** Has he started this block of the plan in force (or gone past it)? planEdits.firstUnstartedAt. */
export function blockStarted(state, b) {
  return b.start < firstUnstartedAt(state);
}

/**
 * The next plan block to start, given the current activity: the block the
 * activity sits in if that activity isn't it (just woke / arrived / ended),
 * else the one after. An activity counts as started from the plan when it
 * carries an availability (the projector's idle states don't).
 * → { block, index, at } | null
 */
export function pendingBlock(state) {
  const plan = state?.plan;
  const blocks = plan?.blocks || [];
  if (!blocks.length) return null;
  const act = state.activity || {};
  const actAt = finite(act.startAt) ? act.startAt : -Infinity;
  const started = act.availability != null;
  let i0 = -1;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= actAt) i0 = i;
  const floor = finite(plan.at) ? plan.at : -Infinity;
  let cand = null;
  if (i0 >= 0 && blocks[i0].end > actAt && !(started && sameKind(act, blocks[i0]))) {
    const b = blocks[i0];
    cand = { block: b, index: i0, at: Math.max(b.start, actAt, floor) };
  } else if (blocks[i0 + 1]) {
    cand = { block: blocks[i0 + 1], index: i0 + 1, at: Math.max(blocks[i0 + 1].start, floor) };
  }
  // A block whose start the owner reverted happened and was undone: he stays
  // as he is (idle) until the block after it.
  while (cand && blockUndone(state, cand)) {
    const b = blocks[cand.index + 1];
    cand = b ? { block: b, index: cand.index + 1, at: Math.max(b.start, floor) } : null;
  }
  return cand;
}

function blockUndone(state, { block, at }) {
  // 014 sched (R20): a chat outing kept as an anchor whose decision or plan is gone is skipped.
  if ((block.decisionId || block.causeEventId) && anchorExcluded(state, block, isExcludedId)) return true;
  if (block.kind === 'commute' || block.kind === 'sleep') return false; // structural: never revertible
  return isUndone(state, 'activity.started', at, block.kind);
}

function isEveningDecision(d) {
  // 020 §A5: a committed interview takes him there. One with no place of its own (a world with one
  // office) moves nothing, as before: it must stay committed so the hunt can reach an offer.
  if (oneBeingOn() && d?.kind === 'career:interview') return typeof d.subject?.placeId === 'string' && d.subject.placeId !== '';
  return Array.isArray(d?.options) && d.options.length === EVENING_OPTIONS.length
    && d.options.every(o => EVENING_OPTIONS.includes(o.id));
}

/**
 * The day's evening invitation (plan §R8 "plan-level decisions from routine"):
 * on a plain day (not sick, not working late), with p = PROPOSAL_P rolled from
 * rngFor(date, 'decision:evening'), the flatmate (if any) suggests one of the
 * world's outings away from home — a weekday evening (19:30–21:00) or a
 * weekend afternoon/evening (16:00–20:00), heard 1.5–4 h before. The options
 * are always go / join late / stay in. Deterministic per date and plan.
 * → { opensAt, spec } | null
 */
export function eveningProposal(plan, state, world) {
  if (!plan || !Array.isArray(plan.blocks) || plan.dayType === 'sick' || plan.workLate) return null;
  if (typeof plan.date !== 'string' || !finite(plan.wakeAt)) return null;
  const r = rngFor(plan.date, 'decision:evening');
  if (!(r() < PROPOSAL_P)) return null;
  const tz = tzOf(state, world);
  const home = state?.self?.homePlaceId;
  const places = state?.places instanceof Map ? state.places : new Map();
  const items = routineOf(world).leisure.filter(l => typeof l.placeId === 'string' && l.placeId !== home
    && places.has(l.placeId) && !ERRANDS.has(l.kind) && ['social', 'leisure'].includes(activityClass(l.kind)));
  const item = r.weighted(leanedLeisure(items));
  if (!item) return null;
  const weekend = plan.dayType === 'weekend' || plan.dayType === 'off';   // 014 sched: a day off times like a weekend
  const eventMin = weekend ? 16 * 60 + r.int(0, 8) * 30 : 19 * 60 + 30 + r.int(0, 3) * 30;
  const eventAt = atLocal(dayStart(plan.wakeAt, tz), eventMin, tz);
  const minutes = Math.min(240, Math.max(30, Math.round(finite(item.minutes) ? item.minutes : 90)));
  const opensAt = eventAt - r.int(3, 8) * 30 * MIN;
  if (opensAt < plan.wakeAt + 30 * MIN) return null;
  const busy = plan.blocks.some(b => (b.kind === 'work' || b.kind === 'meeting')
    && b.end > eventAt - 90 * MIN && b.start < eventAt + minutes * MIN);
  if (busy) return null;
  // 014 sched (R21): an override's range is busy too.
  if (busyByOverride(state, eventAt - 90 * MIN, eventAt + minutes * MIN)) return null;

  const flatmate = [...(state?.cast instanceof Map ? state.cast.values() : [])].find(c => c.relation === 'flatmate');
  const company = flatmate ? ' with the flatmate' : '';
  const place = String(safePlaceName(state, item.placeId, places.get(item.placeId)?.name || 'place')).toLowerCase();   // 014 geo
  const salary = finite(world?.money?.salary) ? world.money.salary : 0;
  const spend = Math.round(salary * (activityClass(item.kind) === 'social' ? 0.005 : 0.002));
  return {
    opensAt,
    spec: {
      kind: item.kind,
      subject: { eventAt, placeId: item.placeId, castIds: flatmate ? [flatmate.id] : [], minutes },
      options: [
        { id: 'go', label: `Go to the ${place}${company}`, go: true, kind: item.kind, spend, fun: 5 },
        { id: 'late', label: `Join later${company}`, go: 'late', kind: item.kind, minutes: Math.round(minutes / 2), spend, fun: 3 },
        { id: 'stay', label: 'Stay in and rest', kind: 'rest' },
      ],
    },
  };
}

function opened(state, spec) {
  for (const d of state?.decisions?.values?.() || []) {
    if (d.kind === spec.kind && d.subject?.eventAt === spec.subject.eventAt) return true;
  }
  // An invitation the owner reverted was heard and undone, not still to come.
  return isUndone(state, 'decision.opened', null, `${spec.kind}|${spec.subject.eventAt}`);
}

function decisionWindow(d) {
  const eventAt = d.subject?.eventAt;
  // 020: an interview runs its own length, the time the career step counts it over.
  const own = oneBeingOn() && d.kind === 'career:interview' ? INTERVIEW_MIN : 120;
  const endAt = d.options.find(o => o.id === 'late')?.expiresAt ?? (finite(eventAt) ? eventAt + own * MIN : null);
  return { eventAt, endAt };
}

/** When a committed go / join-late is acted on: the point of no return, or the late departure. */
export function applyTimeOf(d) {
  const { eventAt, endAt } = decisionWindow(d);
  if (!finite(d.ponrAt) || !finite(eventAt) || !finite(endAt)) return null;
  if (d.committed?.optionId === 'go') return d.ponrAt;
  if (d.committed?.optionId === 'late') return Math.round(d.ponrAt + (endAt - eventAt) / 2);
  return null;
}

/**
 * The plan rewritten for a committed outing, from `at`: what happened before
 * stays, then the trip there, the outing until its end, the trip home, dinner
 * at home if he hasn't had it, free time, and sleep — pushed back if he gets
 * home late (half an hour to wind down), so a late night shows up in the next
 * wake like any other. Null when he can't go (asleep, working, travelling,
 * no route, or he'd arrive in the last quarter hour).
 */
export function amendPlanForOuting(state, d, at, world) {
  const plan = state?.plan;
  if (!plan || !Array.isArray(plan.blocks)) return null;
  const { endAt } = decisionWindow(d);
  const to = d.subject?.placeId;
  const home = state.self?.homePlaceId;
  if (!finite(endAt) || !to || !home || at >= endAt) return null;
  const cur = blockAt(plan, at);
  if (cur && ['commute', 'work', 'meeting', 'sleep'].includes(cur.kind)) return null;
  // 2026-11-01 (live: a routine brewpub plan would have pulled him out of the owner's café date):
  // another plan never takes him out of, or across, a locked outing (owner / goal / adopted) in its
  // window — it can't go (the caller expires it could_not_go). A locked outing's own blocks are fine.
  if (!isLockedOuting(d) && lockedOverlap(state, plan, at, endAt)) return null;
  const from = cur?.placeId ?? state.position?.placeId ?? home;
  const trip = outingTrip(state, plan, world);
  const there = trip(from, to, at);
  if (!there) return null;
  if (at + there.minutes * MIN >= endAt - 15 * MIN) return null;

  const blocks = plan.blocks.filter(b => b.end <= at).map(b => ({ ...b }));
  if (cur && cur.start < at) blocks.push({ ...cur, end: at });
  // 010 (research R4): the outing and its two trips are the amendment's own
  // blocks (caused by the amended plan.made); every other block stays the base plan's.
  const mark0 = typeof d.subjectJid === 'string' && d.subjectJid ? { fromAmendment: true, subjectJid: d.subjectJid } : { fromAmendment: true };
  // A locked outing's blocks name their decision (the "already in the plan" check).
  // (020: a chat's plan is stamped too, whatever its option: startBlock keeps a chat's origin through it.)
  const mark = isLockedOuting(d) || (oneBeingOn() && chatMadeDecision(d)) ? { ...mark0, decisionId: d.id } : mark0;
  return outingAmendment(state, d, plan, world, { blocks, there, departAt: at, mark, trip, workLate: plan.workLate });
}

// The trip estimator of an amendment: 011 weather (owner windows first) and rain
// gear (the morning's umbrella, no new roll; base vitals, R23).
function outingTrip(state, plan, world) {
  const weather = (t) => weatherFor(state, t, world);   // 011: owner windows first
  const v = state.vitals || {};
  const gearCtx = { umbrella: plan.gear?.umbrella === true, money: v.money, salary: world?.money?.salary, valence: v.mood?.valence, energy: v.energy };
  return (a, b, t) => {
    if (a === b) return { from: a, to: b, mode: 'walk', km: 0, minutes: 0, cost: 0 };
    try {
      const w = weather(t);
      const est = planTrip(a, b, t, w, world);
      if (!rainGearOn()) return est;
      const rm = rainMode(est.km, w, world, gearCtx);
      const tr = rm.mode === est.mode ? est : planTrip(a, b, t, w, world, { mode: rm.mode });
      return isObj(plan.gear) ? { ...tr, gear: rm.gear, exposed: rm.exposed } : tr;
    } catch { return null; }
  };
}

// The amended plan from `departAt`: `blocks` (what stays), the trip there, the
// outing until its end, the trip home, dinner at home if he hasn't had it, free
// time, and sleep — pushed back if he gets home late. Null when there's no way home.
function outingAmendment(state, d, plan, world, { blocks, there, departAt, mark, trip, workLate, startAt = null }) {
  const { endAt } = decisionWindow(d);
  const to = d.subject?.placeId;
  const home = state.self?.homePlaceId;
  const sick = state.vitals?.sick === true;
  const push = (b) => blocks.push({ ...b, availability: availabilityFor(b, world, { sick }) });
  const commute = (tr, start) => push({
    kind: 'commute', placeId: null, start, end: start + tr.minutes * MIN,
    from: tr.from, to: tr.to, mode: tr.mode, km: tr.km, minutes: tr.minutes, cost: tr.cost,
    ...(typeof tr.gear === 'boolean' ? { gear: tr.gear, exposed: tr.exposed === true } : {}), ...routedFields(tr), ...mark,
  });
  let t = departAt + there.minutes * MIN;
  if (there.minutes > 0) commute(there, departAt);
  // A locked fit (startAt = the outing's time): there a little early → a short wait
  // at the venue, the outing itself from its own time.
  if (finite(startAt) && startAt > t && startAt < endAt) {
    push({ kind: sick ? 'sick' : 'free', placeId: to, start: t, end: startAt, withCast: [], ...mark });
    t = startAt;
  }
  const castIds = activeCast(state, Array.isArray(d.subject?.castIds) ? d.subject.castIds : []);
  // A locked outing that is a meal stands in for it (no dinner at home after a dinner out).
  const meal = isLockedOuting(d) ? mealOfOuting(state, d, world) : null;
  push({ kind: d.kind, placeId: to, start: t, end: endAt, withCast: castIds, ...(castIds.length ? { social: true } : {}), ...mark, ...(meal ? { meal } : {}) });
  t = endAt;
  const back = trip(to, home, t);
  if (!back) return null;
  if (back.minutes > 0) { commute(back, t); t += back.minutes * MIN; }
  const dinnerDone = d.kind === 'eat-out' || meal === 'dinner' || blocks.some(b => b.kind === 'dinner' || b.kind === 'eat-out');
  if (!dinnerDone) {
    // Home before the usual dinner time: free until then, not an early dinner.
    const zone = tzOf(state, world);
    const usual = atLocal(dayStart(plan.wakeAt ?? departAt, zone), routineOf(world).dinner, zone);
    if (usual > t) { push({ kind: sick ? 'sick' : 'free', placeId: home, start: t, end: usual, withCast: [] }); t = usual; }
    push({ kind: 'dinner', placeId: home, start: t, end: t + DINNER_MIN * MIN, withCast: [] });
    t += DINNER_MIN * MIN;
  }
  const sleepAt = Math.max(finite(plan.sleepAt) ? plan.sleepAt : t, t + WIND_DOWN_MIN * MIN);
  if (sleepAt > t) push({ kind: sick ? 'sick' : 'free', placeId: home, start: t, end: sleepAt, withCast: [] });
  const nextWakeAt = Math.max(finite(plan.nextWakeAt) ? plan.nextWakeAt : 0, sleepAt + 4 * H);
  push({ kind: 'sleep', placeId: home, start: sleepAt, end: nextWakeAt, withCast: [] });
  return {
    date: plan.date, dayType: plan.dayType, wakeAt: plan.wakeAt, lateBy: plan.lateBy, sleepAt, nextWakeAt,
    workLate, skipped: plan.skipped, blocks, amendedFor: d.id,
    // The self morning plan this amendment started from (carried through repeated amendments).
    basePlanEventId: Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : (plan.eventId ?? null),
    ...(isObj(plan.gear) ? { gear: { ...plan.gear } } : {}),   // 011: the morning's umbrella
    ...(Array.isArray(plan.overrides) ? { overrides: [...plan.overrides] } : {}),   // 014 sched (R21): no churn
  };
}

/**
 * An owner-picked, goal or chat-adopted outing (locked: no lean changes it) that
 * he goes to (integration fix, 014/015): it must fit his day, never come back
 * "could not go" because its point of no return found him at work or on the
 * way home. Committed outings on the plan's date are not missed
 */
/** A block of a committed locked outing in the plan between `from` and `to` (its trips included)? */
export function lockedOverlap(state, plan, from, to) {
  const locked = new Set();
  for (const x of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (x?.status === 'committed' && isLockedOuting(x)) locked.add(x.id);
  }
  if (!locked.size) return false;
  return (plan?.blocks ?? []).some(b => Number.isSafeInteger(b.decisionId) && locked.has(b.decisionId) && b.end > from && b.start < to);
}

// Is the time of locked outing `d` held by another committed plan that outranks it (its blocks in the plan)?
export function outranked(state, plan, d) {
  const from = d.subject?.eventAt;
  const to = d.options?.find(o => o.id === 'late')?.expiresAt ?? d.subject?.endAt ?? (finite(from) ? from + 2 * 3600 : null);
  if (!finite(from) || !finite(to)) return null;
  for (const x of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (x?.id === d.id || !isLockedOuting(x) || !outranks(x, d)) continue;
    // Only its outing holds the time: one rule whichever plan was fitted first. A plan that merely
    // overlaps the trips around it is trimmed by the fit, and a wrong could_not_go can message a real person.
    const holds = (b) => b.decisionId === x.id && b.kind !== 'commute';
    if ((plan?.blocks ?? []).some(b => holds(b) && b.end > from && b.start < to)) return x;
  }
  return null;
}

export { isLockedOuting };   // planWeight.js: a committed go that holds (owner, promise)

/** Is this outing already in the plan (a block stamped with its decision)? */
export function outingInPlan(plan, d) {
  if (!Array.isArray(plan?.blocks)) return false;
  if (plan.blocks.some(b => b.decisionId === d.id && b.kind !== 'commute')) return true;
  // 020, deploy: the pre-020 engine amended a by:'reply' outing or an interview without stamping its
  // blocks. The amendment is there, at its place and time: never fit it a second time.
  if (!oneBeingOn()) return false;
  const { eventAt, endAt } = decisionWindow(d);
  const place = d.subject?.placeId;
  return !!place && finite(eventAt) && finite(endAt) && plan.blocks.some(b => b.fromAmendment === true && !Number.isSafeInteger(b.decisionId)
    && b.kind !== 'commute' && b.placeId === place && b.start < endAt && b.end > eventAt);
}

// 020: a sick day covers this promise's time and he hasn't set off for it. An owner's plan or a goal's
// outing stays what the owner made it.
function sickThrough(s, d) {
  if (!oneBeingOn() || !goingTo(d) || neverRethought(d) || planWeight(d) !== WEIGHT.promise) return false;
  const eventAt = d.subject?.eventAt;
  if (!finite(eventAt) || eventAt <= s.at || !finite(s.sick?.until) || s.vitals?.sick !== true || s.sick.until <= eventAt) return false;
  return !(s.plan?.blocks ?? []).some(b => b.decisionId === d.id && blockStarted(s, b));
}

/**
 * A locked outing fitted into the plan in force as soon as that plan is its
 * day's: he leaves the stay he'd be at just in time — work included (he leaves
 * work early, or goes straight from the office when the outing is after work) —
 * searching back from the outing for the latest stay he can still leave from on
 * time (a stay he can't be at in time — home after a long commute — gives way to
 * the one before). None on time → the stay that gets him there earliest, if
 * before the last quarter hour; none at all → null (the ponr path then says
 * "could not go", and the Director preview warns before apply). The outing's
 * blocks carry `decisionId` (014 anchors, 015 drops, the "already fitted" check).
 */
export function fitLockedOuting(state, d, at, world) {
  const plan = state?.plan;
  if (!plan || !Array.isArray(plan.blocks) || !isLockedOuting(d)) return null;
  const eventAt = d.subject?.eventAt;
  const { endAt } = decisionWindow(d);
  const to = d.subject?.placeId;
  const home = state.self?.homePlaceId;
  if (!finite(eventAt) || !finite(endAt) || !to || !home || at >= endAt) return null;
  const trip = outingTrip(state, plan, world);
  // Going on straight from an outing (a scene's "now"): he leaves from where he is, not from the next block of his day.
  if (d.continuing === true && state.position?.placeId && !state.position.travel && state.position.placeId !== to) {
    const there = trip(state.position.placeId, to, at);
    if (there) {
      const blocks = plan.blocks.filter(b => b.end <= at).map(b => ({ ...b }));
      const base = typeof d.subjectJid === 'string' && d.subjectJid ? { fromAmendment: true, subjectJid: d.subjectJid } : { fromAmendment: true };
      return outingAmendment(state, d, plan, world, { blocks, there, departAt: at, mark: { ...base, decisionId: d.id }, trip, workLate: plan.workLate, startAt: eventAt });
    }
  }
  const stays = plan.blocks.filter(b => b.kind !== 'commute' && b.end > at && b.start < eventAt).sort((a, b) => b.start - a.start);
  let pick = null;
  let late = null;
  for (const B of stays) {
    // A sleep he hasn't started (he's awake at `at`: the pulse never fits while he
    // sleeps) before the outing: he stays up for it and leaves from home. Any
    // earlier sleep — or one under way — stops the search.
    if (B.kind === 'sleep' && !(B.start >= at && state.activity?.kind !== 'sleep')) break;
    const from = B.placeId ?? home;
    const lo = Math.max(at, B.start);
    const est = trip(from, to, lo);
    if (!est) continue;
    let dep = Math.max(lo, Math.min(B.end, eventAt - est.minutes * MIN));
    if (dep > B.end) continue;
    let there = trip(from, to, dep);
    if (!there) continue;
    // The trip at the departure may be longer than the first estimate (rush hour):
    // leave earlier within this same stay, re-estimated — a few passes — before
    // giving this stay up for an earlier one.
    for (let pass = 0; pass < 3 && dep + there.minutes * MIN > eventAt; pass++) {
      const next = Math.max(lo, Math.min(B.end, eventAt - there.minutes * MIN));
      if (next >= dep) break;
      const tr = trip(from, to, next);
      if (!tr) break;
      dep = next;
      there = tr;
    }
    const arrive = dep + there.minutes * MIN;
    if (arrive >= endAt - 15 * MIN) continue;
    const c = { B, from, dep, there, arrive };
    if (arrive <= eventAt) { pick = c; break; }
    if (!late || arrive < late.arrive) late = c;
  }
  const c = pick ?? late;
  if (!c) return null;
  const blocks = plan.blocks.filter(b => b.end <= c.dep).map(b => ({ ...b }));
  if (c.B.start < c.dep && c.B.end > c.dep) {
    // Up instead of asleep until he leaves (never a partial sleep block: it would
    // put him to sleep, and he'd sleep through the outing).
    const cut = c.B.kind === 'sleep' ? { kind: 'free', placeId: c.B.placeId ?? home, start: c.B.start, end: c.dep, withCast: [] } : { ...c.B, end: c.dep };
    if (c.B.kind === 'sleep') cut.availability = availabilityFor(cut, world, { sick: state.vitals?.sick === true });
    blocks.push(cut);
  }
  // A meal outing: the same meal at home before he leaves (not begun yet) gives way —
  // no breakfast at home at 09:40 before a 10:30 café breakfast.
  const meal = mealOfOuting(state, d, world);
  if (meal) skipMeal(blocks, meal, at, world, state.vitals?.sick === true);
  const base = typeof d.subjectJid === 'string' && d.subjectJid ? { fromAmendment: true, subjectJid: d.subjectJid } : { fromAmendment: true };
  const mark = { ...base, decisionId: d.id };
  // A daytime outing with work still to come after it: he goes back to his day.
  const back = returnToDay(state, d, plan, world, { blocks, there: c.there, departAt: c.dep, mark, trip, eventAt, endAt });
  if (back) return back;
  // Leaving work before its usual end drops a planned late stint.
  const cutWork = plan.blocks.some(b => (b.kind === 'work' || b.kind === 'meeting') && b.end > c.dep);
  const workLate = cutWork && isObj(plan.workLate) ? null : plan.workLate;
  return outingAmendment(state, d, plan, world, { blocks, there: c.there, departAt: c.dep, mark, trip, workLate, startAt: eventAt });
}

// Outing or place kinds that make it a meal (a lunch-hour outing to one replaces lunch).
const MEAL_OUTINGS = new Set(['eat-out', 'cafe', 'food', 'restaurant', 'lunch', 'dinner', 'coffee', 'drinks']);

// Which meal a locked outing stands in for (2026-11-01 live: breakfast at home at
// 09:42 before the owner's 10:30 café breakfast; dinner at home at 23:48 after the
// pizza dinner out). In order: a `meal` on the decision, a meal word in the owner's
// label (breakfast / brunch / lunch / dinner / supper), a meal kind, else an eating
// kind or a cafe / restaurant at a time inside a meal's window — breakfast until an
// hour before lunch, lunch from then until two hours after its start, dinner from
// two hours before it to midnight (the routine's times). A coffee at 16:00 is no meal.
const MEAL_WORDS = [['breakfast', 'breakfast'], ['brunch', 'breakfast'], ['lunch', 'lunch'], ['dinner', 'dinner'], ['supper', 'dinner']];
const MEAL_KIND_OF = Object.freeze({ breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner' });
const EATING_KINDS = new Set(['eat-out', 'cafe', 'coffee', 'food', 'restaurant']);
const EATING_PLACES = new Set(['cafe', 'restaurant']);
const mealWord = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(MEAL_KIND_OF, v) ? MEAL_KIND_OF[v] : null);

/** 'breakfast' | 'lunch' | 'dinner' | null — the meal a locked outing is (any other outing: null). */
export function mealOfOuting(state, d, world) {
  if (!isLockedOuting(d)) return null;
  const own = mealWord(d.meal) ?? mealWord(d.subject?.meal);
  if (own) return own;
  const label = String((d.options || []).find(o => o.id === 'go')?.label ?? '').toLowerCase();
  let best = null;
  for (const [w, m] of MEAL_WORDS) {
    const i = label.search(new RegExp(`\\b${w}`));
    if (i >= 0 && (!best || i < best.i)) best = { i, m };
  }
  if (best) return best.m;
  if (mealWord(d.kind)) return mealWord(d.kind);
  const placeKind = state?.places?.get?.(d.subject?.placeId)?.kind;
  if (!EATING_KINDS.has(d.kind) && !EATING_PLACES.has(placeKind)) return null;
  const eventAt = d.subject?.eventAt;
  const fallback = d.kind === 'eat-out' ? 'dinner' : null;   // 009: eating out is dinner
  if (!finite(eventAt)) return fallback;
  const p = localParts(eventAt, tzOf(state, world));
  const m = p.hour * 60 + p.minute;
  const r = routineOf(world);
  const lunch = finite(r.lunch?.start) ? r.lunch.start : 13 * 60;
  const dinner = finite(r.dinner) ? r.dinner : 20 * 60 + 30;
  if (m >= 4 * 60 && m < lunch - 60) return 'breakfast';
  if (m >= lunch - 60 && m < lunch + 120) return 'lunch';
  if (m >= dinner - 120) return 'dinner';
  return fallback;
}

/**
 * That meal (not begun by `from`) out of a list of blocks, in place: folded into
 * the stay just before it at the same place, else free time there.
 */
function skipMeal(blocks, meal, from, world, sick) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== meal || !(b.start >= from)) continue;
    const prev = blocks[i - 1];
    if (prev && prev.end === b.start && (prev.placeId ?? null) === (b.placeId ?? null)
        && !['commute', 'sleep', 'breakfast', 'lunch', 'dinner'].includes(prev.kind) && !Number.isSafeInteger(prev.decisionId)) {
      prev.end = b.end;
      blocks.splice(i, 1);
      i--;
      continue;
    }
    const x = { kind: sick ? 'sick' : 'free', placeId: b.placeId, start: b.start, end: b.end, withCast: [] };
    blocks[i] = { ...x, availability: availabilityFor(x, world, { sick }) };
  }
}
const RETURN_WORK_MIN = 30;   // at least this much work left after he'd be back, else the day ends as before

/**
 * A daytime locked outing with work (or a meeting) still to come after it: the
 * trip there and the outing, then back to the place the base plan has him at
 * when it ends (the office, or home on a WFH day) and the rest of the base day
 * unchanged — its work, meetings, commute home, dinner and sleep. Lunch the
 * outing took the place of comes right after his return (unless the outing was a
 * meal: its kind, or a restaurant / cafe). Null when there's no such work (an evening outing: the amendment ends
 * the day as before) or the day can't be stitched (the ponr-style tail then).
 */
function returnToDay(state, d, plan, world, { blocks, there, departAt, mark, trip, eventAt, endAt }) {
  const work = (b) => b.kind === 'work' || b.kind === 'meeting';
  if (!plan.blocks.some(b => work(b) && b.end >= endAt + RETURN_WORK_MIN * MIN)) return null;
  const to = d.subject?.placeId;
  const home = state.self?.homePlaceId;
  // Where the base plan has him once the outing is over: the stay at endAt, or the
  // destination of a trip he'd be on then.
  const at0 = plan.blocks.find(b => b.start <= endAt && b.end > endAt) ?? plan.blocks.find(b => b.start > endAt);
  if (!at0) return null;
  const resume = at0.kind === 'commute' ? at0.to : (at0.placeId ?? home);
  if (!resume || at0.kind === 'sleep') return null;
  const backTrip = trip(to, resume, endAt);
  if (!backTrip) return null;
  const ret = endAt + backTrip.minutes * MIN;
  // The base day from his return: in-progress trips go (he travels straight there);
  // the first stay is cut to start at his return and must be where he went back to.
  const tail = plan.blocks.filter(b => b.end > ret && !(b.kind === 'commute' && b.start < ret)).map(b => ({ ...b }));
  const first = tail[0];
  if (!first || first.kind === 'commute' || first.kind === 'sleep' || (first.placeId ?? home) !== resume) return null;
  if (first.start < ret) first.start = ret;
  const sick = state.vitals?.sick === true;
  const push = (b) => blocks.push({ ...b, availability: availabilityFor(b, world, { sick }) });
  const commute = (tr, start) => push({
    kind: 'commute', placeId: null, start, end: start + tr.minutes * MIN,
    from: tr.from, to: tr.to, mode: tr.mode, km: tr.km, minutes: tr.minutes, cost: tr.cost,
    ...(typeof tr.gear === 'boolean' ? { gear: tr.gear, exposed: tr.exposed === true } : {}), ...routedFields(tr), ...mark,
  });
  let t = departAt + there.minutes * MIN;
  if (there.minutes > 0) commute(there, departAt);
  if (eventAt > t && eventAt < endAt) { push({ kind: sick ? 'sick' : 'free', placeId: to, start: t, end: eventAt, withCast: [], ...mark }); t = eventAt; }
  const castIds = activeCast(state, Array.isArray(d.subject?.castIds) ? d.subject.castIds : []);
  const meal = mealOfOuting(state, d, world);
  push({ kind: d.kind, placeId: to, start: t, end: endAt, withCast: castIds, ...(castIds.length ? { social: true } : {}), ...mark, ...(meal ? { meal } : {}) });
  if (backTrip.minutes > 0) commute(backTrip, endAt);
  // Lunch the outing carved out (not a meal outing): right after his return, cut
  // from the work block he comes back to when it has room for it.
  const lunchGone = plan.blocks.some(b => b.kind === 'lunch' && b.start < ret && b.end > departAt)
    && !blocks.some(b => b.kind === 'lunch') && !MEAL_OUTINGS.has(d.kind) && !MEAL_OUTINGS.has(state.places?.get?.(to)?.kind)
    && meal !== 'lunch';
  if (lunchGone && first.kind === 'work') {
    const lunchMin = routineOf(world).lunch?.minutes ?? 45;
    if (first.end - first.start >= (lunchMin + 15) * MIN) {
      push({ kind: 'lunch', placeId: resume, start: first.start, end: first.start + lunchMin * MIN, withCast: [] });
      first.start += lunchMin * MIN;
    }
  }
  // The meal the outing was: not again later in the base day (a lunch out at 11:30, no canteen at 13:00).
  if (meal) skipMeal(tail, meal, ret, world, sick);
  for (const b of tail) blocks.push(b);
  return {
    date: plan.date, dayType: plan.dayType, wakeAt: plan.wakeAt, lateBy: plan.lateBy, sleepAt: plan.sleepAt, nextWakeAt: plan.nextWakeAt,
    workLate: plan.workLate, skipped: plan.skipped, blocks, amendedFor: d.id,
    basePlanEventId: Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : (plan.eventId ?? null),
    ...(isObj(plan.gear) ? { gear: { ...plan.gear } } : {}),
    ...(Array.isArray(plan.overrides) ? { overrides: [...plan.overrides] } : {}),
  };
}

// ── Wake him ("can't sleep") ─────────────────────────────────────────────

export const NIGHT_AWAKE_MIN = 45;   // up this long when the owner gave no "until"
const NIGHT_SLEEP_MIN = 60;          // back to sleep at least this long before his wake

/**
 * The owner's wake request due in the sleep in force: asked for a time after he
 * fell asleep and before his own wake `w`, not yet answered. The earliest wins.
 * → { id, at, reason, until } | null
 */
export function ownerWakeDue(state, w) {
  const list = state?.wakeSets;
  if (!Array.isArray(list) || !list.length || !asleep(state)) return null;
  const start = state.activity?.startAt;
  if (!finite(start) || !finite(w?.at)) return null;
  let best = null;
  for (const x of list) {
    if (!isObj(x) || finite(x.wokeAt) || !finite(x.at) || x.at <= start || x.at >= w.at) continue;
    if (!best || x.at < best.at) best = x;
  }
  return best;
}

/**
 * The night's plan after a night wake at `at`: the blocks before his sleep stay,
 * the broken sleep up to `at`, free at home until `ws.until` (default
 * NIGHT_AWAKE_MIN; kept up for a locked outing tonight), then sleep until his
 * wake (at least NIGHT_SLEEP_MIN). Same date and wake as the plan in force (it
 * still covers the night). Null without a plan or a home.
 */
export function nightPlan(state, at, ws, w, world) {
  const plan = state?.plan;
  const home = state?.self?.homePlaceId;
  if (!home || !finite(at)) return null;
  const sick = state.vitals?.sick === true;
  const tz = tzOf(state, world);
  let upTo = finite(ws?.until) && ws.until > at + 10 * MIN ? ws.until : at + NIGHT_AWAKE_MIN * MIN;
  const wakeAt0 = finite(w?.at) ? w.at : (finite(plan?.nextWakeAt) ? plan.nextWakeAt : at + 8 * H);
  for (const d of state.decisions?.values?.() || []) {
    const ev = d?.subject?.eventAt;
    if (isLockedOuting(d) && finite(ev) && ev >= at && ev < wakeAt0) upTo = Math.max(upTo, ev);
  }
  const nextWakeAt = Math.max(wakeAt0, upTo + NIGHT_SLEEP_MIN * MIN);
  const before = Array.isArray(plan?.blocks) ? plan.blocks.filter(b => b.end <= at && b.kind !== 'sleep').map(b => ({ ...b })) : [];
  const slept = state.activity?.startAt;
  const blocks = [...before];
  if (finite(slept) && slept < at) blocks.push({ kind: 'sleep', placeId: home, start: slept, end: at, withCast: [], interrupted: true, availability: 'asleep' });
  const up = { kind: sick ? 'sick' : 'free', placeId: home, start: at, end: upTo, withCast: [], awakeAtNight: true };
  blocks.push({ ...up, availability: availabilityFor(up, world, { sick }) });
  const night = { kind: 'sleep', placeId: home, start: upTo, end: nextWakeAt, withCast: [] };
  blocks.push({ ...night, availability: availabilityFor(night, world, { sick }) });
  const date = typeof plan?.date === 'string' ? plan.date : dateKey(at - 12 * H, tz);
  return {
    date, dayType: plan?.dayType ?? null, wakeAt: finite(plan?.wakeAt) ? plan.wakeAt : at, lateBy: plan?.lateBy ?? 0,
    sleepAt: upTo, nextWakeAt, workLate: null, skipped: Array.isArray(plan?.skipped) ? plan.skipped : [], blocks,
    // No basePlanEventId: the night's blocks (up, back to sleep) are caused by this
    // plan — so by the woke and the owner's request (a revert takes them all).
    wokeFor: ws.id,
    ...(isObj(plan?.gear) ? { gear: { ...plan.gear } } : {}),
    ...(Array.isArray(plan?.overrides) ? { overrides: [...plan.overrides] } : {}),
  };
}

function roundVitals(v) {
  const r1 = x => (finite(x) ? Math.round(x * 10) / 10 : null);
  const r2 = x => (finite(x) ? Math.round(x * 100) / 100 : null);
  return {
    energy: r1(v?.energy), sleepDebt: r2(v?.sleepDebt), stress: r1(v?.stress), hunger: r1(v?.hunger),
    socialBattery: r1(v?.socialBattery), workPressure: r1(v?.workPressure),
    valence: r2(v?.mood?.valence), arousal: r2(v?.mood?.arousal), sick: v?.sick === true,
    money: finite(v?.money) ? Math.round(v.money) : null,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ── The pulse ─────────────────────────────────────────────────────────────

/**
 * deps:
 *   world                     loaded world (constants)
 *   getState()                live projection (required)
 *   append(spec) → event      the facade's appender (required)
 *   now()                     unix seconds (default clock.now)
 *   tickMinutes, catchupHours default config.life
 *   openDecision / evaluateDecisions   decisions.js seams
 *   onDay(state)              after each morning's plan (the facade snapshots)
 *   isEnabled()               the life skill: while off, no new invitations and no Jev (code fallback)
 *   setInterval / clearInterval        timers for start()/stop()
 *
 * 010 seams (story-api §3.4; each defaults to 009's behaviour):
 *   storyItems(s, g) → [{ at, prio, run(add), label, id? }]   extra due items, merged after the
 *                             evening proposal; a story item that throws or appends nothing is
 *                             retired (never offered again in this process), so it can't wedge a step
 *   worldOf(state) → world    the world as of the projection (career overlay, R9); used at every
 *                             world read here except weather (default: the loaded world)
 *   blockCause(plan, block)   cause of a block's events (default plan.eventId)
 *   planCause(plan)           cause of work.late, the plan's sleep.started and the evening
 *                             invitation (default plan.eventId)
 *   eventsAfter / getEvent    eventLog reads (default: eventLog.js)
 * Returns { runTo, settle, tick, start, stop, onTick, rebase, stepSeconds, lastTickAt }.
 */
export function createPulse(deps = {}) {
  const world = deps.world;
  const getState = deps.getState;
  const append = deps.append;
  if (!world || typeof getState !== 'function' || typeof append !== 'function') {
    throw new Error('pulse: createPulse needs { world, getState, append }');
  }
  const nowFn = deps.now ?? clockNow;
  const tickMin = Number(deps.tickMinutes ?? config.life?.tickMinutes) > 0 ? Number(deps.tickMinutes ?? config.life.tickMinutes) : DEFAULT_TICK_MINUTES;
  const step = Math.max(60, Math.round(tickMin * 60));
  const capHours = Number(deps.catchupHours ?? config.life?.catchupHours);
  const capSec = (Number.isFinite(capHours) && capHours > 0 ? capHours : 72) * H;
  const open = deps.openDecision ?? openDecisionDefault;
  const evaluate = deps.evaluateDecisions ?? evaluateDecisions;
  const onDay = typeof deps.onDay === 'function' ? deps.onDay : null;
  const enabled = typeof deps.isEnabled === 'function' ? () => { try { return !!deps.isEnabled(); } catch { return true; } } : () => true;
  const setIv = deps.setInterval ?? setInterval;
  const clearIv = deps.clearInterval ?? clearInterval;
  const getEvent = typeof deps.getEvent === 'function' ? deps.getEvent : getEventDefault;
  const eventsAfter = typeof deps.eventsAfter === 'function' ? deps.eventsAfter : eventsAfterDefault;
  const storyItemsFn = typeof deps.storyItems === 'function' ? deps.storyItems : null;
  // Did he start this outing (a live activity.started at its place, in its window)? Read from the log
  // since the decision opened — only for a locked outing whose end has passed and that is still "go".
  // A "yes" is kept per decision until the set of undone events changes (a revert can take the start away).
  const startedSeen = new Map();
  const outingStarted = (s, d) => {
    const undone = `${s.excluded instanceof Set ? s.excluded.size : 0}:${Array.isArray(s.excludedRanges) ? s.excludedRanges.length : 0}`;
    if (startedSeen.get(d.id) === undone) return true;
    const yes = outingStartedRead(s, d);
    if (yes) startedSeen.set(d.id, undone);
    return yes;
  };
  const outingStartedRead = (s, d) => {
    const place = d.subject?.placeId;
    const { eventAt, endAt } = decisionWindow(d);
    if (!place || !finite(eventAt)) return true;   // nothing to look for: never expire on a guess
    const end = finite(d.subject?.endAt) ? d.subject.endAt : endAt;
    try {
      let after = Math.max(0, (Number.isSafeInteger(d.id) ? d.id : 0) - 1);   // from the decision's own opening
      for (let pages = 0; pages < 20; pages++) {
        const page = eventsAfter(after, 500);
        for (const ev of page) {
          if (ev.type === 'activity.started' && ev.payload?.placeId === place && !ev.redacted && !isExcludedId(s, ev.id)
            && ev.at >= eventAt - 2 * H && (!finite(end) || ev.at < end)) return true;
        }
        if (page.length < 500) return false;
        after = page[page.length - 1].id;
      }
    } catch { /* an unreadable log never expires a plan */ }
    return true;
  };
  // A seam that throws or returns junk falls back to 009's default.
  const worldOf = typeof deps.worldOf === 'function'
    ? (s) => { try { const w = deps.worldOf(s); return isObj(w) ? w : world; } catch { return world; } }
    : () => world;
  const causeOr = (fn, dflt, ...args) => {
    if (typeof fn !== 'function') return dflt;
    try { const id = fn(...args); return Number.isSafeInteger(id) ? id : dflt; } catch { return dflt; }
  };
  // 014 sched (R29): without a dep, a block that carries its own cause or comes
  // from an override uses planEdits.blockCause; every other block is 009's.
  const defaultCause = (plan, b) => (b?.causeEventId || b?.fromOverride ? planEditsBlockCause(plan, b) : plan.eventId);
  const blockCause = (plan, b) => causeOr(deps.blockCause, defaultCause(plan, b), plan, b);
  const planCause = (plan) => causeOr(deps.planCause, plan.eventId, plan);
  // 012 seam: fn(state, at, block, add) → true when it pushed his sleep (it
  // appended a chat.perceived pointer + sleep.delayed); absent → 009's path.
  const beforeSleep = typeof deps.beforeSleep === 'function' ? deps.beforeSleep : null;
  // 015 seam: fn(state, at, add) between the wake checkpoint and the morning
  // plan — the story appends due planned wake nudges ("wakes up exhausted"),
  // so today's plan already sees them; absent → nothing.
  const atWake = typeof deps.atWake === 'function' ? deps.atWake : null;
  // 020 G: what he remembers of the night. Live only: a sim doesn't get this. The sleep is read from before the woke.
  const atDream = typeof deps.atDream === 'function' ? deps.atDream : null;
  const dreamAt = (s, at, add, interrupted, wokeId = null) => {
    if (!atDream) return;
    try {
      atDream(getState(), { at, add, interrupted, wokeId, sleepEventId: s.sleep?.eventId ?? null, startedAt: s.sleep?.startedAt ?? null, firstNight: !Number.isSafeInteger(s.sleep?.lastWokeAt) });
    } catch (err) { logger.warn({ err: err?.message }, 'life pulse: atDream failed'); }
  };

  const subscribers = new Set();
  const failed = new Set();     // proposal / story item keys that failed (never retried in this process)
  const retired = new Map();    // item → the plan in force when it was retired (noteRan)
  let lastTickAt = null;
  let lastEvalId = null;
  let timer = null;
  let chain = Promise.resolve();

  const tz = () => tzOf(getState(), world);
  const grid = (t) => Math.floor(t / step) * step;

  function selfCause(id) {
    if (!Number.isSafeInteger(id)) return null;
    try { return getEvent(id)?.originKind === 'self' ? id : null; } catch { return null; }
  }

  // ── Due items ──────────────────────────────────────────────────────────

  function items(s, g) {
    const out = [];
    const due = (at, prio, run, label, id = null) => { if (finite(at) && at <= g) out.push({ at, prio, run, label, ...(id !== null ? { id } : {}) }); };
    if (s.genesisAt === null || s.genesisAt === undefined) return out;

    // weather (also while asleep): the first block, then each block that differs
    if (!s.weather) {
      const w = weatherFor(s, s.at, world);
      const causeId = Number.isSafeInteger(w.windowId) ? w.windowId : null;
      due(s.at, PRIO.weather, add => add({ type: 'weather.changed', at: s.at, actor: 'engine', causeId, payload: w }), 'weather');
    } else if (windowsAhead(s)) {
      // 011: owner windows. Walk the times the weather may change (block
      // boundaries ∪ window edges ∪ the projected `until`), emitting at the first
      // one whose weather differs — so a window starting mid-block lands at its
      // `from`. A window's outcome is caused by the window (a revert cascades).
      let after = finite(s.weather.from) ? s.weather.from : s.at;
      for (let i = 0; finite(after) && i < 64; i++) {
        const t = nextWeatherChangeAt(s, after, world);
        if (!finite(t) || t <= after || t > g) break;
        const w = weatherFor(s, t, world);
        if (!sameWeather(s.weather, w)) {
          const payload = { ...w, from: Math.max(finite(w.from) ? w.from : t, t) };
          const causeId = Number.isSafeInteger(w.windowId) ? w.windowId : null;
          due(t, PRIO.weather, add => add({ type: 'weather.changed', at: t, actor: 'engine', causeId, payload }), 'weather');
          break;
        }
        after = t;
      }
    } else {
      let t = finite(s.weather.until) ? s.weather.until : null;
      for (let i = 0; t !== null && t <= g && i < 32; i++) {
        const w = weatherAt(t, world);
        if (!sameWeather(s.weather, w)) {
          due(w.from, PRIO.weather, add => add({ type: 'weather.changed', at: w.from, actor: 'engine', payload: w }), 'weather');
          break;
        }
        t = w.until;
      }
    }

    const end = endIfDue(s.embargo, g);
    if (end) due(end.at, PRIO.embargo, add => add(end), 'embargo');

    const W = worldOf(s);
    if (asleep(s)) {
      const w = wakeFor(s, W);
      // Wake him (owner): a wake request due before his own wake comes first.
      const ws = w ? ownerWakeDue(s, w) : null;
      if (ws) {
        due(ws.at, PRIO.wake, add => (ws.reason === 'early_start'
          ? wakeUp(add, s, { ...w, at: ws.at, lateBy: 0 }, { wakeSetId: ws.id })
          : nightWake(add, s, ws, w)), 'wake:owner');
      } else if (w) due(w.at, PRIO.wake, add => wakeUp(add, s, w), 'wake');
      // A locked outing whose point of no return comes while he sleeps, not in the
      // plan in force: he slept through it — say so then. Not while a wake request
      // for this sleep is pending (even one set after the ponr): once he is up, the
      // fit decides (he goes late, or could_not_go when it is too late).
      const slept = s.activity?.startAt;
      for (const d of ws ? [] : s.decisions?.values?.() || []) {
        if (!isLockedOuting(d) || !isEveningDecision(d) || outingInPlan(s.plan, d)) continue;
        const ponrAt = applyTimeOf(d);
        if (!finite(ponrAt) || !finite(slept) || ponrAt < slept || (w && ponrAt >= w.at)) continue;
        const at = Math.max(ponrAt, finite(d.committed?.at) ? d.committed.at : ponrAt);
        due(at, PRIO.decision, add => add({
          type: 'decision.expired', at, actor: 'engine', causeId: d.committed.eventId ?? d.id, ...(oneBeingOn() && d.subjectJid ? { subjectJid: d.subjectJid } : {}),
          payload: { decisionId: d.id, reason: 'could_not_go' },
        }), 'outing:missed');
      }
      return out;
    }

    const travel = s.position?.travel;
    if (travel && finite(travel.endAt)) {
      due(travel.endAt, PRIO.arrive, add => add({
        type: 'travel.arrived', at: travel.endAt, actor: 'engine', causeId: travel.eventId ?? null, payload: { to: travel.to },
      }), 'arrive');
    }

    if (!planCurrent(s, g)) {
      due(s.at, PRIO.plan, add => planNow(add, s, s.at), 'plan');
      return out;
    }
    const plan = s.plan;

    const wl = plan.workLate;
    // A plan made after the work block's normal end (a rewind's or a rebase's re-plan of today) holds
    // that late evening in its own past: never append work.late dated before the plan that causes it.
    if (wl && finite(wl.normalEnd) && !(finite(s.work?.lateAt) && s.work.lateAt >= plan.wakeAt)
        && !(finite(plan.at) && wl.normalEnd < plan.at)
        && !isUndone(s, 'work.late', wl.normalEnd)) {
      due(wl.normalEnd, PRIO.workLate, add => add({
        type: 'work.late', at: wl.normalEnd, actor: 'engine', causeId: planCause(plan),
        payload: { extraMin: wl.minutes, until: wl.end, p: wl.p },
      }), 'work.late');
    }

    // 020: he rethought a plan already fitted into today (a promise he broke, a lean to stay): it
    // leaves his day: every block of it not started yet (blockStarted), never the trip he is already
    // on. That includes a departure a late trip has overrun: he must not set off, once he arrives, for
    // a plan he backed out of, and a kept block would make this item due again at once. A promise
    // reversed to 'late' leaves too, once, while its blocks are for the earlier start: the ponr path
    // below amends it at the late departure, into blocks that no longer match this.
    for (const d of oneBeingOn() ? s.decisions?.values?.() || [] : []) {
      if (d.status !== 'committed' || isLockedOuting(d)) continue;
      const late = d.committed?.optionId === 'late' && (d.reversals ?? 0) >= 1;
      if (!late && !['stay', 'skip'].includes(d.committed?.optionId)) continue;
      const mine = (plan.blocks ?? []).filter(b => b.decisionId === d.id);
      const ahead = (b) => !blockStarted(s, b);
      if (!mine.some(ahead)) continue;
      if (late) {
        const lateAt = applyTimeOf(d);
        if (!finite(lateAt) || lateAt <= s.at || !mine.some(b => b.start < lateAt) || !mine.every(ahead)) continue;
      }
      const at = Math.max(d.committed.at ?? s.at, s.at);
      if (at > g || isUndone(s, 'plan.made', at, `dropped:${d.id}`)) continue;
      const fixed = replanToday(s, at, W, { dropDecisionIds: [d.id] });
      // A plan that didn't take it out changes nothing, and would come due again at once.
      if (fixed && !(fixed.blocks ?? []).some(b => b.decisionId === d.id && ahead(b))) {
        due(at, PRIO.decision, add => add({
          type: 'plan.made', at, actor: 'engine', causeId: d.committed.eventId ?? d.id, payload: { ...fixed, droppedFor: d.id },
        }), 'outing:dropped', d.id);
      }
    }

    for (const d of s.decisions?.values?.() || []) {
      if (d.status !== 'committed' || !isEveningDecision(d)) continue;
      // 020: sick through it: he can't go, and says so (could_not_go is a back-out).
      if (sickThrough(s, d)) {
        const at = s.at;
        if (at <= g) {
          due(at, PRIO.decision, add => {
            // Caused by what broke it: undo the sick day and the plan is back (a tell already sent gets its correction).
            const exp = add({ type: 'decision.expired', at, actor: 'engine', causeId: s.sick?.eventId ?? d.committed.eventId ?? d.id, ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}), payload: { decisionId: d.id, reason: 'could_not_go' } });
            if (!(plan.blocks ?? []).some(b => b.decisionId === d.id)) return;
            const fixed = replanToday(getState(), at, W, { dropDecisionIds: [d.id] });
            if (fixed) add({ type: 'plan.made', at, actor: 'engine', causeId: exp?.id ?? d.id, payload: { ...fixed, droppedFor: d.id } });
          }, 'outing:sick', d.id);
        }
        continue;
      }
      // Integration fix (014/015): an owner / goal / adopted outing is fitted into
      // the plan of its day as soon as that plan is in force (he leaves work in
      // time), not at its point of no return, where it found him at work or on
      // the road and came back "could not go".
      if (isLockedOuting(d)) {
        // Over and never started (2026-11-02, property tests: undoing, hours or days later, the change
        // that displaced it brought it back — in a morning plan that still holds it, or for a day
        // already gone): he didn't go. Say so now, never "go" forever for a time already gone.
        const endAt = finite(d.subject?.endAt) ? d.subject.endAt : decisionWindow(d).endAt;
        if (finite(endAt) && endAt + 5 * MIN <= s.at && endAt >= s.at - 7 * 24 * H && s.at <= g && !outingStarted(s, d)) {
          const at = s.at;
          due(at, PRIO.decision, add => add({
            type: 'decision.expired', at, actor: 'engine', causeId: d.committed.eventId ?? d.id, ...(oneBeingOn() && d.subjectJid ? { subjectJid: d.subjectJid } : {}),
            payload: { decisionId: d.id, reason: 'could_not_go' },
          }), 'outing:never', d.id);
          continue;
        }
        if (outingInPlan(plan, d)) continue;
        // 020: a heavier plan (or one as heavy, committed first) holds this time: he can't be at both.
        const winner = oneBeingOn() ? outranked(s, plan, d) : null;
        if (winner) {
          const at = Math.max(applyTimeOf(d) ?? s.at, s.at);
          if (at <= g) {
            // Caused by the plan that holds the time: undo that and this one is back.
            due(at, PRIO.decision, add => add({
              type: 'decision.expired', at, actor: 'engine', causeId: winner.committed?.eventId ?? d.committed.eventId ?? d.id, ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}),
              payload: { decisionId: d.id, reason: 'could_not_go' },
            }), 'outing:outranked', d.id);
          }
          continue;
        }
        const eventAt = d.subject?.eventAt;
        // 020: never before now. A plan committed before this code ran (an accepted invitation, an
        // interview, which only now count as locked) is fitted from here on, not back-dated.
        const fitAt = Math.max(finite(d.committed.at) ? d.committed.at : s.at, finite(plan.at) ? plan.at : s.at, oneBeingOn() ? s.at : -Infinity);
        // Its day: the plan in force at the outing — a plan covers the night past
        // midnight until its wake (an outing at 01:30 is tonight's, not the plan
        // dated that morning, which starts after it).
        const itsDay = finite(eventAt) && (finite(plan.wakeAt) && finite(plan.nextWakeAt)
          ? eventAt >= plan.wakeAt && eventAt < plan.nextWakeAt
          : plan.date === dateKey(eventAt, tzOf(s, W)));
        if (itsDay && fitAt <= g && !isUndone(s, 'plan.made', null, `amended:${d.id}`)) {
          const fitted = fitLockedOuting(s, d, fitAt, W);
          if (fitted) {
            due(fitAt, PRIO.decision, add => add({
              type: 'plan.made', at: fitAt, actor: 'engine', causeId: d.committed.eventId ?? d.id, payload: fitted,
            }), 'outing:fit', d.id);
            continue;
          }
          // Its day's plan came after its point of no return (he slept through it)
          // and the outing isn't in it: he missed it — say so, never "go" forever.
          const ponrAt = applyTimeOf(d);
          if (finite(ponrAt) && finite(plan.at) && plan.at >= ponrAt) {
            due(fitAt, PRIO.decision, add => add({
              type: 'decision.expired', at: fitAt, actor: 'engine', causeId: d.committed.eventId ?? d.id, ...(oneBeingOn() && d.subjectJid ? { subjectJid: d.subjectJid } : {}),
              payload: { decisionId: d.id, reason: 'could_not_go' },
            }), 'outing:missed');
            continue;
          }
        }
      }
      const applyAt = applyTimeOf(d);
      if (!finite(applyAt) || (finite(plan.at) && plan.at >= applyAt)) continue;
      const at = Math.max(applyAt, d.committed.at ?? applyAt);
      if (at > g) continue;
      if (isUndone(s, 'plan.made', at, `amended:${d.id}`)) continue; // the owner undid the outing
      const amended = amendPlanForOuting(s, d, at, W);
      if (!amended) {
        // He committed but can't go now (working, travelling, no route, too
        // late to arrive): say so, or the decision shows "committed" forever.
        if (d.committed.optionId === 'go' || d.committed.optionId === 'late') {
          due(at, PRIO.decision, add => add({
            type: 'decision.expired', at, actor: 'engine', causeId: d.committed.eventId ?? d.id, ...(oneBeingOn() && d.subjectJid ? { subjectJid: d.subjectJid } : {}),
            payload: { decisionId: d.id, reason: 'could_not_go' },
          }), 'outing:missed');
        }
        continue;
      }
      due(at, PRIO.decision, add => add({
        type: 'plan.made', at, actor: 'engine', causeId: d.committed.eventId ?? d.id, payload: amended,
      }), 'outing', d.id);
    }

    // 014 sched (§A5.4, R25): the plan in force vs the active overrides — a
    // clear, revert or rewind, an override set without a re-plan, or a chat
    // anchor whose decision is gone → a re-plan from now (gated: no schedule
    // state → nothing). A committed outing inside a new range expires first (R21).
    if (hasSchedule(s)) {
      let dr = null;
      try {
        dr = scheduleDrift(s, W, { at: s.at, isExcludedId, isUndone: (key) => isUndone(s, 'plan.made', null, key) });
      } catch (err) {
        logger.warn({ err: err?.message }, 'life pulse: schedule drift failed');
      }
      if (dr && !(travel && finite(travel.endAt) && travel.endAt > dr.at)) {
        due(dr.at, PRIO.schedule, (add) => {
          for (const x of dr.expire) {
            add({ type: 'decision.expired', at: dr.at, actor: 'engine', causeId: x.overrideId, subjectJid: x.subjectJid,
              payload: { decisionId: x.decisionId, reason: 'schedule', overrideId: x.overrideId, ...(x.subjectJid ? { subjectJid: x.subjectJid } : {}) } });
          }
          add({ type: 'plan.made', at: dr.at, actor: 'engine', causeId: dr.causeId ?? planCause(plan), payload: dr.payload });
        }, 'schedule');
      }
    }

    if (!travel) {
      const p = pendingBlock(s);
      if (p) due(p.at, PRIO.block, add => startBlock(add, s, p), `block:${p.block.kind}`);
    }

    const pr = enabled() ? eveningProposal(plan, s, W) : null; // life off: no new invitations
    // Never before the plan existed (a day planned at genesis/re-anchor mid-afternoon).
    if (pr && !(finite(plan.at) && pr.opensAt < plan.at) && !opened(s, pr.spec)) {
      const key = `${plan.date}|${pr.spec.kind}|${pr.spec.subject.eventAt}`;
      if (!failed.has(key)) {
        due(pr.opensAt, PRIO.proposal, async () => {
          try {
            await open(getState, pr.spec, { world: worldOf(getState()), at: pr.opensAt, append, causeId: planCause(plan) });
          } catch (err) {
            failed.add(key);
            logger.warn({ err: err?.message, key }, 'life pulse: evening decision not opened');
          }
        }, 'proposal');
      }
    }

    // 010 story items (R7): dated by world time, run serialized with ticks and
    // catch-up like every item above. The story offers only what its controls
    // allow and makes every item append; the pulse still retires one that
    // throws or appends nothing (stepAt), so one bad item never stalls wake,
    // blocks and sleep.
    // Many story items date themselves max(…, s.at), so they are due up to the
    // projection's own time, not only up to the grid point: an event dated off
    // the grid (a phone check, a chat turn, a rewind at the minute it was applied)
    // moves s.at past g, and an item floating with s.at was never ≤ g while one
    // landed before every tick (2026-11-01 live: the daily pass a rewind took
    // back did not re-run until a restart).
    if (storyItemsFn) {
      const sg = Math.max(g, finite(s.at) ? s.at : g);
      let extra = [];
      try { extra = storyItemsFn(s, sg); } catch (err) {
        extra = [];
        logger.warn({ err: err?.message }, 'life pulse: story items failed');
      }
      for (const it of Array.isArray(extra) ? extra : []) {
        if (!isObj(it) || typeof it.run !== 'function' || !finite(it.at) || it.at > sg) continue;
        const label = typeof it.label === 'string' && it.label ? it.label.slice(0, 64) : 'story';
        // The story's own stable key when it gives one (010 review: `at` may float with s.at).
        const key = typeof it.key === 'string' && it.key ? `story:${it.key.slice(0, 96)}` : `story:${label}|${it.at}|${it.id ?? ''}`;
        if (failed.has(key)) continue;
        out.push({ at: it.at, prio: finite(it.prio) ? it.prio : PRIO.story, run: it.run, label: `story:${label}`, key, story: true });
      }
    }
    return out;
  }

  function nextItem(s, g, skipped = null) {
    const list = items(s, g).filter(x => !skipped?.has(itemId(x)) && !isRetired(s, x));
    if (!list.length) return null;
    list.sort((a, b) => a.at - b.at || a.prio - b.prio);
    return list[0];
  }

  // The class of the outing:dropped wedge: an item that appends and doesn't change what made it due
  // is offered again at once (it sorts first), so it burns the step, writes junk rows the log can
  // never lose, and nothing dated after it ever runs: the world stops. Every item must be idempotent
  // by itself; this is the net under them. The same item writing the same thing REPEAT_SAME times in
  // a row in one step (or REPEAT_ANY times in one step, whatever it wrote) sits out until the plan
  // in force changes.
  const itemId = (x) => x.key ?? `${x.label}|${x.id ?? ''}`;
  function isRetired(s, x) {
    if (!retired.has(itemId(x))) return false;
    if (retired.get(itemId(x)) === (s.plan?.eventId ?? null)) return true;
    retired.delete(itemId(x));
    return false;
  }
  function noteRan(ran, item, wrote) {
    const k = itemId(item);
    const r = ran.get(k) ?? { wrote: null, same: 0, any: 0 };
    r.same = wrote && r.wrote === wrote ? r.same + 1 : 1;   // an item that appends on its own (not through `add`) counts only in `any`
    r.wrote = wrote;
    r.any += 1;
    ran.set(k, r);
    if (r.same < REPEAT_SAME && r.any < REPEAT_ANY) return;
    retired.set(k, getState().plan?.eventId ?? null);
    logger.warn({ evt: 'issue', where: 'life.pulse', item: item.label, id: item.id ?? null, same: r.same, any: r.any },
      'life pulse: item keeps coming due with nothing changing; it sits out until the plan changes');
  }

  // ── Item bodies ────────────────────────────────────────────────────────

  // Wake him (owner, reason cant_sleep / woken_up): up at `ws.at`, awake at home
  // until `ws.until` (or NIGHT_AWAKE_MIN; any locked outing tonight keeps him up
  // for it — its fit replaces the rest), then back to sleep until his wake. No
  // morning (no sick / salary / crunch rolls, no new day): the night's plan is
  // re-made from now, the same date, and the morning's woke settles the broken
  // night's debt (vitals: an interrupted woke settles nothing).
  function nightWake(add, s, ws, w) {
    const at = ws.at;
    const start = s.activity?.startAt ?? s.sleep?.startedAt ?? at;
    const woke = add({
      type: 'woke', at, actor: 'engine', causeId: ws.id,
      payload: { interrupted: true, reason: ws.reason, wakeSetId: ws.id, durationMin: Math.max(0, Math.round((at - start) / 60)) },
    });
    dreamAt(s, at, add, true, woke?.id ?? null);
    const s1 = getState();
    const payload = nightPlan(s1, at, ws, w, worldOf(s1));
    if (payload) add({ type: 'plan.made', at, actor: 'engine', causeId: woke.id, payload });
  }

  function wakeUp(add, s, w, { wakeSetId = null } = {}) {
    const at = w.at;
    const start = s.activity?.startAt ?? s.sleep?.startedAt ?? at;
    // The night's outcome goes into the payload (R1 "outcomes, not rolls"):
    // slept / whole cycle as the integration would count them up to `at`.
    const night = advanceTo(s, Math.max(at, s.at ?? at), worldOf(s)).vitals?.night ?? {};
    const sleptMin = Math.max(0, Math.round(night.sleptMin ?? 0));
    const cycleMin = Math.max(sleptMin, Math.round((night.sleptMin ?? 0) + (night.awakeMin ?? 0)));
    // Genesis starts him asleep: the first "night" is a few hours, not a night.
    const firstNight = !Number.isSafeInteger(s.sleep?.lastWokeAt);
    const woke = add({
      // An owner's early start (wake him) is caused by its request: a revert takes the morning with it.
      type: 'woke', at, actor: 'engine', causeId: wakeSetId ?? selfCause(s.sleep?.eventId ?? s.activity?.eventId),
      payload: {
        lateBy: w.lateBy, debt: w.debt, durationMin: Math.max(0, Math.round((at - start) / 60)),
        sleptMin, cycleMin, ...(firstNight ? { firstNight: true } : {}), ...(wakeSetId ? { wakeSetId, reason: 'early_start' } : {}),
      },
    });
    const zone = tz();
    const date = dateKey(at, zone);
    const d0 = dayStart(at, zone);

    let s1 = getState();
    if (s1.sick && finite(s1.sick.until) && s1.sick.until <= at) {
      add({ type: 'sick.ended', at, actor: 'engine', causeId: selfCause(s1.sick.eventId), payload: {} });
      s1 = getState();
    }
    if (!s1.vitals?.sick) {
      const r = rngFor(date, 'sick');
      if (r() < sickChance(s1.vitals)) {
        const days = r.int(1, 3);
        add({ type: 'sick.started', at, actor: 'engine', causeId: woke.id, payload: { until: addDays(d0, days, zone) + 4 * H, days } });
      }
    }

    s1 = getState();
    const md = date.slice(5);
    const bday = (b, last) => typeof b === 'string' && b.slice(5) === md && !(finite(last) && dateKey(last, zone) === date);
    if (bday(s1.self?.birthdate, s1.self?.lastBirthdayAt)) add({ type: 'birthday', at, actor: 'engine', payload: {} });
    for (const c of s1.cast?.values?.() || []) {
      if (bday(c.birthday, c.lastBirthdayAt)) add({ type: 'birthday', at, actor: 'engine', payload: { castId: c.id } });
    }

    const W1 = worldOf(s1);
    const pay = W1.money?.payday;
    const salary = W1.money?.salary;
    if (walletEnabled()) {
      // 018: paid at the first wake on or after the payday (a downtime over it no
      // longer loses the month), never for a month before genesis; then the
      // recurring spends due this morning (rent, bills, the weekly basket).
      const month = salaryDue(s1, at, W1, zone, (k) => isUndone(s1, 'money.salary', null, k));
      if (month) add({ type: 'money.salary', at, actor: 'engine', payload: { amount: salary, month } });
      const s2 = getState();
      for (const r of recurringDue(s2, at, W1, zone, (k) => isUndone(s2, 'money.spent', null, k))) {
        add({ type: 'money.spent', at, actor: 'engine', payload: { amount: r.amount, for: r.for, period: r.period } });
      }
    } else if (Number.isInteger(pay) && finite(salary) && salary > 0) {
      const p = localParts(at, zone);
      const last = s1.money?.lastSalaryAt;
      if (p.day === Math.min(pay, daysInMonth(p.year, p.month))
          && !(finite(last) && dateKey(last, zone).slice(0, 7) === date.slice(0, 7))) {
        add({ type: 'money.salary', at, actor: 'engine', payload: { amount: salary } });
      }
    }

    s1 = getState();
    // 014 sched: the day's overrides (a day off → no crunch).
    const ovs = hasSchedule(s1) ? overridesFor(s1, date) : [];
    const type = dayType(d0, worldOf(s1), s1.vitals, ovs.length ? { overrides: ovs } : undefined);
    if (type === 'office' || type === 'wfh') {
      const r = rngFor(date, 'work.crunch');
      const p = localParts(at, zone).weekday === 1 ? CRUNCH_P_MONDAY : CRUNCH_P;
      if (r() < p) {
        add({ type: 'work.crunch', at, actor: 'engine', causeId: woke.id, payload: { amount: r.int(...CRUNCH_AMOUNT), reason: 'deadline' } });
      }
    }

    add({ type: 'vitals.checkpoint', at, actor: 'engine', payload: { date, vitals: roundVitals(getState().vitals) } });
    if (atWake) {
      try { atWake(getState(), at, add); } catch (err) { logger.warn({ err: err?.message }, 'life pulse: atWake failed'); }
    }
    dreamAt(s, at, add, false);
    const s2 = getState();
    const plan = planDay(s2, at, worldOf(s2), { wakeAt: at, lateBy: w.lateBy });
    add({ type: 'plan.made', at, actor: 'engine', causeId: woke.id, payload: plan });
    if (onDay) {
      try { onDay(getState()); } catch (err) { logger.warn({ err: err?.message }, 'life pulse: onDay failed'); }
    }
  }

  // No plan in force while awake (genesis, re-anchor): plan the day as it
  // would have gone; if that has him asleep now, he is.
  function planNow(add, s, at) {
    const plan = planDay(s, at, worldOf(s));
    if (at < plan.wakeAt) {
      add({ type: 'sleep.started', at, actor: 'engine', payload: { until: plan.wakeAt } });
    } else if (at >= plan.sleepAt) {
      add({ type: 'sleep.started', at, actor: 'engine', payload: { until: plan.nextWakeAt } });
    } else {
      add({ type: 'plan.made', at, actor: 'engine', payload: plan });
    }
  }

  function startBlock(add, s, { block: b, at }) {
    // 012: a live chat may push his sleep — asked before anything ends, so the
    // current activity runs on and the sleep block comes due at its new start.
    if (b.kind === 'sleep' && beforeSleep) {
      let pushed = false;
      try { pushed = beforeSleep(s, at, b, add) === true; } catch (err) {
        logger.warn({ err: err?.message }, 'life pulse: beforeSleep failed');
      }
      if (pushed) return;
    }
    const plan = s.plan;
    const act = s.activity || {};
    const causeId = blockCause(plan, b);
    const subjectJid = typeof b.subjectJid === 'string' && b.subjectJid ? b.subjectJid : null;
    const chatOrigin = chatPlanOrigin(s, b, causeId);
    if (act.availability != null && act.kind !== 'sleep' && activityClass(act) !== 'commute') {
      add({ type: 'activity.ended', at, actor: 'engine', causeId: act.eventId ?? null, payload: { kind: act.kind, placeId: act.placeId ?? null } });
    }
    if (b.kind === 'commute') {
      const minutes = finite(b.minutes) ? b.minutes : Math.round((b.end - b.start) / 60);
      const tr = add({
        type: 'travel.started', at, actor: 'engine', causeId, subjectJid, ...chatOrigin,
        payload: {
          from: b.from, to: b.to, mode: b.mode, km: b.km, minutes, cost: b.cost ?? 0, availability: b.availability,
          // 014 geo (R38): the road route this trip was planned with (the map draws past trips from it).
          ...routedFields(b),
        },
      });
      if (finite(b.cost) && b.cost > 0) {
        add({ type: 'money.spent', at, actor: 'engine', causeId: tr.id, subjectJid, payload: { amount: b.cost, for: 'travel' } });
      }
      // 011: on foot / two wheels without an umbrella in the rain → soaked
      // (weather at departure, so a window or quick RAIN set after the morning
      // plan can catch him out). Caused by the trip: it keeps the trip's origin.
      const soak = soakedAt(s, b, at, world);
      if (soak) {
        add({ type: 'commute.soaked', at, actor: 'engine', causeId: tr.id, subjectJid, payload: { mode: b.mode ?? null, ...soak } });
      }
      return;
    }
    if (b.kind === 'sleep') {
      const late = finite(s.work?.lateAt) && s.work.lateAt >= plan.wakeAt ? s.work.lateEventId : null;
      add({ type: 'sleep.started', at, actor: 'engine', causeId: late ?? planCause(plan), payload: { until: b.end } });
      return;
    }
    const ev = add({
      type: 'activity.started', at, actor: 'engine', causeId, subjectJid, ...chatOrigin,
      payload: {
        kind: b.kind, placeId: b.placeId, end: b.end, availability: b.availability,
        withCast: activeCast(s, b.withCast || []), social: b.social === true,
      },
    });
    // A locked outing that is a meal (b.meal, mealOfOuting) is that meal: hunger and the day read right.
    if (MEAL_KINDS.has(b.kind) || typeof b.meal === 'string') {
      add({
        type: 'meal', at, actor: 'engine', causeId: ev.id, subjectJid,
        payload: { kind: typeof b.meal === 'string' ? b.meal : (b.kind === 'eat-out' ? 'dinner' : b.kind), good: b.social === true || (b.withCast || []).length > 0 },
      });
    }
    // 018: what it costs him (caused by the activity: its origin, its revert cascade).
    const spend = activitySpend({ state: s, block: b, ev, places: s.places instanceof Map ? s.places : new Map(), world: worldOf(s), date: dateKey(at, tz()) });
    if (spend && !chargedBefore(s, b, ev)) add({ type: 'money.spent', at, actor: 'engine', causeId: ev.id, subjectJid, payload: spend });
  }

  /**
   * 020 (final review 11): a chat's plan stays a chat's, whoever committed it. An owner's pick makes the
   * plan that fits it self-origin (an owner cause counts as self), and what starts from that plan would
   * read as his own: a full row on the site, a journal line, a full scene. A stamped block's start takes
   * the origin of the plan's own decision.opened, so it (and all it causes: the spend, the meal, the trip's
   * end, the scene) is that chat's, exactly as with no pick. Its cause stays the plan, so an undo cascades
   * as ever. → { originKind, originJid } or {} (the cause's origin).
   */
  function chatPlanOrigin(s, b, causeId) {
    if (!oneBeingOn() || !Number.isSafeInteger(b.decisionId)) return {};
    const d = s.decisions?.get?.(b.decisionId);
    if (!d || !chatMadeDecision(d)) return {};
    const read = (id) => { try { return getEvent(id) ?? null; } catch { return null; } };
    const chat = (ev) => !!ev?.originKind && ev.originKind !== 'self' && ev.originKind !== 'owner';
    const opened = read(d.id);
    return !chat(read(causeId)) && chat(opened) ? { originKind: opened.originKind, originJid: opened.originJid } : {};
  }

  /**
   * 018 (2026-11-01 live: a café date started at 15:00 and paid for; a rewind at
   * 16:36 re-anchored him idle mid-date and the same block started again → paid
   * twice): an outing is paid for once. True when an earlier activity.started of
   * this block — same kind, place and company, its window overlapping the
   * block's, since the day's plan — and a money.spent it caused are both still in
   * the projection. One reverted or rewound away → false (the resume pays).
   */
  function chargedBefore(s, b, ev) {
    const ids = [s.plan?.basePlanEventId, s.plan?.eventId].filter(x => Number.isSafeInteger(x) && x > 0);
    if (!ids.length) return false;
    const p = ev.payload || {};
    const company = (x) => (Array.isArray(x) ? [...x].sort().join(',') : '');
    const who = company(p.withCast);
    let rows;
    try { rows = eventsAfter(Math.min(...ids) - 1); } catch (err) {
      logger.warn({ err: err?.message }, 'life pulse: spend resume check failed');
      return false;
    }
    const starts = new Set();
    for (const e of rows) {
      if (e.id >= ev.id) break;
      if (e.type === 'activity.started' && !isExcludedId(s, e.id)) {
        const q = e.payload || {};
        const end = finite(q.end) ? q.end : e.at;
        if (q.kind === p.kind && (q.placeId ?? null) === (p.placeId ?? null) && company(q.withCast) === who
            && e.at < b.end && end > b.start) starts.add(e.id);
      } else if (e.type === 'money.spent' && starts.has(e.causeId) && !isExcludedId(s, e.id)) {
        return true;
      }
    }
    return false;
  }

  // ── Steps and ticks ────────────────────────────────────────────────────

  async function stepAt(g) {
    // 018: the wallet's cut-over — from here the hourly baseline drain stops and
    // the spending is itemized (once per log; a sim of a pre-018 log appends its own).
    const sw = getState();
    if (walletEnabled() && sw.genesisAt !== null && sw.genesisAt !== undefined && !finite(sw.money?.walletSince)) {
      append({ type: 'wallet.started', at: sw.at ?? g, actor: 'engine', payload: {} });
    }
    const ran = new Map();        // this step: item → what it appended last, how often in a row, how often at all
    const skipped = new Set();    // this step: items that appended nothing (they get another go next step)
    for (let i = 0; i < MAX_ITEMS_PER_STEP; i++) {
      const s = getState();
      const item = nextItem(s, g, skipped);
      if (!item) break;
      const before = s.lastEventId;
      const wrote = [];
      const add = (ev) => { wrote.push(`${ev?.type}|${JSON.stringify(ev?.payload ?? null)}`); return append(ev); };
      try {
        await item.run(add);
      } catch (err) {
        if (item.story) failed.add(item.key);
        logger.warn({ err: err?.message, item: item.label, at: item.at }, 'life pulse: step item failed');
        break;
      }
      // An item that appended nothing would come back forever.
      if (getState().lastEventId === before) {
        if (item.story) {
          failed.add(item.key);
          logger.warn({ item: item.label, at: item.at }, 'life pulse: story item appended nothing; retired');
        } else {
          logger.warn({ item: item.label, at: item.at }, 'life pulse: item appended nothing');
          skipped.add(itemId(item));
        }
        continue;
      }
      noteRan(ran, item, wrote.join('\n'));
    }

    const s = getState();
    if (s.genesisAt !== null && s.genesisAt !== undefined && !asleep(s)) {
      const vitals = g > (s.at ?? g) ? vitalsAt(s, g, worldOf(s)) : s.vitals;
      const meal = activityClass(s.activity) === 'meal';
      if (!meal && vitals?.hunger > SNACK_HUNGER) {
        append({ type: 'meal', at: g, actor: 'engine', payload: { kind: 'snack', hunger: SNACK_TO } });
      }
    }

    const fresh = lastEvalId === null ? [] : eventsAfter(lastEvalId);
    lastEvalId = fresh.length ? fresh[fresh.length - 1].id : (lastEvalId ?? getState().lastEventId);
    if (getState().decisions?.size) {
      try {
        await evaluate(getState, { world: worldOf(getState()), at: g, append, newEvents: fresh, noJev: !enabled() });
      } catch (err) {
        logger.warn({ err: err?.message }, 'life pulse: decision evaluation failed');
      }
    }
  }

  async function runToInner(at) {
    const s0 = getState();
    if (s0?.genesisAt === null || s0?.genesisAt === undefined) return { steps: 0, reanchored: false };
    if (lastEvalId === null) lastEvalId = s0.lastEventId;
    const to = grid(at);
    let from = lastTickAt ?? grid(s0.at ?? to);
    // First run after boot: remember the grid point we resume from. Without
    // this, an event dated off the grid (a phone check) moves s0.at past the
    // next grid point before the first tick, and every later tick re-derives
    // `from` from s0.at and skips — the world stops stepping until a quiet window.
    if (lastTickAt === null) lastTickAt = from;
    if (to <= from) return { steps: 0, reanchored: false };
    const prevView = advanceTo(s0, Math.max(from, s0.at ?? from), worldOf(s0));
    let reanchored = false;
    if (to - from > capSec) {
      append({ type: 'world.reanchored', at: to, actor: 'engine', payload: { fromAt: from, gapHours: Math.round((to - from) / H) } });
      reanchored = true;
      from = to - step;
    }
    const before = getState().lastEventId;
    let steps = 0;
    for (let g = from + step; g <= to; g += step) {
      await stepAt(g);
      steps++;
      lastTickAt = g;
    }
    lastTickAt = to;
    const state = getState();
    const view = advanceTo(state, Math.max(to, state.at ?? to), worldOf(state));
    const info = {
      at: to, steps, reanchored, catchUp: steps > 1,
      events: eventsAfter(before),
      crossings: crossings(prevView.vitals, view.vitals),
    };
    for (const fn of subscribers) {
      try { await fn(view, info); } catch (err) { logger.warn({ err: err?.message }, 'life pulse: onTick subscriber failed'); }
    }
    return info;
  }

  /** Advance the world to unix `at` (serialized: ticks never overlap). → { steps, reanchored, events, … } */
  function runTo(at) {
    const run = chain.then(() => runToInner(at));
    chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Apply what is due at exactly `at` (off the grid; serialized with ticks):
   * a fresh genesis gets its plan / sleep / current block now instead of at
   * the next grid step. lastTickAt is left alone (not a grid point).
   */
  function settle(at = nowFn()) {
    const run = chain.then(async () => {
      const s0 = getState();
      if (s0?.genesisAt === null || s0?.genesisAt === undefined) return { settled: false };
      if (lastEvalId === null) lastEvalId = s0.lastEventId;
      const before = s0.lastEventId;
      await stepAt(Math.max(at, s0.at ?? at));
      return { settled: true, events: eventsAfter(before) };
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 015: run fn() on the tick chain (serialized with ticks and settle, like
   * settle()): the Director's decision-touching applies, so a story item built
   * from a snapshot never interleaves with an owner commit.
   */
  function exclusive(fn) {
    const run = chain.then(() => fn());
    chain = run.then(() => {}, () => {});
    return run;
  }

  /** One tick at the clock's now. */
  function tick() {
    return runTo(nowFn());
  }

  /** Every tickMinutes, unref'd (never keeps the process alive). */
  function start() {
    if (timer) return;
    timer = setIv(() => {
      tick().catch(err => logger.warn({ err: err?.message }, 'life pulse: tick failed'));
    }, step * 1000);
    timer?.unref?.();
  }

  function stop() {
    if (timer) clearIv(timer);
    timer = null;
  }

  /**
   * After the projection was rebuilt from an earlier point (010 rewind): the
   * next evaluation starts from the current last event, so decisions don't
   * re-read events the rebuild already accounts for.
   */
  function rebase() {
    const id = getState()?.lastEventId;
    lastEvalId = Number.isSafeInteger(id) ? id : null;
  }

  /** Subscribe to ticks: fn(view, { at, steps, catchUp, reanchored, events, crossings }). Returns unsubscribe. */
  function onTick(fn) {
    if (typeof fn !== 'function') throw new Error('pulse: onTick expects a function');
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return {
    runTo,
    settle,
    exclusive,
    tick,
    start,
    stop,
    onTick,
    rebase,
    stepSeconds: step,
    lastTickAt: () => lastTickAt,
  };
}
