// 016 scene play-outs — the live path (plan §P1.1, §P1.5, §P1.7, §P1.10, §P2.1, §P2.4):
// a Director outing with a cast member ends → the afterTick detector queues a pending
// row → the worker plays it out (stubbed models) and appends scene.played (+ effects)
// in one locked transaction. Covers the degrade chain (mind → clerk → one-liner), the
// caps (day, mind sub-cap, $, an unreadable ledger), nothing past the max age after
// downtime, two outings ending together, a cancelled outing, revert / regenerate twice /
// edit (a hint needs its outcome word), cursor seeding and re-seeding after an off period,
// restart idempotency, a chat's outing (clerk only, no follow-up), a real person's (a code
// scene from his side, no model, never edited or rewritten). Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR, DAY,
} from './_helpers.js';
import { getEvent, eventsAfter, lastEventId, listEvents } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, dayStart, zonedToUnix } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { config } from '../../src/utils/config.js';
// 018: the code outcome roll is keyed by the activity's event id (rngFor(date, 'scene:outcome:<id>')); the
// wallet's spend events shift ids, so these fixtures (whose stubbed answers assume today's rolls) run without it.
import { __setWalletForTest } from '../../src/life/spending.js';
__setWalletForTest(false);

await setupScratchDb();

// A ledger stand-in: every scripted scene call counts (calls + cost) under its caller.
const ledger = [];
let ledgerBroken = false;
const usage = (prefix, since) => {
  if (ledgerBroken) throw new Error('ledger down');
  const rows = new Map();
  for (const r of ledger) {
    if (r.at < since || !r.caller.startsWith(prefix)) continue;
    const x = rows.get(r.caller) ?? { caller: r.caller, calls: 0, costUsd: 0, input: 0, output: 0 };
    x.calls += 1; x.costUsd += r.cost;
    rows.set(r.caller, x);
  }
  return [...rows.values()];
};

let answer = null;   // (caller, user, index) → string | null
const cr = fakeCallRole({
  'life.scene.clerk': (sys, user, opts, i) => { ledger.push({ caller: 'life.scene.clerk', at: clockNow(), cost: 0.01 }); return answer ? answer('life.scene.clerk', user, i) : null; },
  'life.scene.mind': (sys, user, opts, i) => { ledger.push({ caller: 'life.scene.mind', at: clockNow(), cost: 0.05 }); return answer ? answer('life.scene.mind', user, i) : null; },
});
let clockNow = () => 0;
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
clockNow = () => clock.now();
story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();

const sceneJson = (o = {}) => JSON.stringify({
  narration: 'They met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. '
    + 'He laughed more than he had all week, and by the end they were trading stories about bad flatmates and worse landlords.',
  impressions: null, topics: ['old flatmates', 'weekend plans'], highlight: 'trading stories about bad landlords', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }], ...o,
});

async function applyAction(action) {
  const pv = await director.preview(action);
  const res = await director.apply(pv.previewId, pv.fingerprint);
  return { pv, res };
}
async function until(pred, maxHours = 30) {
  for (let i = 0; i < maxHours * 4; i++) {
    if (pred()) return true;
    await simulateHours(0.25);
  }
  return pred();
}
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
const evening = (dayOffset, hh, mm = 0) => {
  const p = localParts(clock.now(), tz);
  return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * DAY;
};
const rowsFor = (aid) => sceneStore.versionsOf(aid);
const childrenOf = (id) => eventsAfter(id, 50000).filter(e => e.causeId === id && e.actor === 'engine');
async function outing({ castIds = ['cast:flatmate'], placeId = 'place:cafe', startAt, minutes = 90 } = {}) {
  const { res } = await applyAction({ kind: 'scene', shape: 'outing', placeId, castIds, startAt, minutes, label: 'Catch-up' });
  return getEvent(res.eventIds[1]).id;   // the decision.opened
}
// The outing's own block: an activity.started of the amended plan with someone there.
const startedFor = (decisionId, after) => {
  const sub = getEvent(decisionId)?.payload?.subject ?? {};
  return eventsAfter(after, 50000).find(e => e.type === 'activity.started' && getEvent(e.causeId)?.payload?.amendedFor === decisionId
    && e.payload?.placeId === sub.placeId && e.at >= sub.eventAt - 1800 && (e.payload?.withCast?.length || e.subjectJid));
};
const endedFor = (aid, after) => eventsAfter(after, 50000).find(e => e.type === 'activity.ended' && e.causeId === aid);

