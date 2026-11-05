import { getDb } from '../memory/db.js';
import { dateKey, ageOn, resolveTimezone } from './clock.js';
import { initialVitals, normalizeVitals, integrate, applyEvent as applyVitalsEvent, activityClass, applyCouplings } from './vitals.js';
import { applyEmbargoEvent } from './embargo.js';
import { lerpPosition } from './travel.js';
import { AVAILABILITY_STATES } from './queue.js';
import { eventsAfter, listReverts, cascadeIds, listRewinds, planBlockDecision, lastEventId, getEvent, redactionGeneration } from './eventLog.js';
import { getWorld } from './world.js';
import { initialStory, STORY_HANDLERS, STORY_OBSERVERS, GOD_HANDLERS, SCENE_HANDLERS, SCENE_OBSERVERS, isRewindKept, worldOverlay, cleanVenue, placesSigOf, overlayKey, overlayMemoKey, driftKey } from './story/reducer.js';
// 014 geo: the projected places' content key (memo) — pure.
import { placesKey } from './places.js';
// 012: the overlay's pure math and caps (no DB, no clock).
import { overlayAt as chatMoodOverlay, WINDOW_SEC as CHAT_MOOD_WINDOW_SEC, ENTRIES_MAX as CHAT_MOOD_MAX } from './influence/mood.js';
import { normalize as normalizeOverride, scheduleSigKey, PRUNE_DAYS as SCHEDULE_PRUNE_DAYS, OVERRIDES_MAX as SCHEDULE_MAX } from './planEdits.js';   // 014 sched

// The projection (spec 009 plan §R1/§D): his current state is a fold of the
// world log. project(state, event, world) is the reducer for the §D catalogue;
// rebuild() is the only entry that reads the DB — latest valid snapshot, then
// a replay of later events in id (append) order.
//
// Purity and cost: project() never mutates its input — it clones once
// (structuredClone keeps the Maps/Sets) and applies the event to the copy.
// rebuild() clones once and folds every event into that one private draft in
// place, so a long replay doesn't pay a clone per event (SC-008: < 1 s).
//
// Vitals are not logged per tick (R1 rejects 96 rows/day): before each applied
// event the reducer integrates vitals from the previous event's time to this
// one under the activity then in force (vitals.integrate), then applies the
// event's discrete jump (vitals.applyEvent). Same events → same vitals, live
// or replayed. `at` is not monotone in id order (catch-up writes past times),
// so a negative gap integrates nothing. advanceTo() gives a VIEW at a later
// time for readers (prompts, gate, dashboard); a view is never projected onto
// — that would integrate the same minutes twice — and project() refuses one.
//
// Reverts (R1): `event.reverted {targetId}` excludes the target and every
// engine/jev event reachable from it through engine/jev links (the same walk
// as eventLog.cascadeIds). Chat, mind and owner events caused by an excluded
// event still apply — they are "orphaned" (isOrphaned(), Timeline) — and the
// walk does not continue through them (except an owner commit / reversal /
// lean caused by a decision.opened: it goes with that decision, 015). A revert
// can't be undone inside a live project() call (the target's effects are
// already folded in), so the reducer
// records it and sets `rebuildNeeded`; the facade calls applyAppended(), which
// rebuilds. Excluded events still advance lastEventId: a snapshot's
// upto_event_id means "highest id consumed", not "highest id applied".
//
// Payloads are untrusted shapes even after eventLog sanitized their strings —
// redacted rows arrive as {redacted:true}, 010 adds types — so every handler
// picks typed fields with caps and tolerates anything missing. Unknown types
// only advance the bookkeeping.
//
// Payload contract the pulse/routine/decisions write (all fields optional
// unless noted; times unix seconds):
//   genesis            { worldHash, source, timezone, self:{birthdate, homePlaceId, officePlaceId|job.officePlaceId,
//                        relationship}, vitals } — the facade should copy `self` into the payload so a later
//                        world.json edit can't rewrite history; falls back to world.self
//   place.created      { id, name, kind, lat, lon }      cast.created  { id, name, relation, …world.json cast fields }
//   plan.made          routine.js planDay(): { date, dayType, wakeAt, lateBy, sleepAt, nextWakeAt, workLate, skipped,
//                        blocks:[{kind, placeId, start, end, availability, withCast, social, from, to, mode, km, minutes, cost}] }
//   activity.started   { kind, placeId, start, end|until, availability, withCast, social }
//   activity.ended     { kind }                          travel.started { from, to, mode, km, minutes, cost }
//   travel.arrived     { to }                            sleep.started  { until }
//   woke               { lateBy, debt, sleptMin, cycleMin, durationMin, firstNight }   work.late { extraMin, until }
//   weather.changed    weather.js outcome { rain, condition, tempC, until }
//   sick.started       { until, days }                   money.*        { amount }
//   availability.changed { state, until, reason }        phone.check.*  { until } / { nextCheckAt, reason }
//   decision.opened    R8 shape (decision id = this event's id); later decision.* and chat.trigger carry
//                      { decisionId }; decision.lean { optionId, p, probs, trigger, fallback };
//                      decision.committed { optionId, p, sampled, wanted }; decision.reversed { from, to };
//                      decision.expired { reason } (could_not_go closes a committed one: status 'missed');
//                      decision.mode_set { mode }; chat.trigger { decisionId, toward }
//   birthday           { castId } (absent → his own)     alert.raised   { kind }
//   embargo.*          embargo.js descriptors            event.reverted { targetId, reason, by }
//
// Spec 010 (story slice, rewinds):
//   - HANDLERS = story/reducer.js STORY_HANDLERS under the 009 table (009 wins
//     on a clash); STORY_OBSERVERS run AFTER the 009 handler of their type.
//   - `world.rewound {toEventId}` (owner) excludes the id range toEventId+1 …
//     its own id−1 (state.excludedRanges). Inside a range, the REWIND_KEEP
//     events (reducer.isRewindKept: controls, reverts, vetoes, claim pointers,
//     owner/privacy expiries) still fold — as bookkeeping, like event.reverted:
//     handler only, no vitals integration, no s.at advance — and their ids go
//     into state.keptInRange, which the cause cascade consults. Everything
//     else in a range is excluded without an exclusion signature (the rewind
//     re-anchors at now). world.rewound itself always folds as bookkeeping.
//   - Vitals integrate under worldOverlay(state, world): a career.job_changed
//     moves the office activityClass sees. The overlay is the world itself
//     until a career.* event exists, so a 009 log folds exactly as before.
//   - decision.opened keeps category/big/adopted/bigDowngraded/arcId/claimId,
//     option bias and the event's subjectJid; decision.committed keeps `by`;
//     an owner pick is never reversed; frozen/pinned/owner_cancelled/withdrawn
//     expiries close a committed decision too (status cancelled).
//   - A jev lean on a decision with a stored category counts as an arc call
//     (counters.arcJevToday); the day rollover resets the counters in place.

// Spec 012 (chats shape his life):
//   - `chat.perceived` (an inert chat pointer) and `mood.chat` fold as
//     bookkeeping (NON_INTEGRATING): handler only, no vitals integration, s.at
//     unchanged — a chat blip never splits the base vitals integration.
//   - `mood.chat` pushes an entry onto s.chatMood; views (advanceTo, vitalsAt,
//     sharedView) add the decayed, clamped sum to mood/stress/social through
//     withChatMood while the overlay gate (setOverlayGate, installed by the
//     influence facade; default off) is open. Base s.vitals never sees it; a view
//     that got an overlay carries the base vitals as `vitalsBase` (decisions read
//     those for story-family decisions). `{ chatMood: false }` skips it.
//   - `sleep.delayed` moves tonight's sleep block, plan.sleepAt and the current
//     activity's end (s.sleep.delayedFor, cleared by woke); `work.behind` sets
//     s.influence.workBehindDay (its vitals case adds work pressure).
//   - Every new key (s.chatMood, s.influence, s.sleep.delayedFor) appears only
//     when the first influence event folds, so a log without one serializes
//     exactly as before. Every new handler is a no-op on a redacted event.

// Spec 011 (story prompt, Phase 2):
//   - `weather.window_set` (owner) pushes { id, from, to, sky, intensity } onto
//     s.weatherWindows (≤ 8, re-validated: finite ints, to > from, ≤ 72 h, sky
//     enum, intensity clamped; ended > 24 h ago pruned; over 8, ended windows
//     are dropped before any open one); `weather.window_ended`
//     cuts that window's `to` to its time. weather.js:weatherFor reads them.
//     `weather.changed` keeps `windowId` (a window's emission) and `by:'owner'`
//     (a quick RAIN) — each only when set, so a 009 log folds exactly as before.
//   - `goal.*` keeps s.goals[id] (≤ 32; closed ones pruned after 30 days);
//     decision.opened keeps `goalId`, decision.committed `by:'goal'`.
//     STEER_OBSERVERS (after the 009 handler): an expiry of a fitted goal's
//     decision reopens the goal (could_not_go, rewound, frozen, pinned, sick,
//     heavy, paused — those three and rewound also close a committed goal decision) or,
//     on an owner cancel, closes it; a `goal.deferred` of a fitted goal reopens it.
//   - `commute.soaked` (cause = its travel.started) moves that trip's arrival,
//     the commute activity's end and its availability `until` by lateMin, and
//     sets s.soakedAt { at, eventId, travelEventId, … } (cleared by the next sleep.started).
//   - Every new key (s.weatherWindows, s.goals, s.soakedAt) appears only when
//     the first 011 event folds; every 011 handler is a no-op on a redacted event.

// Spec 014 sched (schedule edits):
//   - `schedule.override_set` (owner) keeps s.scheduleOverrides[id] = the
//     normalized override (planEdits.normalize) + { id, setAt, status:'active' };
//     `schedule.override_cleared` marks it cleared (clearedAt, clearedEventId) and
//     clips its background/ranges at the clear's `from`. Entries dated more than
//     PRUNE_DAYS before the event are pruned at each schedule fold.
//   - plan.made keeps `overrides` (ids) and blocks keep fromOverride / overrideId /
//     causeEventId (< the plan's id) / decisionId — each only when present.
//   - A schedule expiry (decision.expired {reason:'schedule'}) cancels a decision
//     (CLOSING_REASONS) and reopens its goal (GOAL_REOPEN); a re-plan's exclusion
//     signature is `schedule:<date>:<ids>` (R37).
//   - s.scheduleOverrides appears only when the first schedule event folds.

// 2 (2026-10-31): the vitals rebalance (vitals.js) changed the integration, so a
// v1 snapshot holds vitals no replay would produce. v1 rows are skipped as
// unreadable (never deleted), the first rebuild after the upgrade replays the
// whole log under the new rates, and "snapshot rebuild ≡ full replay" holds again.
// 3 (2026-11-02): a revert no longer cascades through a plan into another
// outing's blocks; older snapshots folded under the old rule are replayed once.
export const SNAPSHOT_VERSION = 3;
export const SNAPSHOT_KEEP = 14;

const CASCADE_ACTORS = new Set(['engine', 'jev']);
// 012: chat blips and their pointers are not something that happened over time.
const NON_INTEGRATING = new Set(['chat.perceived', 'mood.chat']);
const INVITE_ANSWERS = new Set(['yes', 'late', 'no', 'maybe']);
const FOLLOW_UP_OUTCOMES = new Set(['going', 'late', 'not_going']);
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const DECISION_MODES = new Set(['auto', 'ask']);
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,47}$/;
const KIND_RE = /^[a-z][a-z0-9_:-]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_INTEGRATE_MIN = 7 * 24 * 60; // a gap longer than a week integrates a week (world.reanchored skips it)
const MAX_PLAN_BLOCKS = 64;
const MAX_OPTIONS = 8;
const MAX_ORIGINS = 16;
const MAX_SIGNALS = 10;
const MAX_ALERTS = 20;
const MAX_DECISIONS = 64;
const DECISION_KEEP_SEC = 3 * 86400; // closed decisions stay visible this long
const MAX_HISTORY = 8;
const MAX_EXCLUDED_SIGS = 256;
const MAX_RANGES = 256;
const BIAS_MAX = 3;
const COMMIT_BY = new Set(['owner', 'lean', 'sample', 'early', 'adopted', 'reply', 'goal', 'text']);   // 012: 'reply' (his answer to an invitation); 011: 'goal'; 019: 'text' (a plan agreed in texts)
// Expiry reasons that also close a COMMITTED decision (data-model §2.5): a
// refused consequence, an owner cancel or a privacy withdrawal is terminal.
// 012: an inviter calling a committed invitation off.
// 015: a god cancel (fell_through), a career change and a departure close a committed one too.
const CLOSING_REASONS = new Set(['frozen', 'pinned', 'owner_cancelled', 'withdrawn', 'inviter_cancelled',
  'fell_through', 'career_changed', 'cast_departed',
  'text_changed']);   // 2026-11-05: later texts moved or called off a plan made in texts
