// Plan 020 C4: the scene is written the moment the outing ends, with the session's record on its sheet and its outcome.
// One call per scene; the explicit register keeps its own path; minimal mode gives no record. Kick races with the tick,
// a restart between the end and the scene, the max-age skip, a regenerate, a resumed outing; sims stay scene-free.
// Example world, fake clock, stubbed models, no network.
import fs from 'fs';
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { eventsAfter, getEvent, lastEventId } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as sceneWorker from '../../src/life/story/scenes/worker.js';
import { afterwardsLines, recordFor, traceSheet } from '../../src/life/story/scenes/facts.js';
import { renderUser, SCENE_CHARTER } from '../../src/life/story/scenes/charter.js';
import { isExcludedId } from '../../src/life/projector.js';
import { zonedToUnix, localParts, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const calls = [];
const sceneJson = () => JSON.stringify({
  narration: 'They met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. He laughed more than he had all week, and by the end they were trading stories.',
  impressions: null, topics: ['old flatmates'], highlight: 'trading stories', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
});
const record = (caller) => (sys, user) => { calls.push({ caller, sys, user }); return sceneJson(); };
const cr = fakeCallRole({ 'life.scene.clerk': record('clerk'), 'life.scene.mind': record('mind') });
const deps = { getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] };
let { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest(deps);
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const evening = (off, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + off * DAY; };
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
async function outing(startAt, minutes = 90, castIds = ['cast:flatmate']) {
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds, startAt, minutes, label: 'Catch-up' });
  const res = await director.apply(pv.previewId, pv.fingerprint);
  return getEvent(res.eventIds[1]).id;
}
const startedFor = (did, after) => {
  const sub = getEvent(did)?.payload?.subject ?? {};
  return eventsAfter(after, 50000).find(e => e.type === 'activity.started' && e.payload?.placeId === sub.placeId && e.at >= sub.eventAt - 1800 && e.payload?.withCast?.length);
};
const playedFor = (aid) => eventsAfter(0, 500000).filter(e => e.type === 'scene.played' && e.payload?.activityEventId === aid);
async function until(pred, hours = 40) {
  for (let i = 0; i < hours * 4; i++) { if (pred()) return true; await simulateHours(0.25); }
  return pred();
}

await simulateHours(1);
await drain();

