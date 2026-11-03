import { publicStanceRows, setStanceProvider } from './stanceSeam.js';   // 020 B
import crypto from 'crypto';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { isGroupJid, isDmJid } from '../utils/jidUtils.js';
import { getDb } from '../memory/db.js';
import { isGroupMuted as dashboardIsGroupMuted } from '../dashboard/state.js';
import { now } from './clock.js';
import { setRngSeed, rngFor } from './rng.js';
import { ensureWorldSeed, resetWorldCache } from './world.js';
import {
  appendEvent, revertEvent as logRevert, redactPerson as logRedactPerson, causeChain, cascadeIds, listEvents as logListEvents,
  getEvent, lastEventId as lastLogEventId, EVENT_TYPES as LOG_EVENT_TYPES, STORY_EVENT_TYPES as LOG_STORY_TYPES,
  INFLUENCE_EVENT_TYPES as LOG_INFLUENCE_TYPES, STEER_EVENT_TYPES as LOG_STEER_TYPES,
  childEvents, eventsNaming, directorGroup,
} from './eventLog.js';
import { rebuild, applyAppended, advanceTo, positionAt, saveSnapshot, isOrphaned, isExcludedId, vitalsAt, vitalsSeries, stateBeforeEvent } from './projector.js';
import { createPulse, genesis } from './pulse.js';
import { createPhone, defaultIsMember } from './phone.js';
import {
  gateMessage as gate, availabilityAt, isAwakeAt as awakeAt, freeWindows as windowsOf,
} from './availability.js';
import {
  timeLine as timeLineOf, innerStateLine as innerLineOf, castCards as cardsOf, catchUpNote as catchUpOf,
  callStateNote as callNoteOf, lineMode as lineModeOf, personLabelOf,
} from './innerState.js';
import { flagReply, dismissClaim as dismissClaimRow, overSelfMentionBudget as overMentionBudget } from './claims.js';
import { noteChat, setMode } from './decisions.js';
import { enqueue, pendingCount, markDrained } from './queue.js';
import { isHeavy, startFromHeavy, lifeGuardNote as guardNoteOf, isActive as embargoIsActive, GUARD_NOTE } from './embargo.js';
// 010 story layer (spec 010, contracts/story-api.md §3.7). Inert while the
// `arcs` skill is off: every seam it installs returns 009's default then.
import * as story from './story/index.js';
import { buildDayView } from './day.js';
import { buildWalletView, WALLET_TYPES } from './wallet.js';   // 018
import { runRules, mergeFindings, cleanStored, nightDue, windowOf, DISMISSED_MAX, RULES as SWEEP_RULES } from './sweep.js';   // 020 E1
import { buildThoughtDeed, ThoughtDeedError as ThoughtDateError } from './thoughtDeed.js';   // 020 F1
import { buildPublicRaw, homeIdsOf } from './publicView.js';
import { buildMapView } from './mapView.js'; // 014 map
import { buildBase, interruptionsOf, liveView, publicBeats, traceOf, firstName as liveFirstName } from './liveSession.js';   // 020 C1
import { tickThoughts, streamKind, THOUGHT_TYPES, MEMORY_DAYS, EVIDENCE_WINDOW_SEC } from './thoughts.js';   // 020 F2
import { loadPhraseBank, unloadPhraseBank, phraseBankView as bankView } from './phraseBank.js';   // 020 H2
import { bankContext } from './phraseCheck.js';
import { insertThought, recentThoughts, thoughtsBetween, sweepThoughts, pruneThoughts, registerThoughtHooks, realThoughtsBetween, isRealThought } from './thoughtStore.js';
import { dateKey as liveDateKey, hhmm as liveHhmm, localParts as liveLocalParts, zonedToUnix } from './clock.js';

const zonedDayStart = (y, mo, d, tz) => zonedToUnix(y, mo, d, 0, 0, tz);
// 012 chat influence (spec 012). Inert while the `chat-influence` skill is off:
// no model call, no event, no prompt change, the mood overlay closed.
import * as influence from './influence/index.js';
// 014 real places · geo: the client is injected (startLife({geo})); the stores and
// jobs live here, the only importer of src/life/geo/ (plan §2 guard).
import { createCandidateStore } from './geo/candidates.js';
import { createGeoJobs, fetchRoutes as fetchGeoRoutes, realifyJob, routesRefreshJob } from './geo/jobs.js';
import { GeoError } from './geo/client.js';
import { cleanVenueName, cleanArea } from './geo/clean.js';
import {
  regionBox, routeFor, isRealVenue, placeLabel as placeLabelOf, negativeAt, setCollidingVenues, routePairsFor,
  refreshPairs, isHomeKind, setVenueNamesSource, scrubVenueNames,
} from './places.js';
import { haversineKm } from './travel.js';
import { realPeopleNames as realPeopleNamesOrThrow, textNameCollisions } from './world.js';
import { SCHEDULE_EVENT_TYPES as LOG_SCHEDULE_TYPES } from './eventLog.js';   // 014 sched
import { firstFrom as overrideFirstFrom, lastTo as overrideLastTo } from './planEdits.js';   // 014 sched

// The life engine's one door (spec 009 plan §C1). The pipeline (Phase 3) and
// the dashboard (Phase 4) import only this module; everything under src/life/
// stays pure or DB-only behind it. This is also the only place that owns the
// live projection, the pulse timer and the phone scheduler.
//
// Lifecycle: startLife() loads the world (ensureWorldSeed: world.json, else
// one seed call; the example world is refused unless the caller passed it —
// see refuseExample), rebuilds the projection from the log
// (snapshot + replay), appends genesis + places + cast on an empty log, catches
// up any downtime through the pulse, then arms the pulse and the phone (all
// timers unref'd). With the `life` skill off at boot nothing is seeded or
// started; a 60 s watcher starts it once the skill is switched on. Switching
// it off later keeps the world ticking (so it is still consistent when turned
// back on) but hands receipts/presence back: one last forced phone check
// drains the queue (nobody left unanswered — even at night), then the phone
// stops. A drain that couldn't run (no socket, a check in progress) is retried
// on the next tick. While off, the pulse opens no decisions and asks Jev
// nothing (decisions fall back to code).
//
// Every write goes through append(): eventLog.appendEvent → fold into the
// projection (projector.applyAppended, which rebuilds after a revert) → a
// heavy event starts an embargo (embargo.startFromHeavy) → the phone hears
// about it (presence/cadence). Readers get advanceTo() views at now(), never
// the live object.
//
// Not a world event (documented skip): vitals.js lists `reply.sent` (social
// battery −0.5 per sent reply) as a facade nudge. The projection is a pure
// fold of the log, so an in-memory nudge would be lost on every rebuild and
// make live and replayed state differ; 009 leaves it out.

const WATCH_MS = 60_000;
// A refused boot (no real world: the seed failed, world.json invalid) retries on
// its own long timer — never the 60 s watcher, since every retry without
// world.json is one 'mind' call. 1 h, doubling, capped at 24 h; a restart
// also retries.
const SEED_RETRY_MIN_MS = 60 * 60_000;
const SEED_RETRY_MAX_MS = 24 * 60 * 60_000;
const TIMELINE_MAX_SEC = 48 * 3600;
const MAP_TRIPS_SEC = 48 * 3600;
const PAGE = 500;
// Public view: ≤ 1M rows per (type-filtered) read — years of history — else no export
// ('history_too_large'). Rows are held per read: publicView keeps every cast delta anyway.
const PUBLIC_MAX_PAGES = 2000;
const STORY_IDLE_MS = 5000;

let rt = null;          // { world, state, pulse, phone, append, opts, timers, wasOn }
let starting = null;
let watcher = null;
let seedRetry = null;   // { timer, delayMs } while a refused boot waits to retry
let startIssue = null;  // { reason, at, retryAt, source } of the last refused boot
let leftover = null;    // { timer, running } while queued rows wait for an engine-less drain
let enabledFn = () => isSkillEnabled('life');
const tickSubs = new Set();

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const viewNow = () => (rt ? advanceTo(rt.state, now(), rt.world) : null);