const PERSON_JID_RE = /^[0-9A-Za-z._:-]{1,80}@(?:s\.whatsapp\.net|lid)$/;
// 011
const WINDOW_SKIES = new Set(['clear', 'cloudy', 'rain', 'storm', 'heat']);
const WINDOWS_MAX = 8;
const WINDOW_MAX_SEC = 72 * 3600;
const WINDOW_KEEP_SEC = 24 * 3600;
const GOAL_KINDS = new Set(['meet', 'call', 'outing', 'errand']);
const GOALS_MAX = 32;
const GOAL_KEEP_SEC = 30 * 86400;
const GOAL_REOPEN = new Set(['could_not_go', 'rewound', 'frozen', 'pinned', 'sick', 'heavy', 'paused', 'fell_through']);
// 015: a departed member's goal closes (refitting it would bring them back).
const GOAL_CLOSE = new Set(['cast_departed']);
// 014 sched: a schedule edit cancels a decision and sends its goal back to open.
CLOSING_REASONS.add('schedule');
GOAL_REOPEN.add('schedule');
// 2026-11-02: an owner outing set up over another plan cancels it the same way (no trust cost).
CLOSING_REASONS.add('owner_plan');
GOAL_REOPEN.add('owner_plan');
// Close a committed goal decision too ('rewound': a rewind took its evening out, rewind.js step 4).
const GOAL_BLOCKED = new Set(['sick', 'heavy', 'paused', 'rewound']);
const SOAK_LATE_MAX = 20;
const STR_MAX = 200;
const REPLAY_PAGE = 5000;
const SNAPSHOT_SCAN = 32;

const fail = (msg) => { throw new Error(`projector: ${msg}`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const str = (v, max = STR_MAX) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const kindOf = (v) => (typeof v === 'string' && KIND_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);
const placeId = (v) => (typeof v === 'string' && PLACE_ID_RE.test(v) ? v : null);
const castId = (v) => (typeof v === 'string' && CAST_ID_RE.test(v) ? v : null);
const optionId = (v) => (typeof v === 'string' && OPTION_ID_RE.test(v) ? v : null);
const availability = (v) => (typeof v === 'string' && AVAILABILITY_STATES.has(v) ? v : null);
const clamp01 = (v, dflt = 0) => (finite(v) ? Math.min(1, Math.max(0, v)) : dflt);
const castIds = (v) => (Array.isArray(v) ? [...new Set(v.map(castId).filter(Boolean))].slice(0, 16) : []);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const personJid = (v) => (typeof v === 'string' && v.length <= 96 && PERSON_JID_RE.test(v) ? v : null);

// ── State ─────────────────────────────────────────────────────────────────

/** Empty WorldState (§D) before genesis. Vitals start from the world's defaults. */
export function createInitialState(world) {
  return {
    lastEventId: 0,
    at: null,          // world time of the last applied event (the integration anchor)
    genesisAt: null,
    world: { source: null, hash: null, timezone: resolveTimezone(world?.timezone) },
    self: { birthdate: null, age: null, homePlaceId: null, officePlaceId: null, relationship: 'single', lastBirthdayAt: null },
    places: new Map(),
    cast: new Map(),
    position: { placeId: null, lat: null, lon: null, travel: null },
    activity: idleActivity(null, null, null),
    plan: null,
    vitals: initialVitals(world),
    weather: null,
    availability: { state: 'free', since: null, until: null, onPhone: false, eventId: null },
    phone: { lastCheckAt: null, checkStartedAt: null, checkUntil: null, lastCheckEndAt: null, nextCheckAt: null },
    sleep: { startedAt: null, eventId: null, lastWokeAt: null, lateBy: 0, wokeEventId: null },
    sick: null,
    work: { lateAt: null, lateEventId: null, crunchAt: null },
    money: { lastSalaryAt: null, lastSalaryEventId: null },
    decisions: new Map(),
    embargo: null,
    alerts: [],
    lastCall: null,
    claims: { flagged: 0, lastFlaggedAt: null },
    checkpoint: null,
    reanchoredAt: null,
    excluded: new Set(),
    excludedSigs: [],  // what the excluded events were (pulse: "happened and undone", not "due")
    counters: { jevDay: null, jevToday: 0, arcJevDay: null, arcJevToday: 0 },
    rebuildNeeded: false,
    // 010
    story: initialStory(),
    excludedRanges: [], // [{from, to, eventId}] from world.rewound (eventId = the rewind's id)
    keptInRange: new Set(), // ids of REWIND_KEEP events inside a range (folded as bookkeeping)
  };
}

function idleActivity(placeIdValue, at, eventId) {
  return { kind: 'idle', placeId: placeIdValue, startAt: at, endAt: null, availability: null, withCast: [], social: false, eventId };
}

function cloneState(state) {
  if (!isObj(state)) fail('state must be a WorldState');
  if (state.view) fail('cannot project onto an advanceTo() view');
  return structuredClone(state);
}

// ── Reducer ───────────────────────────────────────────────────────────────

/**
 * Fold one event into a copy of `state` and return it. `world` supplies the
 * constants vitals need (rates, timezone, office place); omit it only in tests.
 * Excluded events (reverted, or engine/jev consequences of a reverted event)
 * change nothing except lastEventId.
 */
export function project(state, event, world) {
  const draft = cloneState(state);
  applyInPlace(draft, event, world);
  return draft;
}

/**
 * True when event id `id` is out of the projection: in the revert set, or
 * inside a rewind range and not a kept (REWIND_KEEP) event. Only meaningful
 * for ids the state has already folded (keptInRange is filled at fold time).
 */
export function isExcludedId(state, id) {
  if (!Number.isSafeInteger(id)) return false;
  if (state?.excluded instanceof Set && state.excluded.has(id)) return true;
  return inRange(state, id) && !(state.keptInRange instanceof Set && state.keptInRange.has(id));
}

function inRange(state, id) {
  const ranges = state?.excludedRanges;
  if (!Array.isArray(ranges) || !ranges.length) return false;
  for (const r of ranges) if (id >= r.from && id <= r.to) return true;
  return false;
}

/** True when the event was taken out by a revert cascade (directly or as an engine/jev descendant) or a rewind range. */
export function isExcluded(state, event) {
  return !!event && isExcludedId(state, event.id);
}

/**
 * Orphaned (plan §R1): a chat/mind/owner event whose cause was reverted. It
 * still applies — only engine/jev consequences cascade — and the Timeline
 * marks it. `excluded` is a Set of ids (state.excluded).
 */
export function isOrphaned(event, excluded) {
  return !!event && excluded instanceof Set && event.causeId !== null && event.causeId !== undefined
    && excluded.has(event.causeId) && !excluded.has(event.id) && !CASCADE_ACTORS.has(event.actor);
}

// 020: a commit or reversal a chat lean nudged goes with that lean (eventLog.cascadeAll, the same link).
function nudgedByExcludedLean(s, event) {
  if (event.type !== 'decision.committed' && event.type !== 'decision.reversed') return false;
  const lean = event.payload?.leanEventId;
  return Number.isSafeInteger(lean) && CASCADE_ACTORS.has(event.actor) && isExcludedId(s, lean);
}

function applyInPlace(s, event, world) {
  if (!isObj(event) || !Number.isSafeInteger(event.id) || event.id < 1) fail('event needs a positive integer id');
  if (!Number.isSafeInteger(event.at)) fail(`event ${event.id} needs an integer at`);
  const consumed = () => { if (event.id > s.lastEventId) s.lastEventId = event.id; };

  if (s.excluded.has(event.id)) { notePlanBlocks(s, event); noteExcluded(s, event); return consumed(); }
  if (nudgedByExcludedLean(s, event) || (event.causeId != null && s.excluded.has(event.causeId) && CASCADE_ACTORS.has(event.actor) && !keptByPlan(s, event))) {
    notePlanBlocks(s, event);
    s.excluded.add(event.id);
    noteExcluded(s, event);
    return consumed();
  }

  const p = isObj(event.payload) ? event.payload : {};
  const tz = s.world.timezone;

  // 010 rewinds (research R11). A range exclusion leaves no signature: the
  // rewind re-anchors the day at now, so "happened and undone" is moot.
  let bookkeeping = event.type === 'world.rewound' || NON_INTEGRATING.has(event.type);
  if (inRange(s, event.id)) {
    if (!isRewindKept(event)) return consumed();
    if (!(s.keptInRange instanceof Set)) s.keptInRange = new Set();
    s.keptInRange.add(event.id);
    bookkeeping = true;
  } else if (event.causeId != null && CASCADE_ACTORS.has(event.actor) && isExcludedId(s, event.causeId) && !keptByPlan(s, event)) {
    s.excluded.add(event.id);
    return consumed();
  }
  if (bookkeeping && event.type !== 'event.reverted') {
    // Owner steering or a pointer, not something that happened in his life:
    // the handler runs, nothing integrates and s.at stays (as event.reverted).
    const handler = HANDLERS[event.type];
    if (handler) handler(s, event, p, world);
    STORY_OBSERVERS[event.type]?.(s, event, p, world);
    INFLUENCE_OBSERVERS[event.type]?.(s, event, p, world);
    STEER_OBSERVERS[event.type]?.(s, event, p, world);
    SCENE_OBSERVERS[event.type]?.(s, event, p, world);   // 016
    return consumed();
  }

  if (event.type === 'event.reverted') {
    // Record the exclusion. Its consequences can only be removed by a rebuild:
    // the target is already folded in (unless rebuild() pre-seeded it).
    const target = int(p.targetId);
    if (target && target > 0 && !s.excluded.has(target)) {
      s.excluded.add(target);
      if (target <= s.lastEventId) s.rebuildNeeded = true;
    }
    // Log bookkeeping, not something that happened in his life: the
    // integration anchor stays at the last real event, so the next one
    // integrates the whole gap.
    return consumed();
  }

  // The world vitals see (a job change moves the office): `world` itself until a career.* event.
  const vw = overlayFor(s, world);
  // Continuous part: vitals over the gap since the last applied event.
  if (s.genesisAt !== null && s.at !== null && event.type !== 'world.reanchored' && event.at > s.at) {
    const dtMin = Math.min(MAX_INTEGRATE_MIN, (event.at - s.at) / 60);
    s.vitals = integrate(s.vitals, s.activity, dtMin, vw, { at: s.at, rain: s.weather?.rain === true, ...itemizedCtx(s) });
  }
  // Discrete part: the event's explained jump (unknown types → unchanged copy).
  if (event.type !== 'genesis') s.vitals = applyVitalsEvent(s.vitals, event, vw);

  if (event.actor === 'jev') countJev(s, event, p, tz);

  const handler = HANDLERS[event.type];
  if (handler) handler(s, event, p, world);
  STORY_OBSERVERS[event.type]?.(s, event, p, world);
  INFLUENCE_OBSERVERS[event.type]?.(s, event, p, world);
  STEER_OBSERVERS[event.type]?.(s, event, p, world);
  SCENE_OBSERVERS[event.type]?.(s, event, p, world);   // 016

  s.at = s.at === null ? event.at : Math.max(s.at, event.at);
  return consumed();
}

// Jev calls per local day (decisions.js budgets): a lean on a decision with a
// stored category is an arc call (010, ARCS_JEV_MAX_PER_DAY), every other jev
// event a 009 one. Reset in place so neither rollover wipes the other field.
function countJev(s, event, p, tz) {
  const day = dateKey(event.at, tz);
  const c = isObj(s.counters) ? s.counters : (s.counters = {});
  if (c.jevDay !== day) { c.jevDay = day; c.jevToday = 0; }
  if (c.arcJevDay !== day) { c.arcJevDay = day; c.arcJevToday = 0; }
  if (event.type === 'decision.lean' && decisionFor(s, p, event)?.category) c.arcJevToday = (Number(c.arcJevToday) || 0) + 1;
  else c.jevToday = (Number(c.jevToday) || 0) + 1;
}

// worldOverlay builds a new object once a career.* event exists, and
// vitals.vitalsConfig caches per world object: memoize per (world, career
// event) so a replay doesn't rebuild the vitals config for every event.
const overlayCache = new WeakMap();
function overlayFor(s, world) {
  // 014 geo (R27): projected places count too — moved/added places and routes.
  const pk = isObj(world) ? placesKey(s, world) : '';
  // 015: any career / home / departure event (overlayKey), not only a career one.
  if (!isObj(world) || (overlayKey(s) === null && !pk)) return world;
  const key = `${overlayMemoKey(s)}|${pk}`;
  const hit = overlayCache.get(world);
  if (hit && hit.key === key) return hit.world;
  const out = worldOverlay(s, world);
  overlayCache.set(world, { key, world: out });
  return out;
}

// The pulse derives what is due from the projection, so an excluded event
// would simply come due again on the next tick. For the types it re-derives,
// remember a signature of what was undone — { type, at, key } — and the pulse
// treats a matching due item as "happened and undone" (pulse.js isUndone).
// Pure fold: same log → same list, live or replayed.
const RECURRING_SPENDS = new Set(['rent', 'bills', 'groceries']);
const PERIOD_RE = /^\d{4}-\d{2}(-\d{2})?$/;
const SIG_TYPES = new Set(['money.salary', 'money.spent', 'activity.started', 'work.late', 'decision.opened', 'plan.made', 'sleep.delayed', 'work.behind',
  // 015: a god consequence undone stays undone (keyed by its owner cause).
  'change.applied', 'outcome.happened', 'vitals.nudged', 'sick.started',
  // 016: a reverted scene / follow-up stays undone (REGENERATE is the only way to a new version).
  'scene.played', 'scene.followup']);

export function exclusionSig(event) {
  if (!isObj(event) || !SIG_TYPES.has(event.type) || !Number.isSafeInteger(event.at)) return null;
  const p = isObj(event.payload) ? event.payload : {};
  switch (event.type) {
    case 'activity.started': return { type: event.type, at: event.at, key: kindOf(p.kind) };
    case 'work.late': return { type: event.type, at: event.at, key: null };
    // 018: a reverted salary / recurring spend stays undone for its period (the wallet's catch-up).
    case 'money.salary': return typeof p.month === 'string' && PERIOD_RE.test(p.month) ? { type: event.type, at: null, key: `salary:${p.month}` } : null;
    case 'money.spent': return RECURRING_SPENDS.has(p.for) && typeof p.period === 'string' && PERIOD_RE.test(p.period)
      ? { type: event.type, at: null, key: `${p.for}:${p.period}` } : null;
    case 'decision.opened': {
      const eventAt = time(isObj(p.subject) ? p.subject.eventAt : null);
      return { type: event.type, at: event.at, key: `${kindOf(p.kind) ?? 'plan'}|${eventAt ?? ''}` };
    }
    case 'plan.made':
      if (int(p.amendedFor)) return { type: event.type, at: event.at, key: `amended:${p.amendedFor}` };
      if (int(p.droppedFor)) return { type: event.type, at: event.at, key: `dropped:${p.droppedFor}` };   // 020: a rethought plan left today
      // 015: a re-plan after a god change (overlay drift) stays undone for that key.
      if (typeof p.driftKey === 'string' && p.driftKey) return { type: event.type, at: event.at, key: `overlay:${p.driftKey.slice(0, 80)}` };
      return scheduleSig(event, p);   // 014 sched
    case 'change.applied':
    case 'outcome.happened':
      return int(event.causeId) ? { type: event.type, at: event.at, key: String(event.causeId) } : null;
    case 'vitals.nudged':
    case 'sick.started':
      return p.reason === 'planned' && int(event.causeId) ? { type: event.type, at: event.at, key: String(event.causeId) } : null;
    // 012: an undone sleep push / work flag stays undone for that night / day.
    case 'scene.played': return int(p.activityEventId) ? { type: event.type, at: null, key: `scene:${p.activityEventId}` } : null;
    case 'scene.followup': return castIdOk(p.castId) && int(p.from) ? { type: event.type, at: null, key: `followup:${p.castId}|${p.from}` } : null;
    case 'sleep.delayed':
    case 'work.behind': return typeof p.date === 'string' && DATE_RE.test(p.date) ? { type: event.type, at: event.at, key: p.date } : null;
    default: return null;
  }
}

function castIdOk(v) {
  return typeof v === 'string' && CAST_ID_RE.test(v);
}

// 014 sched (R37): a schedule re-plan (its payload lists `overrides`) is undone
// for its date and override set, whatever time it was made.
function scheduleSig(event, p) {
  if (!Array.isArray(p.overrides) || typeof p.date !== 'string' || !DATE_RE.test(p.date)) return null;
  return { type: event.type, at: null, key: scheduleSigKey(p.date, p.overrides.filter(x => posInt(x))) };
}

// wake-fix (Bug A): an outing's cancel undone (its decision.expired reverted, or
// cascaded away with the change that made it) restores the decision — and with
// it the outing's rewrite of the day: the `amended:<id>` signature its cancel
// left (CANCEL TONIGHT reverts the fitted / amended plan) is lifted, so the pulse
// fits / amends it again in the running engine. Only signatures noted before the
// cancel go (log order): an amendment the owner reverted afterwards stays undone.
function liftRestored(s, event) {
  if (event?.type !== 'decision.expired' || !Array.isArray(s.excludedSigs) || !s.excludedSigs.length) return;
  const id = int(isObj(event.payload) ? event.payload.decisionId : null);
  if (!id) return;
  const key = `amended:${id}`;
  if (s.excludedSigs.some(x => x.type === 'plan.made' && x.key === key)) {
    s.excludedSigs = s.excludedSigs.filter(x => !(x.type === 'plan.made' && x.key === key));
  }
}

// An excluded plan's outing blocks (lazy `s.excludedPlans`, ≤ PLANS_KEPT): an
// activity or trip that plan started for ANOTHER decision's block, one still in
// the log, is not cascaded (eventLog.cascadeIds' plan barrier, the same rule).
const PLANS_KEPT = 8;
function notePlanBlocks(s, event) {
  if (event.type !== 'plan.made' || !Array.isArray(event.payload?.blocks)) return;
  const blocks = event.payload.blocks
    .filter(b => isObj(b) && Number.isSafeInteger(b.decisionId) && b.decisionId > 0)
    .map(b => ({ kind: b.kind, start: b.start, end: b.end, decisionId: b.decisionId }));
  if (!blocks.length) return;
  const plans = isObj(s.excludedPlans) ? { ...s.excludedPlans } : {};
  plans[event.id] = { blocks };
  const ids = Object.keys(plans).map(Number).sort((a, b) => a - b);
  for (const id of ids.slice(0, Math.max(0, ids.length - PLANS_KEPT))) delete plans[id];
  s.excludedPlans = plans;
}

function keptByPlan(s, event) {
  const plan = isObj(s.excludedPlans) ? s.excludedPlans[event.causeId] : null;
  if (!plan) return false;
  const d = planBlockDecision(plan, event);
  return !!d && !isExcludedId(s, d);
}

function noteExcluded(s, event) {
  liftRestored(s, event);
  const sig = exclusionSig(event);
  if (!sig) return;
  if (!Array.isArray(s.excludedSigs)) s.excludedSigs = [];
  if (s.excludedSigs.some(x => x.type === sig.type && x.at === sig.at && x.key === sig.key)) return;
  s.excludedSigs.push(sig);
  if (s.excludedSigs.length > MAX_EXCLUDED_SIGS) s.excludedSigs.splice(0, s.excludedSigs.length - MAX_EXCLUDED_SIGS);
}

// 018: after the wallet's cut-over the baseline is itemized (money.spent), so the
// hourly drain stops. Absent before it — a pre-018 log integrates byte for byte.
function itemizedCtx(s) {
  return finite(s?.money?.walletSince) ? { itemized: true } : {};
}

function setPlace(s, id) {
  const place = id ? s.places.get(id) : null;
  s.position = { placeId: id ?? null, lat: place?.lat ?? s.position.lat, lon: place?.lon ?? s.position.lon, travel: null };
}

function setAvailability(s, state, at, until, eventId) {
  s.availability = { state, since: at, until: time(until), onPhone: s.availability.onPhone, eventId };
}

function originOf(event) {
  return CHAT_ORIGINS.has(event.originKind) && typeof event.originJid === 'string'
    ? { kind: event.originKind, jid: event.originJid } : null;
}

// A decision derived from a chat carries that chat's origin (plan §R13): a
// lean moved by a group message is only usable where that group's facts are.
// Owner origins are steering, not content, and are not added.
function addOrigin(decision, event) {
  // A redacted event (006 purge) keeps its origin_jid column, but nothing
  // about that person may be rebuilt into memory from it.
  if (event.redacted === true) return;
  const o = originOf(event);
  if (!o) return;
  // 010: originAt[jid] = the earliest event that carried this origin into the
  // decision, the learnedAt of 006's join-time floor (innerState.originsAllowed).
  if (Number.isSafeInteger(event.at)) {
    const m = isObj(decision.originAt) ? decision.originAt : (decision.originAt = {});
    if (!(m[o.jid] <= event.at)) m[o.jid] = event.at;
  }
  if (decision.origins.some(x => x.kind === o.kind && x.jid === o.jid)) return;
  if (decision.origins.length < MAX_ORIGINS) decision.origins.push(o);
}

function decisionFor(s, p, event) {
  const id = int(p.decisionId) ?? int(event.causeId);
  return id && s.decisions.has(id) ? s.decisions.get(id) : null;
}

// pulse.applyTimeOf, inlined (pulse imports this module): when a committed
// go / join-late is acted on.
function applyTimeOf(d) {
  const eventAt = d.subject?.eventAt;
  const endAt = d.options.find(o => o.id === 'late')?.expiresAt ?? (finite(eventAt) ? eventAt + 120 * 60 : null);
  if (!finite(d.ponrAt) || !finite(eventAt) || !finite(endAt)) return null;
  if (d.committed?.optionId === 'go') return d.ponrAt;
  if (d.committed?.optionId === 'late') return Math.round(d.ponrAt + (endAt - eventAt) / 2);
  return null;
}

// A committed decision whose day hasn't come yet (an adoption up to 30 days
// ahead, research R14) is never pruned and doesn't count toward MAX_DECISIONS.
function isFutureCommit(d, at) {
  if (d.status !== 'committed') return false;
  const applyAt = applyTimeOf(d);
  return (finite(applyAt) && applyAt > at) || (finite(d.subject?.eventAt) && d.subject.eventAt > at);
}

function pruneDecisions(s, at) {
  let future = 0;
  for (const [id, d] of s.decisions) {
    if (isFutureCommit(d, at)) { future += 1; continue; }
    if (d.status !== 'open' && d.closedAt !== null && d.closedAt < at - DECISION_KEEP_SEC) s.decisions.delete(id);
  }
  if (s.decisions.size - future <= MAX_DECISIONS) return;
  for (const [id, d] of s.decisions) {
    if (s.decisions.size - future <= MAX_DECISIONS) break;
    if (d.status !== 'open' && !isFutureCommit(d, at)) s.decisions.delete(id);
  }
}

function cleanCost(c) {
  const out = {};
  for (const k of ['energy', 'money', 'social', 'stress', 'travelMin']) out[k] = finite(c?.[k]) ? c[k] : 0;
  return out;
}

function cleanProbs(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, MAX_OPTIONS)) if (optionId(k) && finite(x)) out[k] = clamp01(x);
  return out;
}

