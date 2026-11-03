// T009 — simulated weather (src/life/weather.js): 3-hour local blocks from the
// world's monthly climatology, deterministic rolls, weather.changed outcomes.
// Pure: no DB, no network.

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, section, check, eq, throws, report } from './_helpers.js';

const W = await import('../../src/life/weather.js');
const { setRngSeed, rngFor } = await import('../../src/life/rng.js');
const { hhmm, addDays, dayStart, localParts } = await import('../../src/life/clock.js');
const {
  BLOCK_HOURS, DEFAULT_CLIMATE, climateFor, windowShare, weatherAt, forecast, isRaining, sameWeather,
  weatherEvent, weatherPhrase,
} = W;

setRngSeed(20261028);
const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/world.example.json'), 'utf-8'));
const TZ = 'Asia/Tokyo'; // fixed +09:00 — exercises local (not UTC) block alignment
const world = { ...example, timezone: TZ };
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const climate = (month, c) => ({ timezone: TZ, climate: { [String(month)]: c } });
let exampleYear = null; // filled once in 'determinism'

/** Every block of `days` days from local midnight of `start`. */
function blocks(w, start, days) {
  const out = [];
  let day = dayStart(start, w.timezone);
  for (let d = 0; d < days; d++, day = addDays(day, 1, w.timezone)) {
    for (let b = 0; b < 24 / BLOCK_HOURS; b++) out.push(weatherAt(day + b * BLOCK_HOURS * 3600 + 60, w));
  }
  return out;
}

section('climate normalization');
{
  eq('example month read from a string key', climateFor(world, 7).rainProb, example.climate['7'].rainProb);
  eq('missing month → dry default', climateFor({ climate: {} }, 3), { ...DEFAULT_CLIMATE });
  eq('no climate at all → default', climateFor(undefined, 3), { ...DEFAULT_CLIMATE });
  eq('rainProb clamped, temp range swapped', climateFor({ climate: { 1: { rainProb: 7, rainyHours: [14, 18], tempRange: [30, 10] } } }, 1),
    { rainProb: 1, rainyHours: [14, 18], tempRange: [10, 30] });
  eq('malformed fields fall back', climateFor({ climate: { 1: { rainProb: 'wet', rainyHours: 'evening', tempRange: [1] } } }, 1),
    { rainProb: 0, rainyHours: [0, 0], tempRange: [18, 28] });
  eq('array climate (index 0 = Jan)', climateFor({ climate: [{ rainProb: 0.5, rainyHours: [1, 2], tempRange: [0, 5] }] }, 1).rainProb, 0.5);
  eq('window share of a block', [windowShare(4, [14, 18]), windowShare(5, [14, 18]), windowShare(0, [14, 18])], [1 / 3, 1, 0]);
  eq('window wrapping midnight', [windowShare(7, [22, 2]), windowShare(0, [22, 2])], [2 / 3, 2 / 3]);
}

section('block shape and alignment');
{
  const t = U(2026, 10, 28, 5, 20); // 14:20 JST
  const w = weatherAt(t, world);
  eq('block index from local hour', w.block, 4);
  eq('block starts on a local 3-h boundary', hhmm(w.from, TZ), '12:00');
  eq('block ends 3 h later', w.until - w.from, 3 * 3600);
  check('at is inside its block', w.from <= t && t < w.until);
  eq('month from the local date', w.month, 10);
  check('fields', typeof w.rain === 'boolean' && ['none', 'light', 'heavy'].includes(w.intensity)
    && ['clear', 'cloudy', 'light_rain', 'heavy_rain'].includes(w.condition) && Number.isInteger(w.tempC) && typeof w.rainyDay === 'boolean');
  const late = weatherAt(U(2026, 10, 28, 14, 59), world); // 23:59 JST
  eq('last block of the day ends at the next local midnight', late.until, addDays(U(2026, 10, 28, 14), 1, TZ));
  eq('UTC midnight is mid-block in JST', weatherAt(U(2026, 10, 28, 0, 0), world).block, 3);
  check('payload is plain data (numbers/labels only)', JSON.stringify(w) === JSON.stringify(JSON.parse(JSON.stringify(w))));
}