function originOfChat(chatJid) {
  if (isGroupJid(chatJid)) return 'group';
  if (isDmJid(chatJid)) return 'dm';
  return null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Start the engine. opts (all optional; tests and the dry run inject them):
 *   getSock, processMessage, withChatLock, isGroupMuted, isMember, loadMessage   phone.js deps
 *   isKnownPerson(jid)  may this DM sender nudge decisions (default: shares a group, group_members)
 *   isEnabled()      master switch (default isSkillEnabled('life'))
 *   world            a loaded world (skips ensureWorld)   ensureWorld()  default ensureWorldSeed
 *   allowExampleWorld  run on the example world (default: only when `world` is passed)
 *   onAlert({kind})  embargo started / no real world (refused boot)
 *   seed             RNG install seed (default: the genesis world hash)
 *   vitals           starting vitals for a fresh genesis
 *   timers: false    don't arm the pulse/phone timers (drive with tick())
 *   tickMinutes, catchupHours, setInterval, clearInterval, setTimer, clearTimer, sleep
 */
export async function startLife(opts = {}) {
  // 010: the DB-only forget/revoke/purge listeners reach the story tables even
  // when life never boots (research R22). Idempotent; never throws.
  story.registerHooks();
  registerThoughtHooks({ logger });      // 020 F2: same contract
  influence.registerHooks();             // 012: same contract (DB-only, idempotent)
  if (opts.geo !== undefined) setGeoClient(opts.geo);   // 014 geo: null by default (geo_off)
  setStanceProvider(opts.stances ?? null);               // 020 B: inert with none
  if (rt) return;
  if (starting) return starting;
  if (typeof opts.isEnabled === 'function') enabledFn = opts.isEnabled;
  if (!enabledFn()) {
    armWatcher(opts);
    await drainLeftovers(opts);
    return;
  }
  starting = boot(opts);
  let failure = null;
  try {
    await starting;
  } catch (err) {
    failure = err;
  } finally {
    starting = null;
  }
  if (!rt) await drainLeftovers(opts);   // a refused or failed boot leaves the queue to us
  if (failure) throw failure;
}

const LEFTOVER_RETRY_MS = 60_000;

/**
 * Queue rows with no engine to answer them: life was switched off in .env (or
 * the skill boots off) and the bot restarted, or a boot was refused / failed.
 * The running engine's life_off drain never happens then, so DMs and mentions
 * deferred before the restart would wait forever. One forced check drains
 * them (nobody left unanswered — even at night) on a phone that writes no
 * world events (life is off) and never lingers; presence goes back to
 * available. No socket yet (boot runs before the connection opens) → retried
 * every minute until it ran, the engine started, or nothing is pending.
 * → the check's result, or null when there was nothing to do / it was deferred.
 */
async function drainLeftovers(opts) {
  if (rt || starting || leftover?.running) return null;
  let n = 0;
  try { n = pendingCount(); } catch { n = 0; }
  if (!n) { clearLeftover(); return null; }
  const sock = safeCall(() => opts.getSock?.(), null);
  if (!sock || typeof opts.processMessage !== 'function') {
    armLeftover(opts);
    return null;
  }
  if (leftover) leftover.running = true;
  else leftover = { timer: null, running: true };
  let res = null;
  try {
    const phone = createPhone({
      getSock: opts.getSock,
      processMessage: opts.processMessage,
      withChatLock: opts.withChatLock,
      isGroupMuted: opts.isGroupMuted,
      isMember: opts.isMember,
      loadMessage: opts.loadMessage,
      appendEvent: () => null,           // life is off: no world events
      getState: () => null,
      world: opts.world,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      sleep: opts.sleep,
    });
    logger.info({ pending: n }, 'life: off with queued messages — draining them once');
    res = await phone.runCheck({ reason: 'life_off', force: true, linger: false });
    phone.stop();
    try { await sock.sendPresenceUpdate?.('available'); } catch { /* best effort */ }
  } catch (err) {
    logger.warn({ err: err?.message }, 'life: leftover drain failed');
  } finally {
    if (leftover) leftover.running = false;
  }
  if (res && !res.skipped) clearLeftover();
  else armLeftover(opts);
  return res;
}

function armLeftover(opts) {
  if (opts.timers === false) return;
  if (leftover?.timer) return;
  const timer = setInterval(() => {
    drainLeftovers(opts).catch(err => logger.warn({ err: err?.message }, 'life: leftover drain retry failed'));
  }, LEFTOVER_RETRY_MS);
  timer.unref?.();
  leftover = { timer, running: leftover?.running ?? false };
}

function clearLeftover() {
  if (leftover?.timer) clearInterval(leftover.timer);
  leftover = leftover?.running ? { timer: null, running: true } : null;
}

function safeCall(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

function armWatcher(opts) {
  if (watcher || opts.timers === false) return;
  watcher = setInterval(() => {
    if (!rt && !starting && enabledFn()) {
      clearInterval(watcher);
      watcher = null;
      startLife(opts).catch(err => logger.warn({ err: err?.message }, 'life: deferred start failed'));
    }
  }, WATCH_MS);
  watcher.unref?.();
}

/**
 * Why the engine isn't running although it was asked to start, or null:
 * { reason: 'example_world', at, retryAt, source }. For the dashboard / status.
 */
export function lifeStartIssue() {
  return startIssue ? { ...startIssue } : null;
}

// The example world (generic '(example)' cast and places) is for tests and the
// dry run only: it must never become his live life — a genesis is permanent
// (the log is append-only). Without a real world the engine stays OFF (the gate
// passes everything, as with life disabled), an alert is raised and the start
// is retried later. A caller that passes `world` itself chose it (tests, the
// dry run); `allowExampleWorld: true` allows it explicitly.
function refuseExample(opts, world) {
  const prev = seedRetry?.delayMs ?? 0;
  const delayMs = Math.min(SEED_RETRY_MAX_MS, prev ? prev * 2 : SEED_RETRY_MIN_MS);
  const at = Math.floor(Date.now() / 1000);
  startIssue = { reason: 'example_world', at, retryAt: at + Math.round(delayMs / 1000), source: world?.source ?? null };
  logger.error({ evt: 'issue', reason: 'example_world', retryInMin: Math.round(delayMs / 60_000) },
    'life: no real world (world.json missing or invalid and the seed failed) — life stays OFF; retrying later');
  try { opts.onAlert?.({ kind: 'example_world', retryAt: startIssue.retryAt }); } catch { /* best effort */ }
  if (seedRetry?.timer) clearTimeout(seedRetry.timer);
  if (opts.timers === false) { seedRetry = { timer: null, delayMs }; return; }
  const timer = setTimeout(() => {
    if (seedRetry) seedRetry.timer = null;
    resetWorldCache(); // an edited world.json is re-read, not the cached fallback
    startLife(opts).catch(err => logger.warn({ err: err?.message }, 'life: seed retry failed'));
  }, delayMs);
  timer.unref?.();
  seedRetry = { timer, delayMs };
}

// 020 H2: his voice for the code-written lines, checked against the names known today. Never fatal: English stays.
function loadVoiceBank(world) {
  // A bank is checked against today's names. Names that can't be read mean no bank: English, an issue, and the next restart retries.
  const refuse = (read, err) => {
    unloadPhraseBank();
    logger.warn({ evt: 'issue', where: 'life.phrases', read, err: err?.name || 'Error' }, 'life: phrase bank not loaded, English stays');
  };
  let realNames;
  let venueNames;
  try { realNames = realPeopleNamesOrThrow(); } catch (err) { refuse('real_names', err); return; }
  try {
    venueNames = venueNamesEver();
    if (venueReadFailed) { refuse('venue_names'); return; }
  } catch (err) { refuse('venue_names', err); return; }
  try {
    loadPhraseBank({ ctx: bankContext({ persona: getPersona(), world, realNames, venueNames, contentProblem: story.contentProblem }) });
  } catch (err) {
    refuse('bank', err);
  }
}

/** Side by side: today's lines and the file's (owner's judgement), the running bank apart from it. A read: works with life off. */
export function phraseBankView(opts) {
  return bankView({
    ...opts,
    // Before life's boot the file is still checked against the names known here. It stays a read: boot is what loads a bank.
    ctx: () => {
      let realNames = [];
      try { realNames = realPeopleNamesOrThrow(); } catch { /* the owner's view only */ }
      return bankContext({ persona: getPersona(), realNames, contentProblem: story.contentProblem });
    },
  });
}

async function boot(opts) {
  const world = opts.world ?? await (opts.ensureWorld ?? ensureWorldSeed)();
  const allowExample = opts.allowExampleWorld === true || (opts.allowExampleWorld === undefined && !!opts.world);
  if (!world || (world.source === 'example' && !allowExample)) {
    refuseExample(opts, world);
    return;
  }
  if (seedRetry?.timer) clearTimeout(seedRetry.timer);
  seedRetry = null;
  startIssue = null;
  const r = { world, state: rebuild({ world }), pulse: null, phone: null, opts, timers: opts.timers !== false, wasOn: true };
  r.append = makeAppend(r);
  rt = r;
  loadVoiceBank(world);
  try {
    const fresh = r.state.genesisAt === null || r.state.genesisAt === undefined;
    if (fresh) {
      genesis(r.append, world, now(), { vitals: opts.vitals });
      logger.info({ source: world.source, places: world.places.length, cast: world.cast.length }, 'life: genesis');
    }
    setRngSeed(opts.seed ?? r.state.world?.hash ?? world.hash ?? undefined); // undefined → rng.js default seed

    r.phone = createPhone({
      getSock: opts.getSock,
      processMessage: opts.processMessage,
      withChatLock: opts.withChatLock,
      isGroupMuted: opts.isGroupMuted,
      isMember: opts.isMember,
      loadMessage: opts.loadMessage,
      appendEvent: r.append,
      getState: () => r.state,
      world,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      sleep: opts.sleep,
      beforeDrainTurn: (chatJid, msgIds, at) => influence.beforeDrainTurn(chatJid, msgIds, at),
      // 012: invitation follow-ups (none while chat influence is off).
      followUps: {
        due: (at) => influence.dueFollowUps(at),
        prepare: (f, d) => influence.prepareFollowUp(f, d),
        finish: (f, o) => influence.finishFollowUp(f, o),
        isDueEvent: (ev) => influence.isFollowUpEvent(ev),
      },
    });
    r.pulse = createPulse({
      world,
      getState: () => r.state,
      append: r.append,
      tickMinutes: opts.tickMinutes,
      catchupHours: opts.catchupHours,
      setInterval: opts.setInterval,
      clearInterval: opts.clearInterval,
      onDay: (s) => snapshot(s),
      isEnabled: () => enabledFn(),
      // 010 seams (story-api §3.4): each returns 009's default while `arcs` is off;
      // storyItems resolves the story lazily, worldOf is state-derived.
      storyItems: (s, g) => story.items(s, g),
      worldOf: (s) => story.worldOf(s, world),
      blockCause: (plan, b) => story.blockCause(plan, b),
      planCause: (plan) => story.planCause(plan),
      // 012 seam: a live chat may push his sleep (false while chat influence is off).
      // 012 real chats first, then 019 his texting with the cast (an engaging chat keeps him up).
      beforeSleep: (s, at, block, add) => influence.beforeSleep(s, at, block, add) || story.phoneBeforeSleep(s, at, block, add),
      // 015 seam: the owner's planned wake nudges (nothing while `arcs` is off).
      atWake: (s, at, add) => story.atWake(s, at, add),
      atDream: (s, o) => story.atDream(s, o),   // 020 G
    });
    r.pulse.onTick((view, info) => afterTick(r, view, info));
    story.attach({
      getState: () => r.state,
      append: r.append,
      world,
      pulse: r.pulse,
      revert: (id, o = {}) => revertInternal(r, id, o),
      rebuild: () => { r.state = rebuild({ world: r.world }); },
      isLifeOn: () => rt === r && !!enabledFn(),
      liveTrace: (id) => liveSessionTrace(id),   // 020 C4: the record of an outing for its scene
      liveResumed: (id) => liveResumedLater(id),
      liveEarlier: (id) => liveEarlierStarts(id),
      // The arc seed's budget gate (seed.js generationGate): 008's mindBudgetOk,
      // passed in by index.js (life imports no mind module).
      mindBudgetOk: typeof r.opts.mindBudgetOk === 'function' ? r.opts.mindBudgetOk : null,
      // 014 geo: the Director's geo service (null → geo_off) and the venue names.
      geo: geoService(),
      venueNames: () => venueEntriesEver(),
      willTellBackOut: (d, o) => influence.willTellBackOut(d, o),
      // 020 F3: real thoughts' table and reads. An outing we can't read counts as private.
      thoughts: thoughtsOn ? {
        store: { insert: insertThought, realBetween: realThoughtsBetween },
        deedRows: (date) => thoughtDeed({ date }).rows,
        isPrivateNow: (at) => liveSession({ at }).private === true,
        isPrivateActivity: (id) => { const t = liveSessionTrace(id); return t ? t.private === true : true; },
      } : null,
    });
    // 016: the dashboard's scene view names a real person by their push name (operator view).
    story.setScenePersonLabel((jid) => personLabelOf(jid, { kind: 'dashboard' }));
    story.applyPendingWithdrawals();      // withdrawals the DB-only hooks recorded while detached
    influence.attachInfluence({
      getState: () => r.state,
      append: r.append,
      world,
      revert: (id, o = {}) => revertInternal(r, id, o),
      isLifeOn: () => rt === r && !!enabledFn(),
      opts: { isGroupMuted: opts.isGroupMuted, isMember: opts.isMember, personOptedOut: opts.personOptedOut },
      controlsVerdict: (o) => story.controlsVerdict(o),
      resolvePlan: (raw, claim, st, o) => story.resolvePlan(raw, claim, st, o),
      worldOf: (st) => story.worldOf(st, world),
      storyOn: () => story.storyOn(),     // P3: the advice tray is the story's
    });
    influence.applyPendingWithdrawals();  // 012: the same, for chat influence

    // A fresh genesis has no plan yet and the first grid step may be up to a
    // tick away: settle now, so a night-time first boot starts him asleep (or
    // in the current block), not "free at home".
    if (fresh) await r.pulse.settle(now());
    await r.pulse.runTo(now());           // catch up the downtime before going live
    // A check left open by a crashed process — closed AFTER the catch-up: an
    // event dated now would move the projection's time and skip the replay.
    r.phone.recover();
    if (r.timers) {
      r.pulse.start();
      await r.phone.start();
    }
    clearLeftover();                      // the engine answers its own queue now
    placesDivergence(r);                  // 014 geo (R28): codes and ids only
    refreshCollidingVenues(r, now(), { force: true });
    logger.info({ at: now(), lastEventId: r.state.lastEventId }, 'life: started');
  } catch (err) {
    if (r.pulse) r.pulse.stop();
    if (r.phone) r.phone.stop();
    story.detach();
    influence.detachInfluence();
    rt = null;
    throw err;
  }
}

// A revert from inside the story layer (a claim withdrawal): log + rebuild.
function revertInternal(r, id, { reason = '', by = 'system' } = {}) {
  const res = logRevert(Number(id), { reason, by, at: now() });
  if (rt === r) r.state = rebuild({ world: r.world });
  return { revertEventId: res.revertEventId, already: !!res.already };
}

function snapshot(state) {
  try { saveSnapshot(state); } catch (err) { logger.debug({ err: err?.message }, 'life: snapshot skipped'); }
}

async function afterTick(r, view, info) {
  try { r.phone.expireStale(info.at); } catch { /* best effort */ }
  const on = enabledFn();
  if (r.wasOn && !on) {
    // Turned off: answer what's queued once (forced: asleep or not), then give
    // receipts/presence back. No socket / a check running → retry next tick.
    let res = null;
    try { res = await r.phone.runCheck({ reason: 'life_off', force: true }); } catch (err) { logger.warn({ err: err?.message }, 'life: final drain failed'); }
    if (res && !res.skipped) {
      r.phone.stop();
      try { await r.opts.getSock?.()?.sendPresenceUpdate?.('available'); } catch { /* best effort */ }
      r.wasOn = false;
    } else {
      logger.info({ skipped: res?.skipped ?? 'error' }, 'life: final drain deferred to the next tick');
    }
  } else if (!r.wasOn && on && r.timers) {
    await r.phone.start();
    r.wasOn = true;
  } else {
    r.wasOn = on;
  }
  // 010: enqueue-only (journal, tray expiry, withdrawals); never awaits a model call.
  try { await story.afterTick(view, info, r.append); } catch (err) { logger.warn({ err: err?.message }, 'life: story afterTick failed'); }
  // 020 E1: the nightly plot-hole sweep (once a night; codes only; appends no event).
  try { sweepTick(r, info?.at ?? now()); } catch (err) { logger.warn({ evt: 'issue', where: 'life.sweep', err: err?.name || 'Error' }, 'life: sweep failed'); }
  // 014 geo: the venue name collision sweep (≤ every 10 min; fail closed).
  try { refreshCollidingVenues(r, info?.at ?? now()); } catch { /* best effort */ }
  // 012: work counter, evidence sweep, withdrawals (codes only; never a model call).
  try { await influence.afterTick(view, info); } catch (err) { logger.warn({ err: err?.message }, 'life: influence afterTick failed'); }
  // 020 F2: the thought stream (live only: a simulation never reaches here; no event, no model).
  try { if (thoughtsOn) thoughtsTick(r, view, info); } catch (err) { logger.warn({ evt: 'issue', where: 'life.thoughts', err: err?.name || 'Error' }, 'life: thoughts failed'); }
  for (const fn of tickSubs) {
    try { await fn(view, info); } catch (err) { logger.warn({ err: err?.message }, 'life: onTick subscriber failed'); }
  }
}

function makeAppend(r) {
  const append = (spec) => {
    const ev = appendEvent(spec);
    r.state = applyAppended(r.state, ev, { world: r.world });
    if (isHeavy(ev)) {
      const { events } = startFromHeavy(ev, r.state.embargo, { hours: config.life?.embargoHours });
      for (const e of events) append(e);
      try { r.opts.onAlert?.({ kind: 'embargo', eventId: ev.id }); } catch { /* best effort */ }
    }
    if (r.phone) r.phone.onEvent(ev).catch(err => logger.debug({ err: err?.message }, 'life: phone event failed'));
    return ev;
  };
  return append;
}

/** Stop the engine: snapshot, clear every timer. Safe to call when not started. */
export async function stopLife() {
  if (watcher) { clearInterval(watcher); watcher = null; }
  if (leftover?.timer) clearInterval(leftover.timer);
  leftover = null;
  if (seedRetry?.timer) clearTimeout(seedRetry.timer);
  seedRetry = null;
  startIssue = null;
  if (starting) { try { await starting; } catch { /* reported by startLife */ } }
  if (seedRetry?.timer) clearTimeout(seedRetry.timer); // a boot refused while we waited
  seedRetry = null;
  const r = rt;
  if (!r) return;
  rt = null;
  story.detach();
  influence.detachInfluence();
  r.pulse?.stop();
  r.phone?.stop();
  // Let a running story job (a journal night) finish its writes, bounded.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, STORY_IDLE_MS);
    t.unref?.();
    Promise.resolve(story.idle()).then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
  });
  snapshot(r.state);
  logger.info('life: stopped');
}

/** True while the engine runs and the `life` skill is on (the pipeline's gate switch). */
export function isLifeOn() {
  return !!rt && !!enabledFn();
}

/** A read-only view of his state now (advanceTo clone), or null when not started. */
export function getState() {
  return viewNow();
}

/** Advance the world to the clock's now (the timer's job; tests and the dry run call it). */
export async function tick() {
  return rt ? rt.pulse.tick() : null;
}

/** Subscribe to pulse ticks (008): fn(view, info). Returns unsubscribe. */
export function onTick(fn) {
  if (typeof fn !== 'function') throw new Error('life: onTick expects a function');
  tickSubs.add(fn);
  return () => tickSubs.delete(fn);
}

// ── Live path (Phase 3 wires these into src/index.js) ─────────────────────

/**
 * The availability gate (plan §R9). Sync. Life off → always 'now'.
 * ctx: { isDm, isGroup, isMention, isQuestion, hasActiveFlow, catchUp? }.
 */
export function gateMessage(msg, ctx = {}) {
  if (!isLifeOn()) {
    return { outcome: 'now', state: 'free', onPhone: false, until: null, delayHintMs: 0, scoreFactor: 1, reason: 'life_off' };
  }
  // A view at now: the social-battery tilt reads vitals as they are, not as of the last event.
  const view = viewNow();
  // 012: while a live chat holds his sleep off, that chat is the one he's in.
  const delayed = view?.sleep?.delayedFor;
  const liveChat = delayed ? influence.isLiveChat(msg?.groupJid ?? msg?.chatJid, delayed) : undefined;
  return gate(view, msg, ctx, { at: now(), world: rt.world, ...(delayed ? { liveChat } : {}) });
}

/** Queue a deferred message (idempotent on chat + message id). Returns the queue row or null. */
export function enqueueDeferred(msg, ctx = {}, rawKey) {
  if (!rt) return null;
  const chatJid = msg?.groupJid ?? msg?.chatJid ?? rawKey?.remoteJid;
  try {
    const avail = availabilityAt(rt.state, now(), rt.world);
    return enqueue({
      chatJid,
      msgId: msg?.id,
      senderJid: msg?.senderJid && msg.senderJid !== 'unknown' ? msg.senderJid : null,
      msgKey: rawKey,
      isDm: !!ctx.isDm,
      isMention: !!ctx.isMention,
      isQuestion: !!ctx.isQuestion,
      availability: avail.state,
    }).item;
  } catch (err) {
    logger.warn({ err: err?.message, chatJid }, 'life: enqueue failed');
    return null;
  }
}

/** ignore/react outcomes: remember the key, read at the next phone check. */
export function noteUnread(chatJid, rawKey) {
  return rt ? rt.phone.noteUnread(chatJid, rawKey) : false;
}

/**
 * now/sneak outcomes: he is looking — read this chat at once. → { read, catchUp }:
 * pass catchUp (null when nothing was queued here) as this turn's ctx.catchUp,
 * then settleCatchUp(catchUp) after the reply is sent. Unsettled → the next
 * phone check answers the queued items.
 */
export async function markSeenNow(sock, chatJid, rawKey) {
  return rt ? rt.phone.markSeenNow(sock, chatJid, rawKey) : { read: 0, catchUp: null };
}

/** The live turn that carried markSeenNow's catchUp replied: mark those queue rows answered. */
export function settleCatchUp(catchUp) {
  if (rt) return rt.phone.settleCatchUp(catchUp);
  // No engine (the leftover drain while life is off): mark the rows directly.
  const ids = Array.isArray(catchUp?.itemIds) ? catchUp.itemIds.filter(Number.isSafeInteger) : [];
  if (!ids.length) return 0;
  try { return markDrained(ids, { at: now() }); } catch { return 0; }
}

// ── Prompt lines (per-turn tail, plan §R12) ───────────────────────────────

export function timeLine() {
  return rt ? timeLineOf(rt.state, now(), rt.world) : '';
}

/** One situation + feeling line (≤ 240 chars) filtered for `audience` ({ chatJid, kind?, members? }). */
export function innerStateLine(audience, opts = {}) {
  return rt ? innerLineOf(viewNow(), now(), audience, { world: rt.world, ...opts }) : '';
}

export function castCards(audience, recentText = '', limit = 3, opts = {}) {
  return rt ? cardsOf(viewNow(), now(), audience, recentText, limit, { world: rt.world, ...opts }) : [];
}

/**
 * 016 (plan §P1.8): how a recent outing went, for this turn's audience — [] or
 * [one fenced block ≤ 480 chars]. opts: { recentText, imitating }. Nothing while
 * life, the `arcs` skill or scenes are off, while imitating, under an embargo, over
 * the self-mention budget or during a heavy stretch. Fails closed.
 */
export function sceneLines(audience, opts = {}) {
  if (!rt || opts.imitating) return [];
  try {
    const at = now();
    const mode = lineModeOf(rt.state, at, audience?.chatJid ?? null);
    return story.sceneMemory(rt.state, audience, {
      at, recentText: opts.recentText ?? '', imitating: !!opts.imitating, mode,
      personLabel: (jid, aud) => personLabelOf(jid, aud),
    });
  } catch {
    return [];
  }
}

/**
 * 019 (owner chose full recall): his texts of the last 24 h with the people in his world, for
 * this turn's audience — [] or [one fenced block ≤ 480 chars]. opts: { imitating }. Nothing
 * while life, the `arcs` skill or the phone are off, while imitating, under an embargo, over
 * the self-mention budget or during a heavy stretch. Fails closed.
 */
export function phoneLines(audience, opts = {}) {
  if (!rt || opts.imitating) return [];
  try {
    const at = now();
    return story.phoneMemory(rt.state, audience, { at, imitating: !!opts.imitating, mode: lineModeOf(rt.state, at, audience?.chatJid ?? null) });
  } catch {
    return [];
  }
}

/** Urge 0–100 for the owner (Life · Now). null while life is off. Absent from the public site. */
export function urgeNow() {
  if (!rt) return null;
  try { return story.urgeOf(rt.state, now()); } catch { return null; }
}

