// Reconciler: 009 flagged claims → his world (spec 010, research R13,
// contracts/reconciler.md). A claim is one of his own sent replies that 009
// flagged ("movie with my flatmate tonight at 9"); the reconciler decides in
// CODE whether it becomes part of his life, and how.
//
//   enqueue / onClaimFlagged → a story_claim_reviews row (pending) + a kick of
//   the one serialized worker (runQueue). Per claim:
//     1 mode (owner's director.reconciler_mode, else config) — off: stays
//       pending; review: tray/review_mode, no model call
//     2 caps (extract 10/h, 60/day; arcs clerk 80/day over extract + journal;
//       the clerk role budget) — over: stays pending, retried on a later tick
//     3 the ONE model call: clerk extraction of the fenced claim excerpt
//     4–10 code only: type gate, time window, place, people, controls,
//       calendar fit (from departure), the 24 future-adoption cap
//     11 adopt: claim.adopted (cause = the claim.flagged pointer, so every
//       adoption event inherits the claim chat's origin) + a decision committed
//       `by:'adopted'` (plan) | commitment.recorded | activity.recorded.
//   Every label written into a world event is built in code (labelFor); the
//   clerk's free-text summary lives only in story_claim_reviews.extraction_json.
//
// Never: create a person or a place; touch vitals, money, health, relationship
// status, job, cast identity or heavy events; adopt for a pinned cast member or
// a frozen category; resolve a real person outside the claim chat's audience
// (a current member of that group through 006's peopleStore reader, or the DM's
// own person). No raw SQL on 006 tables. The only SQL here is the one static
// life_claims status update (a 009 table with no helper for 'adopted').
//
// Withdrawal (R22): hooks mark reviews `withdrawn` DB-only; the world side
// (claim.withdrawn + a revert of claim.adopted, which cascades through the whole
// adoption batch) runs at the next tick or boot through applyPendingWithdrawals.
//
// Logs carry review/claim ids, statuses and reason codes only — never the claim
// text or any extraction field.

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getDb } from '../../memory/db.js';
import { now as clockNow, dateKey, dayStart, addDays, atLocal, weekday, zonedToUnix } from '../clock.js';
import { getEvent as getEventDefault, listEvents as listEventsDefault, revertEvent as revertEventDefault } from '../eventLog.js';
import { isExcludedId } from '../projector.js';
import { planDay as planDayDefault, routineOf } from '../routine.js';
import { deadlines } from '../decisions.js';
import { getClaim as getClaimDefault } from '../claims.js';
import { castTerms } from '../innerState.js';
import { normalizeName } from '../world.js';
import { worldOverlay } from './reducer.js';
// 014 geo: the one projected-places merge.
import { worldWithPlaces, safePlaceName } from '../places.js';
import { check as controlsCheck, reconcilerModeOf, isPaused } from './controls.js';
import * as storeDefault from './store.js';
import { validateExtraction, IN_SCOPE_TYPES, WEEKDAYS } from './schema.js';
import { EXTRACT_PROMPT, fence, cleanItem } from './charter.js';
import { hasSchedule, activeRanges } from '../planEdits.js';   // 014 sched

export const EXTRACT_CALLER = 'life.claim.extract';
export const MIN_CONFIDENCE = 0.6;
export const PAST_WINDOW_SEC = 24 * 3600;
export const FUTURE_WINDOW_SEC = 30 * 86400;
export const MAX_FUTURE_ADOPTIONS = 24;
export const COMMITMENT_SLACK_SEC = 30 * 60;
export const FIXED_KINDS = Object.freeze(new Set(['work', 'meeting', 'sleep', 'commute']));
export const DEFAULT_MINUTES = Object.freeze({ plan: 120, activity: 90, commitment: 30 });
export const PART_WINDOWS = Object.freeze({ morning: '08:00', afternoon: '13:00', evening: '18:30', night: '20:00', weekend: '16:00' });
export const SWEEP_LIMIT = 50;
export const QUEUE_BATCH = 20;

const HOUR = 3600;
const DAY = 86400;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const SELF_WORDS = new Set(['me', 'i', 'myself', 'we', 'us', 'ourselves']);
const YOU_WORDS = new Set(['you', 'u', 'ya', 'yourself']);
const LEAD_WORDS = /^(?:my|our|the|with|and|a|an)\s+/i;

// ── deps ─────────────────────────────────────────────────────────────────────

let deps = {};
/** Production wiring (story/index.js attach): { getState, append, world, worldOf, revertEvent, isOn, callRole, … }. */
export function configure(d = {}) {
  deps = { ...deps, ...(isObj(d) ? d : {}) };
}
/** Test seam: replaces every dep (null → defaults only). */
export function __setDepsForTest(d) {
  deps = isObj(d) ? { ...d } : {};
  chain = Promise.resolve();
}

const nowSec = () => Math.floor((deps.now ?? clockNow)());
const store = () => deps.store ?? storeDefault;
const cfg = () => ({ ...config.arcs, ...(isObj(deps.cfg) ? deps.cfg : {}) });
const getEvent = (id) => (deps.getEvent ?? getEventDefault)(id);
const listEvents = (q) => (deps.listEvents ?? listEventsDefault)(q);
const getClaim = (id) => (deps.getClaim ?? getClaimDefault)(id);
const isOn = () => (typeof deps.isOn === 'function' ? deps.isOn() === true : false);

function tzOf(state, world) {
  return state?.world?.timezone || world?.timezone || config.timezone || 'UTC';
}

function worldFor(state) {
  const w = deps.world ?? null;
  if (typeof deps.worldOf === 'function') return deps.worldOf(state, w);
  return w ? worldOverlay(state, w) : w;
}

// 014 geo (plan §A0): the one merge (places.js) — projected places win on every
// id, so routine/travel resolve a place an event created or moved.
function travelWorld(state, world) {
  return world ? worldWithPlaces(state, world) : world;
}

async function budgetAllowed() {
  try {
    const fn = deps.budgetState ?? (await import('../../brain/usage.js')).budgetState;
    return fn('clerk')?.allowed !== false;
  } catch {
    return false;
  }
}

/** 009's life_claims has no helper for adopted/rejected: one static update, flagged rows only. */
function setClaimStatusDefault(claimId, status, { by = 'engine', at = nowSec() } = {}) {
  if (!['adopted', 'rejected', 'dismissed'].includes(status)) return false;
  return getDb().prepare(`UPDATE life_claims SET status = ?, reviewed_at = ?, reviewed_by = ?
    WHERE id = ? AND status = 'flagged'`).run(status, at, String(by).slice(0, 60), claimId).changes === 1;
}
const setClaimStatus = (...a) => (deps.setClaimStatus ?? setClaimStatusDefault)(...a);

