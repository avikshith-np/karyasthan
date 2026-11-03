// Review repairs at the pulse level (src/life/pulse.js + projector.js): an
// owner revert stays undone on the next tick (a block start, work.late, an
// evening invitation), a committed outing he can't get to is closed as
// could_not_go instead of staying "committed" forever, and — with the example
// world and its default vitals — deadline crunches make the FR-008 chain
// (work.late → late sleep → late wake) actually happen over four weeks.
// Scratch DB, fake clock, mocked Jev, no network.
import { setupScratchDb, fakeClock, fakeJev, jevChoice, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, revertEvent, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters, openDecision } from '../../src/life/decisions.js';
import { createPulse, genesis, PROPOSAL_P, isUndone } from '../../src/life/pulse.js';

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (month, day, h, m = 0) => zonedToUnix(2026, month, day, h, m, tz);
const T0 = local(10, 26, 5);           // Mon 26 Oct 05:00, asleep
const H = 3600;

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const jev = fakeJev((req) => {
  const ids = Object.keys(req?.questions?.pick?.criteria || {});
  const probs = {};
  for (const id of ids) probs[id] = id === 'go' ? 0.9 : 0.1 / Math.max(1, ids.length - 1);
  return { pick: jevChoice(ids.includes('go') ? 'go' : ids[0], probs) };
});
setJev(jev.fn);

// A fresh world at T0 driven like the facade does: append → fold; revert → rebuild.
async function fresh({ vitals } = {}) {
  await setupScratchDb();
  resetDecisionCounters();
  jev.reset();
  const clock = fakeClock(T0);
  setClock(clock.fn);
  const sim = { clock, live: createInitialState(world) };
  sim.append = (spec) => {
    const ev = appendEvent(spec);
    sim.live = applyAppended(sim.live, ev, { world });
    return ev;
  };
  genesis(sim.append, world, T0, vitals ? { vitals } : {});
  sim.pulse = createPulse({ world, getState: () => sim.live, append: sim.append, now: clock.fn, tickMinutes: 15 });
  sim.until = async (t) => { while (clock.now() < t) { clock.advance({ minutes: 15 }); await sim.pulse.tick(); } };
  sim.revert = (id) => {
    const r = revertEvent(id, { reason: 'test', at: clock.now() });
    sim.live = rebuild({ world });
    return r;
  };
  return sim;
}
const after = (id, pred) => eventsAfter(id, 50000).filter(pred);