section('determinism');
{
  const t = U(2026, 7, 15, 6);
  const a = weatherAt(t, world);
  rngFor('2026-07-15', 'weather:block:2')(); // unrelated draws in between don't matter
  weatherAt(U(2026, 7, 16, 6), world);
  eq('same block twice → same outcome', weatherAt(t, world), a);
  eq('any instant in the block → same outcome', weatherAt(a.from + 1, world), weatherAt(a.until - 1, world));
  exampleYear = blocks(world, U(2026, 1, 1, 3), 365);
  const year = JSON.stringify(exampleYear);
  eq('a whole year replays identically', JSON.stringify(blocks(world, U(2026, 1, 1, 3), 365)), year);
  setRngSeed(1);
  check('another install seed gives another year', JSON.stringify(blocks(world, U(2026, 1, 1, 3), 365)) !== year);
  setRngSeed(20261028);
}

section('rain follows the climatology');
{
  const never = blocks(climate(6, { rainProb: 0, rainyHours: [12, 21], tempRange: [20, 30] }), U(2026, 6, 1, 3), 30);
  check('rainProb 0 never rains', never.every(b => !b.rain && !b.rainyDay && b.condition === 'clear'));
  const always = blocks(climate(6, { rainProb: 1, rainyHours: [12, 21], tempRange: [20, 30] }), U(2026, 6, 1, 3), 30);
  check('rainProb 1: every day is a rainy day', always.every(b => b.rainyDay));
  check('rain only inside rainyHours', always.every(b => !b.rain || windowShare(b.block, [12, 21]) > 0),
    always.filter(b => b.rain && windowShare(b.block, [12, 21]) === 0).map(b => b.block));
  check('rainy days do rain in the window', always.filter(b => b.rain).length > 30);
  check('rain off-window never, cloudy instead', always.filter(b => windowShare(b.block, [12, 21]) === 0).every(b => b.condition === 'cloudy'));
  const overnight = blocks(climate(6, { rainProb: 1, rainyHours: [22, 3], tempRange: [20, 30] }), U(2026, 6, 1, 3), 20);
  check('a window wrapping midnight rains at night only', overnight.filter(b => b.rain).every(b => [0, 7].includes(b.block))
    && overnight.some(b => b.rain));

  // Example climatology over a year: the wet season rains far more than the dry one
  const year = exampleYear;
  const rainShare = months => {
    const bs = year.filter(b => months.includes(b.month));
    return bs.filter(b => b.rain).length / bs.length;
  };
  const wet = rainShare([6, 7, 8, 9]);
  const dry = rainShare([1, 2, 12]);
  check('wet months rain more than dry months', wet > 4 * dry && wet > 0.05, { wet, dry });
  const julyDays = new Set(year.filter(b => b.month === 7 && b.rainyDay).map(b => localParts(b.from, TZ).day)).size;
  check('rainy-day share near rainProb (July 0.55)', julyDays >= 9 && julyDays <= 25, julyDays);
  check('no rain outside each month\'s rainyHours', year.every(b => !b.rain || windowShare(b.block, climateFor(world, b.month).rainyHours) > 0));
  const heavyWet = year.filter(b => b.rain && [6, 7, 8].includes(b.month));
  check('heavy and light rain both occur', heavyWet.some(b => b.intensity === 'heavy') && heavyWet.some(b => b.intensity === 'light'));
}