function cleanBlock(b) {
  if (!isObj(b)) return null;
  const kind = kindOf(b.kind);
  const start = time(b.start);
  const end = time(b.end);
  if (!kind || !start || !end || end < start) return null;
  const out = {
    kind,
    placeId: placeId(b.placeId),
    start,
    end,
    availability: availability(b.availability),
    withCast: castIds(b.withCast),
  };
  if (b.social === true) out.social = true;
  // 010 (research R4): an amended plan's outing/commute blocks, and the real person the outing is with.
  if (b.fromAmendment === true) out.fromAmendment = true;
  if (personJid(b.subjectJid)) out.subjectJid = b.subjectJid;
  // Commute blocks carry routine.js / planTrip()'s trip (the pulse turns them into travel events).
  if (placeId(b.from) || placeId(b.to)) {
    Object.assign(out, { from: placeId(b.from), to: placeId(b.to), mode: kindOf(b.mode) });
    for (const k of ['km', 'minutes', 'cost']) if (finite(b[k]) && b[k] >= 0) out[k] = b[k];
    // 011 rain gear (present only when planned with it): umbrella with him, on foot / two wheels.
    if (typeof b.gear === 'boolean') out.gear = b.gear;
    if (typeof b.exposed === 'boolean') out.exposed = b.exposed;
    // 014 geo (plan §A2.2, R24): a trip planned on a stored road route.
    if (b.routed === true) {
      out.routed = true;
      if (finite(b.roadKm) && b.roadKm >= 0) out.roadKm = b.roadKm;
      if (typeof b.routeKey === 'string' && ROUTE_KEY_RE.test(b.routeKey)) out.routeKey = b.routeKey;
      if (posInt(b.routeEventId)) out.routeEventId = b.routeEventId;
    }
  }
  // 014 sched: an override's block, and a chat outing kept as an anchor (R20).
  if (b.fromOverride === true) out.fromOverride = true;
  if (posInt(b.overrideId)) out.overrideId = b.overrideId;
  if (posInt(b.causeEventId)) out.causeEventId = b.causeEventId;
  if (posInt(b.decisionId)) out.decisionId = b.decisionId;
  // A locked outing that is a meal (pulse.mealOfOuting): the meal it stands in for.
  if (out.decisionId && (b.meal === 'breakfast' || b.meal === 'lunch' || b.meal === 'dinner')) out.meal = b.meal;
  return out;
}

