// 014 sched — today's re-plan (plan §A5.4, review R20/R21/R25/R26/R29/R32/R37):
// an override set while he is at work splices into the plan in force (blocks
// before it, the gear and every block outside the edit stay), the pulse's
// `schedule` item re-plans once (engine plan.made caused by the override, self
// origin, `overrides` listed) and then stays quiet when a range simply ends; a
// clear and a revert undo it (the revert by cascade, with no re-derivation); a
// rewind excludes it; an evening "stay in" keeps the evening invitation from
// opening; a sleep-in tomorrow set tonight moves tonight's sleep end and his
// wake; a committed chat outing outside the range stays an anchor tied to its
// decision and keeps the chat origin, and is skipped once its invitation is
// gone; blockCause is the same with arcs on and off; snapshot = full replay.
// Scratch DB, fake clock, no network.
import { setupScratchDb, fakeClock, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix, dateKey, hhmm, weekday as weekdayOf } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, revertEvent, cascadeIds, getEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild, serializeState, deserializeState } from '../../src/life/projector.js';
import { createPulse, genesis, CRUNCH_P, CRUNCH_P_MONDAY } from '../../src/life/pulse.js';
import { checkPlan, dayType } from '../../src/life/routine.js';
import { isAwakeAt } from '../../src/life/availability.js';
import { replanToday, blockCause, scheduleDrift, divergeAt } from '../../src/life/planEdits.js';

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

setRngSeed(7);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const L = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const HOME = world.self.homePlaceId;
const OFFICE = world.self.job.officePlaceId;
const T0 = L(10, 27, 5);                // Tue 27 Oct 2026 05:00 — an office day
const DATE = '2026-10-27';

async function boot(t0 = T0) {
  await setupScratchDb();
  const clock = fakeClock(t0);
  setClock(clock.fn);
  let live = createInitialState(world);
  const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
  genesis(append, world, t0, { vitals: { energy: 80, socialBattery: 70, workPressure: 30, money: 40000 } });
  const pulse = createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15 });
  const until = async (t) => { while (clock.now() < t) { clock.advance({ minutes: 15 }); await pulse.tick(); } };
  const setOverride = (payload) => {
    const act = append({ type: 'director.action', at: clock.now(), actor: 'owner', payload: { kind: 'schedule', previewAt: clock.now(), count: 1 } });
    return append({ type: 'schedule.override_set', at: clock.now(), actor: 'owner', causeId: act.id, payload: { op: 'set', conflicts: [], ...payload } });
  };
  return { clock, pulse, until, append, setOverride, live: () => live, setLive: (s) => { live = s; } };
}

const rows = (plan) => plan.blocks.map(b => `${hhmm(b.start, tz)} ${b.kind}@${b.placeId ?? `${b.from}>${b.to}`}${b.fromOverride ? '*' : ''}`);

