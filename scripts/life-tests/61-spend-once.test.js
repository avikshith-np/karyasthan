// 018 (2026-11-01 live): an outing is paid for once. The owner's café date
// started at 15:00 (activity.started → money.spent); a rewind at 16:36 undid
// something in the middle, the rewind's world.reanchored left him idle, and the
// pulse started the same plan block again → a second money.spent for the same
// date. Now a resumed outing (an earlier start of the same block — same kind,
// place and company, overlapping window — and its spend both still in the
// projection) is not charged again; once the earlier start and its spend are
// rewound away, the resume pays as before. Also: an afternoon café hangout is no
// meal (his dinner at home stays). Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from '../arcs-tests/_helpers.js';
import { listEvents, getEvent } from '../../src/life/eventLog.js';
import { activitySpend } from '../../src/life/spending.js';
import { isExcludedId } from '../../src/life/projector.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone, weekday as weekdayOf } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, (t - clock.now()) / HOUR);   // 15-min steps
const live = (e) => !isExcludedId(S(), e.id);
const startsAt = (placeId, from) => listEvents({ types: ['activity.started'], from, limit: 2000 }).filter(e => e.payload?.placeId === placeId);
const spendsOf = (ids) => listEvents({ types: ['money.spent'], limit: 5000 }).filter(e => ids.includes(e.causeId));

// Tue 27 Oct 06:00 → Sun 1 Nov 08:00 (a weekend day, no work).
await simulateHours(5 * 24 + 2);
const today = dayStart(clock.now(), tz);
eq('it is Sunday', weekdayOf(clock.now(), tz), 0);

const startAt = at(today, 15, 0);
{
  const p = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes: 120, castIds: ['cast:flatmate'], label: 'coffee catch-up' }, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  check('the café date is applied', r?.ok === true, JSON.stringify(r));
}

section('the date starts and is paid for once');
await simulateHours(hoursUntil(startAt + 15 * 60));
const first = startsAt('place:cafe', startAt - HOUR).filter(e => e.payload.kind === 'hangout');
eq('one start at the café', first.length, 1);
const firstSpend = spendsOf(first.map(e => e.id));
eq('…one spend caused by it', firstSpend.length, 1);
check('…for the outing', ['outing', 'food'].includes(firstSpend[0]?.payload?.for), JSON.stringify(firstSpend[0]?.payload));
{
  const dinner = S().plan.blocks.find(b => b.kind === 'dinner' && b.start > clock.now());
  check('a café at 15:00 is no meal: his dinner at home is still planned', !!dinner && dinner.placeId === S().self.homePlaceId,
    JSON.stringify(S().plan.blocks.map(b => [b.kind, b.placeId, b.start])));
  const cafe = S().plan.blocks.find(b => b.placeId === 'place:cafe' && b.kind === 'hangout');
  eq('…and the café block carries no meal', cafe?.meal, undefined);
}

section('a walkout mid-date, then a rewind into the middle: he resumes it, not paid again');
await simulateHours(hoursUntil(startAt + 60 * 60));   // 16:00
{
  // The walkout: the owner calls the date off while he is there (fell through → he heads home).
  const d = [...S().decisions.values()].find(x => x.options?.find(o => o.id === 'go')?.label === 'coffee catch-up');
  const p = await director.preview({ kind: 'outcome', decisionId: d?.id, outcome: 'cancelled' }, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  check('the walkout is applied', r?.ok === true, JSON.stringify(r));
}
await simulateHours(hoursUntil(startAt + 90 * 60));   // 16:30
{
  check('he left the café', S().activity?.placeId !== 'place:cafe' || S().activity?.kind !== 'hangout', JSON.stringify(S().activity));
  const p = await director.preview({ kind: 'rewind', at: startAt + 10 * 60, reason: 'undo the walkout' });
  const r = await director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('the rewind is applied', r?.ok === true, JSON.stringify(r));
  check('…the first start and its spend are still in the projection', live(first[0]) && live(firstSpend[0]));
  await simulateHours(0.25);
  const all = startsAt('place:cafe', startAt - HOUR).filter(e => e.payload.kind === 'hangout');
  const resumed = all.filter(e => e.id > first[0].id && live(e));
  eq('he started the same date again (the live shape)', resumed.length, 1);
  eq('…no spend caused by the resume', spendsOf(resumed.map(e => e.id)).length, 0);
  const liveSpends = spendsOf(all.map(e => e.id)).filter(live);
  eq('…one live spend for the date in all', liveSpends.length, 1);
  eq('…the first one', liveSpends[0]?.id, firstSpend[0]?.id);
}

section('rewound to before the date began: the earlier start and spend are gone → the resume pays');
{
  check('still inside the date\'s block', clock.now() < startAt + 120 * 60);
  const p = await director.preview({ kind: 'rewind', at: startAt - 60, reason: 'from the start' });
  const r = await director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('the rewind is applied', r?.ok === true, JSON.stringify(r));
  check('…the first start and its spend are out of the projection', !live(first[0]) && !live(firstSpend[0]));
  await simulateHours(0.25);
  const all = startsAt('place:cafe', startAt - HOUR).filter(e => e.payload.kind === 'hangout');
  const now = all.filter(live);
  eq('one live start of the date', now.length, 1);
  check('…a new one (the earlier two are rewound away)', now[0]?.id > first[0].id && all.length === 3, JSON.stringify(all.map(e => [e.id, live(e)])));
  const sp = spendsOf(now.map(e => e.id));
  eq('…and it is paid for: one live spend for the date', [sp.length, spendsOf(all.map(e => e.id)).filter(live).length], [1, 1]);
  eq('…caused by that start', getEvent(sp[0]?.id)?.causeId, now[0]?.id);
}

await stopLife();
section('a plan re-made for one outing does not price another block with it');
{
  const places = new Map([['place:pub', { id: 'place:pub', kind: 'bar' }], ['place:cafe', { id: 'place:cafe', kind: 'cafe' }]]);
  const state = {
    self: { homePlaceId: 'place:home' }, plan: { amendedFor: 5 },
    decisions: new Map([[5, { id: 5, status: 'committed', committed: { optionId: 'go' }, subject: { placeId: 'place:cafe' },
      options: [{ id: 'go', spend: 990 }] }]]),
  };
  const ev = (placeId) => ({ payload: { kind: 'drinks-with-friends', placeId, withCast: [] } });
  const other = activitySpend({ state, block: { placeId: 'place:pub' }, ev: ev('place:pub'), places, world: { money: { monthlyBaseline: 60000 } }, date: '2026-11-01' });
  check('a routine block elsewhere is not priced as the outing', other?.amount !== 990 && !other?.decisionId, other);
  const same = activitySpend({ state, block: { placeId: 'place:cafe' }, ev: ev('place:cafe'), places, world: { money: { monthlyBaseline: 60000 } }, date: '2026-11-01' });
  eq('its own block still is', same?.amount, 990);
}

report();