async function peopleReaders() {
  if (deps.people) return deps.people;
  const [peopleStore, mindReads, identity] = await Promise.all([
    import('../../memory/peopleStore.js'), import('../../memory/mindReads.js'), import('../../memory/identity.js'),
  ]);
  deps.people = {
    findPersonInGroupByName: peopleStore.findPersonInGroupByName,
    namesOf: mindReads.namesOf,
    resolvePerson: identity.resolvePerson,
  };
  return deps.people;
}

// ── time (data-model §5) ─────────────────────────────────────────────────────

function dayOf(unix, tz) {
  return dayStart(unix, tz);
}

/** The day (local midnight unix) a `when` points at, relative to `createdAt`. */
function baseDay(when, createdAt, tz, weekendDays) {
  const today = dayOf(createdAt, tz);
  if (when.date) {
    const [y, m, d] = when.date.split('-').map(Number);
    return dayOf(zonedToUnix(y, m, d, 12, 0, tz), tz);
  }
  const rel = when.relative;
  const wd = weekday(today, tz);
  if (rel === 'tomorrow') return dayOf(addDays(today, 1, tz), tz);
  if (rel === 'yesterday' || rel === 'last_night') return dayOf(addDays(today, -1, tz), tz);
  if (rel === 'this_weekend' || (!rel && when.part === 'weekend')) {
    for (let k = 0; k < 7; k++) if (weekendDays.includes((wd + k) % 7)) return dayOf(addDays(today, k, tz), tz);
    return today;
  }
  if (typeof rel === 'string' && rel.startsWith('next_')) {
    const target = WEEKDAYS.indexOf(rel.slice(5));
    if (target >= 0) {
      const k = ((target - wd + 7) % 7) || 7;
      return dayOf(addDays(today, k, tz), tz);
    }
  }
  return today; // today, tonight, now, or only a time/part
}

/**
 * Resolve an extraction's `when` to a span { start, end } (unix s) in world time,
 * relative to the claim's creation; null when it cannot be placed.
 */
export function resolveSpan(extraction, createdAt, tz, { weekendDays = [0, 6] } = {}) {
  const when = isObj(extraction?.when) ? extraction.when : {};
  const type = extraction?.type;
  const minutes = fin(extraction?.minutes) ? Math.min(360, Math.max(15, Math.round(extraction.minutes))) : (DEFAULT_MINUTES[type] ?? 60);
  let start;
  if (when.relative === 'now' && !when.time && !when.date) {
    start = createdAt;
  } else {
    const day = baseDay(when, createdAt, tz, weekendDays);
    let hhmm = when.time;
    if (!hhmm) {
      const part = when.part ?? (when.relative === 'tonight' || when.relative === 'last_night' ? 'night'
        : when.relative === 'this_weekend' ? 'weekend' : 'evening');
      hhmm = PART_WINDOWS[part] ?? PART_WINDOWS.evening;
    }
    start = atLocal(day, hhmm, tz);
    // Only a clock time ("gym at 10") already past for something still to come → the next day.
    if (!when.date && !when.relative && start < createdAt && (type === 'plan' || type === 'commitment')) {
      start = atLocal(dayOf(addDays(day, 1, tz), tz), hhmm, tz);
    }
  }
  if (!fin(start)) return null;
  return { start, end: start + minutes * 60, minutes };
}

/** Claim time for the extraction prompt: "Fri 30 Oct 2026, 18:40". */
export function claimTimeLabel(at, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(at * 1000)).map(p => [p.type, p.value]));
    return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
  } catch {
    return new Date(at * 1000).toISOString();
  }
}

// ── places ───────────────────────────────────────────────────────────────────

function bare(s) {
  let n = normalizeName(s);
  for (let i = 0; i < 3; i++) n = n.replace(LEAD_WORDS, '');
  return n.trim();
}

/** Match a written place against his places (name, then a unique kind word). → { placeId } | { reason } */
export function matchPlace(written, state, world) {
  const places = state?.places instanceof Map && state.places.size ? [...state.places.values()]
    : (Array.isArray(world?.places) ? world.places : []);
  const n = bare(written);
  if (!n) return { reason: 'unknown_place' };
  const byName = places.filter(p => bare(p.name) === n);
  if (byName.length === 1) return { placeId: byName[0].id };
  if (byName.length > 1) return { reason: 'ambiguous_place' };
  const words = new Set(n.split(' '));
  const byKind = places.filter(p => typeof p.kind === 'string' && (words.has(normalizeName(p.kind)) || normalizeName(p.kind) === n));
  if (byKind.length === 1) return { placeId: byKind[0].id };
  if (byKind.length > 1) return { reason: 'ambiguous_place' };
  return { reason: 'unknown_place' };
}

// ── people ───────────────────────────────────────────────────────────────────

