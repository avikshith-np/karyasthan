// Plan 020 §E1: the sweep's two rules that need the story layer's own tables, on the live path. A real
// outing → a real scene sheet → its "afterwards" lines read back against the log (a line that gains its
// "there by" later still holds; one the log doesn't back is counted, never shown). A real text thread
// → the strong cue read from the words, reported as a code. Example world, fake clock, stubbed models.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR } from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { strongCue } from '../../src/life/story/phone/plans.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();

section('strongCue: plainly coming, not merely friendly');
{
  for (const [text, want] of [
    ['on my way!', 'on my way'], ['OMW', 'on my way'], ['otw now', 'on my way'], ['coming over in a bit', 'coming over'],
    ["I'll be there", 'be there'], ['be there by 8', 'be there'], ['see you at 8', 'see you then'], ['see ya tomorrow', 'see you then'],
    ['see you soon', null], ['haha ok', null], ['how was your day', null], ['', null], [null, null],
    ['on my way’s not a phrase here? kidding, on my way', 'on my way'],
  ]) eq(`${JSON.stringify(text)} → ${want}`, strongCue(text), want);
}

const WORDS = 'on my way over, save me a seat';
const sceneJson = () => JSON.stringify({
  narration: 'They sat for a long while at the cafe and talked about the week, the rain and an old plan to go away somewhere. '
    + 'By the second coffee the talk had gone easy and neither of them was looking at the time at all.',
  impressions: { him: [], them: [] }, topics: ['the week'], highlight: 'the second coffee', awkward: null, chemistry: 0.3, focus: 'P1', ending: 'nothing', effects: [],
});
const cr = fakeCallRole({
  'life.scene.mind': () => sceneJson(), 'life.scene.clerk': () => sceneJson(),
  'life.phone.his': () => JSON.stringify({ messages: [WORDS], tone: 'warm', topic: 'tonight', end: true }),
  'life.phone.mind': () => JSON.stringify({ messages: [WORDS], tone: 'warm', topic: 'tonight', end: true }),
  'life.phone.cast': () => JSON.stringify({ messages: ['ok'], tone: 'warm', topic: 'tonight', end: true }),
  'life.phone.plan': () => JSON.stringify({ agreed: false, kind: 'outing', placeHint: null, when: null, day: null, minutes: null, confidence: 0.1 }),
});
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: false }), knownNames: () => [], identity: async () => 'You are an example.' });
config.arcs.phoneOrganicPerDay = 0;
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 15 }); };
const drainScenes = async () => { await story.idle(); await story.runScenesNow(); await story.idle(); };
const drainPhone = async () => { await story.idle(); await story.runPhoneNow(); await story.idle(); };
const CAST = 'cast:flatmate';

await simulateHours(1);
await drainScenes();
await drainPhone();

section('a real outing, its real sheet, read back');
let scene = null;
{
  const day = addDays(dayStart(clock.now(), tz), 1, tz);
  const startAt = at(day, 15, 0);
  const p = await story.director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes: 90, castIds: [CAST], label: 'coffee catch-up' }, { relax: true });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  check('the outing is applied', r?.ok === true, JSON.stringify(r));
  await stepTo(startAt + 95 * 60);       // just ended: the trip home has only just begun
  await drainScenes();
  scene = listEvents({ types: ['scene.played'], from: startAt, limit: 10 })[0];
  check('its scene played', !!scene);
  const row = sceneStore.getByEvent(scene.id);
  check('…with "afterwards" lines on its sheet', Array.isArray(row?.sheet?.afterwards) && row.sheet.afterwards.length > 0, JSON.stringify(row?.sheet));
  eq('they match the log', story.sceneAfterwardsCheck([scene.id]), [{ eventId: scene.id, stale: 0 }]);
  await stepTo(startAt + 4 * HOUR);
  eq('…still, once the trip home has gained its "there by"', story.sceneAfterwardsCheck([scene.id])[0].stale, 0);
  eq('the sweep agrees', life.runSweepNow().findings.filter(f => f.rule === 'scene_afterwards').length, 0);
}

section('a line the log no longer backs: counted, never shown');
{
  const row = sceneStore.getByEvent(scene.id);
  const LIE = '23:59: he walked home with a total stranger';
  sceneStore.update(row.id, { sheet: { ...row.sheet, afterwards: [...row.sheet.afterwards, LIE] } });
  eq('one stale line', story.sceneAfterwardsCheck([scene.id])[0].stale, 1);
  const f = life.runSweepNow().findings.filter(x => x.rule === 'scene_afterwards');
  check('the sweep says so at info level', f.length === 1 && f[0].severity === 'info' && f[0].eventIds.includes(scene.id), JSON.stringify(f));
  check('…without the line itself', !f[0].text.includes('stranger'), f[0].text);
  sceneStore.update(row.id, { sheet: row.sheet });
  eq('…the sheet right again: gone at the next run', life.runSweepNow().findings.filter(x => x.rule === 'scene_afterwards').length, 0);
  eq('a scene with no such row: nothing, no throw', story.sceneAfterwardsCheck([999999]), []);
}

section('a real text saying he is on his way, no plan near it');
{
  const day = addDays(dayStart(clock.now(), tz), 2, tz);
  await stepTo(at(day, 18, 0));
  const p = await story.director.preview({ kind: 'text', castId: CAST, gist: 'tell them he is coming', tone: 'warm' });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  check('the owner asks for the text', r?.ok === true, JSON.stringify(r));
  for (let i = 0; i < 12 && !phoneStore.threadOf(CAST, { live: true }).some(x => (x.text ?? '').includes('on my way')); i++) {
    await drainPhone();
    await simulateHours(0.25);
  }
  await drainPhone();
  const turn = phoneStore.threadOf(CAST, { live: true }).find(x => (x.text ?? '').includes('on my way'));
  check('his turn is live', !!turn);
  eq('the cue is a code word', story.phoneStrongCues([turn.eventId]), [{ eventId: turn.eventId, cue: 'on my way' }]);
  const f = life.runSweepNow().findings.filter(x => x.rule === 'text_plan' && x.eventIds.includes(turn.eventId));
  const ring = story.phonePlanOutcomes();
  const entry = ring?.entries.find(e => e.id === turn.eventId);
  eq('the plan step recorded what it decided, in codes', [entry?.o, entry?.c], ['nothing', 'not_agreed']);
  check('…no words in the ring', !JSON.stringify(ring).includes('save me a seat'));
  eq('a logged "nothing was agreed": an answer, so no finding', f.length, 0);
  phoneStore.__dropPlanOutcomeForTest(turn.eventId);
  const g = life.runSweepNow().findings.filter(x => x.rule === 'text_plan' && x.eventIds.includes(turn.eventId));
  check('the same turn with no record: the step never looked at it', g.length === 1 && g[0].severity === 'warn' && /never looked/.test(g[0].text), JSON.stringify(g));
  check('…none of his words but the cue', !g[0].text.includes('save me a seat'), g[0].text);
  eq('a turn that is not live: nothing', story.phoneStrongCues([987654]), []);
}

report();