function cleanWorkLate(w) {
  if (!isObj(w)) return null;
  return {
    minutes: finite(w.minutes) ? Math.max(0, Math.round(w.minutes)) : 0,
    p: finite(w.p) ? clamp01(w.p) : null,
    normalEnd: time(w.normalEnd),
    end: time(w.end),
  };
}

const HANDLERS_009 = {
  genesis(s, ev, p, world) {
    const self = isObj(p.self) ? p.self : (world?.self ?? {});
    s.genesisAt = ev.at;
    s.world = {
      source: str(p.source, 32) ?? world?.source ?? null,
      hash: str(p.worldHash, 64) ?? world?.hash ?? null,
      timezone: resolveTimezone(str(p.timezone, 64) ?? world?.timezone),
    };
    const birthdate = typeof self.birthdate === 'string' && DATE_RE.test(self.birthdate) ? self.birthdate : null;
    s.self = {
      birthdate,
      age: birthdate ? ageOn(birthdate, ev.at, s.world.timezone) : null,
      homePlaceId: placeId(self.homePlaceId),
      officePlaceId: placeId(self.officePlaceId ?? self.job?.officePlaceId),
      relationship: str(self.relationship, 32) ?? 'single',
      lastBirthdayAt: null,
    };
    s.vitals = isObj(p.vitals) ? normalizeVitals({ ...initialVitals(world), ...p.vitals }) : initialVitals(world);
    s.activity = idleActivity(s.self.homePlaceId, ev.at, ev.id);
    setPlace(s, s.self.homePlaceId);
    setAvailability(s, 'free', ev.at, null, ev.id);
  },

  'place.created'(s, ev, p) {
    const id = placeId(p.id);
    if (!id || !finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
    s.places.set(id, { id, name: str(p.name, 80) ?? id, kind: kindOf(p.kind) ?? 'place', lat: p.lat, lon: p.lon, eventId: ev.id });
    if (s.position.placeId === id && !s.position.travel) s.position = { ...s.position, lat: p.lat, lon: p.lon };
    if (p.venue !== undefined) foldVenueCreated(s, id, p);   // 014 geo
  },

  'cast.created'(s, ev, p) {
    const id = castId(p.id);
    const name = str(p.name, 80);
    if (!id || !name) return;
    // 015: a departed member's id is never reused (their history and past rows stay theirs).
    if (isObj(s.story?.departed) && Object.prototype.hasOwnProperty.call(s.story.departed, id)) return;
    const m = isObj(p.metrics) ? p.metrics : {};
    const home = placeId(p.home) ?? (isObj(p.home) && finite(p.home.lat) && finite(p.home.lon) ? { lat: p.home.lat, lon: p.home.lon } : null);
    s.cast.set(id, {
      id,
      name,
      relation: str(p.relation, 40) ?? 'coworker',
      pronouns: str(p.pronouns, 24),
      birthday: typeof p.birthday === 'string' && DATE_RE.test(p.birthday) ? p.birthday : null,
      hometown: str(p.hometown, 80),
      home,
      job: str(p.job, 80),
      employer: str(p.employer, 80),
      personality: str(p.personality),
      speech: str(p.speech),
      availability: str(p.availability),
      status: str(p.status),
      metrics: { closeness: clamp01(m.closeness, 0.5), trust: clamp01(m.trust, 0.5), tension: clamp01(m.tension, 0) },
      history: Array.isArray(p.history) ? p.history.map(h => str(h)).filter(Boolean).slice(0, MAX_HISTORY) : [],
      lastBirthdayAt: null,
      eventId: ev.id,
    });
  },

  'world.reanchored'(s, ev) {
    // Downtime beyond the catch-up cap: the gap is skipped, not integrated.
    const where = s.position.travel?.to ?? s.position.placeId ?? s.self.homePlaceId;
    setPlace(s, where);
    s.activity = idleActivity(s.position.placeId, ev.at, ev.id);
    s.phone = { ...s.phone, checkStartedAt: null, checkUntil: null, nextCheckAt: null };
    s.availability = { state: 'free', since: ev.at, until: null, onPhone: false, eventId: ev.id };
    s.reanchoredAt = ev.at;
  },

  'plan.made'(s, ev, p) {
    const blocks = Array.isArray(p.blocks) ? p.blocks.slice(0, MAX_PLAN_BLOCKS).map(cleanBlock).filter(Boolean) : [];
    // routine.js planDay() output (the plan.made payload), typed field by field.
    s.plan = {
      date: typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : dateKey(ev.at, s.world.timezone),
      dayType: kindOf(p.dayType),
      wakeAt: time(p.wakeAt),
      lateBy: finite(p.lateBy) ? Math.max(0, Math.round(p.lateBy)) : 0,
      sleepAt: time(p.sleepAt),
      nextWakeAt: time(p.nextWakeAt),
      workLate: cleanWorkLate(p.workLate),
      skipped: Array.isArray(p.skipped) ? p.skipped.map(kindOf).filter(Boolean).slice(0, 16) : [],
      blocks,
      eventId: ev.id,
      at: ev.at,
      by: ev.actor,
    };
    // 010 (research R4): the morning plan an amendment started from.
    const base = posInt(p.basePlanEventId);
    if (base && base < ev.id) s.plan.basePlanEventId = base;
    // 011: the day's umbrella roll (present only when planned with it).
    if (isObj(p.gear) && typeof p.gear.umbrella === 'boolean') s.plan.gear = { umbrella: p.gear.umbrella, p: clamp01(p.gear.p) };
    // 014 sched: the overrides this plan carries (present only when planned with them).
    if (Array.isArray(p.overrides)) {
      s.plan.overrides = [...new Set(p.overrides.filter(x => posInt(x) && x < ev.id))].slice(0, SCHEDULE_MAX * 2);
      for (const b of blocks) if (posInt(b.causeEventId) && b.causeEventId >= ev.id) delete b.causeEventId;
    }
    // 015: the god-change key the plan was made under (absent while no god change folded: 01-inert).
    const dk = driftKey(s);
    if (dk !== null) s.plan.driftKey = dk;
  },

  'activity.started'(s, ev, p) {
    const kind = kindOf(p.kind) ?? 'idle';
    const where = placeId(p.placeId) ?? (s.position.travel ? null : s.position.placeId);
    const avail = availability(p.availability) ?? (activityClass({ kind }) === 'sleep' ? 'asleep' : null);
    s.activity = {
      kind,
      placeId: where,
      startAt: ev.at,
      endAt: time(p.end) ?? time(p.until),
      availability: avail,
      withCast: castIds(p.withCast),
      social: p.social === true,
      eventId: ev.id,
    };
    if (where && !s.position.travel) setPlace(s, where);
    if (avail) setAvailability(s, avail, ev.at, s.activity.endAt, ev.id);
  },

  'activity.ended'(s, ev) {
    const ended = s.activity;
    s.activity = idleActivity(s.position.travel ? null : s.position.placeId, ev.at, ev.id);
    // Availability the ended activity set no longer holds; nothing else does yet.
    if (ended?.eventId && s.availability.eventId === ended.eventId) setAvailability(s, 'free', ev.at, null, ev.id);
  },

  'travel.started'(s, ev, p) {
    const to = placeId(p.to);
    const minutes = finite(p.minutes) && p.minutes >= 0 ? Math.round(p.minutes) : 0;
    const from = placeId(p.from) ?? s.position.placeId;
    s.position = {
      placeId: null,
      lat: s.position.lat,
      lon: s.position.lon,
      travel: {
        from, to, mode: kindOf(p.mode) ?? 'walk', km: finite(p.km) ? p.km : null,
        startAt: ev.at, endAt: ev.at + minutes * 60, eventId: ev.id,
      },
    };
    if (activityClass(s.activity) !== 'commute') {
      s.activity = {
        kind: 'commute', placeId: null, startAt: ev.at, endAt: s.position.travel.endAt,
        availability: availability(p.availability), withCast: [], social: false, eventId: ev.id,
      };
    } else if (!s.activity.endAt) {
      s.activity = { ...s.activity, endAt: s.position.travel.endAt };
    }
    if (availability(p.availability)) setAvailability(s, p.availability, ev.at, s.position.travel.endAt, ev.id);
  },

  'travel.arrived'(s, ev, p) {
    const to = placeId(p.to) ?? s.position.travel?.to ?? null;
    const wasCommute = activityClass(s.activity) === 'commute';
    setPlace(s, to);
    if (wasCommute) {
      const ended = s.activity;
      s.activity = idleActivity(to, ev.at, ev.id);
      if (ended?.eventId && s.availability.eventId === ended.eventId) setAvailability(s, 'free', ev.at, null, ev.id);
    }
  },

  meal(s, ev, p) {
    s.lastMeal = { at: ev.at, kind: kindOf(p.kind), eventId: ev.id };
  },

  'sleep.started'(s, ev, p) {
    const where = s.position.travel ? s.self.homePlaceId : (s.position.placeId ?? s.self.homePlaceId);
    s.activity = {
      kind: 'sleep', placeId: where, startAt: ev.at, endAt: time(p.until),
      availability: 'asleep', withCast: [], social: false, eventId: ev.id,
    };
    if (s.position.travel) setPlace(s, where);
    setAvailability(s, 'asleep', ev.at, time(p.until), ev.id);
    s.sleep = { ...s.sleep, startedAt: ev.at, eventId: ev.id };
  },

  woke(s, ev, p) {
    s.activity = idleActivity(s.position.placeId, ev.at, ev.id);
    setAvailability(s, 'free', ev.at, null, ev.id);
    // Wake him (owner): a night wake is not his morning — lastWokeAt / lateBy stay
    // the morning's; the request it answered is marked done.
    if (p.interrupted === true) {
      s.sleep = { ...s.sleep, startedAt: null, interruptedAt: ev.at, wokeEventId: ev.id };
      markWakeDone(s, int(p.wakeSetId), ev.at);
      return;
    }
    s.sleep = {
      ...s.sleep,
      startedAt: null,
      lastWokeAt: ev.at,
      lateBy: finite(p.lateBy) ? Math.max(0, Math.round(p.lateBy)) : 0,
      wokeEventId: ev.id,
    };
    if (int(p.wakeSetId)) markWakeDone(s, int(p.wakeSetId), ev.at);
  },

  'work.late'(s, ev, p) {
    const until = time(p.until);
    if (until && ['wfh', 'office', 'meeting'].includes(activityClass(s.activity, { self: { officePlaceId: s.self.officePlaceId } }))) {
      s.activity = { ...s.activity, endAt: until };
      if (s.availability.eventId === s.activity.eventId) s.availability = { ...s.availability, until };
    }
    s.work = { ...s.work, lateAt: ev.at, lateEventId: ev.id };
  },

  'work.crunch'(s, ev) {
    s.work = { ...s.work, crunchAt: ev.at };
  },

  'weather.changed'(s, ev, p) {
    s.weather = {
      rain: p.rain === true,
      condition: kindOf(p.condition) ?? (p.rain === true ? 'light_rain' : 'clear'),
      tempC: finite(p.tempC) ? p.tempC : null,
      from: time(p.from),
      until: time(p.until),
      eventId: ev.id,
    };
    // 011 (review R17): who made it, present only when set (a 009 log is unchanged).
    if (posInt(p.windowId)) s.weather.windowId = p.windowId;
    if (ev.actor === 'owner') s.weather.by = 'owner';
  },

  'sick.started'(s, ev, p) {
    s.sick = { since: ev.at, until: time(p.until), days: int(p.days), eventId: ev.id };
  },

  'sick.ended'(s) {
    s.sick = null;
  },

  'money.salary'(s, ev) {
    s.money = { ...s.money, lastSalaryAt: ev.at, lastSalaryEventId: ev.id };
  },

  // 018: a recurring spend marks its period paid (pulse: due once per period).
  'money.spent'(s, ev, p) {
    if (!RECURRING_SPENDS.has(p.for) || typeof p.period !== 'string' || !PERIOD_RE.test(p.period)) return;
    s.money = { ...s.money, paid: { ...(isObj(s.money?.paid) ? s.money.paid : {}), [p.for]: p.period } };
  },

  // 018: the wallet's cut-over — the hourly baseline drain stops from here (integrateCtx).
  'wallet.started'(s, ev) {
    if (finite(s.money?.walletSince)) return;
    s.money = { ...s.money, walletSince: ev.at };
  },

  'vitals.checkpoint'(s, ev) {
    // Not a re-anchor: a checkpoint written after a later-reverted event would
    // re-impose the reverted effects. The payload stays in the log for drift.
    s.checkpoint = { at: ev.at, eventId: ev.id };
  },

  birthday(s, ev, p) {
    const id = castId(p.castId);
    if (id) {
      const c = s.cast.get(id);
      if (c) s.cast.set(id, { ...c, lastBirthdayAt: ev.at });
      return;
    }
    s.self = {
      ...s.self,
      lastBirthdayAt: ev.at,
      age: s.self.birthdate ? ageOn(s.self.birthdate, ev.at, s.world.timezone) : s.self.age,
    };
  },

  'phone.check.started'(s, ev, p) {
    const until = time(p.until);
    s.phone = { ...s.phone, lastCheckAt: ev.at, checkStartedAt: ev.at, checkUntil: until && until >= ev.at ? until : null, nextCheckAt: null };
    s.availability = { ...s.availability, onPhone: true };
  },

  'phone.check.ended'(s, ev, p) {
    s.phone = { ...s.phone, checkStartedAt: null, checkUntil: null, lastCheckEndAt: ev.at, nextCheckAt: time(p.nextCheckAt) };
    s.availability = { ...s.availability, onPhone: false };
  },

  'availability.changed'(s, ev, p) {
    const state = availability(p.state);
    if (state) setAvailability(s, state, ev.at, p.until, ev.id);
  },

  'decision.opened'(s, ev, p) {
    const options = (Array.isArray(p.options) ? p.options : []).slice(0, MAX_OPTIONS).map((o) => {
      const id = optionId(o?.id);
      if (!id) return null;
      const opt = { id, label: str(o.label, 80) ?? id, cost: cleanCost(o.cost), expiresAt: time(o.expiresAt) };
      if (finite(o.bias) && o.bias !== 0) opt.bias = Math.max(-BIAS_MAX, Math.min(BIAS_MAX, o.bias));
      return opt;
    }).filter(Boolean);
    if (!options.length) return;
    const subject = isObj(p.subject) ? p.subject : {};
    const d = {
      id: ev.id,
      kind: kindOf(p.kind) ?? 'plan',
      subject: { eventAt: time(subject.eventAt), placeId: placeId(subject.placeId), castIds: castIds(subject.castIds) },
      opensAt: time(p.opensAt) ?? ev.at,
      decideBy: time(p.decideBy),
      ponrAt: time(p.ponrAt),
      options,
      lean: null,
      leans: 0,
      mode: DECISION_MODES.has(p.mode) ? p.mode : 'auto',
      status: 'open',
      committed: null,
      reversals: 0,
      signals: [],
      origins: [],
      closedAt: null,
      eventId: ev.id,
    };
    // 010 fields (data-model §2.5), present only when set so a 009 decision is unchanged.
    const category = kindOf(p.category);
    if (category) d.category = category;
    if (p.big === true) d.big = true;
    if (p.bigDowngraded === 'lead_time') d.bigDowngraded = 'lead_time';
    if (p.adopted === true) d.adopted = true;
    if (posInt(p.arcId)) d.arcId = p.arcId;
    if (posInt(p.claimId)) d.claimId = p.claimId;
    if (posInt(p.goalId)) d.goalId = p.goalId;   // 011: a soft goal's outing
    if (posInt(p.followupId)) d.followupId = p.followupId;   // 016: a scene's follow-up meet
    // 012: an invitation from a chat (present only then, so other decisions are unchanged).
    if (isObj(p.invite) && posInt(p.invite.pointerId)) {
      d.invite = true;
      d.inviteMaxRev = p.invite.maxReversals === 0 ? 0 : 1;
    }
    if (ev.redacted !== true && personJid(ev.subjectJid)) d.subjectJid = ev.subjectJid;
    // 2026-11-02: a decision OPENED with a chat origin is a plan made in a chat
    // (planEdits.chatMadeDecision). Today's producers (an adoption, an invitation)
    // already say so, so the flag is set only when nothing else does: no fold changes.
    if (originOf(ev) && !d.adopted && !d.claimId && !d.invite && !d.subjectJid) d.chatOpened = true;
    addOrigin(d, ev);
    s.decisions.set(d.id, d);
    pruneDecisions(s, ev.at);
  },

  'decision.lean'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    const opt = optionId(p.optionId);
    if (!d || d.status === 'expired' || !opt || !d.options.some(o => o.id === opt)) return;
    d.lean = {
      optionId: opt,
      p: clamp01(p.p),
      probs: cleanProbs(p.probs),
      at: ev.at,
      by: ev.actor,
      trigger: kindOf(p.trigger),
      fallback: kindOf(p.fallback),
      // what the state looked like when he leaned — decisions.js measures state_shift from here
      state: { energy: s.vitals.energy, stress: s.vitals.stress, sick: s.vitals.sick === true },
      eventId: ev.id,
    };
    d.leans += 1;
    addOrigin(d, ev);
  },

  'decision.committed'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    const opt = optionId(p.optionId) ?? d?.lean?.optionId;
    if (!d || d.status !== 'open' || !opt || !d.options.some(o => o.id === opt)) return;
    d.status = 'committed';
    // `by` (010): only an owner event is an owner pick; 009 rows without it fold from `sampled`.
    const by = ev.actor === 'owner' ? 'owner'
      : (COMMIT_BY.has(p.by) && p.by !== 'owner' ? p.by : (p.sampled === true ? 'sample' : 'early'));
    d.committed = { optionId: opt, at: ev.at, p: finite(p.p) ? clamp01(p.p) : null, sampled: p.sampled === true, by, eventId: ev.id };
    d.closedAt = ev.at;
    addOrigin(d, ev);
    pruneDecisions(s, ev.at);
  },

  'decision.reversed'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    const to = optionId(p.to);
    if (!d || d.status !== 'committed' || !to || to === d.committed?.optionId || !d.options.some(o => o.id === to)) return;
    // An owner pick is immutable (FR-036) — to everyone but the owner (015: keyed on the actor).
    if (d.committed?.by === 'owner' && ev.actor !== 'owner') return;
    if (ev.actor === 'owner') {
      // 015: an owner reversal is the owner's pick now and moves no tension.
      d.committed = { ...d.committed, optionId: to, at: ev.at, eventId: ev.id, by: 'owner' };
      d.reversals += 1;
      return;
    }
    d.committed = { ...d.committed, optionId: to, at: ev.at, eventId: ev.id };
    d.reversals += 1;
    addOrigin(d, ev);
    if (d.invite === true) return;   // 012: no relationship metric moves from a chat invitation
    for (const id of d.subject.castIds) {
      const c = s.cast.get(id);
      if (c) s.cast.set(id, { ...c, metrics: { ...c.metrics, tension: clamp01(c.metrics.tension + 0.1) } });
    }
  },

  'decision.expired'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    // A committed outing he couldn't go to after all (pulse: could_not_go).
    if (d && d.status === 'committed' && p.reason === 'could_not_go') {
      d.status = 'missed';
      d.closedAt = ev.at;
      pruneDecisions(s, ev.at);
      return;
    }
    // 010: a refused consequence, an owner cancel or a withdrawal closes a committed one too. 2026-11-02: and an outing a rewind
    // took away, so the log and the state never disagree. A goal's closes below (GOAL_BLOCKED). Not in CLOSING_REASONS: an open
    // decision a rewind found stale still folds as 'expired', as it always has.
    if (d && d.status === 'committed' && (CLOSING_REASONS.has(p.reason) || (p.reason === 'rewound' && d.committed?.by !== 'goal'))) {
      d.status = 'cancelled';
      d.closedAt = ev.at;
      pruneDecisions(s, ev.at);
      return;
    }
    if (!d || d.status !== 'open') return;
    d.status = p.reason === 'cancelled' || CLOSING_REASONS.has(p.reason) ? 'cancelled' : 'expired';
    d.closedAt = ev.at;
    pruneDecisions(s, ev.at);
  },

  'decision.mode_set'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    if (d && DECISION_MODES.has(p.mode)) d.mode = p.mode;
  },

  'chat.trigger'(s, ev, p) {
    // An inert pointer: it can move a decision's lean only through decisions.js
    // (a later decision.lean). Here it just taints the decision with its origin.
    const d = decisionFor(s, p, ev);
    if (!d || d.status === 'expired' || d.status === 'cancelled' || ev.redacted === true) return;
    d.signals.push({ at: ev.at, toward: optionId(p.toward), eventId: ev.id });
    if (d.signals.length > MAX_SIGNALS) d.signals.splice(0, d.signals.length - MAX_SIGNALS);
    addOrigin(d, ev);
  },

  'call.answered'(s, ev) {
    s.lastCall = { at: ev.at, originKind: ev.originKind, eventId: ev.id };
  },

  'claim.flagged'(s, ev) {
    s.claims = { flagged: s.claims.flagged + 1, lastFlaggedAt: ev.at };
  },

  'embargo.started'(s, ev, p) {
    // An owner-made heavy event's embargo is owner-actor, so a revert of that
    // event doesn't cascade to it (only engine/jev do): undo it here instead.
    if (s.excluded.has(int(p.heavyEventId))) return;
    s.embargo = applyEmbargoEvent(s.embargo, ev);
  },

  'embargo.ended'(s, ev) {
    s.embargo = applyEmbargoEvent(s.embargo, ev);
  },

  'alert.raised'(s, ev, p) {
    if (s.excluded.has(int(p.heavyEventId))) return; // its heavy event was reverted (see embargo.started)
    s.alerts.push({ at: ev.at, kind: kindOf(p.kind) ?? 'alert', eventId: ev.id });
    if (s.alerts.length > MAX_ALERTS) s.alerts.splice(0, s.alerts.length - MAX_ALERTS);
  },
};

