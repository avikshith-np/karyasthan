// Preview tomorrow (spec 010 FR-044, research R23, contracts/director-api.md §5):
// the next 24 hours of his life, simulated on a copy of the projection.
// No model calls and no writes: a second 009 pulse runs over a structuredClone
// with an in-memory appender (simAppend is the ONLY appender here), Jev
// switched off (noJev wrappers on open and evaluate, so every lean is the code
// softmax), and the story's items in `sim:true` mode (no reconciler, journal,
// weekly or store I/O; controls and store writers are no-ops; refusals come
// back in memory). `isEnabled: () => true` keeps 009's evening invitation.
//
//   previewTomorrow(state, world, { storyItems, worldOf, blockCause, planCause, now, hours })
//     → { from, to, planned, birthdays, beats, decisions, heavy, refusals, notes }
//   simulate(state, world, { …the same, rng, sampleSec })
//     → { from, to, log, samples }   one run (Life · Day runs several: `rng`
//     replaces only the deadline sample of decisions, so runs differ in how he
//     decides while his routine, weather and story rolls stay the install
//     seed's — what the live pulse will roll)

import { config } from '../../utils/config.js';
import { now as clockNow } from '../clock.js';
import { project, vitalsAt } from '../projector.js';
import { createPulse } from '../pulse.js';
import { openDecision, evaluate as evaluateDecisions } from '../decisions.js';
import { EVENT_TYPES, getEvent as getEventReal, eventsAfter as eventsAfterReal } from '../eventLog.js';
import { isHeavy, startFromHeavy } from '../embargo.js';
import { worldOverlay } from './reducer.js';

