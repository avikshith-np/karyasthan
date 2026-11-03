// Scene sessions (spec 016, plan §P1.1–§P1.3, D1/D7/D10). Pure over the projection
// and the two events (the one log read is the outing's own plan.made, for its decision):
//
//   isSceneSession(startEv, endEv, s) → { ok:true } | { ok:false, reason }
//       an outing with someone that ended: an activity.started whose kind is not in
//       cast.js ROUTINE_ACTIVITY_KINDS (work, meeting, lunch, dinner, … never get a
//       scene: office lunches, meetings, dinner at home with the flatmate), with an
//       active cast member or a real person (subjectJid) there, ≥ 20 min, neither
//       event excluded / redacted, no heavy flag on the start or its chain.
//   sessionOf(startEv, endEv, s, { chain }) → the session (cast, real person, mode,
//       origin, decision, place, span) or null.
//   tierOf(session, s) → 'mind' (a first meeting, a date, a family occasion, an
//       owner-directed outing) | 'clerk'. A self_only session is 'code' (D17), a chat-origin
//       (narration_only) one always 'clerk' (R10).
import { ROUTINE_ACTIVITY_KINDS } from '../cast.js';
import { isExcludedId } from '../../projector.js';
import { romanceEligible, activeRomance, metricsOf } from '../romance.js';
import { isHomeKind } from '../../places.js';
import { planBlockDecision } from '../../eventLog.js';

export const MIN_MINUTES = 20;
export const MAX_CAST = 4;
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const KIND_RE = /^[a-z][a-z0-9_:-]{0,31}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const PERSON_JID_RE = /^[0-9A-Za-z._:-]{1,80}@(?:s\.whatsapp\.net|lid)$/;
const DATE_PASSION = 0.3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** Active cast ids of an activity.started (departed members dropped), ≤ 4, sorted. */
export function activeCastOf(startEv, s) {
  const list = Array.isArray(startEv?.payload?.withCast) ? startEv.payload.withCast : [];
  const gone = isObj(s?.story?.departed) ? s.story.departed : {};
  return [...new Set(list.filter(id => typeof id === 'string' && CAST_ID_RE.test(id)
    && s?.cast instanceof Map && s.cast.has(id) && !Object.hasOwn(gone, id)))].sort().slice(0, MAX_CAST);
}

function realPersonOf(startEv) {
  return typeof startEv?.subjectJid === 'string' && PERSON_JID_RE.test(startEv.subjectJid) ? startEv.subjectJid : null;
}

/** Eligibility (D1). `chain` = the start's cause chain (eventLog.causeChain) for the heavy check, optional. */
export function isSceneSession(startEv, endEv, s, { chain = null } = {}) {
  if (!isObj(startEv) || startEv.type !== 'activity.started') return { ok: false, reason: 'not_activity' };
  if (!isObj(endEv) || endEv.type !== 'activity.ended') return { ok: false, reason: 'not_ended' };
  if (startEv.redacted === true || endEv.redacted === true || startEv.payload?.redacted === true) return { ok: false, reason: 'redacted' };
  if (isExcludedId(s, startEv.id) || isExcludedId(s, endEv.id)) return { ok: false, reason: 'excluded' };
  const kind = typeof startEv.payload?.kind === 'string' ? startEv.payload.kind : '';
  if (!KIND_RE.test(kind) || ROUTINE_ACTIVITY_KINDS.has(kind)) return { ok: false, reason: 'routine' };
  if (startEv.heavy === true || (Array.isArray(chain) && chain.some(e => e?.heavy === true))) return { ok: false, reason: 'heavy' };
  if (!finite(startEv.at) || !finite(endEv.at) || (endEv.at - startEv.at) / 60 < MIN_MINUTES) return { ok: false, reason: 'short' };
  if (!activeCastOf(startEv, s).length && !realPersonOf(startEv)) return { ok: false, reason: 'alone' };
  return { ok: true };
}

// The outing's decision: the start's own payload, the block of its plan that
// started it (the block covering the start, same kind, with a decisionId), the
// amended plan it hangs off (plan.made {amendedFor}) only when no block says and
// that decision is at the same place,
// else a committed go / late decision at that place whose window holds the
// start. null for a routine outing (an evening eat-out). 2026-11-01 live: the
// day's plan re-made for an evening visit (amendedFor = the visit) started the
// afternoon café date from its own block — the café scene took the visit's tone.
function decisionOf(startEv, s, causeEv) {
  const own = posInt(startEv.payload?.decisionId);
  if (own) return own;
  const placeId = startEv.payload?.placeId ?? null;
  if (causeEv?.type === 'plan.made') {
    const block = posInt(planBlockDecision(causeEv.payload, startEv));
    if (block) return block;
    const amended = posInt(causeEv.payload?.amendedFor);
    const ad = amended && s?.decisions instanceof Map ? s.decisions.get(amended) : null;
    if (amended && (!ad?.subject?.placeId || !placeId || ad.subject.placeId === placeId)) return amended;
  }
  let best = null;
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if (d?.status !== 'committed' || !['go', 'late'].includes(d.committed?.optionId)) continue;
    const sub = d.subject ?? {};
    if (!placeId || sub.placeId !== placeId || !finite(sub.eventAt)) continue;
    const end = finite(sub.endAt) ? sub.endAt : sub.eventAt + 4 * 3600;
    if (startEv.at < sub.eventAt - 2 * 3600 || startEv.at > end) continue;
    if (!best || Math.abs(sub.eventAt - startEv.at) < Math.abs(best.subject.eventAt - startEv.at)) best = d;
  }
  return best ? best.id : null;
}