// 010 rewind bookkeeping (research R11): push the range once. A new range
// means events already folded are now out → rebuild. rebuild() pre-seeds the
// ranges from eventLog.listRewinds(), so a replay meets this with the range
// present and converges.
function addRange(s, from, to, eventId) {
  if (!Array.isArray(s.excludedRanges)) s.excludedRanges = [];
  if (!posInt(from) || !posInt(to) || from > to) return false;
  if (s.excludedRanges.some(r => r.from === from && r.to === to)) return false;
  if (s.excludedRanges.length >= MAX_RANGES) return false;
  s.excludedRanges.push({ from, to, eventId });
  return true;
}

const PROJECTOR_010 = {
  'world.rewound'(s, ev, p) {
    const target = posInt(p.toEventId);
    if (!target || ev.redacted === true) return;
    if (addRange(s, target + 1, ev.id - 1, ev.id) && target + 1 <= s.lastEventId) s.rebuildNeeded = true;
  },
};

// ── 012 chat influence ────────────────────────────────────────────────────

function influenceSlice(s) {
  if (!isObj(s.influence)) s.influence = { perceivedDay: null, perceivedToday: 0, workBehindDay: null };
  return s.influence;
}

const HANDLERS_012 = {
  'chat.perceived'(s, ev) {
    if (ev.redacted === true) return;
    const inf = influenceSlice(s);
    const day = dateKey(ev.at, s.world.timezone);
    if (inf.perceivedDay !== day) { inf.perceivedDay = day; inf.perceivedToday = 0; }
    inf.perceivedToday = (Number(inf.perceivedToday) || 0) + 1;
  },

  'mood.chat'(s, ev, p) {
    if (ev.redacted === true) return;
    const d = isObj(p.delta) ? p.delta : {};
    const num = (v, cap) => (finite(v) ? Math.max(-cap, Math.min(cap, v)) : 0);
    const o = originOf(ev);
    const entry = {
      at: ev.at, eventId: ev.id, pointerId: int(ev.causeId),
      dv: num(d.valence, 0.06), ds: num(d.stress, 4), dsoc: num(d.social, 3),
      affect: kindOf(p.affect), originJid: o?.jid ?? null, subjectJid: personJid(ev.subjectJid),
    };
    const list = Array.isArray(s.chatMood) ? s.chatMood.filter(e => finite(e?.at) && e.at > ev.at - CHAT_MOOD_WINDOW_SEC) : [];
    list.push(entry);
    s.chatMood = list.length > CHAT_MOOD_MAX ? list.slice(list.length - CHAT_MOOD_MAX) : list;
  },

  'sleep.delayed'(s, ev, p) {
    if (ev.redacted === true) return;
    const until = time(p.until);
    const plan = s.plan;
    if (!until || !plan?.blocks?.length) return;
    const i = plan.blocks.findIndex(b => b.kind === 'sleep' && b.end > ev.at && b.start <= until);
    if (i < 0) return;
    const sleep = plan.blocks[i];
    const old = sleep.start;
    if (until <= old || until >= sleep.end) return;
    const blocks = plan.blocks.map((b, j) => {
      if (j === i) return { ...b, start: until };
      if (b.end === old && b.start < old) return { ...b, end: until };   // the block before sleep runs on
      return b;
    });
    s.plan = { ...plan, blocks, ...(plan.sleepAt === old || (finite(plan.sleepAt) && plan.sleepAt < until) ? { sleepAt: until } : {}) };
    if (s.activity && s.activity.kind !== 'sleep' && (s.activity.endAt === old || s.activity.endAt === null || s.activity.endAt < until)) {
      s.activity = { ...s.activity, endAt: until };
      if (s.availability.eventId === s.activity.eventId) s.availability = { ...s.availability, until };
    }
    const o = originOf(ev);
    const total = finite(p.totalMin) ? Math.max(0, Math.min(24 * 60, Math.round(p.totalMin))) : 0;
    s.sleep = { ...s.sleep, delayedFor: { chatJid: o?.jid ?? null, until, totalMin: total, eventId: ev.id } };
  },

  'invite.answered'(s, ev, p) {
    if (ev.redacted === true) return;
    const d = decisionFor(s, p, ev);
    if (!d || d.invite !== true || !INVITE_ANSWERS.has(p.answer)) return;
    d.inviteAnswer = p.answer;                 // the latest wins (a yes / no after a maybe)
    d.inviteAnsweredAt = ev.at;
    addOrigin(d, ev);
  },

  'invite.followed_up'(s, ev, p) {
    if (ev.redacted === true) return;
    const d = decisionFor(s, p, ev);
    if (!d || d.invite !== true || !FOLLOW_UP_OUTCOMES.has(p.outcome)) return;
    d.followUp = { at: ev.at, outcome: p.outcome, sent: p.sent === true, eventId: ev.id };
  },

  'work.behind'(s, ev, p) {
    if (ev.redacted === true) return;
    influenceSlice(s).workBehindDay = typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : dateKey(ev.at, s.world.timezone);
  },
};