section('cursor seeding: the first scan never plays history out');
{
  await simulateHours(1);
  await drain();
  check('cursor seeded at the log head', sceneStore.getCursor() !== null && sceneStore.getCursor() <= lastEventId());
  eq('no rows from history', sceneStore.listByStatus('pending').length + sceneStore.listByStatus('done').length + sceneStore.listByStatus('fallback').length, 0);
}

section('an owner outing with the flatmate → mind tier → scene.played + effects');
let firstAid; let firstRow;
{
  answer = () => sceneJson({ chemistry: 0.5 });
  const before = lastEventId();
  const did = await outing({ startAt: evening(1, 19, 0), minutes: 90 });
  const ok = await until(() => !!startedFor(did, before) && !!endedFor(startedFor(did, before).id, before), 40);
  check('the outing started and ended', ok);
  const start = startedFor(did, before);
  firstAid = start?.id;
  await drain();
  const rows = rowsFor(firstAid);
  firstRow = rows[0];
  eq('one row, done, mind tier (owner-directed)', [rows.length, firstRow?.status, firstRow?.tier], [1, 'done', 'mind']);
  const played = getEvent(firstRow?.eventId);
  eq('scene.played caused by the activity.started, engine, self origin', [played?.type, played?.causeId, played?.actor, played?.originKind],
    ['scene.played', firstAid, 'engine', 'self']);
  check('payload codes only (no text), sha of the text', typeof played?.payload?.textSha === 'string' && !JSON.stringify(played.payload).includes('landlords'));
  eq('the mind caller was used', cr.callsFor('life.scene.mind').length, 1);
  const kids = listEvents({ types: ['relationship.changed'], after: played.id - 1 }).filter(e => e.causeId === played.id);
  eq('one scene effect: closeness +0.02 for the flatmate', kids.map(e => [e.payload.castId, e.payload.delta, e.payload.reason]), [['cast:flatmate', { closeness: 0.02 }, 'scene']]);
  eq('folded into story.scenes', S().story.scenes?.[firstAid]?.eventId, played.id);
  check('row text stored, detail has the highlight', firstRow.text?.includes('cafe') && firstRow.detail?.highlight === 'trading stories about bad landlords');
}

section('the prompt surface: the same day, a DM audience');
{
  const lines = life.sceneLines({ chatJid: '15550001111@s.whatsapp.net', kind: 'dm', members: ['15550001111@s.whatsapp.net'] }, { recentText: [] });
  eq('one block', lines.length, 1);
  if (process.env.DBG) console.log(lines[0]);
  check('fenced, framed, ≤ 480', lines[0]?.includes('<<<SCENE_NOTES') && lines[0]?.includes('SCENE_NOTES>>>') && lines[0].length <= 490 && lines[0].includes('Catch-up') === false, lines[0]);
  eq('nothing while imitating', life.sceneLines({ chatJid: 'x@s.whatsapp.net', kind: 'dm' }, { imitating: true }), []);
}