/** 0–1 for the decision engine. 0 while life is off or the read fails. */
export function urgeFactor() {
  const u = urgeNow();
  return typeof u === 'number' && Number.isFinite(u) ? Math.max(0, Math.min(1, u / 100)) : 0;
}

/** One life-tail line when urge is high. Empty while imitating, under an embargo, or over the self-mention budget. */
// 020 B: may his own life be spoken of in this chat now? (Not during an embargo, or over its self-mention budget.)
export function lineOpen(audience) {
  if (!rt) return false;
  try {
    const mode = lineModeOf(rt.state, now(), audience?.chatJid ?? null);
    return !mode || mode === 'full';
  } catch { return false; }
}

// 020 G: one line about this morning's dream, or ''. In a DM, the first turn or two, until he's mentioned it.
export function dreamLine(audience, recentText = []) {
  if (!rt) return '';
  try {
    const at = now();
    const mode = lineModeOf(rt.state, at, audience?.chatJid ?? null);
    if (mode && mode !== 'full') return '';
    return story.dreamLine(rt.state, at, { audience, recentText });
  } catch { return ''; }
}

export function urgeLine(audience) {
  if (!rt) return '';
  try {
    const at = now();
    const mode = lineModeOf(rt.state, at, audience?.chatJid ?? null);
    if (mode && mode !== 'full') return '';
    const u = story.urgeOf(rt.state, at);
    return typeof u === 'number' && u >= 55 ? "you're wound up tonight" : '';
  } catch { return ''; }
}

/** 019: the public exporter's text reader → Map(phone.message id → text). */
export function publicPhone(eventIds) {
  return story.publicPhone(eventIds);
}

/** 019: his conversations / one thread (operator view) — story.phoneThreads / phoneThread. */
export function phoneThreads() {
  return story.phoneThreads();
}

export function phoneThread(castId, opts = {}) {
  return story.phoneThread(castId, opts);
}

/** 016: the public exporter's scene text reader (full, live, fictional-cast scenes only). */
export function publicScenes(sceneEventIds) {
  return story.publicScenes(sceneEventIds);
}

/** 016: one scene for the dashboard (operator view) — story.sceneDetail. */
export function sceneDetail(id) {
  return story.sceneDetail(id);
}

// chatJid is part of the C1 shape; the note itself only needs the catch-up.
export function catchUpNote(chatJid, catchUp) {
  return catchUpOf(catchUp);
}

/** One line for the call prompt about how he is as the phone rings. */
export function callStateNote(personJid) {
  if (!rt) return '';
  return callNoteOf(viewNow(), now(), { kind: 'call', chatJid: personJid }, { world: rt.world });
}

/**
 * Quality-gate note while a heavy-event embargo holds, or (010, research R17)
 * for the whole active heavy arc, else null.
 */
export function lifeGuardNote() {
  if (!rt) return null;
  const t = now();
  return guardNoteOf(rt.state.embargo, t) ?? (story.heavyGuardActive(rt.state, t) ? GUARD_NOTE : null);
}

// ── Hooks (fire-and-forget; never throw into the pipeline) ────────────────

/**
 * Who may nudge his decisions (plan §R8 chat_mention): this is the audience
 * check decisions.noteChat relies on. Refused: his own messages, muted groups,
 * DMs from someone who shares no group with him (group_members), and a group
 * sender who isn't on its member list (when it has one). Fails closed.
 */
function chatMayNudge(r, msg, chatJid, originKind) {
  if (msg?.isFromSelf === true || msg?.fromMe === true || msg?.key?.fromMe === true) return false;
  const sender = typeof msg?.senderJid === 'string' && msg.senderJid !== 'unknown' ? msg.senderJid : null;
  try {
    if (originKind === 'group') {
      if ((r.opts.isGroupMuted ?? dashboardIsGroupMuted)(chatJid)) return false;
      if (sender && !(r.opts.isMember ?? defaultIsMember)(chatJid, sender)) return false;
      return true;
    }
    const person = sender ?? chatJid;
    if (typeof r.opts.isKnownPerson === 'function') return !!r.opts.isKnownPerson(person);
    return !!getDb().prepare('SELECT 1 FROM group_members WHERE person_jid = ? LIMIT 1').get(person);
  } catch {
    return false;
  }
}

/**
 * An incoming message may touch a live decision (chat_mention trigger). Only
 * the code matcher sees the text; at most an inert chat.trigger and a lean
 * (both with the chat's origin) are written. Preconditions the caller keeps:
 * call it after the pipeline's own mute/blacklist checks, for messages it would
 * process. The facade refuses fromMe, muted groups, unknown DM senders and
 * non-members on its own (chatMayNudge), so a missed check costs nothing.
 * During a heavy-event embargo chat still informs decisions (the embargo is
 * about tone, not plans).
 */
export function perceiveChat(msg, audience, ctx = {}) {
  if (!isLifeOn()) return Promise.resolve(null);
  // 012: the chat-influence perception. The live pipeline passes influence:false
  // here and calls perceiveInfluence once the availability gate has its verdict
  // (no Jev call on a turn he won't read); without it the perception starts now.
  if (ctx?.influence !== false) perceiveInfluence(msg, audience, ctx, ctx?.gateVerdict);
  if (!rt.state.decisions?.size) return Promise.resolve(null);
  const chatJid = audience?.chatJid ?? msg?.groupJid;
  const originKind = originOfChat(chatJid);
  const text = typeof msg?.content === 'string' ? msg.content : msg?.text;
  if (!originKind || typeof text !== 'string' || !text.trim()) return Promise.resolve(null);
  const r = rt;
  if (!chatMayNudge(r, msg, chatJid, originKind)) return Promise.resolve(null);
  return noteChat(() => r.state, { text, originKind, originJid: chatJid, msgId: msg?.id }, { world: story.worldOf(r.state, r.world), at: now(), append: r.append })
    .catch((err) => {
      logger.warn({ err: err?.message, chatJid }, 'life: perceiveChat failed');
      return null;
    });
}

/**
 * 012: the chat-influence perception of one incoming message (its own
 * preconditions, caps and Jev call; nothing lands until gateOutcome). `verdict`:
 * the availability gate's verdict for this turn, known before the call — only
 * now/sneak/defer may spend a Jev call (ignore/react/error → counted as
 * nothing:gate_<verdict>, no call); undefined → perceived regardless. Never
 * throws; off → not even a lookup.
 */
export function perceiveInfluence(msg, audience, ctx = {}, verdict = undefined) {
  try {
    if (!rt || !isLifeOn() || !influence.influenceOn('any')) return;
    const cj = audience?.chatJid ?? msg?.groupJid;
    const ok = originOfChat(cj);
    // A DM may arrive on any of the person's forms; group_members holds the canonical one.
    const who = ok === 'dm' ? { ...msg, senderJid: influence.chatKeyOf(msg?.senderJid ?? cj) ?? msg?.senderJid } : msg;
    if (ok && chatMayNudge(rt, who, cj, ok)) {
      influence.perceive(msg, audience, { ...ctx, ...(verdict !== undefined ? { gateVerdict: verdict } : {}) });
    }
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'perceiveInfluence', err: err?.code || err?.name || 'error' }, 'life: chat perception failed');
  }
}

/**
 * 012: the availability gate's verdict for a live turn (processTurn, right
 * after the gate): now/sneak lets what he perceived in the message land, defer
 * holds it until he reads it, anything else drops it. No-op while off.
 */
export function gateOutcome(chatJid, msgId, verdict) {
  if (!rt) return;
  influence.gateOutcome(chatJid, msgId, verdict);
}

/**
 * After a reply was sent: the claim prefilter + Jev flag (claims.js; also the
 * self-mention counter). A flagged claim leaves an inert `claim.flagged`
 * pointer with the chat's origin; nothing in his life changes (010 adopts).
 */
export function onReplySent({ chatJid, text, triggerText = '', msgId = null, triggerMsgId = null, imitating = false,
  followUp = false, dryRun = false } = {}) {
  if (!isLifeOn()) return Promise.resolve(null);
  // 012: a follow-up turn's reply ("coming after all, see you at 8") is not a new claim.
  if (followUp === true) return Promise.resolve(null);
  // An imitated reply is another member's voice, not his life; a DRY_RUN reply
  // reached nobody — neither becomes a claim (Jev call, row, self-mention budget,
  // the permanent claim.flagged pointer).
  if (imitating === true || dryRun === true) return Promise.resolve(null);
  const r = rt;
  const names = [
    ...[...(r.state.cast?.values?.() || [])].map(c => c.name),
    ...[...(r.state.places?.values?.() || [])].map(p => p.name),
  ].filter(Boolean);
  // 012: an invitation from this chat waiting for his word rides along as one
  // more question of the same Jev call (a reply really sent as him: see above).
  const awaiting = influence.influenceOn('invites') && msgId
    ? influence.awaitingAnswer(chatJid, { triggerMsgId, at: now(), text }).catch(() => null)
    : Promise.resolve(null);
  return awaiting
    .then(inv => flagReply({ chatJid, text, triggerText, msgId, names, ...(inv ? { extraQuestion: inv.extraQuestion } : {}) })
      .then(res => ({ res, inv })))
    .then(({ res, inv }) => {
      if (res?.answer && inv && rt === r) {
        influence.onAnswer(inv, res.answer);
        return res;
      }
      const originKind = originOfChat(chatJid);
      if (res?.flagged && originKind && rt === r) {
        const ev = r.append({
          type: 'claim.flagged', at: now(), actor: 'chat', originKind, originJid: chatJid,
          payload: { claimId: res.flagged.id, kind: res.flagged.kind },
        });
        // 010: queue it for the reconciler (no-op while `arcs` is off; never throws).
        story.onClaimFlagged({ claim: res.flagged, eventId: ev.id });
      }
      return res;
    })
    .catch((err) => {
      logger.warn({ err: err?.message, chatJid }, 'life: onReplySent failed');
      return null;
    });
}

// ── Schedule readers (IG scheduler, R16) ──────────────────────────────────

export function isAwakeAt(unix) {
  return rt ? awakeAt(rt.state, unix, rt.world) : true;
}

export function freeWindows(dayStartUnix) {
  return rt ? windowsOf(rt.state, dayStartUnix, rt.world) : [];
}

// ── Mind readers (spec 008 research R26; additive, read-only) ─────────────
// The mind feature-detects these and checks isLifeOn() itself. Each answers from a
// view at now() and never throws; an error fails closed (not available, embargoed,
// over budget), since every answer only ever holds the mind back.

/** His availability state now ('free'|'light'|'busy'|'meeting'|'dnd'|'asleep'), or null when not started. */
export function availabilityNow() {
  if (!rt) return null;
  try { return availabilityAt(viewNow(), now(), rt.world).state ?? null; } catch { return null; }
}

/**
 * Is he looking at his phone right now (inside a phone check)? Uses availability's
 * `onPhone`, which is inPhoneCheck() bounded by its grace and false while asleep:
 * a night check only reads, so the mind must not treat it as a moment to text.
 */
export function inPhoneCheckNow() {
  if (!rt) return false;
  try { return availabilityAt(viewNow(), now(), rt.world).onPhone === true; } catch { return false; }
}

// ── a changing mind (plan 020 B): what the mind reads for his stances ─────────────────
// Read-only. Topics are namespaced keys; the catalogue holds fictional names and codes only.

const STANCE_FIXED = Object.freeze([['fixed:work', 'work'], ['fixed:city', 'the city'], ['fixed:food', 'food'], ['fixed:money', 'money'], ['fixed:weather', 'the weather'], ['fixed:people', 'people']]);
const STANCE_CHORE_KINDS = new Set(['groceries', 'errand']);
const STANCE_CHORE_PLACE_KINDS = new Set(['shop', 'grocery', 'groceries', 'supermarket']);
const STANCE_TYPES = Object.freeze(['scene.played', 'activity.ended', 'money.spent', 'work.late', 'work.crunch', 'career.appraisal',
  'commute.soaked', 'money.salary', 'meal', 'chat.perceived', 'invite.answered', 'decision.committed', 'decision.reversed']);
const stanceWords = (kind) => String(kind).replace(/[-_]+/g, ' ');

/** What he can have a view on. null while life is off. */
export function stanceCatalogue() {
  const r = rt;
  if (!r) return null;
  const s = r.state;
  const world = story.worldOf(s, r.world) ?? r.world;
  // Where he lives and where he works aren't things he goes to for their own sake.
  // Nor is any home (a former one, a relative's, a pending move: publicView.homeIdsOf), or somewhere he only goes for errands.
  const homes = new Set([world?.self?.homePlaceId, s.self?.officePlaceId, world?.self?.job?.officePlaceId, s.story?.career?.officePlaceId, ...homeIdsOf(s),
    ...(s.places instanceof Map ? [...s.places.values()].filter(p => p?.kind === 'office' || STANCE_CHORE_PLACE_KINDS.has(p?.kind)).map(p => p.id) : [])].filter(Boolean));
  const kinds = new Map();
  for (const l of world?.routine?.leisure ?? []) {
    if (typeof l?.kind === 'string' && !STANCE_CHORE_KINDS.has(l.kind)) kinds.set(`kind:${l.kind}`, stanceWords(l.kind));
  }
  const places = new Map();
  const seen = s.places instanceof Map ? [...s.places.values()] : Array.isArray(world?.places) ? world.places : [];
  for (const p of seen) if (p?.id && !homes.has(p.id)) places.set(p.id, placeLabelOf(s, p.id, { negative: true }) ?? stanceWords(p.kind ?? 'somewhere'));
  const cast = new Map();
  for (const c of s.cast instanceof Map ? s.cast.values() : []) if (c?.id && c.name) cast.set(c.id, liveFirstName(c.name));
  // Everyone in his world, those who've left too: a topic never names one.
  const departed = Object.values(s.story?.departed ?? {}).map(d => d?.name).filter(n => typeof n === 'string').map(liveFirstName);
  return { kinds, places, cast, fixed: new Map(STANCE_FIXED), homes, departed };
}

/** A topic's words now: a renamed place reads under its new name, a venue under its kind word if `negative`. */
export function stanceLabel(topic, { negative = false } = {}) {
  const r = rt;
  if (!r || typeof topic !== 'string') return null;
  if (topic.startsWith('place:')) return placeLabelOf(r.state, topic, { negative }) ?? null;
  if (topic.startsWith('cast:')) { const c = r.state.cast?.get?.(topic); return c?.name ? liveFirstName(c.name) : null; }
  if (topic.startsWith('kind:')) return stanceWords(topic.slice(5));
  return STANCE_FIXED.find(([k]) => k === topic)?.[1] ?? null;
}

/** A code when owner or model text names a real person or carries a JID or a number. */
export function stanceTextProblem(text) {
  return story.stanceTextProblem(text);
}

/** What he came across in his own days (plan 020 B, free topics): never a chat. */
export function stanceEncounters(q) {
  return story.stanceEncounters(q);
}

/** Changes whenever an event leaves the live log (a revert, a rewind). */
export function stanceExclusionSig() {
  const s = rt?.state;
  return s ? `${s.excluded?.size ?? 0}:${s.excludedRanges?.length ?? 0}` : null;
}

export function stanceIsExcluded(id) {
  return rt ? isExcludedId(rt.state, id) : false;
}

export function stanceLastEventId() {
  return rt?.state?.lastEventId ?? null;
}

/**
 * Live events after `afterId` for the night's update, with what the rules need to read them.
 * Reads at most `lookbackSec` back. Not from a heavy stretch: no learning from those.
 * → { events, lastId, ctx } | null while life is off.
 */
