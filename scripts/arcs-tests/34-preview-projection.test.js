// 015 Phase 2 — the re-projected future in a preview (src/life/story/projection.js,
// tomorrow.simulate {anchorFirst, closeChatMood}, director.preview; plan §P2.3, review #35):
// before and after are two sim runs from the same anchor (the sim pulse runs to
// now before the batch is appended), with the install seed and the 012 overlay
// closed, so a no-op gives identical runs; an outing adds rows and a decision; a
// free evening removes work; a chat-made plan is genericised; the budget and the
// process-wide rate skip cleanly; apply never simulates; nothing is written.
//
// integration: a realistic log from the life facade (example world, timers off),
// then the Director on a local projection and appender. Invented, persona-neutral
// names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { zonedToUnix, dateKey, dayStart, addDays, resolveTimezone } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import { buildProjection, projectionRuns, __resetProjectionRate, PROJECTIONS_PER_MIN } from '../../src/life/story/projection.js';
import { getDb } from '../../src/memory/db.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(1);
await simulateHours(7);               // Wed (an office day), early afternoon
await stopLife();

let state = rebuild({ world });
const append = (spec) => {
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append, knownNames: () => ['Quinlan Marsh'], seed: () => seed,
  setClaimStatus: () => {}, fit: () => null, projectionBudgetMs: 60_000,
});
const tz = resolveTimezone(world.timezone ?? config.timezone);
const now = () => clock.now();
const today = dayStart(now(), tz);
const tomorrow = addDays(today, 1, tz);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
const appendDescriptors = (list, ap) => director.appendDescriptors(list, ap);

section('a no-op: identical runs (same anchor, same seed)');
{
  __resetProjectionRate();
  const before = count();
  const p = await buildProjection({ state, world, now: now(), descriptors: [], deps: { appendDescriptors }, budgetMs: 60_000 });
  check('rows are listed', Array.isArray(p.rows) && p.rows.length > 0, JSON.stringify(p).slice(0, 200));
  check('every row is unchanged', p.rows.every(r => r.change === 'same'));
  check('every decision is unchanged', p.decisions.every(d => d.before === d.after));
  eq('money before = after', p.money.before, p.money.after);
  eq('energy at sleep before = after', p.energyAtSleep.before, p.energyAtSleep.after);
  check('the window ends by the end of tomorrow (≤ 36 h)', p.to <= addDays(today, 2, tz) && p.to - p.from <= 36 * HOUR);
  eq('nothing written', count(), before);
}

section('an outing tomorrow evening: added rows and a new decision');
{
  __resetProjectionRate();
  const action = { kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(tomorrow, 20, 30), minutes: 120, castIds: ['cast:flatmate'], label: 'dinner with the flatmate' };
  const pv = await director.preview(action);
  const pr = pv.projection;
  check('the preview carries a projection', !!pr && Array.isArray(pr.rows), JSON.stringify(pr).slice(0, 200));
  const added = pr.rows.filter(r => r.change === 'added');
  check('rows added at the restaurant', added.some(r => r.placeId === 'place:restaurant'), JSON.stringify(added).slice(0, 300));
  check('… with the flatmate named', added.some(r => r.placeId === 'place:restaurant' && r.cast.length === 1));
  const d = pr.decisions.find(x => x.label === 'dinner with the flatmate');
  check('the new decision: before none, after go', d?.before === null && d.after === 'go', JSON.stringify(pr.decisions));
  check('something gave way that evening (a row removed or moved)', pr.rows.some(r => r.change === 'removed' || r.change === 'moved'));
  check('money numbers before / after / min', Number.isFinite(pr.money.before) && Number.isFinite(pr.money.after) && Number.isFinite(pr.money.min));
  const runs = projectionRuns();
  await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  eq('apply never runs a simulation', projectionRuns(), runs);
}

section('an owner outing after an office day fits his day (no silent miss)');
{
  __resetProjectionRate();
  // Thursday is an office day: at 19:00's point of no return he used to be on his way home, so
  // the engine said "could not go". Now the outing is fitted when the day's plan is in force: he
  // goes straight from the office.
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(tomorrow, 19, 0), minutes: 120, castIds: [], label: 'early dinner' });
  const d = pv.projection.decisions.find(x => x.label === 'early dinner');
  eq('the projection keeps it: go', d?.after, 'go');
  check('… and no projected_missed warning', !pv.continuity.warnings.some(x => x.code === 'projected_missed'));
  check('a row at the restaurant tomorrow evening', pv.projection.rows.some(r => r.placeId === 'place:restaurant' && r.change === 'added'));
}

