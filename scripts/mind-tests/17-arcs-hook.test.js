// 010 T025 — the mind's two story seams (contracts/story-api.md §3.8, §3.8b):
//   - sleep step 4b: runSleep feature-detects life.storyWeeklyPass and calls it once
//     with { nightKey, trigger, budgetOk } where budgetOk is mindBudgetOk('sleep')'s
//     OBJECT (not a boolean); a throwing hook never fails the night; no export → no
//     call; the night's status is never changed by it;
//   - pulse collectAnchors: an adopted commit (decision.committed {by:'adopted'}) is
//     not a think anchor; an owner-pick commit still is; the event cursor still moves
//     past the skipped id.
// Scratch DB, fake clock, stubbed models and life, no network.
import {
  setupScratchDb, fakeClock, fakeCallRole, fakeLife, blockNetwork, setBot,
  section, check, eq, report, DAY,
} from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const { config } = await import('../../src/utils/config.js');
config.timezone = 'UTC';
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const sleep = await import('../../src/mind/sleep.js');
const pulseMod = await import('../../src/mind/pulse.js');

const REAL = Math.floor(Date.now() / 1000);
const fc = fakeClock(REAL);
clock.setClock(fc.fn);
await setBot();

const llm = fakeCallRole({
  'mind.sleep': () => JSON.stringify({ v: 1, morning_mood: { word: 'content', intensity: 0.5 }, intentions: [], nudges: [],
    next_think_in_minutes: 600, note: 'quiet night', reach_out: [] }),
});
const budgetObj = { ok: true, reason: null, spentUsd: 0.1, capUsd: 10 };
const budgetCalls = [];
let life = fakeLife({ on: true, events: [] });
sleep.__setDepsForTest({
  now: fc.fn,
  isMindOn: () => true,
  callRole: llm.fn,
  budgetOk: async (kind) => { budgetCalls.push(kind); return budgetObj; },
  clerkBudgetLeft: () => true,
  candidateChats: async () => [],
  selfModel: async () => ({ runSelfModel: async () => ({ status: 'not_due', runId: null }) }),
  life: async () => life,
});

section('sleep step 4b: storyWeeklyPass is called with the budget OBJECT');
{
  const calls = [];
  life.storyWeeklyPass = async (opts) => { calls.push(opts); return { status: 'skipped', reason: 'not_due' }; };
  const nk = clock.nightKey(fc.now());
  const r = await sleep.runSleep(nk, 'night');
  check('the night finished', ['done', 'partial'].includes(r.status), r.status);
  eq('called once', calls.length, 1);
  eq('with this night and trigger', [calls[0]?.nightKey, calls[0]?.trigger], [nk, 'night']);
  check("budgetOk is mindBudgetOk('sleep')'s object, not a boolean", calls[0]?.budgetOk === budgetObj && typeof calls[0]?.budgetOk === 'object');
  check("asked for the 'sleep' budget", budgetCalls.includes('sleep'));
  eq('the night row is done', store.getNight(nk)?.status, 'done');
}

section('a throwing hook does not fail the night');
{
  fc.advance({ seconds: DAY });
  let called = 0;
  life.storyWeeklyPass = async () => { called++; throw new Error('weekly blew up'); };
  const nk = clock.nightKey(fc.now());
  const r = await sleep.runSleep(nk, 'night');
  eq('hook was called', called, 1);
  check('the night still finished', ['done', 'partial'].includes(r.status), r.status);
  eq('night row done', store.getNight(nk)?.status, 'done');
}

section('no export → no call');
{
  fc.advance({ seconds: DAY });
  life = fakeLife({ on: true, events: [] });
  check('the fake life has no storyWeeklyPass', typeof life.storyWeeklyPass !== 'function');
  const nk = clock.nightKey(fc.now());
  const r = await sleep.runSleep(nk, 'night');
  check('the night finished without the hook', ['done', 'partial'].includes(r.status), r.status);
}

section('sleep self events: only 009 types are read when life names them (010 review)');
{
  fc.advance({ seconds: DAY });
  const seen = [];
  const base = life.listEvents.bind(life);
  life.selfEventTypes = () => ['meal', 'work.late'];
  life.listEvents = (opts = {}) => { seen.push(opts); return base(opts); };
  await sleep.runSleep(clock.nightKey(fc.now()), 'night');
  check('the self-event read asks for those types', seen.some(o => Array.isArray(o.types) && o.types.join() === 'meal,work.late'), seen);
  fc.advance({ seconds: DAY });
  delete life.selfEventTypes;
  seen.length = 0;
  await sleep.runSleep(clock.nightKey(fc.now()), 'night');
  check('no selfEventTypes → the 009 read (no types)', seen.length > 0 && seen.every(o => o.types === undefined), seen);
  life.listEvents = base;
}

