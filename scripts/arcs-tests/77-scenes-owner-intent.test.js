// Owner intent and long outings (the pizza night). The sheet carries the owner's line and,
// at ≥ 180 min, the longer narration cap. An invented name retries the same tier once.
// An explicit scene stays on desire: Opus is not given that sheet, and a refusal does not
// fall through to the clerk. Example world, fake clock, no network.
import fs from 'fs';
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR, DAY,
} from './_helpers.js';
import { getEvent, eventsAfter, lastEventId } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { buildFactSheet, ownerIntentOf } from '../../src/life/story/scenes/facts.js';
import { renderUser, SCENE_CHARTER } from '../../src/life/story/scenes/charter.js';
import { validateSceneOutput, validateEditedText, sceneTextCap } from '../../src/life/story/scenes/schema.js';
import { config } from '../../src/utils/config.js';
import { __setWalletForTest } from '../../src/life/spending.js';

__setWalletForTest(false);
await setupScratchDb();

const LABEL = 'Pizza with her friends, a long night out';
const BAD = 'They sat down and Zorblax waved, then Quimby pulled up a chair. The two of them talked about books and old trips until the street went quiet and he walked home pleased with the evening.';

let answer = null;
const cr = fakeCallRole({
  'life.scene.clerk': (_sys, user, _opts, i) => (answer ? answer('life.scene.clerk', user, i) : null),
  'life.scene.mind': (_sys, user, _opts, i) => (answer ? answer('life.scene.mind', user, i) : null),
  'role:desire': (_sys, user, _opts, i) => (answer ? answer('life.scene.desire', user, i) : null),
});
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
story.__setDepsForTest({
  mindBudgetOk: async () => ({ ok: true }),
  knownNames: () => ['Quinn Marlow'],
  getUsageByCaller: () => [],
});
const tz = resolveTimezone(world.timezone);
const base = () => life.getState();

const sceneJson = (o = {}) => JSON.stringify({
  narration: 'They met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. '
    + 'He laughed more than he had all week, and by the end they were trading stories about bad flatmates and worse landlords.',
  impressions: null, topics: ['old flatmates', 'weekend plans'], highlight: 'trading stories about bad landlords', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [], ...o,
});

function withOwner(s, { id = 42, label = LABEL, by = 'owner' } = {}) {
  s.decisions.set(id, {
    id, status: 'committed', committed: { by, optionId: 'go' },
    options: [{ id: 'go', label }, { id: 'stay', label: 'Stay in' }],
    subject: { placeId: 'place:cafe', castIds: ['cast:flatmate'] },
  });
  return s;
}
function session(over = {}) {
  const start = clock.now() - 8 * HOUR;
  return {
    mode: 'full', originKind: 'self', originJid: 'self', minutes: 360, castIds: ['cast:flatmate'],
    decisionId: 42, kind: 'hangout', placeId: 'place:cafe', home: false, activityEventId: 1,
    startAt: start, endAt: start + 360 * 60, ...over,
  };
}