export function stanceLived({ afterId = 0, lookbackSec = 14 * 86400 } = {}) {
  const r = rt;
  if (!r) return null;
  const s = r.state;
  const at = now();
  const lastId = s.lastEventId ?? afterId;
  const from = at - lookbackSec;
  const heavySpans = [];
  for (const e of eventsBetween(from - 120 * 86400, at, ['heavy.started', 'heavy.ended'])) {
    if (isExcludedId(s, e.id)) continue;
    if (e.type === 'heavy.started') heavySpans.push({ id: e.id, from: e.at, to: Number.isFinite(e.payload?.until) ? e.payload.until : e.at + 7 * 86400 });
    else { const h = heavySpans.find(x => x.id === e.payload?.heavyId); if (h) h.to = Math.min(h.to, e.at); }
  }
  const events = eventsBetween(from, at, STANCE_TYPES).filter(e => e.id > afterId && !e.redacted && !isExcludedId(s, e.id)).sort((a, b) => a.id - b.id);
  const startOf = (id) => {
    if (!Number.isSafeInteger(id)) return null;
    try { const e = getEvent(id); return e && !e.redacted && !isExcludedId(s, id) ? e : null; } catch { return null; }
  };
  const world = story.worldOf(s, r.world) ?? r.world;
  const cat = stanceCatalogue();
  const ctx = {
    homeIds: cat.homes,
    activeCast: new Set(s.cast instanceof Map ? s.cast.keys() : []),
    heavyAt: (t) => heavySpans.some(h => t >= h.from && t < h.to) || embargoIsActive(s.embargo, t),
    isHeavyChain: (e) => { try { return causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { return true; } },
    startOf,
    // The chat's own time: the earliest event of that origin up its cause chain (spec 010's audience rule). A read failure → 0, which fails closed.
    originAt: (e, origin) => {
      try {
        const same = causeChain(e.id).filter(x => x?.originJid === origin.jid && Number.isFinite(x.at)).map(x => x.at);
        return same.length ? Math.min(e.at, ...same) : e.at;
      } catch { return 0; }
    },
    decisionOf: (id) => { const d = startOf(id); return d?.type === 'decision.opened' ? d : null; },
    energyAt: (t) => {
      try { const series = vitalsSeries({ from: t - 1800, to: t, stepSec: 900, world }) || []; const v = series.at(-1)?.vitals; return Number.isFinite(v?.energy) ? v.energy : null; } catch { return null; }
    },
  };
  return { events, lastId, ctx };
}

/** True while a heavy-event embargo holds (lifeGuardNote() !== null is the same fact). */
export function embargoActive() {
  if (!rt) return false;
  try { return embargoIsActive(rt.state.embargo, now()); } catch { return true; }
}

/**
 * Over the chat's 24 h self-mention budget (claims.js)? The counter only moves
 * through onReplySent, i.e. while life is on; with life off this is always false.
 */
export function overSelfMentionBudget(chatJid) {
  try { return overMentionBudget(chatJid, now()) === true; } catch { return true; }
}

// ── Owner operations (dashboard; each appends an owner event) ─────────────

function requireRt() {
  if (!rt) throw new Error('life is not running');
  return rt;
}

/**
 * Event types the owner can undo in 009. The pulse derives what is due from
 * the projection, so undoing structural scaffolding — the day's plan, waking,
 * sleep, trips, weather, phone checks, places/cast — would only be re-derived
 * on the next tick (or leave him with no plan to follow); those are refused
 * and wait for 010's reconciler. Of the allowed ones, those the pulse would
 * re-derive (an activity, work.late, an evening invitation, an outing's plan
 * amendment) are remembered as undone (projector.exclusionSig). A committed
 * decision is not revertible on its own: it would be re-sampled at its
 * deadline — revert the invitation (decision.opened) or a lean instead.
 */
export const REVERTIBLE_TYPES = new Set([
  'activity.started', 'meal', 'money.spent', 'money.salary', 'work.late', 'work.crunch',
  'sick.started', 'birthday', 'decision.opened', 'decision.lean', 'decision.reversed',
  'chat.trigger', 'claim.flagged', 'call.answered', 'alert.raised', 'embargo.started',
  // 010 (story-api §3.7): story consequences and records; a withdrawal reverts
  // claim.adopted. Never story.daily_done, heavy.lapsed or heavy.vetoed.
  'cast.beat', 'cast.history_added', 'relationship.changed', 'cast.updated', 'activity.recorded',
  'commitment.recorded', 'family.call', 'vitals.nudged', 'heavy.proposed', 'claim.adopted',
  // 012: chat influence — a blip, its pointer, a sleep push, a work flag (a
  // reverted push / flag stays undone for that night / day: exclusionSig).
  'chat.perceived', 'mood.chat', 'sleep.delayed', 'work.behind', 'invite.answered', 'chat.load',
  // 011: an owner weather window (only before it starts — a started one is
  // undone with END, review R20) and a goal (its fit, outing and done cascade).
  // commute.soaked stays structural (R30: it moved a trip's arrival).
  'weather.window_set', 'goal.set',
  // 014 geo (R23): a place switch / a created place, with the in-use / referenced rules below.
  'place.updated', 'place.created',
  // 015 Director as god (plan §P1.7): an outcome, a money change and a departure /
  // return any time; a scheduled career / home / mood / sick change only while it
  // is still pending (undoing one he already lived would re-plan past days).
  'outcome.set', 'money.adjusted', 'vitals.planned', 'sick.planned', 'career.set', 'self.moved',
  'cast.departed', 'cast.returned',
  // 016 scene play-outs (plan §P1.10): a scene (its effects cascade), a follow-up intent, a tone hint.
  'scene.played', 'scene.followup', 'scene.tone_set',
  // Wake him ("can't sleep"): until his morning (the night wake and its re-plan cascade).
  'wake.set',
  // 019: a text (the replies it led to cascade) and the owner's request (with the text it made).
  'phone.message', 'phone.text_set',
]);
// 014 sched: an owner schedule override, only before it takes effect (§A5.7) — after that, CLEAR it.
REVERTIBLE_TYPES.add('schedule.override_set');

/** 014 sched: may this override still be reverted (nothing it changed has happened yet)? */
export function scheduleRevertible(id, state = rt?.state, at = now()) {
  const o = state?.scheduleOverrides?.[id];
  if (!o) return false;
  const from = overrideFirstFrom(o);
  if (o.background?.wholeDay === true) {
    const p = state?.plan;
    if (p?.date === o.date && Number.isFinite(p.wakeAt) && p.wakeAt <= at && Array.isArray(p.overrides) && p.overrides.includes(id)) return false;
  }
  if (Number.isFinite(from) && from <= at) return false;
  const early = (state?.plan?.blocks || []).filter(b => b.fromOverride && b.overrideId === id).map(b => b.start);
  return !(early.length && Math.min(...early) <= at);
}

const PENDING_ONLY = new Set(['career.set', 'self.moved', 'vitals.planned', 'sick.planned']);
const ACTIVE_CAST_MAX = 24;

/**
 * May the owner revert this event now? REVERTIBLE_TYPES is only the type list;
 * the state/time rules below decide (dashboard REVERT buttons + revertEvent).
 */
export function isRevertible(ev) {
  return !!ev && ev.redacted !== true && revertible(ev);
}

function revertible(ev) {
  // 014 sched (§A5.7): only before it takes effect.
  if (ev.type === 'schedule.override_set') return scheduleRevertible(ev.id);
  // 011 (R20): reverting a started window would back-date the weather.
  if (ev.type === 'weather.window_set') return Number.isSafeInteger(ev.payload?.from) && ev.payload.from > now();
  // 011: likewise a goal whose outing / call has begun or is done (the cascade would
  // take trips and activities he already had out of his day) — cancel it instead.
  if (ev.type === 'goal.set') {
    const g = rt?.state?.goals?.[ev.id];
    if (!g) return true;
    if (g.status === 'done') return false;
    const d = Number.isSafeInteger(g.fitted?.decisionId) ? rt.state.decisions?.get?.(g.fitted.decisionId) : null;
    const startedAt = Number.isFinite(d?.ponrAt) ? d.ponrAt : g.fitted?.slotStart;
    return !(g.status === 'fitted' && Number.isFinite(startedAt) && startedAt <= now());
  }
  // 014 geo (§A3.3, R23).
  if (ev.type === 'place.updated') return !placeInUse(ev.payload?.placeId);
  if (ev.type === 'place.created') return !placeReferenced(ev.payload?.id);
  // 015: a scheduled change only while pending; a departure not while the active cast is full.
  if (PENDING_ONLY.has(ev.type)) return !!rt?.state?.story?.pending?.[ev.id];
  // Wake him: before it fires, or a night wake until his morning wake (the cascade
  // takes the early woke, the night's re-plan and what he did up; he is asleep again
  // from his first sleep). An early start is his morning: only before it fires.
  if (ev.type === 'wake.set') {
    const w = (Array.isArray(rt?.state?.wakeSets) ? rt.state.wakeSets : []).find(x => x?.id === ev.id);
    if (!w) return false;
    if (!Number.isFinite(w.wokeAt)) return true;
    if (w.reason === 'early_start') return false;
    const morning = rt.state.sleep?.lastWokeAt;
    return !(Number.isFinite(morning) && morning >= w.wokeAt);
  }
  if (ev.type === 'cast.departed') return (rt?.state?.cast?.size ?? 0) < Math.min(ACTIVE_CAST_MAX, config.arcs?.castMax ?? ACTIVE_CAST_MAX);
  // 016: not once a follow-up it caused is under way, nor once its romance onset moved on.
  if (ev.type === 'scene.played') return sceneRevertProblem(ev) === null;
  if (ev.type === 'scene.followup') return followupRevertProblem(ev.id) === null;
  if (REVERTIBLE_TYPES.has(ev.type)) return true;
  // An outing's rewrite of the day (decision-caused), not the morning plan.
  return ev.type === 'plan.made' && Number.isSafeInteger(ev.payload?.amendedFor);
}

// 016 (plan §P1.10): a follow-up whose decision passed its point of no return (or
// whose outing started) is lived — reverting it would take that outing out of his day.
function followupRevertProblem(followupId) {
  const f = rt?.state?.story?.followups?.[followupId];
  if (!f || !Number.isSafeInteger(f.decisionId)) return null;
  const d = rt.state.decisions?.get?.(f.decisionId);
  const t = now();
  if (d && ((Number.isFinite(d.ponrAt) && d.ponrAt <= t) || (Number.isFinite(d.subject?.eventAt) && d.subject.eventAt <= t))) return 'followup_happened';
  return null;
}

/**
 * Why the owner may not revert this scene.played now, or null. Never refused (D15): its
 * follow-up and romance onset are uncaused companions — after the revert the unlived ones
 * are undone and the lived ones kept (story.onOwnerReverted → settleCompanions).
 */
export function sceneRevertProblem(ev) {
  void ev;
  return null;
}

// 014 geo (§A3.3): in use = he is at it or travelling to/from it, or it is an
// endpoint / place of a block in the rest of today's plan.
function placeInUse(id) {
  const s = rt?.state;
  if (!s || typeof id !== 'string') return true;
  const pos = s.position;
  if (pos?.placeId === id || pos?.travel?.from === id || pos?.travel?.to === id) return true;
  const at = now();
  return (Array.isArray(s.plan?.blocks) ? s.plan.blocks : []).some(b => b?.end > at && (b.placeId === id || b.from === id || b.to === id));
}

// Referenced = in use, or his home / office, a cast home, an open goal, an
// open or committed decision there, a schedule override naming it (sched).
function placeReferenced(id) {
  const s = rt?.state;
  if (!s || typeof id !== 'string') return true;
  if (placeInUse(id)) return true;
  if (id === s.self?.homePlaceId || id === s.self?.officePlaceId || id === s.story?.career?.officePlaceId) return true;
  for (const c of s.cast instanceof Map ? s.cast.values() : []) if (c?.home === id) return true;
  for (const d of s.decisions instanceof Map ? s.decisions.values() : []) {
    if ((d?.status === 'open' || d?.status === 'committed') && d.subject?.placeId === id) return true;
  }
  for (const g of Object.values(s.goals && typeof s.goals === 'object' ? s.goals : {})) {
    if ((g?.status === 'open' || g?.status === 'fitted') && g.placeId === id) return true;
  }
  const ov = s.scheduleOverrides && typeof s.scheduleOverrides === 'object' ? Object.values(s.scheduleOverrides) : [];
  if (ov.some(o => o?.status === 'active' && JSON.stringify(o).includes(`"${id}"`))) return true;
  return false;
}

/** Undo an event (and its engine/jev consequences); the projection is rebuilt. */
export function revertEvent(id, { reason = '', by = 'owner' } = {}) {
  const r = requireRt();
  const target = getEvent(Number(id));
  if (target && !revertible(target)) {
    throw new Error(`life: ${target.type} cannot be reverted in 009 (the pulse would re-derive it)`);
  }
  const res = logRevert(Number(id), { reason, by, at: now() });
  r.state = rebuild({ world: r.world });
  if (target && !res.already) afterOwnerRevert([target], null, by);
  return { revertEventId: res.revertEventId, already: !!res.already };
}

// ── 015 REVERT THIS CHANGE (owner decision 6) ───────────────────────────────
// One Director change = one `director.action` and the owner events under it (its
// direct children and their owner descendants — an outing's commit hangs off its
// decision), plus the engine roots it lists (a tray adoption's claim.adopted).
// Reverting it reverts each owner part (each cascades its engine consequences)
// in one transaction, then one rebuild. Refused as a whole when a part is past
// its revert window or can't be undone; previewed first (the same list + a
// fingerprint), audited by the route.

// An owner part that needs no revert of its own: a commit / reversal on a
// decision this change opened goes with that decision.
const RIDES_ALONG = new Set(['decision.committed', 'decision.reversed', 'decision.lean']);
// Created in this change and named by nothing outside it → revertible here only.
const CREATED_TYPES = new Set(['place.created', 'cast.created']);
// Owner parts that only undo as part of their whole change (on their own they stay
// structural): a storyline the change started / stepped / ended, a recovery, an
// owner cancel, a free evening, the controls it set.
const CHANGE_REVERTIBLE = new Set(['arc.started', 'arc.stage', 'arc.ended', 'sick.ended', 'decision.expired', 'plan.made',
  'place.updated', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
  'director.paused', 'director.resumed', 'director.seed_set', 'director.reconciler_mode']);

function changeParts(actionId) {
  const action = getEvent(Number(actionId));
  if (!action || action.type !== 'director.action' || action.actor !== 'owner') return null;
  const owned = [];
  const seen = new Set([action.id]);
  const queue = [action.id];
  while (queue.length && owned.length < 200) {
    const id = queue.shift();
    for (const ev of childEvents(id)) {
      // Engine consequences cascade on their own; an approved weekly proposal's parts are 'mind' events.
      if (seen.has(ev.id) || (ev.actor !== 'owner' && ev.actor !== 'mind')) continue;
      seen.add(ev.id);
      owned.push(ev);
      queue.push(ev.id);
    }
  }
  // A tray adoption / a claim scene: engine events caused by the claim pointer, listed by id.
  const listed = Array.isArray(action.payload?.eventIds) ? action.payload.eventIds.filter(Number.isSafeInteger) : [];
  for (const id of listed) {
    if (seen.has(id)) continue;
    const ev = getEvent(id);
    if (ev && !listed.includes(ev.causeId)) { seen.add(id); owned.push(ev); }
  }
  return { action, parts: owned.sort((a, b) => a.id - b.id), ids: seen };
}

/**
 * What REVERT THIS CHANGE would undo for the change `actionEventId`.
 * → { actionEventId, kind, targets:[{id, type}], riding:[{id, type}], refusals:[{id, type, reason}], fingerprint, already }
 * 017 `group:true`: the whole apply the change was part of (a Tell-the-story
 * bundle: every sibling `director.action`, eventLog.directorGroup) — the same
 * lists over all parts, `actionEventIds`, `parts:[{actionEventId, kind,
 * description, targets, refusals}]`, `group:true`; refused as a whole like one change.
 */
export function revertChangePreview(actionEventId, { group = false } = {}) {
  const r = requireRt();
  const found = changeParts(actionEventId);
  if (!found) throw Object.assign(new Error('life: not a Director change'), { code: 'not_found' });
  if (!group) {
    const one = previewOfChange(r, found);
    // Outside the fingerprint: a warning, never part of what the revert does.
    return { ...one, fingerprint: fingerprintOf([one]), already: !one.targets.length && !one.refusals.length,
      continuity: { warnings: livedOutingWarnings(r, one) } };
  }
  const siblings = directorGroup(found.action);
  const list = (siblings.length ? siblings : [found.action]).map(a => (a.id === found.action.id ? found : changeParts(a.id))).filter(Boolean);
  const each = list.map(f => previewOfChange(r, f));
  const targets = each.flatMap(x => x.targets);
  const refusals = each.flatMap(x => x.refusals);
  return {
    actionEventId: each[0].actionEventId, actionEventIds: each.map(x => x.actionEventId), group: true,
    kind: each.length === 1 ? each[0].kind : 'bundle',
    description: each.map(x => x.description).filter(Boolean).join(' · ').slice(0, 720) || null,
    parts: each.map(x => ({ actionEventId: x.actionEventId, kind: x.kind, description: x.description, targets: x.targets, refusals: x.refusals })),
    targets, riding: each.flatMap(x => x.riding), refusals,
    fingerprint: fingerprintOf(each), already: !targets.length && !refusals.length,
  };
}

// A lived outing of this change whose place later trips (of other plans) set off from.
function livedOutingWarnings(r, one) {
  try {
    const t = now();
    const own = new Set();
    for (const x of one.targets) for (const id of cascadeIds(x.id)) own.add(id);
    const outings = [];
    for (const id of own) {
      const e = getEvent(id);
      if (e?.type === 'activity.started' && typeof e.payload?.placeId === 'string' && e.at <= t && !isExcludedId(r.state, e.id)) {
        outings.push({ placeId: e.payload.placeId, at: e.at });
      }
    }
    if (!outings.length) return [];
    const from = Math.min(...outings.map(o => o.at));
    const live = (e) => !own.has(e.id) && !e.redacted && !isExcludedId(r.state, e.id);
    const trips = logListEvents({ types: ['travel.started'], from, limit: 500 }).filter(live)
      .map(e => ({ id: e.id, from: e.payload?.from ?? null, at: e.at }));
    // His own returns there, on other plans: a trip after one sets off from where he really was.
    const places = new Set(outings.map(o => o.placeId));
    const returns = logListEvents({ types: ['travel.arrived', 'activity.started'], from, limit: 1000 }).filter(live)
      .map(e => ({ placeId: e.type === 'travel.arrived' ? e.payload?.to : e.payload?.placeId, at: e.at }))
      .filter(x => places.has(x.placeId));
    return story.revertTripsWarnings({ outings, trips, returns, placeWord: (id) => r.state.places?.get?.(id)?.name ?? 'there' });
  } catch { return []; }
}

// One change's lists (no fingerprint).
function previewOfChange(r, found) {
  const { action, parts, ids } = found;
  const excluded = r.state?.excluded instanceof Set ? r.state.excluded : new Set();
  const targets = [];
  const riding = [];
  const refusals = [];
  const opened = new Set(parts.filter(e => e.type === 'decision.opened').map(e => e.id));
  // 014 geo: a venue this change created (a picked real venue) comes with its routes; they
  // go with the place (a route is used only while both endpoints are where it was recorded).
  const createdPlaces = new Set(parts.filter(e => e.type === 'place.created').map(e => e.payload?.id).filter(Boolean));
  for (const ev of parts) {
    if (excluded.has(ev.id) || isExcludedId(r.state, ev.id)) continue;   // already undone
    if (RIDES_ALONG.has(ev.type) && opened.has(Number(ev.payload?.decisionId ?? ev.causeId))) { riding.push({ id: ev.id, type: ev.type }); continue; }
    if (ev.type === 'route.recorded' && (createdPlaces.has(ev.payload?.a) || createdPlaces.has(ev.payload?.b))) { riding.push({ id: ev.id, type: ev.type }); continue; }
    // wake-fix (Bug A): CANCEL TONIGHT's undo of the outing's plan rewrite can't be
    // reverted itself (a revert is final); it goes with the cancel — once the
    // decision.expired is reverted the outing is committed again and the pulse
    // fits / amends it afresh (projector.liftRestored drops its signature).
    if (ev.type === 'event.reverted' && parts.some(x => x.type === 'decision.expired' && x.actor === 'owner'
        && Number(x.payload?.decisionId) > 0)) { riding.push({ id: ev.id, type: ev.type }); continue; }
    if (CREATED_TYPES.has(ev.type)) {
      const token = ev.payload?.id;
      const outside = eventsNaming(token, ev.id).filter(x => !ids.has(x) && x !== ev.id);
      // Engine events of this change name it too (its trips, blocks): those cascade with the parts.
      const foreign = outside.filter((x) => {
        try { const e = getEvent(x); return !(e && e.causeId && ids.has(e.causeId)); } catch { return true; }
      });
      if (foreign.length) refusals.push({ id: ev.id, type: ev.type, reason: 'in_use' });
      else targets.push({ id: ev.id, type: ev.type });
      continue;
    }
    // An owner pick on an existing decision: undoable while nothing came of it yet.
    if (ev.type === 'decision.committed' && ev.payload?.by === 'owner') {
      const d = r.state?.decisions?.get?.(Number(ev.payload?.decisionId));
      const fresh = d && d.status === 'committed' && d.committed?.eventId === ev.id && !(Number.isFinite(d.ponrAt) && d.ponrAt <= now());
      if (fresh) targets.push({ id: ev.id, type: ev.type });
      else refusals.push({ id: ev.id, type: ev.type, reason: 'already_happened' });
      continue;
    }
    if (CHANGE_REVERTIBLE.has(ev.type) && (ev.actor === 'owner' || ev.actor === 'mind')) { targets.push({ id: ev.id, type: ev.type }); continue; }
    if (!revertible(ev)) {
      refusals.push({ id: ev.id, type: ev.type, reason: PENDING_ONLY.has(ev.type) || ev.type === 'wake.set' ? 'already_happened' : 'not_revertible' });
      continue;
    }
    targets.push({ id: ev.id, type: ev.type });
  }
  // sched-fixes: what the change did, in words (outside the fingerprint; dashboard only).
  let description = null;
  try { description = story.changeDescription(action, r.state); } catch { description = null; }
  return { actionEventId: action.id, kind: typeof action.payload?.kind === 'string' ? action.payload.kind : null, description, targets, riding, refusals };
}

// A single change keeps its pre-017 fingerprint (`a` = its id); a group hashes every part in order.
function fingerprintOf(each) {
  const body = (x) => ({ a: x.actionEventId, t: x.targets.map(t => t.id), r: x.refusals.map(y => `${y.id}:${y.reason}`) });
  return crypto.createHash('sha256').update(JSON.stringify(each.length === 1 ? body(each[0]) : { g: each.map(body) })).digest('hex');
}

// The story rows a revert leaves behind (a tray adoption's review, an approved
// proposal): DB-only, never undoes the revert.
function afterOwnerRevert(events, action, by) {
  try {
    story.onOwnerReverted({ events: events.filter(Boolean), action, by });
  } catch (e) {
    logger.warn({ evt: 'issue', where: 'life.revert', err: e?.code || e?.name }, 'life: story rows after a revert not updated');
  }
}

/**
 * REVERT THIS CHANGE: revert every owner part of one Director change in one
 * transaction (each cascades its engine consequences), then one rebuild.
 * `fingerprint` must equal the preview's (the parts changed → stale). 017
 * `group:true`: every change of that apply (UNDO ALL OF THIS), still one
 * transaction and one rebuild. → { reverted:[ids], actionEventId, actionEventIds? }
 */
export function revertChange(actionEventId, { fingerprint, reason = 'revert change', by = 'owner', group = false } = {}) {
  const r = requireRt();
  const p = revertChangePreview(actionEventId, { group });
  if (typeof fingerprint !== 'string' || fingerprint !== p.fingerprint) throw Object.assign(new Error('life: stale'), { code: 'stale' });
  if (p.refusals.length) throw Object.assign(new Error('life: part of this change cannot be reverted'), { code: 'refused', refusals: p.refusals });
  if (!p.targets.length) throw Object.assign(new Error('life: nothing to revert'), { code: 'nothing' });
  const at = now();
  const reverted = [];
  try {
    getDb().transaction(() => {
      // Newest first: a part's consequences go before the part they hang off.
      for (const t of [...p.targets].sort((a, b) => b.id - a.id)) {
        const res = logRevert(t.id, { reason, by, at });
        reverted.push(res.revertEventId);
      }
    })();
  } finally {
    r.state = rebuild({ world: r.world });
  }
  // The story rows of each change (a tray adoption, an approved proposal), per change.
  const perChange = p.group ? p.parts : [{ actionEventId: p.actionEventId, targets: p.targets }];
  for (const c of perChange) {
    if (c.targets.length) afterOwnerRevert(c.targets.map(t => getEvent(t.id)), getEvent(c.actionEventId), by);
  }
  logger.info({ evt: 'life.revert_change', actionEventId: p.actionEventId, parts: p.targets.length, ...(p.group ? { changes: p.parts.length } : {}) },
    'life: Director change reverted');
  return {
    actionEventId: p.actionEventId, reverted: p.targets.map(t => t.id), revertEventIds: reverted,
    ...(p.group ? { actionEventIds: p.actionEventIds } : {}),
  };
}

/**
 * 006 purgePerson hook: redact every world event about these jids (one person,
 * phone + LID forms) and rebuild the live projection so nothing of them stays
 * in memory (decision origins, signals). Redaction blanks the whole tainted
 * subtree — e.g. a DM-nudged outing's plan, trips and spend — so on the next
 * tick the pulse re-plans the rest of that day from his routine (a redacted
 * plan has no blocks). Works with life stopped too (log only).
 */
export function redactPerson(jids) {
  const res = logRedactPerson(jids);
  // 010: the story tables (DB-only, works with life stopped); errors propagate.
  story.onRedacted(Array.isArray(jids) ? jids : [jids]);
  if (rt) rt.state = rebuild({ world: rt.world });
  if (rt) { try { thoughtsSweepNow(rt); } catch { /* the next tick's read still drops them */ } }
  return res;
}

export function setDecisionMode(id, mode, { by = 'owner' } = {}) {
  const r = requireRt();
  setMode(r.state, Number(id), mode, { at: now(), append: r.append, by, world: story.worldOf(r.state, r.world) });
}

export function dismissClaim(id, { by = 'owner' } = {}) {
  return dismissClaimRow(Number(id), { by });
}

export async function checkPhoneNow({ by = 'owner' } = {}) {
  const r = requireRt();
  const res = await r.phone.checkNow({ by });
  // readOnly: he was asleep — he read the queue (blue ticks) and answered nothing.
  return { drained: res?.drained ?? 0, skipped: res?.skipped ?? null, readOnly: res?.readOnly === true };
}

/** Is a phone check running now? (the dashboard refuses a second one up front) */
export function isPhoneInCheck() {
  return !!rt?.phone?.isInCheck();
}

/**
 * The WhatsApp connection (re)opened: a new socket has no presence, so send
 * the one his availability calls for. No-op while life is off.
 */
export async function onConnect() {
  if (!rt || !enabledFn() || !rt.wasOn) return false;
  try { return await rt.phone.resyncPresence(); } catch { return false; }
}

/** The cause chain of an event, root first. */
export function explain(id) {
  return causeChain(Number(id));
}

export function listEvents(opts = {}) {
  return logListEvents(opts);
}

/**
 * The 009 event types (everything but the 010 story and 012 influence types):
 * 008 sleep's self-event read (010 review) — chat blips never crowd it.
 */
export function selfEventTypes() {
  // 011: owner windows and goals are steering, not his day; a soaked commute is.
  return [...LOG_EVENT_TYPES].filter(t => !LOG_STORY_TYPES.has(t) && !LOG_INFLUENCE_TYPES.has(t)
    && !(LOG_STEER_TYPES.has(t) && t !== 'commute.soaked')
    && !t.startsWith('route.')   // 014 geo: road geometry is bookkeeping, not his day
    && !LOG_SCHEDULE_TYPES.has(t));   // 014 sched: overrides are steering too
}

/**
 * 014 sched: the schedule overrides for the Director's SCHEDULE panel (ids,
 * dates, activities, times; whether REVERT is still allowed). Active first,
 * then recently cleared.
 */
export function scheduleView() {
  const s = rt?.state;
  const m = s?.scheduleOverrides && typeof s.scheduleOverrides === 'object' ? s.scheduleOverrides : {};
  const at = now();
  const list = Object.values(m).filter(o => o && typeof o === 'object')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || (overrideFirstFrom(a) ?? 0) - (overrideFirstFrom(b) ?? 0) || a.id - b.id);
  return {
    running: !!rt,
    overrides: list.slice(0, 24).map(o => ({
      id: o.id, date: o.date, op: o.op, status: o.status,
      background: o.background ? { activity: o.background.activity, from: o.background.from, to: o.background.to, ...(o.background.wholeDay ? { wholeDay: true } : {}) } : null,
      ranges: (o.ranges || []).map(r => ({ activity: r.activity, from: r.from, to: r.to, placeId: r.placeId ?? null, castIds: r.castIds ?? [] })),
      ...(o.blockKind ? { blockKind: o.blockKind } : {}), ...(o.moveTo ? { moveTo: o.moveTo } : {}),
      conflicts: (o.conflicts || []).length,
      until: overrideLastTo(o),
      revertible: o.status === 'active' && scheduleRevertible(o.id, s, at),
      ...(o.clearedAt ? { clearedAt: o.clearedAt } : {}),
    })),
    inForce: Array.isArray(s?.plan?.overrides) ? [...s.plan.overrides] : [],
  };
}

