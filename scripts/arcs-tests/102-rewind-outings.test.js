// A rewind and a committed outing: the log and the state never disagree (property tests, plan 020 E5). Rewound to before it with the
// window still open: nothing is written, it stays committed, and the pulse decides: he goes late, or one could_not_go. With the window
// gone: one `rewound`, closed at once. Rewound to the middle of it: it resumes, nothing expires. Example world, fake clock, stubbed models.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR } from './_helpers.js';
import { appendEvent, eventsAfter, lastEventId } from '../../src/life/eventLog.js';
import { isExcludedId, stateBeforeEvent } from '../../src/life/projector.js';
import { SCENE_OBSERVERS } from '../../src/life/story/reducer.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';

await setupScratchDb();
const { clock, life } = await bootLife({ callRole: fakeCallRole({}) });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: false }), knownNames: () => [] });
const S = () => life.getState();
const MIN = 60;
const t5 = (t) => Math.round(t / 300) * 300;
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
async function outing(startAt, minutes) {
  const before = lastEventId();
  const pv = await story.director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes, castIds: ['cast:flatmate'], label: 'Catch-up' }, { relax: true });
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  check('the outing applied', res?.ok === true, JSON.stringify(res)?.slice(0, 200));
  await story.lastScheduleKick();
  return eventsAfter(before, 500).find(e => e.type === 'decision.opened')?.id ?? null;
}
async function rewindTo(at) {
  const pv = await director.preview({ kind: 'rewind', at, reason: 'test' });
  await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  return pv;
}
const expiries = (id) => eventsAfter(id, 200000).filter(e => e.type === 'decision.expired' && e.payload?.decisionId === id && !isExcludedId(S(), e.id)).map(e => e.payload.reason);
const startsAt = (id, after) => eventsAfter(after, 200000).filter(e => e.type === 'activity.started' && e.payload?.placeId === 'place:cafe' && !isExcludedId(S(), e.id) && e.id > id);
const statusOf = (id) => S().decisions.get(id)?.status ?? 'pruned';

await simulateHours(3);

section('rewound to before it, the window still open: nothing written, the pulse decides');
{
  const start = t5(clock.now() + 4 * HOUR);
  const did = await outing(start, 240);
  await stepTo(start + 20 * MIN);
  check('(setup) he got there', startsAt(did, did).length >= 1);
  const mark = lastEventId();
  await rewindTo(start - 30 * MIN);
  eq('no rewound on it', expiries(did), []);
  eq('still committed', statusOf(did), 'committed');
  await stepTo(start + 270 * MIN);
  const after = startsAt(did, mark);
  const ex = expiries(did);
  check('he goes late, or it closes once', after.length >= 1 ? ex.length === 0 : ex.length === 1 && ex[0] === 'could_not_go', JSON.stringify({ starts: after.length, ex }));
  eq('never a rewound', ex.includes('rewound'), false);
  if (!after.length) eq('…and could_not_go closed it', statusOf(did), 'missed');
}

section('rewound to before it, the window gone: one rewound, closed at once');
{
  const start = t5(clock.now() + 4 * HOUR);
  const did = await outing(start, 60);
  await stepTo(start + 3 * HOUR);
  check('(setup) he went', startsAt(did, did).length >= 1);
  const mark = lastEventId();
  const pv = await rewindTo(start - 30 * MIN);
  eq('one rewound', expiries(did), ['rewound']);
  eq('closed at once', statusOf(did), 'cancelled');
  check('the preview says so', pv.warnings?.some(w => /rewound away/.test(typeof w === 'string' ? w : w?.text ?? '')), JSON.stringify(pv.warnings)?.slice(0, 300));
  await simulateHours(8, { stepMinutes: 5 });
  eq('no late fit', startsAt(did, mark).filter(e => e.at <= start + 12 * HOUR && e.at >= start).length, 0);
  eq('no second expiry', expiries(did), ['rewound']);
  eq('a fold of the log reads the same', stateBeforeEvent(lastEventId())?.decisions?.get(did)?.status ?? 'pruned', statusOf(did));
}

