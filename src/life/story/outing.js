// Outing decisions shared by the Director (scenes, CANCEL TONIGHT, goal.cancel)
// and soft goals (goals.js) — factored out of director.js (spec 011 review R27)
// so goals.js needs no import of the Director. Pure over the projection; the
// one log read is the amended plan lookup.
//
//   outingDecisionPayload({state, now, world}, spec)   the decision.opened payload of
//       an outing / visit / goal outing (openDecision's shape): go / join later /
//       stay, the deadlines from decisions.deadlines; throws OutingError
//       'no_route' | 'too_soon'
//   earliestStart({state, now, world}, {placeId, from?})   the first 5-minute mark
//       he could still get ready for and get to (prep + the trip, re-planned at
//       that time) — the Director's too_soon fix; null when there is no route
//   amendedPlanEventId(state, decisionId, {now, tz})    the plan.made that rewrote
//       today for that decision, or null
//   cancelDecisionEvents(state, decision, {now, tz})   what cancelling a committed /
//       open outing appends: decision.expired {owner_cancelled} and the revert of
//       its amendment when one exists → [{ type, payload }]
import { listEvents } from '../eventLog.js';
import { deadlines, optionCost } from '../decisions.js';
import { routineOf } from '../routine.js';
import { dayStart } from '../clock.js';
import { isExcludedId } from '../projector.js';
// 014 geo (§A7): a venue whose name collides with a real person's is worded by its kind.
import { safePlaceName } from '../places.js';

const MIN = 60;
const posInt = (v) => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export class OutingError extends Error {
  constructor(reason) {
    super(`outing: ${reason}`);
    this.name = 'OutingError';
    this.reason = reason;
  }
}

// The world trips are planned in: its places plus the projection's (created, moved).
function travelWorldOf(state, world) {
  const places = new Map((Array.isArray(world?.places) ? world.places : []).map(p => [p.id, p]));
  for (const [id, p] of state.places instanceof Map ? state.places : []) places.set(id, p);
  return { ...(world ?? {}), places };
}

// Where he leaves from: the spec's `from`, else where he is, else home.
function originOf(state, from) {
  return from ?? state.position?.placeId ?? state.self?.homePlaceId ?? null;
}

export const START_STEP_SEC = 5 * MIN;

/**
 * The earliest start (a 5-minute mark) he can still make: time to get ready
 * plus the trip from where he is (re-planned at each candidate, since a trip's
 * length depends on the time). Used to offer a fix for a too_soon outing.
 * → unix seconds | null (no route, or nothing within ~4 h)
 */
export function earliestStart({ state, now, world: w }, { placeId, from = null, prepMin: prepOverride = null } = {}) {
  const world = w ?? {};
  const tw = travelWorldOf(state, world);
  const origin = originOf(state, from);
  const prepMin = prepOverride ?? routineOf(world).prepMinutes ?? 20;
  const up = (t) => Math.ceil(t / START_STEP_SEC) * START_STEP_SEC;
  let t = up(now + prepMin * MIN);
  for (let i = 0; i < 48; i++) {
    let dl;
    try {
      dl = deadlines({ eventAt: t, placeId, from: origin, at: now, prepMin, weather: state.weather ?? null }, tw);
    } catch {
      return null;
    }
    const need = now + (dl.prepMin + dl.travelMin) * MIN;
    if (t >= need) return t;
    t = up(Math.max(t + START_STEP_SEC, need));
  }
  return null;
}

/**
 * decision.opened payload for an outing / visit / goal outing.
 * spec: { placeId, castIds, startAt, minutes, label, kind, adopted?, claimId?, goalId?, from?, followupId? }
 */
