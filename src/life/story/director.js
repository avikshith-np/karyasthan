// The Director (spec 010 US3, research R12, contracts/director-api.md §3–§4):
// the owner steers his life through a closed catalogue of actions, always
// previewed first. Every action is planned in code into event descriptors; the
// preview shows them with a before/after diff, warnings and refusals; apply
// re-plans against the live projection with the PREVIEW's clock and appends
// exactly what the preview listed, or answers `stale`.
//
//   plan(action, state, ctx)   pure planning (it may READ the log and the story
//                              tables, never writes) → { events, warnings,
//                              refusals, slices, extra, diff, before, after }
//   preview(action, opts)      plan + fingerprint, cached in memory (≤ 20, TTL
//                              10 min) under a previewId
//   apply(previewId, fingerprint, {by})   re-plan at previewAt, compare, append
//   sceneDraftFromReview(id)   a `scene` action draft from a tray claim:
//                              structured ids only, never claim/extraction text
//   appendDescriptors(list, append, {fingerprint})   the batch appender (the
//                              facade's appendOwnerBatch may delegate to it)
//
// Descriptor (what the preview lists and apply appends, in order):
//   { ref:'$n', type, actor:'owner'|'engine'|'mind', at, payload,
//     causeRef?:'$m' | causeId?:<real id>, payloadRefs?:{ key: '$m' | ['$m', …] },
//     heavy?, subjectJid? }
// Owner events of one apply are caused by its `director.action`; engine
// consequences by the owner event they follow (self by R3). Exception: a tray
// adoption and an outing/visit scene opened from a claim — their engine events
// are caused by the claim's `claim.flagged` pointer (so they keep the chat
// origin), and the `director.action`, appended after them, lists their ids.
//
// Fingerprint = sha256(canonical JSON of {action, events, diff, materialId});
// materialId = the newest event id whose type is not ROUTINE (phone checks), so
// a phone check between preview and apply does not make it stale. Vitals are
// left out of the fingerprint's diff: they drift with the clock (a phone check
// integrates them) while the events already say what the action does to them.
//
// Errors: StoryError {code, reason} with code ∈ not_running | not_found |
// stale | invalid | refused | expired | conflict | rate. The reason is the
// route's error word (director-api §3/§4): invalid ← forbidden_theme |
// jid_in_text | real_person_name | too_long | bad_* ; refused ← heavy_cap |
// heavy_precondition | heavy_active | frozen | pinned | full | out_of_scope |
// cap | conflict | nothing | unsupported ; expired ← expired_preview.
//
// Logging: ids, kinds, counts and the fingerprint — never scene text.

import crypto from 'crypto';
import { config, getPersona } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { sanitizeWebContent } from '../../brain/webSearch.js';
import { now as clockNow, dateKey, dayStart, addDays, resolveTimezone, zonedToUnix, hhmm as clockHhmm } from '../clock.js';
import { WINDOW_SKIES, windowAt, windowOutcome, weatherFor } from '../weather.js';
import { project, isExcludedId, advanceTo } from '../projector.js';
import { getEvent, listEvents, lastEventId, lastHeavyAt as lastHeavyAtDefault, cascadeIds } from '../eventLog.js';
import { realPeopleNames, castNameCollisions, textNameCollisions, normalizeName } from '../world.js';
import * as store from './store.js';
import { getDb as getDbSync } from '../../memory/db.js';
import {
  CATEGORIES, FATE_MODES, SLIDERS, RECONCILER_MODES, ROMANCE_STAGES, ROUTINE_TYPES, SEED_PATHS,
  cleanSeedValue, isPinKey, worldOverlay,
  CAREER_REASONS, OUTCOMES, DEPART_HOW, PLAN_REASONS, heavyGuardActive,   // 015
} from './reducer.js';
import { wakeFor } from '../pulse.js';   // wake him
import { WAKE_REASONS } from '../projector.js';
import { check as controlsCheck, pinKeysFor, categoryOf, fateOf, isPaused, pinOf } from './controls.js';
import { registerOf, outsidePartner, urgeNow } from './desire.js';
import { ownerHeavyPlan } from './heavy.js';
import { planRewind, applyRewind } from './rewind.js';
import { labelFor as reconcilerLabelFor, fit as reconcilerFit, fitSpan as reconcilerFitSpan } from './reconciler.js';
import { previewTomorrow as simulateTomorrow } from './tomorrow.js';
import { outingDecisionPayload, OutingError, amendedPlanEventId, cancelDecisionEvents, earliestStart } from './outing.js';
import { fitToday as goalFitToday, activeGoals } from './goals.js';
// 014 geo: real places (place search → new place / move+rename, make places real, routes).
import {
  GEO_ACTION_KINDS, GEO_PROMPT_KINDS, planPlaceReal, planRealify, planRoutesRefresh, resolveGeoAction,
  venuePlace as venuePlaceDefault,
} from './placesDirector.js';
import { negativeAtVenue, mentionsVenue, isRealVenue as isVenue, isVenueLike } from '../places.js';
import * as planEdits from '../planEdits.js';   // 014 sched
import { goingTo, neverRethought, planWeight, WEIGHT } from '../planWeight.js';   // 020
import { planDay, routineOf } from '../routine.js';   // 014 sched
import { simulate as simulateSched, planRows } from './tomorrow.js';   // 014 sched
// 015 Director as god
import { availableOptions, withDecisionLock } from '../decisions.js';
import { isChatDecision, careerDecisions, careerConsequences, replanFor } from './pending.js';
// 015 cont: continuity checker, bundles, retcon, the re-projected preview.
import { EVENT_TYPES as LOG_EVENT_TYPES } from '../eventLog.js';
import { isRewindKept } from './reducer.js';
import { checkContinuity, plannerSuggestions, codesAtLeast, cleanWarning } from './continuity.js';
import { buildProjection, PROJECT_KINDS } from './projection.js';

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

export const PREVIEW_TTL_SEC = 600;
export const PREVIEW_MAX = 20;
export const QUICK_BUTTONS = Object.freeze(['tired', 'energised', 'free_evening', 'cancel_tonight', 'rain', 'sick_day',
  'bad_day_at_work', 'good_day_at_work']);
export const SCENE_SHAPES = Object.freeze(['outing', 'visit', 'cast.beat', 'cast.history', 'new_cast', 'new_place',
  'arc.start', 'arc.stage', 'heavy']);
export const ACTION_KINDS = Object.freeze(['quick', 'fate', 'slider', 'pin', 'unpin', 'pause', 'resume', 'rewind',
  'bookmark', 'bookmark.remove', 'scene', 'cast.edit', 'cast.history', 'place.edit', 'seed.set', 'reconciler.mode',
  'tray.adopt', 'heavy.end', 'proposal.approve',
  // 011 Phase 2: owner weather windows and soft goals.
  'weather', 'weather.end', 'goal', 'goal.cancel',
  // Earned trust (2026-10-30): the owner sets a member's closeness / trust / tension.
  'cast.metrics',
  // 014 geo: real places.
  ...GEO_ACTION_KINDS,
  // 014 sched: schedule edits (a day off, WFH / office, stretches at home / out, sleep in, …).
  'schedule', 'schedule.clear',
  // 015 Director as god (plan §P1.8): the opened powers.
  'decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return',
  // 015 cont: several actions in one apply; rewind + new actions in one apply.
  'bundle', 'retcon',
  // 016: how an outing should go (a hint for its scene play-out).
  'scene.tone',
  // Wake him ("can't sleep"): up at a time tonight, back to sleep after.
  'wake',
  // 019 his phone: he texts a member of his cast.
  'text']);
/** Closed arc kinds an owner may start, per category (heavy has its own scene). */
export const ARC_KINDS = Object.freeze({
  romance: ['romance'], career: ['hunt'], family: ['occasion', 'major'], cast: ['friendship'], health: ['fitness'],
  social: ['social'],
});
export const VISIBLE_EVERYWHERE = 'visible in every chat';
export const FROM_CLAIM = 'built from a DM/group claim';
// True per case (020): he tells them only when the path that sends it would really run.
export const CHAT_PLAN = 'cancels a plan made in a chat (nobody is told)';
export const CHAT_PLAN_TOLD = 'cancels a plan made in a chat (he tells them there)';
export const CHAT_PLAN_KEPT = 'keeps a plan made in a chat';
export const GOAL_PLAN = 'also cancels the goal it was planned for';

// Spec 011 (Director prompt): the kinds and scene shapes a model may PROPOSE as
// drafts. Destructive, privacy/control and heavy kinds are left out (rewind,
// bookmark.remove, reconciler.mode, tray.adopt, proposal.approve, heavy.end, the
// heavy scene): those stay hand-built on their own panels.
export const PROMPT_ACTION_KINDS = Object.freeze(['quick', 'fate', 'slider', 'pin', 'unpin', 'pause', 'resume', 'bookmark',
  'scene', 'cast.edit', 'cast.history', 'place.edit', 'seed.set', 'weather', 'weather.end', 'goal', 'goal.cancel', 'cast.metrics',
  // 014 geo: a venue the owner picked from a lookup.
  ...GEO_PROMPT_KINDS,
  'schedule', 'schedule.clear',   // 014 sched
  // 015 (plan §P1.9): the opened powers a model may draft — never batchable (god_change).
  'decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health', 'arc.end', 'cast.depart', 'cast.return',
  // 016: a tone hint for an outing's scene (free text → never batchable).
  'scene.tone',
  // Wake him ("he can't sleep…"): never batchable (target_resolved).
  'wake',
  // 019: he texts a member of his cast (the words are his; free text → never batchable).
  'text']);
export const PROMPT_SCENE_SHAPES = Object.freeze(['outing', 'visit', 'cast.beat', 'cast.history', 'new_cast', 'new_place',
  'arc.start', 'arc.stage']);
export const WHEN_DAYS_MAX = 60;
export const IN_MINUTES_MIN = 10;
// 011 Phase 2 bounds (code constants, plan §P2): weather windows ≤ 72 h ahead and
// 30 min … 72 h long, ≤ 8 not yet ended; goals ≤ 14 days, ≤ 5 open.
export const WEATHER_KINDS = WINDOW_SKIES;
export const WEATHER_AHEAD_SEC = 72 * 3600;
export const WEATHER_MIN_SEC = 30 * 60;
export const WEATHER_WINDOWS_MAX = 8;
export const GOAL_KINDS = Object.freeze(['meet', 'call', 'outing', 'errand']);
export const GOAL_DAYS_MAX = 13;            // fromDay / toDay 0..13 (a 14-day window)
export const GOAL_OPEN_MAX = 5;
export const GOAL_MINUTES = Object.freeze({ meet: 120, outing: 120, errand: 45, call: 20 });
// cast.metrics: absolute targets 0..1 (two decimals); the change is split into
// equal relationship.changed steps of ≤ METRIC_STEP each (the reducer's per-event
// clamp), so one apply reaches the target exactly and no single event moves a
// metric further than any engine event may.
export const METRIC_FIELDS = Object.freeze(['closeness', 'trust', 'tension']);
// 015 (plan §P1.6): the romance numbers too (story.relationships, the same stepped events).
export const REL_METRIC_FIELDS = Object.freeze(['intimacy', 'passion', 'commitment']);
export const METRIC_STEP = 0.2;

const TEXT_CAPS = { label: 80, beat: 120, history: 160, name: 60, castName: 40, reason: 200, bookmark: 60 };
const CAST_FIELDS = { status: 160, availability: 160, job: 60, employer: 80, personality: 200, speech: 160, pronouns: 24, hometown: 80 };
const CAST_RELATIONS_RE = /^(friend|acquaintance|neighbour|coworker|flatmate|manager|family:[a-z]{2,20})$/;   // 015: + flatmate, manager
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_SLUG_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const JID_IN_TEXT_RE = /[0-9A-Za-z._:+-]{3,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)|@\d{5,}|\+?\d[\d\s-]{8,}\d/i;
const BEAT_KINDS = new Set(['status', 'away', 'back', 'hobby', 'news', 'milestone', 'trip']);
const NUDGE = {
  tired: { energy: -25 },
  energised: { energy: 20, valence: 0.15 },
  bad_day_at_work: { stress: 15, valence: -0.2 },
  good_day_at_work: { stress: -15, valence: 0.2, workPressure: -15 },
};
const EVENING_OPTIONS = ['go', 'late', 'stay'];
const MAX_CAST = 24;
const MAX_PLACES = 48;
const MAX_BOOKMARKS = 30;
const FUTURE_ADOPTIONS_MAX = 24;
const REGION_MARGIN_KM = 10;
const ADOPTABLE = new Set(['plan', 'commitment', 'activity']);
const DIFF_MAX = 100;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

/** The story's error (routes map code → 400/404/409). */
export class StoryError extends Error {
  constructor(code, reason = null, extra = {}) {
    super(`story: ${code}${reason ? ` (${reason})` : ''}`);
    this.name = 'StoryError';
    this.code = code;
    this.reason = reason;
    Object.assign(this, extra);
  }
}
const err = (code, reason, extra) => new StoryError(code, reason, extra);

// ── Deps (test seam; the story facade passes the live ones at attach) ─────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  getState: () => null,          // the live projection (not a view)
  world: null,                   // the loaded world (base; the overlay is applied here)
  append: null,                  // the facade's appender (append + fold + embargo follow-up)
  pulse: null,                   // { rebase() } after a rewind
  seed: () => null,              // the effective arc seed
  knownNames: () => { try { return realPeopleNames(); } catch { return []; } },
  lastHeavyAt: () => lastHeavyAtDefault(),
  labelFor: (resolution, state) => reconcilerLabelFor(resolution, state),
  // The calendar fit of a tray adoption: the span widened to departure, then the
  // reconciler's fit → null when it fits, {with:{…}} on a conflict.
  fit: (span, state, world, o = {}) => reconcilerFit(reconcilerFitSpan(span, o.type, o.placeId, state, world, o.now), state, world),
  proposalDescriptors: null,     // weekly: (proposal, state, ctx) → {events, warnings, refusals}
  setClaimStatus: null,          // (claimId, status, by) → void; default: life_claims UPDATE
  countSelfReplies: null,        // (sinceAt) → number (rewind preview)
  storyItems: null,              // (s, g, {sim}) → items, for preview tomorrow
  worldOf: null,                 // 014 geo: (state) → the overlaid world (the facade's memoised story.worldOf)
  atWake: null,                  // 015: (s, at, add) → the owner's planned wake nudges, for preview tomorrow
  blockCause: null,              // the pulse seams the story installs (preview tomorrow)
  planCause: null,
  chatName: null,                // (chatJid) → name (rewind preview)
  onApplyFailed: null,           // () → void: the facade rebuilds its projection after a rolled-back apply
  // 014 geo: the facade's geo service ({candidates, results, fetchRoutes}; null → geo_off),
  // sched's venue seam (pure, reads ctx.resolved) and every venue name ever recorded.
  geo: null,
  venuePlace: (candidateId, ctx) => venuePlaceDefault(candidateId, ctx),
  venueNames: () => [],
  // 019: the owner's verbatim first text → { ok, text } | { ok:false, reason } (the story facade wires
  // the phone validator; null → a `words` action is refused words_unavailable).
  phoneWords: null,
  logger,
};
let deps = { ...DEFAULT_DEPS };
const cache = new Map();         // previewId → { action, previewAt, fingerprint, expiresAt }

/** Production seam (the story facade at attach): merge the live deps. */
export function configure(over = {}) {
  if (isObj(over)) deps = { ...deps, ...over };
}

/** Test/assemble seam: merge deps (null restores the defaults and clears the preview cache). */
export function __setDepsForTest(over) {
  if (over === null) { deps = { ...DEFAULT_DEPS }; cache.clear(); return; }
  deps = { ...deps, ...(isObj(over) ? over : {}) };
}

function liveState() {
  const s = deps.getState?.();
  if (!s || !isObj(s) || s.genesisAt === null || s.genesisAt === undefined) throw err('not_running');
  if (s.view) throw err('not_running', 'view');
  return s;
}

function cfg() {
  const a = config.arcs || {};
  return {
    rewindDays: Number.isFinite(a.rewindDays) ? a.rewindDays : 14,
    bigLeadHours: Number.isFinite(a.bigLeadHours) ? a.bigLeadHours : 24,
    heavyMinGapDays: Math.max(90, Number.isFinite(a.heavyMinGapDays) ? a.heavyMinGapDays : 90),
    castMax: Math.min(MAX_CAST, Number.isFinite(a.castMax) ? a.castMax : MAX_CAST),
    bookmarksMax: Math.min(MAX_BOOKMARKS, Number.isFinite(a.bookmarksMax) ? a.bookmarksMax : MAX_BOOKMARKS),
  };
}

// 014 geo (plan §A0): the facade's memoised story.worldOf when wired, else the
// overlay itself (projected places + career) — never the bare file world.
function worldFor(state, world) {
  if (typeof deps.worldOf === 'function') {
    try { const w = deps.worldOf(state); if (isObj(w)) return w; } catch { /* the overlay below */ }
  }
  return worldOverlay(state, world);
}

function ctxFor(state, now, { knownNames: givenNames = null } = {}) {
  const world = deps.world ?? null;
  const tz = resolveTimezone(state?.world?.timezone ?? world?.timezone ?? config.timezone);
  // An explicit list (the prompt's dry plans, read fail-closed there) wins over the dep.
  let knownNames = Array.isArray(givenNames) ? givenNames : [];
  if (!Array.isArray(givenNames)) {
    try { knownNames = deps.knownNames() || []; } catch { knownNames = []; }
  }
  let seed = null;
  try { seed = deps.seed() ?? null; } catch { seed = null; }
  return {
    state, now, tz, world: world ? worldFor(state, world) : null, baseWorld: world, cfg: cfg(), knownNames, seed,
    worldOf: (s) => (world ? worldFor(s, world) : null),
    lastHeavyAt: () => { try { return deps.lastHeavyAt(); } catch { return null; } },
    relax: false,   // 015: true only for a hand-built owner preview (plan §1.4)
  };
}

// ── Text and reference validation (§4) ────────────────────────────────────

/** Cap BEFORE sanitizing (oversize → 400), sanitize, one line, strip `>>>`, refuse JIDs and real names. */
export function cleanOwnerText(v, max, ctx, { required = true, field = 'text' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw err('invalid', `bad_${field}`);
    return null;
  }
  if (typeof v !== 'string') throw err('invalid', `bad_${field}`);
  if (v.length > max) throw err('invalid', 'too_long', { field });
  if (JID_IN_TEXT_RE.test(v)) throw err('invalid', 'jid_in_text', { field });
  const s = sanitizeWebContent(v).replace(/>{3,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!s) {
    if (required) throw err('invalid', `bad_${field}`);
    return null;
  }
  if (JID_IN_TEXT_RE.test(s)) throw err('invalid', 'jid_in_text', { field });
  if (textNameCollisions({ places: [{ name: s }] }, ctx.knownNames).length) throw err('invalid', 'real_person_name', { field });
  // 014 geo (§A7): never a bad thing at a named real business.
  if (negativeAtVenue(s, venueNamesSafe())) throw err('invalid', 'negative_at_venue', { field });
  return s;
}

// 014 geo: every venue name ever recorded (fail closed: a read error → refuse nothing
// here, the render-time scrub still words them by kind).
function venueNamesSafe() {
  try { const v = deps.venueNames?.(); return Array.isArray(v) ? v : []; } catch { return []; }
}

function castRef(state, id) {
  if (typeof id !== 'string' || !CAST_ID_RE.test(id) || !(state.cast instanceof Map) || !state.cast.has(id)) {
    throw err('not_found', 'cast');
  }
  return id;
}

function placeRef(state, id) {
  if (typeof id !== 'string' || !PLACE_ID_RE.test(id) || !(state.places instanceof Map) || !state.places.has(id)) {
    throw err('not_found', 'place');
  }
  return id;
}

function startTime(v, ctx) {
  const t = posInt(v);
  if (!t || t < ctx.now - 60) throw err('invalid', 'bad_startAt');
  if (t > ctx.now + 60 * DAY) throw err('invalid', 'bad_startAt');
  return t;
}

function minutesOf(v, lo = 15, hi = 360) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw err('invalid', 'bad_minutes');
  return v;
}

function slugify(s) {
  return String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'x';
}

function freeId(prefix, base, taken) {
  let id = `${prefix}:${base}`;
  for (let i = 2; taken.has(id) && i < 100; i++) id = `${prefix}:${base}-${i}`;
  return id;
}

// ── Batch building ────────────────────────────────────────────────────────

function makeBatch() {
  const events = [];
  const warnings = [];
  const refusals = [];
  const continuity = [];   // 015: [{code, severity, refs?}] (P2's checker merges into it)
  let n = 0;
  const add = (d) => {
    const ref = `$${++n}`;
    events.push({ ref, ...d });
    return ref;
  };
  return { events, warnings, refusals, continuity, add };
}

function ownerParent(b, action, now) {
  return b.add({ type: 'director.action', actor: 'owner', at: now, payload: { kind: action.kind, previewAt: now, count: 0 } });
}

function finishParent(b, parentRef, { eventRefs = null } = {}) {
  const parent = b.events.find(e => e.ref === parentRef);
  if (!parent) return;
  parent.payload.count = b.events.length - 1;
  if (eventRefs) parent.payloadRefs = { ...(parent.payloadRefs || {}), eventIds: eventRefs };
}

function refuse(b, part) {
  b.refusals.push({ reason: part.reason, target: part.target ?? null, ...(part.pinKey ? { pinKey: part.pinKey } : {}) });
}

// 014 geo: the helpers placesDirector.js planners use (no import cycle).
const GEO_HELPERS = Object.freeze({
  err: (code, reason, extra) => err(code, reason, extra),
  refuse: (b, part) => refuse(b, part),
  ownerParent: (b, action, now) => ownerParent(b, action, now),
  finishParent: (b, parentRef, o) => finishParent(b, parentRef, o),
  placeRef: (state, id) => placeRef(state, id),
  VISIBLE_EVERYWHERE,
});

// ── Action planners ───────────────────────────────────────────────────────

function openDecisionsWhere(state, fn) {
  const out = [];
  for (const d of state.decisions instanceof Map ? state.decisions.values() : []) if (d?.status === 'open' && fn(d)) out.push(d);
  return out.sort((a, b) => a.id - b.id);
}

function decisionPinKeys(d, state) {
  return pinKeysFor({ type: 'decision.opened', payload: { category: d.category, kind: d.kind, subject: d.subject, arcId: d.arcId } }, state);
}

function isArcDecision(d) {
  return typeof d?.category === 'string' && d.category !== '' && d.adopted !== true;
}

function planQuick(action, ctx, b) {
  const { state, now, tz } = ctx;
  const button = action.button;
  if (!QUICK_BUTTONS.includes(button)) throw err('invalid', 'bad_button');
  const parent = ownerParent(b, action, now);
  const owner = (type, payload, extra = {}) => b.add({ type, actor: 'owner', at: now, causeRef: parent, payload, ...extra });
  const slices = [];
  switch (button) {
    case 'tired': case 'energised': case 'good_day_at_work':
      owner('vitals.nudged', { delta: { ...NUDGE[button] }, reason: 'quick' });
      slices.push('vitals');
      break;
    case 'bad_day_at_work':
      owner('work.crunch', { amount: 60, reason: 'owner' });
      owner('vitals.nudged', { delta: { ...NUDGE.bad_day_at_work }, reason: 'quick' });
      slices.push('vitals', 'work');
      break;
    case 'rain': {
      const w = state.weather || {};
      owner('weather.changed', { rain: true, condition: 'rain', tempC: finite(w.tempC) ? w.tempC : null, from: now, until: now + 3 * HOUR });
      slices.push('weather');
      break;
    }
    case 'sick_day': {
      if (state.sick || state.vitals?.sick === true) throw err('refused', 'already_sick');
      const until = addDays(dayStart(now, tz), 1, tz) + 4 * HOUR;
      owner('sick.started', { until, days: 1, reason: 'owner' });
      warnSickPromises(b, state, now, until, ctx);
      slices.push('sick', 'vitals');
      break;
    }
    case 'free_evening': {
      const plan = freeEveningPlan(state, now);
      owner('plan.made', plan);
      slices.push('plan');
      break;
    }
    case 'cancel_tonight': {
      const { decision, amendedEventId } = tonightDecision(state, ctx);
      // A plan he made in a chat (adopted from a claim, an invitation): say so.
      if (decisionFromChat(decision)) warnChatPlan(b, decision);
      if (posInt(decision.goalId)) b.warnings.push(GOAL_PLAN);   // 011: its goal closes too
      owner('decision.expired', { decisionId: decision.id, reason: 'owner_cancelled' }, decision.subjectJid ? { subjectJid: decision.subjectJid } : {});
      if (amendedEventId && !isExcludedId(state, amendedEventId)) {
        owner('event.reverted', { targetId: amendedEventId, reason: 'cancel_tonight', by: 'owner' });
      }
      slices.push('decisions', 'plan');
      break;
    }
    default: break;
  }
  finishParent(b, parent);
  return { slices };
}

