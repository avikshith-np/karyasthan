// 010 T011 — the pulse's story seams (src/life/pulse.js, story-api §3.4,
// research R4/R7/R9). Scratch DB, fake clock, mocked Jev, no network.
//
//   1. default seams = today's pulse: a 7-day run with this pulse.js equals a
//      7-day run with a73cb7f's pulse.js (loaded from git into a scratch copy
//      whose imports point at the current modules), apart from the three
//      additive amendment fields; seams that throw or return junk also fall
//      back to it;
//   2. story items: time order, serialized, catch-up = live, a throwing / empty
//      item is retired and wake, blocks and sleep keep advancing;
//   3. the story's blockCause / planCause: only an adopted outing's blocks carry
//      the chat origin; work.late, sleep.started, the next woke and a later
//      evening invitation stay self; reverting the decision or the amended
//      plan.made mid-outing excludes the outing's events;
//   4. worldOf at the world reads (salary, invitation spend, decisions' world),
//      subjectJid on block events, the eventsAfter/getEvent seams and rebase().
import { setupScratchDb, fakeClock, fakeJev, jevChoice, section, check, eq, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import {
  appendEvent, eventsAfter, getEvent, listEvents, revertEvent, lastEventId,
} from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild, saveSnapshot } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters, openDecision, evaluate as evaluateReal } from '../../src/life/decisions.js';
import * as NEW from '../../src/life/pulse.js';
// 018: the comparison is with a pre-wallet pulse — run the pre-018 engine (no itemized spending).
import { __setWalletForTest } from '../../src/life/spending.js';
__setWalletForTest(false);

const { eveningProposal, amendPlanForOuting, applyTimeOf, PROPOSAL_P } = NEW;
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (month, day, h, m = 0) => zonedToUnix(2026, month, day, h, m, tz);
const T0 = local(10, 26, 5);            // Mon 26 Oct 05:00, asleep
const END = T0 + 7 * 86400;
const MIN = 60;
const ALICE = '155590000001@s.whatsapp.net';
const MON = '2026-10-26';
const SAT = '2026-10-31';

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

// The seed of 16-pulse: Monday runs late, Saturday brings an evening invitation.
let seed = null;
for (let s = 1; s < 500 && seed === null; s++) {
  setRngSeed(s);
  if (rngFor(MON, 'work.late')() < 0.3 && rngFor(SAT, 'decision:evening')() < PROPOSAL_P * 0.8) seed = s;
}
setRngSeed(seed ?? 1);

const jev = fakeJev((req) => {
  const ids = Object.keys(req?.questions?.pick?.criteria || {});
  const probs = {};
  for (const id of ids) probs[id] = id === 'go' ? 0.9 : 0.1 / Math.max(1, ids.length - 1);
  return { pick: jevChoice(ids.includes('go') ? 'go' : ids[0], probs) };
});
setJev(jev.fn);

// ── The story layer's seam functions (story-api §3.4, research R4) ─────────
const storyBlockCause = (plan, b) => (b?.fromAmendment ? plan.eventId : (plan.basePlanEventId ?? plan.eventId));
const storyPlanCause = (plan) => plan.basePlanEventId ?? plan.eventId;
const STORY_SEAMS = { blockCause: storyBlockCause, planCause: storyPlanCause };

// T009 (projector) keeps plan.basePlanEventId and the blocks' fromAmendment /
// subjectJid. Until it lands, re-attach them from the plan.made payload — the
// same fields the projector will fold — so the seams can be exercised now.
let shimUsed = 0;
function shim(s) {
  const plan = s?.plan;
  if (!plan || !Number.isSafeInteger(plan.eventId)) return s;
  const p = getEvent(plan.eventId)?.payload;
  if (!p || !Array.isArray(p.blocks)) return s;
  let patched = false;
  if (Number.isSafeInteger(p.basePlanEventId) && plan.basePlanEventId !== p.basePlanEventId) {
    plan.basePlanEventId = p.basePlanEventId;
    patched = true;
  }
  for (const pb of p.blocks) {
    if (!pb?.fromAmendment && !pb?.subjectJid) continue;
    const b = plan.blocks.find(x => x.kind === pb.kind && x.start === pb.start && x.end === pb.end);
    if (!b) continue;
    if (pb.fromAmendment && b.fromAmendment !== true) { b.fromAmendment = true; patched = true; }
    if (pb.subjectJid && b.subjectJid !== pb.subjectJid) { b.subjectJid = pb.subjectJid; patched = true; }
  }
  if (patched) shimUsed++;
  return s;
}

