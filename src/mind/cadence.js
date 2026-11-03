// The cadence (spec 008, research R1, R3, R5): when the mind does what.
//
// Clock source: life.onTick, subscribed AT IMPORT (so the boot catch-up tick of
// startLife is caught). The callback only records the tick in an in-memory inbox and
// calls setImmediate(drain): it returns synchronously and never stalls life's pulse.
// The drain is a no-op until start() (startMind) set `started`; ticks that arrive
// earlier wait in the inbox. If no tick arrives within 20 min of start(), a 15-min
// fallback interval of our own takes over; the first life tick cancels it for good.
//
// One serial job queue: one job at a time; a request for a job that is already queued
// coalesces into it (a tick that lands while a pass is queued joins that pass).
//
// A pass (one job per tick or fallback beat):
//   1. skill edges: off→on (also the first pass after boot with the skill on) re-seeds
//      every cursor to MAX (history is never analysed in bulk) — except a boot whose
//      last pulse is ≤ RESUME_MAX_GAP_SEC old and was not followed by an observed on→off
//      edge (on→off clears last_tick_at): that is a restart, and the cursors resume
//      (the pulse's SCAN_LIMIT bounds the catch-up). Writes the proactive
//      mode seed, and — only when DRY_RUN is off — the lazy first-live initialisation
//      (first_enabled_at + the review window). on→off cancels queued sends. Skill off →
//      nothing else runs;
//   2. the pulse (counters, opt-out detection, expiries; also while paused);
//   3. due(): ≤ 1 sleep (the night's normal sleep, or ONE catch-up sleep for the latest
//      finished night that has none — earlier missing nights are marked `missed`), then
//      ≤ 1 glance, then ≤ 1 think (glance / life anchor / scheduled), then dispatch of
//      due queued proactive drafts. Runs obey the common gate (skill, initialised,
//      paused, degraded) inside glance/think, and here for sleep and dispatch.
// Awake: life on → life.isAwakeAt(t); otherwise outside the quiet hours.
// Logs carry codes and counts only.

import * as store from './store.js';
import { now as clockNow, nightKey, localHour, inSleepHours, nextDayKey, daysBeforeKey } from './clock.js';
import { pulse as realPulse } from './pulse.js';
import { runGlance as realGlance, morningPending, glancesToday } from './glance.js';
import { runThink as realThink, thinkGuards, baseGate, recordSkip } from './think.js';
import { runSleep as realSleep } from './sleep.js';
import { dispatchDue as realDispatch, cancelQueued as realCancel } from './proactive.js';
import * as lifeMod from '../life/index.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const MIN = 60;
const HOUR = 3600;
export const FALLBACK_BOOT_MS = 20 * 60_000;
export const FALLBACK_EVERY_MS = 15 * 60_000;
export const ASLEEP_SETTLE_SEC = 30 * MIN;
export const ANCHOR_MAX_AGE_SEC = 12 * HOUR;
export const OWNER_WAIT_MS = 20_000;
const MISSED_MAX = 60;
const INBOX_MAX = 50;

const unrefd = (h) => { try { h?.unref?.(); } catch { /* */ } return h; };

const DEFAULT_DEPS = {
  now: () => clockNow(),
  life: () => lifeMod,
  isMindOn: () => isSkillEnabled('mind'),
  pulse: (info) => realPulse(info),
  runGlance: (trigger, opts) => realGlance(trigger, opts),
  runThink: (trigger, opts) => realThink(trigger, opts),
  runSleep: (nk, trigger) => realSleep(nk, trigger),
  dispatchDue: (sock) => realDispatch(sock),
  cancelQueued: (reason) => realCancel(reason),
  dryRun: () => !!config.dryRun,
  setTimeout: (fn, ms) => unrefd(setTimeout(fn, ms)),
  setInterval: (fn, ms) => unrefd(setInterval(fn, ms)),
  clearTimeout: (h) => clearTimeout(h),
  clearInterval: (h) => clearInterval(h),
  setImmediate: (fn) => setImmediate(fn),
};
let deps = { ...DEFAULT_DEPS };

// ── module state ─────────────────────────────────────────────────────────────

const inbox = [];
let started = false;
let getSock = () => null;
let lastOn = false;          // the skill as the previous pass saw it
let sawPass = false;         // a pass already ran in this process (so off→on is a real runtime edge)
let tickSeen = false;
let bootTimer = null;
let fallbackTimer = null;
let unsubscribe = null;
let pendingAnchors = [];     // [{ id, type, at, seenAt }]
let reachOutWanted = false;  // the last glance said the next think may look for a reach-out
let lastPass = null;         // { at, flags summary } for the status panel

