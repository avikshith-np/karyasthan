// 016 scene play-outs — owner controls and consequences, live (plan §P1.10, §P2.1–§P2.5):
// the Director's scene.tone (planner refusals, outcome {tone}, the prompt catalogue, the
// hint reaching the model), a scene that starts a romance (D6) and plans to meet again →
// the follow-up becomes an ordinary unlocked decision → the revert rules (D15: a scene or
// anything above it is never refused; its companions are undone only when not lived — a
// lived follow-up outing and a moved arc are kept, through REGENERATE and an ancestor
// revert; a reverted follow-up decision lapses its follow-up), purge of a real person's rows,
// the journal's "how it went", the cast page list, and determinism (two life dry runs
// identical; scenes never in a sim). Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, seedPeople, HOUR, DAY, PROJECT_ROOT,
} from './_helpers.js';
import { spawnSync } from 'child_process';
import path from 'path';
import { appendEvent, getEvent, eventsAfter, lastEventId, listEvents } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { bulletFor } from '../../src/life/story/journal.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';

await setupScratchDb();
await seedPeople(['Quinn Marlow']);   // a real person (the people table)
let answer = null;
const cr = fakeCallRole({
  'life.scene.clerk': (s, user, o, i) => (answer ? answer('life.scene.clerk', user, i) : null),
  'life.scene.mind': (s, user, o, i) => (answer ? answer('life.scene.mind', user, i) : null),
});
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();

async function applyAction(action) {
  const pv = await director.preview(action);
  return director.apply(pv.previewId, pv.fingerprint);
}
async function until(pred, maxHours = 30) {
  for (let i = 0; i < maxHours * 4; i++) { if (pred()) return true; await simulateHours(0.25); }
  return pred();
}
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
const at = (dayOffset, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * DAY; };
const startedFor = (decisionId, after) => {
  const sub = getEvent(decisionId)?.payload?.subject ?? {};
  return eventsAfter(after, 50000).find(e => e.type === 'activity.started' && getEvent(e.causeId)?.payload?.amendedFor === decisionId
    && e.payload?.placeId === sub.placeId && e.at >= sub.eventAt - 1800 && e.payload?.withCast?.length);
};
const endedFor = (aid, after) => eventsAfter(after, 50000).find(e => e.type === 'activity.ended' && e.causeId === aid);
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; } };

await simulateHours(3);
await drain();