section('the sheet: owner intent and a long night');
{
  const s = withOwner(base());
  const built = buildFactSheet(s, session(), { tz, persona: { displayName: 'Him' }, outcome: { value: 'well', by: 'owner' } });
  eq('a 6-hour owner outing carries the label and long', [built.sheet.ownerIntent, built.sheet.long], [LABEL, true]);
  const user = renderUser(built.sheet);
  check('the user message fences the intent and asks for the arc, and does not add the explicit paragraph',
    user.includes(LABEL) && user.includes('stay unnamed') && user.includes('how it started') && user.includes('2400')
    && user.includes('one of her friends') && !/consensual sex/.test(user) && !/consensual sex/.test(SCENE_CHARTER));
  const explicit = renderUser({ ...built.sheet, register: 'explicit' });
  check('the explicit paragraph is only added for an explicit register', /consensual sex/.test(explicit) && explicit.includes(LABEL));

  const short = buildFactSheet(s, session({ minutes: 90, endAt: clock.now() - 7 * HOUR }), { tz, persona: { displayName: 'Him' }, outcome: { value: 'well', by: 'owner' } });
  eq('a 90-minute owner outing keeps the label and is not long', [short.sheet.ownerIntent, short.sheet.long ?? null], [LABEL, null]);
  check('a short scene does not get the long-arc line', !renderUser(short.sheet).includes('how it started'));

  const chat = buildFactSheet(s, session({ mode: 'narration_only', originKind: 'group' }), { tz, outcome: { value: 'fine', by: 'code' } });
  eq('a chat outing gets no owner intent', chat.sheet.ownerIntent ?? null, null);
  const real = buildFactSheet(s, session({ mode: 'self_only', castIds: [] }), { tz, outcome: { value: 'fine', by: 'code' } });
  eq('a real person gets no owner intent', [real.sheet.ownerIntent ?? null, real.sheet.people.length], [null, 0]);
  eq('ownerIntentOf agrees', ownerIntentOf(s, session()), LABEL);

  const labels = { P1: 'cast:flatmate' };
  const names = ['Flatmate', 'Him'];
  const ctx = { labels, mode: 'full', outcome: 'well', firstMeet: [], names, knownNames: [], castNames: ['Flatmate'], venueNames: [] };
  const body = 'They talked about the week and walked home slowly after. ';
  const longText = body.repeat(36);
  check('the long fixture is over 1200 and within 2400', longText.length > 1200 && longText.length <= 2400, longText.length);
  const pack = (narration) => JSON.stringify({
    narration, impressions: null, topics: ['the week'], highlight: 'walking home', awkward: null,
    chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
  });
  check('a long scene validates up to the long cap', validateSceneOutput(pack(longText), { ...ctx, maxChars: sceneTextCap(360), parasMax: 9 }).ok);
  eq('a short scene still refuses over 1200', validateSceneOutput(pack(longText), { ...ctx, maxChars: 1200, parasMax: 6 }).reason, 'too_long');
  eq('an owner edit of a short scene refuses over 1200', validateEditedText('y'.repeat(1201), { mode: 'full', maxChars: 1200, knownNames: [] }).reason, 'too_long');
  check('an owner edit of a long scene allows 2000', validateEditedText('y'.repeat(2000), { mode: 'full', maxChars: 2400, parasMax: 9, knownNames: [] }).ok);
  eq('2401 is still too long', validateEditedText('y'.repeat(2401), { mode: 'full', maxChars: 2400, parasMax: 9, knownNames: [] }).reason, 'too_long');
}

section('explicit scenes stay on desire');
{
  const src = fs.readFileSync(new URL('../../src/life/story/scenes/worker.js', import.meta.url), 'utf8');
  const block = src.split("if (register === 'explicit')")[1].split('} else {')[0];
  check('the explicit branch retries desire and does not open the mind-then-clerk chain',
    block.includes('explicit: true') && block.includes('writeTier') && !block.includes("['mind', 'clerk']"));
  check('desire still has no fallback', /explicit \? 'desire'/.test(src) && /noFallback: true/.test(src));
}

const evening = (dayOffset, hh, mm = 0) => {
  const p = localParts(clock.now(), tz);
  return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * DAY;
};
async function applyAction(action) {
  const pv = await director.preview(action);
  if (!pv?.previewId) return { pv, res: null };
  const res = await director.apply(pv.previewId, pv.fingerprint);
  return { pv, res };
}
async function until(pred, maxHours = 40) {
  for (let i = 0; i < maxHours * 4; i++) {
    if (pred()) return true;
    await simulateHours(0.25);
  }
  return pred();
}
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }
const startedFor = (decisionId, after) => eventsAfter(after, 50000).find(e => e.type === 'activity.started'
  && getEvent(e.causeId)?.payload?.amendedFor === decisionId && (e.payload?.withCast?.length || e.subjectJid));
const endedFor = (aid, after) => eventsAfter(after, 50000).find(e => e.type === 'activity.ended' && e.causeId === aid);

