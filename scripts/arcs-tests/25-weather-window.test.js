// 011 Phase 2 — owner weather windows on the Director (director.js planWeather /
// planWeatherEnd, plan §P2.1, review R20/R28): planner bounds (≤ 72 h ahead,
// 30 min – 72 h long, ≤ 8 open, the sky enum, intensity 0..1), owner-only types,
// the immediate engine weather.changed when the window starts now (caused by it,
// windowId set), END back to what the weather is without it, preview tomorrow
// listing the window, the facade's revert rule (a window can be reverted only
// before it starts), the route's shape check, and a prompt draft resolved in the
// world time zone. Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed,
  fakeCallRole, HOUR,
} from './_helpers.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { zonedToUnix, dateKey, addDays, dayStart, resolveTimezone } from '../../src/life/clock.js';
import { weatherAt, weatherFor } from '../../src/life/weather.js';
import * as director from '../../src/life/story/director.js';
import * as promptMod from '../../src/life/story/prompt.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock, life } = booted;
await simulateDays(1);
await simulateHours(7);               // Wed 28 Oct, early afternoon
const tz = resolveTimezone(world.timezone);

async function codeOf(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
function codeOfSync(fn) {
  try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; }
}

section('the facade: revert only before the window starts (R20)');
{
  // While life runs the story facade wires the Director to the live projection.
  const now = clock.now();
  const future = await director.preview({ kind: 'weather', weatherKind: 'rain', intensity: 0.7, from: now + 2 * HOUR, to: now + 4 * HOUR });
  const a = await director.apply(future.previewId, future.fingerprint);
  const futureId = a.eventIds.map(getEvent).find(e => e.type === 'weather.window_set').id;
  const started = await director.preview({ kind: 'weather', weatherKind: 'heat', intensity: 0.5, from: now, to: now + HOUR });
  const b = await director.apply(started.previewId, started.fingerprint);
  const startedId = b.eventIds.map(getEvent).find(e => e.type === 'weather.window_set').id;
  let refused = null;
  try { life.revertEvent(startedId, { reason: 'test' }); } catch (e) { refused = e.message; }
  check('a started window cannot be reverted (END it instead)', /cannot be reverted/.test(refused ?? ''), refused);
  const r = life.revertEvent(futureId, { reason: 'test' });
  check('a window that has not started can', Number.isSafeInteger(r.revertEventId));
  check('…and is gone from the projection', !(life.getState().weatherWindows ?? []).some(w => w.id === futureId));
  check('the started heat window is in force', life.getState().weather?.condition === 'hot');
  const end = await director.preview({ kind: 'weather.end', windowId: startedId });
  await director.apply(end.previewId, end.fingerprint);
  check('END → back to the climatology', life.getState().weather?.condition !== 'hot' && !Number.isSafeInteger(life.getState().weather?.windowId));
}
await stopLife();

let state = rebuild({ world });
const append = (spec) => {
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append, knownNames: () => [], seed: () => seed, setClaimStatus: () => {},
});

section('planner bounds');
{
  const now = clock.now();
  const w = (o) => ({ kind: 'weather', weatherKind: 'rain', intensity: 0.5, from: now + HOUR, to: now + 3 * HOUR, ...o });
  eq('unknown sky → bad_weatherKind', codeOfSync(() => director.plan(w({ weatherKind: 'hail' }), state)), 'invalid:bad_weatherKind');
  eq('intensity > 1 → bad_intensity', codeOfSync(() => director.plan(w({ intensity: 1.5 }), state)), 'invalid:bad_intensity');
  eq('from in the past → bad_from', codeOfSync(() => director.plan(w({ from: now - 2 * HOUR }), state)), 'invalid:bad_from');
  eq('from more than 72 h ahead → bad_from', codeOfSync(() => director.plan(w({ from: now + 73 * HOUR, to: now + 74 * HOUR }), state)), 'invalid:bad_from');
  eq('to more than 72 h ahead → bad_to', codeOfSync(() => director.plan(w({ to: now + 72 * HOUR + 60 }), state)), 'invalid:bad_to');
  eq('shorter than 30 min → bad_window', codeOfSync(() => director.plan(w({ to: now + HOUR + 20 * 60 }), state)), 'invalid:bad_window');
  eq('to before from → bad_window', codeOfSync(() => director.plan(w({ to: now + 30 * 60 }), state)), 'invalid:bad_window');
  check('30 min and 72 h are fine', !codeOfSync(() => director.plan(w({ from: now, to: now + 30 * 60 }), state))
    && !codeOfSync(() => director.plan(w({ from: now, to: now + 72 * HOUR }), state)));
  const p = director.plan(w({ intensity: undefined }), state);
  eq('intensity defaults to 0.5', p.events.find(e => e.type === 'weather.window_set').payload.intensity, 0.5);
}