/**
 * Today's plan with the work/meeting blocks after max(now, workEnd − 2 h)
 * turned into free time. Refused while asleep, with no work left, or while
 * the plan carries a chat-adopted outing (rewriting it as an owner plan would
 * launder the outing's chat origin into his own).
 */
export function freeEveningPlan(state, now) {
  const plan = state.plan;
  if (state.activity?.kind === 'sleep') throw err('refused', 'asleep');
  if (!plan || !Array.isArray(plan.blocks) || !finite(plan.nextWakeAt) || now >= plan.nextWakeAt) throw err('refused', 'no_plan');
  if (plan.blocks.some(b => b.fromAmendment) || posInt(plan.amendedFor)) throw err('refused', 'amended_plan');
  const work = plan.blocks.filter(b => b.kind === 'work' || b.kind === 'meeting');
  const workEnd = work.length ? Math.max(...work.map(b => b.end)) : null;
  if (!finite(workEnd) || workEnd <= now) throw err('refused', 'no_work_left');
  const trimAt = Math.max(now, workEnd - 2 * HOUR);
  const blocks = [];
  for (const b of plan.blocks) {
    const isWork = b.kind === 'work' || b.kind === 'meeting';
    const copy = { ...b };
    delete copy.fromAmendment;
    delete copy.subjectJid;
    if (!isWork || b.end <= trimAt) { blocks.push(copy); continue; }
    if (b.start < trimAt) blocks.push({ ...copy, end: trimAt });
    const start = Math.max(b.start, trimAt);
    const prev = blocks[blocks.length - 1];
    if (prev && prev.kind === 'free' && prev.end === start && prev.placeId === b.placeId) prev.end = b.end;
    else blocks.push({ kind: 'free', placeId: b.placeId ?? null, start, end: b.end, availability: 'free', withCast: [] });
  }
  return {
    date: plan.date, dayType: plan.dayType, wakeAt: plan.wakeAt, lateBy: plan.lateBy ?? 0, sleepAt: plan.sleepAt,
    nextWakeAt: plan.nextWakeAt, workLate: null, skipped: plan.skipped ?? [], blocks,
    basePlanEventId: Number.isSafeInteger(plan.basePlanEventId) ? plan.basePlanEventId : (plan.eventId ?? null),
    ...(isObj(plan.gear) ? { gear: { ...plan.gear } } : {}),   // 011: the day's umbrella stays packed
  };
}

function isEvening(d) {
  return Array.isArray(d?.options) && d.options.length === EVENING_OPTIONS.length && d.options.every(o => EVENING_OPTIONS.includes(o.id));
}

/**
 * Was a decision made in a chat (adopted from a claim, a real-person subject, an
 * invitation, a reply's commit, opened from a chat)? A routine plan a chat only
 * nudged with a lean is his own here (2026-11-02; planEdits.chatMadeDecision).
 */
export function decisionFromChat(d) {
  return planEdits.chatMadeDecision(d);
}

/**
 * The evening decision CANCEL TONIGHT would expire right now (the same pick the
 * planner makes), or null. → { id, label, eventAt, fromChat }
 */
export function tonightTarget(state, now, tz) {
  try {
    const { decision } = tonightDecision(state, { now, tz: resolveTimezone(tz) });
    const label = decision.options?.find?.(o => o.id === 'go')?.label ?? decision.kind ?? null;
    return { id: decision.id, label: typeof label === 'string' ? label.slice(0, 80) : null, eventAt: decision.subject.eventAt,
      fromChat: decisionFromChat(decision) };
  } catch {
    return null;
  }
}

function tonightDecision(state, ctx) {
  const today = dateKey(ctx.now, ctx.tz);
  const list = [...(state.decisions instanceof Map ? state.decisions.values() : [])]
    .filter(d => (d.status === 'open' || d.status === 'committed') && isEvening(d) && finite(d.subject?.eventAt)
      && dateKey(d.subject.eventAt, ctx.tz) === today && d.subject.eventAt + 6 * HOUR > ctx.now)
    .sort((a, b) => a.subject.eventAt - b.subject.eventAt);
  const decision = list[0];
  if (!decision) throw err('refused', 'nothing');
  return { decision, amendedEventId: amendedPlanEventId(state, decision.id, ctx) };
}

function planFate(action, ctx, b) {
  const { category, mode } = action;
  if (!CATEGORIES.includes(category) || !FATE_MODES.includes(mode)) throw err('invalid', 'bad_fate');
  if (fateOf(category, ctx.state) === mode) throw err('refused', 'nothing');
  const parent = ownerParent(b, action, ctx.now);
  const set = b.add({ type: 'director.fate_set', actor: 'owner', at: ctx.now, causeRef: parent, payload: { category, mode } });
  if (mode === 'frozen') {
    for (const d of openDecisionsWhere(ctx.state, d => isArcDecision(d) && (categoryOf(d.category) ?? d.category) === category)) {
      b.add({ type: 'decision.expired', actor: 'engine', at: ctx.now, causeRef: set, payload: { decisionId: d.id, reason: 'frozen' } });
    }
  }
  finishParent(b, parent);
  return { slices: ['story.controls', 'decisions'] };
}

function planSlider(action, ctx, b) {
  if (!SLIDERS.includes(action.name) || !finite(action.value)) throw err('invalid', 'bad_slider');
  const value = round2(clamp(action.value, 0, 1));
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'director.slider_set', actor: 'owner', at: ctx.now, causeRef: parent, payload: { slider: action.name, value } });
  finishParent(b, parent);
  return { slices: ['story.controls'] };
}

function pinResolves(key, state) {
  if (!isPinKey(key)) return false;
  if (key.startsWith('self.')) return true;
  if (key.startsWith('arc:')) return !!state.story?.arcs?.[Number(key.slice(4, key.indexOf('.')))];
  return state.cast instanceof Map && state.cast.has(key);
}

function planPin(action, ctx, b) {
  const key = action.pinKey;
  if (!pinResolves(key, ctx.state)) throw err('invalid', 'bad_pinKey');
  const pinned = !!pinOf(key, ctx.state);
  if (action.kind === 'pin' && pinned) throw err('refused', 'nothing');
  if (action.kind === 'unpin' && !pinned) throw err('refused', 'nothing');
  const parent = ownerParent(b, action, ctx.now);
  const ev = b.add({ type: action.kind === 'pin' ? 'director.pin_set' : 'director.pin_cleared', actor: 'owner', at: ctx.now, causeRef: parent, payload: { pinKey: key } });
  if (action.kind === 'pin') {
    for (const d of openDecisionsWhere(ctx.state, d => isArcDecision(d) && decisionPinKeys(d, ctx.state).includes(key))) {
      b.add({ type: 'decision.expired', actor: 'engine', at: ctx.now, causeRef: ev, payload: { decisionId: d.id, reason: 'pinned' } });
    }
  }
  finishParent(b, parent);
  return { slices: ['story.controls', 'decisions'] };
}

function planPause(action, ctx, b) {
  const paused = isPaused(ctx.state);
  if (action.kind === 'pause' && paused) throw err('refused', 'nothing');
  if (action.kind === 'resume' && !paused) throw err('refused', 'nothing');
  const reason = cleanOwnerText(action.reason, TEXT_CAPS.reason, ctx, { required: false, field: 'reason' }) ?? '';
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: action.kind === 'pause' ? 'director.paused' : 'director.resumed', actor: 'owner', at: ctx.now, causeRef: parent, payload: { reason } });
  finishParent(b, parent);
  return { slices: ['story.controls'] };
}

function planBookmark(action, ctx, b) {
  const name = cleanOwnerText(action.name, TEXT_CAPS.bookmark, ctx, { field: 'name' });
  const last = ctx.state.lastEventId;
  const eventId = action.eventId === undefined || action.eventId === null ? last : posInt(action.eventId);
  if (!eventId || eventId > last || !getEvent(eventId)) throw err('not_found', 'event');
  if ((ctx.state.story?.bookmarks?.length ?? 0) >= ctx.cfg.bookmarksMax) throw err('refused', 'full');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'director.bookmark', actor: 'owner', at: ctx.now, causeRef: parent, payload: { name, eventId } });
  finishParent(b, parent);
  return { slices: ['story.bookmarks'] };
}

function planBookmarkRemove(action, ctx, b) {
  const id = posInt(action.bookmarkId);
  if (!id || !(ctx.state.story?.bookmarks ?? []).some(x => x.id === id)) throw err('not_found', 'bookmark');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'director.bookmark_removed', actor: 'owner', at: ctx.now, causeRef: parent, payload: { bookmarkId: id } });
  finishParent(b, parent);
  return { slices: ['story.bookmarks'] };
}

function planCastEdit(action, ctx, b) {
  const castId = castRef(ctx.state, action.castId);
  const raw = isObj(action.fields) ? action.fields : null;
  if (!raw) throw err('invalid', 'bad_fields');
  const fields = {};
  for (const [k, cap] of Object.entries(CAST_FIELDS)) {
    if (raw[k] === undefined) continue;
    fields[k] = cleanOwnerText(raw[k], cap, ctx, { field: k });
  }
  if (raw.birthday !== undefined) {
    if (typeof raw.birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.birthday)) throw err('invalid', 'bad_birthday');
    fields.birthday = raw.birthday;
  }
  if (raw.name !== undefined) throw err('invalid', 'bad_fields', { field: 'name' });
  if (!Object.keys(fields).length) throw err('invalid', 'bad_fields');
  const pin = pinOf(castId, ctx.state);
  if (pin && !ctx.relax) { refuse(b, { reason: 'pinned', target: castId, pinKey: castId }); return { slices: [castId] }; }
  if (pin) warn(b, 'overrides_pin', 'warn', { pinKey: castId });   // 015: a hand-built change overrides it
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'cast.updated', actor: 'owner', at: ctx.now, causeRef: parent, payload: { castId, fields, reason: 'owner_edit' } });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: [castId] };
}

function planCastHistory(action, ctx, b) {
  const castId = castRef(ctx.state, action.castId);
  const text = cleanOwnerText(action.text, TEXT_CAPS.history, ctx, { field: 'text' });
  let dated = null;
  if (action.dated !== undefined && action.dated !== null) {
    dated = posInt(action.dated);
    if (!dated || dated > ctx.now + 60) throw err('invalid', 'bad_dated');
  }
  if (pinOf(castId, ctx.state) && !ctx.relax) { refuse(b, { reason: 'pinned', target: castId, pinKey: castId }); return { slices: [`story.history.${castId}`] }; }
  if (pinOf(castId, ctx.state)) warn(b, 'overrides_pin', 'warn', { pinKey: castId });   // 015
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'cast.history_added', actor: 'owner', at: ctx.now, causeRef: parent, payload: { castId, text, ...(dated ? { dated } : {}) } });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: [`story.history.${castId}`] };
}

// The owner sets closeness / trust / tension (absolute targets). Pins refuse
// like a cast edit; the fate of `cast` does not (an owner change, not a start).
function planCastMetrics(action, ctx, b) {
  const castId = castRef(ctx.state, action.castId);
  const m = isObj(ctx.state.cast.get(castId)?.metrics) ? ctx.state.cast.get(castId).metrics : {};
  const rel = isObj(ctx.state.story?.relationships?.[castId]) ? ctx.state.story.relationships[castId] : {};
  const delta = {};
  for (const k of METRIC_FIELDS) {
    if (action[k] === undefined || action[k] === null) continue;
    if (!finite(action[k]) || action[k] < 0 || action[k] > 1) throw err('invalid', `bad_${k}`);
    const d = Math.round((round2(action[k]) - (finite(m[k]) ? m[k] : (k === 'tension' ? 0 : 0.5))) * 10000) / 10000;
    if (d) delta[k] = d;
  }
  // 015: intimacy / passion / commitment (default 0), the same steps.
  for (const k of REL_METRIC_FIELDS) {
    if (action[k] === undefined || action[k] === null) continue;
    if (!finite(action[k]) || action[k] < 0 || action[k] > 1) throw err('invalid', `bad_${k}`);
    const d = Math.round((round2(action[k]) - (finite(rel[k]) ? rel[k] : 0)) * 10000) / 10000;
    if (d) delta[k] = d;
  }
  if (![...METRIC_FIELDS, ...REL_METRIC_FIELDS].some(k => action[k] !== undefined && action[k] !== null)) throw err('invalid', 'bad_fields');
  if (pinOf(castId, ctx.state) && !ctx.relax) { refuse(b, { reason: 'pinned', target: castId, pinKey: castId }); return { slices: [castId] }; }
  if (pinOf(castId, ctx.state)) warn(b, 'overrides_pin', 'warn', { pinKey: castId });   // 015
  if (!Object.keys(delta).length) { refuse(b, { reason: 'nothing', target: castId }); return { slices: [castId] }; }
  const steps = Math.max(1, Math.ceil(Math.max(...Object.values(delta).map(Math.abs)) / METRIC_STEP - 1e-9));
  const parent = ownerParent(b, action, ctx.now);
  const done = Object.fromEntries(Object.keys(delta).map(k => [k, 0]));
  for (let i = 1; i <= steps; i++) {
    const step = {};
    for (const [k, d] of Object.entries(delta)) {
      const v = i === steps ? Math.round((d - done[k]) * 10000) / 10000 : Math.round((d / steps) * 10000) / 10000;
      done[k] += v;
      if (v) step[k] = v;
    }
    if (!Object.keys(step).length) continue;
    b.add({ type: 'relationship.changed', actor: 'owner', at: ctx.now, causeRef: parent, payload: { castId, delta: step, reason: 'owner', ...(steps > 1 ? { step: i, steps } : {}) } });
  }
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: [castId] };
}

function planPlaceEdit(action, ctx, b) {
  const placeId = placeRef(ctx.state, action.placeId);
  const name = action.name === undefined ? null : cleanOwnerText(action.name, TEXT_CAPS.name, ctx, { field: 'name' });
  const kind = action.placeKind === undefined ? null
    : (typeof action.placeKind === 'string' && KIND_SLUG_RE.test(action.placeKind) ? action.placeKind : null);
  if (action.placeKind !== undefined && !kind) throw err('invalid', 'bad_kind');
  if (!name && !kind) throw err('invalid', 'bad_fields');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'place.updated', actor: 'owner', at: ctx.now, causeRef: parent, payload: { placeId, ...(name ? { name } : {}), ...(kind ? { kind } : {}) } });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: [`places.${placeId}`] };
}

function planSeedSet(action, ctx, b) {
  if (!Object.prototype.hasOwnProperty.call(SEED_PATHS, action.path)) throw err('invalid', 'bad_path');
  const value = cleanSeedValue(action.path, action.value);
  if (value === undefined) throw err('invalid', 'bad_value');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'director.seed_set', actor: 'owner', at: ctx.now, causeRef: parent, payload: { path: action.path, value } });
  finishParent(b, parent);
  return { slices: ['story.seedOverlay'] };
}

function planReconcilerMode(action, ctx, b) {
  if (!RECONCILER_MODES.includes(action.mode)) throw err('invalid', 'bad_mode');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'director.reconciler_mode', actor: 'owner', at: ctx.now, causeRef: parent, payload: { mode: action.mode } });
  finishParent(b, parent);
  return { slices: ['story.controls'] };
}

function planHeavyEnd(action, ctx, b) {
  const a = ctx.state.story?.heavy?.active;
  const id = posInt(action.heavyId) ?? a?.id ?? null;
  if (!isObj(a) || !finite(a.until) || a.until <= ctx.now || a.id !== id) throw err('refused', 'no_heavy');
  const parent = ownerParent(b, action, ctx.now);
  b.add({ type: 'heavy.ended', actor: 'owner', at: ctx.now, causeRef: parent, payload: { heavyId: a.id, reason: 'owner' } });
  finishParent(b, parent);
  return { slices: ['story.heavy'] };
}

// ── 011 weather windows (plan §P2.1) ──────────────────────────────────────

function openWindows(state, now) {
  return (Array.isArray(state.weatherWindows) ? state.weatherWindows : []).filter(w => finite(w?.to) && w.to > now);
}

function localWhen(at, tz) {
  return `${dateKey(at, tz)} ${clockHhmm(at, tz)}`;
}

function planWeather(action, ctx, b) {
  const { state, now, tz } = ctx;
  const sky = typeof action.weatherKind === 'string' && WEATHER_KINDS.includes(action.weatherKind) ? action.weatherKind : null;
  if (!sky) throw err('invalid', 'bad_weatherKind');
  const k = action.intensity === undefined || action.intensity === null ? 0.5 : action.intensity;
  if (!finite(k) || k < 0 || k > 1) throw err('invalid', 'bad_intensity');
  const intensity = round2(k);
  const from = posInt(action.from);
  const to = posInt(action.to);
  if (!from || from < now - 60 || from > now + WEATHER_AHEAD_SEC) throw err('invalid', 'bad_from');
  if (!to || to > now + WEATHER_AHEAD_SEC) throw err('invalid', 'bad_to');
  if (to - from < WEATHER_MIN_SEC || to - from > WEATHER_AHEAD_SEC) throw err('invalid', 'bad_window');
  if (openWindows(state, now).length >= WEATHER_WINDOWS_MAX) throw err('refused', 'full');
  const parent = ownerParent(b, action, now);
  const set = b.add({ type: 'weather.window_set', actor: 'owner', at: now, causeRef: parent, payload: { from, to, sky, intensity } });
  if (from <= now) {
    // The change is immediate, as quick RAIN's: the window's outcome now (pure,
    // the function weatherFor uses), caused by the window so a revert cascades.
    const w = windowOutcome({ id: 0, from, to, sky, intensity }, now, ctx.baseWorld ?? ctx.world, { tz });
    delete w.windowId;
    b.add({ type: 'weather.changed', actor: 'engine', at: now, causeRef: set, payload: w, payloadRefs: { windowId: set } });
  }
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE, `overrides the forecast until ${localWhen(to, tz)}`);
  return { slices: ['weather', 'weatherWindows'], extra: { window: { from, to, sky, intensity, startsNow: from <= now } } };
}

function planWeatherEnd(action, ctx, b) {
  const { state, now, tz } = ctx;
  const id = posInt(action.windowId);
  const win = id ? openWindows(state, now).find(w => w.id === id) : null;
  if (!win) throw err('refused', 'no_window');
  const parent = ownerParent(b, action, now);
  const ended = b.add({ type: 'weather.window_ended', actor: 'owner', at: now, causeRef: parent, payload: { windowId: win.id } });
  if (win.from <= now) {
    // Back to what the weather is without it (review R28): weatherFor on the
    // state with this window cut at now — another window, a newer RAIN, or the
    // climatology.
    const after = { ...state, weatherWindows: state.weatherWindows.map(w => (w.id === win.id ? { ...w, to: Math.max(w.from, now) } : w)) };
    const w = { ...weatherFor(after, now, ctx.baseWorld ?? ctx.world, { tz }) };
    for (const k of ['eventId', 'by']) delete w[k];
    const next = windowAt(after.weatherWindows, now);
    if (!Number.isSafeInteger(w.windowId) || !next) delete w.windowId;
    b.add({
      type: 'weather.changed', actor: 'engine', at: now, causeRef: ended,
      payload: { ...w, from: now },
    });
  }
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['weather', 'weatherWindows'] };
}

// ── 011 soft goals (plan §P2.3) ───────────────────────────────────────────

const GOAL_MIN_SEC = HOUR;
const GOAL_MAX_SEC = 14 * DAY;
export const GOAL_TRIES = 'fits into a free slot; tries once a day';

function planGoal(action, ctx, b) {
  const { state, now, tz } = ctx;
  const goalKind = typeof action.goalKind === 'string' && GOAL_KINDS.includes(action.goalKind) ? action.goalKind : null;
  if (!goalKind) throw err('invalid', 'bad_goalKind');
  const from = posInt(action.from);
  const to = posInt(action.to);
  if (!from || from < dayStart(now, tz) - 60) throw err('invalid', 'bad_from');
  if (!to || to - Math.max(from, now) < GOAL_MIN_SEC || to - from > GOAL_MAX_SEC + HOUR) throw err('invalid', 'bad_window');
  const castId = action.castId === undefined || action.castId === null ? null : castRef(state, action.castId);
  if (goalKind === 'meet' && !castId) throw err('invalid', 'bad_castId');
  if (goalKind === 'call' && castId && !/^family:/.test(state.cast.get(castId)?.relation ?? '')) throw err('invalid', 'bad_castId');
  const placeId = action.placeId === undefined || action.placeId === null ? null : placeRef(state, action.placeId);
  if (goalKind === 'call' && placeId) throw err('invalid', 'bad_placeId');
  const minutes = action.minutes === undefined || action.minutes === null ? GOAL_MINUTES[goalKind] : minutesOf(action.minutes, 15, 240);
  const label = action.label === undefined || action.label === null ? null : cleanOwnerText(action.label, TEXT_CAPS.label, ctx, { field: 'label' });
  if (activeGoals(state).length >= GOAL_OPEN_MAX) throw err('refused', 'full');
  const category = goalKind === 'call' ? 'family' : 'social';
  const v = controlsCheck({ source: 'owner', category, action: 'start', pinKeys: castId ? [castId] : [] }, state);
  if (!relaxOr(b, ctx, v, castId ?? category)) return { slices: ['goals'] };   // 015: a warning for a hand-built goal
  const parent = ownerParent(b, action, now);
  const payload = { goalKind, castId, placeId, from, to, minutes, label };
  b.add({ type: 'goal.set', actor: 'owner', at: now, causeRef: parent, payload });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE, GOAL_TRIES);
  // Does today have room right now? (pure; the engine's own try runs at the next tick)
  let firstSlot = null;
  try {
    const f = goalFitToday(state, Math.max(now, from), ctx.baseWorld ?? ctx.world, { id: 0, status: 'open', lastTry: null, ...payload });
    firstSlot = f.ok ? { slotStart: f.slotStart, slotEnd: f.slotEnd, placeId: f.placeId } : { reason: f.reason };
  } catch { firstSlot = null; }
  return { slices: ['goals'], extra: { firstSlot } };
}

function planGoalCancel(action, ctx, b) {
  const { state, now, tz } = ctx;
  const id = posInt(action.goalId);
  const goal = id ? activeGoals(state).find(g => g.id === id) : null;
  if (!goal) throw err('refused', 'no_goal');
  const parent = ownerParent(b, action, now);
  const owner = (type, payload) => b.add({ type, actor: 'owner', at: now, causeRef: parent, payload });
  owner('goal.cancelled', { goalId: goal.id });
  // Its planned outing goes too (CANCEL TONIGHT's logic, outing.js), unless it already happened.
  const d = Number.isSafeInteger(goal.fitted?.decisionId) && state.decisions instanceof Map ? state.decisions.get(goal.fitted.decisionId) : null;
  if (d && (d.status === 'open' || d.status === 'committed') && finite(d.subject?.eventAt) && d.subject.eventAt > now) {
    for (const e of cancelDecisionEvents(state, d, { now, tz, reason: 'goal_cancel' })) owner(e.type, e.payload);
  }
  finishParent(b, parent);
  return { slices: ['goals', 'decisions', 'plan'] };
}

// ── 014 sched: schedule edits (plan §A5) ──────────────────────────────────
//   schedule {day 0..7 | date, background?:{activity, from, to | wholeDay},
//     ranges?:[{activity, from, to, placeId? | candidateId?, castIds?, label?}] (≤ 3),
//     op?:'set'|'remove'|'move', blockKind?, moveTo?, resolutions?:{'<type>:<id>': r}}
//   times: 'HH:MM' on that date | 'now' | 'endOfDay' (the day's planned sleep) | unix
//   schedule.clear {overrideId}
// One owner `schedule.override_set` (+ engine `decision.expired {schedule}` for each
// conflict resolved cancel / reopen, caused by it). The re-plan of today is the
// pulse's `schedule` item, run right after apply (the facade settles at once);
// the preview shows it in extra.projection.