// ── 012 chat influence readers (dashboard; the Day page lane builds on these) ──

/** Life · Now's chat-influence panel: switches, caps, the overlay, live blips, tonight's push. */
export function influenceNow() {
  return influence.nowView();
}

/** Life · Pending's invitations from chats (operator view; ids, codes, code-built labels). */
export function influenceInvites(limit = 30) {
  return influence.invitesView(limit);
}

/** Advice from chats on the owner's tray (P3; operator view, the live excerpt). opts: { status, limit } */
export function influenceAdvice(opts = {}) {
  return influence.adviceView(opts);
}

/** The owner approves (→ a Director preset, nothing written) or rejects one advice row. */
export function influenceAdviceDecide(id, verdict, opts = {}) {
  return influence.adviceDecide(id, verdict, opts);
}

/** The Day page's influence lane in [from, to): [{ at, type, eventId, chatJid, kind, state }]. */
export function influenceLane({ from, to } = {}) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return [];
  const types = [...LOG_INFLUENCE_TYPES];
  return influence.laneEvents(eventsBetween(from, to, types)).filter(e => !isExcludedId(rt?.state, e.eventId));
}

/**
 * 012: the per-turn invitation line for this message (processTurn, before the
 * reply is generated; waits ≤ CHAT_INFLUENCE_INVITE_WAIT_MS from the turn's
 * start). '' while chat influence is off. opts: { startedAt, catchUp, imitating }.
 */
export function inviteNote(chatJid, msgId, audience, opts = {}) {
  if (!rt) return Promise.resolve('');
  return influence.inviteNote(chatJid, msgId, audience, opts);
}

/**
 * Events with from ≤ at ≤ to, oldest first. listEvents pages by time (at, id), so
 * the cursor is a time and ids dedupe the overlap; a run of more than a page at
 * one second is drained by id. Past `maxPages` the read stops: silently for the
 * windowed dashboard reads, with a throw when `strict` (a caller that must see
 * every row — the public view's since-genesis reads — fails closed instead).
 */
function eventsBetween(from, to, types, { maxPages = 20, strict = false } = {}) {
  const out = new Map();
  const sorted = () => [...out.values()].sort((a, b) => a.at - b.at || a.id - b.id);
  let pages = 0;
  const read = (opts) => {
    if (pages >= maxPages) {
      if (strict) {
        const err = new Error(`life: event read over ${maxPages} pages`);
        err.code = 'history_too_large';
        throw err;
      }
      return null;
    }
    pages++;
    const page = logListEvents({ ...opts, types, limit: PAGE });
    for (const ev of page) out.set(ev.id, ev);
    return page;
  };
  let cursor = from;
  for (;;) {
    const page = read({ from: cursor, to });
    if (!page || page.length < PAGE) return sorted();
    const last = page[page.length - 1].at;
    if (page[0].at !== last) { cursor = last; continue; }
    // A full page at one second: the rest of that second by id, then past it.
    for (let after = page[page.length - 1].id; ;) {
      const tie = read({ from: last, to: last, after });
      if (!tie) return sorted();
      if (tie.length < PAGE) break;
      after = tie[tie.length - 1].id;
    }
    if (last >= to) return sorted();
    cursor = last + 1;
  }
}

/** Test hook: the facade's paged event read. */
export function __eventsBetweenForTest(from, to, types, opts) {
  return eventsBetween(from, to, types, opts);
}

const ACTUAL_STARTS = new Set(['activity.started', 'travel.started', 'sleep.started']);
const ACTUAL_ENDS = new Set(['activity.ended', 'travel.arrived', 'woke', 'world.reanchored']);

/**
 * Timeline data for [from, to] (≤ 48 h; default the last 24 h): planned
 * blocks (latest plan.made per day), actual spans (activity/travel/sleep
 * events), decisions, cause links between events in the window, and the ids
 * of orphaned events. Reverted (excluded) events are left out.
 */