section('the charter and the render');
{
  check('the charter says how to use it', SCENE_CHARTER.includes('"how it went"') && SCENE_CHARTER.includes('never as a list'));
  check('finding 18: the owner first, then its shape, and no invented events', SCENE_CHARTER.indexOf("The owner's intent") < SCENE_CHARTER.indexOf('"how it went"') && SCENE_CHARTER.includes("Don't invent events") && !SCENE_CHARTER.includes('Nothing else that happened'));
  const sheet = { mode: 'full', him: { name: 'x' }, activity: 'cafe', place: { words: 'the cafe' }, time: { minutes: 60 }, people: [], outcome: 'fine' };
  check('nothing about it without a record', !renderUser(sheet).includes('how it went'));
  eq('minimal mode has no record', traceSheet({ mode: 'minimal', reason: 'real_person' }, tz), null);
  eq('nor does nothing', traceSheet(null, tz), null);
  const t0 = zonedToUnix(2026, 10, 28, 19, 0, tz);
  const full = { mode: 'full', outcome: 'well', phases: [{ phase: 'main', words: 'in full swing', from: t0, to: t0 + 3600 }], topics: [], interruptions: [
    { at: t0 + 600, kind: 'text', who: 'Mira', answered: false }, { at: t0 + 900, kind: 'chats', sent: 0, received: 7 }, { at: t0 + 1000, kind: 'chats_sent', sent: 2, received: 1 },
  ], mood: [{ at: t0, them: 'ok', his: 'ok' }, { at: t0 + 1200, them: 'high', his: 'ok' }, { at: t0 + 1500, them: 'ok', his: 'ok' }, { at: t0 + 1800, them: 'high', his: 'ok' }], attention: { low: 0.7 } };
  eq('the explicit register keeps its own sheet', recordFor(full, { register: 'explicit', outcome: 'well', tz }), null);
  eq('a record that no longer agrees is dropped', recordFor(full, { register: 'tame', outcome: 'badly', tz }), null);
  const told = recordFor(full, { register: 'suggestive', outcome: 'well', tz });
  check('the others get it', told?.lines?.length > 0);
  eq('someone fictional by name, on the writer\'s allow-list', told.names, ['Mira']);
  check('a text: who, and whether he answered', told.lines.some(l => l.includes('a text from Mira; he left it')));
  check('a real chat: no name, no count, no word', told.lines.some(l => l.includes('his phone buzzed')) && told.lines.some(l => l.includes('answering messages')) && !told.lines.join(' ').includes('7'));
  eq('a mood that did not last is not a mood', told.lines.filter(l => l.includes('they seemed')).length, 2);
  check('the sheet is capped', recordFor({ ...full, topics: Array.from({ length: 40 }, (_, i) => ({ words: `t${i}`, from: t0 + i * 60 })) }, { register: 'tame', outcome: 'well', tz }).lines.length <= 24);
  const src = fs.readFileSync(new URL('../../src/life/story/scenes/worker.js', import.meta.url), 'utf8');
  check('the worker goes through that one check', src.includes('recordFor(fullTrace, { register, outcome: built.outcome, tz: ctx.tz'));

  // Finding 15: his half doesn't contradict the fixed outcome.
  const moods = { ...full, phases: [], interruptions: [], mood: [{ at: t0, them: 'low', his: 'high' }] };
  const moodLines = (outcome) => recordFor({ ...moods, outcome }, { register: 'tame', outcome, tz }).lines.join(' ');
  check('badly: not "enjoying himself"', !/enjoying himself/.test(moodLines('badly')) && /seemed off/.test(moodLines('badly')), moodLines('badly'));
  check('flat: nor that', !/enjoying himself/.test(moodLines('flat')));
  check('fine: it stands', /enjoying himself/.test(moodLines('fine')));
  const low = { ...moods, mood: [{ at: t0, them: 'high', his: 'low' }] };
  check('well: not "he was low"', !/he was low/.test(recordFor({ ...low, outcome: 'well' }, { register: 'tame', outcome: 'well', tz }).lines.join(' ')));

  // Finding 18: the shape, not a transcript.
  const thin = recordFor({ ...full, phases: [{ phase: 'arriving', words: 'arriving', from: t0 }, { phase: 'settling', words: 'settling in', from: t0 + 60 }, { phase: 'main', words: 'in full swing', from: t0 + 120 }, { phase: 'winding', words: 'winding down', from: t0 + 500 }, { phase: 'leaving', words: 'leaving', from: t0 + 3000 }],
    topics: [{ code: 'nothing', words: 'whatever comes to mind', from: t0 + 200 }, { code: 'job', words: 'her work', from: t0 + 300 }], interruptions: [], mood: [] }, { register: 'tame', outcome: 'well', tz }).lines.join(' | ');
  check('no bare phases, no filler', !/settling in|in full swing|whatever comes to mind/.test(thin) && /arriving/.test(thin) && /her work/.test(thin) && /leaving/.test(thin), thin);
  const owned = recordFor({ ...full, topics: [{ code: 'job', words: 'her work', from: t0 + 300 }] }, { register: 'tame', outcome: 'well', tz, ownerIntent: true }).lines.join(' | ');
  check('with an owner intent, no small talk over it', !/her work/.test(owned), owned);

  // Finding 26: a busy outing keeps its ending.
  const busy = recordFor({ ...full, phases: [{ phase: 'arriving', words: 'arriving', from: t0 }, { phase: 'winding', words: 'winding down', from: t0 + 9000 }, { phase: 'leaving', words: 'leaving', from: t0 + 9500 }],
    topics: Array.from({ length: 12 }, (_, i) => ({ code: 'week', words: `topic ${i}`, from: t0 + 100 + i * 200 })),
    interruptions: Array.from({ length: 8 }, (_, i) => ({ at: t0 + 150 + i * 300, kind: 'text', who: 'Mira', answered: false })),
    mood: Array.from({ length: 16 }, (_, i) => ({ at: t0 + 90 + i * 700, them: i % 2 ? 'high' : 'low', his: 'ok' })) }, { register: 'tame', outcome: 'well', tz });
  check('over the cap: within it', busy.lines.length <= 24, busy.lines.length);
  check('…the ending stays', /winding down/.test(busy.lines.join(' ')) && /leaving/.test(busy.lines.join(' ')), busy.lines.slice(-3));
  eq('…and every interruption', busy.lines.filter(l => l.includes('a text from')).length, 8);
  const longSheet = { mode: 'full', him: { name: 'x' }, activity: 'cafe', place: { words: 'the cafe' }, time: { minutes: 60 }, people: [], outcome: 'fine', trace: { lines: Array.from({ length: 20 }, (_, i) => `row ${i}`) } };
  const cut = renderUser(longSheet, { drop: 2 });
  check('a sheet cut for length keeps the last rows', cut.includes('row 19') && cut.includes('row 0') && !cut.includes('row 10'), cut.slice(0, 200));

  // Finding 21: where he went, not "home" every time.
  const places = new Map([['place:home', { kind: 'home' }], ['place:cafe', { kind: 'cafe' }], ['place:rest', { kind: 'restaurant' }]]);
  const st = { places, self: { homePlaceId: 'place:home' }, cast: new Map([['cast:a', { name: 'Robin' }]]), plan: { blocks: [] } };
  const sess = { endAt: t0, placeId: 'place:cafe', castIds: ['cast:a'] };
  const trip = (to, extra = []) => [{ id: 1, type: 'travel.started', at: t0, payload: { from: 'place:cafe', to, mode: 'scooter' } }, ...extra];
  check('to a restaurant reads so', /to the restaurant/.test(afterwardsLines(trip('place:rest'), st, sess, tz)[0]), afterwardsLines(trip('place:rest'), st, sess, tz));
  check('home reads home', / home on his own/.test(afterwardsLines(trip('place:home'), st, sess, tz)[0]));

  // Finding 14: still on the way, with the next block on the plan: not "on his own".
  const planned = { ...st, plan: { blocks: [{ placeId: 'place:rest', start: t0 + 900, withCast: ['cast:a'] }] } };
  const line14 = afterwardsLines(trip('place:rest'), planned, sess, tz)[0];
  check('who he is with comes from the plan in force', /with Robin/.test(line14) && !/on his own/.test(line14), line14);
  const noOne = { ...st, plan: { blocks: [{ placeId: 'place:rest', start: t0 + 900, withCast: [] }] } };
  check('a plan without them: on his own, truly', /on his own/.test(afterwardsLines(trip('place:rest'), noOne, sess, tz)[0]));
  const later = afterwardsLines([...trip('place:rest'), { id: 2, type: 'travel.arrived', at: t0 + 900, payload: { to: 'place:rest' } }, { id: 3, type: 'activity.started', at: t0 + 900, payload: { kind: 'eat-out', placeId: 'place:rest', withCast: ['cast:a'] } }], planned, sess, tz)[0];
  check('the same line, once he is there, starts with it (the sweep\'s check)', later.startsWith(line14), [later, line14]);
}