section('Director scene.tone: planner, refusals, outcome {tone}, the prompt catalogue');
let decisionId;
{
  const r = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:coworker-a'], startAt: at(1, 19), minutes: 90 });
  decisionId = getEvent(r.eventIds[1]).id;
  const p = director.plan({ kind: 'scene.tone', decisionId, tone: 'they hit it off', outcome: 'well' }, S());
  eq('events: director.action + scene.tone_set (owner) carrying the outcome word', p.events.map(e => [e.type, e.actor, e.payload?.outcome ?? null]),
    [['director.action', 'owner', null], ['scene.tone_set', 'owner', 'well']]);
  eq('R23: a hint without its outcome word → refused', codeOf(() => director.plan({ kind: 'scene.tone', decisionId, tone: 'they hit it off' }, S())), 'invalid:outcome_required');
  eq('a JID in the hint → refused', codeOf(() => director.plan({ kind: 'scene.tone', decisionId, tone: 'call 15550001111@s.whatsapp.net', outcome: 'well' }, S())), 'invalid:jid_in_text');
  eq('a real name in the hint → refused', codeOf(() => director.plan({ kind: 'scene.tone', decisionId, tone: 'Quinn Marlow joins them', outcome: 'well' }, S())), 'invalid:real_person_name');
  check('an unknown decision → refused', codeOf(() => director.plan({ kind: 'scene.tone', decisionId: 999999, tone: 'nice', outcome: 'well' }, S())) !== null);
  const o = director.plan({ kind: 'outcome', decisionId, outcome: 'well', tone: 'awkward but sweet' }, S());
  eq('outcome {tone} adds a scene.tone_set to its batch, with that outcome', o.events.map(e => [e.type, e.payload?.outcome ?? null]),
    [['director.action', null], ['outcome.set', 'well'], ['scene.tone_set', 'well']]);
  {
    // A 015 owner outcome that disagrees with the hint's word → refused outcome_conflict.
    const r2 = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:park', castIds: ['cast:flatmate'], startAt: at(3, 18), minutes: 60 });
    const d2 = getEvent(r2.eventIds[1]).id;
    const r3 = await applyAction({ kind: 'outcome', decisionId: d2, outcome: 'badly' });
    eq('R23: a hint whose outcome disagrees with the owner outcome → refused', codeOf(() => director.plan({ kind: 'scene.tone', decisionId: d2, tone: 'a lovely evening', outcome: 'well' }, S())), 'refused:outcome_conflict');
    for (const actionId of [r3.eventIds[0], r2.eventIds[0]]) {
      const pv = life.revertChangePreview(actionId);
      life.revertChange(actionId, { fingerprint: pv.fingerprint, reason: 'test cleanup' });
    }
    check('…cleaned up (that outing is gone)', !S().decisions.get(d2) || S().decisions.get(d2).status !== 'open');
  }
  await applyAction({ kind: 'scene.tone', decisionId, tone: 'they hit it off', outcome: 'well' });
  eq('folded: story.sceneTones (hint + outcome)', [S().story.sceneTones?.[decisionId]?.tone, S().story.sceneTones?.[decisionId]?.outcome], ['they hit it off', 'well']);
  {
    // The Day page's ❖ TONE link: the planned outing's span carries its decision.
    const sub = getEvent(decisionId).payload.subject;
    const p = localParts(sub.eventAt, tz);
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    const dv = await life.dayView({ date });
    const span = (dv?.future?.spans ?? []).find(x => x.cat === 'activity' && x.with?.length && Math.abs(x.at - sub.eventAt) <= 3600);
    eq('Day: the planned outing span carries its decision (the ❖ TONE link)', span?.decisionId, decisionId);
    const { sceneChip } = await import('../../src/dashboard/public/js/pages/life-day.js').catch(() => ({}));
    if (typeof sceneChip === 'function') check('…and the page renders the link for it', String(sceneChip(span)?.strings ?? sceneChip(span)).includes('TONE'));
    check('spans without anyone carry no decisionId', (dv?.future?.spans ?? []).filter(x => !x.with?.length).every(x => !('decisionId' in x)));
  }
  const gv = story.godView().decisions?.find(d => d.id === decisionId);
  eq('godView: the decision shows its tone hint and that it takes one', [gv?.tone, gv?.toneable], ['they hit it off', true]);
  check('the prompt may draft it (never batchable: free text)', director.PROMPT_ACTION_KINDS.includes('scene.tone')
    && promptMod.batchableOf({ kind: 'scene.tone', decisionId, tone: 'x' }).reviewReason === 'free_text');
  // 020: a chat's plan may take a hint; a real person's never does (no invented story about them).
  const flag = appendEvent({ type: 'claim.flagged', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: '15550002222@s.whatsapp.net', payload: { claimId: 9, kind: 'plan' } });
  const chatDec = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', causeId: flag.id,
    payload: { ...getEvent(decisionId).payload, adopted: true, claimId: 9 } });
  story.__rebuildForTest();
  eq('a chat plan with no real person: allowed', codeOf(() => director.plan({ kind: 'scene.tone', decisionId: chatDec.id, tone: 'nice', outcome: 'well' }, S())), null);
  const realDec = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', causeId: flag.id, subjectJid: '15550002222@s.whatsapp.net',
    payload: { ...getEvent(decisionId).payload, adopted: true, claimId: 9 } });
  story.__rebuildForTest();
  eq('a real person\'s plan → refused real_person', codeOf(() => director.plan({ kind: 'scene.tone', decisionId: realDec.id, tone: 'nice', outcome: 'well' }, S())), 'refused:real_person');
  life.revertEvent(realDec.id, { reason: 'test cleanup' });
  life.revertEvent(chatDec.id, { reason: 'test cleanup' });
}