let chain = Promise.resolve();
const queued = new Map();    // key → { promise, opts }
let running = null;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
// A boot whose last pulse (mind_state.last_tick_at) is at most this old is a restart of a
// mind that was on, not an off→on edge: the cursors resume instead of jumping to MAX, so
// a pm2 restart does not drop the day's episode lines or the backlog said while down.
export const RESUME_MAX_GAP_SEC = 6 * 3600;
const nowSec = () => Math.floor(deps.now());
const codeOf = (err) => String(err?.code || err?.name || 'error').slice(0, 60);

function issue(where, err) {
  try { logger.warn({ evt: 'issue', where: `mind.cadence.${where}`, code: codeOf(err) }, 'mind: cadence step failed'); } catch { /* */ }
}

// ── life subscription (at import) ────────────────────────────────────────────

function subscribe(life) {
  if (unsubscribe) { try { unsubscribe(); } catch { /* */ } unsubscribe = null; }
  try {
    if (life && typeof life.onTick === 'function') {
      const off = life.onTick(onLifeTick);
      unsubscribe = typeof off === 'function' ? off : null;
    }
  } catch (err) { issue('subscribe', err); }
}

/**
 * The life tick callback: record, defer, return. Synchronous and O(1) in the tick's
 * size (events are capped); the real work runs later in the serial queue.
 */
export function onLifeTick(view, info = {}) {
  try {
    if (!tickSeen) {
      tickSeen = true;
      if (bootTimer) { deps.clearTimeout(bootTimer); bootTimer = null; }
      if (fallbackTimer) { deps.clearInterval(fallbackTimer); fallbackTimer = null; }
    }
    inbox.push({
      at: fin(info?.at) ? Math.floor(info.at) : null,
      catchUp: !!info?.catchUp,
      events: Array.isArray(info?.events) ? info.events.slice(0, 200) : [],
    });
    if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX);
    deps.setImmediate(drain);
  } catch { /* never throw into life's pulse */ }
}

subscribe(DEFAULT_DEPS.life());

// ── serial queue ─────────────────────────────────────────────────────────────

/**
 * Run fn in the serial queue. A request whose key is already queued (not yet running)
 * returns that job's promise; `merge(opts)` lets it fold its options in first.
 */
function enqueue(key, fn, { opts = null, merge = null } = {}) {
  const q = queued.get(key);
  if (q) {
    if (merge && opts) q.opts = merge(q.opts, opts);
    return q.promise;
  }
  const entry = { opts, promise: null };
  entry.promise = chain.then(async () => {
    queued.delete(key);
    running = key;
    try { return await fn(entry.opts); } finally { running = null; }
  }).catch((err) => { issue(`job.${key.split(':')[0]}`, err); return { status: 'failed' }; });
  chain = entry.promise.then(() => undefined, () => undefined);
  queued.set(key, entry);
  return entry.promise;
}

/** Wait until the inbox is drained and the queue is idle (tests, stopMind). */
export async function idle() {
  for (let i = 0; i < 1000; i++) {
    await new Promise(r => setImmediate(r));
    await chain;
    if (!queued.size && !running && (!inbox.length || !started)) {
      await new Promise(r => setImmediate(r));
      if (!queued.size && !running && (!inbox.length || !started)) return;
    }
  }
}

// ── awake / night rules ──────────────────────────────────────────────────────

function lifeOn(life) {
  try { return !!life && typeof life.isLifeOn === 'function' && life.isLifeOn() === true; } catch { return false; }
}

/** awake(t) = life on ? life.isAwakeAt(t) : outside the quiet hours (research R3). */
export function awakeAt(t) {
  const life = deps.life();
  if (lifeOn(life)) {
    try { return typeof life.isAwakeAt === 'function' ? life.isAwakeAt(t) !== false : true; } catch { return true; }
  }
  return !inSleepHours(t);
}

// The sleep window of a night: from 18:00 to 12:00 local, so an afternoon nap never
// counts as the night's sleep.
function inNightWindow(t) {
  const h = localHour(t);
  return h >= 18 || h < 12;
}

/** The normal sleep: asleep now and for ≥ 30 min, inside the night window. → night key | null */
function sleepNowNight(t) {
  if (!inNightWindow(t)) return null;
  if (awakeAt(t) || awakeAt(t - ASLEEP_SETTLE_SEC)) return null;
  return nightKey(t);
}

