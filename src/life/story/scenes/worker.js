// The scene worker (spec 016, plan §P1.1, §P1.5, §P1.7, §P2.1, §P2.4). Runs on the
// story's own serialized chain (story/index.js enqueue), never on the tick's, and
// never from a sim: story.afterTick is live-only, so scenes are structurally absent
// from tomorrow.simulate, the Day projection and previewTomorrow.
//
//   scan()            cursor scan of activity.ended rows → story_scenes 'pending' (one
//                     transaction with the cursor; UNIQUE (activity, version) makes a
//                     crash / restart idempotent). The first scan seeds the cursor to
//                     MAX(world_events.id): history is never played out in bulk.
//   processPending()  ≤ 3 pending rows, oldest first → runScene.
//   runScene(row)     fact sheet → gates → mind → clerk → code one-liner (never blocks
//                     the outing). An invented_name rejection retries that same tier once.
//                     An explicit scene retries desire once, then the tame one-liner.
//   commit(...)       pulse.exclusive(() => withDecisionLock(…)) and ONE SQLite
//                     transaction: re-read state, re-check, scene.played (+ effects),
//                     the row → done / fallback with its text. Refused → rolled back,
//                     the row → skipped:append.
//   regenerate(id)    an owner REGENERATE: version+1; on success (same transaction) owner
//                     scene.regenerated + the old scene.played reverted (its effects
//                     cascade) + the new one caused by the same activity.started (D5).
//
// Logging: evt 'arcs_scene' with codes only — never the sheet, the text or a hint.
import { config, getPersona } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { routineOf } from '../../routine.js';
import { now as clockNow, dateKey, dayStart, resolveTimezone, ageOn, hhmm, dayLabel } from '../../clock.js';
import { rngFor as rngForDefault } from '../../rng.js';
import { getEvent, listEvents, lastEventId, causeChain, childEvents, revertEvent as logRevert } from '../../eventLog.js';
import { isExcludedId, vitalsAt, asOf, stateBeforeEvent } from '../../projector.js';
import { jobWordsOf } from '../reducer.js';
import { isPaused } from '../controls.js';
import { weatherFor } from '../../weather.js';
import { negativeAt, venueNamesNow, isHomeKind } from '../../places.js';
import { sceneRegister, urgeNow, heatOf } from '../desire.js';
import { withDecisionLock } from '../../decisions.js';
import { arcsCallerSpend } from '../seed.js';
import * as store from './store.js';
import { isSceneSession, sessionOf, tierOf, firstMeetOf, MIN_MINUTES } from './detect.js';
import { buildFactSheet, codeOutcome, oneLiner, ownerIntentOf, placeWords, selfOnlyScene, OUTCOMES, LONG_MINUTES, afterwardsLines, aroundOf, recordFor } from './facts.js';
import { SCENE_CHARTER, renderUser } from './charter.js';
import { validateSceneOutput, sceneTextCap, sceneParasCap } from './schema.js';
import { planEffects, effectsBlocked, companionsToUndo } from './effects.js';
import { createHash } from 'crypto';

// Scene callers live under their own `life.scene.` prefix (R10), outside `life.arcs.`: scene
// spend never uses up ARCS_MIND_BUDGET_USD (weekly pass, seed, Director prompt, continuity).
export const CALLER_PREFIX = 'life.scene.';
export const CALLER_CLERK = 'life.scene.clerk';
export const CALLER_MIND = 'life.scene.mind';
export const MIND_SHARE = 0.6;   // the mind tier stops at 60 % of the scene $ cap (the clerk keeps a reserve)
export const HEAVY_WINDOW_BEFORE = 2 * 86400;
export const HEAVY_WINDOW_AFTER = 31 * 86400;
export const PER_TICK = 3;
const DAY = 86400;
const MIN = 60;
const HOUR = 3600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

let deps = {
  now: () => Math.floor(clockNow()),
  getState: () => null,
  append: null,
  world: null,
  worldOf: (s) => null,
  pulse: null,
  rebuild: () => {},
  callRole: async (...args) => (await import('../../../brain/llm.js')).callRole(...args),
  getUsageByCaller: null,       // strict reader (a throw = cap reached); null → brain/usage.js getUsageByCallerStrict
  mindBudgetOk: null,           // 008's gate; null → the mind tier refuses (fail closed)
  knownNames: () => [],
  seed: () => null,
  rngFor: rngForDefault,
  persona: () => getPersona(),
  texting: () => ({}),          // 019: { castId: { count, tones } } — texts in the days before (story/index.js wires the phone)
};

/** Wire the worker (story/index.js wire()); partial updates keep the rest. */
export function configure(d = {}) {
  deps = { ...deps, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) };
}

const nowSec = () => Math.floor(deps.now());
const tzOf = (s) => resolveTimezone(s?.world?.timezone ?? deps.world?.timezone ?? config.timezone);

// Codes only: status, tier, skip code, row id, duration (never the sheet, a text or a hint).
function log({ status = null, tier = null, skip = null, sceneId = null, ms = null, regen = false } = {}) {
  try { logger.info({ evt: 'arcs_scene', status, tier, skip, sceneId, ms, regen }, 'story: scene'); } catch { /* best effort */ }
}

// ── scan ─────────────────────────────────────────────────────────────────────

function heavyChain(startEv) {
  try { return causeChain(startEv.id).some(e => e?.heavy === true); } catch { return true; }
}

/** The activity.ended row of a start (its child), or null. */
export function endOf(startId) {
  try { return childEvents(startId).find(e => e.type === 'activity.ended') ?? null; } catch { return null; }
}

// plan 020 C4: the live session's record of this outing (a pure read of the log). null when there is none.
function traceOf(startId) {
  try { return deps.liveTrace?.(startId) ?? null; } catch { return null; }
}

function resumedLater(startId) {
  try { return deps.liveResumed?.(startId) === true; } catch { return false; }
}

function earlierStarts(startId) {
  try {
    const ids = deps.liveEarlier?.(startId);
    return Array.isArray(ids) ? ids : [];
  } catch { return []; }
}

// One outing, one scene: the live scene an earlier start of this outing already has (a cancel that was undone after it was written). Its row, or null.
function priorLiveScene(s, startId) {
  const startAt = getEvent(startId)?.at;
  for (const id of earlierStarts(startId)) {
    const live = s?.story?.scenes?.[id];
    if (!isObj(live) || !posInt(live.eventId) || isExcludedId(s, live.eventId)) continue;
    // Its part of the outing was over before this start, or this start isn't what came next.
    if (!(getEvent(live.eventId)?.payload?.endedAt <= startAt)) continue;
    const row = store.getByEvent(live.eventId);
    if (row) return row;
  }
  return null;
}

// A rewind or a re-anchor left a short tail of a longer outing (liveSession's one session): it is still that outing.
function resumedLong(start, ok) {
  if (ok.reason !== 'short') return false;
  const t = traceOf(start.id);
  return t?.mode === 'full' && t.startAt < start.at && t.minutes >= MIN_MINUTES;
}

/**
 * Cursor scan → pending rows (DB only, one transaction). → how many were queued.
 * The cursor seeds to the log head on the first run and on every off → on of the scenes
 * (R24): outings from an off period are never played out. An outing that ended longer
 * than ARCS_SCENE_MAX_AGE_HOURS ago gets a skipped:too_old row and no event (§1.6).
 */
export function scan() {
  const s = deps.getState();
  if (!isObj(s) || s.genesisAt === null || s.genesisAt === undefined) return 0;
  const cursor = store.getCursor();
  if (cursor === null || store.getScenesOn() !== true) {
    store.inTransaction(() => { store.setCursor(lastEventId()); store.setScenesOn(true); });
    return 0;
  }
  const ends = listEvents({ types: ['activity.ended'], after: cursor, limit: 100, order: 'asc' });
  if (!ends.length) return 0;
  const maxAge = Number(config.arcs?.sceneMaxAgeHours ?? 36) * HOUR;
  const t = nowSec();
  let n = 0;
  store.inTransaction(() => {
    for (const end of ends) {
      const start = posInt(end.causeId) ? getEvent(end.causeId) : null;
      if (!start) continue;
      const ok = isSceneSession(start, end, s);
      if ((!ok.ok && !resumedLong(start, ok)) || heavyChain(start)) continue;
      if (resumedLater(start.id)) continue;   // not the outing's end: one outing, one scene, at the true end
      // A reverted scene stays undone: any row (or a folded scene) for this outing → never again.
      if (store.hasAny(start.id) || isObj(s.story?.scenes?.[start.id])) continue;
      const sess = sessionOf(start, end, s);
      if (!sess) continue;
      const tooOld = t - end.at > maxAge;
      const prior = priorLiveScene(s, start.id);
      if (store.insertPending({
        activityEventId: start.id, version: prior ? prior.version + 1 : 1, endedAt: end.at, originKind: start.originKind, originJid: start.originJid,
        subjectJid: start.subjectJid ?? null, mode: sess.mode, createdAt: t,
        ...(tooOld ? { status: 'skipped', skipReason: 'too_old' } : {}),
      }) && !tooOld) n++;
    }
    store.setCursor(ends[ends.length - 1].id);
  });
  return n;
}