section('the moment it ends: a kick, not the next tick');
let firstAid;
{
  const before = lastEventId();
  const did = await outing(evening(1, 19, 0), 80);   // ends between ticks: one ending on a tick is folded by it
  const armed = await until(() => !!story.__sceneKickForTest());
  check('the kick is armed in the last tick before the end', armed);
  const k = story.__sceneKickForTest();
  firstAid = startedFor(did, before)?.id;
  eq('for this outing', k.eventId, firstAid);
  check('…and only with the end inside the coming tick', k.end - clock.now() < 15 * 60 && k.end >= clock.now());
  eq('finding 8: its delay runs from now, to just after the end', k.delaySec, k.end + 5 - clock.now());
  const trace = life.liveSessionTrace(firstAid);
  check('a full record while it runs', trace?.mode === 'full', trace);
  await drain();
  const at = k.end + 6;
  clock.advance({ seconds: at - clock.now() });
  calls.length = 0;
  await story.__fireSceneKickForTest();
  await story.idle();
  const ended = eventsAfter(firstAid, 50000).find(e => e.type === 'activity.ended' && e.causeId === firstAid);
  check('the end is folded at once, not at the next grid tick', !!ended, ended?.at);
  const played = playedFor(firstAid);
  eq('one scene', played.length, 1);
  check('written within seconds of the end', played[0]?.at - k.end < 60, played[0]?.at - k.end);
  eq('one model call', calls.length, 1);

  const done = life.liveSessionTrace(firstAid);
  eq('the scene has the outcome the live line showed, no second roll', played[0].payload.outcome, done.outcome);
  const row = sceneStore.getByEvent(played[0].id);
  check('the record is on the sheet', row.sheet?.trace?.lines?.length > 0 || JSON.parse(row.sheetJson ?? '{}')?.trace?.lines?.length > 0, Object.keys(row));
  check('the writer got it', calls[0].user.includes('how it went (true)'));
  fs.writeFileSync(process.env.TRACE_DUMP ?? '/dev/null', calls[0].user);
}