function matchName(member) {
  return cleanItem(member?.name ?? '', 80).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Cast lookup terms (innerState.castTerms with the cast-wide counts) + every cast name form for the collision rule. */
export function castIndex(state) {
  const cast = state?.cast instanceof Map ? [...state.cast.values()] : [];
  const relationCounts = new Map();
  const firstCounts = new Map();
  for (const c of cast) {
    relationCounts.set(String(c.relation ?? ''), (relationCounts.get(String(c.relation ?? '')) ?? 0) + 1);
    const f = matchName(c).split(' ')[0]?.toLowerCase();
    if (f && f.length >= 3) firstCounts.set(f, (firstCounts.get(f) ?? 0) + 1);
  }
  const entries = cast.map(c => ({ id: c.id, terms: new Set(castTerms(c, relationCounts, firstCounts).map(t => normalizeName(t))) }));
  const names = new Set();
  for (const c of cast) {
    const full = normalizeName(matchName(c));
    if (full) names.add(full);
    const first = full.split(' ')[0];
    if (first && first.length >= 3) names.add(first);
  }
  return { entries, names };
}

/**
 * Resolve the extraction's people (reconciler.md step 7): cast first, then a
 * current member of the claim's group (006 peopleStore) or the DM's own person.
 * → { castIds, subjectJid } | { reason: 'unknown_person'|'ambiguous_person'|'multi_person' }
 */
export async function resolvePeople(people, claim, state) {
  const idx = castIndex(state);
  const isDm = claim.originKind === 'dm';
  const readers = await peopleReaders();
  const real = new Set();
  const castIds = [];
  let dmPerson = null;
  if (isDm) dmPerson = readers.resolvePerson(claim.chatJid) || null;
  const namesOf = (jid) => {
    try { return new Set([...readers.namesOf(jid)].map(n => normalizeName(n)).filter(Boolean)); } catch { return new Set(); }
  };
  for (const raw of Array.isArray(people) ? people : []) {
    const n = bare(raw);
    if (!n || SELF_WORDS.has(n)) continue;
    if (isDm && YOU_WORDS.has(n)) {
      if (!dmPerson) return { reason: 'unknown_person' };
      real.add(dmPerson);
      continue;
    }
    const castHits = idx.entries.filter(e => e.terms.has(n));
    if (castHits.length === 1) { if (!castIds.includes(castHits[0].id)) castIds.push(castHits[0].id); continue; }
    if (castHits.length > 1) return { reason: 'ambiguous_person' };
    let member = null;
    if (isDm) {
      if (dmPerson && namesOf(dmPerson).has(n)) member = { jid: dmPerson, names: [] };
    } else {
      let hit = null;
      try { hit = readers.findPersonInGroupByName(claim.chatJid, cleanItem(raw, 40).replace(LEAD_WORDS, '')); } catch { hit = null; }
      // The 006 reader also has an unambiguous-prefix fallback; only an exact name or a known nickname counts here.
      if (hit?.jid && namesOf(hit.jid).has(n)) member = { jid: hit.jid, names: [hit.push_name, hit.real_name] };
    }
    if (!member) return { reason: 'unknown_person' };
    const memberNames = [n, ...member.names.map(x => normalizeName(x))].filter(Boolean);
    if (memberNames.some(x => idx.names.has(x) || idx.names.has(x.split(' ')[0]))) return { reason: 'ambiguous_person' };
    real.add(member.jid);
  }
  if (isDm && dmPerson && !real.size) real.add(dmPerson);   // "see you at the park" in their DM
  if (real.size > 1) return { reason: 'multi_person' };
  return { castIds, subjectJid: real.size ? [...real][0] : null };
}

// ── calendar fit (data-model §5) ─────────────────────────────────────────────

function planFor(state, day, world) {
  if (typeof deps.planFor === 'function') return deps.planFor(state, day, world);
  if (state?.plan?.blocks && state.plan.date === dateKey(day, tzOf(state, world))) return state.plan;
  try {
    return (deps.planDay ?? planDayDefault)(structuredClone(state), day, world);
  } catch {
    return null;
  }
}

function decisionWindow(d) {
  const eventAt = d?.subject?.eventAt;
  if (!fin(eventAt)) return null;
  let endAt = null;
  try { endAt = getEvent(d.id)?.payload?.subject?.endAt ?? null; } catch { endAt = null; }
  return { start: fin(d.ponrAt) ? Math.min(d.ponrAt, eventAt) : eventAt, end: fin(endAt) ? endAt : eventAt + DEFAULT_MINUTES.plan * 60 };
}

function occupies(d) {
  if (d?.status !== 'committed' || !d.committed) return false;
  const id = d.committed.optionId;
  if (id === 'go' || id === 'late') return true;
  const opt = (d.options || []).find(o => o.id === id);
  return fin(opt?.cost?.travelMin) && opt.cost.travelMin > 0;
}

// Where he will be just before `at` (the plan block covering it), for the departure trip.
function whereBefore(state, at, world) {
  const tz = tzOf(state, world);
  for (const day of [dayOf(at - 60, tz)]) {
    const plan = planFor(state, day, world);
    for (const b of plan?.blocks || []) {
      if (b.start <= at - 60 && at - 60 < b.end) return b.kind === 'commute' ? (b.to ?? b.placeId) : b.placeId;
    }
  }
  return state?.position?.placeId ?? state?.self?.homePlaceId ?? null;
}

/**
 * The span the calendar must hold free (from departure for anything at a place):
 * [eventAt − travel − prep, end] with travel and prep from decisions.deadlines().
 */
export function fitSpan(span, type, placeId, state, world, at) {
  if (type === 'activity' || !placeId) return { start: span.start, end: span.end, travelMin: 0, prepMin: 0 };
  const tw = travelWorld(state, world);
  const from = whereBefore(state, span.start, tw) ?? state?.self?.homePlaceId ?? null;
  let dl = null;
  try {
    dl = deadlines({ eventAt: span.start, placeId, from, at: Math.min(at, span.start), weather: state?.weather ?? null }, tw);
  } catch {
    dl = null;
  }
  const travelMin = fin(dl?.travelMin) ? dl.travelMin : 0;
  const prepMin = fin(dl?.prepMin) ? dl.prepMin : (routineOf(tw)?.prepMinutes ?? 20);
  return { start: span.start - (travelMin + prepMin) * 60, end: span.end, travelMin, prepMin, ponrAt: dl?.ponrAt ?? null };
}

/**
 * Does `span` (already widened to departure) fit his calendar? Checks the fixed
 * blocks (work, meeting, sleep, the work commute) of every day it touches (and the night
 * before, whose sleep runs into the morning), committed decision windows and
 * pending commitments (± 30 min). → null (fits) | { with:{kind, start, end, label, eventId} }
 */
export function fit(span, state, world, { excludeDecisionId = null } = {}) {
  const tz = tzOf(state, world);
  const days = new Set();
  for (let t = dayOf(addDays(dayOf(span.start, tz), -1, tz), tz); t <= span.end; t = dayOf(addDays(t, 1, tz), tz)) days.add(t);
  const office = world?.self?.job?.officePlaceId ?? state?.self?.officePlaceId ?? null;
  for (const day of days) {
    const plan = planFor(state, day, world);
    for (const b of plan?.blocks || []) {
      if (!FIXED_KINDS.has(b.kind)) continue;
      // Only the work commute is fixed; a trip to or from a leisure block is not.
      if (b.kind === 'commute' && !(office && (b.to === office || b.from === office))) continue;
      if (span.start < b.end && b.start < span.end) {
        return { with: { kind: b.kind, start: b.start, end: b.end, label: b.kind, eventId: plan.eventId ?? null } };
      }
    }
  }
  for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (d.id === excludeDecisionId || !occupies(d)) continue;
    const w = decisionWindow(d);
    if (w && span.start < w.end && w.start < span.end) {
      return { with: { kind: 'decision', start: w.start, end: w.end, label: cleanItem(d.options?.find(o => o.id === d.committed.optionId)?.label, 80) || 'plan', eventId: d.id } };
    }
  }
  const now = nowSec();
  for (const c of Array.isArray(state?.story?.commitments) ? state.story.commitments : []) {
    if (!fin(c?.dueAt) || c.dueAt < now) continue;
    const s0 = c.dueAt - COMMITMENT_SLACK_SEC;
    const e0 = c.dueAt + COMMITMENT_SLACK_SEC;
    if (span.start < e0 && s0 < span.end) return { with: { kind: 'commitment', start: s0, end: e0, label: 'commitment', eventId: c.eventId ?? null } };
  }
  // 014 sched (R21): an owner override's range is busy (a claim, an invitation's resolvePlan).
  if (hasSchedule(state)) {
    const r = activeRanges(state, span.start, span.end)[0];
    if (r) return { with: { kind: 'schedule', start: r.from, end: r.to, label: 'schedule', eventId: r.overrideId } };
  }
  return null;
}

