// Integration review fixes (014 + 015): how changes fit his day.
//   daytime    a locked outing in the middle of a work day brings him back to
//              work afterwards (the afternoon's work and meetings stay; lunch it
//              took comes after his return), never home to free time
//   departure  a locked evening outing on a day off: he leaves the stay he is at
//              just in time even when the trip then is longer (rush hour), and
//              the outing starts at its own time — not hours early
//   meals      a schedule range starting just after dinner began moves dinner
//              whole: one dinner, one meal event (no stub AND a moved meal)
//   home move  routine leisure at the former home (TV) happens at the new one:
//              he never travels back to the old flat
// Example world (office Tue–Thu, WFH Mon/Fri), fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed (office day), late morning
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const MIN = 60;
const dayAt = (n, h, m = 0) => {
  const [y, mo, d] = dateKey(addDays(dayStart(clock.now(), tz), n, tz) + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, Math.ceil((t - clock.now()) / HOUR));
async function apply(action) {
  const p = await director.preview(action, { relax: true });
  return { p, r: await director.apply(p.previewId, p.fingerprint) };
}
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);

section('a lunch-hour outing on an office day: back to work after it');
{
  eq('today is an office day', S().plan?.dayType, 'office');
  const office = S().self?.officePlaceId;
  const startAt = dayAt(0, 13, 0);
  await apply({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt, minutes: 45, castIds: [], label: 'lunch-hour outing' });
  await simulateHours(0.25);
  const d = decisionOf('lunch-hour outing');
  const blocks = S().plan.blocks;
  check('the outing is in the plan', blocks.some(b => b.decisionId === d.id && b.kind !== 'commute'));
  const back = blocks.find(b => b.kind === 'commute' && b.decisionId === d.id && b.from === 'place:restaurant');
  eq('the trip after it goes back to the office', back?.to, office);
  check('work at the office later in the afternoon', blocks.some(b => b.kind === 'work' && b.placeId === office && b.start >= startAt + 45 * MIN),
    JSON.stringify(blocks.map(b => [b.kind, b.placeId, b.start])));
  check('the afternoon meetings stay', blocks.some(b => b.kind === 'meeting' && b.start >= startAt + 60 * MIN));
  check('no free time at home in the afternoon', !blocks.some(b => b.kind === 'free' && b.placeId === S().self.homePlaceId && b.start < dayAt(0, 17, 0) && b.start > startAt));
  await simulateHours(hoursUntil(dayAt(0, 15, 30)));
  eq('mid-afternoon he is at the office', S().position?.placeId, office);
}

section('a range starting just after dinner began: one dinner');
{
  const dinner = S().plan.blocks.find(b => b.kind === 'dinner');
  check('a dinner tonight', !!dinner);
  const hm = (t) => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  await apply({ kind: 'schedule', day: 0, ranges: [{ activity: 'gym', from: hm(dinner.start + 15 * MIN), to: hm(dinner.start + 60 * MIN) }] });
  const dinners = S().plan.blocks.filter(b => b.kind === 'dinner');
  eq('one dinner block in the edited plan', dinners.length, 1);
  check('…a whole one (not a stub)', dinners[0] && dinners[0].end - dinners[0].start >= 30 * MIN, JSON.stringify(dinners));
  const from = dayAt(0, 17, 0);
  const to = dayAt(1, 2, 0);
  await simulateHours(hoursUntil(to));
  const meals = listEvents({ types: ['meal'], limit: 2000 }).filter(e => e.payload?.kind === 'dinner' && e.at >= from && e.at < to);
  check('one dinner meal event that evening', meals.length === 1, JSON.stringify(meals.map(e => [e.at, e.payload])));
}

section('an evening outing on a day off: he leaves just in time');
{
  await apply({ kind: 'schedule', day: 1, background: { activity: 'off', wholeDay: true } });
  const eventAt = dayAt(1, 19, 0);
  const later = dayAt(1, 20, 0);
  await apply({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: eventAt, minutes: 90, castIds: [], label: 'day-off dinner' });
  await simulateHours(hoursUntil(dayAt(1, 11, 0)));
  const d = decisionOf('day-off dinner');
  const blocks = S().plan.blocks;
  eq('tomorrow is off', S().plan.dayType, 'off');
  const there = blocks.find(b => b.kind === 'commute' && b.decisionId === d.id && b.to === 'place:restaurant');
  const outing = blocks.find(b => b.decisionId === d.id && b.kind === d.kind);
  check('he leaves less than an hour before it', there && there.start >= eventAt - 60 * MIN && there.start < eventAt,
    JSON.stringify(blocks.map(b => [b.kind, b.placeId ?? b.to, b.start])));
  eq('the outing itself starts at its time', outing?.start, eventAt);
  await simulateHours(hoursUntil(later));
  const went = listEvents({ types: ['activity.started'], limit: 2000 }).filter(e => e.payload?.placeId === 'place:restaurant' && e.at >= eventAt - 2 * HOUR && e.at <= eventAt);
  check('he was there for it', went.some(e => e.at === eventAt), JSON.stringify(went.map(e => [e.at - eventAt, e.payload.kind])));
}

section('a home move: leisure at the old home happens at the new one');
{
  const oldHome = S().self.homePlaceId;
  const { r } = await apply({ kind: 'home', near: 'place:cafe', flatmate: 'comes' });
  const after = r.eventIds.at(-1);
  await simulateHours(24 * 4);
  check('he moved', S().self.homePlaceId !== oldHome);
  const atOld = listEvents({ types: ['activity.started', 'travel.started'], limit: 5000 })
    .filter(e => e.id > after && (e.payload?.placeId === oldHome || e.payload?.to === oldHome));
  eq('he never goes back to the old flat', atOld.map(e => [e.type, e.payload?.kind ?? null]), []);
  check('TV happens at the new home', listEvents({ types: ['activity.started'], limit: 5000 }).some(e => e.id > after && e.payload?.kind === 'tv' && e.payload?.placeId === S().self.homePlaceId)
    || !listEvents({ types: ['activity.started'], limit: 5000 }).some(e => e.id > after && e.payload?.kind === 'tv'));
}

await stopLife();
report();