section('a kick that loses the race, or a tick that follows it, writes nothing more');
{
  calls.length = 0;
  await simulateHours(0.5);
  await drain();
  await story.idle();
  eq('still one scene', playedFor(firstAid).length, 1);
  eq('no second call', calls.length, 0);
}

section('a resumed outing is told from where it began, and a short tail still gets its scene');
{
  const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
  const start = evening(1, 15, 0);
  const did = await outing(start, 150);
  await stepTo(start + 60 * 60);
  const pc = await director.preview({ kind: 'outcome', decisionId: did, outcome: 'cancelled' }, { relax: true });
  await director.apply(pc.previewId, pc.fingerprint);
  await stepTo(start + 140 * 60);
  const pr = await director.preview({ kind: 'rewind', at: start + 10 * 60, reason: 'undo the walkout' });
  await director.apply(pr.previewId, pr.fingerprint, { by: 'tester' });
  calls.length = 0;
  await stepTo(start + 175 * 60);
  await drain();
  const played = eventsAfter(0, 500000).filter(e => e.type === 'scene.played' && e.payload?.startAt >= start - 3600 && e.at >= start);
  const live = played.filter(e => !isExcludedId(S(), e.id));
  check('one scene for the whole outing', live.length === 1, live.map(e => [e.id, e.payload?.startAt - start, e.payload?.endedAt - start]));
  const row = live[0] ? sceneStore.getByEvent(live[0].id) : null;
  const aid = live[0]?.payload?.activityEventId;
  check('its last part was too short to count on its own', aid && getEvent(aid).at > start + 100 * 60, aid && (getEvent(aid).at - start) / 60);
  check('told from where it began', (live[0]?.payload?.startAt ?? 0) <= start + 5 * 60, live[0] && (live[0].payload.startAt - start) / 60);
  check('…for all of it', (row?.sheet?.time?.minutes ?? 0) >= 140, row?.sheet?.time);
  check('with the record of the whole session', calls.at(-1)?.user?.includes('how it went (true)'));
}

section('finding 8: off the grid, as a real boot is: the kick still fires just after the end');
{
  const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h); };
  // A tick at 443 s past the grid point: its info.at is the floored point, the clock isn't.
  const start = evening(1, 15, 0);
  const before = lastEventId();
  const did = await outing(start, 80);
  await stepTo(start + 40 * 60);
  clock.advance({ seconds: 443 });
  await life.tick();
  void did;
  const aid = startedFor(did, before)?.id;
  const end = S().activity?.endAt;
  check('he is on it', S().activity?.eventId === aid && Number.isFinite(end), S().activity);
  while (clock.now() < end - 15 * 60) { clock.advance({ minutes: 15 }); await life.tick(); }
  const k = story.__sceneKickForTest();
  check('armed', k?.eventId === aid, k);
  eq('its delay runs from the real clock', k.delaySec, Math.max(1, k.end + 5 - clock.now()));
  clock.advance({ seconds: k.delaySec });
  await story.idle();
  await story.__fireSceneKickForTest();
  await story.idle();
  check('and it folds the end', eventsAfter(aid, 5000).some(e => e.type === 'activity.ended' && e.causeId === aid));
  eq('…and writes the scene', playedFor(aid).length, 1);
  check('…within seconds of the end', playedFor(aid)[0].at - end < 60, playedFor(aid)[0].at - end);

  // The end falls between the grid point and the tick: past already when it arms, and still unfolded.
  await stepTo(clock.now() + 2 * HOUR);
  await drain();
  const start2 = evening(1, 15, 0);
  const before2 = lastEventId();
  const did2 = await outing(start2, 80);
  await stepTo(start2 + 40 * 60);
  const aid2 = startedFor(did2, before2)?.id;
  const end2 = S().activity?.endAt;
  const grid = 15 * 60;
  const gridPoint = Math.floor(end2 / grid) * grid;
  await stepTo(gridPoint - 2 * grid);   // no earlier tick has this end inside its coming interval
  check('not armed yet', !story.__sceneKickForTest());
  clock.advance({ seconds: end2 + 60 - clock.now() });
  await life.tick();
  await story.idle();
  const stillOn = S().activity?.eventId === aid2;
  const k2 = story.__sceneKickForTest();
  if (stillOn) {
    check('the end has passed since the grid point: armed at once', k2?.eventId === aid2 && k2.delaySec === 1, k2);
    await story.__fireSceneKickForTest();
    await story.idle();
    check('and folded', eventsAfter(aid2, 5000).some(e => e.type === 'activity.ended' && e.causeId === aid2));
  } else {
    check('the tick folded it itself', eventsAfter(aid2, 5000).some(e => e.type === 'activity.ended' && e.causeId === aid2));
  }
  await stepTo(clock.now() + 2 * HOUR);
  await drain();
}

