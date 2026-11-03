// 011 Phase 2 — owner weather windows (plan §P2.1, review R14/R15/R17/R20/R28):
// weather.js:weatherFor precedence (window > projected weather > climatology,
// the newest window wins, only a newer owner quick RAIN outranks a window), no
// windows ≡ the pre-011 lookups, the sky × intensity mapping, forecast split at
// window edges with the `owner` flag, the projector fold (bounded, re-validated,
// present-only keys), the pulse emitting at a window's `from` mid-block and at
// its `to` (cause = the window), a revert cascading, a rewind excluding it, two
// folds of one log being identical, planDay reading a window, and the 011
// eventLog rules (owner-only types, cause types, chat-forbidden goal.*).
// Scratch DB, fake clock, no network.
import { setupScratchDb, fakeClock, section, check, eq, throws, report } from './_helpers.js';
import { setClock, zonedToUnix, dayStart, addDays } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import {
  appendEvent, eventsAfter, revertEvent, cascadeIds, OWNER_ONLY_TYPES, CHAT_FORBIDDEN_TYPES, STEER_EVENT_TYPES,
} from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild, project, serializeState } from '../../src/life/projector.js';
import { createPulse, genesis } from '../../src/life/pulse.js';
import { planDay } from '../../src/life/routine.js';
import {
  weatherAt, weatherFor, windowAt, windowOutcome, forecast, nextWeatherChangeAt, weatherPhrase, climateFor, BLOCK_HOURS,
} from '../../src/life/weather.js';

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };
// Leans fall back to code here, as on a machine with no Jev key: with the real
// askJev and a key in .env each lean tried the (stubbed) network first.
(await import('../../src/life/decisions.js')).setJev(async () => { throw new Error('no Jev in this test'); });

setRngSeed(20261029);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const H = 3600;

// The pre-011 lookups, verbatim (routine.planDay's default and pulse.amendPlanForOuting's).
const oldRoutineLookup = (state, at) => {
  const w = state?.weather;
  if (w && Number.isFinite(w.until) && at < w.until && (!Number.isFinite(w.from) || at >= w.from)) return w;
  return weatherAt(at, world);
};

section('weatherFor: no windows ≡ the pre-011 lookups (30 days of blocks)');
{
  let same = 0;
  let total = 0;
  const quickRain = { rain: true, condition: 'rain', tempC: 24, from: local(7, 6, 10, 30), until: local(7, 6, 13, 30), eventId: 9, by: 'owner' };
  for (let d = 0; d < 30; d++) {
    for (let b = 0; b < 8; b++) {
      const at = local(7, 1, 0) + d * 86400 + b * BLOCK_HOURS * H + 600;
      for (const state of [null, { weather: null }, { weather: quickRain }, { weather: { ...quickRain, by: undefined } }, { weatherWindows: [] }]) {
        total++;
        if (JSON.stringify(weatherFor(state, at, world)) === JSON.stringify(oldRoutineLookup(state, at))) same++;
      }
    }
  }
  eq('every block, every state shape: byte-identical', same, total);
}