/** The latest night whose sleeping time is over (morning after it, or any later time). */
export function lastFinishedNight(t) {
  const k = nightKey(t);
  const h = localHour(t);
  const end = Math.min(11, Math.max(5, Number(config.sleepEndHour) || 0));
  if (h < 12 && h >= end && awakeAt(t)) return k;
  return daysBeforeKey(k, 1);
}

function nightSleepable(nk) {
  const n = store.getNight(nk);
  if (!n) return true;
  if (n.status === 'done' || n.status === 'missed') return false;
  return (Number(n.attempts) || 0) < 3;
}

/**
 * Catch-up planning: the latest finished night with no row gets ONE catch-up sleep;
 * earlier nights since the last known one (never before the night the mind was first
 * enabled) are marked missed. → night key | null
 */
function planCatchUp(t, firstEnabledAt) {
  if (!fin(firstEnabledAt)) return null;
  const minNight = nightKey(firstEnabledAt + 12 * HOUR);
  const L = lastFinishedNight(t);
  if (L < minNight) return null;
  const st = store.getState();
  let from = fin(st.lastSleepAt) ? nextDayKey(nightKey(st.lastSleepAt)) : minNight;
  if (from < minNight) from = minNight;
  let k = from;
  for (let i = 0; i < MISSED_MAX && k < L; i++, k = nextDayKey(k)) {
    if (!store.getNight(k)) store.upsertNight(k, { status: 'missed', finishedAt: t });
  }
  return store.getNight(L) ? null : L;
}

// ── due ──────────────────────────────────────────────────────────────────────

function activitySince(since, t) {
  const from = fin(since) ? since : t - 24 * HOUR;
  try {
    return store.activityFor(Math.floor(from)).some(r => fin(r.lastHumanAt) && r.lastHumanAt > from);
  } catch { return false; }
}

/**
 * What is due at t (pure planning, no model call). flags: the pulse's flags.
 * → { sleep: {nightKey, trigger}|null, glance: bool, think: {trigger}|null, dispatch: bool, awake }
 */
export function due(t = nowSec(), { flags = {}, dueJobs = [] } = {}) {
  const out = { sleep: null, glance: false, think: null, dispatch: false, awake: true };
  const s = store.getSettings();
  const st = store.getState();
  const awake = awakeAt(t);
  out.awake = awake;

  // Never a night that began before the mind was first enabled (nothing to consolidate).
  const minNight = fin(s.firstEnabledAt) ? nightKey(s.firstEnabledAt + 12 * HOUR) : null;
  const nk = sleepNowNight(t);
  if (nk && minNight && nk >= minNight && nightSleepable(nk)) out.sleep = { nightKey: nk, trigger: 'night' };
  else if (awake) {
    const L = planCatchUp(t, s.firstEnabledAt);
    if (L) out.sleep = { nightKey: L, trigger: 'catchup' };
  }

  if (awake) {
    const every = Math.max(1, Number(config.mind?.glanceMinutes ?? 45)) * MIN;
    const gapOk = !fin(st.lastGlanceAt) || t - st.lastGlanceAt >= every || t < st.lastGlanceAt;
    const capOk = glancesToday(t) < Math.max(0, Number(config.mind?.glanceMaxPerDay ?? 20));
    const reason = activitySince(st.lastGlanceAt, t) || pendingAnchors.length > 0
      || (fin(st.nextThinkAt) && st.nextThinkAt <= t) || morningPending(t);
    out.glance = gapOk && capOk && !!reason;
    if (pendingAnchors.length) out.think = { trigger: 'anchor' };
    else if (fin(st.nextThinkAt) && st.nextThinkAt <= t) out.think = { trigger: 'scheduled' };
  }
  out.dispatch = Array.isArray(dueJobs) && dueJobs.includes('dispatch');
  return out;
}

// ── the pass ─────────────────────────────────────────────────────────────────

/** A boot-time edge right after a mind that was on (recent pulse, no observed off). */
function isRestartResume(t) {
  try {
    const st = store.getState();
    return fin(st.lastTickAt) && st.lastTickAt <= t && t - st.lastTickAt <= RESUME_MAX_GAP_SEC;
  } catch { return false; }
}

/** Skill off→on: cursors to MAX, the mode seed, and (not under DRY_RUN) first-live init. */
function onEnable(t, { boot = false } = {}) {
  try {
    if (boot && isRestartResume(t)) {
      logger.info({ evt: 'mind.cadence', at: t }, 'mind: restart with the skill on; cursors resume');
    } else {
      store.seedCursorsToMax();
    }
    store.seedDefaults();
    tryFirstLive(t);
  } catch (err) { issue('enable', err); }
}