export const SCHEDULE_KINDS = new Set(['schedule', 'schedule.clear']);
export const SCHEDULE_DAYS_MAX = planEdits.DAYS_AHEAD_MAX;
export const SCHEDULE_FREE = 'a schedule edit costs no trust';
export const SCHEDULE_REOPEN = 'its goal is fitted again another day';
export const SCHEDULE_EMBARGO = 'during a hard stretch';
const SCHED_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHED_ACTIVITY_SICK = new Set(['out', 'gym', 'errand', 'work_office']);
const PROJECTION_HOURS = 36;
const PROJECTION_DEADLINE_MS = 1500;

function scheduleDateOf(action, ctx) {
  const { now, tz } = ctx;
  const today = dateKey(now, tz);
  let date;
  if (action.date !== undefined && action.date !== null) {
    if (typeof action.date !== 'string' || !WHEN_DATE_RE.test(action.date)) throw err('invalid', 'bad_date');
    date = action.date;
  } else {
    if (!Number.isInteger(action.day) || action.day < 0) throw err('invalid', 'bad_day');
    if (action.day > SCHEDULE_DAYS_MAX) throw err('refused', 'too_far');
    date = planEdits.dateAfter(now, action.day, tz);
  }
  if (date < today) throw err('refused', 'in_past');
  if (date > planEdits.dateAfter(now, SCHEDULE_DAYS_MAX, tz)) throw err('refused', 'too_far');
  return date;
}

// The plan of that date as it stands: today's in force, else a predicted planDay.
function scheduleDayPlan(state, date, ctx, world) {
  if (state.plan?.date === date && Array.isArray(state.plan.blocks)) return state.plan;
  try { return planDay(state, date, world); } catch { return null; }
}

function scheduleTime(v, ctx, d0, endOfDay, field) {
  if (v === 'now') return ctx.now;
  if (v === 'endOfDay') {
    if (!finite(endOfDay)) throw err('invalid', `bad_${field}`);
    return endOfDay;
  }
  if (Number.isSafeInteger(v) && v > 0) return v;
  const m = typeof v === 'string' ? SCHED_TIME_RE.exec(v) : null;
  if (!m) throw err('invalid', `bad_${field}`);
  return zonedToUnix(...WHEN_DATE_RE.exec(dateKey(d0 + 12 * HOUR, ctx.tz)).slice(1, 4).map(Number), Number(m[1]), Number(m[2]), ctx.tz);
}

function scheduleWorld(state, ctx) {
  try { const w = typeof deps.worldOf === 'function' ? deps.worldOf(state) : null; if (isObj(w)) return w; } catch { /* the overlay */ }
  return ctx.world;
}

// A venue range (geo, §A5.9): the geo dep resolves the frozen candidate into
// place descriptors; without it → geo_off.
function venueRange(r, ctx, b, opts) {
  if (typeof deps.venuePlace !== 'function') throw err('refused', 'geo_off');
  const parent = opts?.parent ?? null;   // a scene outing: the venue's events are caused by its change
  let res;
  try { res = deps.venuePlace(r.candidateId, { ...ctx, resolved: opts?.resolved ?? ctx.resolved ?? null }); } catch { res = null; }
  if (!res || res.refusal) throw err('refused', typeof res?.refusal === 'string' ? res.refusal : (res?.refusal?.reason ?? 'expired_candidate'));
  const map = new Map();
  let placeId = typeof res.placeId === 'string' ? res.placeId : null;
  for (const d of Array.isArray(res.descriptors) ? res.descriptors : []) {
    const { ref, causeRef, payloadRefs, ...rest } = d;
    const fix = (x) => (typeof x === 'string' && map.has(x) ? map.get(x) : x);
    const nd = { ...rest, ...(causeRef ? { causeRef: fix(causeRef) } : parent ? { causeRef: parent } : {}),
      ...(payloadRefs ? { payloadRefs: Object.fromEntries(Object.entries(payloadRefs).map(([k, v]) => [k, Array.isArray(v) ? v.map(fix) : fix(v)])) } : {}) };
    map.set(ref, b.add(nd));
    if (ref === res.placeRef && typeof d.payload?.id === 'string') placeId = d.payload.id;
  }
  if (!placeId || !PLACE_ID_RE.test(placeId)) throw err('refused', 'no_place');
  return placeId;
}

function planSchedule(action, ctx, b, opts = {}) {
  const { state, now, tz } = ctx;
  const world = scheduleWorld(state, ctx);
  const op = action.op === undefined || action.op === null ? 'set' : action.op;
  if (!planEdits.OPS.includes(op)) throw err('invalid', 'bad_op');
  const date = scheduleDateOf(action, ctx);
  const d0 = planEdits.dateStart(date, tz);
  const dayPlan = scheduleDayPlan(state, date, ctx, world);
  const endOfDay = dayPlan?.sleepAt ?? null;
  const home = state.self?.homePlaceId ?? world?.self?.homePlaceId ?? null;
  const office = world?.self?.job?.officePlaceId ?? state.self?.officePlaceId ?? null;
  const sick = !!(state.sick || state.vitals?.sick === true);
  const ov = { op, date };

  if (action.background !== undefined && action.background !== null) {
    const bg = action.background;
    if (!isObj(bg) || !planEdits.BACKGROUND_ACTIVITIES.includes(bg.activity)) throw err('invalid', 'bad_background');
    if (bg.activity === 'work_office' && (!office || office === home)) throw err('refused', 'no_place');
    if (bg.activity === 'work_office' && sick) throw err('refused', 'sick');
    if (bg.wholeDay === true) {
      const from = date === dateKey(now, tz) ? now : d0;
      ov.background = { activity: bg.activity, from, to: Math.max(from + 60, finite(endOfDay) ? endOfDay : d0 + DAY - 60), wholeDay: true };
    } else {
      const from = scheduleTime(bg.from, ctx, d0, endOfDay, 'from');
      const to = bg.to === undefined || bg.to === null ? endOfDay : scheduleTime(bg.to, ctx, d0, endOfDay, 'to');
      if (!finite(to) || to <= from) throw err('invalid', 'bad_background');
      ov.background = { activity: bg.activity, from, to };
    }
  }
  const ranges = [];
  if (action.ranges !== undefined && action.ranges !== null) {
    if (!Array.isArray(action.ranges) || action.ranges.length > planEdits.RANGES_MAX) throw err('invalid', 'bad_ranges');
    for (const r of action.ranges) {
      if (!isObj(r) || !planEdits.RANGE_ACTIVITIES.includes(r.activity)) throw err('invalid', 'bad_activity');
      const from = scheduleTime(r.from, ctx, d0, endOfDay, 'from');
      const to = scheduleTime(r.to, ctx, d0, endOfDay, 'to');
      if (to - from < planEdits.RANGE_MIN_SEC || to - from > planEdits.RANGE_MAX_SEC) throw err('invalid', 'bad_range');
      if (sick && SCHED_ACTIVITY_SICK.has(r.activity)) throw err('refused', 'sick');
      const x = { activity: r.activity, from, to };
      if (r.activity === 'out') {
        if (r.candidateId !== undefined && r.candidateId !== null) x.placeId = venueRange(r, ctx, b, opts);
        else if (r.placeId === undefined || r.placeId === null) throw err('refused', 'no_place');
        else x.placeId = placeRef(state, r.placeId);
        const kind = state.places?.get?.(x.placeId)?.kind ?? null;
        if (x.placeId === home || x.placeId === office || kind === 'home' || kind === 'office') throw err('refused', 'private_place');
      } else if (r.activity === 'gym' || r.activity === 'errand') {
        x.placeId = r.placeId !== undefined && r.placeId !== null ? placeRef(state, r.placeId)
          : (r.activity === 'gym' ? planEdits.gymPlaceOf(world) : planEdits.errandPlaceOf(world));
        if (!x.placeId) throw err('refused', 'no_place');
      } else if (r.activity === 'work_office' && (!office || office === home)) throw err('refused', 'no_place');
      if (r.activity === 'sleep') {
        // A sleep range touches the wake ("sleep in") or tonight's sleep ("early night"); else a nap.
        const r0 = routineOf(world);
        const wakeM = dayPlan?.dayType === 'weekend' || dayPlan?.dayType === 'off' ? r0.weekendWake : r0.baseWake;
        const wake = d0 + wakeM * MIN;
        if (from < d0 + 12 * HOUR && !(from <= wake && to > wake)) throw err('invalid', 'bad_sleep');
      }
      const castIds = Array.isArray(r.castIds) ? r.castIds.slice(0, 5).map(id => castRef(state, id)) : [];
      if (castIds.length > 4) throw err('invalid', 'bad_castIds');
      if (castIds.length) x.castIds = [...new Set(castIds)];
      if (r.label !== undefined && r.label !== null) x.label = cleanOwnerText(r.label, TEXT_CAPS.label, ctx, { field: 'label' });
      ranges.push(x);
    }
    ranges.sort((a, c) => a.from - c.from);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].from < ranges[i - 1].to) throw err('invalid', 'ranges_overlap');   // two stretches of one edit (the route's bad_ranges is a shape)
    if (ranges.length) ov.ranges = ranges;
  }
  if (op !== 'set') {
    if (typeof action.blockKind !== 'string' || !KIND_SLUG_RE.test(action.blockKind)) throw err('invalid', 'bad_blockKind');
    if (!(dayPlan?.blocks || []).some(x => x.kind === action.blockKind && x.start >= now && x.kind !== 'commute' && x.kind !== 'sleep')) throw err('refused', 'nothing');
    ov.blockKind = action.blockKind;
    if (op === 'move') {
      ov.moveTo = scheduleTime(action.moveTo, ctx, d0, endOfDay, 'moveTo');
      if (dateKey(ov.moveTo, tz) !== date) throw err('invalid', 'bad_moveTo');
    }
  } else if (!ov.background && !ov.ranges) throw err('invalid', 'nothing');

  // Bounds and refusals (§A5.5).
  const first = planEdits.firstFrom(ov);
  if (finite(first) && first < now - 60) throw err('refused', 'in_past');
  const active = planEdits.activeOverrides(state);
  if (active.length >= planEdits.OVERRIDES_MAX || active.filter(o => o.date === date).length >= planEdits.PER_DATE_MAX) throw err('refused', 'full');
  const spans = (o) => [...(o.background ? [o.background] : []), ...(o.ranges || [])];
  const clash = active.find(o => o.date === date && spans(o).some(x => spans(ov).some(y => x.from < y.to && y.from < x.to)));
  if (clash) { refuse(b, { reason: 'overlap', target: String(clash.id) }); return { slices: ['scheduleOverrides'], extra: { overlapWith: clash.id } }; }
  const travel = state.position?.travel;
  if (travel && finite(travel.endAt) && ranges.some(r => r.to <= travel.endAt)) throw err('refused', 'during_travel');
  if (state.activity?.kind === 'sleep' && date === dateKey(now, tz)) {
    const startsNow = [...(ov.background && !ov.background.wholeDay ? [ov.background] : []), ...ranges.filter(r => r.activity !== 'sleep')].some(x => x.from <= now + 15 * MIN);
    if (startsNow) throw err('refused', 'asleep_now');
  }

  // Conflicts: the rows the owner resolves (resolutions re-preview).
  const { rows, refusal, clipped } = planEdits.conflictsOf(state, ov, {
    now, tz, plan: dayPlan, resolutions: isObj(action.resolutions) ? action.resolutions : {},
    commitments: state.story?.commitments ?? [],
  });
  if (refusal) throw err('refused', refusal);
  const payload = { ...clipped, conflicts: rows.filter(r => r.type !== 'meeting').map(r => ({ type: r.type, id: r.id, resolution: r.resolution })) };
  if (op === 'set' && !payload.background && !payload.ranges) throw err('refused', 'nothing');
  if (!planEdits.normalize(payload)) throw err('invalid', 'bad_override');

  // Would it fit? (planned on a copy, the same code the pulse runs.) A venue new to
  // his world (venueRange's place.created / route.recorded, the only events added
  // so far) is folded in first, so the trial plan knows the place.
  let base = state;
  if (b.events.length) {
    try { base = foldDescriptors(state, b.events, ctx.baseWorld ?? ctx.world); } catch { base = state; }
  }
  const trialWorld = base === state ? world : scheduleWorld(base, ctx);
  const trial = { ...base, scheduleOverrides: { ...(base.scheduleOverrides ?? {}), [PREVIEW_ID_BASE]: { ...planEdits.normalize(payload), id: PREVIEW_ID_BASE, status: 'active', setAt: now } } };
  let fitted = null;
  try {
    fitted = date === state.plan?.date ? planEdits.replanToday(trial, now, trialWorld) : planDay(trial, date, trialWorld);
  } catch { fitted = null; }
  if (fitted && (fitted.skipped || []).some(c => c === `override:unfit:${PREVIEW_ID_BASE}`.slice(0, 32))) throw err('refused', 'unfit');

  const parent = ownerParent(b, action, now);
  const set = b.add({ type: 'schedule.override_set', actor: 'owner', at: now, causeRef: parent, payload });
  for (const r of rows) {
    if (r.resolution !== 'cancel' && r.resolution !== 'reopen') continue;
    b.add({ type: 'decision.expired', actor: 'engine', at: now, causeRef: set,
      payload: { decisionId: r.id, reason: 'schedule', ...(r.subjectJid ? { subjectJid: r.subjectJid } : {}) },
      payloadRefs: { overrideId: set }, ...(r.subjectJid ? { subjectJid: r.subjectJid } : {}) });
    if (r.fromChat) warnChatPlan(b, state.decisions?.get?.(r.id));
    if (r.type === 'goal') b.warnings.push(SCHEDULE_REOPEN);
  }
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  if (rows.some(r => r.outcome === 'cancelled')) b.warnings.push(SCHEDULE_FREE);
  if (state.embargo && finite(state.embargo.until) && state.embargo.until > now) b.warnings.push(SCHEDULE_EMBARGO);
  // The owner's own view of the rows (subject jids never leave the server).
  const conflicts = rows.map(({ subjectJid, fromChat, story, ...r }) => ({ ...r, ...(fromChat ? { fromChat: true } : {}), ...(story ? { story: true } : {}) }));
  return {
    slices: ['scheduleOverrides', 'decisions'],
    extra: {
      conflicts, date, dayType: fitted?.dayType ?? dayPlan?.dayType ?? null,
      skipped: (fitted?.skipped || []).filter(c => c.startsWith('override:')).slice(0, 16),
      ...(fitted ? { planned: fitted.blocks.filter(x => x.end > now).slice(0, 40).map(x => ({ kind: x.kind, placeId: x.placeId ?? null, start: x.start, end: x.end, ...(x.fromOverride ? { fromOverride: true } : {}) })) } : {}),
    },
  };
}

function planScheduleClear(action, ctx, b) {
  const { state, now } = ctx;
  const id = posInt(action.overrideId);
  const o = id ? state.scheduleOverrides?.[id] : null;
  if (!isObj(o) || o.status !== 'active') throw err('refused', 'no_override');
  const parent = ownerParent(b, action, now);
  b.add({ type: 'schedule.override_cleared', actor: 'owner', at: now, causeRef: parent, payload: { overrideId: id, from: now } });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['scheduleOverrides'], extra: { date: o.date } };
}

/**
 * The projected rest of today and tomorrow, without and with the preview's
 * events (tomorrow.simulate; no model calls, nothing written; deterministic
 * leans). → { before, after } | { timedOut:true }
 */
async function scheduleProjection(state, events, now) {
  if (!deps.world) return null;
  const opts = {
    now, hours: PROJECTION_HOURS, rng: null, sampleSec: 0, deadlineMs: PROJECTION_DEADLINE_MS, anchorFirst: true,   // 015 review #35: one anchor
    worldOf: typeof deps.worldOf === 'function' ? deps.worldOf : (s) => worldOverlay(s, deps.world),
    ...(deps.storyItems ? { storyItems: deps.storyItems } : {}),
    ...(deps.blockCause ? { blockCause: deps.blockCause } : {}), ...(deps.planCause ? { planCause: deps.planCause } : {}),
  };
  try {
    const before = await simulateSched(state, deps.world, opts);
    if (before.timedOut) return { timedOut: true };
    const after = await simulateSched(state, deps.world, { ...opts, descriptors: events });
    if (after.timedOut) return { timedOut: true };
    const to = now + PROJECTION_HOURS * HOUR;
    const expired = after.log.events.filter(e => e.type === 'decision.expired').map(e => ({ decisionId: e.payload?.decisionId ?? null, reason: e.payload?.reason ?? null }));
    return { from: now, to, before: planRows(state, before.log.events, now, to), after: planRows(state, after.log.events, now, to), expired: expired.slice(0, 16) };
  } catch {
    return { timedOut: true };
  }
}

// ── Scenes ────────────────────────────────────────────────────────────────

