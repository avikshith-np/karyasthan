// 2026-11-01 live: a Director rewind at 16:36 cancelled that day's story.daily_done,
// and the daily cast pass did not run again until a restart at 17:22 (a morning
// rewind the next day re-ran it at once). After a rewind the daily item dates
// itself max(wake + 5 min, s.at) — it floats with the projection's clock — and
// the pulse offered story items only up to the grid point g. Events dated off
// the grid at the real time (phone checks, chat turns, the rewind itself) kept
// s.at past g at every tick, so the item was never due. Story items are now due
// up to max(g, s.at) (pulse.js).
// Example world, fake clock, no models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents, appendEvent } from '../../src/life/eventLog.js';
import { isExcludedId } from '../../src/life/projector.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { dateKey, resolveTimezone } from '../../src/life/clock.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
const tz = resolveTimezone(world.timezone);
await simulateHours(24 + 10.5);   // the second day, mid-afternoon (on the grid)
const S = () => life.getState();
const today = dateKey(clock.now(), tz);
const dones = () => listEvents({ types: ['story.daily_done'], limit: 200 }).filter(e => e.payload?.date === today && !isExcludedId(S(), e.id));

// A phone check dated at the real now, a few minutes after the grid point — the
// stand-in for what the live phone / chat paths append between ticks.
function offGridEvent() {
  const t = clock.now();
  appendEvent({ type: 'phone.check.started', at: t, actor: 'engine', payload: { until: t + 60, reason: 'scheduled', readOnly: false } });
  appendEvent({ type: 'phone.check.ended', at: t + 60, actor: 'engine', payload: {} });
  story.__rebuildForTest();
}

section('the pass ran this morning');
const first = dones();
eq('one daily pass for today', first.length, 1);

section('a rewind across it, mid-afternoon, off the grid');
clock.advance({ minutes: 6 });
const pv = await director.preview({ kind: 'rewind', toEventId: first[0].id - 1, reason: 'test' });
check('the rewind previews', !pv.refusals?.length, JSON.stringify(pv.refusals));
const applied = await director.apply(pv.previewId, pv.fingerprint);
const rewoundAt = clock.now();
eq('the pass is gone from his day', dones().length, 0);
check('the projection forgot it', S().story.daily.lastDate < today, S().story.daily);

section('the next ticks re-run it, though an off-grid event lands before each');
let ticks = 0;
for (let i = 0; i < 4 && !dones().length; i++) {
  clock.advance({ minutes: i ? 13 : 14 });
  offGridEvent();
  clock.advance({ minutes: 2 });
  check(`tick ${i + 1}: s.at is past the grid point (the live shape)`, S().at > Math.floor(clock.now() / 900) * 900);
  await life.tick();
  ticks++;
}
const again = dones();
eq('a new daily pass for today, exactly one', again.length, 1);
check('at the first tick after the rewind', ticks === 1, ticks);
check('dated after the rewind', again[0]?.at >= rewoundAt && again[0]?.id > (applied.eventIds?.at(-1) ?? 0), again[0]);
eq('the projection has it again', S().story.daily.lastDate, today);

section('and only once');
for (let i = 0; i < 3; i++) { clock.advance({ minutes: 13 }); offGridEvent(); clock.advance({ minutes: 2 }); await life.tick(); }
await simulateHours(2);
eq('still one pass for today', dones().length, 1);

report();