const HOUR = 3600;
const STEP_MINUTES = 15;
const MAX_SIM_EVENTS = 5000;
const BEAT_TYPES = new Set(['cast.beat', 'cast.updated', 'relationship.changed', 'story.daily_done', 'arc.started', 'arc.stage',
  'arc.ended', 'family.call', 'family.occasion', 'career.appraisal', 'career.hunt']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const CHAT_KINDS = new Set(['group', 'dm', 'call', 'ig']);

/**
 * An in-memory log over a copy of `state`: append(spec) folds through the real
 * projector with ids above the real log, origins derived as appendEvent does,
 * and a heavy event's embargo follow-up as the facade's makeAppend does.
 */
export function createSimLog(state, world, { beforeFold = null } = {}) {
  let sim = structuredClone(state);
  const baseLast = state.lastEventId;
  const events = [];
  const getEvent = (id) => (id > baseLast ? events.find(e => e.id === id) ?? null : getEventReal(id));
  // (afterId, limit?): a limit is a page size, as eventLog.eventsAfter's (batch 3 review 41: the pulse
  // pages its log reads by 500); no limit reads as before.
  const eventsAfter = (afterId = 0, limit) => {
    const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
    const out = afterId >= baseLast ? events.filter(e => e.id > afterId)
      : [...(lim ? eventsAfterReal(afterId, lim) : eventsAfterReal(afterId)).filter(e => e.id <= baseLast), ...events];
    return lim ? out.slice(0, lim) : out;
  };
  const append = (spec) => {
    if (!isObj(spec) || !EVENT_TYPES.has(spec.type)) throw new Error('sim: unknown event type');
    if (events.length >= MAX_SIM_EVENTS) throw new Error('sim: too many events');
    const id = baseLast + events.length + 1;
    const cause = spec.causeId != null ? getEvent(spec.causeId) : null;
    let originKind = spec.originKind ?? null;
    let originJid = spec.originJid ?? null;
    if (!originKind) {
      if (spec.actor === 'owner') { originKind = 'owner'; originJid = 'owner'; } else if (cause && CHAT_KINDS.has(cause.originKind)) {
        originKind = cause.originKind; originJid = cause.originJid;
      } else { originKind = 'self'; originJid = 'self'; }
    }
    const ev = {
      id, at: Number.isInteger(spec.at) ? spec.at : Math.floor(clockNow()), recordedAt: null, type: spec.type,
      actor: spec.actor, causeId: cause ? cause.id : null, payload: structuredClone(spec.payload ?? {}),
      originKind, originJid: originJid ?? originKind, subjectJid: spec.subjectJid ?? null, heavy: spec.heavy === true, redacted: false,
    };
    events.push(ev);
    if (beforeFold) beforeFold(sim, ev);
    sim = project(sim, ev, world);
    if (isHeavy(ev)) {
      const { events: follow } = startFromHeavy(ev, sim.embargo, { hours: config.life?.embargoHours });
      for (const e of follow) append(e);
    }
    return ev;
  };
  return { getState: () => sim, append, getEvent, eventsAfter, events, baseLast };
}

function planBlocks(state, events, from, to, { marks = false } = {}) {
  const plans = [];
  if (isObj(state.plan)) plans.push({ ...state.plan });
  for (const e of events) if (e.type === 'plan.made') plans.push({ ...e.payload, at: e.at });
  const lastByDate = new Map();
  for (const p of plans) if (typeof p.date === 'string') lastByDate.set(p.date, p);
  const out = [];
  for (const p of [...lastByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (const b of Array.isArray(p.blocks) ? p.blocks : []) {
      if (!finite(b?.start) || !finite(b?.end) || b.end <= from || b.start >= to) continue;
      out.push({ kind: b.kind, placeId: b.placeId ?? null, start: b.start, end: b.end, availability: b.availability ?? null,
        ...(marks && b.fromOverride ? { fromOverride: true } : {}), ...(marks && b.kind === 'commute' ? { from: b.from ?? null, to: b.to ?? null } : {}) });
    }
  }
  return out;
}

/**
 * One run of the pulse over the next `hours` (24) from `now` on a copy of
 * `state`. opts: previewTomorrow's, plus `rng` (a generator for the decisions'
 * deadline sample; default the keyed install-seed roll) and `sampleSec` (> 0:
 * his vitals every sampleSec on a grid from `now`, read just before each
 * folded event, so a sample sees the activity then in force).
 * 015 (cont §P2.3, review #35) adds: `anchorFirst` (the pulse runs to `now`
 * before the descriptors are appended, so a before and an after run start from
 * the same anchor and a no-op gives identical runs), `closeChatMood` (start
 * from a copy with `chatMood: []` and sample `vitalsBase`: the 012 overlay is
 * closed for the run), `appendDescriptors(list, append)` (the caller's
 * appender; default the Director's) and `deadlineAt` (an absolute ms deadline,
 * like deadlineMs). A failed append → `failed: true` (nothing more is run).
 * → { from, to, log (createSimLog), samples: [{ at, vitals }], timedOut?, failed? }
 */
export async function simulate(state, world, opts = {}) {
  if (!isObj(state) || state.genesisAt === null || state.genesisAt === undefined) {
    throw Object.assign(new Error('story: not_running'), { name: 'StoryError', code: 'not_running' });
  }
  const from = Math.floor(finite(opts.now) ? opts.now : clockNow());
  const to = from + Math.round((finite(opts.hours) ? opts.hours : 24) * HOUR);
  const step = finite(opts.sampleSec) && opts.sampleSec >= 60 ? Math.floor(opts.sampleSec) : 0;
  const samples = [];
  let next = step ? Math.ceil(from / step) * step : Infinity;
  const sampleUpTo = (s, t) => {
    for (; next <= to && next <= t; next += step) {
      if (!closeMood) { samples.push({ at: next, vitals: vitalsAt(s, next, world) }); continue; }
      let v = null;
      try { v = vitalsAt(s, next, world, { chatMood: false }); } catch { v = null; }
      if (v) samples.push({ at: next, vitals: v });
    }
  };
  const closeMood = opts.closeChatMood === true;
  const start = closeMood ? { ...state, chatMood: [] } : state;
  const log = createSimLog(start, world, { beforeFold: step ? (s, ev) => { if (ev.at > next) sampleUpTo(s, ev.at - 1); } : null });
  const rng = typeof opts.rng === 'function' ? opts.rng : null;
  const withRng = (ctx) => (rng ? { ...ctx, noJev: true, rng } : { ...ctx, noJev: true });
  const refusals = Array.isArray(opts.refusals) ? opts.refusals : [];
  const storyItems = typeof opts.storyItems === 'function'
    ? (s, g) => opts.storyItems(s, g, { sim: true, refusals, getState: () => log.getState() })   // run-time re-reads see the sim's state
    : undefined;
  const pulse = createPulse({
    world,
    worldOf: typeof opts.worldOf === 'function' ? opts.worldOf : (s) => worldOverlay(s, world),
    getState: log.getState,
    append: log.append,
    now: () => from,
    tickMinutes: STEP_MINUTES,
    // The window must replay, never collapse into a re-anchor (the live cap is 72 h).
    catchupHours: Math.max(Number(config.life?.catchupHours) || 72, (to - from) / HOUR + 24),
    isEnabled: () => true,
    eventsAfter: log.eventsAfter,
    getEvent: log.getEvent,
    openDecision: (g, spec, ctx) => openDecision(g, spec, withRng(ctx)),
    evaluateDecisions: (g, ctx) => evaluateDecisions(g, withRng(ctx)),
    ...(storyItems ? { storyItems } : {}),
    ...(typeof opts.blockCause === 'function' ? { blockCause: opts.blockCause } : {}),
    ...(typeof opts.planCause === 'function' ? { planCause: opts.planCause } : {}),
    // 015: the owner's planned wake nudges, as the live pulse appends them.
    ...(typeof opts.atWake === 'function' ? { atWake: opts.atWake } : {}),
    setInterval: () => null,
    clearInterval: () => {},
  });
  // 014 sched (R35): descriptors (a Director preview's events) are appended first
  // through the Director's appender, so their refs resolve; with deadlineMs the run
  // goes in one-hour chunks and stops early with timedOut.
  // 015 cont (review #35): with anchorFirst the pulse reaches `now` first, then the batch lands.
  if (opts.anchorFirst === true) await pulse.runTo(from);
  if (Array.isArray(opts.descriptors) && opts.descriptors.length) {
    const appendFn = typeof opts.appendDescriptors === 'function' ? opts.appendDescriptors : (await import('./director.js')).appendDescriptors;
    try {
      appendFn(opts.descriptors, log.append);
    } catch (e) {
      if (typeof opts.appendDescriptors !== 'function') throw e;
      return { from, to, log, samples, failed: true };
    }
  }
  if (finite(opts.deadlineMs) || finite(opts.deadlineAt)) {
    const deadline = finite(opts.deadlineAt) ? opts.deadlineAt : Date.now() + Math.max(0, opts.deadlineMs);
    for (let t = from + HOUR; ; t = Math.min(to, t + HOUR)) {
      await pulse.runTo(t);
      if (t >= to) break;
      if (Date.now() > deadline) return { from, to, log, samples, timedOut: true };
    }
  } else {
    await pulse.runTo(to);
  }
  if (step) sampleUpTo(log.getState(), to);
  return { from, to, log, samples };
}

/**
 * 014 sched: the plan rows of a run for [from, to) — the newest plan per date,
 * as preview tomorrow lists them (+ fromOverride marks).
 */
export function planRows(state, events, from, to) {
  return planBlocks(state, events, from, to, { marks: true });
}

// Open goals at the start, as the sim leaves them: planned slot or the last deferral.
function goalsOf(before, after, from) {
  const was = isObj(before?.goals) ? before.goals : {};
  const now = isObj(after?.goals) ? after.goals : {};
  return Object.values(now).filter(g => isObj(g) && (g.status === 'open' || g.status === 'fitted'
    || (was[g.id] && (was[g.id].status === 'open' || was[g.id].status === 'fitted')) || (finite(g.setAt) && g.setAt >= from)))
    .slice(0, 8).map(g => ({
      id: g.id, goalKind: g.goalKind, castId: g.castId ?? null, placeId: g.placeId ?? null, status: g.status,
      slotStart: g.fitted?.slotStart ?? null, lastReason: g.lastTry?.reason ?? null,
    }));
}

/**
 * Simulate the next `hours` (24) from `now` on a copy of `state`.
 * opts: { storyItems (s, g, {sim:true}) → items, worldOf, blockCause, planCause, now, hours, refusals: [] }
 */
export async function previewTomorrow(state, world, opts = {}) {
  const refusals = Array.isArray(opts.refusals) ? opts.refusals : [];
  const { from, to, log } = await simulate(state, world, { ...opts, refusals, rng: null, sampleSec: 0 });
  const evs = log.events;
  const leanOf = (id) => {
    const l = [...evs].reverse().find(e => e.type === 'decision.lean' && e.payload?.decisionId === id);
    return l ? { optionId: l.payload.optionId ?? null, p: finite(l.payload.p) ? l.payload.p : null } : null;
  };
  const props = state.story?.heavy?.proposals ?? {};
  const pending = Object.values(props).filter(p => isObj(p) && p.status === 'pending' && finite(p.onsetAt) && p.onsetAt <= to)
    .sort((a, b) => a.onsetAt - b.onsetAt)[0];
  const started = evs.find(e => e.type === 'heavy.started');
  return {
    from, to,
    planned: planBlocks(state, evs, from, to),
    birthdays: evs.filter(e => e.type === 'birthday').map(e => ({ castId: e.payload?.castId ?? null, at: e.at })),
    beats: evs.filter(e => BEAT_TYPES.has(e.type)).map(e => ({ type: e.type, ...(e.payload?.castId ? { castId: e.payload.castId } : {}), at: e.at })),
    decisions: evs.filter(e => e.type === 'decision.opened').map(e => ({
      kind: e.payload?.kind ?? null, category: e.payload?.category ?? null, opensAt: e.payload?.opensAt ?? e.at,
      decideBy: e.payload?.decideBy ?? null, big: e.payload?.big === true, leanFromCosts: leanOf(e.id),
    })),
    heavy: started ? { onsetAt: started.at, kind: started.payload?.kind ?? null } : (pending ? { onsetAt: pending.onsetAt, kind: pending.kind } : null),
    // 011: the simulated weather (owner windows marked) and the goals he'd fit.
    weather: evs.filter(e => e.type === 'weather.changed').slice(0, 24).map(e => ({
      at: e.at, condition: typeof e.payload?.condition === 'string' ? e.payload.condition : null,
      tempC: finite(e.payload?.tempC) ? e.payload.tempC : null, rain: e.payload?.rain === true,
      ...(Number.isSafeInteger(e.payload?.windowId) ? { owner: true } : {}),
    })),
    goals: goalsOf(state, log.getState(), from),
    refusals: refusals.slice(0, 50),
    events: evs.length,
    notes: ['no model calls', 'nothing written'],
  };
}