section('pulse anchors: an adopted commit makes no think anchor, an owner pick does');
{
  const anchorLife = fakeLife({ on: true, events: [] });
  pulseMod.__setDepsForTest({
    now: fc.fn, isMindOn: () => true, scanSince: () => [], life: async () => anchorLife,
    knobsReload: async () => true, expireNudges: async () => 0,
  });
  const st0 = Number(store.getState().lastEventId) || 0;
  anchorLife.events = [
    { id: st0 + 1, type: 'decision.committed', at: fc.now(), payload: { decisionId: 7, optionId: 'go', by: 'adopted' } },
    { id: st0 + 2, type: 'decision.committed', at: fc.now(), payload: { decisionId: 8, optionId: 'accept', by: 'owner' } },
    { id: st0 + 3, type: 'decision.committed', at: fc.now(), payload: { decisionId: 9, optionId: 'stay', by: 'sample' } },
  ];
  const r = await pulseMod.pulse({ events: [{ id: st0 + 4, type: 'decision.committed', at: fc.now(), payload: { by: 'adopted' } }] });
  eq('anchors: the owner pick and the sampled commit only', r.flags.anchors.map(a => a.id), [st0 + 2, st0 + 3]);
  eq('the cursor still moved past the adopted ones', store.getState().lastEventId, st0 + 4);
}

section('pulse anchors (spec 012): his answer to an invitation and chat-origin decision events wake nothing');
{
  const anchorLife = fakeLife({ on: true, events: [] });
  pulseMod.__setDepsForTest({
    now: fc.fn, isMindOn: () => true, scanSince: () => [], life: async () => anchorLife,
    knobsReload: async () => true, expireNudges: async () => 0,
  });
  const st0 = Number(store.getState().lastEventId) || 0;
  anchorLife.events = [
    { id: st0 + 1, type: 'decision.committed', at: fc.now(), payload: { decisionId: 7, optionId: 'go', by: 'reply' }, originKind: 'group' },
    { id: st0 + 2, type: 'decision.reversed', at: fc.now(), payload: { decisionId: 7, from: 'go', to: 'stay' }, originKind: 'group' },
    { id: st0 + 3, type: 'decision.committed', at: fc.now(), payload: { decisionId: 8, optionId: 'stay', by: 'sample' }, originKind: 'dm' },
    { id: st0 + 4, type: 'decision.committed', at: fc.now(), payload: { decisionId: 9, optionId: 'stay', by: 'sample' }, originKind: 'self' },
    { id: st0 + 5, type: 'sick.started', at: fc.now(), payload: {}, originKind: 'self' },
  ];
  const r = await pulseMod.pulse({ events: [] });
  eq('anchors: the self-origin commit and the sickness only', r.flags.anchors.map(a => a.id), [st0 + 4, st0 + 5]);
  eq('the cursor moved past all of them', store.getState().lastEventId, st0 + 5);
}

section('sleep step 2b: his stances update, before anything can stop the night, and never change its status');
{
  const calls = [];
  const freeCalls = [];
  sleep.__setDepsForTest({ stanceUpdate: async (nk) => { calls.push(nk); }, stanceFree: async (nk, entries) => { freeCalls.push([nk, entries.length]); } });
  fc.advance({ days: 2 });
  const nk = clock.nightKey(fc.now());
  await sleep.runSleep(nk, 'night');
  eq('called once for this night', calls, [nk]);
  eq('free topics after it, with the night\'s episodes', freeCalls, [[nk, 0]]);

  // A reflection that fails stops the night early: the update has already run.
  fc.advance({ days: 2 });
  const nk2 = clock.nightKey(fc.now());
  const quietLife = life;
  life = fakeLife({ on: true, events: [{ id: 1, type: 'sick.started', at: fc.now() - 3600, originKind: 'self', payload: {} }] });   // something to reflect on
  sleep.__setDepsForTest({ callRole: async () => ({ status: 'error', text: '' }) });
  const failed = await sleep.runSleep(nk2, 'night');
  life = quietLife;
  eq('that night stopped at its reflection', failed.status, 'failed');
  check('the update ran for it anyway', calls.includes(nk2), calls);
  sleep.__setDepsForTest({ callRole: llm.fn });

  fc.advance({ days: 2 });
  const nk3 = clock.nightKey(fc.now());
  sleep.__setDepsForTest({ stanceUpdate: async () => { throw new Error('boom'); }, stanceFree: async () => { throw new Error('boom'); } });
  const r = await sleep.runSleep(nk3, 'night');
  check('a throwing update never fails the night', ['done', 'partial'].includes(r.status), r.status);
  eq('the night row is done', store.getNight(nk3)?.status, 'done');
  sleep.__setDepsForTest({ stanceUpdate: async () => {}, stanceFree: async () => {} });
}

section('the pulse sweeps: a revert reaches his stances on the next pass, also while paused');
{
  const stance = await import('../../src/mind/stance.js');
  const row = store.putStance({ topic: 'kind:cafe', label: 'cafe', kind: 'interest', value: 0.5, status: 'active', source: 'seed' });
  store.addStanceEvidence(row.id, '2026-11-01', { at: fc.now(), source: 'work', cause: 'work_late', weight: 1, eventIds: [777] });
  store.setStanceSetting('stance_exclusion_sig', '0:0');
  stance.__setDepsForTest({ now: fc.fn, life: async () => ({ stanceExclusionSig: () => '1:0', stanceIsExcluded: (id) => id === 777 }) });
  await pulseMod.pulse({ events: [] });
  eq('the evidence went', store.stanceEvidence(row.id).length, 0);
  eq('the signature moved on', store.getSetting('stance_exclusion_sig', null), '1:0');
  stance.__setDepsForTest(null);
}

eq('no network', net.length, 0);
report();