function regionBox(state) {
  const pts = [...(state.places instanceof Map ? state.places.values() : [])].filter(p => finite(p?.lat) && finite(p?.lon));
  if (!pts.length) return null;
  const lat = pts.map(p => p.lat);
  const lon = pts.map(p => p.lon);
  const dLat = REGION_MARGIN_KM / 111;
  const midLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const dLon = REGION_MARGIN_KM / (111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
  return { minLat: Math.min(...lat) - dLat, maxLat: Math.max(...lat) + dLat, minLon: Math.min(...lon) - dLon, maxLon: Math.max(...lon) + dLon };
}

function newPlacePayload(input, ctx) {
  const { state } = ctx;
  if (!isObj(input)) throw err('invalid', 'bad_newPlace');
  if ((state.places?.size ?? 0) >= MAX_PLACES) throw err('refused', 'full');
  const name = cleanOwnerText(input.name, TEXT_CAPS.name, ctx, { field: 'name' });
  const kind = typeof input.kind === 'string' && KIND_SLUG_RE.test(input.kind) ? input.kind : null;
  if (!kind) throw err('invalid', 'bad_kind');
  let lat = input.lat;
  let lon = input.lon;
  if (input.near !== undefined) {
    const near = state.places?.get?.(placeRef(state, input.near));
    const km = input.offsetKm;
    if (!finite(km) || km < 0 || km > 5) throw err('invalid', 'bad_offsetKm');
    const bearing = (crypto.createHash('sha256').update(`${name}|${input.near}`).digest()[0] / 256) * 2 * Math.PI;
    lat = near.lat + (km / 111) * Math.cos(bearing);
    lon = near.lon + (km / (111 * Math.max(0.1, Math.cos(near.lat * Math.PI / 180)))) * Math.sin(bearing);
  }
  if (!finite(lat) || !finite(lon)) throw err('invalid', 'bad_coordinates');
  const box = regionBox(state);
  if (box && (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon)) throw err('invalid', 'region');
  const id = freeId('place', slugify(name), new Set(state.places?.keys?.() ?? []));
  return { id, name, kind, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

function newCastPayload(input, ctx) {
  const { state } = ctx;
  if (!isObj(input)) throw err('invalid', 'bad_newCast');
  if ((state.cast?.size ?? 0) >= ctx.cfg.castMax) throw err('refused', 'full');
  const name = cleanOwnerText(input.name, TEXT_CAPS.castName, ctx, { field: 'name' });
  const relation = typeof input.relation === 'string' && CAST_RELATIONS_RE.test(input.relation) ? input.relation : null;
  if (!relation) throw err('invalid', 'bad_relation');
  const existing = [...(state.cast?.values?.() ?? [])].map(c => c?.name).filter(Boolean);
  if (castNameCollisions([{ id: 'new', name }], [...ctx.knownNames]).length) throw err('invalid', 'real_person_name');
  if (castNameCollisions([{ id: 'new', name }], existing).length) throw err('invalid', 'name_collision');
  const out = { id: freeId('cast', slugify(name), new Set(state.cast?.keys?.() ?? [])), name, relation };
  for (const [k, cap] of Object.entries({ pronouns: 24, personality: 200, speech: 160, status: 160, hometown: 80 })) {
    if (input[k] !== undefined) out[k] = cleanOwnerText(input[k], cap, ctx, { field: k });
  }
  if (input.birthday !== undefined) {
    if (typeof input.birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthday)) throw err('invalid', 'bad_birthday');
    out.birthday = input.birthday;
  }
  if (input.metVia !== undefined && input.metVia !== null) out.metVia = castRef(state, input.metVia);
  out.metrics = { closeness: 0.3, trust: 0.4, tension: 0 };
  return out;
}

// decision.opened payload for an outing/visit, the same shape openDecision writes (outing.js, R27).
// too_soon carries `earliestAt`: the first start he can still get ready for and
// get to (the page offers to move the outing there).
function outingDecision(ctx, spec) {
  try {
    return outingDecisionPayload({ state: ctx.state, now: ctx.now, world: ctx.world }, spec);
  } catch (e) {
    if (!(e instanceof OutingError)) throw e;
    let extra = {};
    if (e.reason === 'too_soon') {
      let at = null;
      try { at = earliestStart({ state: ctx.state, now: ctx.now, world: ctx.world }, { placeId: spec.placeId, from: spec.from ?? null }); } catch { at = null; }
      if (Number.isSafeInteger(at) && at > spec.startAt) extra = { earliestAt: at };
    }
    throw err('refused', e.reason, extra);
  }
}

function futureAdoptions(state, now) {
  let n = 0;
  for (const d of state.decisions instanceof Map ? state.decisions.values() : []) {
    if (d?.adopted === true && d.status === 'committed' && finite(d.subject?.eventAt) && d.subject.eventAt > now) n++;
  }
  return n;
}

function reviewFor(id, { allowed = ['tray', 'returned'] } = {}) {
  const rid = posInt(id);
  const r = rid ? store.getReview(rid) : null;
  if (!r) throw err('not_found', 'review');
  if (!allowed.includes(r.status)) throw err('conflict', 'review_state');
  if (!posInt(r.claimEventId)) throw err('refused', 'no_claim_pointer');
  return r;
}

// The adopted-decision chain (reconciler.md §3): engine, caused by the claim pointer.
function adoptionChain(b, ctx, review, { placeId, castIds, startAt, minutes, label, subjectJid }) {
  const sub = subjectJid ? { subjectJid } : {};
  const claimId = review.claimId;
  const adopted = b.add({
    type: 'claim.adopted', actor: 'engine', at: ctx.now, causeId: review.claimEventId, ...sub,
    payload: { claimId, reviewId: review.id, as: 'decision', ref: null },
  });
  const payload = outingDecision(ctx, { placeId, castIds, startAt, minutes, label, kind: castIds.length ? 'hangout' : 'outing', adopted: true, claimId });
  const opened = b.add({ type: 'decision.opened', actor: 'engine', at: ctx.now, causeRef: adopted, ...sub, payload });
  const lean = b.add({
    type: 'decision.lean', actor: 'engine', at: ctx.now, causeRef: opened, ...sub,
    payload: { optionId: 'go', p: 1, probs: { go: 1 }, trigger: 'new_info' }, payloadRefs: { decisionId: opened },
  });
  b.add({
    type: 'decision.committed', actor: 'engine', at: ctx.now, causeRef: lean, ...sub,
    payload: { optionId: 'go', p: 1, sampled: false, by: 'adopted' }, payloadRefs: { decisionId: opened },
  });
  return adopted;
}

function planOutingScene(action, ctx, b, shape) {
  const { state } = ctx;
  const out = { slices: ['decisions'] };
  const castIds = [...new Set((Array.isArray(action.castIds) ? action.castIds : []).map(id => castRef(state, id)))];
  if (castIds.length > 4) throw err('invalid', 'bad_castIds');
  if (shape === 'visit' && !castIds.length && !action.newCast) throw err('invalid', 'bad_castIds');
  const startAt = startTime(action.startAt, ctx);
  const minutes = minutesOf(action.minutes);
  const label = action.label === undefined ? null : cleanOwnerText(action.label, TEXT_CAPS.label, ctx, { field: 'label' });

  const venueId = action.candidateId !== undefined && action.candidateId !== null;
  if (venueId && (shape !== 'outing' || action.newPlace || (action.placeId !== undefined && action.placeId !== null))) throw err('invalid', 'bad_fields');
  if (action.fromReviewId !== undefined && action.fromReviewId !== null) {
    if (action.newPlace || action.newCast || venueId) throw err('invalid', 'bad_fields');
    const review = reviewFor(action.fromReviewId);
    const placeId = shape === 'visit' ? state.self?.homePlaceId : placeRef(state, action.placeId);
    if (!placeId) throw err('refused', 'no_home');
    const v = controlsCheck({ source: 'owner', category: 'social', action: 'adopt', pinKeys: castIds }, state);
    if (!v.ok) { refuse(b, { reason: v.reason, target: `review:${review.id}`, pinKey: v.pinKey }); return out; }
    if (futureAdoptions(state, ctx.now) >= FUTURE_ADOPTIONS_MAX) { refuse(b, { reason: 'cap', target: `review:${review.id}` }); return out; }
    const subjectJid = typeof review.resolution?.subjectJid === 'string' ? review.resolution.subjectJid : null;
    const first = adoptionChain(b, ctx, review, { placeId, castIds, startAt, minutes, label, subjectJid });
    const parent = b.add({ type: 'director.action', actor: 'owner', at: ctx.now, payload: { kind: action.kind, previewAt: ctx.now, count: 0, shape } });
    finishParent(b, parent, { eventRefs: b.events.filter(e => e.ref !== parent).map(e => e.ref) });
    b.warnings.push(FROM_CLAIM);
    return { ...out, post: { review: { id: review.id, claimId: review.claimId, status: 'adopted', adoptedRef: first } } };
  }

  const parent = ownerParent(b, action, ctx.now);
  let placeId;
  if (shape === 'visit') {
    placeId = state.self?.homePlaceId;
    if (!placeId) throw err('refused', 'no_home');
  } else if (venueId) {
    // 014 geo: a real venue picked from a lookup (preview resolved the candidate
    // once; the search kept it inside his region) → its place.created {venue}
    // (opaque id; an existing place with the same venue is reused) and routes,
    // caused by this change, then the outing at it — one apply.
    placeId = venueRange(action, ctx, b, { parent });
  } else if (action.newPlace) {
    const np = newPlacePayload(action.newPlace, ctx);
    b.add({ type: 'place.created', actor: 'owner', at: ctx.now, causeRef: parent, payload: np });
    placeId = np.id;
    if (looksRealPlace(np.name, state)) warn(b, LOOKS_REAL_PLACE, 'warn', { placeIds: [np.id] });
  } else {
    placeId = placeRef(state, action.placeId);
  }
  if (action.newCast) {
    const nc = newCastPayload(action.newCast, ctx);
    b.add({ type: 'cast.created', actor: 'owner', at: ctx.now, causeRef: parent, payload: nc });
    castIds.push(nc.id);
  }
  // A place/cast created in this batch isn't in the projection yet: plan against a copy that has them.
  const planState = action.newPlace || action.newCast || venueId ? withCreated(state, b.events) : state;
  const payload = outingDecision({ ...ctx, state: planState }, {
    placeId, castIds, startAt, minutes, label, kind: shape === 'visit' ? 'visit' : (castIds.length ? 'hangout' : 'outing'),
  });
  const opened = b.add({ type: 'decision.opened', actor: 'owner', at: ctx.now, causeRef: parent, payload });
  b.add({
    type: 'decision.committed', actor: 'owner', at: ctx.now, causeRef: opened,
    payload: { optionId: 'go', p: 1, sampled: false, by: 'owner' }, payloadRefs: { decisionId: opened },
  });
  const conflicts = outingClashes(action, ctx, b, opened, { from: startAt, to: startAt + minutes * MIN });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return conflicts.length ? { ...out, slices: ['decisions', 'plan'], extra: { conflicts } } : out;
}

// 2026-11-02 (clash at setup): the plans the new outing's window runs into are
// conflict rows the owner resolves (014's row shape + `resolutions`, KEEP IT
// INSTEAD in the modal). Cancel by default — his new plan wins: an engine
// decision.expired {owner_plan} caused by the new decision (no trust cost; a goal
// reopens), today's plan refilled without it. Keep leaves both committed: the
// pulse's locked-wins rule decides on the day (continuity: overlaps_plan). A plan
// made in a chat and a story decision are keep-only. Parts of the same bundle
// (preview ids) are never rows. → the owner's view of the rows.
function outingClashes(action, ctx, b, openedRef, win) {
  const { state } = ctx;
  const rows = planEdits.outingConflicts(state, win, {
    now: ctx.now, resolutions: isObj(action.resolutions) ? action.resolutions : {},
  }).filter(r => r.id < PREVIEW_ID_BASE);
  const drop = [];
  let last = null;
  for (const r of rows) {
    if (r.outcome !== 'cancelled') continue;
    last = b.add({ type: 'decision.expired', actor: 'engine', at: ctx.now, causeRef: openedRef,
      payload: { decisionId: r.id, reason: 'owner_plan' }, ...(r.subjectJid ? { subjectJid: r.subjectJid } : {}) });
    if (r.type === 'goal') b.warnings.push(SCHEDULE_REOPEN);
    if (r.fromChat) warnChatPlan(b, state.decisions?.get?.(r.id));
    const inPlan = state.plan?.amendedFor === r.id || (state.plan?.blocks ?? []).some(x => x.decisionId === r.id);
    if (inPlan) drop.push(r.id);
  }
  if (drop.length && last) replanAfter(b, ctx, last, { dropDecisionIds: drop });
  return rows.map(({ subjectJid, fromChat, story, ...r }) => {
    const d = state.decisions?.get?.(r.id);
    return { ...r, clash: true, ...(fromChat ? { fromChat: true } : {}), ...(story ? { story: true } : {}),
      // A plan kept beside the new outing: who holds the time on the day, and whether a real person hears (the warning's words).
      ...(r.outcome === 'kept' ? { keptWins: d?.committed?.by === 'owner', ...(tellsThem(d, null) ? { tells: true } : {}) } : {}) };
  });
}

function withCreated(state, events) {
  const s = structuredClone(state);
  for (const e of events) {
    if (e.type === 'place.created') s.places.set(e.payload.id, { ...e.payload });
    if (e.type === 'cast.created') s.cast.set(e.payload.id, { ...e.payload });
  }
  return s;
}

// action.kind names the action ('scene', 'place.edit'), so the contract's per-shape
// `kind` field travels as beatKind | arcKind | heavyKind | placeKind — or inside a
// nested `fields` object as plain `kind` (either spelling works).
function withKindAlias(action, name) {
  if (action[name] !== undefined || !isObj(action.fields) || action.fields.kind === undefined) return action;
  return { ...action, [name]: action.fields.kind };
}

function planScene(actionIn, ctx, b) {
  const shape = actionIn.shape;
  const alias = { 'cast.beat': 'beatKind', 'arc.start': 'arcKind', heavy: 'heavyKind', new_place: 'placeKind' }[shape];
  const action = alias ? withKindAlias(actionIn, alias) : actionIn;
  if (!SCENE_SHAPES.includes(shape)) throw err('invalid', 'bad_shape');
  const { state, now } = ctx;
  if (shape === 'outing' || shape === 'visit') return planOutingScene(action, ctx, b, shape);
  const fromClaim = action.fromReviewId !== undefined && action.fromReviewId !== null;
  const post = fromClaim ? { review: { id: reviewFor(action.fromReviewId).id, status: 'dismissed' } } : null;
  if (fromClaim) b.warnings.push(FROM_CLAIM);
  b.warnings.push(VISIBLE_EVERYWHERE);
  switch (shape) {
    case 'cast.history': return { ...planCastHistory({ ...action, kind: 'cast.history' }, ctx, b), post };
    case 'cast.beat': {
      const castId = castRef(state, action.castId);
      const kind = BEAT_KINDS.has(action.beatKind) ? action.beatKind : null;
      if (!kind) throw err('invalid', 'bad_beatKind');
      const text = cleanOwnerText(action.text, TEXT_CAPS.beat, ctx, { field: 'text' });
      let until = null;
      if (action.until !== undefined && action.until !== null) {
        until = posInt(action.until);
        if (!until || until <= now || until > now + 31 * DAY) throw err('invalid', 'bad_until');
      }
      if (pinOf(castId, state) && !ctx.relax) { refuse(b, { reason: 'pinned', target: castId, pinKey: castId }); return { slices: [`story.castLife.${castId}`], post }; }
      if (pinOf(castId, state)) warn(b, 'overrides_pin', 'warn', { pinKey: castId });   // 015
      const parent = ownerParent(b, action, now);
      b.add({ type: 'cast.beat', actor: 'owner', at: now, causeRef: parent, payload: { castId, kind, text, ...(until ? { until } : {}) } });
      finishParent(b, parent);
      return { slices: [`story.castLife.${castId}`], post };
    }
    case 'new_cast': {
      const nc = newCastPayload(action, ctx);
      const parent = ownerParent(b, action, now);
      b.add({ type: 'cast.created', actor: 'owner', at: now, causeRef: parent, payload: nc });
      finishParent(b, parent);
      return { slices: ['cast'], post };
    }
    case 'new_place': {
      const np = newPlacePayload({ ...action, kind: action.placeKind }, ctx);
      const parent = ownerParent(b, action, now);
      b.add({ type: 'place.created', actor: 'owner', at: now, causeRef: parent, payload: np });
      finishParent(b, parent);
      if (looksRealPlace(np.name, state)) warn(b, LOOKS_REAL_PLACE, 'warn', { placeIds: [np.id] });
      return { slices: ['places'], post };
    }
    case 'arc.start': {
      const category = action.category;
      const kinds = ARC_KINDS[category];
      if (!kinds) throw err('invalid', 'bad_category');
      if (!kinds.includes(action.arcKind)) throw err('invalid', 'bad_kind');
      const kind = action.arcKind;
      const castIds = [...new Set((Array.isArray(action.castIds) ? action.castIds : []).map(id => castRef(state, id)))].slice(0, 4);
      let endsRomance = null;
      if (category === 'romance') {
        if (castIds.length !== 1) throw err('invalid', 'bad_castIds');
        // 015 hard limit (content safety): never a romance with family.
        if (/^family:/.test(state.cast.get(castIds[0])?.relation ?? '')) throw err('refused', 'family_romance');
        if (state.story?.romance?.arcId) {
          if (!ctx.relax) throw err('refused', 'romance_active');
          endsRomance = state.story.romance.arcId;   // 015: the batch ends the open one first
          warn(b, 'ends_current_romance', 'warn', { arcIds: [endsRomance] });
        }
        const cd = state.story?.romance?.cooldownUntil;
        if (finite(cd) && cd > now) warn(b, 'romance_cooldown', 'info');
      }
      const payload = { category, kind, castIds, stage: category === 'romance' ? 'interested' : 'started' };
      const v = controlsCheck({ source: 'owner', category, action: 'start', pinKeys: pinKeysFor({ type: 'arc.started', payload }, state) }, state);
      if (!relaxOr(b, ctx, v, `arc:${category}`)) return { slices: ['story.arcs'], post };
      const parent = ownerParent(b, action, now);
      if (endsRomance) b.add({ type: 'arc.ended', actor: 'owner', at: now, causeRef: parent, payload: { arcId: endsRomance, outcome: 'cancelled' } });
      b.add({ type: 'arc.started', actor: 'owner', at: now, causeRef: parent, payload });
      finishParent(b, parent);
      return { slices: ['story.arcs', 'story.romance', 'self'], post };
    }
    case 'arc.stage': {
      const arcId = posInt(action.arcId);
      const arc = arcId ? state.story?.arcs?.[arcId] : null;
      if (!isObj(arc) || arc.status !== 'active') throw err('not_found', 'arc');
      if (arc.category !== 'romance') throw err('invalid', 'unsupported');
      const from = ROMANCE_STAGES.indexOf(arc.stage);
      const to = ROMANCE_STAGES.indexOf(action.to);
      // 015: a hand-built owner step may jump stages (an info warning); drafts stay ±1.
      if (to < 1 || to === from || (Math.abs(to - from) !== 1 && !ctx.relax)) throw err('invalid', 'not_adjacent');
      if (Math.abs(to - from) > 1) warn(b, 'stage_jump', 'info', { arcIds: [arcId] });
      const payload = { arcId, from: arc.stage, to: action.to, reason: 'owner' };
      const v = controlsCheck({ source: 'owner', category: 'romance', action: 'change', pinKeys: pinKeysFor({ type: 'arc.stage', payload }, state) }, state);
      if (!relaxOr(b, ctx, v, `arc:${arcId}`)) return { slices: ['story.arcs'], post };
      const parent = ownerParent(b, action, now);
      b.add({ type: 'arc.stage', actor: 'owner', at: now, causeRef: parent, payload });
      finishParent(b, parent);
      return { slices: ['story.arcs', 'story.romance', 'self'], post };
    }
    case 'heavy': {
      const input = action.themeId !== undefined && action.themeId !== null
        ? { themeId: action.themeId, durationDays: action.durationDays, castId: action.castId }
        : { kind: action.heavyKind, label: action.label, durationDays: action.durationDays, castId: action.castId };
      if (input.label !== undefined && typeof input.label === 'string') {
        if (input.label.length > TEXT_CAPS.label) throw err('invalid', 'too_long');
        if (JID_IN_TEXT_RE.test(input.label)) throw err('invalid', 'jid_in_text');
      }
      const r = ownerHeavyPlan(input, state, { at: now, seed: ctx.seed, world: ctx.world, lastHeavyAt: ctx.lastHeavyAt(), knownNames: ctx.knownNames, relax: ctx.relax });
      if (!r.ok) {
        const code = ['forbidden_theme', 'invalid'].includes(r.code) ? 'invalid' : 'refused';
        throw err(code, r.code === 'invalid' ? 'bad_heavy' : r.code);
      }
      // 015 (plan §1.4): a hand-built heavy start over the pacing / the owner's own
      // guardrails warns (high: it needs the tick); a frozen heavy fate keeps binding
      // the engine (no "fate natural" suggestion).
      for (const code of r.warnings ?? []) {
        warn(b, code, code === 'overrides_pin' || code === 'overrides_frozen' || code === 'heavy_gap' ? 'high' : 'warn');
      }
      const parent = ownerParent(b, action, now);
      if (r.endsActive) b.add({ type: 'heavy.ended', actor: 'owner', at: now, causeRef: parent, payload: { heavyId: r.endsActive, reason: 'owner' } });
      const started = b.add({ type: 'heavy.started', actor: 'owner', at: now, causeRef: parent, heavy: true, payload: r.payload });
      for (const e of r.effects(started)) {
        const { causeId, ...rest } = e;
        b.add({ ...rest, actor: 'engine', at: now, causeRef: started });
      }
      finishParent(b, parent);
      b.warnings.push('starts the heavy guard and the 12 h embargo');
      return { slices: ['story.heavy', 'vitals', 'sick', 'embargo'], post };
    }
    default:
      throw err('invalid', 'bad_shape');
  }
}

// ── Tray adoption ─────────────────────────────────────────────────────────

function localLabel(state, { kind, placeId, castIds, subjectJid }) {
  const parts = [String(kind || 'plan').replace(/[_:-]+/g, ' ')];
  const place = placeId ? state.places?.get?.(placeId)?.name : null;
  if (place) parts.push(`at ${place}`);
  const names = castIds.map(id => state.cast?.get?.(id)?.name?.split(/\s+/)[0]).filter(Boolean);
  if (subjectJid) names.push('a friend from this chat');
  if (names.length) parts.push(`with ${names.join(' and ')}`);
  return parts.join(' ').slice(0, 120);
}

function planTrayAdopt(action, ctx, b) {
  const { state, now } = ctx;
  const review = reviewFor(action.reviewId);
  const ex = isObj(review.extraction) ? review.extraction : null;
  const res = isObj(review.resolution) ? review.resolution : {};
  if (!ex) throw err('refused', 'not_extracted');
  if (!ADOPTABLE.has(ex.type)) throw err('refused', 'out_of_scope');
  const castIds = new Set(Array.isArray(res.castIds) ? res.castIds.filter(id => state.cast?.has?.(id)) : []);
  if (isObj(action.castMap)) for (const id of Object.values(action.castMap)) castIds.add(castRef(state, id));
  const cast = [...castIds].slice(0, 4);
  const placeId = action.placeId !== undefined && action.placeId !== null ? placeRef(state, action.placeId)
    : (typeof res.placeId === 'string' && state.places?.has?.(res.placeId) ? res.placeId : null);
  const start = action.startAt !== undefined && action.startAt !== null ? posInt(action.startAt) : posInt(res.span?.start);
  if (!start) throw err('invalid', 'bad_startAt');
  const minutes = action.minutes !== undefined && action.minutes !== null ? minutesOf(action.minutes)
    : clamp(Math.round(((posInt(res.span?.end) ?? start + 90 * MIN) - start) / MIN), 15, 360);
  const subjectJid = typeof res.subjectJid === 'string' ? res.subjectJid : null;
  const kind = typeof ex.kind === 'string' && KIND_SLUG_RE.test(ex.kind) ? ex.kind : ex.type;
  const resolution = { ...res, kind, placeId, castIds: cast, subjectJid, span: { start, end: start + minutes * MIN } };
  let label;
  try { label = typeof deps.labelFor === 'function' ? deps.labelFor(resolution, state) : null; } catch { label = null; }
  label = typeof label === 'string' && label.trim() ? label.slice(0, 120) : localLabel(state, resolution);

  const v = controlsCheck({ source: 'owner', category: cast.length ? 'social' : 'cast', action: 'adopt', pinKeys: cast }, state);
  if (!v.ok) { refuse(b, { reason: v.reason, target: `review:${review.id}`, pinKey: v.pinKey }); return { slices: ['decisions'] }; }
  if (typeof deps.fit === 'function') {
    let f = null;
    try { f = deps.fit(resolution.span, state, ctx.world, { type: ex.type, placeId, now }); } catch { f = null; }
    // reconciler.fit → null when it fits, {with:{…}} on a conflict (an {ok:false} shape is accepted too).
    if (f && (f.ok === false || isObj(f.with))) { refuse(b, { reason: 'conflict', target: `review:${review.id}` }); return { slices: ['decisions'] }; }
  } else {
    b.warnings.push('calendar fit not checked');
  }
  const asDecision = ex.type === 'plan' && placeId && start >= now - 60;
  if (asDecision && futureAdoptions(state, now) >= FUTURE_ADOPTIONS_MAX) {
    refuse(b, { reason: 'cap', target: `review:${review.id}` });
    return { slices: ['decisions'] };
  }
  let first;
  if (asDecision) {
    first = adoptionChain(b, ctx, review, { placeId, castIds: cast, startAt: start, minutes, label, subjectJid });
  } else {
    const sub = subjectJid ? { subjectJid } : {};
    const as = ex.type === 'activity' || start < now ? 'activity' : 'commitment';
    first = b.add({ type: 'claim.adopted', actor: 'engine', at: now, causeId: review.claimEventId, ...sub, payload: { claimId: review.claimId, reviewId: review.id, as, ref: null } });
    if (as === 'activity') {
      b.add({ type: 'activity.recorded', actor: 'engine', at: now, causeRef: first, ...sub, payload: { kind, ...(placeId ? { placeId } : {}), castIds: cast, startAt: start, endAt: start + minutes * MIN, label } });
    } else {
      b.add({ type: 'commitment.recorded', actor: 'engine', at: now, causeRef: first, ...sub, payload: { dueAt: start, ...(placeId ? { placeId } : {}), castIds: cast, label } });
    }
  }
  const parent = b.add({ type: 'director.action', actor: 'owner', at: now, payload: { kind: action.kind, previewAt: now, count: 0 } });
  finishParent(b, parent, { eventRefs: b.events.filter(e => e.ref !== parent).map(e => e.ref) });
  return { slices: ['decisions', 'story.adopted', 'story.commitments'], post: { review: { id: review.id, claimId: review.claimId, status: 'adopted', adoptedRef: first } } };
}

function planProposalApprove(action, ctx, b) {
  const id = posInt(action.proposalId);
  const p = id ? store.getProposal(id) : null;
  if (!p) throw err('not_found', 'proposal');
  if (p.status !== 'pending') throw err('conflict', 'proposal_state');
  if (typeof deps.proposalDescriptors !== 'function') throw err('refused', 'unsupported');
  const r = deps.proposalDescriptors(p, ctx.state, { now: ctx.now, world: ctx.world, baseWorld: ctx.baseWorld, seed: ctx.seed, knownNames: ctx.knownNames }) || {};
  for (const w of r.warnings ?? []) b.warnings.push(String(w).slice(0, 120));
  for (const x of r.refusals ?? []) refuse(b, x);
  const list = Array.isArray(r.events) ? r.events : [];
  if (!list.length) return { slices: ['cast', 'places', 'story'] };
  const parent = ownerParent(b, action, ctx.now);
  b.events.find(e => e.ref === parent).payload.proposalId = id;   // REVERT THIS CHANGE reopens the row
  const map = new Map();
  for (const e of list) {
    const { ref, causeRef, ...rest } = e;
    const nref = b.add({ ...rest, actor: 'mind', at: ctx.now, causeRef: causeRef && map.has(causeRef) ? map.get(causeRef) : parent });
    if (ref) map.set(ref, nref);
  }
  finishParent(b, parent);
  return { slices: ['cast', 'places', 'story.castLife', 'decisions'], post: { proposal: { id, status: 'applied' } } };
}

// ── 015 Director as god: the opened owner powers (plan §P1) ──────────────
// Every planner here is an ordinary Director action (preview → apply, revert /
// rewind). For a hand-built owner preview (opts.relax, the route's
// source !== 'prompt') the pacing limits and the owner's own guardrails (pins,
// a frozen category) come back as continuity warnings instead of refusals;
// model drafts plan without relax and keep 010/011's refusals (plan §1.4).
// Hard limits stay refusals: privacy (chat-made plans are never targets), content
// safety (family_romance, heavy forbidden themes), structural size caps and
// structural impossibilities (plan §1.7).

export const GOD_ACTION_KINDS = Object.freeze(['decision.pick', 'outcome', 'career', 'money', 'home', 'mood', 'health',
  'arc.end', 'cast.depart', 'cast.return']);
export const CAREER_CHANGES = CAREER_REASONS;
export const MONEY_MODES = Object.freeze(['set', 'income', 'expense']);
export const MOOD_PRESETS = Object.freeze({
  exhausted: Object.freeze({ energy: -30, stress: 10 }),
  energised: Object.freeze({ energy: 25, valence: 0.15 }),
  low: Object.freeze({ valence: -0.3, energy: -10 }),
  great: Object.freeze({ valence: 0.3, energy: 10, stress: -10 }),
  stressed: Object.freeze({ stress: 25, valence: -0.1 }),
  calm: Object.freeze({ stress: -20, valence: 0.1 }),
});
export const MOOD_CAPS = Object.freeze({ energy: 30, stress: 30, workPressure: 30, socialBattery: 30, valence: 0.4 });
export const HEALTH_CHANGES = Object.freeze(['sick', 'well']);
export const ARC_END_OUTCOMES = Object.freeze(['fizzled', 'broken_up', 'done', 'cancelled']);
export const HOME_FLATMATE = Object.freeze(['stays', 'leaves', 'comes']);
export const GOD_CHANGE = 'a god change: rewrites his future from now';
export const WEIGHTY = 'a big life change — he may mention it in any chat';
export const WAKE_DAYS_MAX = 13;
export const SICK_DAYS_MAX = 14;
export const MONEY_MAX = 1e9;
const MOOD_SOON_SEC = 10 * MIN;
const CHURN_SEC = 30 * DAY;
const OUTING_CATEGORIES = new Set(['social']);
const STORY_CATEGORIES = new Set(['career', 'romance', 'family', 'heavy']);

// What a planner's own continuity code means (the preview modal shows it; codes without
// an entry read as their words). Integrated from the P1 modal's tooltip table.
const WARNING_TEXT = Object.freeze({
  messages_real_person: 'this sends a WhatsApp message in that chat',
  sick_promises: 'he is sick through a plan he promised: it falls through',
  overrides_pin: 'overrides a pin for this change only; the pin still binds the engine',
  overrides_frozen: 'overrides a frozen category for this change only; the freeze still binds the engine',
  heavy_gap: 'less than the usual gap since the last heavy stretch',
  ends_active_heavy: 'ends the heavy stretch in progress first',
  ends_current_romance: 'ends the romance in progress first',
  stage_jump: 'jumps more than one relationship stage',
  job_loss_big: 'losing his job is a big change: consider a mood or a heavy stretch too',
  departs_partner: 'writes out his partner: the romance ends',
  money_negative: 'his balance goes below zero',
  reverses_commit: 'changes his mind on a plan he had made',
  outcome_needs_go: 'only happens if he actually goes',
  tone_needs_go: 'the hint only matters if he actually goes',   // 016
  romance_cooldown: 'a new romance soon after the last one ended',
  romance_cooldown_set: 'no new romance for a while after this',
  venue_negative: 'a bad outing at a real place: the place is called by its kind (a cafe, a restaurant) wherever this shows',
  salary_jump: 'his salary changes by more than 30 %',
  job_churn: 'another job change within 30 days',
  notice_active: 'he was already serving notice',
  hunt_active: 'he was already looking for a new job; the hunt ends',
  pattern_all_office: 'no work-from-home days left',
  closes_career_decision: 'closes an open career decision',
  money_jump: 'a change of more than six months of spending',
  move_churn: 'he moved less than 30 days ago',
  mood_vs_state: 'an energised day while he is sick or in a hard stretch',
  sick_long: 'ill for more than a week',
  two_places: 'he has another plan then',
  chat_plan_kept: 'a plan he made in a chat stays',
  looks_real_place: 'this looks like a real place; use the place search',
  outside_partner: 'this is not his partner',
});
/** The looks-real safety net (an invented place named like a real venue): code + text. */
export const LOOKS_REAL_PLACE = 'looks_real_place';
export const LOOKS_REAL_TEXT = WARNING_TEXT.looks_real_place;

export const __test = { WARNING_TEXT };

/** A continuity warning (P2's checker merges its own findings into the same list). */
function warn(b, code, severity = 'info', refs = null, { fromChat = false } = {}) {
  if (!Array.isArray(b.continuity)) b.continuity = [];
  if (b.continuity.some(w => w.code === code)) return;
  b.continuity.push({ code, severity, ...(WARNING_TEXT[code] ? { text: WARNING_TEXT[code] } : {}), ...(refs ? { refs } : {}),
    ...(fromChat ? { fromChat: true } : {}) });
}

const subjectOfPlan = (d) => (typeof d?.subjectJid === 'string' ? { subjectJid: d.subjectJid } : {});

// Would this change really send a real person a message? (Nothing wired → no.)
function tellsThem(d, to) {
  if (!d || typeof deps.willTellBackOut !== 'function') return false;
  try { return deps.willTellBackOut(d, { to }) === true; } catch { return false; }
}
// HIGH: the owner ticks I KNOW. From-chat, so the story read never sees it.
function warnTells(b, d, to) {
  if (tellsThem(d, to)) warn(b, 'messages_real_person', 'high', { decisionIds: [d.id] }, { fromChat: true });
}
// The cancel's words say what is true of this plan.
function warnChatPlan(b, d) {
  if (tellsThem(d, null)) {
    b.warnings.push(CHAT_PLAN_TOLD);
    warnTells(b, d, null);
  } else {
    b.warnings.push(CHAT_PLAN);
  }
}

/** An owner refusal that a hand-built preview turns into a warning (plan §1.4). */
function relaxOr(b, ctx, verdict, target) {
  if (verdict.ok) return true;
  if (!ctx.relax) { refuse(b, { reason: verdict.reason, target, pinKey: verdict.pinKey }); return false; }
  warn(b, verdict.reason === 'pinned' ? 'overrides_pin' : 'overrides_frozen', 'warn', verdict.pinKey ? { pinKey: verdict.pinKey } : null);
  return true;
}

function ownerControls(ctx, category, action, pinKeys) {
  return controlsCheck({ source: 'owner', category, action, pinKeys }, ctx.state);
}

function decisionRef(state, id) {
  const n = posInt(id);
  const d = n && state.decisions instanceof Map ? state.decisions.get(n) : null;
  if (!d) throw err('not_found', 'decision');
  return d;
}

// A time `when` resolved to startAt (resolveTimes) or a unix startAt; null when absent.
function laterTime(action, ctx) {
  if (action.startAt === undefined || action.startAt === null) return null;
  return startTime(action.startAt, ctx);
}

/** Today's re-plan after the batch so far (folded), as an engine plan.made caused by `causeRef`. */
function replanAfter(b, ctx, causeRef, { dropDecisionIds = [] } = {}) {
  const base = ctx.baseWorld ?? ctx.world;
  if (!base) return null;
  let s1;
  try { s1 = foldDescriptors(ctx.state, b.events, base); } catch { return null; }
  let plan = null;
  try { plan = replanFor(s1, ctx.now, worldOverlay(s1, base), { dropDecisionIds }); } catch { plan = null; }
  if (!plan) return null;
  return b.add({ type: 'plan.made', actor: 'engine', at: ctx.now, causeRef, payload: plan });
}

function consequenceApplied(d) {
  const id = posInt(d?.committed?.eventId);
  if (!id) return false;
  try {
    return cascadeIds(id).filter(x => x !== id).some((x) => {
      const e = getEvent(x);
      return e && !ROUTINE_TYPES.has(e.type) && e.type !== 'decision.lean';
    });
  } catch { return true; }   // fail closed: can't tell → treat as happened
}

function planPick(action, ctx, b) {
  const { state, now } = ctx;
  const d = decisionRef(state, action.decisionId);
  const optionId = typeof action.optionId === 'string' && d.options?.some?.(o => o.id === action.optionId) ? action.optionId : null;
  if (!optionId) throw err('invalid', 'bad_optionId');
  const out = { slices: ['decisions'] };
  if (d.status === 'open') {
    if (!availableOptions(d, now).some(o => o.id === optionId)) throw err('refused', 'option_gone');
    if (!relaxOr(b, ctx, ownerControls(ctx, CATEGORIES.includes(d.category) ? d.category : 'social', 'change', decisionPinKeys(d, state)), `decision:${d.id}`)) return out;
    const parent = ownerParent(b, action, now);
    // 020: a real person's plan keeps its subject on every event, so it stays out of other audiences, the journal and the site.
    b.add({ type: 'decision.committed', actor: 'owner', at: now, causeRef: parent, ...subjectOfPlan(d), payload: { decisionId: d.id, optionId, sampled: false, by: 'owner' } });
    finishParent(b, parent);
    warnTells(b, d, optionId);
    if (!planEdits.chatMadeDecision(d)) b.warnings.push(VISIBLE_EVERYWHERE);   // a chat's plan stays that chat's (pulse.chatPlanOrigin)
    return out;
  }
  if (d.status !== 'committed') throw err('refused', 'closed');
  if (d.committed?.optionId === optionId) throw err('refused', 'nothing');
  if (STORY_CATEGORIES.has(d.category) || consequenceApplied(d)) throw err('refused', 'consequence_applied');
  if (finite(d.ponrAt) && now >= d.ponrAt) throw err('refused', 'past_ponr');
  if (!availableOptions(d, now).some(o => o.id === optionId)) throw err('refused', 'option_gone');
  if (!relaxOr(b, ctx, ownerControls(ctx, CATEGORIES.includes(d.category) ? d.category : 'social', 'change', decisionPinKeys(d, state)), `decision:${d.id}`)) return out;
  const parent = ownerParent(b, action, now);
  b.add({ type: 'decision.reversed', actor: 'owner', at: now, causeRef: parent, ...subjectOfPlan(d), payload: { decisionId: d.id, from: d.committed.optionId, to: optionId, by: 'owner' } });
  finishParent(b, parent);
  warn(b, 'reverses_commit', 'info', { decisionIds: [d.id] });
  warnTells(b, d, optionId);
  if (!planEdits.chatMadeDecision(d)) b.warnings.push(VISIBLE_EVERYWHERE);
  return out;
}

// Is decision `d`'s outing over at `now` (its end, else its time + the go minutes)?
// Undated → not over.
function outingOver(d, now) {
  const eventAt = finite(d?.subject?.eventAt) ? d.subject.eventAt : null;
  const minutes = d?.options?.find?.(o => o.id === 'go')?.minutes ?? 90;
  const endAt = finite(d?.subject?.endAt) ? d.subject.endAt : (eventAt ? eventAt + minutes * MIN : null);
  return finite(endAt) && endAt <= now;
}

function planOutcome(action, ctx, b) {
  const { state, now, tz } = ctx;
  const d = decisionRef(state, action.decisionId);
  const outcome = OUTCOMES.includes(action.outcome) ? action.outcome : null;
  if (!outcome) throw err('invalid', 'bad_outcome');
  if (d.status !== 'open' && d.status !== 'committed') throw err('refused', 'closed');
  // 020: a plan made in a chat is the owner's to change too. No invented outcome about a real person, though.
  if (d.subjectJid && outcome !== 'cancelled') throw err('refused', 'real_person');
  const outing = OUTING_CATEGORIES.has(d.category) || isEvening(d);
  if (!outing || (typeof d.category === 'string' && STORY_CATEGORIES.has(d.category))) throw err('refused', 'use_arc_action');
  if (!d.options?.some?.(o => o.id === 'go')) throw err('refused', 'use_arc_action');
  const eventAt = finite(d.subject?.eventAt) ? d.subject.eventAt : null;
  const minutes = d.options.find(o => o.id === 'go')?.minutes ?? 90;
  const endAt = finite(d.subject?.endAt) ? d.subject.endAt : (eventAt ? eventAt + minutes * MIN : null);
  if (!eventAt || !endAt || endAt <= now) throw err('refused', 'past');
  if (isObj(state.story?.outcomes?.[d.id]) && state.story.outcomes[d.id].status === 'set') throw err('refused', 'outcome_set');
  const later = laterTime(action, ctx);
  const parent = ownerParent(b, action, now);
  if (outcome === 'cancelled') {
    const dflt = Math.max(now, (finite(d.ponrAt) ? d.ponrAt : eventAt) - 30 * MIN);
    const cancelAt = later ? Math.min(later, eventAt) : dflt;
    const set = b.add({ type: 'outcome.set', actor: 'owner', at: now, causeRef: parent, ...subjectOfPlan(d), payload: { decisionId: d.id, outcome, cancelAt } });
    if (eventAt <= now + 30 * MIN || cancelAt <= now) {
      // The cancel happens now: engine expiry + the re-plan without its blocks (both cascade).
      const exp = b.add({ type: 'decision.expired', actor: 'engine', at: now, causeRef: set, ...subjectOfPlan(d), payload: { decisionId: d.id, reason: 'fell_through' } });
      replanAfter(b, ctx, exp, { dropDecisionIds: [d.id] });
    }
    if (posInt(d.goalId)) b.warnings.push('its goal reopens for another day');
    if (planEdits.chatMadeDecision(d)) warnChatPlan(b, d);
  } else {
    b.add({ type: 'outcome.set', actor: 'owner', at: now, causeRef: parent, payload: { decisionId: d.id, outcome } });
    // 016: an optional tone hint for the scene, in the same batch; its outcome word is this outcome (R23).
    const tone = action.tone === undefined || action.tone === null || action.tone === '' ? null : cleanOwnerText(action.tone, 120, ctx, { field: 'tone' });
    if (tone && d.subjectJid) throw err('refused', 'real_person');
    if (tone) b.add({ type: 'scene.tone_set', actor: 'owner', at: now, causeRef: parent, payload: { decisionId: d.id, tone, outcome } });
    if (d.status === 'open' || !['go', 'late'].includes(d.committed?.optionId)) warn(b, 'outcome_needs_go', 'info', { decisionIds: [d.id] });
    const place = d.subject?.placeId ? state.places?.get?.(d.subject.placeId) : null;
    if (outcome === 'badly' && isVenue(place)) warn(b, 'venue_negative', 'info', { placeIds: [place.id] });
  }
  finishParent(b, parent);
  if (!d.subjectJid) b.warnings.push(VISIBLE_EVERYWHERE);
  b.warnings.push(`happens at ${localWhen(outcome === 'cancelled' ? Math.max(now, later ?? now) : endAt, tz)}`);
  return { slices: ['decisions', 'story.outcomes', 'plan'] };
}

// 016 (plan §P2.3): the owner's hint for how an outing should go — its scene play-out
// follows it (a tone makes the scene owner-directed → the mind tier). An open or
// committed outing-like decision with a go option, not a chat's plan, not yet over, no
// real person there (D17). The hint carries an outcome word (well / fine / flat / badly,
// R23) that sets the scene's outcome, so the hint can never contradict it; a 015 owner
// outcome on the same decision that disagrees → refused outcome_conflict.
export const SCENE_TONE_OUTCOMES = Object.freeze(['well', 'fine', 'flat', 'badly']);
/** 016: may this decision take a scene tone hint (an outing-like one with a go option, not a chat's plan)? */
export function sceneToneable(d) {
  if (!d || d.subjectJid) return false;   // never a story about a real person (020: other chat plans may take a tone)
  const outing = OUTING_CATEGORIES.has(d.category) || d.category === 'family' || isEvening(d);
  return outing && !!d.options?.some?.(o => o.id === 'go');
}

function planSceneTone(action, ctx, b) {
  const { state, now, tz } = ctx;
  const d = decisionRef(state, action.decisionId);
  if (d.status !== 'open' && d.status !== 'committed') throw err('refused', 'closed');
  if (d.subjectJid) throw err('refused', 'real_person');
  if (!sceneToneable(d)) throw err('refused', 'not_outing');
  const outcome = action.outcome;
  if (!SCENE_TONE_OUTCOMES.includes(outcome)) throw err('invalid', 'outcome_required', { field: 'outcome' });
  const owner = state.story?.outcomes?.[d.id];
  if (isObj(owner) && (owner.outcome === 'well' || owner.outcome === 'badly') && owner.outcome !== outcome) throw err('refused', 'outcome_conflict');
  const eventAt = finite(d.subject?.eventAt) ? d.subject.eventAt : null;
  const minutes = d.options.find(o => o.id === 'go')?.minutes ?? 90;
  const endAt = finite(d.subject?.endAt) ? d.subject.endAt : (eventAt ? eventAt + minutes * MIN : null);
  if (!eventAt || !endAt || endAt <= now) throw err('refused', 'past');
  const tone = cleanOwnerText(action.tone, 120, ctx, { field: 'tone' });
  const parent = ownerParent(b, action, now);
  b.add({ type: 'scene.tone_set', actor: 'owner', at: now, causeRef: parent, payload: { decisionId: d.id, tone, outcome } });
  finishParent(b, parent);
  if (d.status === 'open' || !['go', 'late'].includes(d.committed?.optionId)) warn(b, 'tone_needs_go', 'info', { decisionIds: [d.id] });
  b.warnings.push(`used when it ends, ${localWhen(endAt, tz)}`);
  return { slices: ['story.sceneTones'] };
}

// A real business named in owner text: a venue-like place he knows (a real
// venue or an owner-renamed one), or any venue name ever recorded (a reverted
// or rewound one too, R5), normalised, whole words.
function realBusiness(text, state) {
  if (!text) return false;
  const names = [];
  for (const p of state.places instanceof Map ? state.places.values() : []) {
    if (isVenueLike(p) && typeof p.name === 'string') names.push(p.name);
  }
  return mentionsVenue(String(text), [...names, ...venueNamesSafe()]);
}

// The looks-real safety net (prompt drafts and hand-built scenes alike): an
// invented place whose name contains a real venue's name — a venue-like place
// he knows or any venue name ever recorded — or a known venue area (a
// looked-up venue's area), whole words, any case, ≥ 4 letters, is probably the
// real place → a continuity warning (warn), never a refusal: the owner may
// still mean an invented one.
export function looksRealPlace(name, state) {
  const norm = normalizeName(name);
  if (!norm) return false;
  const names = [...venueNamesSafe()];
  for (const p of state?.places instanceof Map ? state.places.values() : []) {
    if (isVenueLike(p) && typeof p.name === 'string') names.push(p.name);
    if (typeof p?.venue?.area === 'string') names.push(p.venue.area);
  }
  return names.map(normalizeName).some(n => n.replace(/ /g, '').length >= 4 && ` ${norm} `.includes(` ${n} `));
}

function patternOf(v) {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw err('invalid', 'bad_pattern');
  const days = (x) => {
    if (!Array.isArray(x) || x.length > 7 || !x.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw err('invalid', 'bad_pattern');
    return [...new Set(x)].sort((a, c) => a - c);
  };
  const officeDays = days(v.officeDays ?? []);
  const wfhDays = days(v.wfhDays ?? []);
  if (officeDays.some(d => wfhDays.includes(d))) throw err('invalid', 'bad_pattern');
  return { officeDays, wfhDays };
}

function planCareer(action, ctx, b) {
  const { state, now } = ctx;
  const change = CAREER_CHANGES.includes(action.change) ? action.change : null;
  if (!change) throw err('invalid', 'bad_change');
  const c = state.story?.career ?? {};
  const employed = c.employed !== false;
  if (change === 'hire' && employed) throw err('invalid', 'employed');
  if (['fire', 'quit', 'promote', 'job'].includes(change) && !employed) throw err('refused', 'unemployed');
  const payload = { reason: change };
  let newOffice = null;
  if (change === 'hire' || change === 'job') {
    payload.title = cleanOwnerText(action.title, 60, ctx, { field: 'title' });
    payload.employerName = cleanOwnerText(action.employerName, 80, ctx, { required: false, field: 'employerName' }) ?? 'a new company';
    if (realBusiness(payload.title, state) || realBusiness(payload.employerName, state)) throw err('invalid', 'real_business');
    // His office is a generic office (plan §P1.2): never a real venue, never a new
    // place named like one.
    if (action.newPlace) {
      newOffice = newPlacePayload({ ...action.newPlace, kind: 'office' }, ctx);
      if (realBusiness(newOffice.name, state)) throw err('invalid', 'real_business', { field: 'newPlace' });
      payload.officePlaceId = newOffice.id;
    } else if (action.officePlaceId !== undefined && action.officePlaceId !== null) {
      payload.officePlaceId = placeRef(state, action.officePlaceId);
      if (isVenueLike(state.places.get(payload.officePlaceId))) throw err('invalid', 'real_business', { field: 'officePlaceId' });
    }
  }
  if (change === 'promote') {
    const t = cleanOwnerText(action.title, 60, ctx, { required: false, field: 'title' });
    if (t) { if (realBusiness(t, state)) throw err('invalid', 'real_business'); payload.title = t; }
  }
  if (['hire', 'job', 'promote', 'salary'].includes(change)) {
    if (action.salary !== undefined && action.salary !== null) {
      if (!finite(action.salary) || action.salary < 0 || action.salary > MONEY_MAX) throw err('invalid', 'bad_salary');
      payload.salary = Math.round(action.salary);
    } else if (change === 'salary' || change === 'promote') throw err('invalid', 'bad_salary');
  }
  const pattern = patternOf(action.pattern);
  if (change === 'pattern' && !pattern) throw err('invalid', 'bad_pattern');
  if (pattern) payload.pattern = pattern;
  const later = laterTime(action, ctx);
  if (later && later > now + 60) payload.effectiveAt = later;
  if (!relaxOr(b, ctx, ownerControls(ctx, 'career', 'change', ['self.job']), 'self.job')) return { slices: ['story.career'] };
  const parent = ownerParent(b, action, now);
  if (newOffice) b.add({ type: 'place.created', actor: 'owner', at: now, causeRef: parent, payload: newOffice });

  // Warnings (plan §P1.2).
  const oldSalary = finite(c.salary) ? c.salary : (finite(ctx.world?.money?.salary) ? ctx.world.money.salary : null);
  if (finite(payload.salary) && finite(oldSalary) && oldSalary > 0 && Math.abs(payload.salary - oldSalary) / oldSalary > 0.3) warn(b, 'salary_jump', 'info');
  if ((change === 'job' || change === 'hire') && finite(c.startedAt) && now - c.startedAt < CHURN_SEC && posInt(c.godEventId)) warn(b, 'job_churn', 'info');
  if (isObj(c.notice)) warn(b, 'notice_active', 'info');
  if (posInt(c.huntArcId) && ['hire', 'job', 'fire', 'quit'].includes(change)) warn(b, 'hunt_active', 'info', { arcIds: [c.huntArcId] });
  if (change === 'fire' || change === 'quit') { warn(b, 'job_loss_big', 'warn'); b.warnings.push(WEIGHTY); }
  if (pattern && pattern.wfhDays.length === 0 && pattern.officeDays.length >= 5) warn(b, 'pattern_all_office', 'info');
  for (const d of careerDecisions(state)) warn(b, 'closes_career_decision', 'info', { decisionIds: [d.id] });

  const set = b.add({ type: 'career.set', actor: 'owner', at: now, causeRef: parent, payload });
  if (!payload.effectiveAt) {
    for (const e of careerConsequences(state, payload)) b.add({ ...e, actor: 'engine', at: now, causeRef: set });
    if (PLAN_REASONS.has(change) || pattern) replanAfter(b, ctx, set);
  } else {
    b.warnings.push(`takes effect ${localWhen(payload.effectiveAt, ctx.tz)}`);
  }
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE, GOD_CHANGE);
  return { slices: ['story.career', 'self', 'decisions', 'plan', 'story.pending'], extra: { weighty: change === 'fire' || change === 'quit' } };
}

function planMoney(action, ctx, b) {
  const { state, now } = ctx;
  const mode = MONEY_MODES.includes(action.mode) ? action.mode : null;
  if (!mode) throw err('invalid', 'bad_mode');
  const amount = action.amount;
  if (!finite(amount) || Math.abs(amount) > MONEY_MAX || (mode !== 'set' && amount < 0)) throw err('invalid', 'bad_amount');
  const label = action.label === undefined || action.label === null ? null : cleanOwnerText(action.label, TEXT_CAPS.label, ctx, { field: 'label' });
  if (mode !== 'set' && amount === 0) throw err('refused', 'nothing');
  const parent = ownerParent(b, action, now);
  b.add({ type: 'money.adjusted', actor: 'owner', at: now, causeRef: parent, payload: { mode, amount: Math.round(amount * 100) / 100, ...(label ? { label } : {}) } });
  finishParent(b, parent);
  let after = null;
  try { after = foldDescriptors(state, b.events, ctx.baseWorld ?? undefined).vitals?.money; } catch { after = null; }
  if (finite(after) && after < 0) warn(b, 'money_negative', 'warn');
  const baseline = ctx.world?.money?.monthlyBaseline;
  if (finite(baseline) && baseline > 0 && Math.abs(amount) > 6 * baseline) warn(b, 'money_jump', 'info');
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['vitals'], extra: { moneyAfter: finite(after) ? Math.round(after) : null } };
}

function homePlacePayload(action, ctx) {
  const { state } = ctx;
  if ((state.places?.size ?? 0) >= MAX_PLACES) throw err('refused', 'full');
  let lat;
  let lon;
  let name = 'Home';
  if (action.area !== undefined && action.area !== null) {
    if (!isObj(action.area) || !finite(action.area.lat) || !finite(action.area.lon)) throw err('invalid', 'bad_area');
    const area = cleanOwnerText(action.area.name, 60, ctx, { field: 'area' });
    name = `Home · ${area}`;
    lat = action.area.lat;
    lon = action.area.lon;
  } else {
    const near = state.places?.get?.(placeRef(state, action.near));
    const h = crypto.createHash('sha256').update(`home|${action.near}|${state.lastEventId}`).digest();
    const bearing = (h[0] / 256) * 2 * Math.PI;
    const km = 0.5 + (h[1] / 255) * 1.5;
    lat = near.lat + (km / 111) * Math.cos(bearing);
    lon = near.lon + (km / (111 * Math.max(0.1, Math.cos(near.lat * Math.PI / 180)))) * Math.sin(bearing);
  }
  const box = regionBox(state);
  if (box && (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon)) throw err('invalid', 'region');
  const taken = new Set(state.places?.keys?.() ?? []);
  let n = 1;
  while (taken.has(`place:home-${n}`) && n < 100) n++;
  // Neighbourhood-level only (~1 km): never a house position.
  return { id: `place:home-${n}`, name, kind: 'home', lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

function planHome(action, ctx, b) {
  const { state, now } = ctx;
  if ((action.near === undefined || action.near === null) === (action.area === undefined || action.area === null)) throw err('invalid', 'bad_home');
  const flatmate = action.flatmate === undefined || action.flatmate === null ? 'stays' : action.flatmate;
  if (!HOME_FLATMATE.includes(flatmate)) throw err('invalid', 'bad_flatmate');
  const from = state.self?.homePlaceId ?? null;
  const later = laterTime(action, ctx);
  if (!relaxOr(b, ctx, ownerControls(ctx, 'social', 'change', ['self.home']), 'self.home')) return { slices: ['self'] };
  const parent = ownerParent(b, action, now);
  const np = homePlacePayload(action, ctx);
  b.add({ type: 'place.created', actor: 'owner', at: now, causeRef: parent, payload: np });
  const payload = { homePlaceId: np.id, fromPlaceId: from, ...(later && later > now + 60 ? { effectiveAt: later } : {}) };
  const moved = b.add({ type: 'self.moved', actor: 'owner', at: now, causeRef: parent, payload });
  if (flatmate === 'leaves') {
    for (const c of state.cast instanceof Map ? state.cast.values() : []) {
      if (c?.relation !== 'flatmate') continue;
      b.add({ type: 'cast.departed', actor: 'owner', at: now, causeRef: parent, payload: { castId: c.id, how: 'moved_out' } });
    }
  } else if (flatmate === 'comes') {
    b.warnings.push('the flatmate moves with him');
  }
  if (action.newFlatmate) {
    const nc = newCastPayload({ ...action.newFlatmate, relation: 'flatmate' }, ctx);
    b.add({ type: 'cast.created', actor: 'owner', at: now, causeRef: parent, payload: nc });
  }
  if (!payload.effectiveAt) replanAfter(b, ctx, moved);
  else b.warnings.push(`moves ${localWhen(payload.effectiveAt, ctx.tz)}`);
  const homeEv = posInt(state.self?.homeEventId) ? (() => { try { return getEvent(state.self.homeEventId); } catch { return null; } })() : null;
  if (homeEv && now - homeEv.at < CHURN_SEC) warn(b, 'move_churn', 'info');
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE, GOD_CHANGE, 'the home sits at neighbourhood level (~1 km), never an address');
  return { slices: ['self', 'places', 'plan', 'story.pending', 'cast'] };
}

function moodDelta(action) {
  if (action.preset !== undefined && action.preset !== null) {
    const p = Object.prototype.hasOwnProperty.call(MOOD_PRESETS, action.preset) ? MOOD_PRESETS[action.preset] : null;
    if (!p) throw err('invalid', 'bad_preset');
    return { ...p };
  }
  if (!isObj(action.delta)) throw err('invalid', 'bad_delta');
  const out = {};
  for (const [k, cap] of Object.entries(MOOD_CAPS)) {
    const v = action.delta[k];
    if (v === undefined || v === null) continue;
    if (!finite(v)) throw err('invalid', 'bad_delta');
    out[k] = k === 'valence' ? round2(clamp(v, -cap, cap)) : Math.round(clamp(v, -cap, cap));
  }
  if (!Object.keys(out).length || Object.keys(action.delta).some(k => !Object.prototype.hasOwnProperty.call(MOOD_CAPS, k))) throw err('invalid', 'bad_delta');
  return out;
}

function planMood(action, ctx, b) {
  const { state, now, tz } = ctx;
  const delta = moodDelta(action);
  const label = action.label === undefined || action.label === null ? null : cleanOwnerText(action.label, TEXT_CAPS.label, ctx, { field: 'label' });
  const payload = { delta, ...(label ? { label } : {}) };
  if (action.wakeDay !== undefined && action.wakeDay !== null) {
    if (!Number.isInteger(action.wakeDay) || action.wakeDay < 0 || action.wakeDay > WAKE_DAYS_MAX) throw err('invalid', 'bad_wakeDay');
    const date = dateKey(addDays(dayStart(now, tz), action.wakeDay, tz), tz);
    const woke = state.sleep?.lastWokeAt;
    if (action.wakeDay === 0 && finite(woke) && dateKey(woke, tz) === date && state.activity?.kind !== 'sleep') throw err('refused', 'woke_already');
    payload.wakeDate = date;
  } else {
    const at = laterTime(action, ctx);
    if (!at) throw err('invalid', 'bad_when');
    if (at <= now + MOOD_SOON_SEC) throw err('refused', 'use_quick');
    payload.at = at;
  }
  const parent = ownerParent(b, action, now);
  b.add({ type: 'vitals.planned', actor: 'owner', at: now, causeRef: parent, payload });
  finishParent(b, parent);
  if ((delta.energy ?? 0) > 0 && (state.vitals?.sick === true || heavyGuardActive(state, now))) warn(b, 'mood_vs_state', 'info');
  b.warnings.push(VISIBLE_EVERYWHERE, payload.wakeDate ? `when he wakes on ${payload.wakeDate}` : `at ${localWhen(payload.at, tz)}`);
  return { slices: ['story.pending'] };
}

// ── Wake him ("can't sleep") ─────────────────────────────────────────────
// { kind:'wake', reason: cant_sleep | woken_up | early_start, at?: 'HH:MM' | unix
// (default now), until?: 'HH:MM' | unix (cant_sleep / woken_up; default: back to
// sleep after about 45 min, later for a locked outing tonight) }. One owner
// `wake.set`; the pulse wakes him at `at` while he sleeps (an early woke + the
// night's re-plan, or for early_start his morning). Revertible until his morning.
export { WAKE_REASONS };
export const WAKE_AHEAD_SEC = 24 * HOUR;
const WAKE_MARGIN_SEC = 10 * MIN;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A wake time: unix, or 'HH:MM' = its next occurrence from `after` (a minute's grace).
function wakeClock(v, ctx, after, field) {
  if (v === undefined || v === null) return null;
  if (Number.isSafeInteger(v)) {
    if (v < ctx.now - 60 || v > ctx.now + WAKE_AHEAD_SEC) throw err('invalid', `bad_${field}`);
    return v;
  }
  const m = typeof v === 'string' ? HHMM_RE.exec(v.trim()) : null;
  if (!m) throw err('invalid', `bad_${field}`);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const d0 = dayStart(after, ctx.tz);
  let t = zonedAt(d0, mins, ctx.tz);
  if (t < after - 60) t = zonedAt(addDays(d0, 1, ctx.tz), mins, ctx.tz);
  return t;
}

function zonedAt(d0, mins, tz) {
  const [y, mo, d] = dateKey(d0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, Math.floor(mins / 60), mins % 60, tz);
}

/** The sleep a wake at `t` would interrupt: { start, wakeAt } | null (he'd be up then). */
export function sleepAround(state, t, world) {
  if (state?.activity?.kind === 'sleep') {
    const w = wakeFor(state, world);
    return w && t < w.at ? { start: state.activity.startAt, wakeAt: w.at, now: true } : null;
  }
  const p = state?.plan;
  const sb = Array.isArray(p?.blocks) ? [...p.blocks].reverse().find(b => b.kind === 'sleep') : null;
  if (!sb || !finite(sb.start) || !finite(sb.end)) return null;
  return t >= sb.start && t < sb.end ? { start: sb.start, wakeAt: sb.end, now: false } : null;
}

function planWake(action, ctx, b) {
  const { state, now, tz } = ctx;
  const reason = WAKE_REASONS.includes(action.reason) ? action.reason : null;
  if (!reason) throw err('invalid', 'bad_reason');
  for (const k of Object.keys(action)) if (!['kind', 'reason', 'at', 'until', 'source'].includes(k)) throw err('invalid', 'bad_field');
  const at = Math.max(now, wakeClock(action.at, ctx, now, 'at') ?? now);
  const world = ctx.baseWorld ?? ctx.world;
  const night = sleepAround(state, at, world);
  if (!night) throw err('refused', 'not_asleep');
  if (at >= night.wakeAt - WAKE_MARGIN_SEC) throw err('refused', 'after_wake');
  let until = null;
  if (action.until !== undefined && action.until !== null) {
    if (reason === 'early_start') throw err('invalid', 'bad_field');
    until = wakeClock(action.until, ctx, at, 'until');
    if (!(until > at + WAKE_MARGIN_SEC) || until >= night.wakeAt) throw err('invalid', 'bad_until');
  }
  const open = (Array.isArray(state.wakeSets) ? state.wakeSets : []).find(x => !finite(x?.wokeAt) && finite(x?.at) && x.at >= now - 60);
  if (open) throw err('refused', 'wake_open');
  const parent = ownerParent(b, action, now);
  b.add({ type: 'wake.set', actor: 'owner', at: now, causeRef: parent, payload: { at, reason, ...(until ? { until } : {}) } });
  finishParent(b, parent);
  b.warnings.push(`wakes him at ${localWhen(at, tz)}`);
  if (reason === 'early_start') b.warnings.push('starts his day early');
  else b.warnings.push(until ? `back to sleep at ${clockHhmm(until, tz)}` : 'back to sleep after a while (later for a plan tonight)');
  return { slices: ['wakeSets'] };
}

// ── 019 his phone: "he texts …" / "they text him" ───────────────────────────
// One owner phone.text_set {castId, gist?, tone?, at, from?, words?, chat?}; the phone worker
// writes the first text when it is due (his: at his first free moment from `at`; theirs: at
// `at`) — the owner's `words` verbatim, else in the writer's own words from the gist — and
// the other side may answer. from 'them' while he is asleep (wake on by default): the same
// apply adds an owner wake.set {reason:'woken_up', via:'phone'} at `at` — her text wakes him.
// An owner-started chat runs at night on both sides (phone/worker.js waitFor).
export const TEXT_TONES = Object.freeze(['friendly', 'warm', 'flirty', 'teasing', 'caring', 'excited', 'apologetic', 'casual', 'logistics', 'annoyed', 'naughty']);
export const TEXT_GIST_MAX = 200;
export const TEXT_AHEAD_DAYS = 7;
export const TEXT_FROM = Object.freeze(['him', 'them']);
export const TEXT_CHATS = Object.freeze(['short', 'long']);
export const TEXT_WORDS_MAX = 160;
// How long a chat that woke him keeps him up (then the night plan puts him back to sleep).
export const TEXT_WAKE_MIN = Object.freeze({ short: 30, long: 90 });

function textClock(v, ctx) {
  if (v === undefined || v === null || v === 'now') return ctx.now;
  if (Number.isSafeInteger(v)) {
    if (v < ctx.now - 60 || v > ctx.now + TEXT_AHEAD_DAYS * DAY) throw err('invalid', 'bad_at');
    return Math.max(ctx.now, v);
  }
  const m = typeof v === 'string' ? HHMM_RE.exec(v.trim()) : null;
  if (!m) throw err('invalid', 'bad_at');
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const d0 = dayStart(ctx.now, ctx.tz);
  let t = zonedAt(d0, mins, ctx.tz);
  if (t < ctx.now - 60) t = zonedAt(addDays(d0, 1, ctx.tz), mins, ctx.tz);
  return Math.max(ctx.now, t);
}

function planText(action, ctx, b) {
  const { state, now, tz } = ctx;
  for (const k of Object.keys(action)) if (!['kind', 'castId', 'gist', 'tone', 'at', 'from', 'words', 'chat', 'wake', 'source'].includes(k)) throw err('invalid', 'bad_field');
  const castId = typeof action.castId === 'string' ? action.castId : null;
  if (!castId) throw err('invalid', 'bad_castId');
  if (!state.cast?.has?.(castId)) throw err('refused', state.story?.departed?.[castId] ? 'cast_departed' : 'unknown_cast');
  const from = action.from === undefined || action.from === null ? 'him' : action.from;
  if (!TEXT_FROM.includes(from)) throw err('invalid', 'bad_from');
  const chat = action.chat === undefined || action.chat === null ? 'short' : action.chat;
  if (!TEXT_CHATS.includes(chat)) throw err('invalid', 'bad_chat');
  if (action.wake !== undefined && action.wake !== null && typeof action.wake !== 'boolean') throw err('invalid', 'bad_wake');
  const wantWake = typeof action.wake === 'boolean' ? action.wake : from === 'them';
  // The opening text verbatim (owner text): the phone validator's rules for that thread's register.
  let words = null;
  if (action.words !== undefined && action.words !== null && action.words !== '') {
    if (typeof action.words !== 'string' || action.words.length > TEXT_WORDS_MAX) throw err('invalid', 'bad_words');
    if (typeof deps.phoneWords !== 'function') throw err('refused', 'words_unavailable');
    const v = deps.phoneWords(action.words, castId, state, { tone: action.tone ?? null, from });
    if (!v?.ok) throw err('invalid', v?.reason ? `words_${v.reason}`.slice(0, 32) : 'bad_words');
    words = v.text;
  }
  const gist = cleanOwnerText(action.gist, TEXT_GIST_MAX, ctx, { field: 'gist', required: !words });
  let tone = null;
  if (action.tone !== undefined && action.tone !== null && action.tone !== '') {
    if (!TEXT_TONES.includes(action.tone)) throw err('invalid', 'bad_tone');
    tone = action.tone;
  }
  const at = textClock(action.at, ctx);
  if (tone === 'naughty') {
    let age = null;
    try { const n = Number(getPersona()?.age); age = Number.isFinite(n) ? n : null; } catch { age = null; }
    const reg = registerOf(state, castId, {
      age, urge: urgeNow(state, { now, tz }), private: true, tone: 'naughty',
      heavy: heavyGuardActive(state, now) === true,
      sick: state?.vitals?.sick === true || state?.sick === true,
    });
    if (reg !== 'explicit') throw err('refused', 'not_eligible');
    if (outsidePartner(state, castId)) warn(b, 'outside_partner', 'info');
  }
  // Her text wakes him: only when he is asleep then, before his own wake, and no other wake is waiting.
  let wake = null;
  if (wantWake) {
    const night = sleepAround(state, at, ctx.baseWorld ?? ctx.world);
    const open = (Array.isArray(state.wakeSets) ? state.wakeSets : []).some(x => !finite(x?.wokeAt) && finite(x?.at) && x.at >= now - 60);
    if (night && at < night.wakeAt - WAKE_MARGIN_SEC && !open) {
      const until = Math.min(at + TEXT_WAKE_MIN[chat] * MIN, night.wakeAt - WAKE_MARGIN_SEC - 60);
      wake = { at, reason: 'woken_up', via: 'phone', ...(until > at + WAKE_MARGIN_SEC ? { until } : {}) };
    }
  }
  const parent = ownerParent(b, action, now);
  if (wake) b.add({ type: 'wake.set', actor: 'owner', at: now, causeRef: parent, payload: wake });
  b.add({ type: 'phone.text_set', actor: 'owner', at: now, causeRef: parent, payload: {
    castId, ...(gist ? { gist } : {}), at, ...(tone ? { tone } : {}),
    ...(from === 'them' ? { from } : {}), ...(words ? { words } : {}), ...(chat === 'long' ? { chat } : {}),
  } });
  finishParent(b, parent);
  const name = state.cast.get(castId)?.name ?? castId;
  const when = at > now + 120 ? ` at ${localWhen(at, tz)}` : '';
  const said = words ? `: "${words.replace(/\n+/g, ' / ')}"` : '';
  if (from === 'them') b.warnings.push(`${name} texts him${when}${said}${words ? '' : ' (in their own words)'}`);
  else b.warnings.push(`he texts ${name}${when}${said}${words ? '' : ' (in his own words)'}; the first free moment if he is busy or asleep then`);
  if (wake) b.warnings.push(`the text wakes him${wake.until ? ` (back to sleep around ${clockHhmm(wake.until, tz)})` : ''}`);
  if (chat === 'long') b.warnings.push('a long chat: both stay up and answer within minutes, up to 14 texts');
  return { slices: wake ? ['wakeSets'] : [] };
}

// 020: the promises an illness covers fall through (could_not_go at the pulse): the preview lists them.
function warnSickPromises(b, state, from, until, ctx) {
  const broken = [...(state.decisions instanceof Map ? state.decisions.values() : [])].filter(d => goingTo(d) && !neverRethought(d) && planWeight(d) === WEIGHT.promise
    && finite(d.subject?.eventAt) && d.subject.eventAt > from && d.subject.eventAt < until);
  for (const d of broken) {
    const go = d.options?.find?.(o => o?.id === 'go')?.label;
    b.warnings.push(`${typeof go === 'string' ? go.slice(0, 80) : 'a plan'} at ${localWhen(d.subject.eventAt, ctx.tz)} falls through`);
  }
  if (broken.length) warn(b, 'sick_promises', 'warn', { decisionIds: broken.map(d => d.id) }, { fromChat: broken.some(d => planEdits.chatMadeDecision(d)) });
}

function planHealth(action, ctx, b) {
  const { state, now, tz } = ctx;
  const change = HEALTH_CHANGES.includes(action.change) ? action.change : null;
  if (!change) throw err('invalid', 'bad_change');
  const sick = !!state.sick || state.vitals?.sick === true;
  if (change === 'well') {
    if (!sick) throw err('refused', 'nothing');
    const parent = ownerParent(b, action, now);
    const ended = b.add({ type: 'sick.ended', actor: 'owner', at: now, causeRef: parent, payload: {} });
    replanAfter(b, ctx, ended);
    finishParent(b, parent);
    b.warnings.push(VISIBLE_EVERYWHERE);
    return { slices: ['sick', 'vitals', 'plan'] };
  }
  const days = action.days === undefined || action.days === null ? 1 : action.days;
  if (!Number.isInteger(days) || days < 1 || days > SICK_DAYS_MAX) throw err('invalid', 'bad_days');
  const later = laterTime(action, ctx);
  const parent = ownerParent(b, action, now);
  if (later && later > now + 60) {
    b.add({ type: 'sick.planned', actor: 'owner', at: now, causeRef: parent, payload: { startAt: later, days } });
    b.warnings.push(`from ${localWhen(later, tz)}`);
  } else {
    if (sick) throw err('refused', 'already_sick');
    const until = addDays(dayStart(now, tz), days, tz) + 4 * HOUR;
    const started = b.add({ type: 'sick.started', actor: 'owner', at: now, causeRef: parent, payload: { until, days, reason: 'owner' } });
    replanAfter(b, ctx, started);
  }
  finishParent(b, parent);
  if (days > 7) warn(b, 'sick_long', 'info');
  const sickUntil = (later ?? now) + days * DAY;
  for (const d of openDecisionsWhere(state, d => finite(d.subject?.eventAt) && d.subject.eventAt > (later ?? now) && d.subject.eventAt < sickUntil)) {
    warn(b, 'two_places', 'info', { decisionIds: [d.id] });
  }
  warnSickPromises(b, state, later ?? now, sickUntil, ctx);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['sick', 'vitals', 'plan', 'story.pending'], extra: { weighty: days > 3 } };
}

function planArcEnd(action, ctx, b) {
  const { state, now } = ctx;
  const arcId = posInt(action.arcId);
  const arc = arcId ? state.story?.arcs?.[arcId] : null;
  if (!isObj(arc) || arc.status !== 'active') throw err('not_found', 'arc');
  const outcome = ARC_END_OUTCOMES.includes(action.outcome) ? action.outcome : null;
  if (!outcome) throw err('invalid', 'bad_outcome');
  const category = CATEGORIES.includes(arc.category) ? arc.category : 'cast';
  const pinKeys = [`arc:${arcId}.stage`, ...(Array.isArray(arc.castIds) ? arc.castIds : [])];
  if (!relaxOr(b, ctx, ownerControls(ctx, category, 'change', pinKeys), `arc:${arcId}`)) return { slices: ['story.arcs'] };
  const parent = ownerParent(b, action, now);
  b.add({ type: 'arc.ended', actor: 'owner', at: now, causeRef: parent, payload: { arcId, outcome } });
  finishParent(b, parent);
  if (arc.category === 'romance') {
    warn(b, 'romance_cooldown_set', 'info');
    if (ROMANCE_STAGES.indexOf(arc.stage) >= ROMANCE_STAGES.indexOf('dating')) b.warnings.push(WEIGHTY);
  }
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['story.arcs', 'story.romance', 'self'] };
}

function planCastDepart(action, ctx, b) {
  const { state, now } = ctx;
  const castId = castRef(state, action.castId);
  const how = DEPART_HOW.includes(action.how) ? action.how : null;
  if (!how) throw err('invalid', 'bad_how');
  const member = state.cast.get(castId);
  if (!relaxOr(b, ctx, ownerControls(ctx, 'cast', 'change', [castId]), castId)) return { slices: [castId] };
  const parent = ownerParent(b, action, now);
  const gone = b.add({ type: 'cast.departed', actor: 'owner', at: now, causeRef: parent, payload: { castId, how } });
  for (const arc of Object.values(state.story?.arcs ?? {})) {
    if (!isObj(arc) || arc.status !== 'active' || !Array.isArray(arc.castIds) || !arc.castIds.includes(castId)) continue;
    b.add({ type: 'arc.ended', actor: 'owner', at: now, causeRef: parent, payload: { arcId: arc.id, outcome: 'cancelled' } });
    if (arc.category === 'romance') warn(b, 'departs_partner', 'high', { castIds: [castId] });
  }
  let lastExpiry = null;
  const dropped = [];
  for (const d of state.decisions instanceof Map ? state.decisions.values() : []) {
    if (d?.status !== 'open' && d?.status !== 'committed') continue;
    const ids = Array.isArray(d.subject?.castIds) ? d.subject.castIds : [];
    if (!ids.length || !ids.every(id => id === castId)) continue;
    // A plan that already happened stays what it was (a committed outing keeps
    // 'committed' after its end): only one still to come or under way is called off.
    if (outingOver(d, now)) continue;
    // A real person's plan isn't the departed member's to take with them: it stands, without them.
    if (typeof d.subjectJid === 'string') { b.warnings.push(CHAT_PLAN_KEPT); warn(b, 'chat_plan_kept', 'info', null, { fromChat: true }); continue; }
    lastExpiry = b.add({ type: 'decision.expired', actor: 'engine', at: now, causeRef: gone, payload: { decisionId: d.id, reason: 'cast_departed' } });
    if (state.plan?.amendedFor === d.id || (state.plan?.blocks ?? []).some(bl => bl?.decisionId === d.id)) dropped.push(d.id);
  }
  // Today's plan held one of them: an engine re-plan without its blocks (as outcome cancelled).
  if (lastExpiry && dropped.length) replanAfter(b, ctx, lastExpiry, { dropDecisionIds: dropped });
  for (const g of activeGoals(state)) {
    if (g.castId !== castId || g.status !== 'open') continue;
    b.add({ type: 'goal.expired', actor: 'engine', at: now, causeRef: gone, payload: { goalId: g.id, reason: 'cast_departed' } });
  }
  finishParent(b, parent);
  const weighty = state.story?.romance?.partnerId === castId || /^family:/.test(member?.relation ?? '')
    || (finite(member?.metrics?.closeness) && member.metrics.closeness >= 0.6);
  if (weighty) b.warnings.push(WEIGHTY);
  b.warnings.push(VISIBLE_EVERYWHERE, 'their history stays; they can come back');
  return { slices: ['cast', 'story.departed', 'story.arcs', 'decisions', 'goals'], extra: { weighty } };
}

function planCastReturn(action, ctx, b) {
  const { state, now } = ctx;
  const castId = typeof action.castId === 'string' && CAST_ID_RE.test(action.castId) ? action.castId : null;
  if (!castId || !isObj(state.story?.departed?.[castId])) throw err('refused', 'nothing');
  if (state.cast instanceof Map && state.cast.has(castId)) throw err('refused', 'id_in_use');
  if ((state.cast?.size ?? 0) >= ctx.cfg.castMax) throw err('refused', 'full');
  const parent = ownerParent(b, action, now);
  b.add({ type: 'cast.returned', actor: 'owner', at: now, causeRef: parent, payload: { castId } });
  finishParent(b, parent);
  b.warnings.push(VISIBLE_EVERYWHERE);
  return { slices: ['cast', 'story.departed'] };
}

// ── 015 cont: bundles and retcons (plan §P2.5, Phase 3) ────────────────────
//
// bundle {actions:[a1..a5]}: each part is planned in sequence on the state the
// previous parts leave (so part 2 may use a cast member part 1 creates), the
// descriptors are concatenated with their refs renumbered, and every preview
// placeholder id an earlier part produced (PREVIEW_ID_BASE + n) is mapped back
// to that part's $ref — a placeholder that maps to nothing is refused
// `bundle_forward_ref`, never written as a literal. One fingerprint, one
// transaction; each part keeps its own director.action parent. A part may carry
// `source` ('hand' | 'code' | 'continuity' | 'prompt': who proposed it, for the
// audit); a story-read ('continuity') or a Tell-the-story ('prompt', 017) part
// never plans with `relax`.
//
// retcon {to:{eventId}|{bookmarkId}|{at}, actions:[…], reason?}: a rewind to T
// plus a bundle of actions dated NOW, planned on the rewound world, previewed and
// applied as one batch. It rewrites his life from T forward; it never puts an
// event into the past (cast.history {dated} stays the tool for a past fact).

export const BUNDLE_MAX = 5;
export const BUNDLE_EXCLUDED = Object.freeze(new Set(['bundle', 'rewind', 'retcon', 'tray.adopt', 'proposal.approve',
  'bookmark', 'bookmark.remove']));
export const PART_SOURCES = Object.freeze(['hand', 'code', 'continuity', 'prompt']);
// Parts whose proposer isn't the owner's own hand: planned without `relax` (hard rules stay hard).
const UNRELAXED_SOURCES = new Set(['continuity', 'prompt']);

function partsOf(action) {
  const list = action.actions;
  if (!Array.isArray(list) || !list.length || list.length > BUNDLE_MAX) throw err('invalid', 'bad_actions');
  return list.map((a, i) => {
    if (!isObj(a) || typeof a.kind !== 'string' || !ACTION_KINDS.includes(a.kind) || BUNDLE_EXCLUDED.has(a.kind)) {
      throw err('invalid', 'bad_kind', { part: i });
    }
    // A part with a store step after apply (a scene from a tray claim) can't ride in a batch.
    if (a.fromReviewId !== undefined && a.fromReviewId !== null) throw err('invalid', 'bad_part', { part: i });
    if (a.source !== undefined && !PART_SOURCES.includes(a.source)) throw err('invalid', 'bad_source', { part: i });
    const { source = 'hand', ...rest } = a;
    return { action: rest, source };
  });
}

// A placeholder id from an earlier part → its renumbered $ref (null when none).
function refOfPlaceholder(v, ranges) {
  for (const r of ranges) if (v > r.base && v <= r.base + r.count) return `$${r.offset + (v - r.base)}`;
  return null;
}

function hasPlaceholder(v, depth = 0) {
  if (typeof v === 'number') return v >= PREVIEW_ID_BASE;
  if (depth > 6 || v === null || typeof v !== 'object') return false;
  return Object.values(v).some(x => hasPlaceholder(x, depth + 1));
}

// Renumber one part's descriptors: refs shifted by `offset`, placeholders of
// earlier parts → refs. Throws bundle_forward_ref for an unmapped placeholder.
function renumberPart(events, offset, ranges, part) {
  const map = new Map(events.map((e, n) => [e.ref, `$${offset + n + 1}`]));
  const fwd = () => err('refused', 'bundle_forward_ref', { part });
  const refFor = (r) => { const x = map.get(r); if (!x) throw fwd(); return x; };
  return events.map((e) => {
    const out = { ...e, ref: map.get(e.ref), payload: structuredClone(e.payload ?? {}) };
    if (e.causeRef) out.causeRef = refFor(e.causeRef);
    if (Number.isSafeInteger(e.causeId) && e.causeId >= PREVIEW_ID_BASE) {
      const ref = refOfPlaceholder(e.causeId, ranges);
      if (!ref) throw fwd();
      delete out.causeId;
      out.causeRef = ref;
    }
    const refs = {};
    for (const [k, r] of Object.entries(e.payloadRefs ?? {})) refs[k] = Array.isArray(r) ? r.map(refFor) : refFor(r);
    for (const [k, v] of Object.entries(out.payload)) {
      if (refs[k] !== undefined) continue;
      if (typeof v === 'number' && v >= PREVIEW_ID_BASE) {
        const ref = refOfPlaceholder(v, ranges);
        if (!ref) throw fwd();
        refs[k] = ref;
        delete out.payload[k];
      } else if (Array.isArray(v) && v.some(x => typeof x === 'number' && x >= PREVIEW_ID_BASE)) {
        const list = v.map(x => (typeof x === 'number' ? refOfPlaceholder(x, ranges) : null));
        if (list.some(x => !x)) throw fwd();                     // a mixed id list can't be expressed as refs
        refs[k] = list;
        delete out.payload[k];
      } else if (hasPlaceholder(v)) {
        throw fwd();                                             // nested placeholders aren't resolvable
      }
    }
    if (Object.keys(refs).length) out.payloadRefs = refs; else delete out.payloadRefs;
    return out;
  });
}

/**
 * Plan the parts in sequence on `state`. → { events, warnings, refusals, slices,
 * extras, parts:[{kind, source}], afterState }
 */
function planParts(parts, state, opts) {
  let s = state;
  const events = [];
  const warnings = [];
  const refusals = [];
  const slices = new Set();
  const ranges = [];
  const extras = [];
  parts.forEach(({ action, source }, i) => {
    const relax = opts.relax === true && !UNRELAXED_SOURCES.has(source);
    let p;
    try {
      p = plan(action, s, { ...opts, relax, continuity: false, project: false });
    } catch (e) {
      if (e instanceof StoryError) { e.part = i; throw e; }
      throw err('invalid', 'bad_part', { part: i });
    }
    const base = Math.max(PREVIEW_ID_BASE, s.lastEventId);
    const renumbered = renumberPart(p.events, events.length, ranges, i);
    ranges.push({ base, count: p.events.length, offset: events.length });
    events.push(...renumbered);
    for (const w of p.warnings) warnings.push(w);
    for (const r of p.refusals) refusals.push({ ...r, part: i });
    for (const sl of p.slices ?? []) slices.add(sl);
    extras.push(p.extra ?? null);
    s = p.afterState ?? s;
  });
  return { events, warnings: [...new Set(warnings)], refusals, slices: [...slices], extras, parts: parts.map(p => ({ kind: p.action.kind, source: p.source })) };
}

const conflictsOfParts = (extras) => extras.flatMap(x => (Array.isArray(x?.conflicts) ? x.conflicts : []));

function planBundle(action, state, opts, ctx) {
  const parts = partsOf(action);
  const r = planParts(parts, state, opts);
  const world = ctx.baseWorld ?? undefined;
  const after = r.events.length ? foldDescriptors(state, r.events, world) : state;
  let beforeView = state;
  try { if (world) beforeView = advanceTo(state, ctx.now, world); } catch { beforeView = state; }
  const plannedLike = { action, events: r.events, extra: { conflicts: conflictsOfParts(r.extras) } };
  const continuity = opts.continuity === false ? null : continuityOf(plannedLike, beforeView, after, ctx, state, opts, null);
  return {
    action, events: r.events, warnings: r.warnings, refusals: r.refusals, slices: r.slices,
    before: Object.fromEntries(r.slices.map(p => [p, sliceOf(beforeView, p)])),
    after: Object.fromEntries(r.slices.map(p => [p, sliceOf(after, p)])),
    diff: diffSlices(beforeView, after, r.slices), extra: { parts: r.parts }, post: null, afterState: after, parts: r.parts,
    ...(continuity ? { continuity } : {}),
  };
}

// The log as the rewound world sees it: events in (toEventId, upto] are hidden
// unless rewind-kept (review #27), so pacing counts come from the new timeline.
function rewoundReaders(rwState) {
  const visible = (e) => !!e && (!isExcludedId(rwState, e.id) || isRewindKept(e));
  return {
    listEvents: (o = {}) => safeListEvents(o).filter(visible),
    getEvent: (id) => { const e = getEvent(id); return visible(e) ? e : null; },
  };
}

function planRetcon(action, state, opts, ctx) {
  const to = isObj(action.to) ? action.to : null;
  const target = !to ? null : to.eventId !== undefined ? { toEventId: to.eventId }
    : to.bookmarkId !== undefined ? { bookmarkId: to.bookmarkId } : to.at !== undefined ? { at: to.at } : null;
  if (!target) throw err('invalid', 'bad_to');
  const parts = partsOf(action);
  const rw = planRewind({ ...target, reason: action.reason }, state, {
    ...ctx, getState: deps.getState, countSelfReplies: deps.countSelfReplies, chatName: deps.chatName,
  });
  const base = rw.afterState;
  const readers = rewoundReaders(base);
  // The actions are dated now on the rewound world (a past start is refused by their own planners).
  const r = planParts(parts, base, { ...opts, getEvent: readers.getEvent, listEvents: readers.listEvents });
  const events = [...rw.events, ...renumberPart(r.events, rw.events.length, [], 0)];
  const world = ctx.baseWorld ?? undefined;
  const after = r.events.length ? foldDescriptors(base, r.events, world) : base;
  const plannedLike = { action, events: r.events, extra: { conflicts: conflictsOfParts(r.extras) } };
  const continuity = opts.continuity === false ? null
    : continuityOf(plannedLike, base, after, ctx, base, { ...opts, listEvents: readers.listEvents, getEvent: readers.getEvent }, null);
  const slices = [...new Set([...rw.slices, ...r.slices])];
  let beforeView = state;
  try { if (world) beforeView = advanceTo(state, ctx.now, world); } catch { beforeView = state; }
  return {
    action, events, warnings: [...new Set([...rw.warnings, ...r.warnings])], refusals: r.refusals, slices,
    before: Object.fromEntries(slices.map(p => [p, sliceOf(beforeView, p)])),
    after: Object.fromEntries(slices.map(p => [p, sliceOf(after, p)])),
    diff: diffSlices(beforeView, after, slices),
    extra: { ...rw.extra, parts: r.parts }, post: rw.post, rebuiltState: rw.rebuiltState, afterState: after, parts: r.parts,
    retcon: { baseState: base, actionEvents: r.events },
    ...(continuity ? { continuity } : {}),
  };
}

// ── 015 cont: the continuity check of a planned batch ──────────────────────

function safeListEvents(o = {}) {
  const opts = { ...o };
  if (opts.types !== undefined) {
    opts.types = (Array.isArray(opts.types) ? opts.types : [opts.types]).filter(t => LOG_EVENT_TYPES.has(t));
    if (!opts.types.length) return [];
  }
  try { return listEvents(opts); } catch { return []; }
}

function continuityCtx(ctx, state, opts) {
  const a = config.arcs || {};
  return {
    now: ctx.now, tz: ctx.tz, world: ctx.world, baseWorld: ctx.baseWorld,
    cfg: {
      newCastPer90d: Number.isFinite(a.newCastPer90d) ? a.newCastPer90d : 2,
      beatsPerWeek: Number.isFinite(a.beatsPerWeek) ? a.beatsPerWeek : 8,
      heavyMinGapDays: ctx.cfg?.heavyMinGapDays ?? 90,
    },
    lastHeavyAt: ctx.lastHeavyAt,
    listEvents: typeof opts.listEvents === 'function' ? opts.listEvents : safeListEvents,
    getEvent: typeof opts.getEvent === 'function' ? opts.getEvent : getEvent,
    idBase: Math.max(PREVIEW_ID_BASE, state.lastEventId),
    actionKinds: new Set(ACTION_KINDS),
    knownType: (t) => LOG_EVENT_TYPES.has(t),
  };
}

/**
 * { warnings, threads, suggestions } of a planned batch: a planner's own
 * continuity entries (015 P1's relaxed refusals, `b.continuity`) first, then the
 * code rules. Each code suggestion must plan on the after-state (relax: it is the
 * owner's own Director proposing), else it is dropped; ≤ 4.
 */
function continuityOf(plannedLike, beforeView, after, ctx, state, opts, plannerWarnings) {
  const own = (Array.isArray(plannerWarnings) ? plannerWarnings : []).map(cleanWarning).filter(Boolean);
  const cctx = continuityCtx(ctx, state, opts);
  const r = checkContinuity(plannedLike, beforeView, after, cctx);
  // One warning per code: the planner's copy (its refs) with the checker's more
  // specific text for the same code and chat flag, at the higher severity.
  const rank = { info: 0, warn: 1, high: 2 };
  for (const w of own) {
    const c = r.warnings.find(x => x.code === w.code && x.fromChat === w.fromChat);
    if (!c) continue;
    if (c.text) w.text = c.text;
    if ((rank[c.severity] ?? 0) > (rank[w.severity] ?? 0)) w.severity = c.severity;
  }
  const seen = new Set(own.map(w => w.code));
  const warnings = [...own, ...r.warnings.filter(w => !seen.has(w.code))];
  const suggestions = [];
  for (const sgg of [...plannerSuggestions(own, cctx.actionKinds), ...r.suggestions]) {
    if (suggestions.length >= 4 || suggestions.some(x => JSON.stringify(x.action) === JSON.stringify(sgg.action))) continue;
    try {
      const p = plan(sgg.action, after, { now: ctx.now, relax: true, continuity: false, project: false, knownNames: ctx.knownNames });
      if (!p.events.some(e => e.type !== 'director.action')) continue;
    } catch {
      continue;
    }
    suggestions.push({ action: sgg.action, why: sgg.why, source: 'code', code: sgg.code ?? null });
  }
  for (const w of warnings) {
    delete w.fix;
    const i = suggestions.findIndex(x => x.code === w.code);
    if (i >= 0) w.fix = i;
  }
  return { warnings, threads: r.threads, suggestions };
}

/** The continuity part of the content signature: codes, severities and threads. */
function continuitySig(cont) {
  if (!isObj(cont)) return null;
  return {
    warnings: (cont.warnings ?? []).filter(w => !w.projected).map(w => `${w.code}:${w.severity}`).sort(),
    threads: (cont.threads ?? []).map(t => `${t.kind}:${sigValue(t.id)}:${t.fate}`).sort(),
  };
}

// ── Plan / diff / fingerprint ─────────────────────────────────────────────

const toPlain = (v) => {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [k, toPlain(x)]));
  if (v instanceof Set) return [...v];
  if (Array.isArray(v)) return v.map(toPlain);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
};

