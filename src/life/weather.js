import { localParts, atLocal, dayStart, dateKey, now } from './clock.js';
import { rngFor } from './rng.js';

// Simulated weather (spec 009 plan §R6). No network: outcomes come from the
// world file's monthly climatology, `world.climate["1".."12"] = { rainProb,
// rainyHours: [from, to], tempRange: [min, max] }`.
//
// Model (explainable on purpose):
//   - each local day rolls once whether it is a rainy day (p = rainProb);
//   - on a rainy day, each 3-hour block (00–03, 03–06, … local time) that overlaps
//     rainyHours rains with p = 0.7 × the share of its hours inside the window —
//     rain never falls outside rainyHours; heavier months rain harder;
//   - temperature follows a diurnal curve inside tempRange (coolest ~05:00,
//     warmest ~15:00), a little jitter, cooler under rain, clamped to the range.
// Rolls are keyed rngFor(dateKey, 'weather:day' | 'weather:block:<i>'), so asking
// for the same block twice — or after a restart — gives the same answer. The pulse
// stores outcomes as `weather.changed` events (weatherEvent()); replay never rolls.
// Call weatherEvent(projected, at, world) every tick: it returns a payload only on a
// real change (new sky, or ≥ 2 °C), so the projection's `until` means "at least
// until" — informational, not the time the next change happens.
// Argument order: time first, world last (like travel.js); climateFor(world, month)
// is the one lookup that takes the world first.

export const BLOCK_HOURS = 3;
const BLOCK_RAIN_P = 0.7;
const CHANGE_TEMP_C = 2;

/** Used for a missing or malformed month: dry, mild. */
export const DEFAULT_CLIMATE = Object.freeze({ rainProb: 0, rainyHours: [0, 0], tempRange: [18, 28] });

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Normalized climate for `month` (1–12). Accepts "1".."12" keys, numeric keys or a 12-item array. */
export function climateFor(world, month) {
  const c = world?.climate;
  const raw = Array.isArray(c) ? c[month - 1] : (c?.[String(month)] ?? c?.[month]);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLIMATE };
  const rainProb = finite(raw.rainProb) ? Math.min(1, Math.max(0, raw.rainProb)) : 0;
  let rainyHours = [0, 0];
  if (Array.isArray(raw.rainyHours) && raw.rainyHours.length === 2 && raw.rainyHours.every(finite)) {
    rainyHours = raw.rainyHours.map(h => Math.min(24, Math.max(0, Math.round(h))));
  }
  let tempRange = [...DEFAULT_CLIMATE.tempRange];
  if (Array.isArray(raw.tempRange) && raw.tempRange.length === 2 && raw.tempRange.every(finite)) {
    const [a, b] = raw.tempRange.map(t => Math.min(60, Math.max(-50, t)));
    tempRange = a <= b ? [a, b] : [b, a];
  }
  return { rainProb, rainyHours, tempRange };
}