/** First-live init (not under DRY_RUN). Also retried on every pass, so DRY_RUN switched off later starts it. */
function tryFirstLive(t) {
  if (deps.dryRun() || store.getSettings().firstEnabledAt != null) return;
  if (store.initFirstLive(t, config.mind?.reviewDays ?? 14)) {
    logger.info({ evt: 'mind.cadence', at: t }, 'mind: first enabled live (review window started)');
  }
}

function mergeInbox(items) {
  const events = [];
  const ids = new Set();
  let at = null;
  let catchUp = false;
  for (const it of items) {
    if (fin(it.at)) at = Math.max(at ?? 0, it.at);
    catchUp = catchUp || it.catchUp;
    for (const e of it.events || []) {
      const id = Number(e?.id);
      if (Number.isFinite(id) && ids.has(id)) continue;
      if (Number.isFinite(id)) ids.add(id);
      events.push(e);
    }
  }
  return { at, catchUp, events };
}

async function runSleepGated(nk, trigger, t) {
  const g = baseGate();
  if (g) return recordSkip('sleep', g, { trigger: trigger === 'catchup' ? 'catchup' : 'night', t });
  return deps.runSleep(nk, trigger);
}

/** One pass. Runs inside the serial queue. → summary (codes and counts only). */
export async function pass(source = 'tick') {
  const items = inbox.splice(0);
  const t = nowSec();
  const info = mergeInbox(items);
  const summary = { at: t, source, ran: [] };
  const on = deps.isMindOn();
  if (on && !lastOn) onEnable(t, { boot: !sawPass });
  if (!on && lastOn) {
    try { deps.cancelQueued('skill_off'); } catch (err) { issue('cancel', err); }
    // An observed off: the next boot must re-seed, not resume (nothing ran while off).
    try { store.patchState({ lastTickAt: null }); } catch (err) { issue('off_mark', err); }
  }
  lastOn = on;
  sawPass = true;
  if (!on) { summary.skipped = 'disabled'; lastPass = summary; return summary; }
  try { tryFirstLive(t); } catch (err) { issue('first_live', err); }

  let flags = {};
  let dueJobs = [];
  try {
    const p = await deps.pulse(info);
    flags = p?.flags || {};
    dueJobs = p?.dueJobs || [];
  } catch (err) { issue('pulse', err); }
  for (const a of Array.isArray(flags.anchors) ? flags.anchors : []) {
    if (!pendingAnchors.some(x => x.id === a.id)) pendingAnchors.push({ id: a.id, type: a.type, at: a.at ?? null, seenAt: t });
  }
  pendingAnchors = pendingAnchors.filter(a => t - a.seenAt <= ANCHOR_MAX_AGE_SEC).slice(-20);

  const plan = due(t, { flags, dueJobs });
  summary.plan = { sleep: plan.sleep?.trigger || null, glance: plan.glance, think: plan.think?.trigger || null, dispatch: plan.dispatch };

  if (plan.sleep) {
    const r = await runSleepGated(plan.sleep.nightKey, plan.sleep.trigger, t);
    summary.ran.push({ kind: 'sleep', status: r?.status ?? null, reason: r?.reason ?? null });
  }

  let think = plan.think ? { ...plan.think } : null;
  if (plan.glance) {
    const r = await deps.runGlance('tick', { anchors: pendingAnchors });
    summary.ran.push({ kind: 'glance', status: r?.status ?? null, reason: r?.reason ?? null, degraded: !!r?.degraded });
    if (r?.status === 'ok') {
      if (r.lookForReachOut) reachOutWanted = true;
      if (r.wantThink && !think) think = { trigger: 'glance' };
    }
  }
  if (think) {
    const r = await deps.runThink(think.trigger, { anchors: pendingAnchors, lookForReachOut: reachOutWanted });
    summary.ran.push({ kind: 'think', status: r?.status ?? null, reason: r?.reason ?? null });
    if (r?.status && r.status !== 'skipped') { pendingAnchors = []; reachOutWanted = false; }
    else if (r?.reason === 'cap' || r?.reason === 'disabled') pendingAnchors = [];
  }

  if (plan.dispatch && !baseGate()) {
    const sock = (() => { try { return getSock(); } catch { return null; } })();
    if (sock) {
      try {
        const r = await deps.dispatchDue(sock);
        summary.ran.push({ kind: 'dispatch', sent: Number(r?.sent) || 0 });
      } catch (err) { issue('dispatch', err); }
    }
  }
  lastPass = summary;
  return summary;
}

function drain() {
  if (!started || !inbox.length) return;
  enqueue('pass', () => pass('tick')).catch(() => {});
}

