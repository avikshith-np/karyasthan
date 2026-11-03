import { dateKey, localParts } from './clock.js';
import { rngFor } from './rng.js';
import { chooseMode } from './travel.js';
import { weatherAt, weatherFor, windowAt, climateFor, windowShare } from './weather.js';

// Rain gear (spec 011 Phase 2, plan §P2.2, review R23/R24/R28): what he actually
// does on a trip in the rain. Pure: no I/O, no clock reads; random parts are
// keyed rngFor(date, purpose) on their own streams ('commute:umbrella',
// 'commute:soaked:<start minute>'), so every other roll draws as before.
//
// travel.chooseMode stays the conservative ESTIMATE (rain → cab) that decision
// costs and deadlines use; this module decides the trips routine.planDay and
// pulse.amendPlanForOuting plan:
//
//   umbrellaFor(state, departures, date, world)  → { umbrella, p }   once per day,
//       p = 0.1 + 0.85 × the highest forecast chance over the day's usual departure
//       times (routine constants, before any trip is planned — R24), capped at 0.95
//   rainMode(km, weather, world, ctx)             → { mode, gear, exposed }
//       dry → chooseMode (unchanged); raining (a quick RAIN's 'rain' counts as light):
//       walkable → walk with the umbrella unless it pours and money is fine, else a
//       cab unless money is tight, else walk without one; longer → a cab unless money
//       is tight and he isn't fed up, else the world's default mode (exposed when it
//       is a two-wheeler). tight = money < 10 % of the salary (no salary → never).
//       lazy = valence < −0.3 or energy < 25 — base vitals, never the chat overlay (R23)
//   soakedAt(state, block, at, world)             → { intensity, changeClothes, lateMin } | null
//       an exposed trip without gear in rain at departure or at the planned arrival;
//       away from home he changes clothes with p 0.6 and is 10–20 min late.

export const EXPOSED_MODES = Object.freeze(['walk', 'scooter', 'bike', 'motorbike', 'cycle', 'bicycle']);
const EXPOSED = new Set(EXPOSED_MODES);
export const TIGHT_SHARE = 0.1;
export const LAZY_VALENCE = -0.3;
export const LAZY_ENERGY = 25;
const UMBRELLA_BASE = 0.1;
const UMBRELLA_SLOPE = 0.85;
const UMBRELLA_MAX = 0.95;
const CHANGE_CLOTHES_P = 0.6;
const LATE_MIN = Object.freeze([10, 20]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Test seam: rain gear off = the pre-011 trips (chooseMode, no umbrella roll, no
// gear fields, no soak). Only the 012 golden runner turns it off, so its fixture
// recorded before 011 still checks the rest of the engine byte for byte.
let gearOn = true;
export function __setRainGearForTest(on) { gearOn = on !== false; }
export function rainGearOn() { return gearOn; }

/** Is `mode` one where rain reaches him (on foot or on two wheels)? */
export function isExposed(mode) {
  return EXPOSED.has(mode);
}

/** Heavy rain or a storm (an owner window's 'storm' included). */
export function isHard(w) {
  return w?.intensity === 'heavy' || w?.condition === 'heavy_rain' || w?.condition === 'storm';
}

/**
 * What he'd read in a forecast for the 3-hour block at `at` (0..1): leaning
 * towards the truth without being it (so he is sometimes caught out). A block an
 * owner window covers is "in the forecast": rain/storm 0.9, any other sky 0.05.
 */
export function forecastChance(state, at, world) {
  const win = windowAt(state?.weatherWindows, at);
  if (win) return win.sky === 'rain' || win.sky === 'storm' ? 0.9 : 0.05;
  const block = weatherAt(at, world);
  const climate = climateFor(world, block.month);
  return clamp(0.7 * windowShare(block.block, climate.rainyHours) * climate.rainProb + (block.rain ? 0.35 : 0), 0, 1);
}

/** Does he pack an umbrella today? One roll per local date on its own stream. */
export function umbrellaFor(state, departures, date, world) {
  const chances = (Array.isArray(departures) ? departures : []).filter(finite).map(at => forecastChance(state, at, world));
  const p = clamp(UMBRELLA_BASE + UMBRELLA_SLOPE * Math.max(0, ...chances), 0, UMBRELLA_MAX);
  return { umbrella: rngFor(date, 'commute:umbrella')() < p, p: Math.round(p * 100) / 100 };
}

/**
 * The mode of an actual trip of `km` straight-line km in weather `w`.
 * ctx: { umbrella, money, salary, valence, energy }. → { mode, gear, exposed }
 */
export function rainMode(km, w, world, ctx = {}) {
  const umbrella = ctx.umbrella === true;
  const travel = world?.travel || {};
  if (!w?.rain) {
    const mode = chooseMode(km, w, world);
    return { mode, gear: umbrella, exposed: EXPOSED.has(mode) };
  }
  const tight = finite(ctx.money) && finite(ctx.salary) && ctx.salary > 0 && ctx.money < TIGHT_SHARE * ctx.salary;
  const lazy = (finite(ctx.valence) && ctx.valence < LAZY_VALENCE) || (finite(ctx.energy) && ctx.energy < LAZY_ENERGY);
  const hard = isHard(w);
  let mode;
  let gear = false;
  if (km <= (travel.walkMaxKm ?? 0)) {
    if (umbrella && !(hard && !tight)) { mode = 'walk'; gear = true; } else if (!tight) mode = 'cab';
    else mode = 'walk';
  } else if (!tight || lazy) {
    mode = 'cab';
  } else {
    mode = travel.defaultMode || 'cab';
    gear = umbrella;
  }
  return { mode, gear: mode === 'cab' ? umbrella : gear, exposed: EXPOSED.has(mode) };
}

/**
 * A soak on commute block `block` leaving at `at`, or null. Destination home → no
 * change of clothes (he is home). Keyed on the block's local start minute.
 */
export function soakedAt(state, block, at, world) {
  if (!gearOn || !block || block.exposed !== true || block.gear === true) return null;
  const tz = state?.world?.timezone || world?.timezone;
  const dep = weatherFor(state, at, world);
  const arr = finite(block.end) ? weatherFor(state, Math.max(at, block.end - 1), world) : null;
  const wet = dep?.rain ? dep : arr?.rain ? arr : null;
  if (!wet) return null;
  const home = state?.self?.homePlaceId ?? null;
  const p = localParts(finite(block.start) ? block.start : at, tz);
  const r = rngFor(dateKey(at, tz), `commute:soaked:${p.hour * 60 + p.minute}`);
  const changeClothes = block.to !== home && r() < CHANGE_CLOTHES_P;
  return { intensity: isHard(wet) ? 'heavy' : 'light', changeClothes, lateMin: changeClothes ? r.int(...LATE_MIN) : 0 };
}