function decisionsSummary(state) {
  const out = {};
  for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
    if (d.status === 'open' || d.status === 'committed' || d.closedAt === state.at) {
      out[d.id] = { kind: d.kind, status: d.status, committed: d.committed?.optionId ?? null, eventAt: d.subject?.eventAt ?? null };
    }
  }
  return out;
}

/** The slice of `state` at a dotted path ('vitals', 'story.controls', 'cast:<id>', 'places.<id>', 'decisions'). */
export function sliceOf(state, path) {
  if (path === 'decisions') return decisionsSummary(state);
  if (path.startsWith('cast:')) return toPlain(state?.cast?.get?.(path) ?? null);
  const [head, ...rest] = path.split('.');
  let cur = head === 'places' || head === 'cast' ? toPlain(state?.[head]) : toPlain(state?.[head]);
  for (const k of rest) cur = isObj(cur) ? cur[k] : undefined;
  return cur === undefined ? null : cur;
}

function diffInto(out, path, a, b, depth) {
  if (out.length >= DIFF_MAX) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (depth < 4 && isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffInto(out, `${path}.${k}`, a[k], b[k], depth + 1);
    return;
  }
  out.push({ path, from: a ?? null, to: b ?? null });
}

/** [{path, from, to}] over the given slices (≤ 100 entries). */
export function diffSlices(before, after, slices) {
  const out = [];
  for (const p of slices) diffInto(out, p, sliceOf(before, p), sliceOf(after, p), 0);
  return out;
}