section('a window later today: owner events only');
{
  const now = clock.now();
  const pv = await director.preview({ kind: 'weather', weatherKind: 'storm', intensity: 0.9, from: now + 2 * HOUR, to: now + 5 * HOUR });
  eq('events', pv.events.map(e => [e.type, e.actor]), [['director.action', 'owner'], ['weather.window_set', 'owner']]);
  check('warnings: visible everywhere + overrides the forecast', pv.warnings.includes(director.VISIBLE_EVERYWHERE)
    && pv.warnings.some(x => /^overrides the forecast until \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x)), pv.warnings);
  const res = await director.apply(pv.previewId, pv.fingerprint);
  const set = res.eventIds.map(getEvent).find(e => e.type === 'weather.window_set');
  eq('owner origin, caused by the director.action', [set.originKind, getEvent(set.causeId).type], ['owner', 'director.action']);
  eq('in the projection (open windows)', state.weatherWindows.filter(x => x.to > now).map(x => [x.id, x.sky]), [[set.id, 'storm']]);
  check('the weather now is unchanged', state.weather?.windowId === undefined);
}

section('a window starting now: the change is immediate');
{
  const now = clock.now();
  const pv = await director.preview({ kind: 'weather', weatherKind: 'rain', intensity: 0.2, from: now, to: now + 2 * HOUR });
  eq('events', pv.events.map(e => [e.type, e.actor]), [['director.action', 'owner'], ['weather.window_set', 'owner'], ['weather.changed', 'engine']]);
  eq('the change is caused by the window and refers to it', [pv.events[2].causeRef, pv.events[2].payloadRefs?.windowId], ['$2', '$2']);
  const res = await director.apply(pv.previewId, pv.fingerprint);
  const [, set, wc] = res.eventIds.map(getEvent);
  eq('applied: light rain now, windowId = the window, origin self', [wc.payload.condition, wc.payload.windowId, wc.causeId, wc.originKind],
    ['light_rain', set.id, set.id, 'self']);
  eq('projection: raining, from the window', [state.weather.rain, state.weather.windowId], [true, set.id]);

  section('weather.end (R28)');
  eq('unknown window → refused', codeOfSync(() => director.plan({ kind: 'weather.end', windowId: 999999 }, state)), 'refused:no_window');
  const end = await director.preview({ kind: 'weather.end', windowId: set.id });
  eq('END of a window in force: owner end + engine change', end.events.map(e => [e.type, e.actor]),
    [['director.action', 'owner'], ['weather.window_ended', 'owner'], ['weather.changed', 'engine']]);
  await director.apply(end.previewId, end.fingerprint);
  const clim = weatherAt(clock.now(), world);
  eq('back to the climatology', [state.weather.condition, state.weather.tempC, state.weather.windowId], [clim.condition, clim.tempC, undefined]);
  eq('an ended window cannot be ended again', codeOfSync(() => director.plan({ kind: 'weather.end', windowId: set.id }, state)), 'refused:no_window');
}

section('owner-only types refuse every other actor');
for (const type of ['weather.window_set', 'weather.window_ended']) {
  for (const actor of ['engine', 'jev', 'mind']) {
    let msg = null;
    try { appendEvent({ type, at: clock.now(), actor, payload: {} }); } catch (e) { msg = e.message; }
    check(`${actor} cannot append ${type}`, /only the owner/.test(msg ?? ''), msg);
  }
}

section('preview tomorrow lists the window');
{
  // A fresh projection without the eight cloudy windows, plus one rainy evening tomorrow.
  const now = clock.now();
  const tomorrow = addDays(dayStart(now, tz), 1, tz);
  const from = zonedToUnix(...dateKey(tomorrow, tz).split('-').map(Number), 6, 0, tz);
  const s2 = { ...state, weatherWindows: [{ id: 1e9, from, to: from + 3 * HOUR, sky: 'rain', intensity: 0.8 }] };
  const prev = director.__setDepsForTest;
  void prev;
  director.__setDepsForTest({ getState: () => s2 });
  const t = await director.previewTomorrow({ hours: 30 });
  director.__setDepsForTest({ getState: () => state });
  check('a SET BY YOU weather row inside the window', (t.weather ?? []).some(w => w.owner === true && w.at >= from && w.at < from + 3 * HOUR && w.rain), t.weather);
  check('rows outside it are the forecast', (t.weather ?? []).filter(w => w.at >= from + 3 * HOUR).every(w => w.owner !== true));
}

section('route shape check');
eq('weather: unknown sky → 400 bad_weatherKind', actionProblem({ kind: 'weather', weatherKind: 'snow' }), 'bad_weatherKind');
eq('weather.end: a string id → 400 bad_windowId', actionProblem({ kind: 'weather.end', windowId: '7' }), 'bad_windowId');
eq('a well-formed weather action passes', actionProblem({ kind: 'weather', weatherKind: 'rain', intensity: 0.4,
  from: { date: '2026-10-29', time: '18:00' }, to: { date: '2026-10-29', time: '21:00' } }), null);

