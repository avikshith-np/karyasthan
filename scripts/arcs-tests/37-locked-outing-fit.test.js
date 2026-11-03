// Integration fix (014 + 015): an owner-committed outing must fit his day. Before
// the fix the pulse applied a committed outing only at its point of no return
// (pulse.amendPlanForOuting), and an office day put him at work or on the road
// home then — "could_not_go", a silent miss (the Director preview showed a
// committed "go"). Now a locked outing (owner pick, goal, chat-adopted) is fitted
// into the plan of its day as soon as that plan is in force: he leaves work in
// time, or goes straight from the office (pulse.fitLockedOuting). The lunch case:
// a scene during a WFH meeting gets a continuity warning with 014's plan edit as
// the suggestion ("take the afternoon off"), and applied as-is he still goes.
// Example world (office Tue–Thu, WFH Mon/Fri), fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone, weekday as weekdayOf } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';
import { isLockedOuting, outingInPlan, fitLockedOuting } from '../../src/life/pulse.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed, mid-morning: an office day
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, Math.ceil((t - clock.now()) / HOUR));
async function applyScene(action) {
  const p = await director.preview(action, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  return { p, r };
}
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
const expiredFor = (id) => listEvents({ types: ['decision.expired'], limit: 500 }).filter(e => e.payload?.decisionId === id);

section('an owner outing at 19:00 on an office day: he goes straight from the office');
{
  const today = dayStart(clock.now(), tz);
  eq('today is an office day', S().plan?.dayType, 'office');
  const office = S().self?.officePlaceId;
  check('he has an office', typeof office === 'string' && office.length > 0);
  const { p } = await applyScene({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(today, 19, 0), minutes: 120, castIds: [], label: 'dinner after work' });
  check('the preview keeps it (no projected_missed)', !(p.continuity?.warnings ?? []).some(w => w.code === 'projected_missed'),
    JSON.stringify({ w: p.continuity?.warnings, d: p.projection?.decisions, sk: p.projection?.skipped, now: clock.now() }));
  const d = decisionOf('dinner after work');
  check('the owner committed it (locked)', isLockedOuting(d), JSON.stringify(d?.committed));
  await simulateHours(1);
  check('…and it is in the plan in force at once (blocks carry its decision)', outingInPlan(S().plan, d));
  const there = S().plan.blocks.find(b => b.kind === 'commute' && b.to === 'place:restaurant');
  eq('the trip there starts at the office', there?.from, office);
  check('…after a work block cut short or ending as usual (no trip home first)',
    !S().plan.blocks.some(b => b.kind === 'commute' && b.to === S().self.homePlaceId && b.start < (there?.start ?? 0) && b.start > clock.now()));
  check('no planned late stint survives once he leaves work for it', !S().plan.workLate || S().plan.workLate.normalEnd <= (there?.start ?? 0));
  await simulateHours(hoursUntil(at(today, 21, 30)));
  const started = listEvents({ types: ['activity.started'], limit: 500 }).filter(e => e.payload?.placeId === 'place:restaurant' && e.at >= at(today, 17, 0));
  check('he was at the restaurant', started.length > 0, JSON.stringify(started.map(e => [e.at, e.payload.kind])));
  eq('no could_not_go', expiredFor(d.id).map(e => e.payload.reason), []);
  eq('the decision stays a go', S().decisions.get(d.id)?.status, 'committed');
}

section('fitLockedOuting: only locked outings');
{
  const s = S();
  check('a non-locked decision is never fitted early', fitLockedOuting(s, { id: 1, status: 'committed', committed: { optionId: 'go', by: 'lean' }, options: [] }, clock.now(), world) === null);
}

section('the lunch case: a scene during a WFH meeting');
{
  // Friday is a WFH day: run from Wednesday night to Friday morning.
  await simulateHours(hoursUntil(at(addDays(dayStart(clock.now(), tz), 2, tz), 8, 30)));
  const today = dayStart(clock.now(), tz);
  eq('it is Friday', weekdayOf(clock.now(), tz), 5);
  eq('today is a WFH day', S().plan?.dayType, 'wfh');
  const meeting = S().plan.blocks.find(b => b.kind === 'meeting' && b.start > clock.now() + 45 * 60);
  check('a meeting later today', !!meeting, JSON.stringify({ now: clock.now(), blocks: S().plan.blocks.map(b => [b.kind, b.start]) }));
  if (meeting) {
    const action = { kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: meeting.start + 10 * 60, minutes: 60, castIds: [], label: 'lunch at noon' };
    const p = await director.preview(action, { relax: true });
    const w = (p.continuity?.warnings ?? []).find(x => x.code === 'he_at_work');
    check('a continuity warning: he is working then', w?.severity === 'warn', JSON.stringify(p.continuity?.warnings));
    const sg = (p.continuity?.suggestions ?? []).find(x => x.action?.kind === 'schedule' && x.action.background?.activity === 'off');
    check('…with 014\'s plan edit as the suggestion', !!sg, JSON.stringify(p.continuity?.suggestions));
    if (meeting.start + 10 * 60 >= at(today, 12, 0)) eq('…"take the afternoon off"', sg?.why, 'take the afternoon off');
    check('…which plans (a schedule override)', (() => {
      try { return director.plan(sg.action, S(), { now: clock.now() }).events.some(e => e.type === 'schedule.override_set'); } catch { return false; }
    })());
    // Applied as-is (warnings never block): he leaves the meeting and goes.
    await director.apply(p.previewId, p.fingerprint);
    const d = decisionOf('lunch at noon');
    await simulateHours(hoursUntil(action.startAt + 2 * HOUR));
    const started = listEvents({ types: ['activity.started'], limit: 500 }).filter(e => e.payload?.placeId === 'place:restaurant' && e.at >= action.startAt - HOUR);
    check('he went (an activity at the venue)', started.length > 0);
    eq('no could_not_go', expiredFor(d?.id).map(e => e.payload.reason), []);
  }
}

await stopLife();
report();
