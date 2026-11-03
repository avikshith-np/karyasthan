// Locked meal outings (2026-10-31 owner-pinned gap): an owner / goal / adopted
// outing that is a meal stands in for that meal. Live: breakfast at home at 09:42
// before the owner's 10:30 café breakfast; dinner at home at 23:48 after the pizza
// dinner out. Now pulse.mealOfOuting (a meal word in the owner's label, a meal
// kind, else an eating kind / a cafe or restaurant inside the meal's window) →
// the fit drops that meal at home (before he leaves, or later in the base day)
// and the outing block carries `meal`, so its start appends a `meal` of that kind
// (hunger, Life · Day). Non-locked outings are untouched (mealOfOuting → null).
// Example world (weekend wake 09:00, breakfast 08:00, lunch 13:00, dinner 20:30),
// fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from '../arcs-tests/_helpers.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone, weekday as weekdayOf } from '../../src/life/clock.js';
import { mealOfOuting, isLockedOuting } from '../../src/life/pulse.js';
import * as director from '../../src/life/story/director.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
// Scenes off: a scene job finishing in the background between a preview and its apply would make it stale.
config.arcs.scenesEnabled = false;
const { world, clock, life } = await bootLife();
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, (t - clock.now()) / HOUR);
const hm = (t) => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const home = () => S().self.homePlaceId;
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
const meals = (from, to) => listEvents({ types: ['meal'], from, to, limit: 500 }).map(e => {
  const c = e.causeId ? getEvent(e.causeId) : null;
  return { id: e.id, at: e.at, kind: e.payload?.kind, placeId: c?.type === 'activity.started' ? c.payload?.placeId : null, causeKind: c?.payload?.kind ?? null };
});
const contiguous = (blocks) => blocks.every((b, i) => i === 0 || blocks[i - 1].end === b.start);
async function scene(action) {
  const p = await director.preview({ kind: 'scene', shape: 'outing', ...action }, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  check(`applied: ${action.label}`, r?.ok === true, JSON.stringify(r));
  return decisionOf(action.label);
}

section('units: which meal a locked outing is');
{
  const places = new Map([['place:cafe', { kind: 'cafe' }], ['place:restaurant', { kind: 'restaurant' }], ['place:park', { kind: 'park' }]]);
  const st = { places, world: { timezone: world.timezone } };
  const day = dayStart(Date.UTC(2026, 10, 7, 12) / 1000, tz);
  const d = (kind, placeId, h, m, label, committed = { optionId: 'go', by: 'owner' }) => ({
    id: 9, status: 'committed', kind, committed, subject: { placeId, eventAt: at(day, h, m) },
    options: [{ id: 'go', label }, { id: 'late', label: 'Join later' }, { id: 'stay', label: 'Stay in' }],
  });
  const m = (x) => mealOfOuting(st, x, world);
  eq('"breakfast at the cafe" at 10:30', m(d('hangout', 'place:cafe', 10, 30, 'breakfast at the cafe')), 'breakfast');
  eq('a brunch is breakfast', m(d('hangout', 'place:park', 11, 0, 'Brunch picnic')), 'breakfast');
  eq('the label wins over the clock ("dinner" at 17:00)', m(d('outing', 'place:park', 17, 0, 'early dinner')), 'dinner');
  eq('a cafe at 10:30, no meal word → breakfast (its window)', m(d('hangout', 'place:cafe', 10, 30, 'catch up')), 'breakfast');
  eq('a restaurant at 12:30 → lunch', m(d('outing', 'place:restaurant', 12, 30, 'see Sam')), 'lunch');
  eq('a restaurant at 21:00 → dinner', m(d('hangout', 'place:restaurant', 21, 0, 'pizza with Sam')), 'dinner');
  eq('a cafe at 16:00 is no meal', m(d('hangout', 'place:cafe', 16, 0, 'coffee catch-up')), null);
  eq('a walk in the park at 13:00 is no meal', m(d('outing', 'place:park', 13, 0, 'a walk')), null);
  eq('a meal kind', m(d('lunch', 'place:park', 15, 30, 'x')), 'lunch');
  eq('drinks at a bar-like kind: no meal', m(d('drinks', 'place:park', 21, 0, 'drinks')), null);
  check('a goal / adopted outing is locked too', isLockedOuting(d('hangout', 'place:cafe', 10, 30, 'x', { optionId: 'go', by: 'goal' })));
  eq('not locked (a lean / reply commit) → never a meal', m(d('eat-out', 'place:restaurant', 20, 30, 'dinner out', { optionId: 'go', by: 'lean' })), null);
  eq('not a go → never a meal', m(d('hangout', 'place:cafe', 10, 30, 'breakfast', { optionId: 'late', by: 'owner' })), null);
}

// Tue 27 Oct 06:00 → Sat 31 Oct 07:00 (asleep; weekend wake 09:00).
await simulateHours(4 * 24 + 1);
const sat = dayStart(clock.now(), tz);
eq('it is Saturday', weekdayOf(clock.now(), tz), 6);

section('the 10:30 café breakfast: no breakfast at home first');
{
  const d = await scene({ placeId: 'place:cafe', startAt: at(sat, 10, 30), minutes: 60, castIds: ['cast:flatmate'], label: 'breakfast at the cafe' });
  check('a locked outing', isLockedOuting(d));
  await simulateHours(hoursUntil(at(sat, 10, 0)));
  const plan = S().plan;
  const wake = plan.wakeAt;
  check('the day is planned and the outing fitted', plan.blocks.some(b => b.decisionId === d.id && b.kind === 'hangout'),
    JSON.stringify(plan.blocks.map(b => [b.kind, hm(b.start), b.placeId])));
  eq('no breakfast block in his day', plan.blocks.filter(b => b.kind === 'breakfast').map(b => hm(b.start)), []);
  check('…the blocks still run back to back', contiguous(plan.blocks));
  const cafe = plan.blocks.find(b => b.decisionId === d.id && b.kind === 'hangout');
  eq('the café block stands in for breakfast', cafe?.meal, 'breakfast');
  await simulateHours(hoursUntil(at(sat, 12, 0)));
  const ms = meals(wake, at(sat, 12, 0));
  eq('one breakfast this morning, at the café (caused by its start)', ms.filter(x => x.kind === 'breakfast').map(x => [x.placeId, x.causeKind, hm(x.at)]),
    [['place:cafe', 'hangout', '10:30']]);
  eq('no meal at home before he left', ms.filter(x => x.placeId === home() && x.at < at(sat, 10, 30)).map(x => [x.kind, hm(x.at)]), []);
  check('hunger reads fed after it', S().lastMeal?.kind === 'breakfast' || ms.some(x => x.kind === 'breakfast'));
}

section('the late pizza dinner: no dinner at home afterwards');
{
  const d = await scene({ placeId: 'place:restaurant', startAt: at(sat, 19, 30), minutes: 150, castIds: ['cast:flatmate'], label: 'pizza dinner' });
  await simulateHours(0.25);
  const plan = S().plan;
  const out = plan.blocks.find(b => b.decisionId === d.id && b.kind === 'hangout');
  check('fitted', !!out, JSON.stringify(plan.blocks.map(b => [b.kind, hm(b.start), b.placeId])));
  eq('…standing in for dinner', out?.meal, 'dinner');
  eq('no dinner block anywhere in his day', plan.blocks.filter(b => b.kind === 'dinner').map(b => hm(b.start)), []);
  check('…the blocks still run back to back', contiguous(plan.blocks));
  await simulateHours(hoursUntil(at(sat, 23, 59)));
  const ms = meals(at(sat, 17, 0), at(sat, 23, 59));
  eq('one dinner tonight, at the restaurant', ms.filter(x => x.kind === 'dinner').map(x => [x.placeId, hm(x.at)]), [['place:restaurant', '19:30']]);
  eq('no meal at home after it', ms.filter(x => x.placeId === home() && x.at > at(sat, 22, 0)).map(x => [x.kind, hm(x.at)]), []);
}

section('a lunch out on a work-from-home day: no second lunch at home on his return');
{
  // Sat night → Mon 2 Nov 08:00 (a WFH day: work before and after).
  await simulateHours(hoursUntil(at(sat, 8, 0) + 2 * 86400));
  const mon = dayStart(clock.now(), tz);
  eq('it is Monday, a WFH day', [weekdayOf(clock.now(), tz), S().plan?.dayType], [1, 'wfh']);
  const d = await scene({ placeId: 'place:restaurant', startAt: at(mon, 12, 15), minutes: 60, castIds: ['cast:coworker-a'], label: 'lunch with a coworker' });
  await simulateHours(0.25);
  const plan = S().plan;
  const out = plan.blocks.find(b => b.decisionId === d.id && b.kind === 'hangout');
  check('fitted, back to work after', !!out && plan.blocks.some(b => b.kind === 'work' && b.start >= out.end),
    JSON.stringify(plan.blocks.map(b => [b.kind, hm(b.start), b.placeId])));
  eq('…standing in for lunch', out?.meal, 'lunch');
  eq('no lunch block left in his day', plan.blocks.filter(b => b.kind === 'lunch').map(b => [hm(b.start), b.placeId]), []);
  check('…the blocks still run back to back', contiguous(plan.blocks));
  await simulateHours(hoursUntil(at(mon, 15, 0)));
  const ms = meals(at(mon, 11, 0), at(mon, 15, 0));
  eq('one lunch, at the restaurant', ms.filter(x => x.kind === 'lunch').map(x => [x.placeId, hm(x.at)]), [['place:restaurant', '12:15']]);
}

await stopLife();
report();
