// Integration review fixes (015): reverts, simulations and planned illness.
//   revert   reverting an owner outing's decision.opened takes its owner commit
//            and the fitted plan with it (cascadeIds follows an owner commit of
//            a decision.opened): he works on and commutes home, no teleport
//   sim      a scheduled god change re-plans on the state AFTER its
//            change.applied in a simulation too (a fire → an 'off' day)
//   sick     a spell planned while he is already sick waits and starts when he
//            recovers — never stuck pending, and a restart changes nothing
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents, getEvent, cascadeIds } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(30);              // Wed (office day), mid-morning
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const dayAt = (n, h, m = 0) => {
  const [y, mo, d] = dateKey(addDays(dayStart(clock.now(), tz), n, tz) + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const dateOf = (n) => dateKey(addDays(dayStart(clock.now(), tz), n, tz) + 12 * HOUR, tz);
async function apply(action) {
  const p = await director.preview(action, { relax: true });
  return director.apply(p.previewId, p.fingerprint);
}

section('revert of an owner outing\'s decision.opened: the fitted plan goes too');
{
  const r = await apply({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: dayAt(0, 19, 0), minutes: 90, castIds: [], label: 'reverted dinner' });
  await simulateHours(1);
  const opened = r.eventIds.map(getEvent).find(e => e.type === 'decision.opened');
  const commit = r.eventIds.map(getEvent).find(e => e.type === 'decision.committed');
  check('the outing was fitted into today\'s plan', S().plan.blocks.some(b => b.decisionId === opened.id));
  const fit = listEvents({ types: ['plan.made'], limit: 500 }).find(e => e.causeId === commit.id);
  check('the fit is a plan.made caused by the owner commit', !!fit);
  const cascade = cascadeIds(opened.id);
  check('cascadeIds(decision.opened) includes the owner commit and the fitted plan', cascade.includes(commit.id) && cascade.includes(fit.id), JSON.stringify(cascade));
  life.revertEvent(opened.id, { reason: 'test' });
  check('the plan in force is no longer the fitted one', S().plan.eventId !== fit.id && !S().plan.blocks.some(b => b.decisionId === opened.id));
  await simulateHours(Math.ceil((dayAt(0, 21, 0) - clock.now()) / HOUR));
  const trips = listEvents({ types: ['travel.started'], limit: 2000 }).filter(e => e.at > dayAt(0, 16, 0) && e.at < dayAt(0, 21, 0));
  check('he commutes home from the office', trips.some(e => e.payload.to === S().self.homePlaceId), JSON.stringify(trips.map(e => [e.payload.from, e.payload.to])));
  check('…and never to the restaurant', !trips.some(e => e.payload.to === 'place:restaurant'));
}

section('a scheduled fire re-plans an off day in a simulation too');
{
  await apply({ kind: 'career', change: 'fire', when: { date: dateOf(1), time: '08:00' } });
  await life.tick();
  const run = await story.simulate({ now: clock.now(), hours: 30 });
  const applied = run.events.find(e => e.type === 'change.applied');
  check('the sim fires it', !!applied);
  const replan = applied && run.events.find(e => e.type === 'plan.made' && e.causeId === applied.id);
  eq('the sim\'s re-plan after it is an off day', replan?.payload?.dayType, 'off');
}

section('a spell planned while he is sick waits for him to recover');
{
  await apply({ kind: 'health', change: 'sick', days: 2 });
  const planned = await apply({ kind: 'health', change: 'sick', days: 1, when: { date: dateOf(1), time: '10:00' } });
  const sp = planned.eventIds.map(getEvent).find(e => e.type === 'sick.planned');
  check('the second spell is pending', !!S().story?.pending?.[sp.id]);
  await simulateHours(Math.ceil((dayAt(1, 14, 0) - clock.now()) / HOUR));
  check('still sick on its day: it stays pending, nothing started', !!S().story?.pending?.[sp.id]
    && !listEvents({ types: ['sick.started'], limit: 200 }).some(e => e.causeId === sp.id));
  await simulateHours(3 * 24);
  const started = listEvents({ types: ['sick.started'], limit: 200 }).filter(e => e.causeId === sp.id);
  eq('it started once, after he recovered', started.length, 1);
  const recovered = listEvents({ types: ['sick.ended'], limit: 200 }).find(e => started[0] && e.at <= started[0].at);
  check('…at (or right after) his recovery', !!recovered && started[0].at - recovered.at <= HOUR, JSON.stringify({ rec: recovered?.at, start: started[0]?.at }));
  check('it is no longer pending', !S().story?.pending?.[sp.id]);
  const before = listEvents({ types: ['sick.started'], limit: 200 }).length;
  await stopLife();
  const again = await bootLife({ clock });
  await again.life.tick();
  await simulateHours(2);
  eq('a restart starts no second spell', listEvents({ types: ['sick.started'], limit: 200 }).length, before);
}

await stopLife();
report();