/** True when local `hour` (0–23) is inside [from, to); wraps past midnight when from > to. */
function inWindow(hour, [from, to]) {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Share (0–1) of block `i`'s hours that fall inside rainyHours. */
export function windowShare(i, rainyHours) {
  let inside = 0;
  for (let h = i * BLOCK_HOURS; h < (i + 1) * BLOCK_HOURS; h++) if (inWindow(h, rainyHours)) inside++;
  return inside / BLOCK_HOURS;
}

/** 0 at ~05:00, 1 at ~15:00, smooth in between. */
function diurnal(hour) {
  if (hour >= 5 && hour <= 15) return (1 - Math.cos((Math.PI * (hour - 5)) / 10)) / 2;
  const since = (hour < 5 ? hour + 24 : hour) - 15; // 0…14 h of cooling
  return (1 + Math.cos((Math.PI * since) / 14)) / 2;
}

// 011: two conditions only an owner window yields (climatology never does):
// 'storm' (rain, heavy) and 'hot' (dry, hotter than the month's range).
function conditionOf(rain, intensity, rainyDay) {
  if (rain) return intensity === 'heavy' ? 'heavy_rain' : 'light_rain';
  return rainyDay ? 'cloudy' : 'clear';
}

/**
 * The 3-hour block containing `at`: { rain, intensity: 'none'|'light'|'heavy',
 * condition: 'clear'|'cloudy'|'light_rain'|'heavy_rain', tempC, from, until,
 * month, block (0–7), rainyDay }. Deterministic for a given install seed.
 * `opts.tz` overrides world.timezone.
 */
export function weatherAt(at = now(), world, opts = {}) {
  if (!Number.isFinite(at)) throw new Error('weatherAt: at must be unix seconds (signature is weatherAt(at, world))');
  const tz = opts.tz ?? world?.timezone;
  const p = localParts(at, tz);
  const block = Math.floor(p.hour / BLOCK_HOURS);
  const day = dayStart(at, tz);
  const key = dateKey(at, tz);
  const climate = climateFor(world, p.month);

  const rainyDay = rngFor(key, 'weather:day').chance(climate.rainProb);
  const r = rngFor(key, `weather:block:${block}`);
  // Fixed draw order (rain, intensity, jitter) so each roll keeps its own stream.
  const rainRoll = r();
  const heavyRoll = r();
  const jitter = r.float(-1, 1);

  const share = windowShare(block, climate.rainyHours);
  const rain = rainyDay && share > 0 && rainRoll < BLOCK_RAIN_P * share;
  const intensity = !rain ? 'none' : heavyRoll < 0.2 + 0.4 * climate.rainProb ? 'heavy' : 'light';

  const [lo, hi] = climate.tempRange;
  let t = lo + (hi - lo) * diurnal(block * BLOCK_HOURS + BLOCK_HOURS / 2) + jitter;
  if (rain) t -= intensity === 'heavy' ? 4 : 2.5;
  else if (rainyDay) t -= 1;
  const tempC = Math.round(Math.min(hi, Math.max(lo, t)));

  return {
    rain,
    intensity,
    condition: conditionOf(rain, intensity, rainyDay),
    tempC,
    from: atLocal(day, block * BLOCK_HOURS * 60, tz),
    until: atLocal(day, (block + 1) * BLOCK_HOURS * 60, tz),
    month: p.month,
    block,
    rainyDay,
  };
}

/**
 * Consecutive blocks covering [from, from + hours). opts.state (011): the
 * projection — the blocks are then split at its owner windows' edges, each one
 * weatherFor's answer, marked `owner: true` when a window made it. A state
 * without windows gives exactly the climatology blocks.
 */
export function forecast(from = now(), hours = 24, world, opts = {}) {
  const out = [];
  const end = from + Math.max(0, hours) * 3600;
  const state = opts.state ?? null;
  if (activeWindows(state).length) {
    let t = from;
    for (let guard = 0; t < end && guard < 96; guard++) {
      const next = Math.min(nextWeatherChangeAt(state, t, world, opts) ?? end, end);
      const w = weatherFor(state, t, world, opts);
      out.push({ ...w, from: Math.max(finite(w.from) ? w.from : t, t), until: next, owner: Number.isSafeInteger(w.windowId) });
      t = next;
    }
    return out;
  }
  let t = from;
  for (let guard = 0; t < end && guard < 64; guard++) {
    const w = weatherAt(t, world, opts);
    out.push(w);
    t = w.until;
  }
  return out;
}

// ── 011 owner weather windows (plan §P2.1, review R15/R17/R28) ────────────
//
// state.weatherWindows = [{ id, from, to, sky, intensity }] (projector, from
// `weather.window_set`; `weather.window_ended` cuts `to`). weatherFor() is the
// one lookup every planner reads: the newest window covering `at` (by id), then
// state.weather within its [from, until), then climatology. Precedence is by
// source (R17): engine weather never outranks a window; only an owner quick
// RAIN newer than the window does (the window's own emission equals its outcome).
// A projected weather that a window made no longer counts once that window has
// stopped covering `at` (an END, R28). Pure: (state, at, world) → outcome.

export const WINDOW_SKIES = Object.freeze(['clear', 'cloudy', 'rain', 'storm', 'heat']);
export const WINDOW_MAX_SEC = 72 * 3600;

function activeWindows(state) {
  const list = state?.weatherWindows;
  return Array.isArray(list) ? list.filter(w => w && finite(w.from) && finite(w.to) && w.to > w.from) : [];
}

/** The newest window (highest id) covering `at`, or null. */
export function windowAt(windows, at) {
  let best = null;
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !finite(w.from) || !finite(w.to) || !(at >= w.from && at < w.to)) continue;
    if (!best || w.id > best.id) best = w;
  }
  return best;
}

/**
 * Window `win`'s weather at `at`: the climatology block with its sky replaced —
 * rain → light (< 0.5) / heavy rain, tempC −2.5 / −4; storm → condition
 * 'storm' (heavy), −4; heat → condition 'hot', max(block, month max) + 1..5;
 * clear / cloudy → dry (cloudy −1). Temperatures start from the block's dry
 * value and stay in the month's range (heat goes above it). from/until are
 * clipped to the window and the block; windowId is the window's id.
 */