section('regenerate twice, edit, then revert');
{
  const v1 = firstRow;
  const flatClose = () => S().cast.get('cast:flatmate')?.metrics?.closeness;
  const c1 = flatClose();
  answer = () => sceneJson({ chemistry: 0.3, highlight: 'a long walk back in the drizzle', effects: [{ p: 'P1', metric: 'trust', dir: 'up', size: 'small' }] });
  const r2 = await story.sceneRegenerate(v1.id, { tone: 'quiet and easy', outcome: 'fine' });
  await story.idle();
  eq('regenerate → done, v2', [r2.status, sceneStore.getScene(r2.sceneId)?.version], ['done', 2]);
  eq('v1 superseded (text kept for history)', [sceneStore.getScene(v1.id).status, !!sceneStore.getScene(v1.id).text], ['superseded', true]);
  const ev1 = getEvent(v1.eventId);
  const reverts = listEvents({ types: ['event.reverted'] }).filter(e => e.payload.targetId === ev1.id);
  eq('v1 reverted by the owner (scene_regenerated)', reverts.map(e => [e.actor, e.payload.reason]), [['owner', 'scene_regenerated']]);
  const rg = listEvents({ types: ['scene.regenerated'] });
  eq('an owner scene.regenerated record', rg.map(e => [e.actor, e.payload.fromEventId]), [['owner', ev1.id]]);
  const v2 = sceneStore.getScene(r2.sceneId);
  const ev2 = getEvent(v2.eventId);
  eq('v2 caused by the same activity.started (not the owner record)', [ev2.causeId, ev2.originKind, ev2.payload.version, ev2.payload.regenOf], [firstAid, 'self', 2, ev1.id]);
  eq('the tone was used (mind tier, owner-directed) and its outcome word set the outcome', [v2.tier, v2.tone, v2.toneOutcome, v2.detail?.outcome, v2.detail?.outcomeBy],
    ['mind', 'quiet and easy', 'fine', 'fine', 'owner']);
  check('v1 closeness effect undone, v2 trust effect in', Math.abs(flatClose() - (c1 - 0.02)) < 1e-9 && S().story.scenes[firstAid].eventId === ev2.id, { c1, now: flatClose() });
  answer = () => sceneJson({ highlight: 'third time lucky' });
  const r3 = await story.sceneRegenerate(v2.id);
  await story.idle();
  eq('regenerate again → v3 live, v2 superseded', [r3.status, sceneStore.getScene(r3.sceneId)?.version, sceneStore.getScene(v2.id).status], ['done', 3, 'superseded']);
  answer = () => 'not json at all';
  const before = lastEventId();
  const r4 = await story.sceneRegenerate(r3.sceneId);
  await story.idle();
  eq('a failed regenerate keeps the live version, appends nothing', [r4.status, S().story.scenes[firstAid].eventId, eventsAfter(before, 100).length],
    ['failed', sceneStore.getScene(r3.sceneId).eventId, 0]);
  let code = null;
  try { await story.sceneRegenerate(r3.sceneId, { tone: 'he meets Quinn Marlow' }); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('a tone naming a real person is refused', code, 'invalid:real_person_name');
  code = null;
  try { await story.sceneRegenerate(r3.sceneId, { tone: 'a quiet one' }); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('R23: a tone without its outcome word is refused', code, 'invalid:outcome_required');

  const live = sceneStore.getScene(r3.sceneId);
  const ed = story.sceneEditText(live.id, 'They had coffee and walked home slowly.\n\nNothing much happened, and that was the point.');
  eq('edit stored (effects unchanged, no event)', [ed.ok, sceneStore.getScene(live.id).editedText.includes('\n\n')], [true, true]);
  const lines = life.sceneLines({ chatJid: '15550001111@s.whatsapp.net', kind: 'dm', members: ['15550001111@s.whatsapp.net'] }, {});
  check('edited text wins in the prompt', lines[0]?.includes('walked home slowly') && !lines[0].includes('third time lucky'), lines[0]);
  code = null;
  try { story.sceneEditText(live.id, 'Quinn Marlow came along too.'); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('an edit naming a real person is refused', code, 'invalid:real_name');

  const evLive = getEvent(live.eventId);
  check('the live scene is revertible', life.isRevertible(evLive));
  life.revertEvent(evLive.id, { reason: 'test' });
  await drain();
  eq('reverted: the row → reverted, text gone', [sceneStore.getScene(live.id).status, sceneStore.getScene(live.id).text], ['reverted', null]);
  check('no live scene for the outing; its effect undone', !S().story.scenes?.[firstAid] && Math.abs(flatClose() - (c1 - 0.02)) < 1e-9);
  eq('never played again (no new row)', rowsFor(firstAid).filter(r => ['pending', 'done', 'fallback'].includes(r.status)).length, 0);
  eq('nothing in the prompt now', life.sceneLines({ chatJid: '15550001111@s.whatsapp.net', kind: 'dm' }, {}), []);
}

section('degrade chain, caps, budget, an unreadable ledger');
{
  // A routine-tier outing: a member with no owner hand in it is still owner-committed via the Director → mind;
  // the mind call fails → the clerk writes it.
  answer = (caller) => (caller === 'life.scene.mind' ? null : sceneJson({ focus: 'P1' }));
  const before = lastEventId();
  const did = await outing({ castIds: ['cast:coworker-a'], placeId: 'place:park', startAt: evening(1, 18, 30), minutes: 60 });
  await until(() => !!startedFor(did, before) && !!endedFor(startedFor(did, before).id, before), 40);
  await drain();
  const row = rowsFor(startedFor(did, before)?.id)[0];
  eq('mind failed → clerk wrote it', [row?.status, row?.tier], ['done', 'clerk']);

  // Every model fails → the code one-liner, no effects, the outing unaffected.
  answer = () => null;
  const b2 = lastEventId();
  const d2 = await outing({ castIds: ['cast:coworker-b'], placeId: 'place:restaurant', startAt: evening(1, 19, 0), minutes: 60 });
  await until(() => !!startedFor(d2, b2) && !!endedFor(startedFor(d2, b2).id, b2), 40);
  await drain();
  const r2 = rowsFor(startedFor(d2, b2)?.id)[0];
  const ev2 = getEvent(r2?.eventId);
  check('one-liner fallback: tier code, no effects', r2?.status === 'fallback' && r2.tier === 'code' && ev2?.payload?.fallback === true
    && childrenOf(ev2.id).length === 0, r2);
  check('…a readable code line', /with .+ — it (went well|was fine|was a bit flat|didn't go well)\./.test(r2?.text ?? ''), r2?.text);

  // Day cap reached → one-liner, no model call.
  await drain();
  const calls = cr.calls.length;
  config.arcs.sceneMaxPerDay = 0;
  answer = () => sceneJson();
  const b3 = lastEventId();
  const d3 = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt: evening(1, 19, 0), minutes: 60 });
  await until(() => !!startedFor(d3, b3) && !!endedFor(startedFor(d3, b3).id, b3), 40);
  await drain();
  const r3 = rowsFor(startedFor(d3, b3)?.id)[0];
  eq('cap 0 → one-liner, no call', [r3?.status, r3?.skipReason, cr.calls.slice(calls).map(c => c.caller).filter(c => /scene/.test(c))], ['fallback', 'off', []]);
  config.arcs.sceneMaxPerDay = 8;

  // $ cap: the month is spent → 'budget'.
  config.arcs.sceneBudgetUsd = 0;
  const b4 = lastEventId();
  const d4 = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt: evening(1, 19, 0), minutes: 60 });
  await until(() => !!startedFor(d4, b4) && !!endedFor(startedFor(d4, b4).id, b4), 40);
  await drain();
  eq('budget spent → one-liner (budget)', [rowsFor(startedFor(d4, b4)?.id)[0]?.status, rowsFor(startedFor(d4, b4)?.id)[0]?.skipReason], ['fallback', 'budget']);
  config.arcs.sceneBudgetUsd = 1;

  // The ledger can't be read → fail closed.
  ledgerBroken = true;
  const b5 = lastEventId();
  const d5 = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt: evening(1, 19, 0), minutes: 60 });
  await until(() => !!startedFor(d5, b5) && !!endedFor(startedFor(d5, b5).id, b5), 40);
  await drain();
  eq('ledger error → one-liner (ledger)', rowsFor(startedFor(d5, b5)?.id)[0]?.skipReason, 'ledger');
  ledgerBroken = false;

  // Mind sub-cap 0 → the clerk.
  config.arcs.sceneMindMaxPerDay = 0;
  const b6 = lastEventId();
  const d6 = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt: evening(1, 19, 0), minutes: 60 });
  await until(() => !!startedFor(d6, b6) && !!endedFor(startedFor(d6, b6).id, b6), 40);
  await drain();
  eq('mind sub-cap → clerk', rowsFor(startedFor(d6, b6)?.id)[0]?.tier, 'clerk');
  config.arcs.sceneMindMaxPerDay = 3;
}