section('weatherFor precedence (R17)');
{
  const at = local(7, 6, 14);
  const win = { id: 50, from: local(7, 6, 13), to: local(7, 6, 17), sky: 'storm', intensity: 0.9 };
  const older = { id: 40, from: local(7, 6, 12), to: local(7, 6, 18), sky: 'clear', intensity: 0.5 };
  const engineNewer = { rain: false, condition: 'clear', tempC: 30, from: local(7, 6, 12), until: local(7, 6, 15), eventId: 60 };
  eq('a window beats climatology', weatherFor({ weatherWindows: [win] }, at, world).condition, 'storm');
  eq('… and carries its id', weatherFor({ weatherWindows: [win] }, at, world).windowId, 50);
  eq('the newest window wins on overlap', weatherFor({ weatherWindows: [win, older] }, at, world).windowId, 50);
  eq('engine weather never outranks a window, even with a newer id', weatherFor({ weatherWindows: [win], weather: engineNewer }, at, world).condition, 'storm');
  const rainNewer = { rain: true, condition: 'rain', tempC: 22, from: local(7, 6, 13, 30), until: local(7, 6, 16, 30), eventId: 70, by: 'owner' };
  eq('a quick RAIN newer than the window wins', weatherFor({ weatherWindows: [win], weather: rainNewer }, at, world).condition, 'rain');
  eq('a quick RAIN older than the window loses', weatherFor({ weatherWindows: [win], weather: { ...rainNewer, eventId: 30 } }, at, world).condition, 'storm');
  eq('outside the window: the projected weather', weatherFor({ weatherWindows: [win], weather: engineNewer }, local(7, 6, 12, 30), world).condition, 'clear');
  const outside = local(7, 6, 18, 30);
  eq('outside every window: climatology', weatherFor({ weatherWindows: [win] }, outside, world), weatherAt(outside, world));
  // R28: a window's own emission stops counting once the window doesn't cover `at`.
  const emission = { ...windowOutcome(win, at, world), eventId: 61 };
  const ended = { weatherWindows: [{ ...win, to: local(7, 6, 14) }], weather: emission };
  eq('an ended window\'s emission no longer counts', weatherFor(ended, local(7, 6, 14, 10), world), weatherAt(local(7, 6, 14, 10), world));
  eq('windowAt: [from, to)', [windowAt([win], win.from)?.id ?? null, windowAt([win], win.to)?.id ?? null], [50, null]);
}

section('sky × intensity mapping, temperatures');
{
  const at = local(7, 6, 15);
  const base = weatherAt(at, world);
  const [lo, hi] = climateFor(world, base.month).tempRange;
  const mk = (sky, intensity) => windowOutcome({ id: 1, from: at - H, to: at + H, sky, intensity }, at, world);
  eq('rain < 0.5 → light rain', [mk('rain', 0.2).condition, mk('rain', 0.2).intensity, mk('rain', 0.2).rain], ['light_rain', 'light', true]);
  eq('rain ≥ 0.5 → heavy rain', [mk('rain', 0.8).condition, mk('rain', 0.8).intensity], ['heavy_rain', 'heavy']);
  eq('storm → storm, heavy', [mk('storm', 0.1).condition, mk('storm', 0.1).intensity, mk('storm', 0.1).rain], ['storm', 'heavy', true]);
  eq('heat → hot, dry', [mk('heat', 0.5).condition, mk('heat', 0.5).rain], ['hot', false]);
  check('heat is above the month max', mk('heat', 0).tempC > hi && mk('heat', 1).tempC >= mk('heat', 0).tempC);
  eq('clear / cloudy are dry', [mk('clear', 0.5).condition, mk('cloudy', 0.5).condition, mk('cloudy', 0.5).rain], ['clear', 'cloudy', false]);
  for (const sky of ['clear', 'cloudy', 'rain', 'storm']) {
    for (const k of [0, 0.4, 0.6, 1]) check(`${sky} ${k}: tempC in the month's range`, mk(sky, k).tempC >= lo && mk(sky, k).tempC <= hi, mk(sky, k).tempC);
  }
  check('rain is cooler than the dry sky', mk('rain', 0.9).tempC <= mk('clear', 0.5).tempC);
  const clipped = windowOutcome({ id: 1, from: local(7, 6, 13, 40), to: local(7, 6, 14, 20), sky: 'rain', intensity: 0.5 }, local(7, 6, 14), world);
  eq('from/until clipped to the window and the block', [clipped.from, clipped.until], [local(7, 6, 13, 40), local(7, 6, 14, 20)]);
  eq('phrases', [weatherPhrase({ condition: 'storm', tempC: 20 }), weatherPhrase({ condition: 'hot', tempC: 41 }), weatherPhrase({ condition: 'rain', rain: true })],
    ['stormy, 20°C', 'scorching hot, 41°C', 'raining']);
}