section('temperature');
{
  const year = exampleYear;
  check('always inside the month\'s tempRange', year.every(b => {
    const [lo, hi] = climateFor(world, b.month).tempRange;
    return b.tempC >= lo && b.tempC <= hi;
  }));
  const avgAt = blk => {
    const bs = year.filter(b => b.block === blk && !b.rain);
    return bs.reduce((s, b) => s + b.tempC, 0) / bs.length;
  };
  check('afternoon warmer than pre-dawn', avgAt(4) > avgAt(1) + 5, { afternoon: avgAt(4), dawn: avgAt(1) });
  const dry = blocks(climate(4, { rainProb: 0, rainyHours: [15, 19], tempRange: [22, 34] }), U(2026, 4, 1, 3), 20).filter(b => b.block === 4);
  const wet = blocks(climate(4, { rainProb: 1, rainyHours: [12, 15], tempRange: [22, 34] }), U(2026, 4, 1, 3), 20).filter(b => b.block === 4 && b.rain);
  const mean = bs => bs.reduce((s, b) => s + b.tempC, 0) / bs.length;
  check('rain cools the afternoon', wet.length > 0 && mean(wet) < mean(dry) - 1.5, { dry: mean(dry), wet: mean(wet) });
}

section('forecast');
{
  const f = forecast(U(2026, 7, 15, 2, 10), 24, world);
  eq('24 h → 9 blocks when starting mid-block', f.length, 9);
  check('blocks are contiguous', f.every((b, i) => i === 0 || b.from === f[i - 1].until));
  eq('forecast(0 h) → empty', forecast(U(2026, 7, 15), 0, world), []);
}

section('weather.changed outcomes');
{
  const t = U(2026, 7, 15, 6);
  const cur = weatherAt(t, world);
  eq('no prior weather → an event payload', weatherEvent(null, t, world), cur);
  eq('same block already projected → null', weatherEvent(cur, t, world), null);
  eq('projection shape {rain, tempC, until} matches by sky + temp', weatherEvent({ rain: cur.rain, tempC: cur.tempC, until: cur.until, condition: cur.condition }, t, world), null);
  const flipped = { ...cur, rain: !cur.rain, condition: cur.rain ? 'clear' : 'light_rain', intensity: cur.rain ? 'none' : 'light' };
  eq('a change of sky → payload', weatherEvent(flipped, t, world), cur);
  eq('a 2 °C change → payload', weatherEvent({ ...cur, tempC: cur.tempC + 2 }, t, world), cur);
  eq('a 1 °C change → null', weatherEvent({ ...cur, tempC: cur.tempC + 1 }, t, world), null);
  check('sameWeather needs both sides', !sameWeather(null, cur) && !sameWeather(cur, undefined));

  // Walking a week block by block from the projection: an event only on a real change
  let projected = null;
  let events = 0;
  let blocksSeen = 0;
  let silentOk = true;
  for (let at = U(2026, 7, 13, 3); at < U(2026, 7, 20, 3); at += 3 * 3600, blocksSeen++) {
    const p = weatherEvent(projected, at, world);
    if (p) { projected = p; events++; }
    else if (!sameWeather(projected, weatherAt(at, world))) silentOk = false;
  }
  check('silent blocks are within 2 °C and the same sky', silentOk);
  check('fewer weather.changed events than blocks', events >= 1 && events < blocksSeen, { events, blocks: blocksSeen });
}

section('helpers');
{
  check('isRaining', isRaining({ rain: true }) && !isRaining({ rain: false }) && !isRaining(null));
  eq('phrases', [
    weatherPhrase({ condition: 'heavy_rain', tempC: 22 }),
    weatherPhrase({ condition: 'clear', tempC: 31 }),
    weatherPhrase({ rain: true }),
    weatherPhrase(null),
  ], ['raining hard, 22°C', 'clear, 31°C', 'light rain', '']);
  throws('weatherAt(world) by mistake fails loudly', () => weatherAt(world), /unix seconds/);
  check('invalid timezone does not throw', typeof weatherAt(U(2026, 7, 15), { ...world, timezone: 'Nowhere/Land' }).tempC === 'number');
}

report();
