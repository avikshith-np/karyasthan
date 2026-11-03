// 016 scene play-outs — the guards from the review (plan §P1.1 step 6, R1, R8/R16, R9, R10,
// R23, R32, D9): a paused Director and a heavy stretch at the session get the code one-liner
// with no model call and no effects; a scene from around a heavy stretch is DM/call-only
// forever, never in the journal or on the site, and heavy-caused beats never reach a sheet;
// REGENERATE reuses v1's roll (a hint's outcome word sets it); scene callers live under
// life.scene.* (never the arcs budget) and a chat's outing is clerk-only with its own day
// cap; a row a crash left 'running' is played after a restart; every version's text goes
// when the outing leaves the log; a reverted scene keeps its panel and can be rewritten;
// the model never sees or keeps a venue's name. Example world, fake clock, stubbed models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, seedPeople, HOUR, DAY,
} from './_helpers.js';
import { appendEvent, getEvent, listEvents, revertEvent } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as worker from '../../src/life/story/scenes/worker.js';
import { tierOf } from '../../src/life/story/scenes/detect.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import { renderUser } from '../../src/life/story/scenes/charter.js';
import { validateSceneOutput } from '../../src/life/story/scenes/schema.js';
import { arcsCallerSpend } from '../../src/life/story/seed.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
await seedPeople(['Quinn Marlow']);
let answer = null;
const users = [];
const cr = fakeCallRole({
  'life.scene.clerk': (s, u, o, i) => { users.push(u); return answer ? answer('clerk', u, i) : null; },
  'life.scene.mind': (s, u, o, i) => { users.push(u); return answer ? answer('mind', u, i) : null; },
});
let usageRows = [];
const deps = { getUsageByCaller: (prefix) => usageRows.filter(r => r.caller.startsWith(prefix)), mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] };
let { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest(deps);
const S = () => life.getState();
const applyAction = async (a) => { const pv = await director.preview(a); return director.apply(pv.previewId, pv.fingerprint); };
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
const sceneCalls = () => cr.calls.filter(c => /^life\.scene\./.test(c.caller ?? '')).length;
const json = (o = {}) => JSON.stringify({
  narration: 'They sat by the window and talked through most of the evening about films, food and nothing much. It was easy and warm, and he walked home in a good mood.',
  impressions: null, topics: ['films'], highlight: 'talking through the evening', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing',
  effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }], ...o,
});
// An outing that just ended: self origin (engine, no cause) unless a chat claim is given.
function fab({ cast = ['cast:flatmate'], startAgo = 3 * HOUR, minutes = 60, kind = 'hangout', place = 'place:cafe', chat = null } = {}) {
  const t0 = clock.now() - startAgo;
  const flag = chat ? appendEvent({ type: 'claim.flagged', at: t0 - HOUR, actor: 'chat', originKind: chat.kind, originJid: chat.jid, payload: { claimId: 7, kind: 'plan' } }) : null;
  const st = appendEvent({ type: 'activity.started', at: t0, actor: 'engine', ...(flag ? { causeId: flag.id } : {}),
    payload: { kind, placeId: place, withCast: cast, social: true, availability: 'busy', end: t0 + minutes * 60 } });
  appendEvent({ type: 'activity.ended', at: t0 + minutes * 60, actor: 'engine', causeId: st.id, payload: { kind, placeId: place } });
  story.__rebuildForTest();
  return st;
}
const effectsOf = (eventId) => listEvents({ types: ['relationship.changed'] }).filter(e => e.causeId === eventId).length;
const GROUP = { chatJid: '120363000000000077@g.us', kind: 'group', members: ['15550001234@s.whatsapp.net', '15550005678@s.whatsapp.net'] };
const DM = { chatJid: '15550001234@s.whatsapp.net', kind: 'dm', members: ['15550001234@s.whatsapp.net'] };

await simulateHours(3);
await drain();

section('a paused Director: the code one-liner, no model call, no effects (P1.1 step 6)');
{
  answer = () => json();
  await applyAction({ kind: 'pause', reason: 'holiday' });
  const c0 = sceneCalls();
  const st = fab();
  await drain();
  const row = sceneStore.versionsOf(st.id)[0];
  eq('paused → no call, code one-liner (paused), no effects', [sceneCalls() - c0, row?.status, row?.tier, row?.skipReason, effectsOf(row?.eventId)],
    [0, 'fallback', 'code', 'paused', 0]);
  await applyAction({ kind: 'resume' });
}