section('forecast and nextWeatherChangeAt');
{
  const from = local(7, 6, 9);
  const win = { id: 5, from: local(7, 6, 13, 30), to: local(7, 6, 16, 45), sky: 'storm', intensity: 1 };
  eq('no windows: forecast(…, {state}) ≡ forecast(…)', forecast(from, 24, world, { state: { weatherWindows: [] } }), forecast(from, 24, world));
  const f = forecast(from, 12, world, { state: { weatherWindows: [win] } });
  check('split at the window edges', f.some(b => b.from === win.from) && f.some(b => b.from === win.to), f.map(b => [b.from, b.until]));
  check('owner blocks are exactly the window', f.filter(b => b.owner).every(b => b.from >= win.from && b.until <= win.to)
    && f.filter(b => b.owner).length >= 1 && f.filter(b => !b.owner).every(b => b.until <= win.from || b.from >= win.to));
  check('contiguous', f.every((b, i) => i === 0 || b.from === f[i - 1].until));
  const st = { weatherWindows: [win] };
  check('next change strictly later', [from, win.from, win.to, local(7, 6, 15)].every(t => nextWeatherChangeAt(st, t, world) > t));
  eq('next change: a window edge inside a block', nextWeatherChangeAt(st, local(7, 6, 12, 10), world), win.from);
  eq('next change: the block boundary first', nextWeatherChangeAt(st, local(7, 6, 10), world), local(7, 6, 12));
}

section('projector fold: bounded, re-validated, present-only (R15)');
{
  let s = createInitialState(world);
  let id = 100;
  const fold = (type, payload, extra = {}) => { s = project(s, { id: ++id, at: local(7, 6, 8), type, actor: 'owner', payload, originKind: 'owner', originJid: 'owner', ...extra }, world); return id; };
  fold('weather.changed', { rain: false, condition: 'clear', tempC: 25, from: local(7, 6, 6), until: local(7, 6, 9) }, { actor: 'engine', originKind: 'self', originJid: 'self' });
  check('an engine weather.changed folds without windowId / by', !('windowId' in s.weather) && !('by' in s.weather));
  check('no weatherWindows key before a window', !('weatherWindows' in s));
  fold('weather.changed', { rain: true, condition: 'rain', tempC: 24, from: local(7, 6, 8), until: local(7, 6, 11) });
  eq('an owner one keeps by:owner', s.weather.by, 'owner');
  for (const bad of [
    { from: local(7, 6, 10), to: local(7, 6, 9), sky: 'rain' },
    { from: local(7, 6, 10), to: local(7, 6, 10) + 73 * H, sky: 'rain' },
    { from: local(7, 6, 10), to: local(7, 6, 12), sky: 'hail' },
    { from: 'soon', to: local(7, 6, 12), sky: 'rain' },
    { from: local(7, 6, 10) + 0.5, to: local(7, 6, 12), sky: 'rain' },
  ]) fold('weather.window_set', bad);
  eq('malformed windows are ignored', (s.weatherWindows ?? []).length, 0);
  const w1 = fold('weather.window_set', { from: local(7, 6, 10), to: local(7, 6, 14), sky: 'rain', intensity: 7 });
  eq('intensity clamped', s.weatherWindows[0].intensity, 1);
  for (let i = 0; i < 9; i++) fold('weather.window_set', { from: local(7, 6, 10), to: local(7, 6, 14), sky: 'clear', intensity: 0.5 });
  eq('≤ 8 kept, oldest dropped', [s.weatherWindows.length, s.weatherWindows.some(w => w.id === w1)], [8, false]);
  const last = s.weatherWindows.at(-1).id;
  s = project(s, { id: ++id, at: local(7, 6, 11), type: 'weather.window_ended', actor: 'owner', payload: { windowId: last }, originKind: 'owner', originJid: 'owner' }, world);
  eq('weather.window_ended cuts `to` at its time', s.weatherWindows.at(-1).to, local(7, 6, 11));
  const before = JSON.stringify(serializeState(s));
  s = project(s, { id: ++id, at: local(7, 6, 11), type: 'weather.window_set', actor: 'owner', payload: { redacted: true }, redacted: true, originKind: 'owner', originJid: 'owner' }, world);
  eq('a redacted window is a no-op', JSON.stringify({ ...serializeState(s), lastEventId: 0, at: 0 }), JSON.stringify({ ...JSON.parse(before), lastEventId: 0, at: 0 }));
}