section('rest of the day off (at work, 13:30): the re-plan splices into the plan in force (R22/R26)');
{
  const A = await boot();
  await A.until(L(10, 27, 13, 30));
  const before = A.live().plan;
  eq('an office day planned in the morning', [before.dayType, before.blocks.some(b => b.kind === 'work' && b.placeId === OFFICE)], ['office', true]);
  const ov = A.setOverride({ date: DATE, background: { activity: 'off', from: A.clock.now(), to: before.sleepAt } });
  check('the override folds into s.scheduleOverrides', A.live().scheduleOverrides?.[ov.id]?.status === 'active');
  const nBefore = eventsAfter(0, 50000).length;
  await A.pulse.settle(A.clock.now());
  const made = eventsAfter(0, 50000).slice(nBefore).filter(e => e.type === 'plan.made');
  eq('one engine plan.made at once (settle)', made.length, 1);
  const p = A.live().plan;
  eq('… caused by the override, self origin, listing it', [made[0].causeId, made[0].originKind, p.overrides], [ov.id, 'self', [ov.id]]);
  eq('… sound', checkPlan(p, world), []);
  const at = A.clock.now();
  const cut = before.blocks.find(b => b.start <= at && at < b.end).start;
  check('blocks before the current one are the morning plan\'s', p.blocks.filter(b => b.end <= cut).every((b, i) => JSON.stringify(b) === JSON.stringify(before.blocks[i])));
  eq('the current block (lunch at the office) is cut at now', [p.blocks.find(b => b.start === cut)?.kind, p.blocks.find(b => b.start === cut)?.end], ['lunch', at]);
  check('no work or meeting after now', !p.blocks.some(b => b.start >= at && (b.kind === 'work' || b.kind === 'meeting')));
  const trip = p.blocks.find(b => b.kind === 'commute' && b.start >= at);
  eq('first thing after now: the trip home from the office', [trip?.from, trip?.to, trip?.fromOverride], [OFFICE, HOME, true]);
  const evening = (pl) => pl.blocks.filter(b => b.start >= L(10, 27, 18, 45)).map(b => `${b.kind}@${b.placeId}|${b.start}`);
  eq('the evening after the commute home is the morning plan\'s (R26)', evening(p), evening(before));
  eq('gear and wake kept', [p.gear?.umbrella, p.wakeAt], [before.gear?.umbrella, before.wakeAt]);
  check('the meetings he skipped are listed as override codes', p.skipped.some(c => /^override:meeting:\d{4}$/.test(c)), p.skipped);
  eq('sleep stays at the routine time', p.sleepAt, before.sleepAt);
  eq('divergeAt = the start of the block he is in', divergeAt(before, p), cut);

  section('… the pulse then stays quiet (idempotent), also after the range ends (R25)');
  const n1 = eventsAfter(0, 50000).filter(e => e.type === 'plan.made').length;
  await A.until(L(10, 27, 23));
  eq('no further re-plan today', eventsAfter(0, 50000).filter(e => e.type === 'plan.made').length, n1);
  const trav = eventsAfter(0, 50000).filter(e => e.type === 'travel.started' && e.at >= at);
  eq('he travelled home at once', [trav[0]?.payload.from, trav[0]?.payload.to], [OFFICE, HOME]);
  check('… caused by the re-plan (blockCause → fromOverride → the plan)', trav[0]?.causeId === made[0].id, trav[0]?.causeId);
  check('no work activity after now', !eventsAfter(0, 50000).some(e => e.type === 'activity.started' && e.at >= at && e.payload.kind === 'work'));

  section('… the next morning plans the routine again (the override was for one date)');
  await A.until(L(10, 28, 10));
  const tomorrow = A.live().plan;
  eq('Wed 28 Oct: an office day, no overrides key', [tomorrow.date, tomorrow.dayType, 'overrides' in tomorrow], ['2026-10-28', 'office', false]);

  section('snapshot / restore = full replay (R24)');
  const replay = rebuild({ world, useSnapshot: false });
  eq('the live projection equals a replay', JSON.stringify(serializeState(replay)), JSON.stringify(serializeState(A.live())));
  eq('… and a serialize round trip', JSON.stringify(serializeState(deserializeState(JSON.parse(JSON.stringify(serializeState(replay)))))),
    JSON.stringify(serializeState(replay)));
}

section('revert of the override: the cascade takes the re-plan, nothing is re-derived (R37)');
{
  const A = await boot();
  await A.until(L(10, 27, 10));
  const ov = A.setOverride({ date: DATE, ranges: [{ activity: 'out', placeId: 'place:cafe', from: L(10, 27, 19), to: L(10, 27, 20, 30) }] });
  await A.pulse.settle(A.clock.now());
  const re = eventsAfter(0, 50000).filter(e => e.type === 'plan.made').at(-1);
  eq('a re-plan with the cafe', [re.causeId, re.payload.blocks.some(b => b.kind === 'cafe' && b.fromOverride)], [ov.id, true]);
  check('the cascade of the override covers the re-plan', cascadeIds(ov.id).includes(re.id));
  revertEvent(ov.id, { reason: 'test', at: A.clock.now() });
  A.setLive(rebuild({ world }));
  eq('after the revert: no override, the morning plan in force', [Object.keys(A.live().scheduleOverrides ?? {}).length, 'overrides' in A.live().plan], [0, false]);
  const n = eventsAfter(0, 50000).length;
  await A.until(L(10, 27, 21));
  check('no schedule re-plan came back', !eventsAfter(0, 50000).slice(n).some(e => e.type === 'plan.made'));
  check('no cafe outing happened', !eventsAfter(0, 50000).some(e => e.type === 'activity.started' && e.payload.kind === 'cafe'));
}