/** Adopted plans whose event is still ahead (research R14: exempt from pruning, capped at 24). */
export function futureAdoptions(state, at = nowSec()) {
  if (typeof deps.futureAdoptions === 'function') return deps.futureAdoptions(state, at);
  let n = 0;
  for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (d.adopted === true && d.status === 'committed' && fin(d.subject?.eventAt) && d.subject.eventAt > at) n++;
  }
  return n;
}

// ── labels (code-built; never the clerk's summary) ───────────────────────────

// The clerk's `kind` is a free slug: only these activity words (009's activity
// classes plus everyday outings) reach a label, a decision kind, an option kind
// or activity.recorded; anything else is the type's own word / 'plan'.
const ACTIVITY_KINDS = new Set([
  'plan', 'movie', 'dinner', 'lunch', 'breakfast', 'brunch', 'meal', 'snack', 'coffee', 'cafe', 'tea', 'drinks', 'eat-out',
  'party', 'outing', 'hangout', 'visit', 'social', 'family-call', 'call', 'walk', 'run', 'gym', 'workout', 'sport', 'game',
  'groceries', 'shopping', 'errand', 'chores', 'cook', 'tv', 'gaming', 'read', 'concert', 'trip', 'leisure', 'rest', 'nap',
]);

/** The clerk's kind on the closed allow-list, or null (012: an invitation with any other kind is refused). */
export function allowedKind(kind) {
  if (typeof kind !== 'string') return null;
  const k = kind.trim().toLowerCase().replace(/[\s_]+/g, '-').slice(0, 24);
  return ACTIVITY_KINDS.has(k) ? k : null;
}

/** The clerk's kind on the closed allow-list, else 'plan'. */
export function activityKind(kind) {
  return allowedKind(kind) ?? 'plan';
}

/** "movie at Cinema with Rowan and a friend from this chat" — from resolved fields only, ≤ 120. */
export function labelFor(resolution, state) {
  const k = allowedKind(resolution?.kind);
  const kind = k ? k.replace(/[_-]+/g, ' ')
    : ({ plan: 'plan', commitment: 'to-do', activity: 'outing' }[resolution?.type] ?? 'plan');
  const place = resolution?.placeId && state?.places instanceof Map ? state.places.get(resolution.placeId) : null;
  const names = (resolution?.castIds || []).map(id => (state?.cast instanceof Map ? state.cast.get(id) : null))
    .filter(Boolean).map(c => matchName(c).split(' ')[0]).filter(Boolean);
  if (resolution?.subjectJid) names.push('a friend from this chat');
  let label = kind;
  if (place?.name) label += ` at ${safePlaceName(state, resolution.placeId, matchName(place) || cleanItem(place.name, 60))}`;
  if (names.length) label += ` with ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`;
  return cleanItem(label, 120);
}

// ── resolve (steps 4–10) ─────────────────────────────────────────────────────

/**
 * Code-only resolution of a validated extraction for a claim (steps 4–10).
 *   claim = { id, chatJid, originKind, originJid, createdAt }
 *   opts.mapping (owner tray adopt): { placeId, castIds, startAt, minutes } replace the
 *   automatic place/people/time resolution (unknown_* / ambiguous_* overridden).
 * → { ok:true, resolution } | { ok:false, reason, conflict?, refusal? }
 * resolution = { type, kind, placeId, castIds, subjectJid, span:{start,end}, fitSpan, day, minutes }
 */
export async function resolve(extraction, claim, state, { at = nowSec(), mapping = null, world = worldFor(state) } = {}) {
  const x = isObj(extraction) ? extraction : {};
  // 4. type gate
  if (!IN_SCOPE_TYPES.includes(x.type) || !(fin(x.confidence) && x.confidence >= MIN_CONFIDENCE)) return { ok: false, reason: 'out_of_scope' };
  const tz = tzOf(state, world);
  const weekendDays = routineOf(world)?.weekend ?? [0, 6];

  // 5. time
  let span = resolveSpan(x, claim.createdAt, tz, { weekendDays });
  if (mapping && fin(mapping.startAt)) {
    const minutes = fin(mapping.minutes) ? Math.min(360, Math.max(15, Math.round(mapping.minutes))) : (span?.minutes ?? DEFAULT_MINUTES[x.type]);
    span = { start: Math.floor(mapping.startAt), end: Math.floor(mapping.startAt) + minutes * 60, minutes };
  } else if (mapping && fin(mapping.minutes) && span) {
    const minutes = Math.min(360, Math.max(15, Math.round(mapping.minutes)));
    span = { start: span.start, end: span.start + minutes * 60, minutes };
  }
  if (!span) return { ok: false, reason: 'out_of_window' };
  if (span.start < at - PAST_WINDOW_SEC || span.end > at + FUTURE_WINDOW_SEC) return { ok: false, reason: 'out_of_window' };
  if ((x.type === 'plan' || x.type === 'commitment') && span.end <= at) return { ok: false, reason: 'out_of_window' };
  if (x.type === 'activity' && span.start >= at) return { ok: false, reason: 'out_of_window' };

  // 6. place
  let placeId = null;
  if (mapping && typeof mapping.placeId === 'string') {
    if (!(state?.places instanceof Map) || !state.places.has(mapping.placeId)) return { ok: false, reason: 'unknown_place' };
    placeId = mapping.placeId;
  } else if (x.place) {
    const m = matchPlace(x.place, state, world);
    if (!m.placeId) return { ok: false, reason: m.reason };
    placeId = m.placeId;
  } else if (x.type === 'plan') {
    return { ok: false, reason: 'unknown_place' };
  }

  // 7. people
  let castIds;
  let subjectJid;
  if (mapping && Array.isArray(mapping.castIds)) {
    castIds = [...new Set(mapping.castIds.filter(id => state?.cast instanceof Map && state.cast.has(id)))];
    if (castIds.length !== new Set(mapping.castIds).size) return { ok: false, reason: 'unknown_person' };
    const auto = await resolvePeople(x.people, claim, state);
    subjectJid = auto.reason ? null : auto.subjectJid;
    if (mapping.subjectJid === null) subjectJid = null;
  } else {
    const p = await resolvePeople(x.people, claim, state);
    if (p.reason) return { ok: false, reason: p.reason };
    ({ castIds, subjectJid } = p);
  }

  // 8. controls (social always; cast too when cast members are involved; their pins)
  const categories = castIds.length ? ['social', 'cast'] : ['social'];
  for (const category of categories) {
    const v = controlsCheck({ source: mapping ? 'owner' : 'reconciler', category, action: 'adopt', pinKeys: castIds }, state);
    if (!v.ok) return { ok: false, reason: 'blocked', refusal: { category, reason: v.reason, pinKey: v.pinKey ?? null } };
  }

  // 9. calendar fit, from departure
  const fs0 = fitSpan(span, x.type, placeId, state, world, at);
  if (x.type === 'plan' && fin(fs0.ponrAt) && fs0.ponrAt <= at) return { ok: false, reason: 'out_of_window' };
  const conflict = fit(fs0, state, world);
  if (conflict) return { ok: false, reason: 'conflict', conflict };

  // 10. future-plan cap
  if (x.type === 'plan' && futureAdoptions(state, at) >= MAX_FUTURE_ADOPTIONS) return { ok: false, reason: 'cap' };

  return {
    ok: true,
    resolution: {
      type: x.type, kind: x.kind ?? null, placeId, castIds, subjectJid, minutes: span.minutes,
      span: { start: span.start, end: span.end }, fitSpan: { start: fs0.start, end: fs0.end }, day: dateKey(span.start, tz),
    },
  };
}