export function timeline({ from, to } = {}) {
  const t1 = finite(to) ? Math.floor(to) : now();
  const t0 = Math.max(finite(from) ? Math.floor(from) : t1 - 24 * 3600, t1 - TIMELINE_MAX_SEC);
  const excluded = rt?.state.excluded instanceof Set ? rt.state.excluded : new Set();
  // 010: reverts and rewind ranges (isExcludedId); with no engine, the revert set only.
  const isOut = (id) => (rt ? isExcludedId(rt.state, id) : excluded.has(id));
  const plans = eventsBetween(t0 - 36 * 3600, t1, ['plan.made']).filter(ev => !isOut(ev.id));
  const byDate = new Map();
  for (const p of plans) byDate.set(p.payload?.date ?? p.at, p);
  const planned = [];
  for (const p of byDate.values()) {
    for (const b of p.payload?.blocks || []) {
      if (b.end > t0 && b.start < t1) {
        planned.push({ kind: b.kind, placeId: b.placeId ?? null, start: b.start, end: b.end, availability: b.availability, planEventId: p.id });
      }
    }
  }
  const evs = eventsBetween(t0 - 24 * 3600, t1).filter(ev => !isOut(ev.id));
  const actual = [];
  let open = null;
  for (const ev of evs) {
    if (ACTUAL_STARTS.has(ev.type) || ACTUAL_ENDS.has(ev.type)) {
      if (open) { open.end = ev.at; if (open.end > t0) actual.push(open); }
      open = ACTUAL_STARTS.has(ev.type) ? {
        kind: ev.type === 'travel.started' ? 'commute' : ev.type === 'sleep.started' ? 'sleep' : (ev.payload?.kind ?? 'activity'),
        placeId: ev.payload?.placeId ?? null, start: ev.at, end: null, eventId: ev.id,
      } : null;
    }
  }
  if (open) { open.end = Math.max(open.start, t1); actual.push(open); }
  const inWindow = evs.filter(ev => ev.at >= t0);
  const ids = new Set(inWindow.map(ev => ev.id));
  const links = inWindow.filter(ev => ev.causeId && ids.has(ev.causeId)).map(ev => ({ from: ev.causeId, to: ev.id }));
  // Kept, but their cause was undone (plan §R1): the Timeline marks them.
  const orphaned = inWindow.filter(ev => isOrphaned(ev, excluded)).map(ev => ev.id);
  const decisions = [...(rt?.state.decisions?.values?.() || [])]
    .filter(d => (d.closedAt ?? t1) >= t0 && (d.opensAt ?? 0) <= t1)
    .map(d => ({
      id: d.id, kind: d.kind, status: d.status, opensAt: d.opensAt, decideBy: d.decideBy, ponrAt: d.ponrAt,
      closedAt: d.closedAt, lean: d.lean ? { optionId: d.lean.optionId, p: d.lean.p } : null,
      committed: d.committed ? { optionId: d.committed.optionId, at: d.committed.at } : null,
    }));
  return { from: t0, to: t1, planned, actual, decisions, links, orphaned };
}

/**
 * Map data: places, his position now, and trips of the last 48 h. A trip's endAt
 * is the planned arrival (departure + the trip's minutes); arrivedAt is the actual
 * one from the log — the travel.arrived caused by that start (else the first
 * arrival before the next departure) — or null while en route / never arrived.
 */
export function mapData() {
  const r = requireRt();
  const at = now();
  const places = [...r.state.places.values()].map(p => ({ id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon }));
  const evs = eventsBetween(at - MAP_TRIPS_SEC, at, ['travel.started', 'travel.arrived']).filter(ev => !isExcludedId(r.state, ev.id));
  const starts = evs.filter(ev => ev.type === 'travel.started');
  const arrivals = evs.filter(ev => ev.type === 'travel.arrived');
  const used = new Set();
  const trips = starts.map((ev, i) => {
    const nextStart = starts[i + 1]?.at ?? Infinity;
    const arrived = arrivals.find(a => !used.has(a.id) && a.causeId === ev.id)
      || arrivals.find(a => !used.has(a.id) && a.causeId == null && a.at >= ev.at && a.at <= nextStart);
    if (arrived) used.add(arrived.id);
    return {
      from: ev.payload?.from ?? null, to: ev.payload?.to ?? null, mode: ev.payload?.mode ?? null,
      startAt: ev.at, endAt: ev.at + Math.round((Number(ev.payload?.minutes) || 0) * 60),
      arrivedAt: arrived?.at ?? null, eventId: ev.id,
    };
  });
  return { places, position: positionAt(r.state, at), trips };
}

// 014 map: Life · Map / Life · Day's Leaflet maps (plan §B.3). mapData() above
// stays as it is (013's exporter reads its place fields).
/**
 * Map view: places (+ `area`, `venue`), his position (null on another day),
 * past trips from the log and today's planned ones (`planned: true`), each
 * with `pts` when the trip carries a route.recorded by data contract (else
 * the page draws a straight line), and home as an area. date null → the last
 * 48 h + the rest of today; 'YYYY-MM-DD' → that local day. Throws
 * MapError('bad_date'); 'life is not running' when the engine is off.
 */
export function mapView({ date = null } = {}) {
  const r = requireRt();
  return buildMapView({
    state: r.state,
    world: r.world,
    at: now(),
    date,
    events: eventsBetween,
    getEvent,
  });
}

export { MapError } from './mapView.js';

/**
 * Life · Day (dashboard, read only): one local day — the log's past, a NOW
 * card for today, and the projected rest of today / tomorrow (day.js: N
 * preview-tomorrow runs while the story layer is on, else 009's day plan and
 * the forecast). date 'YYYY-MM-DD' (default today, world timezone), from the
 * genesis day to tomorrow. → the view | null when not running. Throws
 * DayError('bad_date' | 'out_of_range').
 */
export async function dayView({ date = null } = {}) {
  const r = rt;
  if (!r) return null;
  const isOut = (id) => isExcludedId(r.state, id);
  return buildDayView({
    state: r.state,
    world: r.world,
    worldOf: (s) => story.worldOf(s, r.world),
    at: now(),
    date,
    events: (from, to) => eventsBetween(from, to).filter(ev => !isOut(ev.id)),
    simulate: (opts) => story.simulate(opts),
    storyOn: story.storyOn(),
  });
}

export { DayError } from './day.js';

// ── 020 F2: the thought stream (thoughts.js holds the rules, thoughtStore.js the table) ───
//
// From the live tick only. Writes its own table and nothing else: no world event, no state, so no
// decision can read it. A thought whose evidence leaves the log is swept.

const THOUGHT_UNANSWERED_SEC = 6 * 3600;
let thoughtsOn = true;   // the test seam: the same run with and without, to show the log doesn't change
let thoughtSweepSig = null;
let thoughtPruneDay = null;

function thoughtGone(r, row) {
  const s = r.state;
  for (const id of row.evidence ?? []) {
    if (isExcludedId(s, id)) return true;
    const e = getEvent(id);
    if (!e || e.redacted) return true;
  }
  // A rewind over the moment he thought it: he never lived that stretch.
  if (Number.isSafeInteger(row.asOf) && Array.isArray(s.excludedRanges)
    && s.excludedRanges.some(x => row.asOf >= x.from && row.asOf <= x.to)) return true;
  return false;
}

function thoughtsSweepNow(r) {
  const n = sweepThoughts(row => thoughtGone(r, row));
  thoughtSweepSig = `${r.state.excluded?.size ?? 0}:${r.state.excludedRanges?.length ?? 0}`;
  return n;
}

// The people he'd think of: a romance first, then whoever he's closest to (fictional cast only).
function thoughtClosest(s) {
  const out = [];
  const arc = Object.values(s.story?.arcs ?? {}).find(a => a?.kind === 'romance' && a?.status === 'active');
  const partner = typeof arc?.castIds?.[0] === 'string' ? arc.castIds[0] : null;
  for (const c of s.cast instanceof Map ? s.cast.values() : []) {
    const close = c?.metrics?.closeness;
    if (!c?.name || !(c.id === partner || (Number.isFinite(close) && close >= 0.55))) continue;
    out.push({ name: liveFirstName(c.name), partner: c.id === partner });
  }
  return out;
}

function thoughtsTick(r, view, info) {
  const at = info?.at;
  if (!Number.isSafeInteger(at)) return;
  const s = r.state;
  const sig = `${s.excluded?.size ?? 0}:${s.excludedRanges?.length ?? 0}`;
  if (sig !== thoughtSweepSig) thoughtsSweepNow(r);
  const tz = liveTz(r);
  const day = liveDateKey(at, tz);
  if (day !== thoughtPruneDay) { thoughtPruneDay = day; pruneThoughts(at); }
  if (s.genesisAt === null || s.genesisAt === undefined) return;

  const isLive = (e) => !e.redacted && !e.heavy && !isExcludedId(s, e.id);
  const heavyChain = (e) => { try { return causeChain(e.id).some(x => x?.heavy === true || x?.type === 'heavy.started'); } catch { return true; } };
  const events = eventsBetween(at - EVIDENCE_WINDOW_SEC, at, THOUGHT_TYPES).filter(e => isLive(e) && !heavyChain(e));
  const castMember = (id) => view.cast?.get?.(id) ?? s.cast?.get?.(id) ?? null;
  const nameOf = (id) => { const c = castMember(id); return c?.name ? liveFirstName(c.name) : null; };
  const anyName = (id) => { const n = castMember(id)?.name ?? s.story?.departed?.[id]?.name; return n ? liveFirstName(n) : null; };
  const live = liveSession({ at });
  const world = story.worldOf(s, r.world) ?? r.world;
  const heavyActive = s.story?.heavy?.active;
  const heavy = (Number.isFinite(heavyActive?.until) && at < heavyActive.until) || embargoIsActive(s.embargo, at);

  let deeds = [];
  if (events.some(e => e.type === 'decision.committed' || e.type === 'decision.reversed')) {
    try {
      deeds = thoughtDeed({ date: liveDateKey(at, tz) }).rows.filter(x => x.against).map((x) => {
        const o = s.decisions?.get?.(x.id)?.origins?.find?.(y => ['group', 'dm', 'call', 'ig'].includes(y?.kind));
        return { ...x, origin: o ? { kind: o.kind, jid: o.jid ?? null } : null };
      });
    } catch { deeds = []; }
  }
  let unanswered = [];
  try {
    const texts = eventsBetween(at - THOUGHT_UNANSWERED_SEC, at, ['phone.message']).filter(isLive);
    unanswered = texts.filter(e => e.payload?.dir === 'in' && at - e.at >= 20 * 60
      && !texts.some(x => x.payload?.dir === 'out' && x.payload?.castId === e.payload?.castId && x.at >= e.at));
  } catch { unanswered = []; }
  let intentions = [];
  try { intentions = r.opts?.intentions?.(at) ?? []; } catch { intentions = []; }

  const rows = tickThoughts({
    s: view, at, tickSec: r.pulse?.stepSeconds ?? 900, steps: info.steps ?? 1, reanchored: info.reanchored === true,
    rng: (key) => rngFor(day, `thought:${key}`), hourOf: (t) => liveLocalParts(t, tz).hour,
    events, live, deeds, unanswered, intentions, recent: recentThoughts(at - MEMORY_DAYS * 86400).filter(t => !isRealThought(t)),   // F3's aren't the stream's
    memberOf: castMember, nameOf, anyName,
    departed: Object.values(s.story?.departed ?? {}).map(d => d?.name).filter(Boolean).map(liveFirstName),
    closest: thoughtClosest(s),
    wokeAt: Number.isFinite(s.sleep?.lastWokeAt) ? s.sleep.lastWokeAt : null,
    employed: world?.self?.employed !== false,
    goalsOpen: Object.values(s.goals ?? {}).filter(g => g?.status === 'open').length,
    moneyRef: Number.isFinite(world?.money?.salary) ? world.money.salary : null,
    heavy, firstMeet: live?.firstMeet === true, asOf: s.lastEventId ?? null,
  });
  for (const row of rows) insertThought(row, now());
}

/**
 * The stream of one local day ('YYYY-MM-DD', default today), oldest first, or the newest `limit` of
 * today. Never a JID or a chat's word: a chat's thought is marked fromChat. { running, date, thoughts }.
 */
export function thoughtsView({ date = null, limit = null } = {}) {
  const r = rt;
  const at = now();
  const tz = r ? liveTz(r) : config.timezone;
  const today = liveDateKey(at, tz);
  const day = date ?? today;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new ThoughtDateError('bad_date');
  let from;
  try {
    from = zonedDayStart(Number(m[1]), Number(m[2]), Number(m[3]), tz);
    if (liveDateKey(from, tz) !== day) throw new Error('no such day');
  } catch { throw new ThoughtDateError('bad_date'); }
  if (!r) return { running: false, date: day, today, thoughts: [], real: [] };
  const all = thoughtsBetween(from, from + 26 * 3600, 800).filter(t => liveDateKey(t.at, tz) === day && !thoughtGone(r, t));
  const real = all.filter(isRealThought);
  // One moment, one thought: a real thought takes the place of the stream's excuse for the same choice.
  const told = new Set(real.map(t => t.codes?.decisionId).filter(Number.isSafeInteger));
  const rows = all.filter(t => !isRealThought(t) && !(t.family === 'excuse' && told.has(Number(String(t.dedupeKey ?? '').split(':')[2]))));
  const shown = Number.isSafeInteger(limit) && limit > 0 ? rows.slice(-limit) : rows;
  return {
    running: true, date: day, today, count: rows.length,
    thoughts: shown.map(t => ({ id: t.id, at: t.at, family: t.family, kind: streamKind(t.family), text: t.text, cause: t.cause ?? null, fromChat: t.originKind !== 'self' && t.originKind !== 'owner' })),
    // F3: two columns, newest first. With a limit (Life · Now) the newest three.
    real: (Number.isSafeInteger(limit) && limit > 0 ? real.slice(-3) : real).map(t => story.realThoughtView(t)).reverse(),
  };
}

export function __setThoughtsForTest(on) { thoughtsOn = on !== false; }
export function __resetThoughtsForTest() {
  thoughtSweepSig = null;
  thoughtPruneDay = null;
}

// ── 020 C1–C2: the live outing (liveSession.js holds the state and the words) ─────────────
//
// A read of the log, nothing stored: a revert, a rewind or a restart can't leave it behind. The
// facts come from the story layer through the scene's own rule, so the two can't disagree on what
// is an outing, how it goes, or who may be named. Never called from a simulation.

const LIVE_MOVES = ['activity.started', 'activity.ended', 'travel.started', 'sleep.started', 'world.reanchored'];
const LIVE_LOOKBACK_SEC = 14 * 3600;
const LIVE_DEFAULT_SEC = 2 * 3600;
let liveFactsCache = null;

const liveCompany = (e) => (Array.isArray(e.payload?.withCast) ? [...e.payload.withCast].sort().join(',') : '');
const sameBlock = (a, b) => a.payload?.kind === b.payload?.kind && (a.payload?.placeId ?? null) === (b.payload?.placeId ?? null)
  && liveCompany(a) === liveCompany(b) && !!a.subjectJid === !!b.subjectJid;

/** What he is doing at `at` per the log: { current, anchor (the first start of a resumed block) } | null. */
function liveFind(r, at) {
  const isLive = (e) => !e.redacted && !isExcludedId(r.state, e.id);
  const rows = eventsBetween(at - LIVE_LOOKBACK_SEC, at, LIVE_MOVES).filter(isLive);
  let cur = null;
  const starts = [];
  for (const e of rows) {
    if (e.type === 'activity.started') { cur = e; starts.push(e); }
    else if (e.type === 'activity.ended') { if (cur && e.causeId === cur.id) cur = null; }
    else cur = null;
  }
  if (!cur) return null;
  // A rewind or re-anchor left him idle and the same block started again: one outing, not two.
  let anchor = cur;
  for (let i = starts.length - 1; i >= 0; i--) {
    const e = starts[i];
    if (e.id >= anchor.id) continue;
    const end = Number.isFinite(e.payload?.end) ? e.payload.end : e.at;
    if (sameBlock(e, anchor) && end > anchor.at) anchor = e;
  }
  return { current: cur, anchor };
}

function liveFacts(r, anchor, current, endAt) {
  const s = r.state;
  const sig = `${anchor.id}:${endAt}:${s.excluded?.size ?? 0}:${s.excludedRanges?.length ?? 0}:${JSON.stringify(s.story?.sceneTones ?? null)}:${JSON.stringify(s.story?.outcomes ?? null)}`;
  if (liveFactsCache?.sig === sig) return liveFactsCache.value;
  const value = story.liveContext({ ...anchor, payload: { ...anchor.payload, end: current.payload?.end ?? anchor.payload?.end } }, endAt);
  liveFactsCache = { sig, value };
  return value;
}