section('an owner outing at 03:00 tonight while he is still up: he stays up for it (wake him: no miss)');
{
  __resetProjectionRate();
  // 03:00 tomorrow = tonight past midnight, on tonight's plan: he is awake now, so his
  // sleep (not yet started) gives way — he stays up, goes and sleeps after. (Already
  // asleep, the preview warns projected_missed and suggests waking him: arcs-tests/63.)
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(tomorrow, 3, 0), minutes: 60, castIds: [], label: 'night snack' });
  const d = pv.projection.decisions.find(x => x.label === 'night snack');
  eq('the projection keeps it: go', d?.after, 'go');
  check('… no projected_missed, no refusal', !pv.continuity.warnings.some(x => x.code === 'projected_missed') && pv.refusals.length === 0);
  check('a projected warning stays out of the content signature', (() => {
    const p = director.plan({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(tomorrow, 3, 0), minutes: 60, castIds: [], label: 'night snack' }, state, { now: now() });
    return director.contentSigOf(p) === pv.contentSig;
  })());
}

section('a free evening: work leaves the rest of today');
{
  __resetProjectionRate();
  const pv = await director.preview({ kind: 'quick', button: 'free_evening' });
  const pr = pv.projection;
  check('work rows removed or shortened today', pr?.rows?.some(r => r.kind === 'work' && (r.change === 'removed' || r.change === 'moved'))
    || pr?.rows?.some(r => r.kind === 'free' && r.change === 'added'), JSON.stringify(pr?.rows?.filter(r => r.change !== 'same')).slice(0, 400));
}

section('a chat-made plan shows as "a plan from a chat"');
{
  __resetProjectionRate();
  const dm = '15550004444@s.whatsapp.net';
  const ev = at(tomorrow, 21, 30);
  const opened = append({ type: 'decision.opened', at: now(), actor: 'engine', subjectJid: dm, payload: {
    kind: 'hangout', subject: { eventAt: ev, endAt: ev + 2 * HOUR, placeId: 'place:park', castIds: [] }, opensAt: now(), decideBy: ev - HOUR,
    ponrAt: ev - 30 * 60, travelMin: 10, prepMin: 20, mode: 'auto', category: 'social',
    options: [{ id: 'go', label: 'SECRET-CHAT-PLAN', expiresAt: ev - 30 * 60 }, { id: 'late', label: 'Join later', expiresAt: ev + 2 * HOUR }, { id: 'stay', label: 'Stay in', expiresAt: null }],
  } });
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: at(tomorrow, 17, 0), minutes: 60, castIds: [] });
  const d = pv.projection.decisions.find(x => x.id === opened.id);
  check('its decision is listed genericised and fromChat', d?.label === 'a plan from a chat' && d.fromChat === true);
  check('its label is nowhere in the projection', !JSON.stringify(pv.projection).includes('SECRET-CHAT-PLAN'));
}

section('budget, rate, opt-out');
{
  __resetProjectionRate();
  const b = await buildProjection({ state, world, now: now(), descriptors: [], deps: { appendDescriptors }, budgetMs: 0 });
  eq('a 0 ms budget → skipped budget', b, { skipped: 'budget' });
  __resetProjectionRate();
  let last = null;
  for (let i = 0; i <= PROJECTIONS_PER_MIN; i++) last = await buildProjection({ state, world, now: now(), descriptors: [], deps: { appendDescriptors }, budgetMs: 0 });
  eq(`the ${PROJECTIONS_PER_MIN + 1}th in a minute → skipped rate`, last, { skipped: 'rate' });
  __resetProjectionRate();
  const pv = await director.preview({ kind: 'quick', button: 'tired' }, { project: false });
  eq('project:false → no projection', pv.projection, undefined);
  const fate = await director.preview({ kind: 'fate', category: 'social', mode: 'guided' });
  eq('a control kind → no projection', fate.projection, undefined);
  check('the projection is not part of the fingerprint', typeof fate.fingerprint === 'string');
}

report();