/** The scenes went off (the arcs skill or ARCS_SCENES_ENABLED): the next scan re-seeds (R24). */
export function markScenesOff() {
  try { if (store.getScenesOn() !== false) store.setScenesOn(false); } catch { /* the next on re-seeds anyway */ }
}

/**
 * Rows left 'running' by a crash / restart mid-call (the first scenes job after attach):
 * v1 → pending again (skipped:interrupted past the max age), a regenerate → skipped. → count
 */
export function resetInterrupted() {
  const maxAge = Number(config.arcs?.sceneMaxAgeHours ?? 36) * HOUR;
  return store.resetRunning({ tooOldBefore: nowSec() - maxAge, at: nowSec() });
}

// ── gates (plan §P1.5; all fail closed) ──────────────────────────────────────

async function usageRows(since) {
  const fn = deps.getUsageByCaller ?? (await import('../../../brain/usage.js')).getUsageByCallerStrict;
  const rows = fn(CALLER_PREFIX, since);
  if (!Array.isArray(rows)) throw new Error('ledger');
  return rows.filter(r => typeof r?.caller === 'string' && r.caller.startsWith(CALLER_PREFIX));
}

/** Today's scene calls and the month's spend. → { today, mindToday, chatToday, monthUsd } | null (ledger unreadable). */
export async function budgetStatus(at = nowSec(), tz = tzOf(deps.getState())) {
  try {
    const since = dayStart(at, tz);
    const rows = await usageRows(since);
    const count = (list) => list.reduce((a, r) => a + (Number(r.calls) || 0), 0);
    const monthUsd = await arcsCallerSpend(at, { tz, getUsageByCaller: deps.getUsageByCaller ?? undefined, prefixes: [CALLER_PREFIX] });
    if (!finite(monthUsd)) return null;
    return {
      today: count(rows), mindToday: count(rows.filter(r => r.caller === CALLER_MIND)),
      chatToday: store.countChatAttemptsSince(since), monthUsd,
    };
  } catch {
    return null;
  }
}

async function gate(tier, at, tz, mode) {
  const b = await budgetStatus(at, tz);
  if (!b) return 'ledger';
  const cap = Number(config.arcs?.sceneBudgetUsd ?? 1);
  if (!(b.today < Number(config.arcs?.sceneMaxPerDay ?? 8))) return 'cap';
  if (!(b.monthUsd < cap)) return 'budget';
  if (mode === 'narration_only' && !(b.chatToday < Number(config.arcs?.sceneChatMaxPerDay ?? 2))) return 'chat_cap';
  if (tier === 'mind') {
    if (!(b.mindToday < Number(config.arcs?.sceneMindMaxPerDay ?? 3))) return 'mind_cap';
    if (!(b.monthUsd < cap * MIND_SHARE)) return 'mind_budget';
    if (typeof deps.mindBudgetOk !== 'function') return 'budget';
    let r;
    try { r = await deps.mindBudgetOk('think'); } catch { r = null; }
    if (r?.ok !== true) return r?.reason === 'unpriced' ? 'unpriced' : 'budget';
  }
  return null;
}

// ── the fact sheet's context (the log reads) ─────────────────────────────────