section('the tone reaches the model; a romance onset + a follow-up from a good first date');
let playedId;
let arcId;
let followupId;
{
  // Raise the member's passion (owner relationship change) so the onset gates can pass.
  appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'owner', payload: { castId: 'cast:coworker-a', delta: { passion: 0.2 }, reason: 'owner' } });
  appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'owner', payload: { castId: 'cast:coworker-a', delta: { passion: 0.1 }, reason: 'owner' } });
  story.__rebuildForTest();
  answer = () => JSON.stringify({
    narration: 'They met at the cafe just after seven and the conversation never stalled. They traded stories about awful bosses and good books, and laughed at the same moments. By the end they had swapped numbers and were already arguing about which film to see next.',
    impressions: null, topics: ['books', 'films'], highlight: 'arguing happily about films', awkward: null, chemistry: 0.85,
    focus: 'P1', ending: 'swapped_numbers', effects: [{ p: 'P1', metric: 'passion', dir: 'up', size: 'small' }, { p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }],
  });
  const before = lastEventId();
  await until(() => !!startedFor(decisionId, before) && !!endedFor(startedFor(decisionId, before).id, before), 40);
  await drain();
  const st = startedFor(decisionId, before);
  const row = sceneStore.versionsOf(st.id)[0];
  eq('scene done on the mind tier', [row?.status, row?.tier], ['done', 'mind']);
  check('the hint reached the model, fenced', cr.callsFor('life.scene.mind').some(c => c.user.includes('they hit it off') && c.user.includes('STORY_DATA')));
  eq('the hint set the outcome (by the owner) and is recorded on the row', [row.detail?.outcome, row.detail?.outcomeBy, row.tone, row.toneOutcome],
    ['well', 'owner', 'they hit it off', 'well']);
  eq('sceneDetail shows the hint it was written with', [story.sceneDetail(row.id)?.tone, story.sceneDetail(row.id)?.toneOutcome], ['they hit it off', 'well']);
  playedId = row.eventId;
  const kids = listEvents({ types: ['relationship.changed', 'arc.started', 'scene.followup'] })
    .filter(e => e.causeId === playedId || e.payload?.sceneEventId === playedId);
  eq('effects: relationship.changed, arc.started (romance onset), scene.followup', kids.map(e => e.type), ['relationship.changed', 'arc.started', 'scene.followup']);
  eq('D15: the deltas hang off the scene; the onset and the follow-up are uncaused companions naming it',
    kids.map(e => [e.type, e.causeId === playedId, e.causeId ?? null, e.payload?.sceneEventId ?? null]),
    [['relationship.changed', true, playedId, null], ['arc.started', false, null, playedId], ['scene.followup', false, null, playedId]]);
  arcId = kids.find(e => e.type === 'arc.started')?.id;
  followupId = kids.find(e => e.type === 'scene.followup')?.id;
  eq('the romance started (interested)', [S().story.romance?.arcId, S().story.arcs?.[arcId]?.stage], [arcId, 'interested']);
  eq('the follow-up is open', S().story.followups?.[followupId]?.status, 'open');
  check('the scene is still revertible', life.isRevertible(getEvent(playedId)));
  const detail = story.sceneDetail(row.id);
  eq('sceneDetail: live, effects listed, versions', [detail?.live, detail?.effects?.length, detail?.versions?.length], [true, 3, 1]);
  check('sceneDetail: who was there (name, first meeting), names on impressions, not a real person',
    detail?.with?.[0]?.castId === 'cast:coworker-a' && typeof detail.with[0].name === 'string' && detail.with[0].name !== 'cast:coworker-a'
    && detail.realPerson === false && (detail.impressions === null || [...detail.impressions.him, ...detail.impressions.them].every(x => typeof x.name === 'string')), detail?.with);
  const cast = story.castDetail('cast:coworker-a');
  eq('castDetail.scenes lists it', cast?.scenes?.[0]?.eventId, playedId);
  const b = bulletFor(getEvent(st.id), { state: S(), tz, sceneOf: (ev) => (ev.id === st.id ? 'arguing happily about films (swapped numbers)' : null) });
  check('journal bullet: how it went', b?.includes('how it went: arguing happily about films'), b);
  const chatEv = { ...getEvent(st.id), originKind: 'dm', originJid: '15550002222@s.whatsapp.net' };
  check('…never for a chat-origin activity', !bulletFor(chatEv, { state: S(), tz, sceneOf: () => 'x' })?.includes('how it went'));
}

section('the follow-up becomes an ordinary decision; revert rules');
{
  const ok = await until(() => S().story.followups?.[followupId]?.status !== 'open', 60);
  const f = S().story.followups?.[followupId];
  check('the follow-up was fitted (or decided)', ok && Number.isSafeInteger(f?.decisionId), f);
  const d = S().decisions.get(f.decisionId);
  const opened = getEvent(f.decisionId);
  eq('its decision: engine, caused by the follow-up, social, not locked', [opened?.actor, opened?.causeId, opened?.payload?.category, opened?.payload?.followupId],
    ['engine', followupId, 'social', followupId]);
  check('not pre-committed by the engine at open', !listEvents({ types: ['decision.committed'] }).some(e => e.payload.decisionId === f.decisionId && e.at === opened.at));
  void d;
  // He goes (the Ask-me pick path) and the follow-up outing is lived; the arc moves on (owner stage).
  const { ownerCommit } = await import('../../src/life/decisions.js');
  const fBefore = f.decisionId;
  await ownerCommit(S(), f.decisionId, 'go', { at: clock.now() });
  story.__rebuildForTest();
  await applyAction({ kind: 'scene', shape: 'arc.stage', arcId, to: 'talking' });
  const lived = await until(() => { const a = startedFor(f.decisionId, fBefore); return !!a && !!endedFor(a.id, fBefore); }, 120);
  check('the follow-up outing was lived', lived);
  eq('the follow-up past its point of no return → its direct revert is refused', life.isRevertible(getEvent(followupId)), false);
  eq('D15: the scene itself stays revertible (never refused)', [life.isRevertible(getEvent(playedId)), life.sceneRevertProblem(getEvent(playedId))], [true, null]);
}