function fallbackBeat() {
  inbox.push({ at: nowSec(), catchUp: false, events: [], fallback: true });
  if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX);
  drain();
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** startMind's half: started + the fallback timer. Idempotent. */
export function start({ getSock: gs } = {}) {
  if (typeof gs === 'function') getSock = gs;
  if (started) return;
  started = true;
  if (!tickSeen && !bootTimer && !fallbackTimer) {
    bootTimer = deps.setTimeout(() => {
      bootTimer = null;
      if (tickSeen || !started) return;
      fallbackTimer = deps.setInterval(fallbackBeat, FALLBACK_EVERY_MS);
      fallbackBeat();
    }, FALLBACK_BOOT_MS);
  }
  if (inbox.length) deps.setImmediate(drain);
}

/** stopMind's half: timers cleared, drain stopped (the queue is not drained). */
export function stop() {
  started = false;
  if (bootTimer) { deps.clearTimeout(bootTimer); bootTimer = null; }
  if (fallbackTimer) { deps.clearInterval(fallbackTimer); fallbackTimer = null; }
}

export const isStarted = () => started;
/** The life facade the cadence reads (the real one, or a test's). */
export function lifeFacade() { try { return deps.life(); } catch { return null; } }
export const fallbackActive = () => !!fallbackTimer;
export const lastPassSummary = () => lastPass;
export const pendingAnchorCount = () => pendingAnchors.length;

// ── owner "run now" ──────────────────────────────────────────────────────────

const OWNER_REASON = { disabled: 'skill_off', error: 'degraded' };
const ownerReason = (r) => OWNER_REASON[r] || r;

/**
 * Pre-check an owner run (skill, initialised, pause, caps, gap, budget, awake/asleep).
 * → reason (dashboard-api 409 code) | null
 */
export function ownerRunCheck(kind, t = nowSec()) {
  const g = baseGate();
  if (g) return ownerReason(g);
  if (kind === 'glance') {
    if (!awakeAt(t)) return 'asleep';
    if (glancesToday(t) >= Math.max(0, Number(config.mind?.glanceMaxPerDay ?? 20))) return 'cap';
    return null;
  }
  if (kind === 'think') {
    if (!awakeAt(t)) return 'asleep';
    const r = thinkGuards('owner', {});
    return r.reason ? ownerReason(r.reason) : null;
  }
  if (kind === 'sleep') {
    if (awakeAt(t)) return 'awake';
    if (!nightSleepable(nightKey(t))) return 'cap';
    return null;
  }
  return 'bad_request';
}

/**
 * Enqueue an owner run after the pre-check. Waits up to OWNER_WAIT_MS for it.
 * → { runId, status, reason? } | { reason } (refused)
 */
export async function ownerRun(kind) {
  const t = nowSec();
  const reason = ownerRunCheck(kind, t);
  if (reason) return { refused: true, reason };
  const job = enqueue(`owner:${kind}`, async () => {
    if (kind === 'glance') return deps.runGlance('owner', { anchors: pendingAnchors });
    if (kind === 'think') return deps.runThink('owner', { anchors: pendingAnchors, lookForReachOut: true });
    return runSleepGated(nightKey(nowSec()), 'owner', nowSec());
  });
  let timer = null;
  const waited = await Promise.race([
    job,
    new Promise(r => { timer = setTimeout(() => r(null), OWNER_WAIT_MS); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!waited) return { runId: null, status: 'queued' };
  if (waited.status === 'skipped' && typeof waited.reason === 'string') return { refused: true, reason: ownerReason(waited.reason) };
  return { runId: waited.runId ?? null, status: String(waited.status || 'unknown').slice(0, 20) };
}

// ── test seam ────────────────────────────────────────────────────────────────

/**
 * Test seam: { now, life, isMindOn, pulse, runGlance, runThink, runSleep, dispatchDue,
 * cancelQueued, dryRun, setTimeout, setInterval, clearTimeout, clearInterval,
 * setImmediate }. A new `life` is subscribed in place of the old one. null resets
 * deps AND module state (and re-subscribes to the real life facade).
 */
export function __setDepsForTest(d = null) {
  const prevLife = deps.life;
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  if (!d) {
    stop();
    inbox.length = 0;
    lastOn = false;
    sawPass = false;
    tickSeen = false;
    pendingAnchors = [];
    reachOutWanted = false;
    lastPass = null;
    queued.clear();
    getSock = () => null;
  }
  if (!d || (d.life && d.life !== prevLife)) subscribe(deps.life());
}