function liveInputs(r, base, to) {
  const s = r.state;
  const isLive = (e) => !e.redacted && !e.heavy && !isExcludedId(s, e.id);
  const texts = eventsBetween(base.startAt, to, ['phone.message']).filter(isLive);
  // A chat.load's window reaches back: only one ending well into the session is about it (as the scene's sheet reads it).
  const chats = eventsBetween(base.startAt + 10 * 60, to, ['chat.load']).filter(isLive);
  const nameOf = (id) => firstNameOf(s.cast?.get?.(id)?.name ?? s.story?.departed?.[id]?.name);
  base.facts.nameOf = nameOf;
  let series = null;
  const vitalsOf = (t) => {
    if (series === null) {
      try { series = vitalsSeries({ from: base.startAt, to, stepSec: 900, world: r.world }) || []; } catch { series = []; }
    }
    let v = null;
    for (const pt of series) { if (pt.at <= t) v = pt.vitals ?? v; else break; }
    return v;
  };
  return { moodlets: interruptionsOf(base, [...texts, ...chats]), vitalsAt: vitalsOf };
}

function firstNameOf(name) {
  const t = String(name ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.split(' ')[0] : null;
}

function liveBase(r, facts) {
  const tz = liveTz(r);
  return buildBase(facts, {
    rngFor, date: liveDateKey(facts.startAt, tz), hhmm: (t) => liveHhmm(t, tz), hourOf: (t) => liveLocalParts(t, tz).hour,
  });
}

function liveTz(r) {
  return r.state.world?.timezone ?? r.world?.timezone ?? config.timezone;
}

/**
 * The live outing at `at` (default now): { running, active } and, while one is on, its mode. Full: phase,
 * his mood and theirs as bands, attention, closeness, topic, interruptions, the line. Minimal (a real
 * person, a chat's outing, a heavy stretch or window): the line "out with a friend", nothing else.
 */
export function liveSession({ at = null } = {}) {
  const r = rt;
  if (!r) return { running: false, active: false };
  const t = Number.isFinite(at) ? Math.min(Math.floor(at), now()) : now();
  const found = liveFind(r, t);
  if (!found) return { running: true, active: false, at: t };
  const planned = Number.isFinite(found.current.payload?.end) ? found.current.payload.end : found.current.at + LIVE_DEFAULT_SEC;
  const facts = liveFacts(r, found.anchor, found.current, planned);
  if (!facts) return { running: true, active: false, at: t };
  const tz = liveTz(r);
  if (facts.mode === 'minimal') {
    const parts = ['out with a friend'];
    return { running: true, active: true, mode: 'minimal', reason: facts.reason, at: t, line: { at: liveHhmm(t, tz), parts }, text: [liveHhmm(t, tz), ...parts].join(' · ') };
  }
  const base = liveBase(r, facts);
  const view = liveView(base, liveInputs(r, base, t), t);
  return {
    running: true, active: true, mode: 'full', at: t, activityEventId: facts.activityId, startAt: facts.startAt, endAt: base.endAt,
    kind: facts.kind, private: facts.register === 'private' || undefined, firstMeet: facts.firstMeet === true, ...view,
  };
}

/**
 * Did this start's block go on under a later start (a re-plan mid-outing, a rewind)? Then it wasn't the outing's end: one outing, one scene, at the true end. (020 C4)
 */
export function liveResumedLater(activityEventId) {
  const r = rt;
  if (!r) return false;
  const start = getEvent(activityEventId);
  if (!start || start.type !== 'activity.started') return false;
  const planned = Number.isFinite(start.payload?.end) ? start.payload.end : start.at + LIVE_DEFAULT_SEC;
  const isLive = (e) => !e.redacted && !isExcludedId(r.state, e.id);
  for (const e of eventsBetween(start.at, Math.min(now(), start.at + LIVE_LOOKBACK_SEC), LIVE_MOVES).filter(isLive)) {
    if (e.id <= start.id || e.type === 'activity.ended') continue;
    return e.type === 'activity.started' && sameBlock(e, start) && e.at < planned;
  }
  return false;
}

// The earlier starts of the block this start resumed, nearest first: the last one is the outing's anchor.
function liveStartChain(r, start) {
  const isLive = (e) => !e.redacted && !isExcludedId(r.state, e.id);
  const earlier = eventsBetween(start.at - LIVE_LOOKBACK_SEC, start.at, ['activity.started']).filter(isLive);
  const out = [];
  let anchor = start;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.id < anchor.id && sameBlock(e, anchor) && (Number.isFinite(e.payload?.end) ? e.payload.end : e.at) > anchor.at) {
      out.push(e);
      anchor = e;
    }
  }
  return out;
}

/** The ids of the earlier starts of the outing this start resumed, nearest first (020 C4). [] for a start that resumed nothing. */
export function liveEarlierStarts(activityEventId) {
  const r = rt;
  if (!r) return [];
  const start = getEvent(activityEventId);
  if (!start || start.type !== 'activity.started') return [];
  return liveStartChain(r, start).map(e => e.id);
}

/**
 * The record of an outing for its end scene's sheet (scene worker, plan 020 C4). activityEventId:
 * any start of the outing. null when it is no session or has left the log; { mode:'minimal', reason }
 * when only that much may be said. Fictional names and codes; real chats as counts only.
 */
export function liveSessionTrace(activityEventId) {
  const r = rt;
  if (!r) return null;
  const start = getEvent(activityEventId);
  if (!start || start.type !== 'activity.started' || start.redacted || isExcludedId(r.state, start.id)) return null;
  const isLive = (e) => !e.redacted && !isExcludedId(r.state, e.id);
  const rows = eventsBetween(start.at, Math.min(now(), start.at + LIVE_LOOKBACK_SEC), LIVE_MOVES).filter(isLive);
  // Before it: a start of the same block this one resumed. After it: any later resume, then what ended it.
  const anchor = liveStartChain(r, start).at(-1) ?? start;
  let current = start;
  let endAt = null;
  for (const e of rows) {
    if (e.id === start.id) continue;
    if (e.type === 'activity.ended') {
      if (e.causeId === current.id && endAt === null) endAt = e.at;
      continue;
    }
    const resumes = e.type === 'activity.started' && sameBlock(e, current) && e.at < (Number.isFinite(current.payload?.end) ? current.payload.end : e.at);
    if (resumes) { current = e; endAt = null; continue; }
    if (endAt === null) endAt = e.at;
    break;
  }
  const planned = Number.isFinite(current.payload?.end) ? current.payload.end : current.at + LIVE_DEFAULT_SEC;
  const end = endAt ?? Math.min(now(), planned);
  if (endAt !== null && end - anchor.at < 20 * 60) return null;   // over too soon: no scene either
  const facts = story.liveContext({ ...anchor, payload: { ...anchor.payload, end: planned } }, planned);
  if (!facts) return null;
  if (facts.mode === 'minimal') return { mode: 'minimal', reason: facts.reason, activityEventId: anchor.id };
  const base = liveBase(r, facts);
  return { mode: 'full', private: facts.register === 'private' || undefined, ...traceOf(base, liveInputs(r, base, end), end) };
}

/**
 * Life · Wallet (spec 018 §B, dashboard, read only): one local month of his money —
 * salary, every itemized spend, the owner's money changes — newest first, the month's
 * totals by category and a balance per day (one read-only vitals series for the
 * month's day ends). month 'YYYY-MM' (default this month), from genesis's month to
 * now. → the view ({running:false, …} when not running). Throws WalletError
 * ('bad_month' | 'out_of_range').
 */
export function walletView({ month = null } = {}) {
  const r = rt;
  const at = now();
  if (!r) return buildWalletView({ state: null, at, tz: config.timezone, month, events: () => [] });
  const world = r.world;
  return buildWalletView({
    state: r.state,
    world: story.worldOf(r.state, world) ?? world,
    at,
    tz: r.state.world?.timezone ?? world?.timezone ?? config.timezone,
    month,
    events: (from, to, types) => eventsBetween(from, to, types),
    getEvent,
    isOut: (id) => isExcludedId(r.state, id),
    balanceNow: () => vitalsAt(r.state, at, world)?.money ?? null,
    balancesAt: (times) => {
      if (!times.length) return [];
      const series = vitalsSeries({ from: Math.min(...times) - 3600, to: Math.max(...times), stepSec: 3600, world }) || [];
      return times.map((t) => {
        if (t >= at - 60) return vitalsAt(r.state, at, world)?.money ?? null;
        let v = null;
        for (const pt of series) { if (pt.at <= t) v = pt.vitals?.money ?? v; else break; }
        return v;
      });
    },
    balanceBefore: (id) => stateBeforeEvent(id, { world })?.vitals?.money ?? null,
    isRevertible,
  });
}

export { WalletError } from './wallet.js';

// ── 020 E1: the nightly plot-hole sweep (sweep.js holds the rules) ───────────────────────
//
// Once a night (his sleep started, or the first tick after midnight; only from the live
// tick, which a simulation never reaches) and on demand. Writes only story_state; a failure
// is logged as a code and marks that night done, so it can't repeat on every tick.

const SWEEP_MAX_PAGES = 400;
let sweepNightTried = null;
let sweepAttempts = 0;

function sweepTz(r) {
  return r.state.world?.timezone ?? r.world?.timezone ?? config.timezone;
}

function sweepStored() {
  const raw = story.sweepStateRead();
  const clean = cleanStored(raw.findings.value, raw.dismissed.value);
  return { ...clean, corrupt: clean.corrupt || raw.findings.corrupt || raw.dismissed.corrupt };
}

function sweepTick(r, at) {
  if (r.state?.genesisAt === null || r.state?.genesisAt === undefined) return;
  const tz = sweepTz(r);
  let stored;
  try { stored = sweepStored(); } catch { stored = { lastNight: null, lastRunAt: null, findings: [], dismissed: [], corrupt: true }; }
  const night = nightDue(stored.lastNight, at, tz, r.state.activity?.kind === 'sleep');
  if (!night || night === sweepNightTried) return;
  sweepNightTried = night;
  sweepAttempts += 1;
  sweepRun(r, at, { night, stored });
}

function sweepRun(r, at, { night = null, stored = sweepStored(), full = false } = {}) {
  const tz = sweepTz(r);
  const world = r.world;
  const isOut = (id) => isExcludedId(r.state, id);
  const { from, to } = windowOf(stored.lastRunAt, at, { full });
  const live = (e) => !e.redacted && !isOut(e.id);
  const started = Date.now();
  const { findings, ruleErrors } = runRules({
    from, to, tz, isOut, getEvent, causeChain,
    read: (a, b, types) => eventsBetween(a, b, types, { maxPages: SWEEP_MAX_PAGES, strict: true }),
    placeWord: (id) => { try { return placeLabelOf(r.state, id, { negative: true }) ?? 'somewhere'; } catch { return 'somewhere'; } },
    castWord: (id) => r.state.cast?.get?.(id)?.name ?? r.state.story?.departed?.[id]?.name ?? 'someone',
    kindWord: (k) => String(k ?? 'outing').replace(/[_:-]+/g, ' '),
    walletStartId: () => logListEvents({ types: ['wallet.started'], limit: 50, order: 'desc' }).find(live)?.id ?? null,
    moneyBefore: (id) => stateBeforeEvent(id, { world })?.vitals?.money ?? null,
    moneyNow: () => vitalsAt(r.state, at, world)?.money ?? null,
    moneySince: (id) => {
      const out = [];
      for (let after = id - 1; ;) {
        const page = logListEvents({ types: WALLET_TYPES, after, limit: 500 });
        out.push(...page.filter(live));
        if (page.length < 500) return out;
        after = page[page.length - 1].id;
      }
    },
    strongCues: (ids) => story.phoneStrongCues(ids),
    planOutcomes: () => story.phonePlanOutcomes(),
    sceneAfterwards: (ids) => story.sceneAfterwardsCheck(ids),
    overduePromises: () => story.commitmentsFor(r.state, at, tz),   // 020 D3
  });
  const dismissed = new Set(stored.dismissed.map(d => d.fp));
  const isGone = (id) => { if (isOut(id)) return true; const e = getEvent(id); return !e || e.redacted === true; };
  const merged = mergeFindings(stored.findings, findings, { from, at, dismissed, isGone, ruleErrors });
  const value = {
    lastNight: night ?? stored.lastNight, lastRunAt: at, findings: merged,
    ...(ruleErrors.length ? { ruleErrors } : {}), ...(stored.corrupt ? { recoveredAt: at } : {}),
    durationMs: Date.now() - started,
  };
  story.sweepStateWrite({ findings: value, ...(stored.corrupt ? { dismissed: stored.dismissed } : {}) });
  logger.info({ evt: 'life_sweep', night, findings: merged.length, ruleErrors: ruleErrors.length, durationMs: value.durationMs }, 'life: sweep');
  return value;
}

/**
 * The owner's alerts: { running, lastNight, lastRunAt, findings, count, rules, corrupt }. A finding whose
 * event was reverted or rewound since the last run is already left out. Never throws: a bad stored
 * value reads as `corrupt: true` with whatever was still well-formed.
 */
export function alertsView() {
  const r = rt;
  if (!r) return { running: false, lastNight: null, lastRunAt: null, findings: [], count: 0, rules: SWEEP_RULES, corrupt: false, ruleErrors: [] };
  let stored;
  let extra = {};
  try {
    stored = sweepStored();
    extra = story.sweepStateRead().findings.value ?? {};
  } catch { stored = { lastNight: null, lastRunAt: null, findings: [], dismissed: [], corrupt: true }; }
  const findings = stored.findings.filter(f => !f.eventIds.some(id => isExcludedId(r.state, id)));
  return {
    running: true, lastNight: stored.lastNight, lastRunAt: stored.lastRunAt, findings, count: findings.length, rules: SWEEP_RULES,
    corrupt: stored.corrupt === true, ruleErrors: Array.isArray(extra?.ruleErrors) ? extra.ruleErrors.filter(x => SWEEP_RULES.includes(x)) : [],
  };
}

/** How many findings are open (the topbar badge). 0 when not running or unreadable. */
export function alertsCount() {
  try { return alertsView().count; } catch { return 0; }
}

/** Dismiss one finding: it never comes back, unless its events change. → { ok } | { ok:false, code }. */
export function dismissAlert(fp, { by = 'owner', at = now() } = {}) {
  if (!rt) return { ok: false, code: 'not_running' };
  const stored = sweepStored();
  const row = stored.findings.find(f => f.fp === fp);
  if (!row) return { ok: false, code: 'not_found' };
  const dismissed = [...stored.dismissed.filter(d => d.fp !== fp), { fp, at, by: String(by).slice(0, 40) }].slice(-DISMISSED_MAX);
  const raw = story.sweepStateRead().findings.value;
  story.sweepStateWrite({
    dismissed,
    findings: { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), lastNight: stored.lastNight, lastRunAt: stored.lastRunAt, findings: stored.findings.filter(f => f.fp !== fp) },
  });
  return { ok: true, rule: row.rule };
}

/** A sweep now, over the longest window (the dashboard's RUN NOW; the live state only). → alertsView() */
export function runSweepNow({ at = now() } = {}) {
  const r = rt;
  if (!r) return { ok: false, code: 'not_running' };
  sweepRun(r, at, { full: true });
  return { ok: true, ...alertsView() };
}

export function __resetSweepForTest() {
  sweepNightTried = null;
  sweepAttempts = 0;
}
export const __sweepAttemptsForTest = () => sweepAttempts;

// ── 020 F1: thought vs deed (read only, no storage, no model) ─────────────────────────────

/**
 * What he leaned to vs what he did on one local day ('YYYY-MM-DD', default today), from the log
 * (thoughtDeed.js). → the view; throws ThoughtDeedError('bad_date').
 */
export function thoughtDeed({ date = null } = {}) {
  const r = rt;
  const at = now();
  if (!r) return buildThoughtDeed({ running: false, date, at, tz: config.timezone, read: () => [] });
  const isOut = (id) => isExcludedId(r.state, id);
  return buildThoughtDeed({
    running: true, date, at, tz: sweepTz(r), getEvent,
    read: (a, b, types) => eventsBetween(a, b, types, { maxPages: 40 }).filter(e => !e.redacted && !isOut(e.id)),
  });
}

export { ThoughtDeedError } from './thoughtDeed.js';

/**
 * Public site (spec 013): the structural public view — self/owner-origin rows only,
 * chat-caused spans as 'out' rows, heavy events and their consequences dropped, a
 * heavy stretch as one flag (publicView.js). Still internal ids and person refs: only
 * src/public/ (which resolves, scrubs and validates) may call it. null when not running.
 */