// ── adopt (step 11) ──────────────────────────────────────────────────────────

/**
 * Write the adoption batch (engine; cause = the claim pointer). → { ok, adoptedEventId, as, ref } |
 * { ok:false, reason }. The review row is updated by the caller (runOne / ownerAdopt).
 */
export async function adopt(review, resolution, state, append = deps.append, { at = nowSec() } = {}) {
  if (typeof append !== 'function') return { ok: false, reason: 'not_attached' };
  if (!Number.isSafeInteger(review?.claimEventId)) return { ok: false, reason: 'no_pointer' };
  const as = resolution.type === 'plan' ? 'decision' : resolution.type;
  const subject = resolution.subjectJid ? { subjectJid: resolution.subjectJid } : {};
  const label = labelFor(resolution, state);
  const adoptedEv = append({
    type: 'claim.adopted', at, actor: 'engine', causeId: review.claimEventId, ...subject,
    payload: { claimId: review.claimId, reviewId: review.id, as, ref: null },
  });
  try {
    if (as === 'decision') {
      const openDecision = deps.openDecision ?? (await import('../decisions.js')).openDecision;
      const getState = typeof deps.getState === 'function' ? deps.getState : () => state;
      const k = activityKind(resolution.kind);
      const res = await openDecision(getState, {
        kind: `claim:${k}`, category: 'social', adopted: true, preCommit: 'go', claimId: review.claimId,
        subject: { eventAt: resolution.span.start, placeId: resolution.placeId, castIds: resolution.castIds, minutes: resolution.minutes },
        options: [
          { id: 'go', label, go: true, kind: k },
          { id: 'late', label: 'Join later', go: 'late', kind: k },
          { id: 'stay', label: 'Stay in', kind: 'rest' },
        ],
      }, { at, world: worldFor(getState()), append, causeId: adoptedEv.id, ...subject });
      const committed = (res?.events || []).some(e => e.type === 'decision.committed');
      if (!committed) throw Object.assign(new Error('not committed'), { code: 'not_committed' });
      return { ok: true, adoptedEventId: adoptedEv.id, as, ref: res.decision.id };
    }
    if (as === 'commitment') {
      const ev = append({
        type: 'commitment.recorded', at, actor: 'engine', causeId: adoptedEv.id, ...subject,
        payload: { dueAt: resolution.span.start, ...(resolution.placeId ? { placeId: resolution.placeId } : {}), castIds: resolution.castIds, label },
      });
      return { ok: true, adoptedEventId: adoptedEv.id, as, ref: ev.id };
    }
    const ev = append({
      type: 'activity.recorded', at, actor: 'engine', causeId: adoptedEv.id, ...subject,
      payload: { kind: activityKind(resolution.kind), ...(resolution.placeId ? { placeId: resolution.placeId } : {}), castIds: resolution.castIds,
        startAt: resolution.span.start, endAt: resolution.span.end, label },
    });
    return { ok: true, adoptedEventId: adoptedEv.id, as, ref: ev.id };
  } catch (err) {
    // Undo the half-written batch: reverting claim.adopted cascades through whatever followed it.
    try { revert(adoptedEv.id, 'adopt_failed'); } catch { /* the review goes to the tray either way */ }
    return { ok: false, reason: err?.code === 'not_committed' ? 'out_of_window' : 'failed', adoptedEventId: adoptedEv.id };
  }
}

function revert(eventId, reason) {
  const fn = deps.revertEvent ?? ((id, o) => revertEventDefault(id, { ...o, at: nowSec() }));
  return fn(eventId, { reason, by: 'system:withdrawn' });
}

// ── queue ────────────────────────────────────────────────────────────────────

let chain = Promise.resolve();
let kicked = null;
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * Enqueue a flagged claim (the life facade, right after the claim.flagged
 * pointer). Creates the pending review (tray window = ARCS_TRAY_HOURS) and kicks
 * the worker. Never throws. → review id | null
 */
export function enqueue({ claim, eventId = null } = {}) {
  try {
    if (!isObj(claim) || !Number.isSafeInteger(claim.id)) return null;
    if (!['group', 'dm'].includes(claim.originKind ?? claim.origin_kind)) return null;
    const { id } = store().createReview({
      claimId: claim.id, claimEventId: Number.isSafeInteger(eventId) ? eventId : null, chatJid: claim.chatJid ?? claim.chat_jid,
      originKind: claim.originKind ?? claim.origin_kind, originJid: claim.originJid ?? claim.origin_jid ?? claim.chatJid,
      createdAt: nowSec(), trayHours: cfg().trayHours,
    });
    kick();
    return id;
  } catch (err) {
    logger.warn({ evt: 'arcs_reconciler', status: 'enqueue_failed', claimId: claim?.id ?? null, code: err?.code ?? null }, 'arcs reconciler: enqueue failed');
    return null;
  }
}
export const onClaimFlagged = enqueue;