// Run after the 009/010 handler of their type (like STORY_OBSERVERS).
const INFLUENCE_OBSERVERS = {
  woke(s) {
    if (isObj(s.sleep) && 'delayedFor' in s.sleep) {
      const { delayedFor, ...rest } = s.sleep;
      s.sleep = rest;
    }
  },
};

// ── 011 owner steering ────────────────────────────────────────────────────

function windowsOf(s) {
  if (!Array.isArray(s.weatherWindows)) s.weatherWindows = [];
  return s.weatherWindows;
}

function goalsOf(s) {
  if (!isObj(s.goals)) s.goals = {};
  return s.goals;
}

function pruneGoals(s, at) {
  const g = goalsOf(s);
  for (const [k, x] of Object.entries(g)) {
    if (x.status !== 'open' && x.status !== 'fitted' && finite(x.closedAt) && x.closedAt < at - GOAL_KEEP_SEC) delete g[k];
  }
  const ids = Object.keys(g).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    if (Object.keys(g).length <= GOALS_MAX) break;
    if (g[id].status !== 'open' && g[id].status !== 'fitted') delete g[id];
  }
}

function goalFor(s, p) {
  const id = posInt(p.goalId);
  return id && isObj(s.goals) && isObj(s.goals[id]) ? s.goals[id] : null;
}

function reopenGoal(g, at, tz, reason) {
  g.status = 'open';
  g.fitted = null;
  g.lastTry = { date: dateKey(at, tz), reason };
}

const HANDLERS_011 = {
  'weather.window_set'(s, ev, p) {
    if (ev.redacted === true) return;
    const from = time(p.from);
    const to = time(p.to);
    if (!from || !to || to <= from || to - from > WINDOW_MAX_SEC || !WINDOW_SKIES.has(p.sky)) return;
    const list = windowsOf(s).filter(w => w.to > ev.at - WINDOW_KEEP_SEC);
    list.push({ id: ev.id, from, to, sky: p.sky, intensity: Math.round(clamp01(p.intensity, 0.5) * 100) / 100 });
    // Over the cap: ended windows go first (the earliest end, then the lowest id),
    // only then the oldest open one — a long window still in force is never
    // pushed out by short ones set and ended after it.
    while (list.length > WINDOWS_MAX) {
      let drop = -1;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (w.to > ev.at) continue;
        if (drop < 0 || w.to < list[drop].to || (w.to === list[drop].to && w.id < list[drop].id)) drop = i;
      }
      list.splice(drop < 0 ? 0 : drop, 1);
    }
    s.weatherWindows = list;
  },

  'weather.window_ended'(s, ev, p) {
    if (ev.redacted === true) return;
    const id = posInt(p.windowId);
    const w = id ? windowsOf(s).find(x => x.id === id) : null;
    if (w && ev.at < w.to) w.to = Math.max(w.from, ev.at);
  },

  'goal.set'(s, ev, p) {
    if (ev.redacted === true) return;
    const from = time(p.from);
    const to = time(p.to);
    if (!GOAL_KINDS.has(p.goalKind) || !from || !to || to <= from) return;
    goalsOf(s)[ev.id] = {
      id: ev.id, goalKind: p.goalKind, castId: castId(p.castId), placeId: placeId(p.placeId), from, to,
      minutes: Number.isInteger(p.minutes) ? Math.max(15, Math.min(240, p.minutes)) : 60,
      label: str(p.label, 80), status: 'open', lastTry: null, fitted: null, setAt: ev.at, closedAt: null,
    };
    pruneGoals(s, ev.at);
  },

  'goal.cancelled'(s, ev, p) {
    const g = ev.redacted === true ? null : goalFor(s, p);
    if (!g || (g.status !== 'open' && g.status !== 'fitted')) return;
    g.status = 'cancelled';
    g.closedAt = ev.at;
  },

  'goal.fitted'(s, ev, p) {
    const g = ev.redacted === true ? null : goalFor(s, p);
    if (!g || g.status !== 'open') return;
    g.status = 'fitted';
    g.fitted = {
      eventId: ev.id, decisionId: null, slotStart: time(p.slotStart), slotEnd: time(p.slotEnd),
      placeId: placeId(p.placeId), castIds: castIds(p.castIds),
    };
    g.lastTry = { date: typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : dateKey(ev.at, s.world.timezone), reason: null };
  },

  'goal.deferred'(s, ev, p) {
    const g = ev.redacted === true ? null : goalFor(s, p);
    if (!g || (g.status !== 'open' && g.status !== 'fitted')) return;
    const date = typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : dateKey(ev.at, s.world.timezone);
    if (g.status === 'fitted') reopenGoal(g, ev.at, s.world.timezone, kindOf(p.reason) ?? 'deferred');
    g.lastTry = { date, reason: kindOf(p.reason) ?? 'deferred' };
  },

  'goal.done'(s, ev, p) {
    const g = ev.redacted === true ? null : goalFor(s, p);
    if (!g || g.status !== 'fitted') return;
    g.status = 'done';
    g.closedAt = ev.at;
  },

  'goal.expired'(s, ev, p) {
    const g = ev.redacted === true ? null : goalFor(s, p);
    if (!g || g.status !== 'open') return;
    g.status = 'expired';
    g.closedAt = ev.at;
  },

  'commute.soaked'(s, ev, p) {
    if (ev.redacted === true) return;
    const late = finite(p.lateMin) ? Math.max(0, Math.min(SOAK_LATE_MAX, Math.round(p.lateMin))) : 0;
    const t = s.position?.travel;
    if (late > 0 && t && t.eventId === int(ev.causeId) && finite(t.endAt)) {
      const endAt = t.endAt + late * 60;
      s.position = { ...s.position, travel: { ...t, endAt } };
      if (s.activity?.eventId === t.eventId) s.activity = { ...s.activity, endAt };
      if (s.availability?.eventId === t.eventId) s.availability = { ...s.availability, until: endAt };
    }
    s.soakedAt = { at: ev.at, eventId: ev.id, travelEventId: int(ev.causeId), intensity: p.intensity === 'heavy' ? 'heavy' : 'light', lateMin: late };
  },
};

// ── 014 sched: schedule overrides ─────────────────────────────────────────

function overridesOf(s) {
  if (!isObj(s.scheduleOverrides)) s.scheduleOverrides = {};
  return s.scheduleOverrides;
}

function pruneOverrides(s, at) {
  const m = overridesOf(s);
  const cutoff = dateKey(at - SCHEDULE_PRUNE_DAYS * 86400, s.world.timezone);
  for (const [k, o] of Object.entries(m)) if (!isObj(o) || o.date < cutoff) delete m[k];
}

function clipAt(o, from) {
  if (isObj(o.background)) {
    if (o.background.from >= from) delete o.background;
    else if (o.background.to > from) o.background = { ...o.background, to: from };
  }
  if (Array.isArray(o.ranges)) {
    o.ranges = o.ranges.filter(r => r.from < from).map(r => (r.to > from ? { ...r, to: from } : r));
    if (!o.ranges.length) delete o.ranges;
  }
}

// ── Wake him ("can't sleep"): the owner's night wakes ───────────────────
// s.wakeSets appears only when the first wake.set folds (the 012 rule), so a
// log without one serializes exactly as before. Kept: the last WAKE_SETS_MAX,
// none older than two days.
const WAKE_SETS_MAX = 8;
export const WAKE_REASONS = Object.freeze(['cant_sleep', 'woken_up', 'early_start']);

function markWakeDone(s, id, at) {
  if (!id || !Array.isArray(s.wakeSets)) return;
  const w = s.wakeSets.find(x => x.id === id);
  if (w) w.wokeAt = at;
}

const HANDLERS_WAKE = {
  'wake.set'(s, ev, p) {
    const at = time(p.at);
    if (!at || !WAKE_REASONS.includes(p.reason)) return;
    const until = time(p.until);
    const list = Array.isArray(s.wakeSets) ? s.wakeSets : [];
    const keep = list.filter(x => x.at > ev.at - 2 * 86400);
    keep.push({ id: ev.id, at, reason: p.reason, until: until && until > at ? until : null, setAt: ev.at });
    s.wakeSets = keep.slice(-WAKE_SETS_MAX);
  },
};

const HANDLERS_014_SCHED = {
  'schedule.override_set'(s, ev, p) {
    if (ev.redacted === true) return;
    const o = normalizeOverride(p);
    if (!o) return;
    overridesOf(s)[ev.id] = { ...o, id: ev.id, setAt: ev.at, status: 'active' };
    pruneOverrides(s, ev.at);
  },

  'schedule.override_cleared'(s, ev, p) {
    if (ev.redacted === true) return;
    const id = posInt(p.overrideId);
    const o = id ? overridesOf(s)[id] : null;
    if (!isObj(o) || o.status !== 'active') return;
    o.status = 'cleared';
    o.clearedAt = ev.at;
    o.clearedEventId = ev.id;
    clipAt(o, time(p.from) ?? ev.at);
    pruneOverrides(s, ev.at);
  },
};

// Run after the 009/010 handler of their type.
const STEER_OBSERVERS = {
  'decision.opened'(s, ev, p) {
    const g = goalFor(s, p);
    if (g && g.status === 'fitted' && g.fitted && int(ev.causeId) === g.fitted.eventId) g.fitted.decisionId = ev.id;
  },
  'decision.expired'(s, ev, p) {
    const d = decisionFor(s, p, ev);
    if (!d || !posInt(d.goalId) || !isObj(s.goals)) return;
    const g = s.goals[d.goalId];
    if (!g || g.status !== 'fitted' || g.fitted?.decisionId !== d.id) return;
    if (GOAL_BLOCKED.has(p.reason) && d.status === 'committed') { d.status = 'cancelled'; d.closedAt = ev.at; }
    if (GOAL_REOPEN.has(p.reason)) reopenGoal(g, ev.at, s.world.timezone, p.reason);
    else if (p.reason === 'owner_cancelled') { g.status = 'cancelled'; g.closedAt = ev.at; }   // CANCEL TONIGHT on its outing
    else if (GOAL_CLOSE.has(p.reason)) { g.status = 'expired'; g.closedAt = ev.at; g.reason = p.reason; }   // 015
  },
  'sleep.started'(s) {
    if ('soakedAt' in s) delete s.soakedAt;
  },
};

// ── 014 geo (plan §A2.1): road routes and venue places ───────────────────
// s.routes / s.placesSig appear only when the first 014 event folds (the 012
// rule), so a pre-014 log serializes exactly as before.

const ROUTE_KEY_RE = /^place:[a-z0-9][a-z0-9-]{0,39}\|place:[a-z0-9][a-z0-9-]{0,39}\|(?:car|foot)$/;
const ROUTE_PTS_MAX = 200;

function foldVenueCreated(s, id, p) {
  const venue = cleanVenue(p.venue);
  if (!venue) return;
  s.places.set(id, { ...s.places.get(id), venue });
  s.placesSig = placesSigOf(s);
}

function cleanPts(v) {
  if (!Array.isArray(v) || v.length > ROUTE_PTS_MAX) return null;
  const out = [];
  for (const q of v) {
    if (!Array.isArray(q) || q.length !== 2 || !Number.isInteger(q[0]) || !Number.isInteger(q[1])) return null;
    if (Math.abs(q[0]) > 90e5 || Math.abs(q[1]) > 180e5) return null;
    out.push([q[0], q[1]]);
  }
  return out;
}