// One run: fresh scratch DB, genesis at T0, a 15-min tick until `until`.
// hook(sim) runs after each tick; returning 'stop' ends the run there.
async function simulate({ mod = NEW, deps = {}, downtime = null, until = END, hook = null, useShim = false } = {}) {
  await setupScratchDb();
  resetDecisionCounters();
  jev.reset();
  const clock = fakeClock(T0);
  setClock(clock.fn);
  const fold = (s) => (useShim ? shim(s) : s);
  const sim = { clock, live: createInitialState(world) };
  sim.append = (spec) => {
    const ev = appendEvent(spec);
    sim.live = fold(applyAppended(sim.live, ev, { world }));
    return ev;
  };
  sim.rebuild = () => { sim.live = fold(rebuild({ world })); };
  mod.genesis(sim.append, world, T0, { vitals: { workPressure: 95 } });
  const boot = () => mod.createPulse({
    world, getState: () => sim.live, append: sim.append, now: clock.fn, tickMinutes: 15,
    onDay: (s) => saveSnapshot(s), ...deps,
  });
  sim.pulse = boot();
  let downDone = false;
  while (clock.now() < until) {
    if (downtime && !downDone && clock.now() >= downtime.at) {
      downDone = true;
      sim.live = null;
      clock.advance({ hours: downtime.hours });
      sim.rebuild();
      sim.pulse = boot();
      await sim.pulse.tick();
      continue;
    }
    clock.advance({ minutes: 15 });
    await sim.pulse.tick();
    if (hook && (await hook(sim)) === 'stop') break;
  }
  sim.events = eventsAfter(0, 50000);
  return sim;
}

// Logs compared with ids replaced by positions (16-pulse's shape). `strip`
// drops the additive 010 amendment fields, which a73cb7f never wrote, and 011's
// additive rain-gear fields (plan.gear, a commute's gear/exposed): both runs plan
// mornings with today's routine.planDay, but a73cb7f's outing rewrite doesn't carry
// them. The trips themselves (modes, times, costs) are still compared.
const ADDED = new Set(['basePlanEventId', 'fromAmendment', 'subjectJid', 'gear', 'exposed']);
const ID_KEYS = new Set(['decisionId', 'amendedFor', 'basePlanEventId']);
function shape(list, { strip = false } = {}) {
  const idx = new Map(list.map((e, i) => [e.id, i]));
  const swap = (p) => JSON.parse(JSON.stringify(p, (k, v) => {
    if (strip && ADDED.has(k)) return undefined;
    return ID_KEYS.has(k) && Number.isInteger(v) ? `#${idx.get(v)}` : v;
  }));
  return list.map(e => JSON.stringify([e.type, e.at, e.actor, e.causeId === null ? null : idx.get(e.causeId),
    e.originKind, e.subjectJid ?? null, swap(e.payload)]));
}
function sameLog(name, a, b) {
  const firstDiff = a.length === b.length ? a.findIndex((x, i) => x !== b[i]) : Math.min(a.length, b.length);
  return check(name, a.length === b.length && firstDiff === -1,
    firstDiff === -1 ? undefined : { lenA: a.length, lenB: b.length, i: firstDiff, a: a[firstDiff]?.slice(0, 260), b: b[firstDiff]?.slice(0, 260) });
}

