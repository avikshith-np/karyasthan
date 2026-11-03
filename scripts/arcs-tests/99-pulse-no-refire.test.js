// A pulse item that appends and doesn't change what made it due must not come back (final review 16).
// The live shape: a promise fitted into today, a trip home that overruns the fitted departure (soaked,
// lateMin), a reversal during that trip. replanToday's floor (the arrival) used to keep the fitted trip,
// so outing:dropped came due again at once: 200 plan.made a tick, the world stopped, and afterwards he
// set off for a plan he had backed out of. Both the stay and the late branch; the generic net under
// every item. Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR,
} from './_helpers.js';
import { appendEvent, listEvents } from '../../src/life/eventLog.js';
import { firstUnstartedAt } from '../../src/life/planEdits.js';
import { createPulse, pendingBlock, MAX_ITEMS_PER_STEP, REPEAT_SAME } from '../../src/life/pulse.js';
import { config } from '../../src/utils/config.js';
import * as story from '../../src/life/story/index.js';
import { localParts, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';

const { db } = await setupScratchDb();
const cr = fakeCallRole({});
const deps = { getUsageByCaller: () => [], knownNames: () => [], mindBudgetOk: async () => ({ ok: false }) };
let { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest(deps);
config.arcs.scenesEnabled = false;
config.arcs.phoneOrganicPerDay = 0;
const reboot = async () => { await stopLife(); ({ life } = await bootLife({ world, clock, callRole: cr })); story.__setDepsForTest(deps); };
const S = () => life.getState();
const tz = resolveTimezone(world.timezone);
const todayAt = (h, m = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, m, tz); };
const rows = () => db.prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
const planRows = () => db.prepare("SELECT COUNT(*) AS n FROM world_events WHERE type = 'plan.made'").get().n;

/** A promise agreed in texts, fitted into today; he is on a trip that lands past its departure, and then the reversal. */
async function overrun(to) {
  while (localParts(clock.now(), tz).hour < 17 || localParts(clock.now(), tz).hour >= 18) await simulateHours(0.25);
  const at = todayAt(20, 30);
  const now = clock.now();
  const options = [{ id: 'go', label: 'Coffee', go: true, kind: 'hangout' }, { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 45, expiresAt: at + 90 * 60 }, { id: 'stay', label: 'Stay in', kind: 'rest' }];
  const op = appendEvent({ type: 'decision.opened', at: now, actor: 'engine',
    payload: { kind: 'hangout', subject: { eventAt: at, placeId: 'place:cafe', castIds: ['cast:coworker-a'], minutes: 90 }, options, opensAt: now, decideBy: at - 2 * HOUR, ponrAt: at - HOUR } });
  appendEvent({ type: 'decision.committed', at: now, actor: 'engine', causeId: op.id, payload: { decisionId: op.id, optionId: 'go', p: 1, sampled: false, by: 'text' } });
  await reboot();
  await simulateHours(0.25);
  const mine = () => S().plan.blocks.filter(b => b.decisionId === op.id);
  check('the promise is fitted into today', mine().length >= 2, mine().map(b => b.kind));
  const first = mine()[0];
  while (clock.now() < first.start - 1800) await simulateHours(0.25);
  const t = clock.now();
  if (!S().position.travel) {
    const minutes = Math.round((first.start - t) / 60) - 5;
    const tr = appendEvent({ type: 'travel.started', at: t, actor: 'engine', payload: { from: S().position.placeId, to: 'place:home', mode: 'walk', km: 1, minutes, cost: 0 } });
    appendEvent({ type: 'commute.soaked', at: t, actor: 'engine', causeId: tr.id, payload: { mode: 'walk', intensity: 'heavy', lateMin: 15 } });
  }
  appendEvent({ type: 'decision.reversed', at: t, actor: 'engine', causeId: op.id, payload: { decisionId: op.id, from: 'go', to, p: 0.95 } });
  await reboot();
  check('the trip overruns the fitted departure', S().position.travel?.endAt > first.start, { endAt: S().position.travel?.endAt, first: first.start });
  return { id: op.id, first };
}

section('a promise reversed to stay during a trip that overruns its departure');
{
  const { id } = await overrun('stay');
  const left = () => S().plan.blocks.filter(b => b.decisionId === id);
  const before = planRows();
  const p0 = rows();
  await simulateHours(0.25);
  eq('one re-plan, not 200', planRows() - before, 1);
  eq('the plan no longer holds the outing', left().map(b => b.kind), []);
  const counts = [];
  for (let i = 0; i < 30; i++) { await simulateHours(0.25); counts.push(planRows() - before); }
  check('thirty ticks later: no flood of re-plans', counts[counts.length - 1] <= 3, counts);
  check('the log grows by what his evening writes, not by the hundreds', rows() - p0 < 120, rows() - p0);
  check('the world did not stop (asleep by now, or current)', S().activity?.kind === 'sleep' || clock.now() - S().at <= 1800, { behind: clock.now() - S().at, act: S().activity?.kind });
  check('his evening went on after the trip', listEvents({ types: ['sleep.started'], from: clock.now() - 9 * HOUR, limit: 5 }).length >= 1 || !S().position.travel);
  check('he arrived', listEvents({ types: ['travel.arrived'], from: clock.now() - 9 * HOUR, limit: 50 }).length >= 1);
  eq('he never set off for the plan he backed out of',
    listEvents({ types: ['travel.started'], from: clock.now() - 9 * HOUR, limit: 50 }).filter(e => e.payload?.to === 'place:cafe').length, 0);
}

section('the same with a reversal to late (the late branch)');
{
  await simulateHours(14);
  const { id, first } = await overrun('late');
  const before = planRows();
  await simulateHours(0.25);
  check('it comes out of the plan once', planRows() - before <= 2, planRows() - before);
  check('the early blocks are gone', !S().plan.blocks.some(b => b.decisionId === id && b.start === first.start));
  const counts = [];
  for (let i = 0; i < 16; i++) { await simulateHours(0.25); counts.push(planRows() - before); }
  check('no flood of re-plans afterwards', counts[counts.length - 1] <= 4, counts);
  check('the world did not stop', clock.now() - S().at <= 1800, clock.now() - S().at);
}

section('firstUnstartedAt reads as pendingBlock does');
{
  const blocks = [
    { kind: 'work', start: 100, end: 200 },
    { kind: 'commute', start: 200, end: 300 },
    { kind: 'hangout', start: 300, end: 400 },
  ];
  const at = (activity) => firstUnstartedAt({ plan: { blocks }, activity });
  eq('at work: the trip is next', at({ kind: 'work', startAt: 100, availability: 'busy' }), 200);
  eq('on the trip: the outing is next', at({ kind: 'commute', startAt: 205, availability: 'light' }), 300);
  eq('idle after a late arrival, inside the trip block: it has not started', at({ kind: 'idle', startAt: 250, availability: null }), 200);
  eq('at the outing: nothing left', at({ kind: 'hangout', startAt: 300, availability: 'busy' }), Infinity);
  eq('no activity yet: all ahead', at(null), 100);
  for (const activity of [{ kind: 'work', startAt: 100, availability: 'busy' }, { kind: 'commute', startAt: 205, availability: 'light' }, { kind: 'idle', startAt: 250, availability: null }]) {
    eq(`pendingBlock agrees (${activity.kind})`, pendingBlock({ plan: { blocks }, activity })?.block.start, firstUnstartedAt({ plan: { blocks }, activity }));
  }
}

section('the net: any item that changes nothing sits out (a pulse on a copy of the real state)');
{
  // A quiet stretch: nothing of his own due in the next three ticks.
  for (let i = 0; i < 192; i++) {
    const p = pendingBlock(S());
    if (S().activity?.kind !== 'sleep' && !S().position.travel && p && p.at > clock.now() + 3100) break;
    await simulateHours(0.25);
  }
  const state = structuredClone(S());
  delete state.view;
  const t0 = clock.now();
  let fires = 0;
  let noop = 0;
  let other = 0;
  const append = (ev) => { state.lastEventId += 1; return { ...ev, id: state.lastEventId }; };
  const pulse = createPulse({
    world, getState: () => state, append, now: () => t0, tickMinutes: 15,
    evaluateDecisions: async () => {},
    storyItems: (s) => [
      // Appends, changes nothing, sorts first.
      { at: s.at, prio: 0, label: 'stuck', key: 'stuck', run: (add) => { fires += 1; add({ type: 'cast.beat', at: s.at, actor: 'engine', payload: { same: true } }); } },
      // Appends nothing: retired, doesn't stop the rest.
      { at: s.at, prio: 1, label: 'noop', key: 'noop', run: () => { noop += 1; } },
      { at: s.at, prio: 2, label: 'other', key: 'other', run: (add) => { if (other) return; other += 1; add({ type: 'cast.beat', at: s.at, actor: 'engine', payload: { other: true } }); } },
    ],
  });
  await pulse.runTo(t0 + 900);
  eq('it fired REPEAT_SAME times, not MAX_ITEMS_PER_STEP', fires, REPEAT_SAME);
  check('(the cap is far above that)', MAX_ITEMS_PER_STEP > REPEAT_SAME * 10);
  eq('what came after it ran', other, 1);
  eq('a no-op ran once', noop, 1);
  await pulse.runTo(t0 + 1800);
  eq('next tick, the plan unchanged: it stays out', fires, REPEAT_SAME);
  state.plan = { ...state.plan, eventId: state.plan.eventId + 1000000 };
  await pulse.runTo(t0 + 2700);
  eq('a new plan: it may try again, and sits out again', fires, REPEAT_SAME * 2);
}

await stopLife();
report();