section('eventLog rules (owner-only, cause types R14, chat-forbidden goal.*)');
{
  await setupScratchDb();
  check('the four owner types are owner-only', ['weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled'].every(t => OWNER_ONLY_TYPES.has(t)));
  eq('goal.* are chat-forbidden; commute.soaked and weather windows are not',
    [...STEER_EVENT_TYPES].filter(t => CHAT_FORBIDDEN_TYPES.has(t)).sort(),
    ['goal.cancelled', 'goal.deferred', 'goal.done', 'goal.expired', 'goal.fitted', 'goal.set']);
  const at = local(7, 6, 9);
  throws('engine cannot append weather.window_set', () => appendEvent({ type: 'weather.window_set', at, actor: 'engine', payload: { from: at, to: at + H, sky: 'rain' } }), /only the owner/);
  const g = appendEvent({ type: 'genesis', at, actor: 'engine', payload: {} });
  throws('commute.soaked needs a cause', () => appendEvent({ type: 'commute.soaked', at, actor: 'engine', payload: {} }), /needs a cause/);
  throws('commute.soaked caused by genesis is refused', () => appendEvent({ type: 'commute.soaked', at, actor: 'engine', causeId: g.id, payload: {} }), /cannot be caused by genesis/);
  throws('owner cannot append commute.soaked', () => appendEvent({ type: 'commute.soaked', at, actor: 'owner', causeId: g.id, payload: {} }), /must be an engine event/);
  const tr = appendEvent({ type: 'travel.started', at, actor: 'engine', payload: { from: 'place:home', to: 'place:office', minutes: 20 } });
  check('commute.soaked caused by its travel.started is fine', appendEvent({ type: 'commute.soaked', at, actor: 'engine', causeId: tr.id, payload: { lateMin: 0 } }).id > 0);
  const gs = appendEvent({ type: 'goal.set', at, actor: 'owner', payload: { goalKind: 'outing', from: at, to: at + 86400 } });
  throws('goal.done caused by goal.set is refused (needs goal.fitted)', () => appendEvent({ type: 'goal.done', at, actor: 'engine', causeId: gs.id, payload: { goalId: gs.id } }), /cannot be caused by goal.set/);
  throws('heavy flag refused on a 011 type', () => appendEvent({ type: 'goal.deferred', at, actor: 'engine', causeId: gs.id, heavy: true, payload: {} }), /cannot be heavy/);
  const ptr = appendEvent({ type: 'chat.trigger', at, actor: 'chat', originKind: 'dm', originJid: '15550001111@s.whatsapp.net', payload: {} });
  throws('a goal.* with a chat origin is refused', () => appendEvent({ type: 'goal.deferred', at, actor: 'engine', causeId: ptr.id, payload: {} }), /cannot be caused by|chat origin/);
}

// ── The pulse over a window (scratch DB, fake clock) ────────────────────────

const T0 = local(7, 6, 5);            // Mon 6 Jul 2026 05:00 (a rainy month in the example world)
async function run({ window = null, rewindBefore = false } = {}) {
  await setupScratchDb();
  const clock = fakeClock(T0);
  setClock(clock.fn);
  let live = createInitialState(world);
  const append = (spec) => { const ev = appendEvent(spec); live = applyAppended(live, ev, { world }); return ev; };
  genesis(append, world, T0);
  const pulse = createPulse({ world, getState: () => live, append, now: clock.fn, tickMinutes: 15 });
  let win = null;
  while (clock.now() < local(7, 6, 9)) { clock.advance({ minutes: 15 }); await pulse.tick(); }
  if (window) {
    const act = append({ type: 'director.action', at: clock.now(), actor: 'owner', payload: { kind: 'weather', previewAt: clock.now(), count: 1 } });
    win = append({ type: 'weather.window_set', at: clock.now(), actor: 'owner', causeId: act.id, payload: window });
    if (rewindBefore) append({ type: 'world.rewound', at: clock.now(), actor: 'owner', payload: { toEventId: act.id - 1 } });
  }
  while (clock.now() < local(7, 7, 5)) { clock.advance({ minutes: 15 }); await pulse.tick(); }
  return { live: () => live, win, events: eventsAfter(0, 50000), clock };
}