function sha(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

// The outcome (plan §P1.4, R23): the owner's tone outcome word, else a 015 owner outcome,
// else one code draw (on the metrics before the outing). A real person's scene is pinned to well / fine (D10).
function outcomeOf(s, session, rng, vitals, weather, { toneOutcome = null, before = s } = {}) {
  const pin = (v) => (session.mode === 'self_only' && v !== 'well' ? 'fine' : v);
  const tone = OUTCOMES.includes(toneOutcome) ? toneOutcome
    : (session.decisionId ? s.story?.sceneTones?.[session.decisionId]?.outcome : null);
  if (OUTCOMES.includes(tone)) return { value: pin(tone), by: 'owner' };
  const o = session.decisionId ? s.story?.outcomes?.[session.decisionId] : null;
  if (isObj(o) && (o.outcome === 'well' || o.outcome === 'badly')) return { value: pin(o.outcome), by: 'owner' };
  return { value: pin(codeOutcome(before, session, rng, { vitals, weather })), by: 'code' };
}

// His vitals at the session's start (R8/R20), read from the world before it (plan 020 D1). A zero-width
// vitalsSeries only ever sampled a start on the half hour, so any other outing read the state at job time.
// Base numbers, like every story reader: a real chat's mood overlay must not move this sheet or the roll
// (its effects carry no chat origin). That closes this morning's dream nudge too, as on the phone's sheet.
function vitalsAtStart(s, session, before, world) {
  if (isObj(before)) {
    try { return vitalsAt(before, session.startAt, world ?? undefined, { chatMood: false }); } catch { /* the state below */ }
  }
  return s.vitals ?? null;
}

// The world when the outing ended, for what was planned next (plan 020 D1: a rewrite days later
// must not list a plan made since). A session still going on has no end event: the state now.
function stateAtEnd(s, session) {
  if (!posInt(session.endEventId)) return s;
  try { return asOf({ eventId: session.endEventId + 1 }, { world: deps.world ?? undefined })?.state ?? s; } catch { return s; }
}

// Heavy / embargo at the session (P1.1 step 6, R1): a raw-log check, since a stretch that
// ended before the job would otherwise gate nothing. A read error → treated as heavy.
export function heavyAtSession(s, session) {
  try {
    const t = session.startAt;
    for (const e of listEvents({ types: ['heavy.started', 'embargo.started'], to: t, order: 'desc', limit: 100 })) {
      if (e.at > t || e.redacted || isExcludedId(s, e.id) || !(finite(e.payload?.until) && e.payload.until > t)) continue;
      if (e.type === 'heavy.started') {
        const ended = listEvents({ types: ['heavy.ended'], from: e.at, to: t, limit: 50 })
          .some(x => x.payload?.heavyId === e.id && !isExcludedId(s, x.id));
        if (ended) continue;
      }
      return true;
    }
    return false;
  } catch { return true; }
}

// The scene's register, from the world before the outing (the writer's route; the live line only asks whether it is explicit).
function registerOfSession(s0, session, ctx, outcome) {
  const regState = ctx.before?.cast instanceof Map ? ctx.before : s0;
  let personaAge = null;
  try { const a = Number((deps.persona?.() ?? getPersona())?.age); personaAge = Number.isFinite(a) ? a : null; } catch { personaAge = null; }
  return sceneRegister(regState, {
    age: personaAge,
    urge: urgeNow(regState, { now: session.startAt, tz: ctx.tz }),
    castIds: session.castIds,
    mode: session.mode,
    firstMeet: Array.isArray(ctx.firstMeet) && session.castIds?.length === 1 && ctx.firstMeet.includes(session.castIds[0]),
    outcome,
    privatePlace: isHomeKind(regState, session.placeId) || isHomeKind(s0, session.placeId),
    sick: regState.vitals?.sick === true || regState.activity?.kind === 'sick',
    realPerson: session.mode === 'self_only',
  });
}

const LIVE_BEAT_KINDS = new Set(['hobby', 'status', 'news', 'milestone']);
const COMMITMENTS_FRESH_SEC = 6 * 3600;

/**
 * Plan 020 C1: the facts of an outing still going on, for the live line. Same rule as a scene (a
 * non-routine kind, with someone, ≥ 20 min by its plan, no heavy chain), same outcome roll, so the
 * line and the scene written at its end agree. → null (no session) | { mode: 'minimal', reason }
 * (a real person, a chat's outing, a heavy stretch or window: nothing beyond "out with a friend") |
 * { mode: 'full', … } with fictional names and codes only.
 */
export function liveContext(startEv, endAt) {
  const s = deps.getState();
  if (!isObj(s) || !isObj(startEv)) return null;
  const fakeEnd = { type: 'activity.ended', at: endAt };
  let chain;
  try { chain = causeChain(startEv.id); } catch { return null; }
  if (!isSceneSession(startEv, fakeEnd, s, { chain }).ok) return null;
  const causeEv = Number.isSafeInteger(startEv.causeId) ? getEvent(startEv.causeId) : null;
  const session = sessionOf(startEv, fakeEnd, s, { causeEv });
  if (!session) return null;
  if (session.mode === 'self_only') return { mode: 'minimal', reason: 'real_person' };
  if (session.mode !== 'full') return { mode: 'minimal', reason: 'chat' };
  if (heavyAtSession(s, session)) return { mode: 'minimal', reason: 'heavy' };
  if (inHeavyWindow(s, session)) return { mode: 'minimal', reason: 'heavy_window' };
  const ctx = contextFor(s, session);
  const before = ctx.before;
  const member = (id) => before.cast?.get?.(id) ?? s.cast?.get?.(id) ?? null;
  const cast = session.castIds.map((id) => ({ id, name: member(id)?.name ?? null, pronouns: member(id)?.pronouns ?? null }));
  const metrics = session.castIds.map(id => member(id)?.metrics ?? {});
  const mean = (k) => (metrics.length ? metrics.reduce((a, m) => a + (finite(m[k]) ? m[k] : 0.5), 0) / metrics.length : 0.5);
  const topicCodes = [];
  for (const id of session.castIds) {
    for (const k of new Set(ctx.beats?.[id] ?? [])) if (LIVE_BEAT_KINDS.has(k)) topicCodes.push(`beat:${k}`);
    if (member(id)?.job && session.castIds.length === 1) topicCodes.push('job');
    if (member(id)?.hometown && session.castIds.length === 1 && !ctx.firstMeet?.includes(id)) topicCodes.push('hometown');
    if (ctx.history?.[id]?.length) topicCodes.push('history');
  }
  const opened = session.decisionId ? getEvent(session.decisionId) : null;
  const eventAt = opened?.payload?.subject?.eventAt;
  const placeKind = session.placeId ? s.places?.get?.(session.placeId)?.kind ?? null : null;
  const word = String(placeWords(s, session) ?? 'out').replace(/^(?:a|an|the) /i, '');
  const value = ctx.outcome?.value ?? 'fine';
  return {
    mode: 'full',
    activityId: startEv.id, startAt: startEv.at, endAt, kind: session.kind, placeKind, home: session.home === true, placeWord: word,
    cast, closeness: Math.round(mean('closeness') * 1000) / 1000, tension: Math.round(mean('tension') * 1000) / 1000,
    outcome: value, outcomeBy: ctx.outcome?.by ?? 'code',
    firstMeet: Array.isArray(ctx.firstMeet) && ctx.firstMeet.length > 0,
    lateMin: finite(eventAt) && startEv.at > eventAt ? Math.round((startEv.at - eventAt) / 60) : null,
    rain: ctx.weather?.rain === true,
    sick: ctx.vitals?.sick === true,
    employed: ctx.world?.self?.employed !== false,
    energyAtStart: finite(ctx.vitals?.energy) ? ctx.vitals.energy : undefined,
    topicCodes: [...new Set(topicCodes)],
    register: registerOfSession(s, session, ctx, value) === 'explicit' ? 'private' : null,
  };
}

// The heavy window (R1): a stretch's onset − 2 d … onset + 31 d (build.js nearHeavy's window).
export function inHeavyWindow(s, session) {
  try {
    const t = session.startAt;
    return listEvents({ types: ['heavy.started'], from: t - HEAVY_WINDOW_AFTER, to: t + HEAVY_WINDOW_BEFORE, limit: 100 })
      .some(e => !e.redacted && !isExcludedId(s, e.id) && t >= e.at - HEAVY_WINDOW_BEFORE && t <= e.at + HEAVY_WINDOW_AFTER);
  } catch { return true; }
}

// A beat that descends from a heavy stretch (family_illness's `news`) never reaches the sheet (R1).
function heavyCaused(e) {
  try { return causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { return true; }
}

function travelModeTo(session) {
  try {
    const trips = listEvents({ types: ['travel.started'], from: session.startAt - 4 * HOUR, to: session.startAt, order: 'desc', limit: 10 });
    const t = trips.find(e => e.payload?.to === session.placeId);
    return typeof t?.payload?.mode === 'string' ? t.payload.mode : null;
  } catch { return null; }
}

// The members' beats of the 14 days before the outing — appended before its start too (`before`
// = the activity.started id): a pass during the outing may date its lines at the start.
function beatsOf(s, ids, at, before = Infinity, afterOf = () => 0) {
  const out = {};
  try {
    for (const e of listEvents({ types: ['cast.beat'], from: at - 14 * DAY, to: at, order: 'desc', limit: 200 })) {
      if (!(e.id < before) || !(e.id > afterOf(e.payload?.castId))) continue;
      if (e.redacted || isExcludedId(s, e.id) || !ids.includes(e.payload?.castId) || e.heavy === true || heavyCaused(e)) continue;
      (out[e.payload.castId] ??= []).push(e.payload.kind);
    }
  } catch { /* none */ }
  return out;
}

// The previous live scene with each member: its ending + highlight (code-stored, re-cleaned at render).
function prevOf(s, session) {
  const out = {};
  const scenes = Object.entries(isObj(s.story?.scenes) ? s.story.scenes : {})
    .filter(([aid]) => Number(aid) !== session.activityEventId).sort((a, b) => b[1].at - a[1].at);
  for (const id of session.castIds) {
    const hit = scenes.find(([, sc]) => Array.isArray(sc.castIds) && sc.castIds.includes(id) && sc.mode === 'full' && sc.heavyWindow !== true);
    if (!hit) continue;
    let row = null;
    try { row = store.getByEvent(hit[1].eventId); } catch { row = null; }
    out[id] = { ending: hit[1].ending, highlight: typeof row?.detail?.highlight === 'string' ? row.detail.highlight : null };
  }
  return out;
}

/**
 * The world just before the outing began (2026-10-31, the first-meeting bug): a daily cast
 * pass that runs DURING an outing credits that outing's time together and adds its history
 * line ("hangout together", dated at the start), so the state at write time already says
 * "they've met". Every "before the outing" fact — firstMeet, the metrics bands and the code
 * outcome's weights, history, the previous scene, names, job, the date check — reads this
 * fold of the log up to the outing's activity.started (today's exclusions applied, so a
 * later revert still counts). Owner intent (tone, outcome, the decision) stays the state
 * now. null (no fold within the cap) → the state now, as before. A resumed outing reads
 * from before its first part (session.beforeEventId), which it was told from.
 */
export function stateAtStart(session) {
  try { return stateBeforeEvent(session.beforeEventId ?? session.activityEventId, { world: deps.world ?? undefined }) ?? null; } catch { return null; }
}

export function metAtGenesis(c) {
  const evId = posInt(c?.eventId);
  if (!evId) return true;
  const ev = getEvent(evId);
  return !ev || ev.actor === 'engine';
}

/** Everything the sheet, the validator and the effects need for one session. */
export function contextFor(s, session, { tone = null, toneOutcome = null, fixed = null, before = undefined } = {}) {
  const tz = tzOf(s);
  const world = deps.worldOf(s) ?? deps.world;
  const b0 = before === undefined ? stateAtStart(session) : before;
  const b = isObj(b0) ? b0 : s;
  let weather = null;
  try { weather = weatherFor(b, session.startAt, world); } catch { weather = null; }
  const vitals = vitalsAtStart(s, session, b0, deps.world ?? world);
  const rng = deps.rngFor(dateKey(session.endAt, tz), `scene:outcome:${session.activityEventId}`);
  // R16: a later version reuses v1's roll (outcome, firstMeet); only the owner's explicit
  // outcome word (a regenerate's tone) replaces the outcome.
  const outcome = fixed && !OUTCOMES.includes(toneOutcome) && OUTCOMES.includes(fixed.outcome)
    ? { value: fixed.outcome, by: fixed.outcomeBy === 'owner' ? 'owner' : 'code' }
    : outcomeOf(s, session, rng, vitals, weather, { toneOutcome, before: b });
  // firstMeet is a fact of the world before the outing, so a later version recomputes it
  // from that world (never frozen: v1 may have been written from a state that already held
  // the outing's credit); v1's own list is the fallback only when that world can't be read.
  const firstMeet = fixed && Array.isArray(fixed.firstMeet) && !isObj(b0)
    ? fixed.firstMeet.filter(id => session.castIds.includes(id)) : firstMeetOf(session, b, { metAtGenesis });
  const hint = tone ?? (session.decisionId ? s.story?.sceneTones?.[session.decisionId]?.tone ?? null : null);
  let negative = outcome.value === 'badly' || outcome.value === 'flat';
  if (!negative && session.placeId) {
    try {
      const evs = listEvents({ from: session.startAt - 3 * HOUR, to: session.endAt + 3 * HOUR, limit: 500 });
      negative = negativeAt(s, session.startAt, { placeId: session.placeId, events: evs });
    } catch { negative = true; }
  }
  const persona = (() => { try { return deps.persona() ?? {}; } catch { return {}; } })();
  const history = {};
  for (const id of session.castIds) history[id] = (b.story?.history?.[id] ?? []).map(h => h?.text).filter(Boolean);
  const names = {};
  for (const id of session.castIds) names[id] = b.cast?.get?.(id)?.name ?? s.cast.get(id)?.name ?? null;
  // 020 D2 + D3: the note that held when the outing began (never one written after it), the beats newer than it, and any promise with them.
  const standing = {};
  const historyAfter = {};
  const commitments = {};
  for (const id of session.mode === 'full' ? session.castIds : []) {
    let note = null;
    try { note = deps.standing?.(s, id, session.startAt) ?? null; } catch { note = null; }
    if (note) {
      standing[id] = note;
      historyAfter[id] = history[id];   // the note never reads the shared past: every line stays, whatever its date
    }
    // Only for a scene written now: what he owes them today says nothing about an old outing.
    if (deps.now() - session.endAt <= COMMITMENTS_FRESH_SEC) {
      try { commitments[id] = deps.commitmentLines?.(s, id, session.endAt, tz, 'scene') ?? []; } catch { commitments[id] = []; }
    }
  }
  const noted = Object.keys(standing);
  const beatsAfter = noted.length ? beatsOf(s, noted, session.startAt, session.beforeEventId ?? session.activityEventId, (id) => standing[id]?.asOfEventId ?? Infinity) : {};
  const toneOut = OUTCOMES.includes(toneOutcome) ? toneOutcome
    : (tone === null && session.decisionId && OUTCOMES.includes(s.story?.sceneTones?.[session.decisionId]?.outcome)
      ? s.story.sceneTones[session.decisionId].outcome : null);
  return {
    tz, world, weather, vitals, outcome, firstMeet, tone: hint, toneOutcome: hint ? toneOut : null, negative, names,
    before: b, fromStart: isObj(b0), place: placeWords(s, session),
    persona: { displayName: persona.displayName ?? persona.name ?? null, voice: persona.voiceDescriptor ?? null, aliases: persona.aliases ?? [] },
    age: ageOn(s.self?.birthdate, session.startAt, tz),
    jobTitle: jobWordsOf(b, world),
    travelMode: travelModeTo(session),
    beats: beatsOf(s, session.castIds, session.startAt, session.beforeEventId ?? session.activityEventId),
    prev: prevOf(b, session),
    history, standing, historyAfter, beatsAfter, commitments,
    texting: (() => { try { return deps.texting(session.castIds, session.startAt) ?? {}; } catch { return {}; } })(),
    ...aroundSession(s, session, tz, outcome),
  };
}

// pinned #8: the phone's true lines around the outing — when they last saw each other, their
// time together in the two days before, how he really left and what followed, and what's planned
// with them next (as of the outing's end). Fictional cast only (a real person's scene is code).
// A failed read → that part is left out.
const AROUND_TYPES = ['activity.started', 'activity.ended', 'travel.started', 'travel.arrived'];
const PUBLIC_ORIGINS = new Set(['self', 'owner']);
function afterwardsNow(s, session, tz) {
  const evs = listEvents({ types: AROUND_TYPES, from: session.endAt - 60, to: session.endAt + 6 * HOUR, order: 'asc', limit: 200 })
    .filter(e => !e.redacted && !e.heavy && !e.subjectJid && PUBLIC_ORIGINS.has(e.originKind ?? 'self') && !isExcludedId(s, e.id));
  return afterwardsLines(evs, s, session, tz);
}

// "home" on a stored line reads "their place" once he has moved out of there: the same trip, not a plot hole.
const sameHome = (line) => line.replace(/\b(?:to )?(?:home|(?:his|their) place)\b/g, 'HOME');

/**
 * 020 E1 (the sweep): do the "afterwards" lines on these scenes' stored sheets still match the
 * log? A line written while the trip home was under way gains its "there by" later, so a stored
 * line holds when a line now starts with it. → [{ eventId, stale }] (counts only, never the lines).
 */
export function afterwardsCheck(eventIds) {
  const s = deps.getState();
  if (!s) return [];
  const tz = tzOf(s);
  const out = [];
  for (const row of store.byEventIds(eventIds)) {
    const stored = Array.isArray(row.sheet?.afterwards) ? row.sheet.afterwards.filter(l => typeof l === 'string') : [];
    if (!stored.length || !['done', 'fallback'].includes(row.status)) continue;
    const ev = getEvent(row.eventId);
    const p = ev?.payload;
    if (!ev || ev.redacted || !finite(p?.endedAt)) continue;
    const session = { endAt: p.endedAt, castIds: Array.isArray(p.castIds) ? p.castIds : [], placeId: p.placeId ?? null, home: p.placeId ? isHomeKind(s, p.placeId) : false };
    const now = (aroundOf({ afterwards: afterwardsNow(s, session, tz) }).afterwards ?? []).map(sameHome);
    out.push({ eventId: row.eventId, stale: stored.filter(l => !now.some(n => n.startsWith(sameHome(l)))).length });
  }
  return out;
}

// What the writer needs to make a plan that fits: the time, his usual week, what's set, who else he knows.
// How often they do decide on something next, by how it went: a code draw on the outing, the same for every version of it.
export const DECIDE_NEXT_P = Object.freeze({ well: 0.5, fine: 0.2, flat: 0, badly: 0 });
// Left alone the writers all settle on a meal on Saturday: the code picks what sort of thing comes up.
const DECIDE_KINDS = Object.freeze(['going on somewhere right now', 'back to one of their places', 'a plan for another day', 'somewhere new to try', 'something to see or do, not a meal', 'an errand or chore, together or his own']);
// Going on together from here. Told plainly, and with no "walked home" line: the writers keep to that line
// over any hint (2026-11-05: 0 of 9 went on until it was gone and the sheet said so).
const GO_ON = Object.freeze({
  'going on somewhere right now': 'they do not part here: they go on somewhere together right now, straight from here. In "plans" use "when": "now"',
  'back to one of their places': 'they do not part here: they go back to one of their places together right now, straight from here. In "plans" use "when": "now"',
});
function planningOf(s, atEnd, session, tz, outcome) {
  const at = nowSec();
  let week = null;
  try { const r = routineOf(deps.worldOf(s) ?? deps.world); if (r?.workStart && r?.workEnd) week = `work Mon–Fri ${r.workStart}–${r.workEnd}; weekends free`; } catch { week = null; }
  let plans = [];
  try {
    plans = (deps.plans?.(atEnd, session.castIds[0], at, tz, { aheadHours: 7 * 24, skipDecisionId: session.decisionId ?? null }) ?? [])
      .map(l => (typeof l === 'string' ? l : l?.text)).filter(Boolean).map(l => l.replace(/\s*\[with them[^\]]*\]$/, '')).slice(0, 6);
  } catch { plans = []; }
  const here = new Set(session.castIds);
  const others = [...(s.cast instanceof Map ? s.cast.values() : [])].filter(c => c?.name && !here.has(c.id) && !s.story?.departed?.[c.id])
    .map(c => String(c.name).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0]).filter(Boolean).slice(0, 12);
  const draw = parseInt(sha(`decide:${session.activityEventId}`).slice(0, 8), 16) / 0xffffffff;
  // Going on from here only while it's fresh and nothing of his day (work, a meeting) starts within two hours.
  const busySoon = (Array.isArray(s.plan?.blocks) ? s.plan.blocks : [])
    .some(b => ['work', 'meeting'].includes(b?.kind) && b.end > at && b.start < at + 2 * HOUR);
  const kinds = at - session.endAt <= 30 * MIN && !busySoon ? DECIDE_KINDS : DECIDE_KINDS.filter(k => !GO_ON[k]);
  const kind = kinds[parseInt(sha(`kind:${session.activityEventId}`).slice(0, 8), 16) % kinds.length];
  const on = draw < (DECIDE_NEXT_P[outcome] ?? 0);
  const decide = on ? GO_ON[kind] ?? `they decide on something to do next. What comes up: ${kind}, or whatever fits them better` : null;
  return { now: `${dayLabel(at, tz)} ${hhmm(at, tz)}`, week, plans, others, ...(decide ? { decide } : {}), ...(on && GO_ON[kind] ? { goOn: true } : {}) };
}