section('two outings ending in the same tick; a cancelled one; restart idempotency; off → on re-seeds');
{
  // No effects: valid for any code-rolled outcome (a closeness-up effect is an
  // outcome_mismatch when the roll says badly — it did after the 2026-10-31 vitals
  // rebalance moved the event ids and the vitals this roll reads).
  answer = () => sceneJson({ effects: [] });
  await drain();
  // Two routine-style outings (self origin, no decision) whose ends land in ONE scan.
  const { appendEvent } = await import('../../src/life/eventLog.js');
  const fab = (cast) => {
    const t0 = clock.now() - 2 * HOUR;
    const st = appendEvent({ type: 'activity.started', at: t0, actor: 'engine', payload: { kind: 'hangout', placeId: 'place:cafe', withCast: [cast], social: true, availability: 'busy', end: t0 + HOUR } });
    appendEvent({ type: 'activity.ended', at: t0 + HOUR, actor: 'engine', causeId: st.id, payload: { kind: 'hangout', placeId: 'place:cafe' } });
    return st;
  };
  const sa = fab('cast:flatmate');
  const sb = fab('cast:coworker-a');
  story.__rebuildForTest();
  await drain();
  const ra = rowsFor(sa.id);
  const rb = rowsFor(sb.id);
  eq('both got exactly one scene', [ra.length, rb.length, ra[0]?.status, rb[0]?.status], [1, 1, 'done', 'done']);

  // Cancelled mid-way: the outing's activity reverted while it runs → no scene.
  const b2 = lastEventId();
  const dc = await outing({ castIds: ['cast:coworker-b'], placeId: 'place:park', startAt: evening(1, 18, 0), minutes: 120 });
  await until(() => !!startedFor(dc, b2), 40);
  const st = startedFor(dc, b2);
  life.revertEvent(st.id, { reason: 'cancelled mid-way' });
  await simulateHours(3);
  await drain();
  eq('a cancelled outing gets no scene', rowsFor(st.id).length, 0);

  // A second scan / a re-run never queues a played outing again.
  const n = await story.runScenesNow();
  void n;
  eq('re-running the job adds nothing', rowsFor(sa.id).length, 1);

  // R24: an outing that ended while the scenes were off is never played out (the cursor re-seeds on).
  config.arcs.scenesEnabled = false;
  const b3 = lastEventId();
  const doff = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt: evening(1, 18, 0), minutes: 60 });
  await until(() => !!startedFor(doff, b3) && !!endedFor(startedFor(doff, b3).id, b3), 40);
  config.arcs.scenesEnabled = true;
  await simulateHours(0.5);
  await drain();
  eq('an outing from the off period gets no row', rowsFor(startedFor(doff, b3)?.id).length, 0);
}