section('one invented try is retried; two are not');
{
  config.arcs.sceneMindMaxPerDay = 20;
  config.arcs.sceneMaxPerDay = 20;
  await simulateHours(1);
  let n = 0;
  answer = () => (++n === 1 ? sceneJson({ narration: BAD }) : sceneJson());
  const before = lastEventId();
  const calls0 = cr.calls.length;
  const applied = await applyAction({
    kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:flatmate'],
    startAt: evening(1, 19, 0), minutes: 90, label: LABEL,
  });
  check('the owner outing applied', applied.res?.ok === true, applied.pv?.refusals);
  const decisionId = applied.res?.eventIds?.[1];
  const ran = await until(() => decisionId && startedFor(decisionId, before) && endedFor(startedFor(decisionId, before).id, before));
  check('it started and ended', ran);
  await drain();
  const start = startedFor(decisionId, before);
  const row = sceneStore.versionsOf(start?.id)[0];
  const sceneCalls = cr.calls.slice(calls0).filter(c => String(c.caller || '').startsWith('life.scene.'));
  eq('one retry on the mind tier, then a stored scene', [row?.status, row?.tier, sceneCalls.length], ['done', 'mind', 2]);
  eq('both calls are mind, neither is desire', sceneCalls.map(c => c.role), ['mind', 'mind']);
  check('the correction is on the second call only', !!sceneCalls[1]?.user?.includes('Correction') && !sceneCalls[0]?.user?.includes('Correction'));
  check('Opus is not shown an explicit paragraph', sceneCalls.every(c => !/consensual sex/.test(String(c.system)) && !/consensual sex/.test(String(c.user))));
  check('the sheet and the prompt carry the owner line', row?.sheet?.ownerIntent === LABEL && sceneCalls[0].user.includes(LABEL) && sceneCalls[0].user.includes('one of her friends'));
  eq('a 90-minute scene is not marked long, and the call stays at 900 tokens', [row?.sheet?.long ?? null, sceneCalls[0].opts?.maxTokens], [null, 900]);

  let code = null;
  try { story.sceneEditText(row.id, 'y'.repeat(1201)); } catch (e) { code = `${e.code}:${e.reason}`; }
  eq('a short scene still refuses an edit over 1200', code, 'invalid:too_long');
  sceneStore.update(row.id, { sheet: { ...row.sheet, long: true, time: { ...(row.sheet?.time ?? {}), minutes: 360 } } });
  const edited = story.sceneEditText(row.id, 'y'.repeat(2000));
  eq('a long scene accepts 2000 characters', [edited.ok, sceneStore.getScene(row.id).editedText?.length], [true, 2000]);

  const stripped = { ...sceneStore.getScene(row.id).sheet };
  delete stripped.ownerIntent;
  delete stripped.long;
  sceneStore.update(row.id, { sheet: stripped });
  const atCalls = cr.calls.length;
  answer = () => sceneJson();
  const regen = await story.sceneRegenerate(row.id);
  await story.idle();
  const regenCalls = cr.calls.slice(atCalls).filter(c => String(c.caller || '').startsWith('life.scene.'));
  check('a regenerate rebuilds the owner line even when v1 stored none',
    regen.status === 'done' && regenCalls.some(c => c.user.includes(LABEL) && c.user.includes('stay unnamed')));

  n = 0;
  answer = () => sceneJson({ narration: BAD });
  const b2 = lastEventId();
  const c2 = cr.calls.length;
  const second = await applyAction({
    kind: 'scene', shape: 'outing', placeId: 'place:park', castIds: ['cast:coworker-a'],
    startAt: evening(1, 18, 30), minutes: 60, label: 'A walk',
  });
  check('the second outing applied', second.res?.ok === true, second.pv?.refusals);
  const id2 = second.res?.eventIds?.[1];
  const ran2 = await until(() => id2 && startedFor(id2, b2) && endedFor(startedFor(id2, b2).id, b2));
  check('the second outing started and ended', ran2);
  await drain();
  const row2 = sceneStore.versionsOf(startedFor(id2, b2)?.id)[0];
  const calls2 = cr.calls.slice(c2).filter(c => String(c.caller || '').startsWith('life.scene.'));
  eq('two invented tries on each tier → the code one-liner', [row2?.status, row2?.tier], ['fallback', 'code']);
  check('the row keeps both tiers\' reasons, and desire was not called',
    row2?.skipReason?.includes('mind:invented_name') && row2?.skipReason?.includes('clerk:invented_name')
    && calls2.length === 4 && calls2.every(c => c.role !== 'desire'), row2?.skipReason);
  config.arcs.sceneMindMaxPerDay = 3;
  config.arcs.sceneMaxPerDay = 8;
}

await stopLife();
report();