/** Start the worker if it isn't running (fire and forget). */
export function kick() {
  if (kicked || !isOn()) return kicked;
  kicked = runQueue().catch(() => null).finally(() => { kicked = null; });
  return kicked;
}

/** Caps for one more extraction now. → null (ok) | 'cap_hour'|'cap_day'|'clerk_cap'|'budget' */
export async function capReason(at = nowSec(), state = deps.getState?.()) {
  const c = cfg();
  const st = store();
  const since = dayStart(at, tzOf(state, deps.world));
  if (st.countRuns({ kind: 'extract', excludeStatus: 'skipped', since: at - HOUR }) >= Number(c.extractMaxPerHour ?? 10)) return 'cap_hour';
  if (st.countRuns({ kind: 'extract', excludeStatus: 'skipped', since }) >= Number(c.extractMaxPerDay ?? 60)) return 'cap_day';
  if (st.countRuns({ kind: ['extract', 'journal'], excludeStatus: 'skipped', since }) >= Number(c.clerkMaxPerDay ?? 80)) return 'clerk_cap';
  if (!(await budgetAllowed())) return 'budget';
  return null;
}

/**
 * Process pending reviews, oldest first, one at a time (serialized per process).
 * Stops at the first cap. Runs only while the story is on. → { processed, stopped? }
 */
export function runQueue() {
  return serialized(async () => {
    let processed = 0;
    if (!isOn()) return { processed, stopped: 'off' };
    expireTray();
    applyPendingWithdrawals();   // appends + a facade rebuild: here on the worker, never on the tick chain
    const pending = store().listReviews({ status: 'pending', limit: 200 }).reverse();
    for (const r of pending.slice(0, QUEUE_BATCH)) {
      if (!isOn()) return { processed, stopped: 'off' };
      const out = await runOne(r.id);
      processed++;
      if (out === 'capped' || out === 'paused' || out === 'off') return { processed, stopped: out };
    }
    return { processed };
  });
}

function logOutcome(review, status, reason = null) {
  logger.info({ evt: 'arcs_reconciler', reviewId: review.id, claimId: review.claimId, status, reason }, 'arcs reconciler');
}

function toTray(review, reason, { conflict = null, from = 'extracting', resolution } = {}) {
  const st = store();
  const patch = { status: 'tray', reason };
  if (conflict) patch.conflict = conflict;
  if (resolution !== undefined) patch.resolution = resolution;
  const changed = st.updateReview(review.id, patch, { fromStatus: from });
  if (changed) logOutcome(review, 'tray', reason);
  return changed;
}

/**
 * One review through the pipeline. → 'adopted'|'tray'|'capped'|'paused'|'off'|'skipped'|'gone'|'failed'
 */
export async function runOne(reviewId) {
  const st = store();
  let review = st.getReview(reviewId);
  if (!review || review.status !== 'pending') return 'gone';
  const at = nowSec();
  const state = deps.getState?.();
  if (!state || state.genesisAt == null) return 'off';
  if (isPaused(state)) return 'paused';
  const mode = reconcilerModeOf(state, cfg().reconcilerMode);
  if (mode === 'off') return 'off';
  if (mode === 'review') { toTray(review, 'review_mode', { from: 'pending' }); return 'tray'; }

  const claim = getClaim(review.claimId);
  if (!claim) {
    st.updateReview(review.id, { status: 'failed', decidedBy: 'engine' }, { fromStatus: 'pending' });
    logOutcome(review, 'failed', 'no_claim');
    return 'failed';
  }
  if (claim.status !== 'flagged') {
    const status = claim.status === 'dismissed' ? 'dismissed' : claim.status === 'rejected' ? 'rejected' : 'failed';
    st.updateReview(review.id, { status, decidedBy: 'engine' }, { fromStatus: 'pending' });
    logOutcome(review, status, 'claim_closed');
    return 'failed';
  }
  if (!Number.isSafeInteger(review.claimEventId)) {
    const ptr = findPointer(review.claimId, review.createdAt);
    if (!ptr) {
      st.updateReview(review.id, { status: 'failed', decidedBy: 'engine' }, { fromStatus: 'pending' });
      logOutcome(review, 'failed', 'no_pointer');
      return 'failed';
    }
    st.updateReview(review.id, { claimEventId: ptr }, { fromStatus: 'pending' });
    review = st.getReview(review.id);
  }

  const cap = await capReason(at, state);
  if (cap) return 'capped';
  if (!st.updateReview(review.id, { status: 'extracting' }, { fromStatus: 'pending' })) return 'gone';

  // 3. the one model call: the fenced claim excerpt + its time, nothing else.
  const world = worldFor(state);
  const tz = tzOf(state, world);
  const user = `Claim written ${claimTimeLabel(claim.createdAt, tz)} (world timezone).\n${fence(claim.text, { kind: 'claim', cap: 300 })}`;
  const runId = st.startRun({ kind: 'extract', caller: EXTRACT_CALLER, input: { claimId: review.claimId, reviewId: review.id }, startedAt: at });
  let res;
  try {
    const call = deps.callRole ?? (await import('../../brain/llm.js')).callRole;
    res = await call('clerk', EXTRACT_PROMPT, user, { caller: EXTRACT_CALLER, maxTokens: 400, temperature: 0 });
  } catch {
    res = { text: null, status: 'error' };
  }
  const meta = { model: res?.model ?? null, fellBack: !!res?.fellBack, costUsd: fin(res?.costUsd) ? res.costUsd : null };
  if (!isOn()) {
    // Switched off (or detached) during the call: the paid call still counts
    // against the caps (status failed, not skipped); adopt nothing, the review waits.
    st.bumpRun(runId, { status: 'failed', ...meta });
    st.updateReview(review.id, { status: 'pending', runId }, { fromStatus: 'extracting' });
    return 'off';
  }
  if (res?.skipped) {
    st.bumpRun(runId, { status: 'skipped', skipReason: ['budget', 'disabled', 'no_key'].includes(res.skipped) ? res.skipped : 'budget', ...meta });
    st.updateReview(review.id, { status: 'pending', runId }, { fromStatus: 'extracting' });
    return 'capped';
  }
  const v = validateExtraction(res?.text);
  if (!v.ok) {
    st.bumpRun(runId, { status: 'invalid', ...meta, dropped: [{ path: '', reason: v.error }] });
    st.updateReview(review.id, { runId }, { fromStatus: 'extracting' });
    toTray(review, 'invalid_extraction');
    return 'tray';
  }
  // Structural fields only in the run row: the summary lives in the review alone.
  st.bumpRun(runId, { status: 'ok', ...meta, output: { type: v.value.type, kind: v.value.kind, confidence: v.value.confidence } });
  if (!st.updateReview(review.id, { extraction: v.value, runId }, { fromStatus: 'extracting' })) return 'gone';   // withdrawn meanwhile

  // 4–10. code only, against the projection as it is now.
  const live = deps.getState?.() ?? state;
  const r = await resolve(v.value, { ...claim, chatJid: claim.chatJid, originKind: claim.originKind, createdAt: claim.createdAt }, live, { at });
  if (!r.ok) {
    if (r.refusal) {
      try {
        st.recordRefusal({ source: 'reconciler', category: r.refusal.category, action: 'adopt', target: `claim:${review.claimId}`,
          reason: ['paused', 'frozen', 'pinned', 'guided', 'invalid'].includes(r.refusal.reason) ? r.refusal.reason : 'invalid',
          pinKey: r.refusal.pinKey, detail: { reviewId: review.id }, at });
      } catch { /* best effort */ }
    }
    toTray(review, r.reason, { conflict: r.conflict ?? null });
    return 'tray';
  }
  return finishAdoption(review, r.resolution, live, { at, by: 'engine' });
}