function aroundSession(s, session, tz, outcome = null) {
  if (session.mode !== 'full' || !session.castIds?.length) return {};
  const call = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : null; } catch { return null; } };
  const lastSaw = {};
  const together = [];
  const plansAfter = [];
  const atEnd = stateAtEnd(s, session);
  for (const id of session.castIds) {
    const seen = call(deps.lastSeen, s, id, session.startAt - 1, tz);
    if (seen) lastSaw[id] = seen;
    for (const l of call(deps.timeline, s, id, session.startAt - 1, tz) ?? []) {
      if (typeof l === 'string' && l.endsWith(' [together]')) together.push(l.slice(0, -' [together]'.length));
    }
    for (const l of call(deps.plans, atEnd, id, session.endAt, tz, { skipDecisionId: session.decisionId ?? null }) ?? []) {
      const text = typeof l === 'string' ? l : l?.text;
      if (typeof text === 'string' && text.includes('[with them')) plansAfter.push(text.replace(/\s*\[with them[^\]]*\]$/, ''));
    }
  }
  let afterwards = [];
  try { afterwards = afterwardsNow(s, session, tz); } catch { afterwards = []; }
  const age = nowSec() - session.endAt;
  const planning = age <= PLANS_MAX_AGE_HOURS * HOUR ? planningOf(s, atEnd, session, tz, outcome) : null;
  // Written as it ends, he has only just set off: they may still decide to go on together. A line of its own: "afterwards" is compared with the log.
  if (planning && age <= 30 * MIN && afterwards.length === 1 && / on his own$/.test(afterwards[0])) {
    if (planning.goOn) afterwards = [];   // they go on: his walk home is what gets cut short
    else planning.justLeft = 'he has only just set off: if they decide to go on together instead, that replaces the "afterwards" line';
  }
  return { lastSaw, together: [...new Set(together)], afterwards, plansAfter: [...new Set(plansAfter)], ...(planning ? { planning } : {}), ...phoneDuring(s, session) };
}