export function outingDecisionPayload({ state, now, world: w }, {
  placeId, castIds, startAt, minutes, label, kind, adopted = false, claimId = null, goalId = null, from = null,
  followupId = null,   // 016: a scene's follow-up meet
  prepMin: prepOverride = null,   // 2026-11-05: going on straight from an outing, he is already out and ready
}) {
  const world = w ?? {};
  const tw = travelWorldOf(state, world);
  const origin = originOf(state, from);
  const prepMin = prepOverride ?? routineOf(world).prepMinutes ?? 20;
  let dl;
  try {
    dl = deadlines({ eventAt: startAt, placeId, from: origin, at: now, prepMin, weather: state.weather ?? null }, tw);
  } catch {
    throw new OutingError('no_route');
  }
  if (dl.ponrAt < now) throw new OutingError('too_soon');
  const endAt = startAt + minutes * MIN;
  const placeName = safePlaceName(state, placeId, state.places?.get?.(placeId)?.name ?? 'there');
  const opts = [
    { id: 'go', label: label || homeLabel(state, placeId, castIds) || `Go to ${placeName}`, go: true, kind, minutes, fun: 5 },
    { id: 'late', label: 'Join later', go: 'late', kind, minutes: Math.round(minutes / 2), fun: 3 },
    { id: 'stay', label: 'Stay in', kind: 'rest', minutes },
  ];
  const options = opts.map(o => ({
    id: o.id, label: o.label,
    cost: optionCost(o, o.go ? dl.trip : null, world),
    expiresAt: o.go === true ? dl.ponrAt : o.go === 'late' ? endAt : null,
  }));
  return {
    kind, subject: { eventAt: startAt, endAt, placeId, castIds }, opensAt: now, decideBy: dl.decideBy, ponrAt: dl.ponrAt,
    travelMin: dl.travelMin, prepMin: dl.prepMin, mode: 'auto', options, category: 'social',
    ...(adopted ? { adopted: true } : {}), ...(claimId ? { claimId } : {}), ...(goalId ? { goalId } : {}),
    ...(followupId ? { followupId } : {}),
  };
}

/**
 * The go label of a plan at his own home with people (a visit): "<name> comes
 * over to his place" — never "Go to <his flat>". The flatmate lives there, so a
 * plan with the flatmate in it keeps 009's label (the phone's plan lines word
 * those themselves). null when the place isn't his home, nobody is named or a
 * name is missing. ≤ 3 names, ≤ 80 chars like the other code labels.
 */
export function homeLabel(state, placeId, castIds) {
  if (!placeId || placeId !== state?.self?.homePlaceId) return null;
  const ids = [...new Set(Array.isArray(castIds) ? castIds : [])];
  if (!ids.length || ids.length > 3) return null;
  const cast = ids.map(id => (state.cast instanceof Map ? state.cast.get(id) : null));
  if (cast.some(c => !c || c.relation === 'flatmate')) return null;
  const names = cast.map(c => (typeof c.name === 'string' ? c.name.trim() : '')).filter(Boolean);
  if (names.length !== ids.length) return null;
  const who = names.length < 3 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names[2]}`;
  const label = `${who} ${names.length === 1 ? 'comes' : 'come'} over to his place`;
  return label.length <= 80 ? label : null;
}

/** The plan.made (from today's start) that rewrote the day for `decisionId`, or null. */
export function amendedPlanEventId(state, decisionId, { now, tz }) {
  if (posInt(state.plan?.amendedFor) === decisionId) return state.plan.eventId ?? null;
  const evs = listEvents({ types: ['plan.made'], from: dayStart(now, tz), limit: 200, order: 'desc' });
  return evs.find(e => posInt(e.payload?.amendedFor) === decisionId)?.id ?? null;
}

/** [{type, payload}] that cancel an open / committed outing (the caller dates and causes them). */
export function cancelDecisionEvents(state, decision, { now, tz, reason = 'cancel_tonight' }) {
  const out = [{ type: 'decision.expired', payload: { decisionId: decision.id, reason: 'owner_cancelled' } }];
  const amended = amendedPlanEventId(state, decision.id, { now, tz });
  if (amended && !isExcludedId(state, amended)) out.push({ type: 'event.reverted', payload: { targetId: amended, reason, by: 'owner' } });
  return out;
}