try {
  // ── A seed where Monday runs late and Tuesday has an evening invitation ──
  let seed = null;
  for (let s = 1; s < 500 && seed === null; s++) {
    setRngSeed(s);
    if (rngFor('2026-10-26', 'work.late')() < 0.3 && rngFor('2026-10-27', 'decision:evening')() < PROPOSAL_P * 0.8) seed = s;
  }
  setRngSeed(seed ?? 1);

  section('revert a block start, then tick');
  {
    const sim = await fresh({ vitals: { workPressure: 95 } });
    await sim.until(local(10, 26, 11));
    const target = eventsAfter(0, 50000).filter(e => e.type === 'activity.started' && e.at <= sim.clock.now()
      && !['sleep', 'commute'].includes(e.payload.kind)).pop();
    check('an activity has started by 11:00', !!target, target);
    const rv = sim.revert(target.id);
    check('the projection no longer holds it', sim.live.activity.eventId !== target.id);
    check('… and remembers it as undone', isUndone(sim.live, 'activity.started', target.at, target.payload.kind));
    await sim.until(local(10, 26, 13));
    eq('the next ticks do not start it again', after(rv.revertEventId, e => e.type === 'activity.started'
      && e.at === target.at && e.payload.kind === target.payload.kind).length, 0);
    check('… and the day goes on with the next block', after(rv.revertEventId, e => e.type === 'activity.started').length > 0);
    await sim.until(local(10, 27, 9));
    check('he still goes to sleep and wakes the next day', after(rv.revertEventId, e => e.type === 'sleep.started').length >= 1
      && after(rv.revertEventId, e => e.type === 'woke').length >= 1);
    const replay = rebuild({ world, useSnapshot: false });
    eq('live ≡ full replay after revert + ticks', JSON.stringify([...replay.excludedSigs]), JSON.stringify([...sim.live.excludedSigs]));
  }

  section('revert work.late, then tick');
  {
    const sim = await fresh({ vitals: { workPressure: 95 } });
    await sim.until(local(10, 26, 20));
    const late = eventsAfter(0, 50000).find(e => e.type === 'work.late');
    check('Monday ran late (seeded)', !!late, seed);
    if (late) {
      const rv = sim.revert(late.id);
      await sim.until(local(10, 27, 9));
      eq('work.late is not appended again', after(rv.revertEventId, e => e.type === 'work.late' && e.at === late.at).length, 0);
      const sleep = after(rv.revertEventId, e => e.type === 'sleep.started')[0];
      check('that night\'s sleep is no longer caused by it', !!sleep && sleep.causeId !== late.id, sleep);
    }
  }

  section('revert an evening invitation, then tick');
  {
    const sim = await fresh();
    await sim.until(local(10, 27, 23));
    const opened = eventsAfter(0, 50000).find(e => e.type === 'decision.opened' && dateKey(e.at, tz) === '2026-10-27');
    check('Tuesday brought an invitation (seeded)', !!opened, seed);
    if (opened) {
      // Back up to the moment it opened: a fresh world, ticked to just after it.
      const sim2 = await fresh();
      await sim2.until(opened.at + 15 * 60);
      const op2 = eventsAfter(0, 50000).find(e => e.type === 'decision.opened');
      const rv = sim2.revert(op2.id);
      eq('the decision is gone from the projection', sim2.live.decisions.has(op2.id), false);
      await sim2.until(local(10, 27, 23));
      eq('it is not opened again', after(rv.revertEventId, e => e.type === 'decision.opened').length, 0);
      eq('… and no outing rewrote the evening', after(rv.revertEventId, e => e.type === 'plan.made' && e.payload.amendedFor).length, 0);
    }
  }

  section('committed, but he can\'t go: could_not_go');
  {
    const sim = await fresh();
    await sim.until(local(10, 27, 9, 45));            // Tuesday, at the office
    const flat = [...sim.live.cast.values()].find(c => c.relation === 'flatmate');
    const placeId = world.routine.leisure.find(l => l.placeId && l.placeId !== world.self.homePlaceId)?.placeId;
    const eventAt = local(10, 27, 12);                // midday, in the middle of work
    const spec = {
      kind: 'cafe',
      subject: { eventAt, placeId, castIds: flat ? [flat.id] : [], minutes: 60 },
      options: [
        { id: 'go', label: 'Go', go: true, kind: 'cafe', spend: 100, fun: 5 },
        { id: 'late', label: 'Join later', go: 'late', kind: 'cafe', minutes: 30, spend: 100, fun: 3 },
        { id: 'stay', label: 'Stay in', kind: 'rest' },
      ],
    };
    const { decision: d } = await openDecision(() => sim.live, spec, { world, at: sim.clock.now(), append: sim.append });
    check('a midday outing was opened', !!d?.id, d);
    await sim.until(local(10, 27, 15));
    const dec = sim.live.decisions.get(d.id);
    const missed = after(d.id, e => e.type === 'decision.expired' && e.payload.decisionId === d.id);
    eq('committed to go, then closed as could_not_go', [missed.map(e => e.payload.reason), dec?.status], [['could_not_go'], 'missed']);
    eq('no outing rewrite while he was at work', after(d.id, e => e.type === 'plan.made' && e.payload.amendedFor === d.id).length, 0);
  }

  section('four weeks, example world, default vitals: the FR-008 chain happens');
  {
    setRngSeed('2');                                  // pinned: the dry run's --seed 2
    const sim = await fresh();
    await sim.until(T0 + 28 * 86400);
    const evs = eventsAfter(0, 100000);
    const byId = new Map(evs.map(e => [e.id, e]));
    const crunch = evs.filter(e => e.type === 'work.crunch');
    const late = evs.filter(e => e.type === 'work.late');
    check('deadline crunches happen', crunch.length >= 1, crunch.length);
    check('… only on work days, at the wake, with the amount in the payload',
      crunch.every(e => byId.get(e.causeId)?.type === 'woke' && Number.isInteger(e.payload.amount) && e.payload.amount >= 60));
    check('work runs late at least once', late.length >= 1, late.length);
    const chains = late.map((wl) => {
      const sleep = evs.find(e => e.type === 'sleep.started' && e.causeId === wl.id);
      const woke = sleep && evs.find(e => e.type === 'woke' && e.causeId === sleep.id);
      return { wl, sleep, woke };
    });
    check('a late night follows (sleep caused by work.late)', chains.some(c => c.sleep), chains.length);
    check('… and a late wake (woke caused by it, lateBy > 0)', chains.some(c => c.woke && c.woke.payload.lateBy > 0));
    const checkpoints = evs.filter(e => e.type === 'vitals.checkpoint').map(e => e.payload.vitals);
    check('vitals vary after week one (not the same morning every day)',
      new Set(checkpoints.slice(7).map(v => `${v.workPressure}|${v.stress}`)).size > 3);
    check('stress never pins at 100', checkpoints.every(v => v.stress < 100));
    const wokes = evs.filter(e => e.type === 'woke');
    eq('the first wake after genesis is marked', [wokes[0].payload.firstNight, wokes.slice(1).some(w => w.payload.firstNight)], [true, false]);
    check('woke carries the night\'s outcome (sleptMin ≤ cycleMin)', wokes.every(w => Number.isInteger(w.payload.sleptMin)
      && Number.isInteger(w.payload.cycleMin) && w.payload.sleptMin <= w.payload.cycleMin));
    check('no network', fetches === 0, fetches);
    check('a revert-free log has no undone signatures', sim.live.excludedSigs.length === 0 && lastEventId() > 0);
  }
} finally {
  report();
}