// a73cb7f's pulse.js, its relative imports pointed at the current modules (so
// the comparison isolates pulse.js). Null when git can't produce it.
const BASE_DIR = path.join(PROJECT_ROOT, 'data', `life-test-27-baseline-${process.pid}`);
process.on('exit', () => { try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* gone */ } });
async function loadBaselinePulse() {
  let src;
  try {
    src = execFileSync('git', ['-C', PROJECT_ROOT, 'show', 'a73cb7f:src/life/pulse.js'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const lifeDir = path.join(PROJECT_ROOT, 'src', 'life');
  const out = src.replace(/from '(\.{1,2}\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(path.resolve(lifeDir, rel)).href}'`);
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const file = path.join(BASE_DIR, 'pulse-a73cb7f.js');
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const ofType = (evs, t) => evs.filter(e => e.type === t);
const day = (e) => dateKey(e.at, tz);
const wokePlan = (evs, date) => evs.find(e => e.type === 'plan.made' && e.payload?.date === date && getEvent(e.causeId)?.type === 'woke');

try {
  section('setup');
  check('found a seed for the scenarios', seed !== null, seed);

  // ── 1. Default seams = a73cb7f ─────────────────────────────────────────
  section('default seams: the 7-day run equals a73cb7f\'s pulse');
  const OLD = await loadBaselinePulse();
  const A = await simulate();
  const aShape = shape(A.events, { strip: true });
  if (!OLD) {
    console.log('  (skip: git cannot show a73cb7f:src/life/pulse.js here)');
  } else {
    const O = await simulate({ mod: OLD });
    check('the baseline wrote a full week', O.events.length > 300 && ofType(O.events, 'woke').length === 7, O.events.length);
    sameLog('identical log to a73cb7f (types, times, actors, causes, origins, subjects, payloads)', aShape, shape(O.events, { strip: true }));
    const amendedOld = O.events.find(e => e.type === 'plan.made' && Number.isSafeInteger(e.payload?.amendedFor));
    check('… including a committed evening outing (the amendment path is covered)', !!amendedOld);
  }
  const amended = A.events.find(e => e.type === 'plan.made' && Number.isSafeInteger(e.payload?.amendedFor));
  const satMorning = wokePlan(A.events, SAT);
  eq('the amended plan.made names its base (the self morning plan)', amended?.payload.basePlanEventId, satMorning?.id);
  const marked = (amended?.payload.blocks || []).filter(b => b.fromAmendment);
  const outingKind = getEvent(amended?.payload.amendedFor)?.payload?.kind;
  check('only the outing and its commutes are marked fromAmendment',
    marked.length >= 1 && marked.length <= 3 && marked.every(b => b.kind === 'commute' || b.kind === outingKind)
    && marked.some(b => b.kind === outingKind), marked.map(b => b.kind));
  check('… and no 009 decision carries a subject, so no block does', (amended?.payload.blocks || []).every(b => !('subjectJid' in b)));
  check('the morning plans carry no 010 fields', A.events.filter(e => e.type === 'plan.made' && !e.payload?.amendedFor)
    .every(e => !('basePlanEventId' in e.payload) && e.payload.blocks.every(b => !('fromAmendment' in b))));

  const I = await simulate({ deps: { storyItems: () => [], worldOf: () => world, blockCause: (p) => p.eventId, planCause: (p) => p.eventId } });
  sameLog('explicit identity seams = the defaults', shape(I.events), shape(A.events));
  const boom = () => { throw new Error('seam boom'); };
  const J = await simulate({ deps: { storyItems: boom, worldOf: boom, blockCause: boom, planCause: boom } });
  sameLog('seams that throw fall back to the defaults', shape(J.events), shape(A.events));
  const K = await simulate({ deps: { storyItems: () => 'junk', worldOf: () => 42, blockCause: () => 'x', planCause: () => -0.5 } });
  sameLog('seams that return junk fall back to the defaults', shape(K.events), shape(A.events));
  // The comparison is not vacuous: a valid but different cause seam shows up.
  const N = await simulate({ deps: { planCause: (p) => getEvent(p.eventId)?.causeId ?? p.eventId } });
  check('a different (valid) planCause changes the log (the comparison bites)', JSON.stringify(shape(N.events)) !== JSON.stringify(shape(A.events)));

  // ── 2. Story items ─────────────────────────────────────────────────────
  section('story items: time order, serialized, catch-up = live');
  const doneDates = () => new Set(listEvents({ types: ['story.daily_done'], limit: 1000 }).map(e => e.payload?.date));
  let inFlight = 0;
  let maxInFlight = 0;
  let dailyRuns = 0;
  // A daily item like R7's: due at wake + 5 min once per plan date; "done" is
  // read from the log (never a closure), so a restart doesn't repeat it.
  const daily = (s) => {
    const plan = s.plan;
    if (!plan || !Number.isSafeInteger(plan.wakeAt) || doneDates().has(plan.date)) return [];
    const at = plan.wakeAt + 5 * MIN;
    return [{
      at, prio: 9, label: 'daily', id: plan.date,
      async run(add) {
        dailyRuns++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 1));
        add({ type: 'story.daily_done', at, actor: 'engine', payload: { date: plan.date, rolls: {}, counts: { events: 0, beats: 0, drift: 0 } } });
        inFlight--;
      },
    }];
  };
  const S1 = await simulate({ deps: { storyItems: daily } });
  const dd = ofType(S1.events, 'story.daily_done');
  eq('one daily item per day, Mon–Sun', dd.map(e => e.payload.date), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  check('each dated at its own time (wake + 5 min), self, no cause',
    dd.every(e => e.at === wokePlan(S1.events, e.payload.date)?.payload.wakeAt + 5 * MIN && e.originKind === 'self' && e.causeId === null));
  const pos = new Map(S1.events.map((e, i) => [e.id, i]));
  check('in time order among the 009 items (the log around it is time-ordered)', dd.every(e => {
    const i = pos.get(e.id);
    return S1.events[i - 1].at <= e.at && (!S1.events[i + 1] || S1.events[i + 1].at >= e.at);
  }));
  const noStory = shape(A.events);
  sameLog('the 009 events are untouched by the story items', shape(S1.events.filter(e => e.type !== 'story.daily_done')), noStory);
  eq('never two items in flight (async item, serialized with the tick)', maxInFlight, 1);
  dailyRuns = 0;
  const S2 = await simulate({ deps: { storyItems: daily }, downtime: { at: local(10, 28, 4), hours: 30 } });
  sameLog('a 30 h downtime catch-up writes the same log as live', shape(S2.events), shape(S1.events));
  eq('… with one run per day (no repeat after the restart)', dailyRuns, 7);

  // Two overlapping runTo calls while an item awaits.
  await setupScratchDb();
  resetDecisionCounters();
  {
    const clock = fakeClock(T0);
    setClock(clock.fn);
    let live = createInitialState(world);
    const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
    NEW.genesis(append, world, T0, { vitals: { workPressure: 95 } });
    inFlight = 0; maxInFlight = 0;
    const p = NEW.createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15, storyItems: daily });
    const r1 = p.runTo(T0 + 6 * 3600);
    const r2 = p.runTo(T0 + 12 * 3600);
    const r3 = p.tick();
    await Promise.all([r1, r2, r3]);
    eq('overlapping runTo calls stay serialized (max one item in flight)', maxInFlight, 1);
    eq('… and the day\'s item ran once', listEvents({ types: ['story.daily_done'], limit: 10 }).length, 1);
  }

  section('story items: a throwing or empty item is retired');
  const offered = { boom: 0, empty: 0, wedge: 0 };
  const bad = (s, g) => {
    const out = daily(s, g);
    const plan = s.plan;
    if (plan?.date === '2026-10-27') {
      out.push({ at: plan.wakeAt + 10 * MIN, label: 'boom', id: 'x', run: () => { offered.boom++; throw new Error('story item boom'); } });
    }
    if (plan?.date === '2026-10-28') {
      out.push({ at: plan.wakeAt + 10 * MIN, label: 'empty', id: 'y', run: async () => { offered.empty++; } });
    }
    // Due in the past for good (an item that would wedge the pulse if re-offered first every step).
    if (plan?.date === '2026-10-29') out.push({ at: plan.wakeAt, label: 'wedge', run: () => { offered.wedge++; } });
    return out;
  };
  const S3 = await simulate({ deps: { storyItems: bad } });
  eq('the throwing item ran once', offered.boom, 1);
  eq('the item that appended nothing ran once', offered.empty, 1);
  eq('an always-due empty item ran once (not re-offered every step)', offered.wedge, 1);
  eq('wake, plans and sleep keep advancing all week', [ofType(S3.events, 'woke').length, ofType(S3.events, 'sleep.started').length], [7, 8]);
  sameLog('the 009 log is the same as without the bad items', shape(S3.events.filter(e => e.type !== 'story.daily_done')), noStory);
  // Review regression: an item dated max(…, s.at) floats with every tick; its
  // stable key (not `at`) must keep it retired after a half-applied run.
  const floats = { n: 0 };
  const floating = (s, g) => {
    const out = daily(s, g);
    const plan = s.plan;
    if (plan?.date === '2026-10-27') {
      out.push({ at: Math.max(plan.wakeAt + 10 * MIN, s.at ?? 0), label: 'float', id: '2026-10-27', key: 'float|2026-10-27',
        run: (add) => { floats.n++; add({ type: 'meal', at: Math.max(plan.wakeAt + 10 * MIN, s.at ?? 0), actor: 'engine', payload: { kind: 'snack' } }); throw new Error('half applied'); } });
    }
    return out;
  };
  await simulate({ deps: { storyItems: floating }, until: T0 + 3 * 86400 });
  eq('a floating item that appended then threw ran once (stable key)', floats.n, 1);
  let itemsCalled = 0;
  const S4 = await simulate({ deps: { storyItems: () => { itemsCalled++; throw new Error('items boom'); } }, until: T0 + 2 * 86400 });
  check('storyItems() itself throwing never stops the day', itemsCalled > 0 && ofType(S4.events, 'woke').length === 2);

  // ── 3. Story causes: the chat origin stays on the outing ───────────────
  section('story seams: an adopted (chat-origin) outing taints only its own blocks');
  // A decision opened from a chat (the reconciler adoption shape: an engine
  // decision caused by a chat-actor event), committed by Jev → the outing.
  const chatOuting = (state) => async (sim) => {
    if (state.opened || sim.live.plan?.date !== SAT || sim.clock.now() < sim.live.plan.wakeAt + 30 * MIN) return null;
    const pr = eveningProposal(sim.live.plan, sim.live, world);
    if (!pr) { state.opened = 'none'; return 'stop'; }
    const trig = sim.append({ type: 'chat.trigger', at: sim.clock.now(), actor: 'chat', originKind: 'dm', originJid: ALICE, payload: { kind: 'plan' } });
    await openDecision(() => sim.live, pr.spec, { world, at: sim.clock.now(), append: sim.append, causeId: trig.id });
    state.opened = trig.id;
    return null;
  };
  const runOuting = async ({ story, stopMidOuting = false }) => {
    const st = {};
    const opener = chatOuting(st);
    const sim = await simulate({
      deps: story ? STORY_SEAMS : {}, useShim: true,
      hook: async (s) => {
        if ((await opener(s)) === 'stop') return 'stop';
        if (!stopMidOuting || !Number.isSafeInteger(st.opened)) return null;
        const evs = eventsAfter(st.opened, 5000);
        const plan = evs.find(e => e.type === 'plan.made' && e.payload?.amendedFor);
        const out = plan && evs.find(e => e.type === 'activity.started' && e.causeId === plan.id && e.payload.kind === plan.payload.blocks.find(b => b.fromAmendment && b.kind !== 'commute')?.kind);
        if (out && s.clock.now() < out.payload.end - 15 * MIN) return 'stop';
        return null;
      },
    });
    return { sim, trig: st.opened };
  };

  const D = await runOuting({ story: false });
  const S = await runOuting({ story: true });
  const outingParts = (run) => {
    const evs = run.sim.events;
    const rewrite = evs.find(e => e.type === 'plan.made' && e.payload?.amendedFor);
    const base = wokePlan(evs, SAT);
    const outBlocks = (rewrite?.payload.blocks || []).filter(b => b.fromAmendment);
    const isOutingEv = (e) => {
      const root = e.type === 'money.spent' || e.type === 'meal' ? getEvent(e.causeId) : e;
      if (!root || root.causeId !== rewrite?.id) return false;
      const b = root.type === 'travel.started' ? outBlocks.find(x => x.kind === 'commute' && x.start === root.at)
        : root.type === 'activity.started' ? outBlocks.find(x => x.kind === root.payload.kind && x.start === root.at) : null;
      return !!b;
    };
    const sleepAfter = evs.find(e => e.type === 'sleep.started' && e.id > (rewrite?.id ?? Infinity));
    const sunWoke = evs.find(e => e.type === 'woke' && day(e) === '2026-11-01');
    const between = evs.filter(e => e.id > (rewrite?.id ?? Infinity) && e.id < (sleepAfter?.id ?? -1));
    return { evs, rewrite, base, outBlocks, isOutingEv, sleepAfter, sunWoke, between };
  };
  check('the chat-origin decision was opened on Saturday', Number.isSafeInteger(S.trig) && Number.isSafeInteger(D.trig), { S: S.trig, D: D.trig });
  const s = outingParts(S);
  const d = outingParts(D);
  eq('the commit and the amended plan carry the DM origin', [s.rewrite?.originKind, getEvent(s.rewrite?.causeId)?.originKind], ['dm', 'dm']);
  const outingEvs = s.between.filter(s.isOutingEv);
  check('the outing\'s events (trip there, the outing, trip back) carry the DM origin',
    outingEvs.length >= 2 && outingEvs.every(e => e.originKind === 'dm' && e.originJid === ALICE), outingEvs.map(e => `${e.type}:${e.originKind}`));
  const rest = s.between.filter(e => !s.isOutingEv(e) && ['activity.started', 'meal', 'activity.ended', 'travel.arrived', 'money.spent'].includes(e.type)
    && (e.type !== 'activity.ended' && e.type !== 'travel.arrived'));
  check('the blocks after the outing (dinner / free time) are self, caused by the base plan',
    rest.filter(e => e.type === 'activity.started').length >= 1
    && rest.filter(e => e.type === 'activity.started').every(e => e.originKind === 'self' && e.causeId === s.base?.id),
    rest.map(e => `${e.type}:${e.originKind}:${e.causeId}`));
  eq('the night\'s sleep.started is self, caused by the base plan', [s.sleepAfter?.originKind, s.sleepAfter?.causeId], ['self', s.base?.id]);
  eq('Sunday\'s woke is self and still linked to that sleep', [s.sunWoke?.originKind, s.sunWoke?.causeId], ['self', s.sleepAfter?.id]);
  check('with the default seams (009), the sleep inherits the DM and Sunday\'s woke is cut loose',
    d.sleepAfter?.originKind === 'dm' && d.sunWoke?.causeId === null, { sleep: d.sleepAfter?.originKind, woke: d.sunWoke?.causeId });
  sameLog('the story seams change causes and origins only (same types, times, payloads)',
    s.evs.map(e => JSON.stringify([e.type, e.at, e.payload])), d.evs.map(e => JSON.stringify([e.type, e.at, e.payload])));
  if (shimUsed) console.log(`  (projector shim used ${shimUsed}× — T009 not landed: plan.basePlanEventId / block.fromAmendment re-attached from the payload)`);

  section('story seams: reverting the decision or the amended plan mid-outing');
  for (const which of ['decision.opened', 'plan.made']) {
    const R = await runOuting({ story: true, stopMidOuting: true });
    const parts = outingParts({ sim: { events: eventsAfter(0, 50000) } });
    const out = eventsAfter(0, 50000).filter(parts.isOutingEv);
    check(`(${which}) stopped mid-outing`, out.some(e => e.type === 'activity.started') && !!parts.rewrite, out.map(e => e.type));
    const target = which === 'plan.made' ? parts.rewrite : eventsAfter(R.trig, 50).find(e => e.type === 'decision.opened' && e.causeId === R.trig);
    revertEvent(target.id, { reason: 'test', at: R.sim.clock.now() });
    R.sim.rebuild();
    check(`(${which}) every outing event is excluded`, out.length >= 2 && out.every(e => R.sim.live.excluded.has(e.id)), out.map(e => `${e.type}:${R.sim.live.excluded.has(e.id)}`));
    check(`(${which}) … and the amended plan with them`, R.sim.live.excluded.has(parts.rewrite.id));
    check(`(${which}) the morning's self events stay`, ![parts.base.id, ...eventsAfter(parts.base.id, 50000)
      .filter(e => e.id < R.trig && e.originKind === 'self').map(e => e.id)].some(id => R.sim.live.excluded.has(id)));
    eq(`(${which}) the base plan is in force again`, R.sim.live.plan?.eventId, parts.base.id);
    const n0 = lastEventId();
    for (let i = 0; i < 24 * 4 && R.sim.clock.now() < local(11, 1, 12); i++) { R.sim.clock.advance({ minutes: 15 }); await R.sim.pulse.tick(); }
    const after = eventsAfter(n0, 50000);
    check(`(${which}) the pulse goes on to a self sleep and Sunday's wake`, after.some(e => e.type === 'sleep.started' && e.originKind === 'self')
      && after.some(e => e.type === 'woke' && day(e) === '2026-11-01'), after.map(e => e.type).slice(0, 20));
    check(`(${which}) the outing is not re-run`, !after.some(e => e.type === 'plan.made' && e.payload?.amendedFor));
  }

  section('story seams: work.late, sleep and a later invitation cite the base plan');
  // A manual amendment caused by a chat (the reconciler's shape for a
  // lunchtime adoption): one block is the adoption's, every other block,
  // work.late, the sleep and the evening invitation stay self.
  const manual = (state) => async (sim) => {
    const plan = sim.live.plan;
    if (!plan || !Number.isSafeInteger(plan.eventId) || state[plan.date] || ![MON, SAT].includes(plan.date)) return null;
    if (sim.clock.now() < plan.wakeAt + 20 * MIN) return null;
    const now = sim.clock.now();
    const payload = structuredClone(getEvent(plan.eventId).payload);
    const target = payload.blocks.find(b => b.start > now + 60 * MIN && !['commute', 'sleep', 'work', 'meeting'].includes(b.kind));
    if (!target) { state[plan.date] = 'none'; return null; }
    target.fromAmendment = true;
    target.subjectJid = ALICE;
    payload.basePlanEventId = plan.eventId;
    const trig = sim.append({ type: 'chat.trigger', at: now, actor: 'chat', originKind: 'dm', originJid: ALICE, payload: { kind: 'plan' } });
    const ev = sim.append({ type: 'plan.made', at: now, actor: 'engine', causeId: trig.id, payload });
    state[plan.date] = { base: plan.eventId, amended: ev.id, target };
    return null;
  };
  const runManual = async (story) => { const st = {}; const sim = await simulate({ deps: story ? STORY_SEAMS : {}, useShim: true, hook: manual(st) }); return { sim, st }; };
  const MS = await runManual(true);
  const MD = await runManual(false);
  const mon = MS.st[MON];
  check('Monday was amended with one adopted block', !!mon?.amended, mon);
  const monEvs = MS.sim.events.filter(e => e.id > mon.amended && day(e) === MON);
  const tgt = monEvs.find(e => e.type === 'activity.started' && e.at === mon.target.start && e.payload.kind === mon.target.kind);
  eq('the adopted block\'s activity: DM origin, subject, caused by the amended plan', [tgt?.originKind, tgt?.subjectJid, tgt?.causeId], ['dm', ALICE, mon.amended]);
  const tgtMeal = monEvs.find(e => e.type === 'meal' && e.causeId === tgt?.id);
  if (tgtMeal) eq('… its meal carries the subject too', [tgtMeal.originKind, tgtMeal.subjectJid], ['dm', ALICE]);
  const others = monEvs.filter(e => (e.type === 'activity.started' || e.type === 'travel.started') && e.id !== tgt?.id);
  check('every other block that day is self, caused by the base plan', others.length >= 2
    && others.every(e => e.originKind === 'self' && e.causeId === mon.base && e.subjectJid === null), others.map(e => `${e.type}:${e.payload.kind ?? ''}:${e.originKind}`));
  const wl = MS.sim.events.find(e => e.type === 'work.late' && day(e) === MON);
  eq('work.late is self, caused by the base plan', [wl?.originKind, wl?.causeId], ['self', mon.base]);
  const monSleep = MS.sim.events.find(e => e.type === 'sleep.started' && e.id > mon.amended);
  eq('the night\'s sleep is self, caused by the work.late', [monSleep?.originKind, monSleep?.causeId], ['self', wl?.id]);
  const tueWoke = MS.sim.events.find(e => e.type === 'woke' && day(e) === '2026-10-27');
  eq('Tuesday\'s woke is self and linked to that sleep', [tueWoke?.originKind, tueWoke?.causeId], ['self', monSleep?.id]);
  const sat = MS.st[SAT];
  const inv = MS.sim.events.find(e => e.type === 'decision.opened' && day(e) === SAT);
  check('Saturday was amended before its invitation', !!sat?.amended && !!inv && inv.id > sat.amended, { sat, inv: inv?.id });
  eq('the later evening invitation is self, caused by the base plan', [inv?.originKind, inv?.causeId], ['self', sat?.base]);
  const mdWl = MD.sim.events.find(e => e.type === 'work.late' && day(e) === MON);
  const mdInv = MD.sim.events.find(e => e.type === 'decision.opened' && day(e) === SAT);
  eq('with the default seams (009) both inherit the DM', [mdWl?.originKind, mdInv?.originKind], ['dm', 'dm']);

  // ── 4. worldOf, subjectJid, eventsAfter / getEvent, rebase ─────────────
  section('worldOf: every world read sees the overlay');
  const OVER = { ...world, money: { ...world.money, salary: 99999 }, self: { ...world.self, job: { ...world.self.job } } };
  const evalWorlds = [];
  const openWorlds = [];
  const W = await simulate({
    until: local(11, 1, 12),
    deps: {
      worldOf: () => OVER,
      evaluateDecisions: (gs, ctx) => { evalWorlds.push(ctx.world); return evaluateReal(gs, ctx); },
      openDecision: (gs, spec, ctx) => { openWorlds.push(ctx.world); return openDecision(gs, spec, ctx); },
    },
  });
  const pay = ofType(W.events, 'money.salary');
  eq('salary day pays the overlaid salary', pay.map(e => e.payload.amount), [99999]);
  const wInv = W.events.find(e => e.type === 'decision.opened' && day(e) === SAT);
  const aInv = A.events.find(e => e.type === 'decision.opened' && day(e) === SAT);
  const spendOf = (e) => e?.payload?.options?.find(o => o.id === 'go')?.spend ?? e?.payload?.options?.find(o => o.id === 'go')?.cost?.spend;
  check('the evening invitation is priced from the overlaid salary', !!wInv && !!aInv && JSON.stringify(wInv.payload.options) !== JSON.stringify(aInv.payload.options),
    { w: spendOf(wInv), a: spendOf(aInv) });
  check('decisions.evaluate gets the overlaid world', evalWorlds.length > 0 && evalWorlds.every(w => w === OVER));
  check('openDecision gets the overlaid world', openWorlds.length === 1 && openWorlds[0] === OVER, openWorlds.length);
  const daysOf = (sim) => ofType(sim.events, 'plan.made').filter(e => getEvent(e.causeId)?.type === 'woke').map(e => e.payload.dayType);
  eq('the routine itself is not overlaid (same day types)', daysOf(W), daysOf(A).slice(0, daysOf(W).length));

  section('subjectJid: the outing blocks carry the decision\'s subject');
  {
    await setupScratchDb();
    resetDecisionCounters();
    const clock = fakeClock(T0);
    setClock(clock.fn);
    let live = createInitialState(world);
    const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
    NEW.genesis(append, world, T0, { vitals: { workPressure: 95 } });
    const p = NEW.createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15 });
    let dec = null;
    while (clock.now() < END && !dec) {
      clock.advance({ minutes: 15 });
      await p.tick();
      dec = [...live.decisions.values()].find(x => x.status === 'committed' && applyTimeOf(x) > clock.now());
    }
    check('found a committed outing before its point of no return', !!dec);
    const at = applyTimeOf(dec);
    const withSubj = amendPlanForOuting(live, { ...dec, subjectJid: ALICE }, at, world);
    const without = amendPlanForOuting(live, dec, at, world);
    const mk = (pl) => (pl?.blocks || []).filter(b => b.fromAmendment);
    check('with a subject: the outing and commutes carry it', mk(withSubj).length >= 1 && mk(withSubj).every(b => b.subjectJid === ALICE));
    check('… and no other block does', (withSubj?.blocks || []).filter(b => !b.fromAmendment).every(b => !('subjectJid' in b)));
    check('without a subject: no subjectJid anywhere', (without?.blocks || []).every(b => !('subjectJid' in b)) && mk(without).length === mk(withSubj).length);
    eq('basePlanEventId = the plan in force', withSubj?.basePlanEventId, live.plan.eventId);
    const again = amendPlanForOuting({ ...live, plan: { ...live.plan, eventId: 999999, basePlanEventId: live.plan.eventId } }, dec, at, world);
    eq('a repeated amendment keeps the original base', again?.basePlanEventId, live.plan.eventId);
  }

  section('eventsAfter / getEvent seams and rebase()');
  {
    await setupScratchDb();
    resetDecisionCounters();
    const clock = fakeClock(T0);
    setClock(clock.fn);
    let live = createInitialState(world);
    const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
    NEW.genesis(append, world, T0, { vitals: { workPressure: 95 } });
    const cursors = [];
    const gets = [];
    const p = NEW.createPulse({
      world, getState: () => live, append, now: clock.fn, tickMinutes: 15,
      eventsAfter: (id, ...rest) => { cursors.push(id); return eventsAfter(id, ...rest); },
      getEvent: (id) => { gets.push(id); return getEvent(id); },
    });
    check('rebase is exported on the pulse', typeof p.rebase === 'function');
    for (let i = 0; i < 4 * 6; i++) { clock.advance({ minutes: 15 }); await p.tick(); }
    check('the pulse reads new events through deps.eventsAfter', cursors.length > 0);
    check('… and causes through deps.getEvent (woke → its sleep)', gets.length > 0);
    // Events appended behind the pulse's back (e.g. a rewind's rebuild): rebase skips them.
    append({ type: 'work.crunch', at: clock.now(), actor: 'engine', payload: { amount: 10, reason: 'deadline' } });
    append({ type: 'work.crunch', at: clock.now(), actor: 'engine', payload: { amount: 10, reason: 'deadline' } });
    const mark = live.lastEventId;
    p.rebase();
    cursors.length = 0;
    clock.advance({ minutes: 15 });
    await p.tick();
    check('after rebase() the next evaluation reads from the current last event', cursors.length > 0 && cursors.every(c => c >= mark), cursors);
  }

  section('offline');
  eq('no network calls', fetches, 0);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
