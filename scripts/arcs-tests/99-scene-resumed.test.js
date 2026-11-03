// The batch 2 re-review, scenes (plan 020 C4). A cancel undone after its scene was written: one live scene afterwards, told whole,
// with effects and stance evidence counted once. A hop to the next outing with the same person isn't "on his own", also with a wait
// at the place first. "Home" is only his. Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { eventsAfter, getEvent, lastEventId } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as sceneWorker from '../../src/life/story/scenes/worker.js';
import { afterwardsLines } from '../../src/life/story/scenes/facts.js';
import { renderUser } from '../../src/life/story/scenes/charter.js';
import { isExcludedId } from '../../src/life/projector.js';
import { zonedToUnix, localParts, resolveTimezone } from '../../src/life/clock.js';

await setupScratchDb();
const mindStore = await import('../../src/mind/store.js');
const stance = await import('../../src/mind/stance.js');
const calls = [];
const sceneJson = () => JSON.stringify({
  narration: 'They met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. He laughed more than he had all week, and by the end they were trading stories.',
  impressions: null, topics: ['old flatmates'], highlight: 'trading stories', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing',
  effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }],
});
const record = (sys, user) => { calls.push(user); return sceneJson(); };
const { world, clock, life } = await bootLife({ callRole: fakeCallRole({ 'life.scene.clerk': record, 'life.scene.mind': record }) });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] });
mindStore.setStoreClock(clock.fn);
stance.__setDepsForTest({ now: clock.fn, life: async () => life });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const at = (off, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + off * DAY; };
const drain = async () => { await story.idle(); await story.runScenesNow(); await story.idle(); };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const live = (type, after) => eventsAfter(after, 500000).filter(e => e.type === type && !isExcludedId(S(), e.id));
const scene = (o) => ({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:flatmate'], minutes: 120, label: 'Catch-up', ...o });
await simulateHours(1);
await drain();

section('a cancel undone after its scene: one outing, one live scene');
{
  mindStore.putStance({ topic: 'kind:hangout', label: 'hangout', kind: 'interest', value: 0.5, status: 'active', source: 'seed' });
  mindStore.setStanceSetting('stance_cursor', life.stanceLastEventId());
  const start = at(1, 15);
  const before = lastEventId();
  const pv = await director.preview(scene({ startAt: start }));
  const res = await director.apply(pv.previewId, pv.fingerprint);
  const did = res.eventIds.map(getEvent).find(e => e?.type === 'decision.opened').id;
  const tone = await director.preview({ kind: 'scene.tone', decisionId: did, tone: 'they hit it off', outcome: 'well' }, { relax: true });
  await director.apply(tone.previewId, tone.fingerprint);
  await stepTo(start + 60 * 60);
  const pc = await director.preview({ kind: 'outcome', decisionId: did, outcome: 'cancelled' }, { relax: true });
  const rc = await director.apply(pc.previewId, pc.fingerprint);
  await story.idle();
  await stepTo(start + 80 * 60);
  await drain();
  const first = live('scene.played', before);
  eq('the early end got its scene', first.length, 1);
  const s1 = first[0].payload.activityEventId;
  eq('…one closeness step', live('relationship.changed', before).filter(e => e.payload?.reason === 'scene').length, 1);
  await stance.nightlyUpdate('2026-10-28');
  const action = rc.eventIds.map(getEvent).find(e => e?.type === 'director.action').id;
  const rp = life.revertChangePreview(action);
  await life.revertChange(action, { fingerprint: rp.fingerprint });
  await story.idle();
  calls.length = 0;
  await stepTo(start + 135 * 60);
  await drain();
  const after = live('scene.played', before);
  eq('one live scene afterwards', after.length, 1);
  const now = after[0];
  check('it is a new one, on the resumed start', now.id !== first[0].id && now.payload.activityEventId !== s1, now.payload);
  check('the old one left the log', isExcludedId(S(), first[0].id));
  eq('it names what it replaced', now.payload.regenOf, first[0].id);
  check('told whole, to the true end', now.payload.startAt <= start + 300 && now.payload.endedAt >= start + 115 * 60, now.payload);
  eq('the second model call only', calls.length, 1);
  check('its sheet does not remember itself', !calls[0].includes('trading stories'), calls[0].slice(0, 900));
  const old = sceneStore.versionsOf(s1)[0];
  const row = sceneStore.versionsOf(now.payload.activityEventId)[0];
  eq('rows: the old superseded, this one version + 1', [old.status, row.status, row.version], ['superseded', 'done', old.version + 1]);
  eq('the payload says so', now.payload.version, old.version + 1);
  eq('not on the owner\'s regenerate cap', sceneStore.countRegensSince(0), 0);
  eq('the folded scene is the new one', [S().story?.scenes?.[s1] ?? null, S().story?.scenes?.[now.payload.activityEventId]?.eventId], [null, now.id]);
  eq('effects count once', live('relationship.changed', before).filter(e => e.payload?.reason === 'scene').length, 1);
  await stance.nightlyUpdate('2026-10-29');
  const played = eventsAfter(before, 500000).filter(e => e.type === 'scene.played').map(e => e.id);
  const scenes = mindStore.allStanceEvidence().filter(e => e.source === 'scene' && e.eventIds.some(id => played.includes(id)));
  check('stance evidence is the new scene\'s only', scenes.length > 0 && scenes.every(e => e.eventIds[0] === now.id), scenes.map(e => e.eventIds[0]));
  eq('…once per topic and cause', new Set(scenes.map(e => `${e.stanceId}|${e.cause}`)).size, scenes.length);
  const rg = await story.sceneRegenerate(row.id, {});
  eq('the owner can still rewrite it', rg.status, 'done');
  eq('…still one live', live('scene.played', before).length, 1);
  eq('…and that one is on the cap', sceneStore.countRegensSince(0), 1);
  await stepTo(clock.now() + 12 * HOUR);
  await drain();
}

section('a crash in a resumed outing\'s call: replayed, like a first version');
{
  const id = sceneStore.insertPending({ activityEventId: 99000001, version: 2, endedAt: clock.now(), mode: 'full', createdAt: clock.now() });
  sceneStore.update(id, { status: 'running' }, { fromStatus: 'pending' });
  sceneStore.resetRunning({ tooOldBefore: 0, at: clock.now() });
  eq('back to pending', sceneStore.getScene(id).status, 'pending');
  await drain();
  eq('…and its start being gone ends it', sceneStore.getScene(id).status, 'skipped');
}

section('the next outing with the same person: not "on his own", wait at the place or not');
{
  const start = at(1, 17);
  const before = lastEventId();
  const pv = await director.preview({ kind: 'bundle', actions: [
    { ...scene({ startAt: start, minutes: 200, label: 'Long catch-up' }), source: 'hand' },
    { ...scene({ placeId: 'place:restaurant', startAt: start + 225 * 60, minutes: 70, label: 'Dinner after' }), source: 'hand' },
  ] }, { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  for (let i = 0; i < 500 && S().activity?.placeId !== 'place:cafe'; i++) await simulateHours(0.25, { stepMinutes: 5 });
  const end = S().activity.endAt;
  await stepTo(end - 400);
  clock.advance({ seconds: end + 6 - clock.now() });
  await story.__fireSceneKickForTest();
  await drain();
  check('there is a wait at the restaurant before dinner', (() => {
    const at = (S().plan?.blocks ?? []).filter(b => b.placeId === 'place:restaurant');
    return at.length >= 2 && !at[0].withCast?.length && at[1].withCast?.includes('cast:flatmate');
  })(), S().plan?.blocks);
  const played = live('scene.played', before)[0];
  const row = sceneStore.versionsOf(played.payload.activityEventId)[0];
  const text = renderUser(row.sheet);
  check('the sheet goes with them', /afterwards \(true\):\s*\n?\s*- \d\d:\d\d: he \w+ to the restaurant with Flatmate/.test(text), text);
  check('never "on his own" above "planned next with them"', !(text.includes('on his own') && text.includes('planned next with them')), text);
  await stepTo(end + 40 * 60);
  await drain();
  eq('the line still holds once he is there', sceneWorker.afterwardsCheck([played.id]), [{ eventId: played.id, stale: 0 }]);
  await stepTo(clock.now() + 12 * HOUR);
  await drain();
}

section('home is his; anyone else\'s is theirs');
{
  const t = clock.now();
  const sess = { endAt: t, castIds: ['cast:flatmate'], placeId: 'place:cafe' };
  const trip = (to) => ({ id: 9e6, type: 'travel.started', at: t, payload: { from: 'place:cafe', to, mode: 'scooter' } });
  const visit = (placeId) => ({ id: 9e6 + 1, type: 'activity.started', at: t + 3600, payload: { kind: 'visit', placeId, withCast: ['cast:flatmate'] } });
  const his = afterwardsLines([trip('place:home'), visit('place:home')], S(), sess, tz);
  check('to his own: home', his[0].includes('rode home on his own'), his);
  check('…and they come over', his[1].includes('came over to his place'), his);
  const theirs = afterwardsLines([trip('place:family-home'), visit('place:family-home')], S(), sess, tz);
  check('to someone else\'s: not "home"', theirs[0].includes('to their place') && !theirs[0].includes('home'), theirs);
  check('…and nobody came over to his', !theirs[1].includes('his place') && theirs[1].includes('their place'), theirs);
}

report();