section('prompt: "rain tomorrow evening" → a weather draft in the world time zone');
{
  const cr = fakeCallRole({
    'director.prompt': () => JSON.stringify({ actions: [{ action: { kind: 'weather', weatherKind: 'rain', intensity: 0.6,
      from: { day: 1, time: '18:00' }, to: { day: 1, time: '21:00' } }, why: 'rain tomorrow evening' },
    { action: { kind: 'weather', weatherKind: 'rain', from: { day: 4, time: '18:00' }, to: { day: 4, time: '21:00' } }, why: 'too far' },
    { action: { kind: 'weather.end', windowId: 424242 }, why: 'unknown window' }] }),
  });
  promptMod.__setDepsForTest(null);
  promptMod.__setDepsForTest({
    now: () => clock.now(), getState: () => state, world, callRole: cr.fn, mindBudgetOk: async () => ({ ok: true }),
    getUsageByCaller: () => [], knownNames: () => [], persona: { name: 'Testname', voiceDescriptor: 'plain' },
  });
  const res = await promptMod.runPrompt('make it rain tomorrow evening');
  eq('one draft, two dropped', [res.status, res.drafts.length, res.dropped.map(d => d.reason)], ['ok', 1, ['bad_time', 'unknown_ref']]);
  const d = res.drafts[0];
  const tomorrow = dateKey(addDays(dayStart(clock.now(), tz), 1, tz), tz);
  eq('the draft keeps the time forms anchored to the prompt date', [d.action.from, d.action.to], [{ date: tomorrow, time: '18:00' }, { date: tomorrow, time: '21:00' }]);
  eq('the route accepts it', actionProblem(d.action), null);
  check('batchable, a code summary', d.batchable === true && /^WEATHER · RAIN/.test(d.summary), d);
  const p = director.plan(d.action, state);
  const set = p.events.find(e => e.type === 'weather.window_set');
  const [y, m, dd] = tomorrow.split('-').map(Number);
  eq('resolved in the world time zone', [set.payload.from, set.payload.to], [zonedToUnix(y, m, dd, 18, 0, tz), zonedToUnix(y, m, dd, 21, 0, tz)]);
  const user = cr.callsFor('director.prompt')[0]?.user ?? '';
  check('the catalogue carries the forecast and the open windows', /"weather":\[/.test(user) && /"windows":\[\{"id":/.test(user));
  promptMod.__setDepsForTest(null);
}

section('the projector cap drops ended windows first (a long open window survives set/END cycles)');
{
  const act = async (a) => {
    const pv = await director.preview(a);
    return (await director.apply(pv.previewId, pv.fingerprint)).eventIds.map(getEvent);
  };
  for (const w of (state.weatherWindows ?? []).filter(x => x.to > clock.now())) await act({ kind: 'weather.end', windowId: w.id });
  const now = clock.now();
  const long = (await act({ kind: 'weather', weatherKind: 'storm', intensity: 0.9, from: now + HOUR, to: now + 49 * HOUR }))
    .find(e => e.type === 'weather.window_set');
  for (let i = 0; i < 8; i++) {
    const w = (await act({ kind: 'weather', weatherKind: i % 2 ? 'cloudy' : 'clear', from: clock.now(), to: clock.now() + 1800 }))
      .find(e => e.type === 'weather.window_set');
    await act({ kind: 'weather.end', windowId: w.id });
    clock.advance({ seconds: 60 });
  }
  check('at most 8 windows kept', state.weatherWindows.length <= 8, state.weatherWindows.length);
  check('the long open window is still there', state.weatherWindows.some(w => w.id === long.id && w.to > clock.now()),
    state.weatherWindows.map(w => w.id));
  eq('…and still sets the weather 10 h ahead', weatherFor(state, now + 10 * HOUR, world).condition, 'storm');
  eq('…and END still finds it', codeOfSync(() => director.plan({ kind: 'weather.end', windowId: long.id }, state)), null);
  await act({ kind: 'weather.end', windowId: long.id });
}

section('≤ 8 open windows');
{
  const now = clock.now();
  for (let i = 0; i < 8; i++) {
    const open = (state.weatherWindows ?? []).filter(w => w.to > now).length;
    if (open >= 8) break;
    const pv = await director.preview({ kind: 'weather', weatherKind: 'cloudy', from: now + 6 * HOUR + i * HOUR, to: now + 7 * HOUR + i * HOUR });
    await director.apply(pv.previewId, pv.fingerprint);
  }
  eq('the 9th → refused full', codeOfSync(() => director.plan({ kind: 'weather', weatherKind: 'clear', from: now + 20 * HOUR, to: now + 21 * HOUR }, state)), 'refused:full');
}

report();