export function windowOutcome(win, at, world, opts = {}) {
  const base = weatherAt(at, world, opts);
  const [lo, hi] = climateFor(world, base.month).tempRange;
  const dry = base.rain ? base.tempC + (base.intensity === 'heavy' ? 4 : 2.5) : base.rainyDay ? base.tempC + 1 : base.tempC;
  const k = finite(win?.intensity) ? Math.min(1, Math.max(0, win.intensity)) : 0.5;
  const inRange = (t) => Math.round(Math.min(hi, Math.max(lo, t)));
  let out;
  switch (win?.sky) {
    case 'rain': {
      const intensity = k < 0.5 ? 'light' : 'heavy';
      out = { rain: true, intensity, condition: conditionOf(true, intensity, true), tempC: inRange(dry - (intensity === 'heavy' ? 4 : 2.5)) };
      break;
    }
    case 'storm': out = { rain: true, intensity: 'heavy', condition: 'storm', tempC: inRange(dry - 4) }; break;
    case 'heat': out = { rain: false, intensity: 'none', condition: 'hot', tempC: Math.round(Math.min(60, Math.max(dry, hi) + Math.round(1 + 4 * k))) }; break;
    case 'cloudy': out = { rain: false, intensity: 'none', condition: 'cloudy', tempC: inRange(dry - 1) }; break;
    default: out = { rain: false, intensity: 'none', condition: 'clear', tempC: inRange(dry) }; break;
  }
  return {
    ...out,
    from: Math.max(win.from, base.from),
    until: Math.min(win.to, base.until),
    month: base.month,
    block: base.block,
    rainyDay: base.rainyDay,
    windowId: win.id,
  };
}

/** The weather in force at `at` for this projection (see the section comment). */
export function weatherFor(state, at, world, opts = {}) {
  const windows = activeWindows(state);
  const w = state?.weather;
  const covers = !!w && finite(w.until) && at < w.until && (!finite(w.from) || at >= w.from);
  const win = windows.length ? windowAt(windows, at) : null;
  if (win) {
    if (covers && w.by === 'owner' && Number.isSafeInteger(w.eventId) && w.eventId > win.id) return w;
    return windowOutcome(win, at, world, opts);
  }
  // A window's own emission stops counting once its window doesn't cover `at`
  // (ended, cut to nothing, or reverted). A projected weather without a
  // windowId — every pre-011 one — is untouched.
  if (covers && Number.isSafeInteger(w.windowId) && !windowAt(windows.filter(x => x.id === w.windowId), at)) {
    return weatherAt(at, world, opts);
  }
  if (covers) return w;
  return weatherAt(at, world, opts);
}

/**
 * The next time after `after` (strictly later) the weather may change: the
 * next 3-hour block boundary, a window edge or the projected weather's
 * `until`, whichever comes first.
 */
export function nextWeatherChangeAt(state, after, world, opts = {}) {
  if (!finite(after)) return null;
  let next = weatherAt(after, world, opts).until;
  if (!(next > after)) next = after + BLOCK_HOURS * 3600;
  for (const w of activeWindows(state)) {
    if (w.from > after && w.from < next) next = w.from;
    if (w.to > after && w.to < next) next = w.to;
  }
  const u = state?.weather?.until;
  if (finite(u) && u > after && u < next) next = u;
  return next;
}

/** True when weather `w` (an outcome, a projection or a payload) means rain. */
export function isRaining(w) {
  return w?.rain === true;
}

/** Same sky and within 2 °C — no `weather.changed` needed. */
export function sameWeather(a, b) {
  if (!a || !b) return false;
  const condA = a.condition ?? (a.rain ? 'light_rain' : 'clear');
  const condB = b.condition ?? (b.rain ? 'light_rain' : 'clear');
  return condA === condB && finite(a.tempC) && finite(b.tempC) && Math.abs(a.tempC - b.tempC) < CHANGE_TEMP_C;
}

/**
 * Payload for a `weather.changed` event at `at`, or null when the projected
 * weather `prev` already matches the current block (same sky, < 2 °C apart).
 * The payload is the block outcome itself — numbers and fixed labels only.
 */
export function weatherEvent(prev, at = now(), world, opts = {}) {
  const current = weatherAt(at, world, opts);
  if (prev && sameWeather(prev, current)) return null;
  return current;
}

/** Short neutral phrase for prompt lines: 'raining hard, 22°C', 'clear, 31°C'. */
export function weatherPhrase(w) {
  if (!w) return '';
  const label = {
    heavy_rain: 'raining hard',
    light_rain: 'light rain',
    rain: 'raining',          // a quick RAIN (owner)
    storm: 'stormy',          // 011 owner windows
    hot: 'scorching hot',
    cloudy: 'cloudy',
    clear: 'clear',
  }[w.condition ?? (w.rain ? 'light_rain' : 'clear')] || (w.rain ? 'raining' : 'clear');
  return finite(w.tempC) ? `${label}, ${w.tempC}°C` : label;
}