export function publicRaw({ days = 14 } = {}) {
  const r = rt;
  if (!r) return null;
  const at = now();
  const view = advanceTo(r.state, at, r.world);
  let hardStretch = true;   // unknown → the gentle line, never details
  try { hardStretch = story.heavyGuardActive(view, at) === true || embargoIsActive(view.embargo, at); } catch { /* keep true */ }
  let cards = [];
  try { cards = story.storyOn() ? story.cards({ includeClosed: false }) : []; } catch { cards = []; }
  // 015 §1.8 (013 seam): his job (a fired character is out of work) comes from the overlaid world.
  let world = r.world;
  try { world = story.worldOf(view, r.world) ?? r.world; } catch { world = r.world; }
  return buildPublicRaw({
    state: view,
    world,
    at,
    tz: r.state.world?.timezone ?? r.world?.timezone ?? config.timezone,
    // Since-genesis cast/arc reads must be complete (a dropped heavy delta would move the
    // public metrics): strict, so an over-long log fails the export closed.
    events: (from, to, types) => {
      try { return eventsBetween(from, to, types, { maxPages: PUBLIC_MAX_PAGES, strict: true }); } catch (err) {
        logger.warn({ evt: 'issue', code: 'history_too_large', types, pages: PUBLIC_MAX_PAGES }, 'life: public view read hit its page guard');
        throw err;
      }
    },
    getEvent,
    isOut: (id) => isExcludedId(r.state, id),
    hardStretch,
    cards,
    days,
    // 020: no words: the exporter joins them (publicThoughts).
    thoughtRows: publicThoughtRows(at - days * 86400, at),
  });
}

function publicThoughtRows(from, to) {
  // F3's real thoughts are the dashboard's: never on the site.
  return thoughtsBetween(from, to, 2000).filter(t => !isRealThought(t) && (!rt || !thoughtGone(rt, t))).map(t => ({ id: t.id, at: t.at, family: t.family, originKind: t.originKind, originJid: t.originJid, evidence: t.evidence }));
}

/** 020: the words of these thoughts (the site's `thoughts`). Map(id → text). F3's real thoughts stay off the feed. */
export function publicThoughts(ids, { days = 14 } = {}) {
  const want = new Set(ids);
  const at = now();
  const out = new Map();
  for (const t of thoughtsBetween(at - days * 86400, at, 2000)) if (want.has(t.id) && !isRealThought(t) && typeof t.text === 'string') out.set(t.id, t.text);
  return out;
}

/** 020 G: the words of these dreams (the site's `dreams`). Map(event id → { text, night }). */
export function publicDreams(eventIds) {
  return story.publicDreams(eventIds);
}

/** 020 B: his interests and opinions that only his own life shaped (the site's `mind`), or null with no mind to ask. */
export function publicMind() {
  return publicStanceRows();
}

/**
 * 020 C2: the site's `live`. null: not out with fictional cast (a chat, a real person, a heavy stretch or window, nothing on).
 * A private session is { private: true } and nothing more, never its place. Codes, ids, code-built words. Throws on a read failure.
 */
export function publicLive() {
  const r = rt;
  if (!r) return null;
  const at = now();
  const v = liveSession({ at });
  if (v.active !== true || v.mode !== 'full') return null;
  const start = getEvent(v.activityEventId);
  if (!start || start.redacted || start.heavy === true || isExcludedId(r.state, start.id) || start.subjectJid) return null;
  if (start.originKind !== 'self' && start.originKind !== 'owner') return null;
  if (causeChain(start.id).some(x => x?.heavy === true || x?.type === 'heavy.started')) return null;
  if (v.private === true) return { private: true };
  const trace = liveSessionTrace(start.id);
  if (trace?.mode !== 'full') return null;
  return {
    startAt: v.startAt, until: Number.isFinite(v.endAt) ? v.endAt : null, placeId: start.payload?.placeId ?? null,
    castIds: (v.them ?? []).map(x => x.castId), phase: v.phase,
    line: (v.line?.parts ?? []).slice(1).join(' · ') || v.phaseWords,   // the first part is the place: the site has it by id
    beats: publicBeats(trace),
  };
}

// ── 010 story (contracts/story-api.md §3.7) ───────────────────────────────

/**
 * 008 sleep step 4b: the weekly arc pass. budgetOk is mindBudgetOk('sleep')'s
 * object; the pass runs only when budgetOk.ok === true. A no-op while life or
 * the `arcs` skill is off.
 */
/** 020 D2: how things stand, the mind's sleep step. */
export async function storyStandingPass(opts = {}) {
  return story.standingPass(opts);
}

/** 020 D2: the site's rows for fictional people, ready and not exported yet: [{ castId, text, validFrom }]. */
export function publicStanding() {
  return story.publicStanding();
}

/**
 * 020 D3: what he said he'd do. No storage. { running, at, timezone, rows, counts }. A failed read says so, it never throws.
 * No JID on a row: a real person is "a friend", a chat's plan "a plan from a chat".
 */
export function commitmentsView() {
  const r = rt;
  if (!r?.state) return { running: false, rows: [] };
  const at = Math.floor(now());
  try {
    const rows = story.commitmentsFor(r.state, at, sweepTz(r));
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return { running: true, at, rows, counts };
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'life.commitments', err: err?.name ?? 'Error' }, 'life: commitments view failed');
    return { running: true, at, rows: [], failed: true };
  }
}

export async function storyWeeklyPass(opts = {}) {
  if (!rt || !story.storyOn()) return { status: 'skipped', reason: 'disabled' };
  return story.weeklyPass(opts);
}

/** Apply a planned rewind (story.director.apply only). */
export async function rewindTo(planned, { by = 'owner', fingerprint = null } = {}) {
  const r = requireRt();
  return story.rewindTo(planned, { by, fingerprint, append: r.append });
}

/**
 * Append owner descriptors in one transaction through the facade's appender
 * (folded, embargo follow-ups; story.director.apply and owner scenes only).
 * → { eventIds }
 */
export function appendOwnerBatch(descriptors, { by = 'owner' } = {}) {
  const r = requireRt();
  return story.appendOwnerBatch(descriptors, { append: r.append, by, now: now() });
}

// ── 014 real places · geo (spec 014 plan §A1, §A3, §A4, §A7) ──────────────
//
// One geo client per process, built in src/index.js start() and passed as
// startLife({geo}); the default is null, so every geo path answers `geo_off`
// in tests and scripts (R11). The dashboard reaches it only through these
// functions (R10); the story layer gets the geo service (candidates, job
// results, the route fetcher) through attach. Lookups happen on owner clicks
// only; their results enter the world only as owner events through a Director
// preview → apply. Logs carry codes and counts, never a query, name or
// coordinate.

export const OSM_DATA_ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL';
const COLLIDING_REFRESH_SEC = 600;
let geoClient = null;
const geoCandidates = createCandidateStore({ now: () => now() });
const geoJobs = createGeoJobs({ now: () => now(), logger });
let collidingAt = 0;
let venueNamesCache = { lastEventId: -1, entries: [] };
let venueReadFailed = false;   // the last read of them didn't finish, so what came back may be short
// Render-time scrubs (innerState, journal, Day rows, the mouth's tail) read the
// names through places.js; the reader works with life stopped too (log only).
setVenueNamesSource(() => venueEntriesEver());

/** Set the geo client (startLife's `geo` option; null → geo off). */
function setGeoClient(client) {
  geoClient = client && typeof client.search === 'function' ? client : null;
}

/** The service the story layer's Director preview resolver reads (never the raw stores). */
function geoService() {
  if (!geoClient) return null;
  return {
    candidates: { get: (id) => geoCandidates.get(id) },
    results: { get: (id) => geoJobs.result(id) },
    // A6b: a prompt draft's venueQuery → candidates (the same search, wish checks and stores).
    search: (q, o = {}) => placeSearch(q, { areas: false, ...o }),
    venueQueryProblem: (name, area) => {
      let names;
      try { names = realPeopleNamesOrThrow(); } catch { return 'names_unavailable'; }
      if (!cleanVenueName(name, { knownNames: names })) return 'bad_venue';
      if (area && !cleanArea(area, { knownNames: names })) return 'bad_venue';
      return null;
    },
    fetchRoutes: (pairs, { coords = {}, deadlineMs, max } = {}) => {
      const r = rt;
      return fetchGeoRoutes(geoClient, pairs, {
        coordsOf: (id) => coords[id] ?? placeCoords(r, id),
        isHome: (id) => isHomeKind(r?.state, id),
        deadlineMs, max,
      });
    },
  };
}

function placeCoords(r, id) {
  const p = r?.state?.places?.get?.(id);
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : null;
}

/** /api/status `geo`: booleans and codes only, never a URL. */
export function geoStatus() {
  const cfg = config.geo || {};
  if (!geoClient) {
    return { enabled: false, hosts: { nominatim: { ok: null, configured: false }, overpass: { ok: null, configured: false }, osrm: { ok: null, configured: false } }, configEnabled: cfg.enabled !== false };
  }
  let st;
  try { st = geoClient.status(); } catch { st = null; }
  const host = (h) => ({ ok: st?.hosts?.[h]?.ok ?? null, configured: !!st?.hosts?.[h]?.configured, ...(st?.hosts?.[h]?.lastErrorCode ? { lastErrorCode: st.hosts[h].lastErrorCode } : {}) });
  return {
    enabled: !!st?.enabled,
    hosts: { nominatim: host('nominatim'), overpass: host('overpass'), osrm: host('osrm') },
    today: st?.today ?? null,
  };
}

function geoReady(host) {
  if (!geoClient) throw new GeoError('off');
  const st = geoClient.status();
  if (!st.enabled) throw new GeoError('off');
  if (host && !st.hosts?.[host]?.configured) throw new GeoError(host === 'osrm' ? 'off' : 'unconfigured');
}

/**
 * Director place search (POST /api/places/search): Nominatim inside the region
 * box. The query passes the Director's wish checks first (JID / phone / real
 * name: the owner typed it, but it goes to a third party). Candidates are kept
 * server-side under opaque ids (30 min). → {candidates, areas, attribution, dropped}
 * Throws GeoError(off | unconfigured | bad_input | names_unavailable | …).
 */
export async function placeSearch(q, { areas = false } = {}) {
  const r = requireRt();
  geoReady('nominatim');
  const problem = story.queryProblem(q);
  if (problem) throw new GeoError(problem === 'names_unavailable' ? 'names_unavailable' : 'bad_input');
  const box = regionBox(r.state);
  if (!box) throw new GeoError('bad_input');
  const res = await geoClient.search(q, { box, areas: areas === true, limit: 8 });
  const home = placeCoords(r, r.state.self?.homePlaceId);
  const candidates = res.candidates.slice(0, 8).map((c) => {
    const distKmFromHome = home ? Math.round(haversineKm(home, c) * 100) / 100 : null;
    const id = geoCandidates.put({ ...c, distKmFromHome });
    return { id, name: c.name, kind: c.kind, lat: c.lat, lon: c.lon, area: c.area ?? null, ref: c.ref, distKmFromHome, flags: c.flags ?? [] };
  });
  return { candidates, areas: res.areas ?? [], attribution: OSM_DATA_ATTRIBUTION, dropped: res.dropped };
}

/** "Make places real" (POST /api/places/realify) → {jobId}; GeoError('busy') while a job runs. */
export function realifyStart() {
  const r = requireRt();
  geoReady('overpass');
  const world = story.worldOf(r.state, r.world);
  return geoJobs.start('places.realify', (progress) => realifyJob({
    client: geoClient, state: r.state, world, radiusKm: config.geo?.switchRadiusKm ?? 2, progress,
    coordsOf: (id) => placeCoords(r, id), isHome: (id) => isHomeKind(r.state, id),
    routePairs: (pid) => routePairsFor(r.state, world, pid),
  }));
}

/** "Refresh routes" (POST /api/places/routes/refresh) → {jobId}: the pairs whose route is missing or stale. */
export function routesRefreshStart() {
  const r = requireRt();
  geoReady('osrm');
  const world = story.worldOf(r.state, r.world);
  const pairs = refreshPairs(r.state, world).filter(([a, b]) => !routeFor(world, a, b, 'car'));
  return geoJobs.start('routes.refresh', (progress) => routesRefreshJob({
    client: geoClient, pairs, progress, coordsOf: (id) => placeCoords(r, id), isHome: (id) => isHomeKind(r.state, id),
  }));
}

/** A geo job's progress (GET /api/places/jobs/:id) → {kind, done, total, phase, resultId?, error?} | null. */
export function geoJob(id) {
  return geoJobs.get(id);
}

/**
 * Every venue name ever recorded — place.created / place.updated with venue,
 * EXCLUDED events included (a reverted or rewound switch, R5) — with its kind,
 * from the log, cached by lastEventId. Names only from `venueNamesEver()`.
 */
export function venueEntriesEver() {
  let last = -1;
  venueReadFailed = false;
  try { last = lastLogEventId(); } catch { last = -1; venueReadFailed = true; }
  if (last < 0) return venueNamesCache.entries;          // no log (yet): nothing recorded
  if (venueNamesCache.lastEventId === last) return venueNamesCache.entries;
  const out = new Map();
  try {
    let after = 0;
    for (let page = 0; page < 200; page++) {
      // listEvents takes ids ≥ 1 only: the first page has no `after`.
      const list = logListEvents({ types: ['place.created', 'place.updated'], ...(after ? { after } : {}), limit: 500, order: 'asc' });
      if (!list.length) break;
      for (const ev of list) {
        const p = ev.payload || {};
        if (p.venue && typeof p.venue === 'object' && typeof p.name === 'string' && p.name.trim()) {
          out.set(p.name.trim().toLowerCase(), { name: p.name.trim(), kind: typeof p.kind === 'string' ? p.kind : null });
        }
      }
      after = list[list.length - 1].id;
      if (list.length < 500) break;
    }
  } catch (err) {
    venueReadFailed = true;
    logger.warn({ evt: 'issue', where: 'life.geo', err: err?.name || 'Error' }, 'life: venue names read failed');
    return venueNamesCache.entries;
  }
  venueNamesCache = { lastEventId: last, entries: [...out.values()] };
  return venueNamesCache.entries;
}

/** Every venue name ever recorded (string[]; 013 replaces them in published prose). */
export function venueNamesEver() {
  return venueEntriesEver().map(e => e.name);
}

/**
 * Published prose (013, 014 plan §8): every venue name ever recorded → its kind
 * word ("a cafe"), whole words, any case. Non-strings come back as they are.
 */
export function venueKindWords(text) {
  return scrubVenueNames(text, venueEntriesEver());
}

/** The safe wording of a place (013 and other surfaces): a venue next to a negative event → its kind word. */
export function placeLabel(id, { at = null, negative = false } = {}) {
  const r = rt;
  if (!r) return null;
  let neg = negative === true;
  if (!neg && Number.isFinite(at)) {
    try {
      const evs = eventsBetween(at - 3 * 3600, at + 3 * 3600).filter(e => !isExcludedId(r.state, e.id));
      neg = negativeAt(r.state, at, { placeId: id, events: evs });
    } catch { neg = true; }   // fail closed: kind word
  }
  return placeLabelOf(r.state, id, { negative: neg });
}

// The collision sweep (§A1.3, R7): a venue name that matches a person who
// became known later is worded by its kind everywhere. A names read error
// marks every venue colliding (fail closed). At most every 10 min, from the tick.
function refreshCollidingVenues(r, at, { force = false } = {}) {
  if (!force && at - collidingAt < COLLIDING_REFRESH_SEC) return;
  collidingAt = at;
  const venues = [...(r?.state?.places instanceof Map ? r.state.places.values() : [])].filter(p => isRealVenue(p) || p?.ownerNamed);
  if (!venues.length) { setCollidingVenues([]); return; }
  let names;
  try { names = realPeopleNamesOrThrow(); } catch { setCollidingVenues(venues.map(p => p.id)); return; }
  setCollidingVenues(venues.filter(p => textNameCollisions({ places: [{ name: p.name }] }, names).length).map(p => p.id));
}


// Boot check (R28): projected places that moved away from world.json (or were
// added by events) — codes and ids only, so the owner can confirm the A0 fix.
function placesDivergence(r) {
  try {
    const file = new Map((Array.isArray(r.world?.places) ? r.world.places : []).map(p => [p.id, p]));
    const moved = [];
    const added = [];
    for (const [id, p] of r.state.places) {
      const f = file.get(id);
      if (!f) added.push(id);
      else if (f.lat !== p.lat || f.lon !== p.lon) moved.push(id);
    }
    if (moved.length || added.length) {
      logger.info({ evt: 'issue', where: 'life.places', moved: moved.slice(0, 20), added: added.slice(0, 20), movedN: moved.length, addedN: added.length },
        'life: projected places differ from world.json (event-created or moved places now resolve)');
    }
    return { moved, added };
  } catch {
    return { moved: [], added: [] };
  }
}

/** Test seam: the geo stores (cleared) and the client. */
export function __resetGeoForTest({ client = undefined } = {}) {
  geoCandidates.clear();
  geoJobs.clear();
  venueNamesCache = { lastEventId: -1, entries: [] };
  collidingAt = 0;
  setCollidingVenues([]);
  if (client !== undefined) setGeoClient(client);
}