/**
 * The session (plan §P1.2). causeEv: the start's cause event (the plan.made), optional.
 * → { activityEventId, endEventId, startAt, endAt, minutes, kind, placeId, home, castIds, realJid,
 *     mode, originKind, originJid, decisionId } | null
 */
export function sessionOf(startEv, endEv, s, { causeEv = null } = {}) {
  const castIds = activeCastOf(startEv, s);
  const realJid = realPersonOf(startEv);
  if (!castIds.length && !realJid) return null;
  const originKind = startEv.originKind ?? 'self';
  const chat = CHAT_ORIGINS.has(originKind);
  const mode = realJid ? 'self_only' : (chat ? 'narration_only' : 'full');
  const placeId = typeof startEv.payload?.placeId === 'string' ? startEv.payload.placeId : null;
  return {
    activityEventId: startEv.id,
    endEventId: endEv.id,
    startAt: startEv.at,
    endAt: endEv.at,
    minutes: Math.round((endEv.at - startEv.at) / 60),
    kind: startEv.payload.kind,
    placeId,
    home: placeId ? isHomeKind(s, placeId) : false,
    castIds,
    realJid,
    mode,
    originKind,
    originJid: startEv.originJid ?? 'self',
    decisionId: decisionOf(startEv, s, causeEv),
  };
}

/** Was he meeting this member for the first time (no time together, no history, not met at genesis, no earlier scene)? */
export function firstMeetOf(session, s, { metAtGenesis = () => true } = {}) {
  const out = [];
  for (const id of session.castIds) {
    const rel = s?.story?.relationships?.[id];
    if (finite(rel?.togetherMin) && rel.togetherMin > 0) continue;
    if (Array.isArray(s?.story?.history?.[id]) && s.story.history[id].length) continue;
    const c = s?.cast instanceof Map ? s.cast.get(id) : null;
    if (!c || metAtGenesis(c)) continue;
    const earlier = Object.entries(isObj(s?.story?.scenes) ? s.story.scenes : {})
      .some(([aid, sc]) => Number(aid) !== session.activityEventId && Array.isArray(sc?.castIds) && sc.castIds.includes(id));
    if (earlier) continue;
    out.push(id);
  }
  return out;
}

/** A date (D7): with the active romance partner, or a romance-eligible member with passion ≥ 0.3. */
export function isDate(session, s) {
  const r = activeRomance(s);
  return session.castIds.some(id => (r && r.partnerId === id) || (romanceEligible(s, id) && metricsOf(s, id).passion >= DATE_PASSION));
}

/** Owner-directed: a tone hint, an owner outcome, a decision committed by the owner or a goal. */
export function ownerDirected(session, s, { tone = null } = {}) {
  if (tone) return true;
  const id = session.decisionId;
  if (!id) return false;
  if (isObj(s?.story?.sceneTones?.[id])) return true;
  if (isObj(s?.story?.outcomes?.[id])) return true;
  const d = s?.decisions instanceof Map ? s.decisions.get(id) : null;
  return ['owner', 'goal'].includes(d?.committed?.by);
}

/**
 * Model tier (plan §P1.3). opts: { firstMeet: [ids], tone, before } — `before` = the world
 * before the outing (the date check reads its romance and metrics); the decision and owner
 * direction read `s` (now).
 */
export function tierOf(session, s, { firstMeet = [], tone = null, before = s } = {}) {
  // A real person's scene is a code template (D17); a chat-planned outing never reaches the
  // mind tier, whatever it is (R10: chat members can't trigger mind spend).
  if (session.mode === 'self_only') return 'code';
  if (session.mode !== 'full') return 'clerk';
  if (firstMeet.length) return 'mind';
  if (isDate(session, before ?? s)) return 'mind';
  const d = session.decisionId && s?.decisions instanceof Map ? s.decisions.get(session.decisionId) : null;
  if (d?.category === 'family' || (typeof d?.kind === 'string' && d.kind.startsWith('family:'))) return 'mind';
  if (ownerDirected(session, s, { tone })) return 'mind';
  return 'clerk';
}
