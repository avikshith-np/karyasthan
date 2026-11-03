// 017 Tell the story, made easy: the page applies a wish as ONE bundle per ≤ 5
// drafts (prompt.js promptBundles), every part planned with source 'prompt' —
// never `relax`, whatever the preview's own relax says (director.js
// UNRELAXED_SOURCES) — and audited as such; the plan in one line (planLineOf)
// and each draft's phrase are built in code, never from model text.
// Replays the live wish of 2026-10-31 (a breakfast with a coworker and his new
// friend at the cafe, the coworker's news riding along, an unasked bookmark
// dropped) on the example world. Invented, persona-neutral names; fake clock,
// stubbed mind model, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole } from './_helpers.js';
import { getDb } from '../../src/memory/db.js';
import { dateKey, addDays, dayStart, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';
import * as director from '../../src/life/story/director.js';
import { getEvent } from '../../src/life/eventLog.js';
import { partsProblem, PART_SOURCES as ROUTE_PART_SOURCES } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
const { life, world, clock } = await bootLife();
await simulateHours(30);               // Wed, mid-morning
const story = await import('../../src/life/story/index.js');
const promptMod = await import('../../src/life/story/prompt.js');
const D = story.director;
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;

let answer = null;
const fcr = fakeCallRole({ 'director.prompt': () => JSON.stringify(answer) });
story.__setDepsForTest({ callRole: fcr.fn, getUsageByCaller: () => [], knownNames: () => [], mindBudgetOk: async () => ({ ok: true }) });
const ask = async (wish, actions) => { answer = { actions, cantDo: [] }; return D.prompt(wish); };

const tomorrow = dateKey(addDays(dayStart(clock.now(), tz), 1, tz) + 12 * 3600, tz);
const WISH = 'Coworker A invites his friend, a 25-year-old from the hills, to breakfast tomorrow at the cafe, 10:30 to 12';
const LIVE = [
  { action: { kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:coworker-a'], newCast: { name: 'Ivy Marr', relation: 'acquaintance' },
    when: { day: 1, time: '10:30' }, minutes: 90, label: 'breakfast with Coworker A and his friend' }, why: 'the breakfast' },
  { action: { kind: 'scene', shape: 'cast.beat', castId: 'cast:coworker-a', beatKind: 'news', text: 'invited a friend to join breakfast tomorrow' },
    why: 'his news', accompanies: 0 },
  { action: { kind: 'bookmark', name: 'first breakfast together' }, why: 'remember it' },
];

section('the live wish: two drafts, the unasked bookmark dropped, a code-built plan line');
let r = null;
{
  r = await ask(WISH, LIVE);
  eq('status ok, two drafts', [r.status, r.drafts.length], ['ok', 2]);
  check('the bookmark was dropped unrequested', r.dropped.some(x => x.kind === 'bookmark' && x.reason === 'unrequested'), JSON.stringify(r.dropped));
  const p0 = r.drafts[0].phrase;
  check('the outing phrase: time, place, the coworker, someone new', /10:30/.test(p0) && p0.includes('Coworker A (example)') && /someone new/.test(p0) && /90 min/.test(p0), p0);
  check('…never the model-made name or label', !/Ivy|breakfast with/.test(p0), p0);
  eq('the beat phrase', r.drafts[1].phrase, 'news from Coworker A (example)');
  check('planLine: one sentence, ≤ 240, capitalised, both parts', typeof r.planLine === 'string' && r.planLine.length <= 240
    && /^[A-Z]/.test(r.planLine) && r.planLine.endsWith('.') && r.planLine.includes('news from'), r.planLine);
  check('planLine has no model text', !/Ivy|hills|invited a friend/.test(r.planLine), r.planLine);
  eq('bundlePlan: one bundle (main, then its side draft), nothing after or waiting', r.bundlePlan, { bundles: [[0, 1]], after: [], waiting: [] });
}

section('one bundle of prompt parts: preview → apply, audited as prompt');
{
  const action = { kind: 'bundle', actions: r.drafts.map(d => ({ ...d.action, source: 'prompt' })) };
  eq('the route accepts prompt parts', partsProblem(action), null);
  check('route and planner agree on the sources', ROUTE_PART_SOURCES.has('prompt') && director.PART_SOURCES.includes('prompt'));
  const pv = await D.preview(action, { source: 'prompt' });
  eq('previewed: no refusals', pv.refusals ?? [], []);
  const before = count();
  let stale = null;
  try { await D.apply(pv.previewId, 'f'.repeat(64)); } catch (e) { stale = e.code; }
  check('a wrong fingerprint is refused, nothing written', stale !== null && count() === before, stale);
  const res = await D.apply(pv.previewId, pv.fingerprint);
  eq('parts recorded with source prompt', res.parts, [{ kind: 'scene', source: 'prompt' }, { kind: 'scene', source: 'prompt' }]);
  // The page's UNDO ALL keeps res.actionEventId: the bundle's FIRST part's director.action (the grouped revert finds its siblings).
  const firstAction = res.eventIds.map(getEvent).find(e => e?.type === 'director.action');
  check('apply returns the first part\'s director.action as actionEventId', Number.isSafeInteger(res.actionEventId) && res.actionEventId === firstAction?.id,
    { actionEventId: res.actionEventId, first: firstAction?.id });
  const ivy = [...S().cast.values()].find(c => c.name === 'Ivy Marr');
  check('the new member is in his life', !!ivy);
  check('the outing is committed go with both', [...S().decisions.values()].some(d => d.status === 'committed'
    && d.subject?.placeId === 'place:cafe' && d.subject?.castIds?.includes('cast:coworker-a') && d.subject?.castIds?.includes(ivy?.id)));
  eq('the news landed on the coworker', S().story.castLife['cast:coworker-a']?.lastBeat?.kind, 'news');
  const parents = res.eventIds.map(id => getDb().prepare('SELECT type, payload_json FROM world_events WHERE id = ?').get(id))
    .filter(e => e.type === 'director.action').map(e => JSON.parse(e.payload_json).fingerprint);
  eq('two director.actions sharing the fingerprint', parents, [pv.fingerprint, pv.fingerprint]);
}

section('a prompt part never plans with relax (a pin stays a refusal)');
{
  const pin = await D.preview({ kind: 'pin', pinKey: 'cast:sibling' });
  await D.apply(pin.previewId, pin.fingerprint);
  const beat = { kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'status', text: 'busy with exams' };
  const now = clock.now();
  const hand = director.plan({ kind: 'bundle', actions: [{ ...beat, source: 'hand' }] }, S(), { now, relax: true });
  const fromPrompt = director.plan({ kind: 'bundle', actions: [{ ...beat, source: 'prompt' }] }, S(), { now, relax: true });
  check('owner hand part with relax: the pin is a warning, no refusal', !hand.refusals.some(x => x.reason === 'pinned'), JSON.stringify(hand.refusals));
  check('prompt part with relax: still refused pinned', fromPrompt.refusals.some(x => x.reason === 'pinned'), JSON.stringify(fromPrompt.refusals));
  const cont = director.plan({ kind: 'bundle', actions: [{ ...beat, source: 'continuity' }] }, S(), { now, relax: true });
  check('continuity parts unchanged (also refused)', cont.refusals.some(x => x.reason === 'pinned'));
}

section('promptBundles and planLineOf (pure)');
{
  const d = (index, kind, extra = {}) => ({ index, action: { kind, ...(kind === 'scene' ? { shape: 'cast.beat', castId: 'cast:flatmate' } : {}) }, events: 2, ...extra });
  eq('six mains → 5 + 1, in order', promptMod.promptBundles([0, 1, 2, 3, 4, 5].map(i => d(i, 'scene'))).bundles, [[0, 1, 2, 3, 4], [5]]);
  eq('a bookmark applies after; a side draft rides after the mains; a status waits',
    promptMod.promptBundles([d(0, 'bookmark', { side: true }), d(1, 'scene', { side: true }), d(2, 'scene'), d(3, 'scene', { status: 'needs_pick' })]),
    { bundles: [[2, 1]], after: [0], waiting: [3] });
  eq('a draft that plans to nothing is left out', promptMod.promptBundles([d(0, 'scene', { events: 0 })]), { bundles: [], after: [], waiting: [] });
  eq('no drafts → no line', promptMod.planLineOf([], S(), clock.now(), tz), null);
  const many = Array.from({ length: 6 }, (_, i) => ({ action: { kind: 'scene', shape: 'outing', placeId: 'place:restaurant', castIds: ['cast:coworker-a', 'cast:coworker-b', 'cast:flatmate'],
    when: { date: tomorrow, time: `1${i}:00` }, minutes: 60 } }));
  const line = promptMod.planLineOf(many, S(), clock.now(), tz);
  check('a long plan is cut at a phrase with "and N more"', line.length <= 240 && /and \d+ more changes?\.$/.test(line), line);
}

await stopLife();
report();