section('an outing across midnight: the scene lands on its span (Day view)');
{
  answer = () => sceneJson();
  const before = lastEventId();
  const startAt = evening(1, 23, 0);
  const did = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt, minutes: 90 });
  await until(() => !!startedFor(did, before) && !!endedFor(startedFor(did, before).id, before), 40);
  await drain();
  const st = startedFor(did, before);
  const end = endedFor(st.id, before);
  check('it ended after midnight', localParts(end.at, tz).day !== localParts(st.at, tz).day, [localParts(st.at, tz), localParts(end.at, tz)]);
  eq('scene done', rowsFor(st.id)[0]?.status, 'done');
  const p = localParts(st.at, tz);
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const dv = await life.dayView({ date });
  const span = (dv?.past?.spans ?? []).find(x => x.eventId === st.id);
  eq('Day span carries the scene', [span?.scene?.eventId, span?.scene?.ending], [rowsFor(st.id)[0]?.eventId, 'nothing']);
}

section('a chat-origin outing (adopted from a DM): narration only, no effects, that DM only');
const DM_A = '15550002222@s.whatsapp.net';
const DM_B = '15550003333@s.whatsapp.net';
{
  const { appendEvent } = await import('../../src/life/eventLog.js');
  answer = () => sceneJson({ chemistry: 0.9, ending: 'plan_to_meet', highlight: 'the lantern by the door',
    narration: 'They sat under the old lantern by the door and talked until the cafe closed. He told a story about a lantern he had broken as a kid, and the evening went quietly and well.',
    effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'medium' }] });
  const t0 = clock.now() - HOUR;
  const flag = appendEvent({ type: 'claim.flagged', at: t0 - HOUR, actor: 'chat', originKind: 'dm', originJid: DM_A, payload: { claimId: 1, kind: 'plan' } });
  const st = appendEvent({ type: 'activity.started', at: t0, actor: 'engine', causeId: flag.id,
    payload: { kind: 'hangout', placeId: 'place:cafe', withCast: ['cast:flatmate'], social: true, availability: 'busy', end: t0 + HOUR } });
  appendEvent({ type: 'activity.ended', at: t0 + HOUR, actor: 'engine', causeId: st.id, payload: { kind: 'hangout', placeId: 'place:cafe' } });
  story.__rebuildForTest();
  await drain();
  const row = rowsFor(st.id)[0];
  const ev = getEvent(row?.eventId);
  eq('scene played: narration_only, dm origin', [row?.status, row?.mode, ev?.originKind, ev?.originJid], ['done', 'narration_only', 'dm', DM_A]);
  eq('no effects, no follow-up', childrenOf(ev.id).length, 0);
  const heard = (aud) => life.sceneLines(aud, {}).join('\n').includes('lantern');
  check('that DM hears it', heard({ chatJid: DM_A, kind: 'dm', members: [DM_A] }));
  check('another DM does not (it may hear an older self scene)', !heard({ chatJid: DM_B, kind: 'dm', members: [DM_B] }));
  let code = null;
  try { appendEvent({ type: 'scene.followup', at: clock.now(), actor: 'engine', payload: { sceneEventId: ev.id, castId: 'cast:flatmate', from: clock.now() + DAY, to: clock.now() + 3 * DAY } }); } catch (e) { code = 'refused'; }
  eq('a chat-origin scene can never get a follow-up (only a self/owner full scene)', code, 'refused');
  code = null;
  try { appendEvent({ type: 'scene.followup', at: clock.now(), actor: 'engine', causeId: ev.id, payload: { sceneEventId: ev.id, castId: 'cast:flatmate', from: clock.now() + DAY, to: clock.now() + 3 * DAY } }); } catch (e) { code = 'refused'; }
  eq('…and a follow-up never has a cause (a companion, D15)', code, 'refused');
  eq('a chat-origin scene is written by the clerk, never the mind (R10)', row?.tier, 'clerk');
}