const latLon = (v) => (isObj(v) && finite(v.lat) && finite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180 ? { lat: v.lat, lon: v.lon } : null);

const HANDLERS_014_GEO = {
  'route.recorded'(s, ev, p) {
    const a = placeId(p.a);
    const b = placeId(p.b);
    const profile = p.profile === 'car' || p.profile === 'foot' ? p.profile : null;
    if (!a || !b || a >= b || !profile) return;
    if (!finite(p.km) || p.km < 0 || p.km > 2000 || !finite(p.minutes) || p.minutes < 0 || p.minutes > 3000) return;
    const aAt = latLon(p.aAt);
    const bAt = latLon(p.bAt);
    const pts = cleanPts(p.pts ?? []);
    if (!aAt || !bAt || !pts) return;
    if (!isObj(s.routes)) s.routes = {};
    s.routes = { ...s.routes, [`${a}|${b}|${profile}`]: { km: p.km, minutes: p.minutes, aAt, bAt, pts, eventId: ev.id } };
    s.placesSig = placesSigOf(s);
  },
};

// 009 wins on a name clash (tested): the story, influence and 011 tables can only add types.
const HANDLERS = { ...HANDLERS_WAKE, ...SCENE_HANDLERS, ...HANDLERS_014_GEO, ...HANDLERS_014_SCHED, ...GOD_HANDLERS, ...HANDLERS_011, ...HANDLERS_012, ...STORY_HANDLERS, ...PROJECTOR_010, ...HANDLERS_009 };   // 015: GOD_HANDLERS

// The overlay gate (012): the influence facade installs influenceOn('mood');
// default closed, so views are exactly 009/010's.
let overlayGate = () => false;

/** fn() → may views add the chat-mood overlay? null restores the default (never). */
export function setOverlayGate(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setOverlayGate expects a function or null');
  overlayGate = fn || (() => false);
}

function overlayOpen(state, opts) {
  if (opts?.chatMood === false || !Array.isArray(state?.chatMood) || !state.chatMood.length) return false;
  try { return overlayGate() === true; } catch { return false; }
}

/**
 * Base vitals + the decayed chat-mood overlay at `at` (spec 012): the sum is
 * clamped as a whole, added to mood.valence / stress / socialBattery, then the
 * vital ranges and couplings apply. Returns `vitals` itself when there is
 * nothing to add (gate closed, no entries, `{chatMood:false}`, all decayed).
 */
export function withChatMood(vitals, state, at, opts = {}) {
  if (!isObj(vitals)) return vitals;
  const o = overlayOpen(state, opts) ? chatMoodOverlay(state.chatMood, at) : null;
  const d = opts?.chatMood === false ? null : dreamOverlay(state, at);
  if (!o && !d) return vitals;
  const v = { ...vitals, mood: { ...(vitals.mood || {}) } };
  if (finite(v.mood.valence)) v.mood.valence += (o?.valence ?? 0) + (d?.valence ?? 0);
  if (finite(v.stress)) v.stress += (o?.stress ?? 0) + (d?.stress ?? 0);
  if (finite(v.socialBattery)) v.socialBattery += o?.social ?? 0;
  return applyCouplings(v);
}

// 020 G: this morning's dream, a small nudge gone by midday. Shown, not integrated: nothing of it stays in his vitals.
function dreamOverlay(state, at) {
  const d = state?.story?.dream;
  if (!isObj(d) || !finite(d.at) || !finite(d.until) || at < d.at || at >= d.until || (!d.dv && !d.ds)) return null;
  const left = 1 - (at - d.at) / (d.until - d.at);
  return { valence: (d.dv ?? 0) * left, stress: (d.ds ?? 0) * left };
}

// Put the overlay on a view: v.vitals gains it, v.vitalsBase keeps what it replaced.
function overlayView(v, at, opts) {
  const next = withChatMood(v.vitals, v, at, opts);
  if (next !== v.vitals) { v.vitalsBase = v.vitals; v.vitals = next; }
  return v;
}

// ── Views ─────────────────────────────────────────────────────────────────

/**
 * A read-only VIEW of `state` at world time `at` (≥ state.at): vitals
 * integrated over the gap, age re-derived, travel position interpolated. For
 * readers only — project() refuses a view (it would integrate twice).
 */
export function advanceTo(state, at, world, opts = {}) {
  if (!isObj(state) || state.view) fail('advanceTo needs a projected state, not a view');
  const v = structuredClone(state);
  if (v.genesisAt !== null && v.at !== null && Number.isFinite(at) && at > v.at) {
    v.vitals = integrate(v.vitals, v.activity, Math.min(MAX_INTEGRATE_MIN, (at - v.at) / 60), overlayFor(v, world),
      { at: v.at, rain: v.weather?.rain === true, ...itemizedCtx(v) });
  }
  const when = Number.isFinite(at) ? Math.max(at, v.at ?? at) : v.at;
  if (v.self.birthdate && when) v.self.age = ageOn(v.self.birthdate, when, v.world.timezone);
  if (when) v.position = { ...v.position, ...positionAt(v, when) };
  if (when) overlayView(v, when, opts);   // 012: also at at <= state.at
  v.viewAt = when;
  v.view = true;
  return v;
}

/**
 * His vitals at world time `at` (≥ state.at) — exactly advanceTo(state, at,
 * world).vitals, without cloning the whole state (the pulse's snack check and
 * the Day page's sparklines ask for nothing else).
 */
export function vitalsAt(state, at, world, opts = {}) {
  if (!isObj(state)) fail('vitalsAt needs a projected state');
  if (state.view) return structuredClone(state.vitals);
  if (state.genesisAt === null || state.at === null || !Number.isFinite(at) || !(at > state.at)) {
    const base = structuredClone(state.vitals);
    return Number.isFinite(at) ? withChatMood(base, state, Math.max(at, state.at ?? at), opts) : base;
  }
  const base = integrate(state.vitals, state.activity, Math.min(MAX_INTEGRATE_MIN, (at - state.at) / 60), overlayFor(state, world),
    { at: state.at, rain: state.weather?.rain === true, ...itemizedCtx(state) });
  return withChatMood(base, state, at, opts);
}

/**
 * A cheap read-only view at `at`: advanceTo's vitals, age and position over a
 * SHALLOW copy, so its Maps/Sets are the projection's own. Only for readers
 * that never mutate what they read (decisions.evaluate, once per pulse step);
 * everything else takes advanceTo's deep copy.
 */
export function sharedView(state, at, world) {
  if (!isObj(state) || state.view) fail('sharedView needs a projected state, not a view');
  if (state.genesisAt === null || state.at === null || !Number.isFinite(at) || !(at > state.at)) return advanceTo(state, at, world);
  const v = { ...state, vitals: vitalsAt(state, at, world, { chatMood: false }) };
  if (v.self?.birthdate) v.self = { ...v.self, age: ageOn(v.self.birthdate, at, v.world.timezone) };
  v.position = { ...v.position, ...positionAt(v, at) };
  overlayView(v, at);
  v.viewAt = at;
  v.view = true;
  return v;
}

/** His map position at `at`: { placeId, lat, lon, travelling } (straight line while travelling). */
export function positionAt(state, at) {
  const pos = state?.position;
  if (!pos) return { placeId: null, lat: null, lon: null, travelling: false };
  const t = pos.travel;
  if (!t) return { placeId: pos.placeId, lat: pos.lat, lon: pos.lon, travelling: false };
  const a = t.from ? state.places.get(t.from) : null;
  const b = t.to ? state.places.get(t.to) : null;
  if (!a || !b) return { placeId: null, lat: pos.lat, lon: pos.lon, travelling: true };
  const span = t.endAt - t.startAt;
  const frac = span > 0 ? (at - t.startAt) / span : 1;
  return { placeId: null, ...lerpPosition(a, b, frac), travelling: true };
}

// ── Serialization ─────────────────────────────────────────────────────────

/** JSON-safe form of a WorldState (Maps/Sets → arrays, in insertion order). */
export function serializeState(state) {
  const { view, viewAt, vitalsBase, ...rest } = state;
  return {
    v: SNAPSHOT_VERSION,
    ...rest,
    places: [...state.places.entries()],
    cast: [...state.cast.entries()],
    decisions: [...state.decisions.entries()],
    excluded: [...state.excluded].sort((a, b) => a - b),
    keptInRange: state.keptInRange instanceof Set ? [...state.keptInRange].sort((a, b) => a - b) : [],
  };
}

function cleanRanges(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const r of v.slice(0, MAX_RANGES)) {
    if (!isObj(r) || !posInt(r.from) || !posInt(r.to) || r.from > r.to) continue;
    if (out.some(x => x.from === r.from && x.to === r.to)) continue;
    out.push({ from: r.from, to: r.to, eventId: posInt(r.eventId) });
  }
  return out;
}

// A 009 (v1) snapshot has no story slice: default it here; fill any missing
// top-level key. rebuild() never starts from such a row (parseSnapshotRow
// skips it), since the story also observes 009 events.
function cleanStory(v) {
  const dflt = initialStory();
  if (!isObj(v)) return dflt;
  const out = { ...v };
  for (const k of Object.keys(dflt)) {
    const ok = Array.isArray(dflt[k]) ? Array.isArray(out[k]) : isObj(out[k]);
    if (!ok) out[k] = dflt[k];
  }
  return out;
}

/** Inverse of serializeState. Throws on a wrong version or shape. */
export function deserializeState(obj) {
  if (!isObj(obj) || obj.v !== SNAPSHOT_VERSION) fail('snapshot version mismatch');
  for (const k of ['places', 'cast', 'decisions', 'excluded']) if (!Array.isArray(obj[k])) fail(`snapshot ${k} is not a list`);
  if (!Number.isSafeInteger(obj.lastEventId) || obj.lastEventId < 0) fail('snapshot lastEventId is invalid');
  const { v, ...rest } = obj;
  return {
    ...rest,
    places: new Map(obj.places),
    cast: new Map(obj.cast),
    decisions: new Map(obj.decisions),
    excluded: new Set(obj.excluded.filter(id => Number.isSafeInteger(id))),
    excludedSigs: Array.isArray(obj.excludedSigs) ? obj.excludedSigs : [], // older snapshots had none
    rebuildNeeded: false,
    // 010 fields; a 009 snapshot has none of them.
    counters: { jevDay: null, jevToday: 0, arcJevDay: null, arcJevToday: 0, ...(isObj(obj.counters) ? obj.counters : {}) },
    story: cleanStory(obj.story),
    excludedRanges: cleanRanges(obj.excludedRanges),
    keptInRange: new Set(Array.isArray(obj.keptInRange) ? obj.keptInRange.filter(id => Number.isSafeInteger(id)) : []),
  };
}

// ── Snapshots (a cache, not the log) ──────────────────────────────────────

/**
 * Persist `state` as a snapshot (plan §R1: day boundary and clean shutdown)
 * and prune old ones. Refuses views and states awaiting a rebuild. One
 * snapshot per upto_event_id: an existing one is returned as is.
 */
export function saveSnapshot(state, { timezone } = {}) {
  if (!isObj(state) || state.view) fail('cannot snapshot a view');
  if (state.rebuildNeeded) fail('state needs a rebuild before it can be snapshotted');
  if (!state.lastEventId || state.at === null) return null;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM world_snapshots WHERE upto_event_id = ? ORDER BY id DESC LIMIT 1').get(state.lastEventId);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO world_snapshots (upto_event_id, at, state_json) VALUES (?, ?, ?)')
    .run(state.lastEventId, state.at, JSON.stringify(serializeState(state)));
  pruneSnapshots({ timezone: timezone ?? state.world?.timezone });
  return Number(info.lastInsertRowid);
}

function parseSnapshotRow(row) {
  try {
    const raw = JSON.parse(row.state_json);
    // A pre-010 (009) row has no story slice. The story reducer also observes
    // 009 events (work days, contacts), so defaulting the slice would lose what
    // those events folded before the upgrade: skip the row (a full replay
    // rebuilds it, and the next snapshot carries the slice).
    if (!isObj(raw) || !isObj(raw.story)) return null;
    const state = deserializeState(raw);
    if (state.lastEventId !== row.upto_event_id) return null;
    return { id: row.id, uptoEventId: row.upto_event_id, at: row.at, state };
  } catch {
    return null;
  }
}

/**
 * Newest readable snapshot, optionally only those with upto_event_id <
 * `beforeEventId`. { id, uptoEventId, at, state } or null. Unreadable rows
 * (old version, corrupt JSON) are skipped, not deleted.
 */
export function loadLatestSnapshot({ beforeEventId } = {}) {
  const db = getDb();
  const rows = beforeEventId !== undefined && beforeEventId !== null
    ? db.prepare('SELECT * FROM world_snapshots WHERE upto_event_id < ? ORDER BY upto_event_id DESC, id DESC LIMIT ?')
      .all(Number(beforeEventId) || 0, SNAPSHOT_SCAN)
    : db.prepare('SELECT * FROM world_snapshots ORDER BY upto_event_id DESC, id DESC LIMIT ?').all(SNAPSHOT_SCAN);
  for (const row of rows) {
    const snap = parseSnapshotRow(row);
    if (snap) return snap;
  }
  return null;
}