async function finishAdoption(review, resolution, state, { at, by, from = 'extracting' }) {
  const st = store();
  const a = await adopt(review, resolution, state, deps.append, { at });
  if (!a.ok) {
    toTray(review, a.reason === 'out_of_window' ? 'out_of_window' : 'conflict', { from, resolution });
    if (a.reason === 'not_attached' || a.reason === 'no_pointer') logOutcome(review, 'tray', a.reason);
    return 'tray';
  }
  const ok = st.updateReview(review.id, {
    status: 'adopted', adoptedEventId: a.adoptedEventId, resolution: { ...resolution, ref: a.ref, as: a.as }, decidedBy: by,
  }, { fromStatus: from });
  if (!ok) {
    // Withdrawn while the batch was being written: keep the event id so the world side is undone now.
    st.updateReview(review.id, { adoptedEventId: a.adoptedEventId });
    applyPendingWithdrawals();
    return 'gone';
  }
  try { setClaimStatus(review.claimId, 'adopted', { by: by === 'engine' ? 'engine' : by, at }); } catch { /* the review is the record */ }
  logOutcome(review, 'adopted', null);
  return 'adopted';
}

// The claim.flagged pointer of a claim (boot-sweep rows carry no event id).
function findPointer(claimId, since) {
  try {
    const rows = listEvents({ types: ['claim.flagged'], from: (fin(since) ? since : nowSec()) - 7 * DAY, limit: 500, order: 'desc' });
    return rows.find(e => e.payload?.claimId === claimId)?.id ?? null;
  } catch {
    return null;
  }
}

// ── tray, expiry, sweep ──────────────────────────────────────────────────────

/**
 * Expire what ran out (afterTick): a tray review past expires_at → expired; a
 * pending one → expired while paused or the mode is off, else (it waited on caps)
 * → tray/not_extracted with a fresh tray window. → count changed
 */
export function expireTray(at = nowSec()) {
  const st = store();
  let n = 0;
  try {
    const state = deps.getState?.();
    const stalled = !state || isPaused(state) || reconcilerModeOf(state, cfg().reconcilerMode) === 'off';
    for (const r of st.listExpiredReviews(at, { status: ['pending', 'tray'] })) {
      if (r.status === 'tray' || stalled) {
        if (st.updateReview(r.id, { status: 'expired', decidedBy: 'engine' }, { fromStatus: r.status })) { n++; logOutcome(r, 'expired', r.reason ?? null); }
      } else if (st.updateReview(r.id, { status: 'tray', reason: 'not_extracted', expiresAt: at + Number(cfg().trayHours ?? 72) * HOUR },
        { fromStatus: 'pending' })) {
        n++;
        logOutcome(r, 'tray', 'not_extracted');
      }
    }
  } catch (err) {
    logger.warn({ evt: 'arcs_reconciler', status: 'expire_failed', code: err?.code ?? null }, 'arcs reconciler: expiry failed');
  }
  return n;
}

/**
 * Boot sweep (attach): reviews left `extracting` by a crash go back to pending;
 * flagged claims of the last ARCS_TRAY_HOURS with no review get one (≤ 50, oldest
 * first). → { reset, enqueued }
 */
export function bootSweep(at = nowSec()) {
  const st = store();
  let reset = 0;
  let enqueued = 0;
  try {
    for (const r of st.listReviews({ status: 'extracting', limit: 200 })) {
      if (st.updateReview(r.id, { status: 'pending' }, { fromStatus: 'extracting' })) reset++;
    }
    const since = at - Number(cfg().trayHours ?? 72) * HOUR;
    for (const c of st.claimsWithoutReview({ since, limit: SWEEP_LIMIT })) {
      const ptr = findPointer(c.claimId, c.createdAt);
      const { created } = st.createReview({ claimId: c.claimId, claimEventId: ptr, chatJid: c.chatJid, originKind: c.originKind,
        originJid: c.originJid, createdAt: at, trayHours: cfg().trayHours });
      if (created) enqueued++;
    }
  } catch (err) {
    logger.warn({ evt: 'arcs_reconciler', status: 'sweep_failed', code: err?.code ?? null }, 'arcs reconciler: boot sweep failed');
  }
  if (enqueued || reset) logger.info({ evt: 'arcs_reconciler', status: 'sweep', reset, enqueued }, 'arcs reconciler: boot sweep');
  kick();
  return { reset, enqueued };
}

/**
 * Owner tray adopt (Director `tray.adopt`): steps 5, 8, 9 (and 10) re-run with the
 * owner's mapping; an out-of-scope type is refused. `apply:false` only resolves
 * (the preview). → { ok, resolution?, reason?, conflict?, status? }
 */