section('the pulse: no window ≡ pre-011 weather events');
const plain = await run();
const plainWeather = plain.events.filter(e => e.type === 'weather.changed');
check('weather changes dated at their 3-hour block, none caused', plainWeather.length > 3
  && plainWeather.every(e => e.causeId === null && !('windowId' in e.payload)));

section('the pulse: a storm window from 13:40 to 16:20');
{
  const spec = { from: local(7, 6, 13, 40), to: local(7, 6, 16, 20), sky: 'storm', intensity: 0.9 };
  const A = await run({ window: spec });
  const ws = A.events.filter(e => e.type === 'weather.changed');
  const atFrom = ws.find(e => e.at === spec.from);
  check('a weather.changed at the window\'s `from` (mid-block)', !!atFrom, ws.map(e => e.at));
  eq('… storm, caused by the window, windowId set', [atFrom?.payload.condition, atFrom?.causeId, atFrom?.payload.windowId], ['storm', A.win.id, A.win.id]);
  eq('… origin self (owner cause → self)', atFrom?.originKind, 'self');
  const atTo = ws.find(e => e.at === spec.to);
  check('a weather.changed at the window\'s `to`, back to climatology', !!atTo && atTo.causeId === null && !('windowId' in atTo.payload)
    && atTo.payload.condition !== 'storm', atTo);
  const inside = ws.filter(e => e.at > spec.from && e.at < spec.to);
  check('inside the window only window weather', inside.every(e => e.payload.windowId === A.win.id));
  const after = ws.filter(e => e.at > spec.to);
  eq('after the window: the pre-011 events, one for one', after.map(e => [e.at, e.payload.condition, e.payload.tempC]),
    plainWeather.filter(e => e.at > spec.to && e.at >= atTo.payload.until).map(e => [e.at, e.payload.condition, e.payload.tempC])
      .filter(([at]) => after.some(x => x.at === at)));
  check('his weather during the window is the storm', A.events.some(e => e.type === 'weather.changed' && e.payload.condition === 'storm'));

  section('revert of a window cascades its emissions (the facade\'s started-window refusal: arcs 25)');
  const ids = cascadeIds(A.win.id);
  check('the cascade covers every window emission', ws.filter(e => e.causeId === A.win.id).every(e => ids.includes(e.id)));
  revertEvent(A.win.id, { reason: 'test', at: A.clock.now() });
  const rebuilt = rebuild({ world });
  check('after the revert no window and no storm in the projection', (rebuilt.weatherWindows ?? []).length === 0 && rebuilt.weather?.condition !== 'storm');

  section('the same log folds identically twice');
  eq('two rebuilds', JSON.stringify(serializeState(rebuild({ world, useSnapshot: false }))), JSON.stringify(serializeState(rebuild({ world, useSnapshot: false }))));
}

section('a rewind before the window excludes it');
{
  const spec = { from: local(7, 6, 13), to: local(7, 6, 16), sky: 'heat', intensity: 0.5 };
  const R = await run({ window: spec, rewindBefore: true });
  const s = rebuild({ world });
  eq('no window in the projection', (s.weatherWindows ?? []).length, 0);
  check('no weather caused by the rewound window is in force', s.weather?.windowId !== R.win.id);
}

section('planDay reads a window covering the departure');
{
  const s = plain.live();
  const day = local(7, 7, 7, 30);          // Tue 7 Jul: an office day
  const dry = planDay({ ...s, weather: null, weatherWindows: [{ id: 9, from: local(7, 7, 6), to: local(7, 7, 12), sky: 'clear', intensity: 0.5 }] }, day, world, { wakeAt: day });
  const wet = planDay({ ...s, weather: null, weatherWindows: [{ id: 9, from: local(7, 7, 6), to: local(7, 7, 12), sky: 'storm', intensity: 1 }] }, day, world, { wakeAt: day });
  const commute = (p) => p.blocks.find(b => b.kind === 'commute');
  eq('a clear window: the dry mode', commute(dry).mode, world.travel.defaultMode);
  eq('a storm window over the departure: a cab', commute(wet).mode, 'cab');
  check('the departure is inside the window', commute(wet).start >= local(7, 7, 6) && commute(wet).start < local(7, 7, 12));
}

check('no network', fetches === 0, fetches);
void dayStart; void addDays;
report();