// #14 one stream of attention: what his phone did while they were together — texts with other
// people from his world (who, how many, the main tone) and his real chats as counts only (never a
// name, a group or a word of them). → { phoneDuring: [line], phoneNames: [name] }
function phoneDuring(s, session) {
  const ids = new Set(session.castIds ?? []);
  const lines = [];
  const names = [];
  try {
    const by = new Map();
    for (const e of listEvents({ types: ['phone.message'], from: session.startAt, to: session.endAt, order: 'asc', limit: 300 })) {
      if (e.redacted || isExcludedId(s, e.id) || e.heavy) continue;
      const id = e.payload?.castId;
      if (typeof id !== 'string' || ids.has(id)) continue;
      const k = `${id}|${e.payload?.dir}`;
      const v = by.get(k) ?? { id, dir: e.payload?.dir, n: 0, tones: {} };
      v.n++;
      if (typeof e.payload?.tone === 'string') v.tones[e.payload.tone] = (v.tones[e.payload.tone] ?? 0) + 1;
      by.set(k, v);
    }
    for (const v of by.values()) {
      const name = s.cast?.get?.(v.id)?.name ?? s.story?.departed?.[v.id]?.name;
      if (!name) continue;
      names.push(name);
      const tone = Object.entries(v.tones).sort((a, b) => b[1] - a[1])[0]?.[0];
      const times = `${v.n} time${v.n === 1 ? '' : 's'}`;
      lines.push(v.dir === 'out' ? `he texted ${name} ${times}${tone ? `, mostly ${tone.replace(/[^a-z]/g, '')}` : ''}` : `${name} texted him ${times}`);
    }
  } catch { /* none */ }
  try {
    let sent = 0;
    for (const e of listEvents({ types: ['chat.load'], from: session.startAt + 10 * 60, to: session.endAt + 15 * 60, limit: 100 })) {
      if (!e.redacted && !isExcludedId(s, e.id) && Number.isFinite(e.payload?.sent)) sent += e.payload.sent;
    }
    if (sent >= 2) lines.push(`his phone kept going off with his group chats; he replied ${sent} times`);
  } catch { /* none */ }
  return lines.length ? { phoneDuring: lines.slice(0, 5), phoneNames: names } : {};
}

// ── the job ──────────────────────────────────────────────────────────────────

function sessionFor(row, s) {
  const start = getEvent(row.activityEventId);
  const end = start ? endOf(start.id) : null;
  if (!start || !end) return { reason: 'gone' };
  const ok = isSceneSession(start, end, s);
  if (!ok.ok && !resumedLong(start, ok)) return { reason: ok.reason === 'excluded' || ok.reason === 'redacted' ? 'gone' : ok.reason };
  const causeEv = posInt(start.causeId) ? getEvent(start.causeId) : null;
  const session = sessionOf(start, end, s, { causeEv });
  return session ? { session, start } : { reason: 'alone' };
}

const NAME_CORRECTION = 'Correction: name only people listed in the fact sheet. Anyone else stays unnamed, for example one of her friends or the waiter. Write the scene again as the JSON object.';

function attemptCode(tier, reason) {
  const why = String(reason || 'failed').replace(/^invalid:/, '').replace(/[^a-z0-9_:-]/gi, '').slice(0, 24);
  return `${tier}:${why || 'failed'}`;
}

async function callTier(tier, sheetUser, vctx, rowId = null, { explicit = false, long = false } = {}) {
  const role = explicit ? 'desire' : tier === 'mind' ? 'mind' : 'clerk';
  const caller = tier === 'mind' ? CALLER_MIND : CALLER_CLERK;
  const maxTokens = long ? 1800 : 900;
  const opts = explicit
    ? { caller, maxTokens, temperature: 0.9, timeoutMs: 60_000, noFallback: true }
    : tier === 'mind'
      ? { caller, maxTokens, effort: 'low', timeoutMs: 60_000 }
      : { caller, maxTokens, temperature: 0.8, timeoutMs: 45_000 };
  // The row records the attempt before the call (the chat-origin day cap counts attempts).
  try { if (rowId) store.update(rowId, { caller }); } catch { /* the ledger still counts it */ }
  let res;
  try { res = await deps.callRole(role, SCENE_CHARTER, sheetUser, opts); } catch { res = null; }
  if (!res || typeof res.text !== 'string' || !res.text.trim() || (res.status && res.status !== 'ok')) {
    return { ok: false, reason: res?.skipped ? `model_${String(res.skipped).slice(0, 16)}` : 'model_failed', caller };
  }
  const v = validateSceneOutput(res.text, vctx);
  if (!v.ok) return { ok: false, reason: `invalid:${v.reason}`.slice(0, 48), caller };
  return { ok: true, value: v.value, model: typeof res.model === 'string' ? res.model : null, fellBack: res.fellBack === true, caller };
}

/** One tier, plus one retry when the only failure is an invented name. The caller label stays. */
async function writeTier(tier, user, vctx, rowId, opts) {
  const codes = [];
  let r = await callTier(tier, user, vctx, rowId, opts);
  // A minor-age or non-consent failure is not retried. Neither is a model refusal.
  if (!r.ok) {
    codes.push(attemptCode(tier, r.reason));
    if (!String(r.reason).includes('invented_name')) return { ok: false, reason: r.reason, codes };
    r = await callTier(tier, `${user}\n\n${NAME_CORRECTION}`, vctx, rowId, opts);
    if (!r.ok) {
      codes.push(attemptCode(tier, r.reason));
      return { ok: false, reason: r.reason, codes };
    }
  }
  // 020 E3, enforce only (absent otherwise; an explicit scene never has it): a contradiction gets one rewrite naming it.
  const first = await opts.claims?.(r.value.narration);
  if (!first?.contradicted?.length) return { ok: true, result: { ...r, check: first?.result ?? null }, codes };
  codes.push(attemptCode(tier, 'contradicted'));
  r = await callTier(tier, `${user}\n\n${first.correction}`, vctx, rowId, opts);
  if (!r.ok) {
    codes.push(attemptCode(tier, r.reason));
    return { ok: false, reason: r.reason, codes };
  }
  const again = await opts.claims(r.value.narration);
  if (again?.contradicted?.length) {
    codes.push(attemptCode(tier, 'contradicted'));
    return { ok: false, reason: 'contradicted', codes };
  }
  return { ok: true, result: { ...r, check: again?.result ?? null, rewrote: true }, codes };
}

