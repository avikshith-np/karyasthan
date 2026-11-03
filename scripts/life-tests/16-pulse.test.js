// T021 — the pulse (src/life/pulse.js): one simulated week on a scratch DB with
// a fake clock and a mocked Jev, folded live the way the facade does it.
// Checks: the routine per weekday (wake → plan → blocks as planned → sleep,
// office commutes Tue–Thu, WFH Mon/Fri, weekends), the FR-008 consequence
// chain (work.late → sleep.started → woke with lateBy > 0, cause_id chain), a
// timed decision lifecycle driven by ticks (invitation → lean → commit → the
// evening rewritten at the point of no return → the trip there and back),
// Jev only on decision triggers, no network at all, idempotent re-walks, a
// 10 h downtime catch-up that writes exactly the uninterrupted log, the
// re-anchor beyond the cap and onTick subscribers.
import { setupScratchDb, fakeClock, fakeJev, jevChoice, section, check, eq, near, report } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setClock, zonedToUnix, dateKey, weekday, hhmm, minuteOfDay } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, causeChain } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild, saveSnapshot } from '../../src/life/projector.js';
import { inRange, lateWakeMinutes } from '../../src/life/vitals.js';
import { setJev, resetDecisionCounters } from '../../src/life/decisions.js';
import { routineOf } from '../../src/life/routine.js';
import { createPulse, genesis, eveningProposal, PROPOSAL_P } from '../../src/life/pulse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIFE_DIR = path.resolve(__dirname, '../../src/life');

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz); // October 2026
const T0 = local(26, 5);              // Mon 26 Oct 05:00 — he's still asleep
const END = T0 + 7 * 86400;           // the next Monday, 05:00
const MIN = 60;

// No network, ever: every fetch during the simulation is counted and refused.
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

// A seed under which Monday runs late (work pressure starts at 95, so p ≈ 0.4)
// and Saturday brings an evening invitation — the scenarios this file needs.
let seed = null;
for (let s = 1; s < 500 && seed === null; s++) {
  setRngSeed(s);
  if (rngFor('2026-10-26', 'work.late')() < 0.3 && rngFor('2026-10-31', 'decision:evening')() < PROPOSAL_P * 0.8) seed = s;
}
setRngSeed(seed ?? 1);

// Jev mock: whatever the trigger, he likes going (p 0.9 → early commit).
const jev = fakeJev((req) => {
  const ids = Object.keys(req?.questions?.pick?.criteria || {});
  const probs = {};
  for (const id of ids) probs[id] = id === 'go' ? 0.9 : 0.1 / Math.max(1, ids.length - 1);
  return { pick: jevChoice(ids.includes('go') ? 'go' : ids[0], probs) };
});
setJev(jev.fn);

const allEvents = () => eventsAfter(0, 50000);

// One simulated run: fresh scratch DB, genesis at T0, ticks every 15 min until
// END; `downtime` = { at, hours } "crashes" at `at` (projection and pulse
// dropped) and boots again `hours` later from the log (snapshot + replay).
async function simulate({ downtime = null } = {}) {
  await setupScratchDb();
  resetDecisionCounters();
  jev.reset();
  const clock = fakeClock(T0);
  setClock(clock.fn);
  let live = createInitialState(world);
  const append = (spec) => {
    const ev = appendEvent(spec);
    live = applyAppended(live, ev, { world });
    return ev;
  };
  genesis(append, world, T0, { vitals: { workPressure: 95 } });
  const boot = () => createPulse({
    world, getState: () => live, append, now: clock.fn, tickMinutes: 15,
    onDay: (s) => saveSnapshot(s),
  });
  let pulse = boot();
  const ticks = [];
  pulse.onTick((view, info) => { ticks.push(info); });
  let downInfo = null;
  while (clock.now() < END) {
    if (downtime && !downInfo && clock.now() >= downtime.at) {
      pulse = null;
      live = null;
      clock.advance({ hours: downtime.hours });
      live = rebuild({ world });
      pulse = boot();
      downInfo = await pulse.tick();
      continue;
    }
    clock.advance({ minutes: 15 });
    await pulse.tick();
  }
  return { events: allEvents(), live: () => live, pulse, clock, ticks, downInfo, append, jevCalls: jev.calls.length };
}