section('D15: REGENERATE and an ancestor revert keep the lived follow-up outing and the moved arc');
{
  const { isExcludedId } = await import('../../src/life/projector.js');
  const f = S().story.followups[followupId];
  const fStart = startedFor(f.decisionId, f.decisionId);
  const fEnd = fStart && endedFor(fStart.id, f.decisionId);
  const liveIds = () => [followupId, f.decisionId, fStart?.id, fEnd?.id, arcId].map(id => !isExcludedId(S(), id));
  check('the lived outing found', !!fStart && !!fEnd);
  await drain();
  answer = () => JSON.stringify({
    narration: 'They met at the cafe and talked about work, then books, then nothing in particular. It was pleasant and easy, and the evening ended a little earlier than either of them expected, with a promise to swap book lists.',
    impressions: null, topics: ['books'], highlight: 'swapping book lists', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
  });
  const v1 = sceneStore.getByEvent(playedId);
  const r = await story.sceneRegenerate(v1.id);
  await story.idle();
  eq('regenerate → done', r.status, 'done');
  eq('…the follow-up, its decision, the lived outing and the moved arc all stay', liveIds(), [true, true, true, true, true]);
  const det = story.sceneDetail(v1.id);
  check('sceneDetail (v1): the companions are listed as kept', ['scene.followup', 'arc.started'].every(t => det?.effects?.some(e => e.type === t && e.kept === true)), det?.effects);
  const firstStart = getEvent(playedId).causeId;
  check('the first outing\'s activity.started is revertible (an ancestor)', life.isRevertible(getEvent(firstStart)));
  life.revertEvent(firstStart, { reason: 'ancestor revert' });
  await drain();
  check('the first outing and its scenes are out', isExcludedId(S(), firstStart) && isExcludedId(S(), playedId) && isExcludedId(S(), sceneStore.getScene(r.sceneId).eventId));
  eq('…the lived follow-up and the moved arc are kept', liveIds(), [true, true, true, true, true]);
  check('…the follow-up decision is still in his day', S().decisions.has(f.decisionId));
}

section('a fresh scene with a follow-up: revert takes the follow-up and its decision with it');
{
  answer = () => JSON.stringify({
    narration: 'They walked the long way round the park and talked about nothing in particular, which was exactly what both of them needed after the week they had had. They agreed to do it again soon.',
    impressions: null, topics: ['the week'], highlight: 'the long way round', awkward: null, chemistry: 0.7, focus: 'P1', ending: 'plan_to_meet', effects: [],
  });
  const r = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:park', castIds: ['cast:flatmate'], startAt: at(1, 18, 30), minutes: 60 });
  const did = getEvent(r.eventIds[1]).id;
  const before = lastEventId();
  await until(() => !!startedFor(did, before) && !!endedFor(startedFor(did, before).id, before), 40);
  await drain();
  const row = sceneStore.versionsOf(startedFor(did, before).id)[0];
  const fu = listEvents({ types: ['scene.followup'] }).find(e => e.payload?.sceneEventId === row.eventId);
  check('a follow-up planned', !!fu);
  life.revertEvent(row.eventId, { reason: 'test' });
  await drain();
  eq('reverted: the unlived follow-up is undone with it (scene_gone)', [S().story.followups?.[fu.id],
    listEvents({ types: ['event.reverted'] }).find(e => e.payload.targetId === fu.id)?.payload?.reason], [undefined, 'scene_gone']);
  eq('the row → reverted', sceneStore.getScene(row.id).status, 'reverted');
}

