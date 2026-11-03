// The first ticks after a boot (live bug, 2026-10-29): the pulse derived its
// resume point from the projection's time until it had stepped once, so a phone
// check dated off the grid — ending after the next grid point but before the
// tick — made every later tick skip, and the world stopped stepping.
// Scratch DB, fake clock, no Jev, no network.
import { setupScratchDb, fakeClock, fakeJev, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, eventsAfter } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters } from '../../src/life/decisions.js';
import { createPulse, genesis } from '../../src/life/pulse.js';

globalThis.fetch = async () => { throw new Error('network is off in life tests'); };

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const MIN = 60;
const T0 = local(27, 5);   // Tue 27 Oct 05:00, asleep

setRngSeed(7);
const jev = fakeJev(() => { throw new Error('no Jev in this test'); });
setJev(jev.fn);

await setupScratchDb();
resetDecisionCounters();
const clock = fakeClock(T0);
setClock(clock.fn);
let live = createInitialState(world);
const append = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
genesis(append, world, T0, {});
const boot = () => createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15 });

// The first process runs the morning normally.
let pulse = boot();
for (clock.set(T0); clock.now() < local(27, 10, 5); clock.advance({ minutes: 15 })) await pulse.tick();
const beforeRestart = live.lastEventId;

// A phone check dated off the grid (as phone.js does with the wall clock).
const phoneCheck = (at) => {
  append({ type: 'phone.check.started', at, actor: 'engine', payload: { until: at + 2 * MIN, reason: 'scheduled', readOnly: false } });
  append({ type: 'phone.check.ended', at: at + 2 * MIN, actor: 'engine', payload: { nextCheckAt: at + 10 * MIN, nextReason: 'gap:light', readOnly: false, drained: 0, expired: 0 } });
};

section('restart: a phone check after each grid point never stalls the pulse');
// As live: a phone check ends just before the restart, after the 10:00 grid
// point, so the boot catch-up has nothing to step (to === grid(s0.at)).
phoneCheck(local(27, 10, 7));
// Restart at 10:12 (ticks fire 12 min after their grid point, like setInterval from boot).
clock.set(local(27, 10, 12));
pulse = boot();
let ticks = 0;
pulse.onTick(() => { ticks++; });
await pulse.runTo(clock.now());            // boot catch-up
const stepsSeen = [];
for (let i = 0; i < 8; i++) {
  // Each window: a phone check that ends after the next grid point, before the tick.
  const g = local(27, 10, 15) + i * 15 * MIN;
  phoneCheck(g + 3 * MIN);
  clock.set(g + 12 * MIN);
  const info = await pulse.tick();
  stepsSeen.push(info?.steps ?? 0);
}
eq('every tick after the restart stepped once', stepsSeen, [1, 1, 1, 1, 1, 1, 1, 1]);
check('onTick subscribers ran on every tick', ticks >= 8, `ticks=${ticks}`);
const after = eventsAfter(beforeRestart, 5000).filter(e => e.type === 'activity.started');
check('blocks kept starting after the restart', after.length >= 1, `activity.started=${after.length}`);
check('no Jev calls', jev.calls.length === 0, `calls=${jev.calls.length}`);

report();