section('a heavy stretch at the session: no model call; heavy_window → DM/call only, forever; beats filtered (R1)');
let heavyRow;
{
  answer = () => json({ narration: 'He spent the afternoon at the family home with his parent. They sat on the porch, drank tea and talked quietly about old neighbours while the light faded over the yard.',
    topics: ['old neighbours'], highlight: 'tea on the porch', effects: [] });
  const now = clock.now();
  const hs = appendEvent({ type: 'heavy.started', at: now - 2 * DAY, actor: 'engine', heavy: true,
    payload: { kind: 'family_illness', themeId: 'parent-hospital', castId: 'cast:parent', until: now + 5 * HOUR } });
  appendEvent({ type: 'cast.beat', at: now - 2 * DAY + 60, actor: 'engine', causeId: hs.id, payload: { castId: 'cast:parent', kind: 'news', text: 'in hospital' } });
  const c0 = sceneCalls();
  const st = fab({ cast: ['cast:parent'], kind: 'visit', place: 'place:family-home', minutes: 120 });
  await drain();
  heavyRow = sceneStore.versionsOf(st.id)[0];
  const ev = getEvent(heavyRow?.eventId);
  eq('during the stretch: no call, the one-liner (heavy), no effects', [sceneCalls() - c0, heavyRow?.status, heavyRow?.tier, heavyRow?.skipReason, effectsOf(ev?.id)],
    [0, 'fallback', 'code', 'heavy', 0]);
  eq('heavy_window on the row and the event', [heavyRow?.heavyWindow, ev?.payload?.heavyWindow], [true, true]);
  appendEvent({ type: 'heavy.ended', at: clock.now(), actor: 'engine', payload: { heavyId: hs.id } });
  await simulateHours(6);   // past `until` too
  story.__rebuildForTest();
  // A later visit (the stretch over, still inside its window): the model writes it, without the heavy-caused beat.
  users.length = 0;
  const st2 = fab({ cast: ['cast:parent'], kind: 'visit', place: 'place:family-home', minutes: 90, startAgo: 2 * HOUR });
  await drain();
  const r2 = sceneStore.versionsOf(st2.id)[0];
  eq('after the stretch: a model scene, still heavy_window', [r2?.status, r2?.tier === 'code', r2?.heavyWindow], ['done', false, true]);
  check('the heavy-caused beat never reaches the sheet', users.length > 0 && !users.some(u => /lately: news|news/.test(u)), users[0]?.slice(0, 400));
  const g = life.sceneLines(GROUP, {}).join('\n');
  check('a group never hears a heavy_window scene (another scene may be told)', !g.includes('porch') && !g.includes('visit'), g);
  check('a DM does', life.sceneLines(DM, {}).join('\n').includes('porch'));
  eq('never on the site', story.publicScenes([r2.eventId, heavyRow.eventId]), []);
  const sc = S().story.scenes[st2.id];
  eq('folded with heavyWindow', sc?.heavyWindow, true);
}

section('REGENERATE reuses v1\'s roll; only a hint\'s outcome word replaces it (R16, R23)');
{
  answer = () => json({ effects: [] });
  const st = fab({ cast: ['cast:coworker-b'], place: 'place:restaurant', kind: 'eat-out', startAgo: 2 * HOUR });
  await drain();
  const v1 = sceneStore.versionsOf(st.id)[0];
  const p1 = getEvent(v1.eventId).payload;
  check('v1 stored its sheet', !!v1.sheet && Array.isArray(v1.sheet.people));
  for (let i = 0; i < 5; i++) appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'owner', payload: { castId: 'cast:coworker-b', delta: { tension: 0.2, closeness: -0.2 }, reason: 'owner' } });
  story.__rebuildForTest();
  users.length = 0;
  const r = await story.sceneRegenerate(v1.id);
  await story.idle();
  const v2 = sceneStore.getScene(r.sceneId);
  const p2 = getEvent(v2.eventId).payload;
  eq('v2 keeps v1\'s outcome and firstMeet', [r.status, p2.outcome, p2.outcomeBy, p2.firstMeet], ['done', p1.outcome, p1.outcomeBy, p1.firstMeet]);
  check('…from v1\'s sheet (closeness bands of the time, not today\'s)', users.some(u => u.includes(`OUTCOME: ${p1.outcome}`) || u.includes(p1.outcome)));
  // A hint with its outcome word sets the outcome, and the output that follows it is valid.
  answer = () => json({ ending: 'parted_badly', effects: [{ p: 'P1', metric: 'tension', dir: 'up', size: 'small' }], highlight: 'the argument at the door',
    narration: 'The evening started fine but turned sour over dinner when an old disagreement came back. By the time they left, neither was speaking much, and they parted at the door on bad terms.' });
  const r3 = await story.sceneRegenerate(v2.id, { tone: 'they argue and part on bad terms', outcome: 'badly' });
  await story.idle();
  const v3 = sceneStore.getScene(r3.sceneId);
  eq('a hint + outcome badly → done, outcome badly (by the owner), the hint recorded', [r3.status, getEvent(v3.eventId)?.payload?.outcome, getEvent(v3.eventId)?.payload?.outcomeBy, v3.tone, v3.toneOutcome],
    ['done', 'badly', 'owner', 'they argue and part on bad terms', 'badly']);
}