/**
 * Play one pending row out (plan §P1.5). opts.regenOf: the live row being regenerated.
 * → { status: 'done'|'fallback'|'skipped', reason?, sceneId, eventId? }
 */
export async function runScene(row, { regenOf = null, by = 'owner' } = {}) {
  const started = Date.now();
  if (!store.update(row.id, { status: 'running' }, { fromStatus: 'pending' })) return { status: 'skipped', reason: 'busy', sceneId: row.id };
  const s0 = deps.getState();
  const found = isObj(s0) ? sessionFor(row, s0) : { reason: 'not_running' };
  const skip = (reason) => {
    store.update(row.id, { status: 'skipped', skipReason: reason, finishedAt: nowSec() });
    log({ status: 'skipped', skip: reason, sceneId: row.id, ms: Date.now() - started, regen: !!regenOf });
    return { status: regenOf ? 'failed' : 'skipped', reason, sceneId: row.id };
  };
  if (!found.session) return skip(found.reason);
  let { session } = found;
  if (!regenOf && resumedLater(session.activityEventId)) return skip('resumed');   // it went on after this row was queued
  const at = nowSec();
  // §1.6: an outing found past the max age gets nothing (no event) — downtime never bursts the log.
  if (!regenOf && at - session.endAt > Number(config.arcs?.sceneMaxAgeHours ?? 36) * HOUR) return skip('too_old');
  // P1.1 step 6 (R1, R14): a heavy stretch or embargo at the session, or a paused Director →
  // the code one-liner, no model call, no effects. A real person's scene is the code
  // template (D10/D17), never a model call.
  const codeReason = session.mode === 'self_only' ? 'real_person'
    : isPaused(s0) ? 'paused' : heavyAtSession(s0, session) ? 'heavy' : null;
  if (regenOf && codeReason) return skip(codeReason);
  // plan 020 C4: what the live line showed is what happened. The scene takes the session's outcome rather than
  // rolling its own, and a resumed outing is told from where it began. Minimal mode has no record; a later version
  // keeps v1's roll, and carries the record only while it still agrees with the outcome.
  const trace = traceOf(session.activityEventId);
  const fullTrace = trace?.mode === 'full' ? trace : null;
  if (fullTrace && fullTrace.startAt < session.startAt) session = { ...session, startAt: fullTrace.startAt, minutes: fullTrace.minutes };
  // The before-facts of a resumed outing are from before it began, not from before its last start: that world holds its own earlier
  // scene. One anchor for all of them: the first start in the log's chain, which is the one the record was told from.
  const anchorId = earlierStarts(session.activityEventId).at(-1) ?? (fullTrace && posInt(fullTrace.activityEventId) && fullTrace.activityEventId !== session.activityEventId ? fullTrace.activityEventId : null);
  if (anchorId) session = { ...session, beforeEventId: anchorId };
  const prior = regenOf ? null : priorLiveScene(s0, session.activityEventId);
  const fixed = regenOf ? rollOf(regenOf) : fullTrace && OUTCOMES.includes(fullTrace.outcome)
    ? { outcome: fullTrace.outcome, outcomeBy: fullTrace.outcomeBy } : prior ? rollOf(prior) : null;
  const ctx = contextFor(s0, session, { tone: row.tone ?? null, toneOutcome: row.toneOutcome ?? null, fixed });
  // The sheet's "before" facts come from the world before the outing (ctx.before), the place
  // words from now (a negative moment at a venue since then still hides its name).
  const built = buildFactSheet(ctx.before, session, ctx);
  // R16: a later version never rebuilds the sheet from a state that already holds v1's
  // effects. The world before the outing holds none, so it is rebuilt from that (and a v1
  // sheet written from a wrong state is not carried on); only when that world can't be read
  // is v1's stored sheet reused (same cast) with this version's outcome and hint.
  if (!ctx.fromStart && fixed?.sheet && JSON.stringify(fixed.sheet.people?.map(p => p.label) ?? []) === JSON.stringify(Object.keys(built.labels))) {
    const intent = built.sheet.ownerIntent ?? null;
    const isLong = built.sheet.long === true;
    built.sheet = { ...fixed.sheet, outcome: built.outcome, tone: built.sheet.tone };
    if (intent) built.sheet.ownerIntent = intent;
    if (isLong) built.sheet.long = true;
  }
  // A regenerate whose v1 sheet predates these fields still gets them. The world now
  // (and the world before the outing) both know an owner commit; a chat outing and a
  // real person stay without an intent line.
  const intentNow = ownerIntentOf(s0, session, { tone: row.tone ?? ctx.tone ?? null })
    ?? ownerIntentOf(ctx.before, session, { tone: row.tone ?? ctx.tone ?? null });
  if (intentNow) built.sheet.ownerIntent = intentNow;
  else delete built.sheet.ownerIntent;
  Object.assign(built.sheet, aroundOf(ctx));   // pinned #8: a reused v1 sheet gets today's true lines too
  if (Number(session.minutes) >= LONG_MINUTES) built.sheet.long = true;
  const maxChars = sceneTextCap(session.minutes, Number(config.arcs?.sceneMaxChars ?? 1200));
  const parasMax = sceneParasCap(session.minutes);
  if (built.sheet.long === true) {
    built.sheet.narrationMax = maxChars;
    built.sheet.parasMax = parasMax;
  }
  const heavyWindow = inHeavyWindow(s0, session);
  // A rewrite keeps v1's mind tier; it moves up (never down) when the facts say so now (a
  // first meeting v1 missed).
  const fresh = tierOf(session, s0, { firstMeet: ctx.firstMeet, tone: row.tone ?? null, before: ctx.before });
  const tier0 = codeReason ? 'code'
    : regenOf?.tier === 'mind' && !row.tone ? 'mind' : fresh;
  const register = codeReason ? 'tame' : registerOfSession(s0, session, ctx, built.outcome);
  built.sheet.register = register;
  if (built.sheet.register === 'explicit') delete built.sheet.hisViews;   // plan 020 B: the explicit sheet stays as it was (D2, D3: its renderer leaves them out)
  // Plan 020 D1: the moment its "before" facts hold (the place's words, the owner's intent and what came after are as of writing).
  if (register === 'explicit' || !ctx.fromStart || !ctx.tz) delete built.sheet.asOf;
  else built.sheet.asOf = `${dayLabel(session.startAt, ctx.tz)} ${hhmm(session.startAt, ctx.tz)}`;
  // The explicit register keeps its own path, sheet unchanged.
  delete built.sheet.trace;
  const told = recordFor(fullTrace, { register, outcome: built.outcome, tz: ctx.tz, ownerIntent: !!built.sheet.ownerIntent });
  if (told) {
    built.sheet.trace = { lines: told.lines, ...(told.lateMin ? { lateMin: told.lateMin } : {}), ...(told.drifted ? { drifted: true } : {}) };
    built.names.push(...told.names);
  }
  const castNames = [...(s0.cast instanceof Map ? s0.cast.values() : [])].map(c => c?.name).filter(n => typeof n === 'string');
  let knownNames = null;
  try { knownNames = deps.knownNames(); if (!Array.isArray(knownNames)) knownNames = null; } catch { knownNames = null; }
  const vctx = {
    labels: built.labels, mode: session.mode, outcome: built.outcome, firstMeet: ctx.firstMeet,
    maxChars, parasMax,
    names: [...built.names, ...(ctx.persona.aliases ?? []), ...String(ctx.tone ?? '').split(/\s+/), ...(built.sheet?.planning?.others ?? [])],
    knownNames: knownNames ?? [], castNames, venueNames: venueNamesNow(), negative: ctx.negative,
    register,
  };

  let result = null;
  let reason = codeReason === 'real_person' ? null : codeReason;
  const chain = [];
  const sheetLong = built.sheet.long === true;
  // 020 E3: what a model wrote is checked against this sheet. Never the explicit register; never a code line.
  const grounding = () => deps.claimCheck?.scene(built.sheet, { startAt: session.startAt, endAt: session.endAt, tz: ctx.tz }) ?? null;
  const enforcing = deps.claimCheck?.mode() === 'enforce' && register !== 'explicit';
  const claims = enforcing ? ((text) => deps.claimCheck.enforce(text, grounding(), { speaker: 'narrator', register })) : undefined;
  if (codeReason) { /* no model call */ }
  else if (!knownNames) reason = 'names_unavailable';
  else if (!(Number(config.arcs?.sceneMaxPerDay ?? 8) > 0)) reason = 'off';
  else {
    const user = renderUser(built.sheet);
    if (register === 'explicit') {
      // Desire only. One invented-name retry, then the tame one-liner. Never the clerk, never Opus.
      const tier = tier0 === 'mind' ? 'mind' : 'clerk';
      const g = await gate(tier, at, ctx.tz, session.mode);
      if (g) reason = g;
      else {
        const w = await writeTier(tier, user, vctx, row.id, { explicit: true, long: sheetLong });
        chain.push(...w.codes);
        if (w.ok) result = { ...w.result, tier };
        else reason = w.reason;
      }
    } else {
      const tiers = tier0 === 'mind' ? ['mind', 'clerk'] : ['clerk'];
      for (const tier of tiers) {
        const g = await gate(tier, at, ctx.tz, session.mode);
        if (g) { reason = g; continue; }
        const w = await writeTier(tier, user, vctx, row.id, { long: sheetLong, claims });
        chain.push(...w.codes);
        if (w.ok) { result = { ...w.result, tier }; break; }
        reason = w.reason;
      }
    }
  }
  const attemptReason = chain.length ? chain.join(',').slice(0, 96) : null;

  // A failed REGENERATE keeps the old version live: nothing is appended (plan §P2.4).
  if (regenOf && !result) return skip(attemptReason ?? reason ?? 'model_failed');
  const place = placeWords(s0, session);
  const selfOnly = session.mode === 'self_only';
  const fallbackText = selfOnly
    ? selfOnlyScene(session, built.outcome, { place, weather: ctx.weather, vitals: ctx.vitals })
    : oneLiner(session, built.outcome, { names: ctx.names, place });
  const out = result ? result.value : {
    narration: fallbackText, impressions: null, topics: [], highlight: null, awkward: null, chemistry: null,
    focus: null, ending: 'nothing', effects: [],
  };
  try {
    const res = await commit({
      row, session, out, built, ctx, regenOf, by, heavyWindow,
      tier: result ? result.tier : 'code', model: result?.model ?? null, fellBack: result?.fellBack === true,
      caller: result?.caller ?? undefined, reason: result ? null : (attemptReason ?? reason), intended: selfOnly,
      heat: result ? heatOf({ text: out.narration, register, tone: null }) : 'tame',
    });
    log({ status: res.status, tier: result ? result.tier : 'code', skip: result ? attemptReason : (attemptReason ?? reason), sceneId: row.id, ms: Date.now() - started, regen: !!regenOf });
    if (result && register !== 'explicit') {
      deps.claimCheck?.submit({ writer: 'scene', rowId: row.id, eventId: res.eventId, grounding: result.check ? null : grounding(), speaker: 'narrator',
        chatOrigin: session.mode !== 'full', register, result: result.check, rewrote: result.rewrote === true });
    }
    return { ...res, sceneId: row.id, reason: result ? null : reason };
  } catch (err) {
    try { deps.rebuild(); } catch { /* the next tick re-reads */ }
    void err;
    return skip('append');
  }
}

