// REVERT THIS CHANGE of an outing he already lived, with a later trip of another plan setting off
// from there (property tests, seeds 20261114 / 31000039: the sweep's two_places info "left the café
// while the log has him at the office"). The revert stays allowed (016: undoing a lived outing is
// never refused); its preview now carries the continuity warning `later_trips_from` — outside the
// fingerprint, so the revert still goes through with it. An outing nothing sets off from afterwards
// gets no such line. Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR } from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import * as story from '../../src/life/story/index.js';
import { laterTripsFrom } from '../../src/life/story/continuity.js';

await setupScratchDb();
const { clock, life } = await bootLife({ callRole: fakeCallRole({}) });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: false }), knownNames: () => [] });
const S = () => life.getState();
const t5 = (t) => Math.round(t / 300) * 300;
async function applyAction(action) {
  const pv = await story.director.preview(action);
  return story.director.apply(pv.previewId, pv.fingerprint);
}

section('the pure rule');
{
  const w = laterTripsFrom({ outings: [{ placeId: 'place:cafe', at: 100 }], trips: [{ id: 9, from: 'place:cafe', at: 200 }, { id: 10, from: 'place:office', at: 300 }], placeWord: () => 'Café' });
  eq('one warning, code + severity + place', w.map(x => [x.code, x.severity, x.refs.placeIds]), [['later_trips_from', 'warn', ['place:cafe']]]);
  check('…in words, naming the place and the count', /Later trips start from Café/.test(w[0].text) && /1 trip\)/.test(w[0].text), w[0].text);
  eq('a trip before the outing, or from elsewhere, is no reason', laterTripsFrom({ outings: [{ placeId: 'place:cafe', at: 100 }], trips: [{ id: 9, from: 'place:cafe', at: 50 }, { id: 10, from: 'place:park', at: 300 }] }), []);
  eq('junk in → nothing, never a throw', laterTripsFrom({ outings: [null, { placeId: 5 }], trips: 'x' }), []);
}

section('a lived café outing, then a schedule errand straight after it');
let outingAction = null;
{
  await simulateHours(3);   // Tue 09:00
  const start = t5(clock.now() + 2 * HOUR);
  const res = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: start, minutes: 60, castIds: ['cast:flatmate'], label: 'Coffee with the flatmate' });
  outingAction = res.actionEventId;
  const hh = (t) => new Date(t * 1000).toISOString().slice(11, 16);   // the suite's zone is UTC
  await applyAction({ kind: 'schedule', day: 0, ranges: [{ activity: 'errand', placeId: 'place:grocery', from: hh(start + HOUR), to: hh(start + HOUR + 45 * 60) }] });
  await simulateHours(5);
  const trip = listEvents({ types: ['travel.started'], limit: 200 }).find(e => e.payload?.from === 'place:cafe');
  check('he went, then set off from the café for the errand', !!trip, JSON.stringify(listEvents({ types: ['travel.started'], limit: 50 }).map(e => [e.payload?.from, e.payload?.to])));
}

section('REVERT THIS CHANGE of the outing: allowed, with the warning');
{
  const p = life.revertChangePreview(outingAction);
  eq('no refusal (undoing a lived outing is allowed)', p.refusals, []);
  const codes = (p.continuity?.warnings ?? []).map(w => w.code);
  eq('the continuity warning later_trips_from', codes, ['later_trips_from']);
  check('…about the café', p.continuity.warnings[0].refs.placeIds[0] === 'place:cafe');
  const r = life.revertChange(outingAction, { fingerprint: p.fingerprint });
  check('the revert goes through with the preview\'s fingerprint (the warning is outside it)', (r?.reverted?.length ?? 0) > 0, JSON.stringify(r).slice(0, 200));
}

// Batch 3 review, finding 39: he went back to the café on a later plan, and that plan's own trip home sets
// off from there — not a trip "from a place he never went to". Only a trip with no return there in between counts.
section('a later revisit to the same place: its own trip from there is no reason');
{
  const startA = t5(clock.now() + 2 * HOUR);
  const a = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: startA, minutes: 45, castIds: ['cast:coworker-a'], label: 'Coffee A' });
  await simulateHours(3);
  const startB = t5(clock.now() + 2 * HOUR);
  await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: startB, minutes: 45, castIds: ['cast:coworker-b'], label: 'Coffee B' });
  await simulateHours(4);
  const fromCafe = listEvents({ types: ['travel.started'], limit: 2000 }).filter(e => e.payload?.from === 'place:cafe' && e.at >= startB);
  check('(setup) after B he set off from the café', fromCafe.length >= 1);
  const p = life.revertChangePreview(a.actionEventId);
  eq('no later_trips_from for A (the trip follows his return there)', (p.continuity?.warnings ?? []).map(w => w.code), []);
  eq('the pure rule: a return between the outing and the trip clears it', laterTripsFrom({
    outings: [{ placeId: 'place:cafe', at: 100 }], trips: [{ id: 9, from: 'place:cafe', at: 300 }], returns: [{ placeId: 'place:cafe', at: 200 }] }), []);
  eq('…a return elsewhere, or after the trip, does not', laterTripsFrom({
    outings: [{ placeId: 'place:cafe', at: 100 }], trips: [{ id: 9, from: 'place:cafe', at: 300 }],
    returns: [{ placeId: 'place:park', at: 200 }, { placeId: 'place:cafe', at: 400 }] }).map(w => w.code), ['later_trips_from']);
}

section('an outing nothing sets off from afterwards: no such line');
{
  const start = t5(clock.now() + 2 * HOUR);
  const res = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:park', startAt: start, minutes: 45, castIds: ['cast:sibling'], label: 'A walk' });
  await simulateHours(1.5);
  const p = life.revertChangePreview(res.actionEventId);
  eq('no later_trips_from before he has gone', (p.continuity?.warnings ?? []).map(w => w.code), []);
}

report();