section('finding 7: a re-plan mid-outing: one scene, at the true end');
{
  const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
  for (const editAt of [40, 105]) {   // the second leaves a tail under 20 min
    const start = evening(1, 15, 0);
    const before = lastEventId();
    const did = await outing(start, 120);
    await stepTo(start + editAt * 60);
    const p0 = localParts(start + 300 * 60, tz);
    const pv = await director.preview({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: `${String(p0.hour).padStart(2, '0')}:${String(p0.minute).padStart(2, '0')}`, to: `${String(p0.hour + 1).padStart(2, '0')}:00` }] }, { relax: true });
    check(`the edit at +${editAt} previews`, pv.previewId && !pv.refusals?.length, pv.refusals);
    await director.apply(pv.previewId, pv.fingerprint);
    await story.idle();
    calls.length = 0;
    await stepTo(start + 130 * 60);
    await drain();
    void did;
    const played = eventsAfter(before, 50000).filter(e => e.type === 'scene.played' && !isExcludedId(S(), e.id) && e.payload?.startAt >= start - 3600);
    const starts = eventsAfter(before, 50000).filter(e => e.type === 'activity.started' && e.at >= start - 1800 && e.at < start + 120 * 60 && e.payload?.placeId === 'place:cafe');
    check(`+${editAt}: the edit did split the block`, starts.length >= 2, starts.length);
    eq(`+${editAt}: one scene`, played.length, 1);
    eq(`+${editAt}: one model call`, calls.length, 1);
    check(`+${editAt}: told whole, written after the true end`, played[0]?.payload?.startAt <= start + 300 && played[0]?.payload?.endedAt >= start + 115 * 60 && played[0]?.at >= start + 115 * 60, played[0]?.payload);
    await stepTo(clock.now() + 12 * HOUR);
    await drain();
  }
}

section('finding 7, the verifier\'s caveat: a resume that comes after the row was queued drops it');
{
  const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
  const start = evening(1, 15, 0);
  const before = lastEventId();
  const did = await outing(start, 60);
  // The scan sees no resume, the run does: it went on after the row was queued.
  let reads = 0;
  sceneWorker.configure({ liveResumed: () => { reads += 1; return reads > 1; } });
  calls.length = 0;
  await stepTo(start + 75 * 60);
  await drain();
  const aid = startedFor(did, before)?.id;
  const row = sceneStore.versionsOf(aid)[0];
  eq('skipped as resumed', [row?.status, row?.skipReason], ['skipped', 'resumed']);
  eq('no scene', playedFor(aid).length, 0);
  eq('no model call', calls.length, 0);
  sceneWorker.configure({ liveResumed: (id) => life.liveResumedLater(id) });
}

section('finding 14, its side note: a scene\'s own outing is not what is planned next');
{
  const { planLines } = await import('../../src/life/story/phone/facts.js');
  const t = clock.now();
  const own = { id: 7, status: 'committed', committed: { optionId: 'go' }, subject: { eventAt: t - 3600, castIds: ['cast:flatmate'], placeId: 'place:cafe' }, options: [{ id: 'go', label: 'Catch-up' }], kind: 'hangout' };
  const next = { id: 8, status: 'committed', committed: { optionId: 'go' }, subject: { eventAt: t + 3600, castIds: ['cast:flatmate'], placeId: 'place:restaurant' }, options: [{ id: 'go', label: 'Dinner after' }], kind: 'eat-out' };
  const st = { ...S(), decisions: new Map([[7, own], [8, next]]) };
  const lines = planLines(st, { at: t, tz, castId: 'cast:flatmate', endOf: () => t + 300, skipDecisionId: 7 }).join(' | ');
  check('the next one stays', lines.includes('Dinner after'), lines);
  check('its own is gone', !lines.includes('Catch-up'), lines);
  check('without the skip, as a thread sees it, it shows', planLines(st, { at: t, tz, castId: 'cast:flatmate', endOf: () => t + 300 }).join(' ').includes('Catch-up'));
}