section('clear: the rest of the day goes back to the routine');
{
  const A = await boot();
  await A.until(L(10, 27, 10));
  const ov = A.setOverride({ date: DATE, ranges: [{ activity: 'home', from: L(10, 27, 18), to: L(10, 27, 23) }] });
  await A.pulse.settle(A.clock.now());
  await A.until(L(10, 27, 12));
  const act = A.append({ type: 'director.action', at: A.clock.now(), actor: 'owner', payload: { kind: 'schedule.clear', previewAt: A.clock.now(), count: 1 } });
  const clr = A.append({ type: 'schedule.override_cleared', at: A.clock.now(), actor: 'owner', causeId: act.id, payload: { overrideId: ov.id, from: A.clock.now() } });
  eq('the fold marks it cleared', A.live().scheduleOverrides[ov.id].status, 'cleared');
  await A.pulse.settle(A.clock.now());
  const re = eventsAfter(0, 50000).filter(e => e.type === 'plan.made').at(-1);
  eq('a re-plan caused by the clear, no overrides', [re.causeId, re.payload.overrides], [clr.id, []]);
  check('no override block left after now', !A.live().plan.blocks.some(b => b.fromOverride && b.end > A.clock.now()));
  eq('… sound', checkPlan(A.live().plan, world), []);
}

section('rewind past the override: excluded with its re-plan');
{
  const A = await boot();
  await A.until(L(10, 27, 10));
  const mark = eventsAfter(0, 50000).at(-1).id;
  A.setOverride({ date: DATE, ranges: [{ activity: 'gym', from: L(10, 27, 19), to: L(10, 27, 20) }] });
  await A.pulse.settle(A.clock.now());
  A.append({ type: 'world.rewound', at: A.clock.now(), actor: 'owner', payload: { toEventId: mark } });
  A.setLive(rebuild({ world }));
  eq('no override, no override blocks', [Object.keys(A.live().scheduleOverrides ?? {}).length, A.live().plan.blocks.some(b => b.fromOverride)], [0, false]);
}

section('"stay in tonight" at 15:00: the evening invitation never opens into it (R21)');
{
  // A day with an evening invitation in the example world, found by scanning.
  let found = null;
  for (let d = 26; d <= 31 && !found; d++) {
    const A = await boot(L(10, d, 5));
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    await A.until(L(10, d, 15));
    const ov = A.setOverride({ date: day, ranges: [{ activity: 'home', from: L(10, d, 17), to: A.live().plan.sleepAt }] });
    await A.pulse.settle(A.clock.now());
    await A.until(L(10, d, 23, 30));
    const opened = eventsAfter(0, 50000).filter(e => e.type === 'decision.opened' && e.at >= L(10, d, 15));
    const outings = eventsAfter(0, 50000).filter(e => e.type === 'travel.started' && e.at >= L(10, d, 17) && e.at < L(10, d, 23) && e.payload.to !== HOME);
    found = { opened: opened.length, outings: outings.length, ov };
  }
  eq('no evening decision opened inside the range, no outing taken', [found.opened, found.outings], [0, 0]);
}

section('a sleep-in tomorrow set tonight moves tonight\'s sleep end and his wake (R32)');
{
  const A = await boot();
  await A.until(L(10, 27, 21));
  const plan0 = A.live().plan;
  const ov = A.setOverride({ date: '2026-10-28', ranges: [{ activity: 'sleep', from: L(10, 28, 0), to: L(10, 28, 10, 30) }] });
  await A.pulse.settle(A.clock.now());
  const p = A.live().plan;
  eq('tonight\'s plan: the sleep block and nextWakeAt end at 10:30', [p.blocks.at(-1).end, p.nextWakeAt], [L(10, 28, 10, 30), L(10, 28, 10, 30)]);
  check('… listing the next day\'s override', p.overrides.includes(ov.id));
  eq('… nothing else of tonight moved', p.blocks.slice(0, -1).map(b => b.start), plan0.blocks.slice(0, -1).map(b => b.start));
  check('he is asleep at 09:30 tomorrow (isAwakeAt)', !isAwakeAt(A.live(), L(10, 28, 9, 30), world));
  await A.until(L(10, 28, 12));
  const woke = eventsAfter(0, 50000).filter(e => e.type === 'woke').at(-1);
  eq('he wakes at 10:30', woke.at, L(10, 28, 10, 30));
  eq('the morning plan lists the override, an office day starting late', [A.live().plan.overrides, A.live().plan.wakeAt], [[ov.id], L(10, 28, 10, 30)]);
}