try {
  section('setup');
  check('found a seed for the scenarios', seed !== null, seed);

  const A = await simulate();
  const jevRequests = JSON.stringify(jev.calls);
  const evs = A.events;
  const byId = new Map(evs.map(e => [e.id, e]));
  const ofType = (t) => evs.filter(e => e.type === t);
  const day = (e) => dateKey(e.at, tz);
  const r = routineOf(world);

  section('one simulated week');
  check('no network calls (no LLM, no Jev transport)', fetches === 0, fetches);
  eq('time never runs backwards by more than a tick', evs.filter((e, i) => i > 0 && e.at < evs[i - 1].at - 15 * MIN).map(e => `${e.id}:${e.type}`), []);
  const wokes = ofType('woke');
  eq('he wakes once a day, Mon–Sun', wokes.map(day),
    ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  const sleeps = ofType('sleep.started');
  eq('a sleep each night (+ the one he was in at genesis)', sleeps.length, 8);
  const plans = ofType('plan.made');
  const wakePlans = plans.filter(e => byId.get(e.causeId)?.type === 'woke');
  eq('a plan at every wake', wakePlans.length, 7);
  eq('day types: Mon wfh, Tue–Thu office, Fri wfh, weekend',
    wakePlans.map(p => p.payload.dayType), ['wfh', 'office', 'office', 'office', 'wfh', 'weekend', 'weekend']);
  check('every plan is dated at its wake', wakePlans.every(p => p.at === byId.get(p.causeId).at && p.payload.wakeAt === p.at));

  for (const w of wokes) {
    const base = r.weekend.includes(weekday(w.at, tz)) ? r.weekendWake : r.baseWake;
    check(`${day(w)}: woke at ${hhmm(w.at, tz)} = base + lateBy (${w.payload.lateBy}) ± 10 min`,
      Math.abs(minuteOfDay(w.at, tz) - (base + w.payload.lateBy)) <= 10);
  }

  // The actual day follows the plan: every block start is one event, at its start.
  const startOf = (e) => (e.type === 'travel.started' ? 'commute' : e.type === 'sleep.started' ? 'sleep'
    : e.type === 'activity.started' ? e.payload.kind : null);
  for (const p of wakePlans) {
    const next = plans.find(q => q.id > p.id);
    const amended = !!next && next.payload.wakeAt === p.payload.wakeAt;
    const actual = evs.filter(e => e.id > p.id && (!next || e.id < next.id) && startOf(e)).map(e => `${startOf(e)}@${e.at}`);
    const planned = p.payload.blocks.filter(b => !amended || b.start < next.at).map(b => `${b.kind}@${b.start}`);
    eq(`${p.payload.date} (${p.payload.dayType}): the day happens as planned${amended ? ' until the evening was rewritten' : ''}`,
      actual, planned);
  }

  const officeTrips = ofType('travel.started').filter(e => e.payload.to === 'place:office');
  eq('commutes to the office on Tue–Thu only', [...new Set(officeTrips.map(e => weekday(e.at, tz)))], [2, 3, 4]);
  check('every trip ends in an arrival', ofType('travel.started').every(t => evs.some(a => a.type === 'travel.arrived' && a.causeId === t.id)));
  for (const k of ['breakfast', 'lunch', 'dinner']) {
    check(`a ${k} every day`, wokes.every(w => evs.some(e => e.type === 'meal' && e.payload.kind === k && day(e) === day(w))));
  }
  const checkpoints = ofType('vitals.checkpoint');
  eq('one vitals checkpoint per morning', checkpoints.length, 7);
  check('vitals stay in range all week', inRange(A.live().vitals)
    && checkpoints.every(c => c.payload.vitals.energy >= 0 && c.payload.vitals.energy <= 100 && c.payload.vitals.stress >= 0));
  const weather = ofType('weather.changed');
  check('weather changes dated at their 3-hour block', weather.length > 7 && weather.every(e => e.at === e.payload.from || e.id === weather[0].id));

  section('consequence chain: work late → sleep debt → late wake (FR-008)');
  const late = ofType('work.late');
  const monLate = late.find(e => day(e) === '2026-10-26');
  check('Monday ran late', !!monLate, late.map(day));
  const monPlan = byId.get(monLate?.causeId);
  eq('work.late caused by the plan that rolled it, at the normal end', [monPlan?.type, monPlan?.payload.workLate?.normalEnd], ['plan.made', monLate?.at]);
  const monSleep = sleeps.find(e => e.causeId === monLate?.id);
  check('that night\'s sleep is caused by the work.late', !!monSleep);
  const sleepMin = (t) => { const m = minuteOfDay(t, tz); return m < 12 * 60 ? m + 1440 : m; };
  check(`… and starts after the usual bedtime (${monSleep && hhmm(monSleep.at, tz)})`, monSleep && sleepMin(monSleep.at) > r.baseSleep);
  const tueWoke = wokes.find(e => e.causeId === monSleep?.id);
  check('Tuesday\'s woke is caused by that sleep', !!tueWoke && day(tueWoke) === '2026-10-27');
  check('… and he woke late (lateBy > 0 from sleep debt > 0)', tueWoke?.payload.lateBy > 0 && tueWoke?.payload.debt > 0, tueWoke?.payload);
  near('lateBy = min(90, 20 × debt)', tueWoke?.payload.lateBy, lateWakeMinutes(tueWoke?.payload.debt), 1);
  eq('explain(woke) walks plan.made → work.late → sleep.started → woke',
    causeChain(tueWoke.id).map(e => e.type).slice(-4), ['plan.made', 'work.late', 'sleep.started', 'woke']);

  section('timed decision lifecycle, driven by the ticks');
  const opened = ofType('decision.opened');
  const dec = opened.find(e => day(e) === '2026-10-31');
  check('Saturday brought an evening invitation', !!dec, opened.map(day));
  const sat = wakePlans.find(p => p.payload.date === '2026-10-31');
  eq('opened by the engine, caused by the day\'s plan', [dec.actor, dec.causeId], ['engine', sat.id]);
  const prop = eveningProposal(sat.payload, { ...A.live(), plan: sat.payload }, world);
  eq('opened at the invitation time the pulse rolled', dec.at, prop?.opensAt);
  check('decideBy < ponrAt < the outing', dec.payload.decideBy < dec.payload.ponrAt && dec.payload.ponrAt < dec.payload.subject.eventAt);
  const lean = evs.find(e => e.type === 'decision.lean' && e.payload.decisionId === dec.id);
  eq('first lean: Jev, new_info, at the open', [lean?.actor, lean?.payload.trigger, lean?.at], ['jev', 'new_info', dec.at]);
  const commit = evs.find(e => e.type === 'decision.committed' && e.payload.decisionId === dec.id);
  eq('a confident lean (0.9 ≥ commitP) commits early to go', [commit?.payload.optionId, commit?.payload.sampled, commit?.causeId], ['go', false, lean?.id]);
  const rewrite = plans.find(p => p.causeId === commit?.id);
  check('the evening is rewritten at the point of no return', !!rewrite && rewrite.at === dec.payload.ponrAt, { rewrite: rewrite?.at, ponr: dec.payload.ponrAt });
  const there = evs.find(e => e.type === 'travel.started' && e.at === rewrite?.at && e.payload.to === dec.payload.subject.placeId);
  check('… he leaves for the place right then', !!there && there.causeId === rewrite.id);
  const outing = evs.find(e => e.type === 'activity.started' && e.payload.placeId === dec.payload.subject.placeId && e.id > (rewrite?.id ?? 0));
  eq('… does it with the flatmate', [outing?.payload.kind, outing?.payload.withCast], [dec.payload.kind, ['cast:flatmate']]);
  const satSleep = sleeps.find(s => s.id > (outing?.id ?? Infinity));
  check('… and comes home before sleeping', !!satSleep && evs.some(e => e.type === 'travel.arrived' && e.payload.to === 'place:home'
    && e.id > outing.id && e.id < satSleep.id));
  eq('that night\'s sleep is a consequence of the decision', causeChain(satSleep.id).map(e => e.type).slice(-5),
    ['decision.opened', 'decision.lean', 'decision.committed', 'plan.made', 'sleep.started']);
  const leans = ofType('decision.lean');
  eq('Jev asked exactly once per Jev lean (only on triggers)', A.jevCalls, leans.filter(e => e.actor === 'jev').length);
  check('… never without an open decision', leans.every(e => byId.get(e.payload.decisionId)?.type === 'decision.opened'));
  check('Jev never saw a cast member\'s name', !world.cast.some(c => jevRequests.includes(c.name)));

  section('idempotent re-walks');
  const n0 = A.live().lastEventId;
  await A.pulse.runTo(A.clock.now());
  eq('ticking the same time again appends nothing', A.live().lastEventId, n0);
  const fresh = createPulse({ world, getState: A.live, append: A.append, now: A.clock.fn });
  await fresh.tick();
  eq('a restarted pulse re-walking from the projection appends nothing', A.live().lastEventId, n0);

  section('onTick');
  check('one call per tick, one step each', A.ticks.length === 7 * 96 && A.ticks.every(t => t.steps === 1), A.ticks.length);
  check('a tick reports the events it appended', A.ticks.some(t => t.events.some(e => e.type === 'woke')));
  let seen = 0;
  const off = fresh.onTick(() => { seen++; });
  A.clock.advance({ minutes: 15 });
  await fresh.tick();
  off();
  A.clock.advance({ minutes: 15 });
  await fresh.tick();
  eq('subscriber called until unsubscribed', seen, 1);

  section('beyond the catch-up cap: re-anchor');
  const before = A.live().lastEventId;
  A.clock.advance({ hours: 80 });
  const re = await fresh.tick();
  const tail = eventsAfter(before, 50);
  const reEv = tail.find(e => e.type === 'world.reanchored');
  check('world.reanchored appended and one step run', re.reanchored === true && re.steps === 1 && !!reEv);
  eq('the gap is recorded', reEv?.payload.gapHours, 80);
  check('the day goes on from the re-anchor (plan or sleep)', tail.some(e => e.id > reEv.id && ['plan.made', 'sleep.started'].includes(e.type)));

  section('10 h downtime catch-up = uninterrupted run');
  const B = await simulate({ downtime: { at: local(28, 10), hours: 10 } });
  // 40 steps of downtime + the few it re-walks from the projection's last event (idempotent, append nothing).
  check('the restart caught up the 10 h (40 steps, + re-walked ones) in one tick, without re-anchoring',
    B.downInfo?.steps >= 40 && B.downInfo?.steps <= 48 && B.downInfo?.catchUp === true && B.downInfo?.reanchored === false,
    B.downInfo && { steps: B.downInfo.steps });
  // Compare the logs with ids replaced by positions (cause links and decision ids included).
  const shape = (list) => {
    const idx = new Map(list.map((e, i) => [e.id, i]));
    const swap = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'decisionId' && Number.isInteger(v) ? `#${idx.get(v)}` : v)));
    return list.map(e => JSON.stringify([e.type, e.at, e.actor, e.causeId === null ? null : idx.get(e.causeId), e.originKind, swap(e.payload)]));
  };
  const a = shape(A.events.filter(e => e.at < END));
  const b = shape(B.events);
  eq('same number of events', b.length, a.length);
  const firstDiff = a.findIndex((x, i) => x !== b[i]);
  check('identical log (types, times, actors, causes, payloads)', firstDiff === -1,
    firstDiff === -1 ? undefined : { i: firstDiff, a: a[firstDiff]?.slice(0, 240), b: b[firstDiff]?.slice(0, 240) });
  eq('same number of Jev calls', B.jevCalls, A.jevCalls);

  section('no LLM in the engine');
  const sources = fs.readdirSync(LIFE_DIR).filter(f => f.endsWith('.js'));
  eq('no src/life module imports llm.js statically (world seeding loads it lazily)',
    sources.filter(f => /from ['"]\.\.\/brain\/llm\.js['"]/.test(fs.readFileSync(path.join(LIFE_DIR, f), 'utf-8'))), []);
  for (const f of ['pulse.js', 'index.js']) {
    check(`${f} never calls callLlm`, !/callLlm/.test(fs.readFileSync(path.join(LIFE_DIR, f), 'utf-8')));
  }
  check('still no network after both runs', fetches === 0, fetches);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