/**
 * Fold the descriptors onto a copy of `state` (placeholder ids from
 * PREVIEW_ID_BASE, refs resolved; origins as appendEvent would derive them).
 * → the folded state.
 */
// Placeholder ids for a preview fold: a fixed base far above any real id, so the
// fold (and the diff: a new arc is keyed by its id) is the same at preview and at
// apply even when routine events moved lastEventId in between.
export const PREVIEW_ID_BASE = 1e12;

export function foldDescriptors(state, events, world) {
  let s = state;
  let id = Math.max(PREVIEW_ID_BASE, state.lastEventId);
  const ids = new Map();
  const origins = new Map();
  for (const d of events) {
    id += 1;
    ids.set(d.ref, id);
    const causeId = d.causeRef ? ids.get(d.causeRef) ?? null : (posInt(d.causeId) ?? null);
    let originKind;
    let originJid;
    if (d.actor === 'owner') { originKind = 'owner'; originJid = 'owner'; } else {
      const c = d.causeRef ? origins.get(d.causeRef) : (causeId ? (() => { const e = getEvent(causeId); return e ? { kind: e.originKind, jid: e.originJid } : null; })() : null);
      if (c && c.kind !== 'self' && c.kind !== 'owner') { originKind = c.kind; originJid = c.jid; } else { originKind = 'self'; originJid = 'self'; }
    }
    origins.set(d.ref, { kind: originKind, jid: originJid });
    const payload = resolvePayload(d, ids);
    const ev = {
      id, at: d.at, recordedAt: d.at, type: d.type, actor: d.actor, causeId, payload, originKind, originJid,
      subjectJid: d.subjectJid ?? null, heavy: d.heavy === true, redacted: false,
    };
    try { s = project(s, ev, world); } catch { /* a preview fold never throws past here */ }
  }
  return s;
}