section('callers: life.scene.* outside life.arcs.*; a chat\'s outing is clerk-only with its own cap (R10)');
{
  eq('callers', [worker.CALLER_CLERK, worker.CALLER_MIND], ['life.scene.clerk', 'life.scene.mind']);
  usageRows = [{ caller: 'life.scene.mind', calls: 3, costUsd: 0.9 }, { caller: 'life.arcs.weekly', calls: 1, costUsd: 2 }];
  eq('the arcs budget never sees scene spend', await arcsCallerSpend(clock.now(), { tz: world.timezone, getUsageByCaller: deps.getUsageByCaller }), 2);
  const b = await worker.budgetStatus(clock.now(), world.timezone);
  eq('the scene budget sums life.scene.* only', [b?.monthUsd, b?.mindToday], [0.9, 3]);
  usageRows = [];
  eq('a chat outing with a first meeting is still clerk', tierOf({ mode: 'narration_only', castIds: ['cast:coworker-a'], decisionId: null }, S(), { firstMeet: ['cast:coworker-a'] }), 'clerk');
  // The arcs mind budget spent → the scene mind tier still runs (no coupling).
  usageRows = [{ caller: 'life.arcs.weekly', calls: 1, costUsd: 5 }];
  config.arcs.sceneChatMaxPerDay = 0;
  answer = () => json();
  const c0 = sceneCalls();
  const st = fab({ chat: { kind: 'dm', jid: '15550002222@s.whatsapp.net' }, startAgo: 2 * HOUR });
  await drain();
  const row = sceneStore.versionsOf(st.id)[0];
  eq('chat cap 0 → the one-liner (chat_cap), no call', [row?.status, row?.skipReason, sceneCalls() - c0], ['fallback', 'chat_cap', 0]);
  config.arcs.sceneChatMaxPerDay = 2;
  usageRows = [];
}

section('a row a crash left running is played after the restart');
{
  answer = () => json();
  await drain();
  const st = fab({ startAgo: 2 * HOUR });
  worker.scan();
  const row = sceneStore.versionsOf(st.id)[0];
  sceneStore.update(row.id, { status: 'running' }, { fromStatus: 'pending' });   // the process dies in the model call
  await stopLife();
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  await simulateHours(0.5);
  await drain();
  const r = sceneStore.versionsOf(st.id);
  eq('one row, played (done) after the restart', [r.length, r[0]?.status, !!S().story.scenes?.[st.id]], [1, 'done', true]);
}

section('the outing leaves the log → every version\'s text goes, superseded ones too (R9)');
{
  answer = () => json({ narration: 'Version one: they met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. He laughed more than he had all week.' });
  const st = fab({ chat: { kind: 'group', jid: '120363000000000099@g.us' }, startAgo: 2 * HOUR });
  await drain();
  const v1 = sceneStore.versionsOf(st.id)[0];
  answer = () => json({ narration: 'Version two: they met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. He laughed more than he had all week.' });
  const rg = await story.sceneRegenerate(v1.id, {});
  eq('regenerated (v1 superseded, text kept for history)', [rg.status, sceneStore.getScene(v1.id).status, !!sceneStore.getScene(v1.id).text], ['done', 'superseded', true]);
  revertEvent(st.id, { reason: 'forget', by: 'engine' });
  story.__rebuildForTest();
  await drain();
  const rows = sceneStore.versionsOf(st.id);
  eq('every version reverted with no text or detail', rows.map(r => [r.version, r.status, r.text, r.detail, r.sheet ?? null]),
    [[2, 'reverted', null, null, null], [1, 'reverted', null, null, null]]);
  eq('the dashboard serves no text for v1', story.sceneDetail(v1.id)?.text ?? null, null);
}