// The roll a later version reuses (R16): v1's outcome, firstMeet and castIds from its
// scene.played payload (the log keeps them after a revert NULLs the row), and its sheet.
function rollOf(old) {
  let p = null;
  try { p = posInt(old.eventId) ? getEvent(old.eventId)?.payload ?? null : null; } catch { p = null; }
  const first = store.versionsOf(old.activityEventId).at(-1) ?? old;
  return {
    outcome: p?.outcome ?? old.detail?.outcome ?? null,
    outcomeBy: p?.outcomeBy ?? old.detail?.outcomeBy ?? 'code',
    firstMeet: Array.isArray(p?.firstMeet) ? p.firstMeet : Array.isArray(old.detail?.firstMeet) ? old.detail.firstMeet : null,
    sheet: isObj(first?.sheet) ? first.sheet : isObj(old.sheet) ? old.sheet : null,
  };
}

function underLocks(fn) {
  const inner = () => withDecisionLock(fn);
  return typeof deps.pulse?.exclusive === 'function' ? deps.pulse.exclusive(inner) : inner();
}

// Today's scene deltas per member (closeness / trust, abs sums) from the live log.
function todaySceneDeltas(s, at, tz) {
  const out = {};
  try {
    for (const e of listEvents({ types: ['relationship.changed'], from: dayStart(at, tz), to: at + 1, limit: 500 })) {
      if (e.redacted || e.payload?.reason !== 'scene' || isExcludedId(s, e.id)) continue;
      const m = (out[e.payload.castId] ??= { closeness: 0, trust: 0 });
      for (const k of ['closeness', 'trust']) if (finite(e.payload.delta?.[k])) m[k] += Math.abs(e.payload.delta[k]);
    }
  } catch { return null; }
  return out;
}

// The newest scene-caused onset in the raw log (a rewind can't launder it), except one a
// regenerate of this same outing undid as an unlived companion (plan §P2.1).
function lastSceneOnsetAt(s, activityEventId) {
  try {
    const evs = listEvents({ types: ['arc.started'], order: 'desc', limit: 200 });
    return evs.find(e => e.payload?.reason === 'scene' && !(isExcludedId(s, e.id)
      && getEvent(e.payload?.sceneEventId)?.payload?.activityEventId === activityEventId))?.at ?? null;
  } catch { return Infinity; }
}

/**
 * D15 / R17 / R26 (plan §P1.10): revert the unlived companions of scenes that left the
 * log (a revert, a regenerate, an ancestor's cascade, a rewind) and lapse a follow-up
 * whose decision the owner reverted; lived ones are kept. Synchronous, one transaction
 * (nested → a savepoint), then a rebuild. Callers: the owner-revert hook, the regenerate
 * commit and every scenes job. → { reverted, lapsed, kept }
 */
export function settleCompanions() {
  const s = deps.getState();
  if (!isObj(s) || typeof deps.append !== 'function') return { reverted: 0, lapsed: 0, kept: 0 };
  const t = nowSec();
  const plan = companionsToUndo(s, { eventOf: getEvent, childrenOf: childEvents, now: t });
  if (!plan.revert.length && !plan.lapse.length) return { reverted: 0, lapsed: 0, kept: plan.kept.length };
  const at = Math.max(t, Number.isSafeInteger(s.at) ? s.at : 0);
  store.inTransaction(() => {
    for (const id of plan.revert) logRevert(id, { reason: 'scene_gone', by: 'engine', at });
    for (const fid of plan.lapse) {
      deps.append({ type: 'scene.followup_lapsed', at, actor: 'engine', causeId: fid,
        payload: { followupId: fid, castId: s.story.followups?.[fid]?.castId ?? null, reason: 'reverted' } });
    }
  });
  try { deps.rebuild(); } catch { /* the next tick re-reads */ }
  log({ status: 'companions', skip: `r${plan.revert.length}:l${plan.lapse.length}:k${plan.kept.length}` });
  return { reverted: plan.revert.length, lapsed: plan.lapse.length, kept: plan.kept.length };
}

// Plans a scene made (2026-11-05): after its commit, so a plan that fails never undoes the story.
export const PLANS_MAX_AGE_HOURS = 6;
async function commit(args) {
  const res = await commitScene(args);
  const { out, session, tier, ctx } = args;
  if (out?.plans?.length && tier !== 'code' && Number.isSafeInteger(res?.eventId) && typeof deps.planFromScene === 'function'
    && nowSec() - session.endAt <= PLANS_MAX_AGE_HOURS * HOUR) {
    try {
      if (!effectsBlocked(deps.getState(), session)) await deps.planFromScene({ sceneEventId: res.eventId, session, plans: out.plans, tz: ctx.tz });
    } catch { log({ status: 'plans', skip: 'error' }); }
  }
  return res;
}