export async function ownerAdopt(reviewId, mapping = {}, { by = 'owner', apply = true, at = nowSec() } = {}) {
  const st = store();
  const review = st.getReview(reviewId);
  if (!review) return { ok: false, reason: 'not_found' };
  if (!['tray', 'returned'].includes(review.status)) return { ok: false, reason: 'stale' };
  const x = review.extraction;
  if (!isObj(x)) return { ok: false, reason: 'invalid' };
  if (!IN_SCOPE_TYPES.includes(x.type)) return { ok: false, reason: 'out_of_scope' };
  const claim = getClaim(review.claimId);
  if (!claim) return { ok: false, reason: 'not_found' };
  const state = deps.getState?.();
  if (!state) return { ok: false, reason: 'not_running' };
  // The owner vouches for the claim: confidence no longer gates it.
  const r = await resolve({ ...x, confidence: 1 }, claim, state, { at, mapping: isObj(mapping) ? mapping : {} });
  if (!r.ok) return { ok: false, reason: r.reason, conflict: r.conflict ?? null };
  if (!apply) return { ok: true, resolution: r.resolution };
  const status = await finishAdoption(review, r.resolution, state, { at, by, from: review.status });
  return { ok: status === 'adopted', status, resolution: r.resolution };
}

// ── withdrawal (R22) ─────────────────────────────────────────────────────────

const WITHDRAW_REASONS = ['revoked', 'forgotten', 'owner', 'rewound'];
function withdrawReason(by) {
  const s = String(by ?? '').toLowerCase();
  if (/forg/.test(s)) return 'forgotten';
  if (/rewin|rewound/.test(s)) return 'rewound';
  if (/revok|edit|delet/.test(s)) return 'revoked';
  return 'owner';
}

function withdrawnEventExists(claimId, since) {
  try {
    const rows = listEvents({ types: ['claim.withdrawn'], from: (fin(since) ? since : 0) - DAY, limit: 500, order: 'desc' });
    return rows.some(e => e.payload?.claimId === claimId);
  } catch {
    return false;
  }
}

/**
 * The world side of one withdrawn adoption: claim.withdrawn (engine, cause = the
 * claim pointer) once, then the revert of claim.adopted (the 009 cascade removes
 * the decision, its lean and commit, the amended plan and the outing, or the
 * record). Idempotent. → true when the adoption is (now) out of the projection.
 */
export function withdrawWorld(review, { reason = null } = {}) {
  if (!Number.isSafeInteger(review?.adoptedEventId)) return false;
  const state = deps.getState?.();
  if (!state) return false;
  if (isExcludedId(state, review.adoptedEventId)) return true;
  const why = WITHDRAW_REASONS.includes(reason) ? reason : withdrawReason(review.decidedBy);
  if (typeof deps.append === 'function' && Number.isSafeInteger(review.claimEventId)
    && !withdrawnEventExists(review.claimId, review.createdAt)) {
    deps.append({ type: 'claim.withdrawn', at: nowSec(), actor: 'engine', causeId: review.claimEventId, payload: { claimId: review.claimId, reason: why } });
  }
  revert(review.adoptedEventId, `withdrawn:${why}`);
  logOutcome(review, 'withdrawn', why);
  return true;
}

/**
 * Owner/hook withdrawal of reviews by id: DB side at once (store.withdrawReviews,
 * extraction NULLed), world side when attached. → { withdrawn, pendingWorld }
 */
export function withdraw(reviewIds, { by = 'owner' } = {}) {
  const st = store();
  const ids = (Array.isArray(reviewIds) ? reviewIds : [reviewIds]).map(Number).filter(Number.isSafeInteger);
  const claimIds = ids.map(id => st.getReview(id)?.claimId).filter(Number.isSafeInteger);
  const before = st.withdrawReviews(claimIds, { by });
  let pendingWorld = 0;
  for (const b of before) {
    if (!Number.isSafeInteger(b.adoptedEventId)) continue;
    const row = st.getReview(b.id);
    try {
      if (!withdrawWorld(row, { reason: withdrawReason(by) })) pendingWorld++;
    } catch {
      pendingWorld++;
    }
  }
  return { withdrawn: before.length, pendingWorld };
}

/**
 * Withdrawn reviews whose adoption is still in the projection (hooks ran DB-only,
 * possibly with life stopped): do the world side now (next tick, or boot before
 * the first pulse step). → count done
 */
export function applyPendingWithdrawals() {
  let n = 0;
  try {
    const state = deps.getState?.();
    if (!state) return 0;
    for (const r of store().listReviews({ status: 'withdrawn', limit: 200 })) {
      if (!Number.isSafeInteger(r.adoptedEventId) || isExcludedId(deps.getState?.() ?? state, r.adoptedEventId)) continue;
      try { if (withdrawWorld(r)) n++; } catch (err) {
        logger.warn({ evt: 'arcs_reconciler', reviewId: r.id, status: 'withdraw_failed', code: err?.code ?? null }, 'arcs reconciler: withdrawal failed');
      }
    }
  } catch (err) {
    logger.warn({ evt: 'arcs_reconciler', status: 'withdraw_failed', code: err?.code ?? null }, 'arcs reconciler: withdrawals failed');
  }
  return n;
}

/**
 * The tick's share (story afterTick, ENQUEUE ONLY): expire a few rows and kick the
 * worker, which applies pending withdrawals and runs the queue off the tick chain.
 */
export function afterTick(at = nowSec()) {
  expireTray(at);
  kick();
}

// ── owner tray decisions (reconciler.md §4) ──────────────────────────────────

/** Export of the life_claims status write (adopted | rejected | dismissed; flagged rows only). */
export { setClaimStatus };

function trayDecide(reviewId, status, { by = 'owner', at = nowSec() } = {}) {
  const st = store();
  const review = st.getReview(Number(reviewId));
  if (!review) return { ok: false, reason: 'not_found' };
  const who = typeof by === 'string' && by ? by.slice(0, 60) : 'owner';
  if (!st.updateReview(review.id, { status, decidedBy: who, decidedAt: at, ...(status === 'dismissed' ? { reason: 'owner' } : {}) },
    { fromStatus: ['tray', 'returned', 'pending'] })) return { ok: false, reason: 'stale' };
  try { setClaimStatus(review.claimId, status, { by: who, at }); } catch { /* the review is the record */ }
  logOutcome(review, status, 'owner');
  return { ok: true };
}

/** Owner reject: review `rejected`, life_claims `rejected`. → { ok, reason? } */
export function trayReject(reviewId, opts = {}) {
  return trayDecide(reviewId, 'rejected', opts);
}

/** Owner dismiss (also "open as scene" afterwards): review `dismissed` (reason owner), life_claims `dismissed`. */
export function trayDismiss(reviewId, opts = {}) {
  return trayDecide(reviewId, 'dismissed', opts);
}