section('a reverted scene keeps its panel, stays listed, and can be rewritten (R32)');
{
  answer = () => json();
  const st = fab({ cast: ['cast:coworker-a'], startAgo: 2 * HOUR });
  await drain();
  const v1 = sceneStore.versionsOf(st.id)[0];
  life.revertEvent(v1.eventId, { reason: 'not like that' });
  await drain();
  const d = story.sceneDetail(v1.id);
  check('detail after the revert: when, where, who, REVERTED, regenerable', d?.at === st.at && typeof d.place === 'string' && d.with?.[0]?.castId === 'cast:coworker-a'
    && d.excluded === true && d.status === 'reverted' && d.regenerable === true, d);
  const listed = story.castDetail('cast:coworker-a')?.scenes?.find(x => x.eventId === v1.eventId);
  eq('the cast page lists it, marked excluded', listed?.excluded, true);
  const r = await story.sceneRegenerate(v1.id);
  await story.idle();
  const v2 = sceneStore.getScene(r.sceneId);
  eq('regenerate of the reverted scene → v2 live, v1 stays reverted', [r.status, v2?.version, S().story.scenes?.[st.id]?.eventId === v2?.eventId, sceneStore.getScene(v1.id).status],
    ['done', 2, true, 'reverted']);
  eq('…its scene.regenerated record names v1', listEvents({ types: ['scene.regenerated'] }).at(-1)?.payload?.fromEventId, v1.eventId);
  eq('…not regenerable twice from the old row', (await story.sceneRegenerate(v1.id)).reason, 'not_live');
  life.revertEvent(v2.eventId, { reason: 'not that either' });
  await drain();
  eq('both reverted: only the newest offers REGENERATE (the worker\'s rule)', [story.sceneDetail(v1.id)?.regenerable, story.sceneDetail(v2.id)?.regenerable], [false, true]);
  const { vitalsSeries } = await import('../../src/life/projector.js');
  eq('R8: a zero-width vitals series at a session start gives its one checkpoint', vitalsSeries({ from: st.at, to: st.at })?.length, 1);
}

section('D9: the model never sees or keeps a venue\'s name');
{
  const venue = { id: 'place:v1a2b3c4d', name: 'Cafe Mocha', kind: 'cafe', venue: { ref: 'osm:node/1', area: 'Old Town' }, ownerNamed: true };
  const s = { places: new Map([[venue.id, venue]]), cast: new Map([['cast:asha', { name: 'Asha Quill', relation: 'friend', pronouns: 'she/her' }]]),
    story: { relationships: {}, history: {} }, self: { homePlaceId: 'place:home' }, vitals: {} };
  const session = { activityEventId: 1, startAt: 1_700_000_000, endAt: 1_700_005_400, minutes: 90, kind: 'eat-out', placeId: venue.id, home: false,
    castIds: ['cast:asha'], realJid: null, mode: 'full', originKind: 'self', originJid: 'self', decisionId: null };
  for (const outcome of ['well', 'flat']) {
    const built = buildFactSheet(s, session, { tz: 'UTC', outcome: { value: outcome, by: 'code' }, negative: false, persona: { displayName: 'Hero' } });
    const user = renderUser(built.sheet);
    check(`${outcome}: the sheet has the kind word, never the name`, !user.includes('Mocha') && user.includes('a cafe'), user.slice(0, 300));
  }
  const built = buildFactSheet(s, session, { tz: 'UTC', outcome: { value: 'flat', by: 'code' }, persona: { displayName: 'Hero' } });
  const out = {
    narration: 'They met at Cafe Mocha after work. The coffee at Cafe Mocha was bland and overpriced, the service at Cafe Mocha was painfully slow, '
      + 'and the food came out cold. Asha shrugged it off and they talked about her new flat until it was time to leave.',
    impressions: null, topics: ['flats'], highlight: 'talking about her new flat', awkward: 'waiting forty minutes for cold food at Cafe Mocha',
    chemistry: null, focus: 'P1', ending: 'nothing', effects: [],
  };
  const v = validateSceneOutput(JSON.stringify(out), { labels: built.labels, mode: 'full', outcome: 'flat', firstMeet: [], names: built.names,
    knownNames: [], castNames: ['Asha Quill'], venueNames: [{ name: 'Cafe Mocha', kind: 'cafe' }], negative: false });
  check('a venue name in the output is scrubbed, not stored (narration + awkward)', v.ok && !/Mocha/.test(v.value.narration) && !/Mocha/.test(v.value.awkward ?? ''), v);
}

report();
await stopLife();