section('rewound to the middle of it: it resumes');
{
  const start = t5(clock.now() + 4 * HOUR);
  const did = await outing(start, 180);
  await stepTo(start + 30 * MIN);
  // Something to rewind past: nothing else happens while he sits there.
  appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'engine', payload: { castId: 'cast:flatmate', delta: { closeness: 0.01 }, reason: 'shared_time' } });
  story.__rebuildForTest();
  await stepTo(start + 60 * MIN);
  const mark = lastEventId();
  await rewindTo(start + 10 * MIN);
  eq('nothing expires', expiries(did), []);
  eq('still committed', statusOf(did), 'committed');
  await stepTo(start + 100 * MIN);
  check('it resumed', startsAt(did, mark).length >= 1);
  await stepTo(start + 200 * MIN);
  eq('nothing expired by the end', expiries(did), []);
}

section('the rest of an expiry is as for any other');
{
  const handler = SCENE_OBSERVERS['decision.expired'];
  const followUp = (reason) => {
    const s = { story: { followups: { a: { status: 'fitted', decisionId: 5 } } } };
    handler(s, { at: 100 }, { decisionId: 5, reason });
    return [s.story.followups.a.status, s.story.followups.a.decisionId];
  };
  eq('its follow-up reopens, like could_not_go', followUp('rewound'), followUp('could_not_go'));
  // An open decision a rewind found stale has always folded as expired: old rows replay the same.
  const t = clock.now();
  const opened = appendEvent({ type: 'decision.opened', at: t, actor: 'engine', payload: {
    kind: 'hangout', category: 'social', mode: 'auto', decideBy: t + HOUR, ponrAt: t + 2 * HOUR,
    options: [{ id: 'go', label: 'Go', cost: {}, expiresAt: t + 2 * HOUR }, { id: 'stay', label: 'Stay', cost: {}, expiresAt: t + 2 * HOUR }],
    subject: { eventAt: t + 3 * HOUR, endAt: t + 4 * HOUR, placeId: 'place:cafe', castIds: [] } } });
  appendEvent({ type: 'decision.expired', at: t, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, reason: 'rewound' } });
  story.__rebuildForTest();
  eq('an open one still reads expired', statusOf(opened.id), 'expired');
}

// Batch 3 review, finding 35: a family occasion he committed to 'attend' — an option the pulse never moves
// him for, so it has no activity.started — lived days ago; an unrelated 30-minute rewind cancelled it
// ("1 plans are rewound away") although its window lies wholly before the target.
section('an old committed attend and an unrelated short rewind: it stays committed, no "rewound away"');
{
  const t = clock.now();
  const eventAt = t5(t + 6 * HOUR);
  const opened = appendEvent({ type: 'decision.opened', at: t, actor: 'engine', payload: {
    kind: 'family:gathering', category: 'family', big: true, mode: 'ask', opensAt: t, decideBy: eventAt - HOUR,
    options: [{ id: 'attend', label: 'Go to the family lunch', cost: {} }, { id: 'call', label: 'Call instead', cost: {} }, { id: 'skip', label: 'Skip it', cost: {} }],
    subject: { eventAt, placeId: 'place:family-home', castIds: ['cast:parent'] } } });
  appendEvent({ type: 'decision.committed', at: t + 60, actor: 'owner', payload: { decisionId: opened.id, optionId: 'attend', p: 1, sampled: false, by: 'owner' } });
  story.__rebuildForTest();
  eq('(setup) committed to attend', [statusOf(opened.id), S().decisions.get(opened.id)?.committed?.optionId], ['committed', 'attend']);
  await simulateHours(36);
  eq('(setup) 36 h later still committed, never started', [statusOf(opened.id),
    eventsAfter(opened.id, 200000).filter(e => e.type === 'activity.started' && e.payload?.placeId === 'place:family-home').length], ['committed', 0]);
  // A short rewind: to just before the newest event (well after the occasion's window).
  const newest = eventsAfter(lastEventId() - 1, 1)[0];
  const pv = await rewindTo(newest.at - 5 * MIN);
  check('(setup) the rewind is short and after the occasion', newest.at - eventAt > 24 * HOUR, String((newest.at - eventAt) / HOUR));
  check('no "rewound away" warning', !pv.warnings?.some(w => /rewound away/.test(typeof w === 'string' ? w : w?.text ?? '')), JSON.stringify(pv.warnings)?.slice(0, 300));
  eq('no expiry on it', expiries(opened.id), []);
  eq('still committed to attend', statusOf(opened.id), 'committed');
}

report();