/**
 * Delete snapshots that may contain state from event `fromEventId` on, or
 * from world time `fromAt` on (either bound alone works). Returns the count.
 * eventLog.revertEvent / redactPerson already do this for their own writes.
 */
export function invalidateSnapshots({ fromEventId, fromAt } = {}) {
  const id = Number.isSafeInteger(fromEventId) ? fromEventId : null;
  const at = Number.isSafeInteger(fromAt) ? fromAt : null;
  if (id === null && at === null) return 0;
  return getDb().prepare('DELETE FROM world_snapshots WHERE (? IS NOT NULL AND upto_event_id >= ?) OR (? IS NOT NULL AND at >= ?)')
    .run(id, id, at, at).changes;
}

/**
 * Retention (plan §D): keep the newest `keep` (14) snapshots plus, among the
 * older ones, the newest per local calendar month. Returns the count deleted.
 */
export function pruneSnapshots({ keep = SNAPSHOT_KEEP, timezone } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT id, at FROM world_snapshots ORDER BY upto_event_id DESC, id DESC').all();
  const months = new Set();
  const drop = [];
  rows.forEach((r, i) => {
    if (i < keep) return;
    const month = dateKey(r.at, timezone).slice(0, 7);
    if (months.has(month)) drop.push(r.id);
    else months.add(month);
  });
  const del = db.prepare('DELETE FROM world_snapshots WHERE id = ?');
  db.transaction(() => { for (const id of drop) del.run(id); })();
  return drop.length;
}

// ── Rebuild (DB) ──────────────────────────────────────────────────────────

/** Every id the log's reverts exclude (∪ eventLog.cascadeIds over listReverts()). */
export function exclusionSet() {
  const out = new Set();
  for (const r of listReverts()) for (const id of cascadeIds(r.targetId)) out.add(id);
  return out;
}

/**
 * Rebuild the projection: exclusions from the whole log, the newest snapshot
 * that predates every revert target it hasn't seen (an older one, or genesis,
 * otherwise — stale ones are deleted), then a replay of later events in id
 * order. `useSnapshot: false` forces a full replay from an empty state.
 */
export function rebuild({ world = getWorld(), useSnapshot = true } = {}) {
  const reverts = listReverts();
  const excluded = exclusionSet();
  // 010: rewinds (a reverted rewind is not one).
  const rewinds = listRewinds().filter(r => !excluded.has(r.rewindId));
  let state = null;
  if (useSnapshot) {
    let before;
    for (let guard = 0; guard < SNAPSHOT_SCAN && !state; guard++) {
      const snap = loadLatestSnapshot({ beforeEventId: before });
      if (!snap) break;
      // A revert the snapshot hasn't seen must target something after it.
      const stale = reverts.some(r => r.revertId > snap.uptoEventId && r.targetId <= snap.uptoEventId)
        || rewinds.some(r => r.rewindId > snap.uptoEventId && r.from <= snap.uptoEventId);
      if (stale) {
        getDb().prepare('DELETE FROM world_snapshots WHERE id = ?').run(snap.id);
        before = snap.uptoEventId;
        continue;
      }
      state = snap.state;
    }
  }
  state = state ?? createInitialState(world);
  for (const id of excluded) state.excluded.add(id);
  for (const r of rewinds) addRange(state, r.from, r.to, r.rewindId);

  for (;;) {
    const page = eventsAfter(state.lastEventId, REPLAY_PAGE);
    if (!page.length) break;
    for (const ev of page) applyInPlace(state, ev, world);
    if (page.length < REPLAY_PAGE) break;
  }
  if (state.rebuildNeeded) {
    // A revert target was folded before its exclusion was known (a snapshot
    // the stale check couldn't see through). Replay everything once more.
    if (!useSnapshot) fail('replay did not converge');
    return rebuild({ world, useSnapshot: false });
  }
  return state;
}

/**
 * His vitals on a grid over the past window [from, to] (Life · Day's
 * sparklines). Read only — unlike rebuild() it deletes nothing: the newest
 * readable snapshot before the window's first event that no later revert or
 * rewind reaches into (stale ones are skipped, older ones tried), else an
 * empty state when the log up to the window is at most `maxEvents` long, else
 * null (no sparkline beats a full replay per request). Events then fold in id
 * order into a private draft; each grid point is read (vitalsAt) just before
 * the first event dated after it, so it sees the activity then in force.
 * → [{ at, vitals }] | null
 */
export function vitalsSeries({ from, to, stepSec = 1800, world = getWorld(), maxEvents = 20000 } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const step = Math.max(60, Math.floor(stepSec));
  const db = getDb();
  const first = db.prepare('SELECT MIN(id) AS id FROM world_events WHERE at >= ?').get(Math.floor(from))?.id ?? null;
  if (first === null) return [];
  const state = readOnlyBase(first, world, maxEvents);
  if (!state) return null;

  const out = [];
  let next = Math.ceil(from / step) * step;
  const sampleUpTo = (t) => {
    for (; next <= to && next <= t; next += step) {
      if (state.genesisAt !== null && state.at !== null && state.at <= next) out.push({ at: next, vitals: vitalsAt(state, next, world) });
    }
  };
  let folded = 0;
  for (let done = false; !done;) {
    const page = eventsAfter(state.lastEventId, REPLAY_PAGE);
    if (!page.length) break;
    for (const ev of page) {
      if (ev.at > next) sampleUpTo(ev.at - 1);
      if (next > to && ev.at > to) { done = true; break; }
      applyInPlace(state, ev, world);
      if (++folded > maxEvents) return null;
    }
    if (page.length < REPLAY_PAGE) break;
  }
  sampleUpTo(to);
  return out;
}

// The private draft a read-only fold starts from (vitalsSeries, stateBeforeEvent): the
// newest readable snapshot before event `before` that no later revert or rewind reaches
// into, else an empty state when the log up to there is at most `maxEvents` long, else
// null. Today's exclusions and rewind ranges are applied, so later reverts count.
function readOnlyBase(before, world, maxEvents) {
  const reverts = listReverts();
  const excluded = exclusionSet();
  const rewinds = listRewinds().filter(r => !excluded.has(r.rewindId));
  let state = null;
  let scanBefore = before;
  for (let guard = 0; guard < SNAPSHOT_SCAN && !state; guard++) {
    const snap = loadLatestSnapshot({ beforeEventId: scanBefore });
    if (!snap) break;
    const stale = reverts.some(r => r.revertId > snap.uptoEventId && r.targetId <= snap.uptoEventId)
      || rewinds.some(r => r.rewindId > snap.uptoEventId && r.from <= snap.uptoEventId);
    if (stale) { scanBefore = snap.uptoEventId; continue; }
    state = snap.state;
  }
  if (!state) {
    if (before > maxEvents) return null;
    state = createInitialState(world);
  }
  for (const id of excluded) state.excluded.add(id);
  for (const r of rewinds) addRange(state, r.from, r.to, r.rewindId);
  return state;
}

/**
 * The world "as of" one moment (plan 020 D1): the one read for every writer's fact sheet.
 *
 *   asOf({ eventId })  what the world held when this event was appended: every event with
 *                      a smaller id. For facts tied to a moment in the log (an outing's start).
 *   asOf({ at })       what had happened by this time: every event dated ≤ `at`. `at` is not
 *                      monotone in id (catch-up, phone and chat events write past times), so
 *                      later-dated rows are skipped, and the base snapshot must predate the
 *                      first of them. For facts tied to a clock time (a journal's night).
 *
 * Either way it is the moment's facts as we know them now: today's reverts, rewinds and
 * redactions are applied, so a later revert counts. Read only, like vitalsSeries.
 * Numbers at a clock time come from vitalsAt(state, t, world): the state is the fold, not a view.
 *
 * → { state, at, upto, targetExcluded } | null. `state` is the caller's own copy (structuredClone,
 *   as advanceTo pays per turn). `at` is the moment, `upto` the newest id folded. null = no such
 *   world: a bad key, before genesis, or no base within `maxEvents` (a very old id whose
 *   snapshots were pruned). Callers fall back knowingly; this never silently returns "now".
 *
 * Cached (small LRU) per key and world, and dropped whole on a new revert or rewind or a purge's
 * redaction; a plain append can't change an earlier cut. An `at` key also carries the newest id
 * dated by then, so a later back-dated event misses too.
 */
const ASOF_CACHE_MAX = 8;
const asOfCache = new Map();
const asOfWorldIds = new WeakMap();
let asOfWorldSeq = 0;
let asOfDb = null;
let asOfStamp = null;
const asOfCounts = { hits: 0, misses: 0 };
/** Test seam: the cache's counters. */
export const __asOfStats = () => ({ ...asOfCounts, size: asOfCache.size });

function asOfWorldId(world) {
  if (!isObj(world)) return 'none';
  if (!asOfWorldIds.has(world)) asOfWorldIds.set(world, ++asOfWorldSeq);
  return asOfWorldIds.get(world);
}

// What can change an already-folded cut: a revert or a rewind in the log, a purge's redaction.
function asOfUndoStamp(db) {
  const r = db.prepare("SELECT MAX(id) AS id FROM world_events WHERE type IN ('event.reverted', 'world.rewound')").get()?.id ?? 0;
  return `${r}.${redactionGeneration()}`;
}

function asOfBounds(db, key) {
  if (Number.isSafeInteger(key?.eventId)) {
    if (key.eventId <= 0) return null;
    const head = lastEventId() ?? 0;
    const before = Math.min(key.eventId, head + 1);
    return { cacheKey: `e${before}`, before, upto: before - 1, notAfter: null };
  }
  if (Number.isFinite(key?.at)) {
    const at = Math.floor(key.at);
    const upto = db.prepare('SELECT MAX(id) AS id FROM world_events WHERE at <= ?').get(at)?.id ?? null;
    if (upto === null) return null;
    const later = db.prepare('SELECT MIN(id) AS id FROM world_events WHERE at > ?').get(at)?.id ?? null;
    return { cacheKey: `t${at}.${upto}`, before: Math.min(upto + 1, later ?? upto + 1), upto, notAfter: at };
  }
  return null;
}

export function asOf(key, { world = getWorld(), maxEvents = 20000 } = {}) {
  const db = getDb();
  // Everything goes at once: a purged person's rows must not linger in memory until evicted.
  const stamp = asOfUndoStamp(db);
  if (db !== asOfDb || stamp !== asOfStamp) { asOfCache.clear(); asOfDb = db; asOfStamp = stamp; }
  const bounds = asOfBounds(db, key);
  if (!bounds || bounds.upto <= 0) return null;
  const cacheKey = `${bounds.cacheKey}|${asOfWorldId(world)}`;
  let state = asOfCache.get(cacheKey);
  if (state) {
    asOfCounts.hits++;
    asOfCache.delete(cacheKey);   // most recently used last
  } else {
    asOfCounts.misses++;
    state = readOnlyBase(bounds.before, world, maxEvents);
    if (!state) return null;
    let cursor = state.lastEventId ?? 0;
    let folded = 0;
    while (cursor < bounds.upto) {
      const page = eventsAfter(cursor, REPLAY_PAGE);
      if (!page.length) break;
      for (const ev of page) {
        if (ev.id > bounds.upto) { cursor = bounds.upto; break; }
        cursor = ev.id;
        if (bounds.notAfter !== null && ev.at > bounds.notAfter) continue;
        applyInPlace(state, ev, world);
        if (++folded > maxEvents) return null;
      }
      if (page.length < REPLAY_PAGE) break;
    }
    if (state.rebuildNeeded || state.genesisAt === null) return null;
  }
  asOfCache.set(cacheKey, state);
  while (asOfCache.size > ASOF_CACHE_MAX) asOfCache.delete(asOfCache.keys().next().value);
  const targetExcluded = Number.isSafeInteger(key?.eventId) && isExcludedId(state, key.eventId);
  const at = bounds.notAfter ?? getEvent(key.eventId)?.at ?? state.at;
  return { state: structuredClone(state), at, upto: bounds.upto, targetExcluded };
}

/**
 * The world as it stood just before event `eventId` was appended (016: a scene's "before the
 * outing" facts): asOf's state. → a projected state (not a view) | null (see asOf).
 */
export function stateBeforeEvent(eventId, opts = {}) {
  return asOf({ eventId }, opts)?.state ?? null;
}

/**
 * Live path for the facade: fold a just-appended event; a revert of an event
 * already folded in triggers rebuild() (the only way to take effects back out).
 */
export function applyAppended(state, event, { world = getWorld() } = {}) {
  const next = project(state, event, world);
  return next.rebuildNeeded ? rebuild({ world }) : next;
}