section('R26: reverting a follow-up\'s decision lapses it — the pulse never refits it');
{
  answer = () => JSON.stringify({
    narration: 'They sat on the low wall outside the park and talked about the week and the weekend ahead. It was easy company, and before they split they agreed to do it again some evening soon.',
    impressions: null, topics: ['the weekend'], highlight: 'the low wall by the park', awkward: null, chemistry: 0.7, focus: 'P1', ending: 'plan_to_meet', effects: [],
  });
  const r = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:park', castIds: ['cast:coworker-b'], startAt: at(1, 18, 0), minutes: 60 });
  const did = getEvent(r.eventIds[1]).id;
  const before = lastEventId();
  await until(() => !!startedFor(did, before) && !!endedFor(startedFor(did, before).id, before), 40);
  await drain();
  const row = sceneStore.versionsOf(startedFor(did, before).id)[0];
  const fu = listEvents({ types: ['scene.followup'] }).find(e => e.payload?.sceneEventId === row.eventId);
  check('a follow-up planned', !!fu);
  const fitted = await until(() => Number.isSafeInteger(S().story.followups?.[fu?.id]?.decisionId), 60);
  check('…and fitted as a decision', fitted);
  const dec = S().story.followups[fu.id].decisionId;
  life.revertEvent(dec, { reason: 'not this one' });
  const lapsed = listEvents({ types: ['scene.followup_lapsed'] }).filter(e => e.payload.followupId === fu.id);
  eq('the follow-up lapsed (reverted) at once', [lapsed.map(e => e.payload.reason), S().story.followups?.[fu.id]?.status], [['reverted'], 'lapsed']);
  await simulateHours(26);
  await drain();
  const refits = listEvents({ types: ['decision.opened'] }).filter(e => e.payload?.followupId === fu.id && e.id !== dec);
  eq('never refitted', refits.length, 0);
}

section('a rewind over a scene takes it and its effects out; never re-played');
{
  answer = () => JSON.stringify({
    narration: 'They sat by the window and talked through most of the evening about films, food and nothing much. It was easy and warm, and he walked home in a good mood.',
    impressions: null, topics: ['films'], highlight: 'talking through the evening', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing',
    effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'medium' }],
  });
  await drain();
  const r = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:flatmate'], startAt: at(1, 18, 0), minutes: 60 });
  const did = getEvent(r.eventIds[1]).id;
  const before = lastEventId();
  await until(() => !!startedFor(did, before), 40);
  const st = startedFor(did, before);
  const close0 = S().cast.get('cast:flatmate').metrics.closeness;
  await until(() => !!endedFor(st.id, before), 10);
  await drain();
  const row = sceneStore.versionsOf(st.id)[0];
  check('the scene moved closeness', row?.status === 'done' && S().cast.get('cast:flatmate').metrics.closeness > close0 + 0.03);
  const pv = await director.preview({ kind: 'rewind', toEventId: st.id - 1, reason: 'try that evening again' });
  await director.apply(pv.previewId, pv.fingerprint);
  await drain();
  eq('the scene is out of the projection', S().story.scenes?.[st.id], undefined);
  check('its closeness effect is undone', Math.abs(S().cast.get('cast:flatmate').metrics.closeness - close0) < 0.011, [S().cast.get('cast:flatmate').metrics.closeness, close0]);
  eq('the row → reverted, text gone', [sceneStore.getScene(row.id).status, sceneStore.getScene(row.id).text], ['reverted', null]);
  eq('never played again (one row for that outing)', sceneStore.versionsOf(st.id).length, 1);
}

section('purge: a real person\'s scene rows go with them');
{
  const PERSON = '15550004444@s.whatsapp.net';
  const id = sceneStore.insertPending({ activityEventId: 999999, version: 1, endedAt: clock.now(), originKind: 'group', originJid: '120363000000000099@g.us', subjectJid: PERSON });
  check('a row about them exists', !!sceneStore.getScene(id));
  story.onRedacted([PERSON]);
  eq('purged', sceneStore.getScene(id), null);
}

section('determinism: scenes never in a sim; two life dry runs identical');
{
  const sim = await story.simulate({ now: clock.now(), hours: 36 });
  check('no scene event in tomorrow.simulate', !(sim?.events ?? []).some(e => String(e.type).startsWith('scene.played')));
  const run = () => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'life-dryrun.js'), '--days', '2'], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, DB_PATH: undefined }, timeout: 120_000,
  }).stdout.split('\n').filter(l => !l.startsWith('[')).join('\n');
  const a = run();
  const b = run();
  check('the dry run produced a day log', a.includes('Life dry run'), a.slice(0, 200));
  check('two dry runs are byte-identical', a === b);
}

report();
await stopLife();