function resolvePayload(d, ids) {
  const payload = structuredClone(d.payload ?? {});
  for (const [k, ref] of Object.entries(d.payloadRefs ?? {})) {
    payload[k] = Array.isArray(ref) ? ref.map(r => ids.get(r)).filter(Boolean) : (ids.get(ref) ?? null);
  }
  return payload;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The newest event id whose type is not routine (phone checks): the fingerprint's material marker. */
// Pointers nothing a Director plan reads (2026-11-02: during a live phone chat a text lands every
// minute or two, and each one made a preview stale before the owner could APPLY it). Their effects
// (relationship.changed, arc.stage) still count.
const MATERIAL_NEUTRAL = new Set(['phone.message', 'chat.load', 'chat.perceived', 'mood.chat']);

export function materialId() {
  let before = lastEventId() + 1;
  for (let page = 0; page < 20; page++) {
    const list = listEvents({ order: 'desc', limit: 200, ...(before ? { before } : {}) });
    if (!list.length) return 0;
    const hit = list.find(e => !ROUTINE_TYPES.has(e.type) && !MATERIAL_NEUTRAL.has(e.type));
    if (hit) return hit.id;
    before = list[list.length - 1].id;
  }
  return lastEventId();
}

function fpEvents(events) {
  return events.map((e) => {
    const payload = structuredClone(e.payload ?? {});
    if (e.type === 'world.rewound') {
      delete payload.uptoEventId;
      if (isObj(payload.cancelled?.byType)) {
        payload.cancelled = { byType: Object.fromEntries(Object.entries(payload.cancelled.byType).filter(([t]) => !ROUTINE_TYPES.has(t))) };
      }
    }
    return { ...e, payload };
  });
}

/** sha256 over {action, events, diff (vitals left out: they drift with the clock), materialId}. */
export function fingerprintOf(action, planned, material) {
  // Vitals drift with the clock (a phone check integrates them): the events say what the nudge is.
  const diff = (planned.diff ?? []).filter(d => !(d.path === 'vitals' || d.path.startsWith('vitals.')));
  return crypto.createHash('sha256').update(canonical({ action, events: fpEvents(planned.events), diff, materialId: material })).digest('hex');
}

// ── Time forms (spec 011): relative times on an action, resolved at planning ──
//   when: {date:'YYYY-MM-DD', time:'HH:MM'} (≤ WHEN_DAYS_MAX days ahead, world
//   time zone) | {inMinutes: 0..1440} (floored to IN_MINUTES_MIN) → startAt;
//   untilDays 1..31 → until; daysAgo 0..36500 → dated. Resolved at the planning
//   clock, so a preview resolves at its own time and apply's re-plan at
//   previewAt resolves identically.

const WHEN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WHEN_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function whenToUnix(w, now, tz) {
  if (!isObj(w)) throw err('invalid', 'bad_when');
  const keys = Object.keys(w);
  if (keys.length === 1 && keys[0] === 'inMinutes') {
    if (!Number.isInteger(w.inMinutes) || w.inMinutes < 0 || w.inMinutes > 1440) throw err('invalid', 'bad_when');
    return now + Math.max(IN_MINUTES_MIN, w.inMinutes) * MIN;
  }
  if (keys.length !== 2 || typeof w.date !== 'string' || typeof w.time !== 'string') throw err('invalid', 'bad_when');
  const d = WHEN_DATE_RE.exec(w.date);
  const t = WHEN_TIME_RE.exec(w.time);
  if (!d || !t) throw err('invalid', 'bad_when');
  const today = dateKey(now, tz);
  const last = dateKey(addDays(dayStart(now, tz), WHEN_DAYS_MAX, tz), tz);
  if (w.date < today || w.date > last) throw err('invalid', 'bad_when');
  return zonedToUnix(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]), tz);
}

// 011 Phase 2: a weather window's `from` / `to` may be a `when` object too, and a
// goal's window is whole local days: fromDay / toDay (0..GOAL_DAYS_MAX from the
// planning day; the page's form) or fromDate / toDate ('YYYY-MM-DD', the prompt's
// drafts, anchored to the prompt's date) → from = the first day's start, to = the
// end of the last day.
const DAY_FORMS = ['fromDay', 'toDay', 'fromDate', 'toDate'];

function dayFormToUnix(v, now, tz, field) {
  const today = dayStart(now, tz);
  if (field === 'fromDay' || field === 'toDay') {
    if (!Number.isInteger(v) || v < 0 || v > GOAL_DAYS_MAX) throw err('invalid', `bad_${field}`);
    return addDays(today, v, tz);
  }
  const d = typeof v === 'string' ? WHEN_DATE_RE.exec(v) : null;
  if (!d) throw err('invalid', `bad_${field}`);
  const at = zonedToUnix(Number(d[1]), Number(d[2]), Number(d[3]), 0, 0, tz);
  if (dateKey(at, tz) !== v || at < today || at > addDays(today, GOAL_DAYS_MAX, tz)) throw err('invalid', `bad_${field}`);
  return dayStart(at, tz);
}

/** An action with its relative time forms replaced by unix times (a copy; unchanged when it has none). */
export function resolveTimes(action, now, tz) {
  if (!isObj(action)) return action;
  const objectTimes = (action.kind === 'weather') && (isObj(action.from) || isObj(action.to));
  const dayForms = DAY_FORMS.some(k => action[k] !== undefined);
  if (action.when === undefined && action.untilDays === undefined && action.daysAgo === undefined && !objectTimes && !dayForms) return action;
  const a = { ...action };
  if (objectTimes) {
    for (const k of ['from', 'to']) if (isObj(a[k])) a[k] = whenToUnix(a[k], now, tz);
  }
  if (dayForms) {
    if (a.from !== undefined || a.to !== undefined) throw err('invalid', 'bad_window');
    if ((a.fromDay !== undefined) === (a.fromDate !== undefined) || (a.toDay !== undefined) === (a.toDate !== undefined)) {
      throw err('invalid', 'bad_window');
    }
    a.from = dayFormToUnix(a.fromDay ?? a.fromDate, now, tz, a.fromDay !== undefined ? 'fromDay' : 'fromDate');
    a.to = addDays(dayFormToUnix(a.toDay ?? a.toDate, now, tz, a.toDay !== undefined ? 'toDay' : 'toDate'), 1, tz);
    for (const k of DAY_FORMS) delete a[k];
  }
  if (a.when !== undefined) {
    if (a.startAt !== undefined) throw err('invalid', 'bad_when');
    a.startAt = whenToUnix(a.when, now, tz);
    delete a.when;
  }
  if (a.untilDays !== undefined) {
    if (a.until !== undefined || !Number.isInteger(a.untilDays) || a.untilDays < 1 || a.untilDays > 31) throw err('invalid', 'bad_untilDays');
    a.until = now + a.untilDays * DAY;
    delete a.untilDays;
  }
  if (a.daysAgo !== undefined) {
    if (a.dated !== undefined || !Number.isInteger(a.daysAgo) || a.daysAgo < 0 || a.daysAgo > 36500) throw err('invalid', 'bad_daysAgo');
    a.dated = now - a.daysAgo * DAY;
    delete a.daysAgo;
  }
  return a;
}