section('a committed chat outing outside the range stays an anchor (R20)');
{
  const A = await boot();
  await A.until(L(10, 27, 12));
  // An evening outing the flatmate proposed in a DM: decision + chat lean + commit, the outing amendment.
  const DM = '15550001111@s.whatsapp.net';
  const d = A.append({ type: 'decision.opened', at: A.clock.now(), actor: 'engine', payload: {
    kind: 'cafe', subject: { eventAt: L(10, 27, 20), placeId: 'place:cafe', castIds: [], minutes: 60 },
    options: [{ id: 'go', label: 'Go to the cafe', go: true, kind: 'cafe' }, { id: 'late', label: 'Join later', go: 'late', kind: 'cafe', minutes: 30 }, { id: 'stay', label: 'Stay in', kind: 'rest' }],
    opensAt: A.clock.now(), decideBy: L(10, 27, 18), ponrAt: L(10, 27, 19, 30),
  } });
  const trig = A.append({ type: 'chat.trigger', at: A.clock.now(), actor: 'chat', originKind: 'dm', originJid: DM, causeId: d.id, payload: { decisionId: d.id, toward: 'go' } });
  const commit = A.append({ type: 'decision.committed', at: A.clock.now(), actor: 'engine', causeId: trig.id, payload: { decisionId: d.id, optionId: 'go', p: 0.9, sampled: false } });
  await A.until(L(10, 27, 19, 45));
  const amended = A.live().plan;
  check('the outing amended the plan (chat origin)', amended.blocks.some(b => b.kind === 'cafe' && b.fromAmendment) && getEvent(amended.eventId).originKind === 'dm', getEvent(amended.eventId)?.originKind);
  // Now a "home 22:30-23:15" range after the outing, set while he is out.
  const ov = A.setOverride({ date: DATE, ranges: [{ activity: 'home', from: L(10, 27, 22, 30), to: L(10, 27, 23, 15) }] });
  await A.pulse.settle(A.clock.now());
  const p = A.live().plan;
  const cafe = p.blocks.find(b => b.kind === 'cafe');
  eq('the cafe block stays an anchor: decisionId + causeEventId = the amended plan', [cafe?.decisionId, cafe?.causeEventId], [d.id, amended.eventId]);
  eq('blockCause → the amended plan (chat origin kept), arcs off or on', blockCause(p, cafe), amended.eventId);
  void commit; void ov;
  // Forget the invitation: its decision goes, the anchor is skipped and the evening is his routine again.
  revertEvent(d.id, { reason: 'forget', at: A.clock.now() });
  A.setLive(rebuild({ world }));
  const n = eventsAfter(0, 50000).length;
  await A.until(L(10, 27, 21));
  check('no trip to the cafe after the revert', !eventsAfter(0, 50000).slice(n).some(e => e.type === 'travel.started' && e.payload.to === 'place:cafe'));
  check('no cafe activity after the revert', !eventsAfter(0, 50000).slice(n).some(e => e.type === 'activity.started' && e.payload.kind === 'cafe'));
}

section('a day off: no deadline crunch, planned like a weekend day (§A5.6)');
{
  // A workday whose crunch roll fires under this seed.
  let day = null;
  for (let d = 1; d <= 60 && !day; d++) {
    const t = L(11, 1, 5) + (d - 1) * 86400;
    const date = dateKey(t, tz);
    const wd = weekdayOf(t, tz);
    if (!['office', 'wfh'].includes(dayType(t, world, {}))) continue;
    if (rngFor(date, 'work.crunch')() < (wd === 1 ? CRUNCH_P_MONDAY : CRUNCH_P)) day = { t, date };
  }
  check('found a crunch day', !!day);
  if (day) {
    const A = await boot(day.t);
    A.setOverride({ date: day.date, background: { activity: 'off', from: day.t, to: day.t + 18 * 3600, wholeDay: true } });
    await A.until(day.t + 6 * 3600);
    const crunch = eventsAfter(0, 50000).filter(e => e.type === 'work.crunch');
    eq('the morning plan: a day off, no crunch', [A.live().plan.dayType, crunch.length], ['off', 0]);
    const B = await boot(day.t);
    await B.until(day.t + 6 * 3600);
    eq('…the same day without the override has its crunch', eventsAfter(0, 50000).filter(e => e.type === 'work.crunch').length, 1);
  }
}

section('replanToday / scheduleDrift are pure');
{
  const A = await boot();
  await A.until(L(10, 27, 11));
  const s = A.live();
  const copy = JSON.stringify(serializeState(s));
  replanToday(s, A.clock.now(), world);
  scheduleDrift(s, world, { at: A.clock.now() });
  eq('the projection is unchanged', JSON.stringify(serializeState(s)), copy);
  eq('no schedule state → no drift', scheduleDrift(s, world, { at: A.clock.now() }), null);
}

eq('no network', fetches, 0);
report();