async function commitScene({ row, session, out, built, ctx, regenOf, by, tier, model, fellBack, caller, reason, heavyWindow = false, intended = false, heat = null }) {
  const fallback = tier === 'code' && !intended;   // a real person's code scene is the intended result, not a degrade
  return underLocks(() => {
    let reverted = false;
    const res = store.inTransaction(() => {
      let s = deps.getState();
      const again = sessionFor(row, s);
      if (!again.session) throw Object.assign(new Error('gone'), { code: 'gone' });
      const live = s.story?.scenes?.[session.activityEventId];
      const at = Math.max(nowSec(), Number.isSafeInteger(s.at) ? s.at : 0);
      if (regenOf && live) {
        if (live.eventId !== regenOf.eventId) throw Object.assign(new Error('moved'), { code: 'moved' });
        deps.append({ type: 'scene.regenerated', at, actor: 'owner', payload: { activityEventId: session.activityEventId, fromEventId: regenOf.eventId } });
        logRevert(regenOf.eventId, { reason: 'scene_regenerated', by: String(by || 'owner').slice(0, 40), at });
        reverted = true;
        deps.rebuild();
        // v1's unlived companions go (a lived follow-up or a moved arc stays), then re-read:
        // v2's effects are planned on a state without v1's (R16).
        settleCompanions();
        s = deps.getState();
      } else if (regenOf) {
        // A reverted scene (R32): no live version to replace — just the owner's record and v+1.
        if (posInt(regenOf.eventId) && !isExcludedId(s, regenOf.eventId)) throw Object.assign(new Error('moved'), { code: 'moved' });
        deps.append({ type: 'scene.regenerated', at, actor: 'owner', payload: { activityEventId: session.activityEventId, fromEventId: regenOf.eventId } });
      } else if (live) {
        throw Object.assign(new Error('exists'), { code: 'exists' });
      }
      // The outing went on after an earlier start's scene was written: this one tells all of it, so that one goes, with what it did.
      const prior = regenOf ? null : priorLiveScene(s, session.activityEventId);
      if (prior) {
        logRevert(prior.eventId, { reason: 'scene_resumed', by: 'engine', at });
        reverted = true;
        deps.rebuild();
        settleCompanions();
        s = deps.getState();
      }
      const text = out.narration;
      const played = deps.append({
        type: 'scene.played', at, actor: 'engine', causeId: session.activityEventId,
        ...(session.realJid ? { subjectJid: session.realJid } : {}),
        payload: {
          sceneId: row.id, version: row.version, activityEventId: session.activityEventId,
          startAt: session.startAt, endedAt: session.endAt, kind: session.kind,
          decisionId: session.decisionId ?? null, placeId: session.placeId ?? null,
          castIds: session.mode === 'self_only' ? [] : session.castIds, mode: session.mode, tier,
          outcome: built.outcome, outcomeBy: built.outcomeBy, ending: out.ending,
          chemistry: session.mode === 'self_only' ? null : (finite(out.chemistry) ? out.chemistry : null),
          firstMeet: session.mode === 'full' ? ctx.firstMeet : [], fallback,
          regenOf: regenOf?.eventId ?? prior?.eventId ?? null, heavyWindow: heavyWindow === true,
          ...(heat === 'tame' || heat === 'suggestive' || heat === 'explicit' ? { heat } : {}),
          textSha: sha(text),
        },
      });
      // Phase 2 effects: a code one-liner has none; a fell-back mind run is limited to the clerk tier's caps.
      let effects = [];
      if (tier !== 'code' && !effectsBlocked(s, session)) {
        const today = todaySceneDeltas(s, at, ctx.tz);
        if (today) {
          effects = planEffects(s, session, out, {
            tier: fellBack ? 'clerk' : tier, fellBack, at, tz: ctx.tz, seed: deps.seed(),
            todayScene: today, outcomeHappened: s.story?.outcomes?.[session.decisionId]?.status === 'done',
            lastOnsetAt: lastSceneOnsetAt(s, session.activityEventId),
          });
        }
      }
      // Relationship deltas are caused by the scene (they cascade with it); the follow-up and
      // the romance onset are uncaused companions naming it (D15): a revert of the scene or of
      // anything above it never cascades into an outing he went on — companionsToUndo decides.
      const appended = [];
      for (const e of effects) {
        appended.push(e.type === 'relationship.changed'
          ? deps.append({ ...e, at, actor: 'engine', causeId: played.id })
          : deps.append({ ...e, at, actor: 'engine', payload: { ...e.payload, sceneEventId: played.id } }));
      }
      store.update(row.id, {
        status: fallback ? 'fallback' : 'done', eventId: played.id, tier, mode: session.mode, text,
        // The hint this version was written with (the Director's or the REGENERATE's) and its outcome word.
        tone: ctx.tone ?? null, toneOutcome: ctx.tone && OUTCOMES.includes(ctx.toneOutcome) ? ctx.toneOutcome : null,
        heavyWindow: heavyWindow === true,
        ...(!regenOf && session.mode !== 'self_only' && isObj(built.sheet)
          && Buffer.byteLength(JSON.stringify(built.sheet), 'utf8') <= store.SHEET_MAX_BYTES ? { sheet: built.sheet } : {}),
        detail: {
          impressions: out.impressions, topics: out.topics ?? [], highlight: out.highlight ?? null, awkward: out.awkward ?? null,
          chemistry: out.chemistry ?? null, ending: out.ending, outcome: built.outcome, outcomeBy: built.outcomeBy,
          focus: out.focus ?? null, effects: effects.map(e => ({ type: e.type, castId: e.payload.castId ?? e.payload.castIds?.[0] ?? null, delta: e.payload.delta ?? null })),
          firstMeet: ctx.firstMeet, heavyWindow: heavyWindow === true,
        },
        model, fellBack, caller, skipReason: reason, finishedAt: at,
        originKind: played.originKind, originJid: played.originJid, subjectJid: played.subjectJid ?? null,
      });
      if (regenOf && store.LIVE_STATUSES.includes(regenOf.status)) store.update(regenOf.id, { status: 'superseded' });
      if (prior) store.update(prior.id, { status: 'superseded' });
      return { status: fallback ? 'fallback' : 'done', eventId: played.id, effects: effects.length };
    });
    if (reverted) { try { deps.rebuild(); } catch { /* the next tick re-reads */ } }
    return res;
  });
}

/** ≤ PER_TICK pending rows, oldest first (the afterTick job). → results */
export async function processPending(limit = PER_TICK) {
  const out = [];
  for (const row of store.listPending(limit)) {
    // A regenerate runs inside its own request. A later version with nothing below it on this start is a resumed outing's (priorLiveScene).
    if (row.version > 1 && store.versionsOf(row.activityEventId).some(v => v.version < row.version)) continue;
    out.push(await runScene(row));
  }
  return out;
}

/**
 * The owner's REGENERATE (plan §P2.4): the live row `sceneId` → version+1 with an
 * optional cleaned tone. Failure keeps the old version live (nothing appended).
 * → { status, reason?, sceneId (the new row), eventId? }
 */
export async function regenerate(sceneId, { tone = null, outcome = null, by = 'owner' } = {}) {
  const old = store.getScene(sceneId);
  if (!old || !posInt(old.eventId)) return { status: 'refused', reason: 'not_live' };
  if (old.mode === 'self_only') return { status: 'refused', reason: 'real_person' };
  const s = deps.getState();
  if (!isObj(s)) return { status: 'refused', reason: 'not_live' };
  const liveNow = s.story?.scenes?.[old.activityEventId];
  if (store.LIVE_STATUSES.includes(old.status)) {
    if (liveNow?.eventId !== old.eventId) return { status: 'refused', reason: 'not_live' };
  } else if (old.status === 'reverted' && liveNow?.eventId === old.eventId) {
    // Its scene.played came back into the log (a narrower revert cascade, 2026-11-02) but the
    // sweep had already dropped its words: rewrite it like a live one (the old event is replaced).
  } else if (old.status === 'reverted') {
    // R32: a reverted scene may be rewritten while its outing is still in his day and no
    // other version is live (a scene whose outing went is final).
    if (liveNow || !sessionFor(old, s).session) return { status: 'refused', reason: 'not_live' };
    const newer = store.versionsOf(old.activityEventId)[0];
    if (newer && newer.id !== old.id && newer.status !== 'skipped') return { status: 'refused', reason: 'not_live' };
  } else {
    return { status: 'refused', reason: 'not_live' };
  }
  const tz = tzOf(s);
  if (store.countRegensSince(dayStart(nowSec(), tz)) >= Number(config.arcs?.sceneRegenMaxPerDay ?? 6)) return { status: 'refused', reason: 'regen_cap' };
  const top = store.versionsOf(old.activityEventId)[0];
  const id = store.insertPending({
    activityEventId: old.activityEventId, version: (top?.version ?? old.version) + 1, endedAt: old.endedAt,
    originKind: old.originKind, originJid: old.originJid, subjectJid: old.subjectJid, tone,
    toneOutcome: tone && OUTCOMES.includes(outcome) ? outcome : null, mode: old.mode, createdAt: nowSec(),
  });
  if (!id) return { status: 'refused', reason: 'busy' };
  const row = store.getScene(id);
  const res = await runScene(row, { regenOf: old, by });
  return { ...res, sceneId: id };
}