section('a real-person outing (invitation): a code scene from his side, no model call, only where they are');
const GROUP = '120363000000000099@g.us';
const PERSON = '15550004444@s.whatsapp.net';
{
  const { appendEvent } = await import('../../src/life/eventLog.js');
  // Whatever a model would say about the friend never matters: no model is called (D10/D17).
  answer = () => JSON.stringify({ narration: 'He met {FRIEND} at the restaurant and {FRIEND} was clearly upset about losing the job, distant and cold all evening. He walked home slowly.',
    impressions: null, topics: ['her divorce', 'losing her job'], highlight: 'walking home slowly', awkward: 'a long silence when her ex came up', chemistry: null, focus: null, ending: 'nothing', effects: [] });
  const mk = (t0) => {
    const flag = appendEvent({ type: 'claim.flagged', at: t0 - HOUR, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { claimId: 2, kind: 'plan' } });
    const st = appendEvent({ type: 'activity.started', at: t0, actor: 'engine', causeId: flag.id, subjectJid: PERSON,
      payload: { kind: 'eat-out', placeId: 'place:restaurant', withCast: [], social: true, availability: 'busy', end: t0 + HOUR } });
    appendEvent({ type: 'activity.ended', at: t0 + HOUR, actor: 'engine', causeId: st.id, subjectJid: PERSON, payload: { kind: 'eat-out', placeId: 'place:restaurant' } });
    story.__rebuildForTest();
    return st;
  };
  const calls0 = cr.calls.filter(c => /scene/.test(c.caller ?? '')).length;
  const st2 = mk(clock.now() - HOUR);
  await drain();
  const r2 = rowsFor(st2.id)[0];
  const ev2 = getEvent(r2?.eventId);
  eq('no model call for a real person\'s scene', cr.calls.filter(c => /scene/.test(c.caller ?? '')).length - calls0, 0);
  eq('a code scene: done, tier code (not a fallback), group origin, the person as subject, no cast', [r2?.status, r2?.tier, ev2?.payload?.fallback, ev2?.originJid, ev2?.subjectJid, ev2?.payload?.castIds],
    ['done', 'code', false, GROUP, PERSON, []]);
  check('outcome pinned to well / fine; ending nothing; no topics / highlight / awkward / impressions',
    ['well', 'fine'].includes(ev2?.payload?.outcome) && ev2.payload.ending === 'nothing' && (r2.detail?.topics ?? []).length === 0
    && r2.detail?.highlight === null && r2.detail?.awkward === null && r2.detail?.impressions === null, r2?.detail);
  check('the text is about him only: no token, no person, nothing the model said', typeof r2?.text === 'string' && /^Eating out/.test(r2.text)
    && !r2.text.includes('{FRIEND}') && !/upset|divorce|silence|she |her /i.test(r2.text), r2?.text);
  const here = life.sceneLines({ chatJid: GROUP, kind: 'group', members: [PERSON] }, {});
  check('the group with the person hears it (the frame names them, the notes are his side)', here.length === 1 && here[0].includes('eating out') && !here[0].includes('{FRIEND}')
    && !/upset|divorce/i.test(here[0]), here);
  const hears = (aud) => life.sceneLines(aud, {}).join('\n').includes(r2.text.slice(0, 30));
  check('the same group without the person: not this scene', !hears({ chatJid: GROUP, kind: 'group', members: ['15550009999@s.whatsapp.net'] }));
  check("the person's own DM (another chat): not this scene", !hears({ chatJid: PERSON, kind: 'dm', members: [PERSON] }));
  eq('never effects', childrenOf(ev2.id).length, 0);
  eq('not exported to the site', story.publicScenes([ev2.id]), []);
  // The dashboard (operator view) names the person; the scene is never rewritten, edited or toned (D17).
  story.setScenePersonLabel(() => 'Robin');
  const d2 = story.sceneDetail(r2.id);
  check('sceneDetail: realPerson + friend, never the JID, not regenerable',
    d2?.realPerson === true && d2.friend === 'Robin' && d2.regenerable === false && !JSON.stringify(d2).includes('15550004444'), d2);
  let code = null;
  try { story.sceneEditText(r2.id, `${r2.text} Annoyingly the place was packed.`); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('an edit is refused (real_person)', code, 'refused:real_person');
  code = null;
  try { await story.sceneRegenerate(r2.id); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('a regenerate is refused (real_person)', code, 'refused:real_person');
  eq('…the stored text is unchanged, no edit', [rowsFor(st2.id)[0]?.editedText ?? null, rowsFor(st2.id).length], [null, 1]);
}

section('downtime: an outing replayed on restart; past the max age → no scene');
{
  answer = () => sceneJson();
  await drain();
  const before = lastEventId();
  // Today 19:00 when this runs after midnight (the sections above end past 00:00).
  const startAt = evening(localParts(clock.now(), tz).hour < 17 ? 0 : 1, 19, 0);
  const did = await outing({ castIds: ['cast:flatmate'], placeId: 'place:cafe', startAt, minutes: 60 });
  await until(() => clock.now() >= startAt - 2 * HOUR, 40);
  await stopLife();
  // The bot is down through the outing; the max age (a .env hard cap, 6–72 h) is lowered for the test.
  config.arcs.sceneMaxAgeHours = 1;
  clock.advance({ hours: 5 });
  const b2 = await bootLife({ world, clock, callRole: cr });
  story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] });
  await drain();
  const st = startedFor(did, before);
  check('the outing was replayed in the catch-up', !!st && !!endedFor(st.id, before));
  const row = st ? rowsFor(st.id)[0] : null;
  eq('ended past the max age → nothing (skipped:too_old), no event, no model call', [row?.status, row?.skipReason, row?.eventId ?? null], ['skipped', 'too_old', null]);
  config.arcs.sceneMaxAgeHours = 36;
  void b2;
}

section('scenes never in tomorrow.simulate / the Day projection');
{
  const sim = await story.simulate({ now: clock.now(), hours: 30 });
  const types = new Set((sim?.events ?? []).map(e => e.type));
  check('no scene.played in a sim', !types.has('scene.played'), [...types].filter(t => t.startsWith('scene')));
}

report();
await stopLife();