section('a stale kick folds nothing');
{
  const last = lastEventId();
  const n = await story.__fireSceneKickForTest();
  await story.idle();
  check('none armed: nothing happens', n === false || lastEventId() >= last);
  eq('still one scene', playedFor(firstAid).length, 1);
}

section('no record: the scene is still fine, with its own roll');
{
  const before = lastEventId();
  const did = await outing(evening(1, 19, 0), 60);
  sceneWorker.configure({ liveTrace: () => null });
  calls.length = 0;
  await until(() => { const st = startedFor(did, before); return !!st && eventsAfter(st.id, 5000).some(e => e.type === 'activity.ended' && e.causeId === st.id); });
  await drain();
  const st = startedFor(did, before);
  eq('one scene', playedFor(st.id).length, 1);
  check('no record reached any writer', calls.length >= 1 && calls.every(c => !c.user.includes('how it went')), calls.length);
  sceneWorker.configure({ liveTrace: () => ({ mode: 'minimal', reason: 'chat' }) });
  const before2 = lastEventId();
  const did2 = await outing(evening(1, 19, 0), 60);
  calls.length = 0;
  await until(() => { const s2 = startedFor(did2, before2); return !!s2 && eventsAfter(s2.id, 5000).some(e => e.type === 'activity.ended' && e.causeId === s2.id); });
  await drain();
  check('minimal mode: none either', calls.length >= 1 && calls.every(c => !c.user.includes('how it went')), calls.length);
  sceneWorker.configure({ liveTrace: (id) => life.liveSessionTrace(id) });
}

section('a regenerate');
{
  const v1 = sceneStore.getByEvent(playedFor(firstAid)[0].id);
  calls.length = 0;
  const r = await story.sceneRegenerate(v1.id);
  await story.idle();
  eq('done', r.status, 'done');
  check('the same outcome: the record again', calls.at(-1).user.includes('how it went (true)'));
  const v2 = sceneStore.getByEvent(playedFor(firstAid).at(-1).id);
  calls.length = 0;
  const other = v2.outcome === 'badly' ? 'well' : 'badly';
  const r2 = await story.sceneRegenerate(v2.id, { tone: 'quieter', outcome: other });
  await story.idle();
  eq('done', r2.status, 'done');
  check('the owner changed how it went: the old record no longer holds', !calls.at(-1).user.includes('how it went (true)'), calls.at(-1).user.slice(0, 200));
}

section('a restart between the end and the scene');
{
  const before = lastEventId();
  const did = await outing(evening(1, 19, 0), 60);
  await until(() => !!startedFor(did, before));
  const aid = startedFor(did, before).id;
  const was = life.liveSessionTrace(aid)?.outcome;
  await story.idle();
  await stopLife();
  clock.advance({ hours: 3 });
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  calls.length = 0;
  await simulateHours(0.25);
  await drain();
  const played = playedFor(aid);
  eq('the scene is written once after it', played.length, 1);
  eq('with the outcome it had before the restart', played[0]?.payload?.outcome, was);
  check('and the record', calls.some(c => c.user.includes('how it went (true)')));
}

section('past the max age: nothing, and the record is not even read');
{
  const before = lastEventId();
  const did = await outing(evening(1, 19, 0), 60);
  await until(() => !!startedFor(did, before));
  await story.idle();
  await stopLife();
  config.arcs.sceneMaxAgeHours = 1;
  clock.advance({ hours: 5 });
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  let reads = 0;
  sceneWorker.configure({ liveTrace: (id) => { reads += 1; return life.liveSessionTrace(id); } });
  calls.length = 0;
  await drain();
  const aid = startedFor(did, before)?.id;
  const row = sceneStore.versionsOf(aid)[0];
  eq('skipped', [row?.status, row?.skipReason], ['skipped', 'too_old']);
  eq('no model call', calls.length, 0);
  eq('no record read', reads, 0);
  config.arcs.sceneMaxAgeHours = 36;
  sceneWorker.configure({ liveTrace: (id) => life.liveSessionTrace(id) });
}

section('sims stay scene-free');
{
  const rows = sceneStore.listByStatus('pending').length;
  const armedBefore = story.__sceneKickForTest();
  const last = lastEventId();
  await story.simulate({ now: clock.now(), hours: 30 });
  eq('no rows', sceneStore.listByStatus('pending').length, rows);
  eq('no events', lastEventId(), last);
  eq('no kick armed by it', story.__sceneKickForTest(), armedBefore);
}

void HOUR;
await stopLife();
report();
