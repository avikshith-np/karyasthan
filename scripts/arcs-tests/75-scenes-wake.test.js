// 016 scene play-outs × wake him (merge of the wake-fix): an owner outing at 01:30
// reached via a Director wake at 01:15 (he is asleep on the plan in force) still gets
// its scene once it ends — the outing's activity.started comes from the night's
// re-plan (caused by the woke → the wake.set), not from a morning plan amendment.
// The wake's own blocks (the broken sleep, free at home) never get one. Example
// world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR,
} from './_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();

const sceneJson = () => JSON.stringify({
  narration: 'They walked to the cafe in the dark and sat by the window with tea and toast. Neither of them could sleep, so they talked '
    + 'about nothing much until the street went quiet again and the tea went cold.',
  impressions: null, topics: ['not sleeping'], highlight: 'tea by the window at two', awkward: null,
  chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [{ p: 'P1', metric: 'closeness', dir: 'up', size: 'small' }],
});
const cr = fakeCallRole({ 'life.scene.mind': () => sceneJson(), 'life.scene.clerk': () => sceneJson() });
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [] });
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const MIN = 60;
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const since = (id, types) => listEvents({ types, limit: 5000 }).filter(e => e.id > id);
const lastId = () => Math.max(0, ...listEvents({ limit: 5000 }).map(e => e.id));
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); }

const today0 = dayStart(clock.now(), tz);
const tomorrow = addDays(today0, 1, tz);
const NEAR = 'place:cafe';

section('scenes on, cursor seeded before the night');
{
  await simulateHours(16);   // Tue ~22:00
  await drain();
  check('cursor seeded', sceneStore.getCursor() !== null);
}

section('asleep at 00:50 → an owner outing at 01:30 with the flatmate + a wake at 01:15');
let outingId = null;
let before = 0;
{
  await stepTo(at(tomorrow, 0, 50));
  eq('asleep at 00:50', S().activity?.kind, 'sleep');
  before = lastId();
  const outing = { kind: 'scene', shape: 'outing', placeId: NEAR, startAt: at(tomorrow, 1, 30), minutes: 60, castIds: ['cast:flatmate'], label: 'Sleepless tea' };
  const p = await story.director.preview({ kind: 'bundle', actions: [outing, { kind: 'wake', reason: 'cant_sleep', at: '01:15' }] }, { relax: true });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  await story.lastScheduleKick();
  check('applied', r?.ok === true, JSON.stringify(r));
  outingId = decisionOf('Sleepless tea')?.id ?? null;
  check('the outing decision exists', !!outingId);
}

section('he wakes, goes out, comes home → the outing gets its scene');
{
  await stepTo(at(tomorrow, 3, 0));
  const woke = since(before, ['woke']).find(e => e.payload?.interrupted === true);
  check('woken by the wake request', !!woke && getEvent(woke.causeId)?.type === 'wake.set', JSON.stringify(woke));
  const start = since(before, ['activity.started']).find(e => e.payload?.placeId === NEAR && (e.payload?.withCast ?? []).includes('cast:flatmate'));
  check('the outing with the flatmate started', !!start, JSON.stringify(since(before, ['activity.started']).map(e => e.payload)));
  const ended = start && since(before, ['activity.ended']).find(e => e.causeId === start.id);
  check('…and ended', !!ended);
  eq('no could_not_go', since(before, ['decision.expired']).filter(e => e.payload.decisionId === outingId).map(e => e.payload.reason), []);
  await drain();
  const rows = start ? sceneStore.versionsOf(start.id) : [];
  eq('one scene row for the outing, done', [rows.length, rows[0]?.status], [1, 'done']);
  eq('…mind tier (owner-directed)', rows[0]?.tier, 'mind');
  const played = getEvent(rows[0]?.eventId);
  eq('scene.played caused by the outing\'s activity.started, engine, self origin', [played?.type, played?.causeId, played?.actor, played?.originKind],
    ['scene.played', start?.id, 'engine', 'self']);
  check('a mind call was made', cr.callsFor('life.scene.mind').length === 1, String(cr.callsFor('life.scene.mind').length));
  // Only the outing: the wake's blocks (free at home, the sleep) are routine.
  const sceneEvents = since(before, ['scene.played']);
  eq('exactly one scene this night', sceneEvents.map(e => e.causeId), [start?.id]);
}

report();