// ── Content signature (spec 011 review R2) ─────────────────────────────────
// What an action DOES, without its clock: per event the type, actor and the
// id-valued payload fields (targets), plus warnings and refusals. Two previews
// of the same draft with equal signatures act on the same objects; the page's
// APPLY ALL re-applies a stale draft only then. Times, previewAt and preview-
// range placeholder ids are left out.
const SIG_FIELDS = ['decisionId', 'targetId', 'castId', 'castIds', 'placeId', 'arcId', 'id', 'pinKey', 'category', 'mode',
  'slider', 'value', 'path', 'optionId', 'heavyId', 'bookmarkId', 'eventId'];

function sigValue(v) {
  if (Array.isArray(v)) return v.map(sigValue);
  if (typeof v === 'number' && v >= PREVIEW_ID_BASE) return '$new';
  return v ?? null;
}

/** sha256 over {kind, shape, events:[{type, actor, ids}], warnings, refusals}. */
export function contentSigOf(planned) {
  const events = (planned.events ?? []).map((e) => {
    const p = isObj(e.payload) ? e.payload : {};
    const ids = {};
    for (const k of SIG_FIELDS) if (p[k] !== undefined) ids[k] = sigValue(p[k]);
    if (isObj(p.subject)) ids.subject = { placeId: sigValue(p.subject.placeId), castIds: sigValue(p.subject.castIds) };
    return { type: e.type, actor: e.actor, ids, refs: e.payloadRefs ?? null };
  });
  const refusals = (planned.refusals ?? []).map(r => ({ reason: r.reason ?? null, target: r.target ?? null, pinKey: r.pinKey ?? null }));
  return crypto.createHash('sha256').update(canonical({
    kind: planned.action?.kind ?? null, shape: planned.action?.shape ?? null, events, warnings: planned.warnings ?? [], refusals,
    // 015 cont: a changed continuity warning or thread stops APPLY ALL's equal-signature rule (never the fingerprint).
    ...(planned.continuity ? { continuity: continuitySig(planned.continuity) } : {}),
  })).digest('hex');
}

function cleanAction(action) {
  if (!isObj(action) || typeof action.kind !== 'string' || !ACTION_KINDS.includes(action.kind)) throw err('invalid', 'bad_action');
  const s = JSON.stringify(action);
  if (s.length > 8192) throw err('invalid', 'too_long');
  return JSON.parse(s);
}

/**
 * Plan an action against `state` with the planning clock `opts.now`. Pure: it
 * reads the log and the story tables, never writes. → { events, warnings,
 * refusals, slices, before, after, diff, extra, post }
 */
export function plan(actionIn, state, opts = {}) {
  const now = Math.floor(finite(opts.now) ? opts.now : deps.now());
  const ctx = ctxFor(state, now, { knownNames: opts.knownNames ?? null });
  // 014 geo (R18): ids resolved by preview(), frozen and passed per call (never a store).
  ctx.resolved = isObj(opts.resolved) ? opts.resolved : {};
  ctx.relax = opts.relax === true;   // 015: hand-built owner previews only
  const action = resolveTimes(cleanAction(actionIn), now, ctx.tz);
  const b = makeBatch();
  let r;
  switch (action.kind) {
    case 'quick': r = planQuick(action, ctx, b); break;
    case 'fate': r = planFate(action, ctx, b); break;
    case 'slider': r = planSlider(action, ctx, b); break;
    case 'pin': case 'unpin': r = planPin(action, ctx, b); break;
    case 'pause': case 'resume': r = planPause(action, ctx, b); break;
    case 'bookmark': r = planBookmark(action, ctx, b); break;
    case 'bookmark.remove': r = planBookmarkRemove(action, ctx, b); break;
    case 'scene': r = planScene(action, ctx, b); break;
    case 'cast.edit': r = planCastEdit(action, ctx, b); break;
    case 'cast.history': r = planCastHistory(action, ctx, b); break;
    case 'cast.metrics': r = planCastMetrics(action, ctx, b); break;
    case 'place.edit': r = planPlaceEdit(withKindAlias(action, 'placeKind'), ctx, b); break;
    case 'seed.set': r = planSeedSet(action, ctx, b); break;
    case 'reconciler.mode': r = planReconcilerMode(action, ctx, b); break;
    case 'tray.adopt': r = planTrayAdopt(action, ctx, b); break;
    case 'heavy.end': r = planHeavyEnd(action, ctx, b); break;
    case 'proposal.approve': r = planProposalApprove(action, ctx, b); break;
    case 'weather': r = planWeather(action, ctx, b); break;
    case 'weather.end': r = planWeatherEnd(action, ctx, b); break;
    case 'goal': r = planGoal(action, ctx, b); break;
    case 'goal.cancel': r = planGoalCancel(action, ctx, b); break;
    // 014 geo
    case 'place.real': r = planPlaceReal(action, ctx, b, GEO_HELPERS); break;
    case 'places.realify': r = planRealify(action, ctx, b, GEO_HELPERS); break;
    case 'routes.refresh': r = planRoutesRefresh(action, ctx, b, GEO_HELPERS); break;
    case 'schedule': r = planSchedule(action, ctx, b, opts); break;            // 014 sched
    case 'schedule.clear': r = planScheduleClear(action, ctx, b); break;     // 014 sched
    // 015 Director as god
    case 'decision.pick': r = planPick(action, ctx, b); break;
    case 'outcome': r = planOutcome(action, ctx, b); break;
    case 'scene.tone': r = planSceneTone(action, ctx, b); break;   // 016
    case 'career': r = planCareer(action, ctx, b); break;
    case 'money': r = planMoney(action, ctx, b); break;
    case 'home': r = planHome(action, ctx, b); break;
    case 'mood': r = planMood(action, ctx, b); break;
    case 'wake': r = planWake(action, ctx, b); break;   // wake him
    case 'text': r = planText(action, ctx, b); break;   // 019 his phone
    case 'health': r = planHealth(action, ctx, b); break;
    case 'arc.end': r = planArcEnd(action, ctx, b); break;
    case 'cast.depart': r = planCastDepart(action, ctx, b); break;
    case 'cast.return': r = planCastReturn(action, ctx, b); break;
    case 'rewind': {
      const rw = planRewind(action, state, { ...ctx, getState: deps.getState, countSelfReplies: deps.countSelfReplies, chatName: deps.chatName });
      return { ...rw, action };
    }
    // 015 cont: several actions as one batch; a rewind + actions dated now.
    case 'bundle': return planBundle(action, state, { ...opts, now, knownNames: ctx.knownNames }, ctx);
    case 'retcon': return planRetcon(action, state, { ...opts, now, knownNames: ctx.knownNames }, ctx);
    default: throw err('invalid', 'bad_action');
  }
  const slices = r?.slices ?? [];
  const world = ctx.baseWorld ?? undefined;
  const after = b.events.length ? foldDescriptors(state, b.events, world) : state;
  // "before" as of the planning clock, so the diff shows the action, not the drift since the last event.
  // Always a view (age, position): it integrates nothing when now ≤ state.at, so preview
  // and apply see the same derived fields whatever routine event landed in between.
  let beforeView = state;
  try { if (world) beforeView = advanceTo(state, now, world); } catch { beforeView = state; }
  // 015 cont: the code continuity rules (opts.continuity === false skips them: bundle parts, suggestion checks).
  const continuity = opts.continuity === false ? null
    : continuityOf({ action, events: b.events, extra: r?.extra ?? null }, beforeView, after, ctx, state, opts, b.continuity);
  return {
    action, events: b.events, warnings: [...new Set(b.warnings)], refusals: b.refusals, slices,
    before: Object.fromEntries(slices.map(p => [p, sliceOf(beforeView, p)])),
    after: Object.fromEntries(slices.map(p => [p, sliceOf(after, p)])),
    diff: diffSlices(beforeView, after, slices), extra: r?.extra ?? null, post: r?.post ?? null, afterState: after,
    ...(continuity ? { continuity } : {}),
  };
}

function publicEvents(events) {
  return events.map(e => ({
    ref: e.ref, type: e.type, actor: e.actor, at: e.at,
    ...(e.causeRef ? { causeRef: e.causeRef } : {}), ...(e.causeId ? { causeId: e.causeId } : {}),
    ...(e.heavy ? { heavy: true } : {}), payload: e.payload, ...(e.payloadRefs ? { payloadRefs: e.payloadRefs } : {}),
  }));
}

/**
 * Preview an action (POST /api/director/preview; 403 in read-only, CSRF-checked).
 * → { previewId, fingerprint, expiresAt, before, after, diff, events, warnings, refusals, extra? }
 */
export async function preview(action, opts = {}) {
  const state = liveState();
  const now = Math.floor(deps.now());
  // 014 geo: resolve candidate / job-result ids once, into a frozen copy kept with the preview.
  const resolved = await resolveGeoAction(action, state, { geo: deps.geo, world: worldFor(state, deps.world), err });
  const planned = plan(action, state, { now, ...opts, resolved });
  const fingerprint = fingerprintOf(planned.action, planned, materialId());
  // 014 sched (§A5.8): the projected rest of today and tomorrow, before / after (display only).
  if (SCHEDULE_KINDS.has(planned.action.kind)) {
    planned.extra = { ...(planned.extra ?? {}), projection: await scheduleProjection(state, planned.events, now) };
  }
  const previewId = crypto.randomUUID();
  const expiresAt = now + PREVIEW_TTL_SEC;
  // 015 cont: the re-projected future (display only: never in the fingerprint, never run by apply).
  const projection = await projectionOf(planned, state, now, opts);
  cache.set(previewId, { action: planned.action, previewAt: now, fingerprint, expiresAt, resolved, projection, relax: opts.relax === true });
  while (cache.size > PREVIEW_MAX) cache.delete(cache.keys().next().value);
  deps.logger.info({ evt: 'arcs.director.preview', kind: planned.action.kind, events: planned.events.length, refusals: planned.refusals.length }, 'story: director preview');
  return {
    previewId, fingerprint, expiresAt, contentSig: contentSigOf(planned),
    before: planned.before, after: planned.after, diff: planned.diff,
    events: publicEvents(planned.events), warnings: planned.warnings, refusals: planned.refusals,
    ...(planned.extra ? { extra: planned.extra } : {}),
    // 015 cont
    continuity: planned.continuity ?? null, ...(projection ? { projection } : {}),
  };
}

// 015 (plan §P1.1 review #28): kinds whose apply touches a decision run inside
// pulse.exclusive → decisions.withDecisionLock (pulse chain outer, decision lock
// inner — a tick's order), so a deadline commit and an owner pick never both land.
// A bundle / retcon takes them when any of its parts would.
const LOCKED_KINDS = new Set(['decision.pick', 'outcome', 'career', 'cast.depart', 'health', 'home']);

function needsLocks(action) {
  if (LOCKED_KINDS.has(action?.kind)) return true;
  return (action?.kind === 'bundle' || action?.kind === 'retcon') && Array.isArray(action.actions)
    && action.actions.some(a => LOCKED_KINDS.has(a?.kind));
}

function underLocks(action, fn) {
  if (!needsLocks(action)) return fn();
  const inner = () => withDecisionLock(fn);
  return typeof deps.pulse?.exclusive === 'function' ? deps.pulse.exclusive(inner) : inner();
}

/**
 * Append descriptors in order through `append` (the facade's appender),
 * resolving `$n` refs. The `director.action` gets the fingerprint in its
 * payload. → { byRef: Map(ref → event), eventIds: [ids in order] }
 */
export function appendDescriptors(events, append, { fingerprint = null, rewoundId = null } = {}) {
  if (typeof append !== 'function') throw err('not_running');
  const ids = new Map();
  const byRef = new Map();
  if (rewoundId) ids.set('$rewound', rewoundId);
  const eventIds = [];
  const lastOf = {};   // the real id of the newest career.set / self.moved appended here
  for (const d of events) {
    const payload = resolvePayload(d, ids);
    if (d.type === 'director.action' && fingerprint) payload.fingerprint = fingerprint;
    if (d.type === 'plan.made' && typeof payload.driftKey === 'string') payload.driftKey = realDriftKey(payload.driftKey, lastOf);
    const causeId = d.causeRef ? (ids.get(d.causeRef) ?? null) : (posInt(d.causeId) ?? null);
    const ev = append({
      type: d.type, at: d.at, actor: d.actor, ...(causeId ? { causeId } : {}), payload,
      ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}), ...(d.heavy ? { heavy: true } : {}),
    });
    ids.set(d.ref, ev.id);
    byRef.set(d.ref, ev);
    eventIds.push(ev.id);
    if (d.type === 'career.set' || d.type === 'self.moved') lastOf[d.type] = ev.id;
  }
  return { byRef, eventIds };
}

// A re-plan built at preview carries the drift key it was folded under, with the
// preview's placeholder ids (career part | home part): the same batch's career.set /
// self.moved real ids replace them, so the exclusion signature (overlay:<key>)
// matches the folded key. A placeholder with no such event → the key is left out
// (the fold stamps s.plan.driftKey itself).
function realDriftKey(key, lastOf) {
  const parts = key.split('|');
  if (parts.length !== 2) return key;
  const fix = (x, type) => {
    if (!/^\d{1,16}$/.test(x) || Number(x) < PREVIEW_ID_BASE) return x;
    return lastOf[type] ? String(lastOf[type]) : null;
  };
  const c = fix(parts[0], 'career.set');
  const h = fix(parts[1], 'self.moved');
  return c === null || h === null ? undefined : `${c}|${h}`;
}

// One apply is one transaction: an appendEvent refusal half-way leaves nothing in
// the log. The facade's in-memory projection may already hold the folded part, so
// deps.onApplyFailed (the facade: rebuild) runs before the error is returned.
function atomically(fn) {
  let db = null;
  try { db = getDbSync(); } catch { db = null; }
  try {
    return db ? db.transaction(fn)() : fn();
  } catch (e) {
    try { deps.onApplyFailed?.(); } catch { /* best effort */ }
    deps.logger.warn({ evt: 'issue', where: 'arcs.director', err: e?.code || e?.name }, 'story: director apply rolled back');
    if (e instanceof StoryError) throw e;
    throw err('conflict', 'apply_failed');
  }
}

function setClaimStatus(claimId, status, by) {
  if (typeof deps.setClaimStatus === 'function') return deps.setClaimStatus(claimId, status, by);
  try {
    getDbSync().prepare('UPDATE life_claims SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
      .run(status, Math.floor(deps.now()), String(by || 'owner').slice(0, 64), claimId);
  } catch { /* the review row is the source of truth */ }
  return undefined;
}

/**
 * Apply a preview (POST /api/director/apply): re-plan against the live state
 * with now := previewAt; a different fingerprint → stale. Appends exactly the
 * planned events. → { ok:true, actionEventId, eventIds }
 */
export async function apply(previewId, fingerprint, { by = 'owner' } = {}) {
  const entry = typeof previewId === 'string' ? cache.get(previewId) : null;
  const now = Math.floor(deps.now());
  if (!entry || entry.expiresAt <= now) {
    if (entry) cache.delete(previewId);
    throw err('expired', 'expired_preview');
  }
  if (typeof fingerprint !== 'string' || fingerprint !== entry.fingerprint) throw err('stale', 'stale');
  return underLocks(entry.action, () => applyEntry(previewId, entry, fingerprint, { by }));
}

async function applyEntry(previewId, entry, fingerprint, { by }) {
  const state = liveState();
  if (typeof deps.append !== 'function') throw err('not_running');
  const planned = plan(entry.action, state, { now: entry.previewAt, resolved: entry.resolved, relax: entry.relax === true });   // 015 cont: the preview's relax
  const fp = fingerprintOf(planned.action, planned, materialId());
  if (fp !== entry.fingerprint) throw err('stale', 'stale');
  if (!planned.events.some(e => e.type !== 'director.action')) {
    throw err('refused', planned.refusals[0]?.reason ?? 'nothing', { refusals: planned.refusals });
  }
  cache.delete(previewId);

  if (planned.action.kind === 'rewind' || planned.action.kind === 'retcon') {
    const res = await applyRewind(planned, {
      append: deps.append, getState: deps.getState, pulse: deps.pulse, fingerprint, by, now: entry.previewAt,
      appendDescriptors: (list, append, opts) => atomically(() => appendDescriptors(list, append, opts)),
    });
    deps.logger.info({ evt: 'arcs.director.apply', kind: planned.action.kind, events: res.eventIds.length }, 'story: director apply');
    return { ok: true, actionEventId: res.actionEventId, eventIds: res.eventIds, ...appliedContinuity(planned) };
  }

  const { byRef, eventIds } = atomically(() => appendDescriptors(planned.events, deps.append, { fingerprint }));
  const parent = planned.events.find(e => e.type === 'director.action');
  const post = planned.post;
  if (post?.review) {
    const adopted = post.review.adoptedRef ? byRef.get(post.review.adoptedRef)?.id ?? null : null;
    const patch = post.review.status === 'adopted'
      ? { status: 'adopted', reason: null, adoptedEventId: adopted, decidedBy: String(by).slice(0, 100) }
      : { status: 'dismissed', reason: 'owner', decidedBy: String(by).slice(0, 100) };
    try {
      store.updateReview(post.review.id, patch, { fromStatus: ['tray', 'returned'] });
      const r = store.getReview(post.review.id);
      if (r) await setClaimStatus(r.claimId, post.review.status === 'adopted' ? 'adopted' : 'dismissed', by);
    } catch (e) {
      deps.logger.warn({ evt: 'issue', where: 'arcs.director', reviewId: post.review.id, err: e?.code || e?.name }, 'story: review update after apply failed');
    }
  }
  if (post?.proposal) {
    try { store.decideProposal(post.proposal.id, { status: 'applied', by: String(by).slice(0, 100) }); } catch { /* best effort */ }
  }
  deps.logger.info({ evt: 'arcs.director.apply', kind: planned.action.kind, events: eventIds.length }, 'story: director apply');
  return { ok: true, actionEventId: parent ? byRef.get(parent.ref)?.id ?? null : null, eventIds, ...appliedContinuity(planned),
    // 014 sched / wake him: the facade runs what is now due at once (the re-plan, a wake now).
    ...(planned.events.some(e => e.type.startsWith('schedule.') || e.type === 'wake.set') ? { schedule: true } : {}),
    ...(planned.events.some(e => e.type === 'phone.text_set') ? { phone: true } : {}) };   // 019: the story facade runs the phone job now
}

// ── 015 cont: preview/apply helpers ───────────────────────────────────────

/** What an apply reports for the audit: the continuity codes ≥ warn it overrode, and a batch's parts. */
function appliedContinuity(planned) {
  return {
    continuity: codesAtLeast(planned.continuity, 'warn'),
    ...(Array.isArray(planned.parts) ? { parts: planned.parts.map(p => ({ kind: p.kind, source: p.source })) } : {}),
    ...(planned.action.kind === 'retcon' ? { toEventId: planned.extra?.toEventId ?? null, cancelled: planned.extra?.cancelled?.total ?? null } : {}),
  };
}

export const __bundleTest = { renumberPart, refOfPlaceholder, partsOf, needsLocks };

async function projectionOf(planned, state, now, opts) {
  if (opts.project === false || !deps.world || !PROJECT_KINDS.has(planned.action.kind)) return null;
  if (!planned.events.some(e => e.type !== 'director.action')) return null;
  const retcon = planned.action.kind === 'retcon' && isObj(planned.retcon);
  let projection;
  try {
    projection = await buildProjection({
      state, afterBase: retcon ? planned.retcon.baseState : state,
      descriptors: retcon ? planned.retcon.actionEvents : planned.events,
      world: deps.world, now, budgetMs: deps.projectionBudgetMs ?? undefined,
      deps: {
        appendDescriptors: (list, ap) => appendDescriptors(list, ap),
        worldOf: typeof deps.worldOf === 'function' ? (s) => deps.worldOf(s, deps.world) : undefined,
        storyItems: deps.storyItems ?? undefined, blockCause: deps.blockCause ?? undefined, planCause: deps.planCause ?? undefined,
        atWake: deps.atWake ?? undefined,
      },
    });
  } catch {
    projection = { skipped: 'failed' };
  }
  // C10: a projected balance below zero within the window.
  const m = projection?.money;
  if (planned.continuity && Number.isFinite(m?.min) && m.min < 0 && !(Number.isFinite(m.before) && m.before < 0)
    && !planned.continuity.warnings.some(w => w.code === 'money_negative')) {
    planned.continuity.warnings.push({ ...cleanWarning({ code: 'money_negative', severity: 'warn', text: `his balance would dip below zero (${m.min}) in the next hours` }), projected: true });
  }
  // A plan the change commits that the projection shows he can't make (still at
  // work, on the road, asleep at its point of no return): it would silently not happen.
  for (const d of Array.isArray(projection?.decisions) ? projection.decisions : []) {
    if (!planned.continuity || d.after !== 'missed' || d.before === 'missed') continue;
    if (planned.continuity.warnings.some(w => w.code === 'projected_missed' && w.fromChat === d.fromChat)) continue;
    planned.continuity.warnings.push({ ...cleanWarning({ code: 'projected_missed', severity: 'warn', fromChat: d.fromChat,
      text: `the projection shows he can't make ${d.label} (asleep then, or no way to get there in time)`,
      refs: { decisionIds: Number.isSafeInteger(d.id) ? [d.id] : [] } }), projected: true });
  }
  return projection;
}

/**
 * A live preview entry (the story read's door: action, planning clock,
 * fingerprint, the cached projection) or null once expired.
 */
export function previewEntry(previewId) {
  const entry = typeof previewId === 'string' ? cache.get(previewId) : null;
  if (!entry || entry.expiresAt <= Math.floor(deps.now())) return null;
  return { action: entry.action, previewAt: entry.previewAt, fingerprint: entry.fingerprint, projection: entry.projection ?? null, relax: entry.relax === true };
}

/**
 * A `scene` action draft from a tray claim (POST /api/arcs/claims/:id/scene):
 * structured ids only — place, cast, time, minutes and fromReviewId — never
 * claim or extraction text. Outing when the claim resolved a place, else a
 * visit draft the owner completes.
 */
export function sceneDraftFromReview(reviewId) {
  const r = posInt(reviewId) ? store.getReview(posInt(reviewId)) : null;
  if (!r) throw err('not_found', 'review');
  if (!['tray', 'returned'].includes(r.status)) throw err('conflict', 'review_state');
  const res = isObj(r.resolution) ? r.resolution : {};
  const state = deps.getState?.() ?? null;
  const castIds = (Array.isArray(res.castIds) ? res.castIds : []).filter(id => typeof id === 'string' && CAST_ID_RE.test(id)
    && (!state || state.cast?.has?.(id))).slice(0, 4);
  const placeId = typeof res.placeId === 'string' && PLACE_ID_RE.test(res.placeId) ? res.placeId : null;
  const start = posInt(res.span?.start);
  const end = posInt(res.span?.end);
  const minutes = start && end ? clamp(Math.round((end - start) / MIN), 15, 360) : 90;
  const home = state?.self?.homePlaceId ?? null;
  return {
    kind: 'scene',
    shape: placeId && placeId === home ? 'visit' : 'outing',
    ...(placeId && placeId !== home ? { placeId } : {}),
    castIds, ...(start ? { startAt: start } : {}), minutes, fromReviewId: r.id,
  };
}

/**
 * Preview tomorrow (POST /api/director/preview-tomorrow): the next 24 h on a
 * copy of the projection — no model calls, nothing written (tomorrow.js).
 */
export async function previewTomorrow(opts = {}) {
  const state = liveState();
  if (!deps.world) throw err('not_running', 'world');
  return simulateTomorrow(state, deps.world, {
    now: Math.floor(deps.now()), storyItems: deps.storyItems ?? undefined, atWake: deps.atWake ?? undefined,
    blockCause: deps.blockCause ?? undefined, planCause: deps.planCause ?? undefined,
    ...(typeof deps.worldOf === 'function' ? { worldOf: deps.worldOf } : {}), ...opts,
  });
}

/** Clear the preview cache (tests, detach). */
export function clearPreviews() {
  cache.clear();
}
