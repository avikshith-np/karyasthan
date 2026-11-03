import { config } from '../utils/config.js';
// 014 geo: stored road routes (pure; read from world.routes via worldOverlay).
import { routeFor } from './places.js';

// Travel between places (spec 009 plan §R5). Pure: no I/O, no clock, no RNG.
//
//   minutes = overhead(mode) + km × roadFactor ÷ speedsKmh[mode] × 60 × peakFactor(at)
//
// km is the straight-line (haversine) distance; roadFactor turns it into road
// distance. Every constant (speeds, overheads, peak windows, road factor, costs)
// comes from world.travel — nothing city-specific lives in code. `world` is the
// normalized object from world.js (loadWorld/validateWorld); `weather` is the
// projection's { rain, tempC, until } or null (= dry).

const EARTH_RADIUS_KM = 6371;
const DEFAULT_WEEKEND = [0, 6]; // 0 = Sunday, as in world.routine

// Intl formatters are costly to build; one per timezone.
const formatters = new Map();
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zoneOf(world) {
  return world?.timezone || config.timezone || 'UTC';
}

// Weekday (0–6) and minute-of-day of a unix time in the world's timezone.
// Kept local (not clock.js) so travel math has no dependency beyond config.
function localParts(at, timezone) {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timezone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(at * 1000))) parts[p.type] = p.value;
  return { weekday: WEEKDAYS[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** "HH:MM" → minutes since midnight (NaN if malformed). */
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Great-circle distance in km between two { lat, lon } points. */
export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Traffic multiplier at unix time `at`: on weekdays, the largest factor of the
 * world's peakWindows covering that minute (1 when none does; a window whose
 * `from` is after its `to` wraps past midnight); on weekend days
 * (world.routine.weekend) a flat world.travel.weekendFactor (default 1).
 */
// Road traffic slows road modes only: a walk or a metro ride takes as long in
// the rush hour as at noon.
export const PEAK_EXEMPT = new Set(['walk', 'metro']);

export function peakFactor(at, world) {
  const travel = world?.travel || {};
  const { weekday, minute } = localParts(at, zoneOf(world));
  const weekend = Array.isArray(world?.routine?.weekend) ? world.routine.weekend : DEFAULT_WEEKEND;
  if (weekend.includes(weekday)) return Number.isFinite(travel.weekendFactor) ? travel.weekendFactor : 1;

  let factor = 1;
  for (const w of travel.peakWindows || []) {
    const from = hhmmToMinutes(w.from);
    const to = hhmmToMinutes(w.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(w.factor)) continue;
    const inside = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
    if (inside && w.factor > factor) factor = w.factor;
  }
  return factor;
}

/**
 * Mode for a trip of `km` straight-line kilometres. Rain switches to a cab
 * whatever the distance (spec FR-010 — he doesn't walk 800 m in a downpour);
 * dry, he walks up to world.travel.walkMaxKm, else takes the world's defaultMode.
 */
export function chooseMode(km, weather, world) {
  const travel = world?.travel || {};
  if (weather?.rain) return 'cab';
  if (km <= (travel.walkMaxKm ?? 0)) return 'walk';
  return travel.defaultMode || 'cab';
}

/** Money spent on `km` straight-line km by `mode` (road distance × costPerKm), 2 dp. */
export function travelCost(km, mode, world) {
  const travel = world?.travel || {};
  const perKm = travel.costPerKm?.[mode] ?? 0;
  return Math.round(km * (travel.roadFactor ?? 1) * perKm * 100) / 100;
}

// A place id (resolved against world.places, array or Map) or a { lat, lon }.
function resolvePoint(p, world) {
  if (p && typeof p === 'object' && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return p;
  if (typeof p === 'string') {
    const places = world?.places;
    const place = places instanceof Map ? places.get(p) : (places || []).find((x) => x.id === p);
    if (place) return place;
  }
  throw new Error(`travel: unknown place ${typeof p === 'string' ? p : JSON.stringify(p)}`);
}

/**
 * Full trip from `from` to `to` (place ids or { lat, lon }) leaving at unix `at`.
 * Returns { from, to, mode, km, minutes, cost }: `from`/`to` are place ids when
 * given ids (null for raw coordinates), km is straight-line (3 dp), minutes a
 * whole number ≥ 1 for any real distance. The same spot is a zero trip (no
 * overhead). `opts.mode` forces a mode (e.g. a decision option "take a cab").
 * The payload shape of travel.started / travel.arrived events.
 */
export function planTrip(from, to, at, weather, world, opts = {}) {
  const a = resolvePoint(from, world);
  const b = resolvePoint(to, world);
  const ids = { from: typeof from === 'string' ? from : null, to: typeof to === 'string' ? to : null };
  const km = haversineKm(a, b);
  if (km < 0.001) return { ...ids, mode: 'walk', km: 0, minutes: 0, cost: 0 };

  const travel = world?.travel || {};
  const mode = opts.mode || chooseMode(km, weather, world);
  const speed = travel.speedsKmh?.[mode];
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`travel: no speed for mode ${mode}`);
  const peak = PEAK_EXEMPT.has(mode) ? 1 : peakFactor(at, world);
  // 014 geo (plan §A2.2, R33): a stored road route between two known places →
  // the world's own speed model on the ROAD distance (OSRM's free-flow minutes
  // are display only), cost per road km (no roadFactor). Keys appear only when
  // routed, so an unrouted trip is byte-identical to before.
  const road = ids.from && ids.to ? roadRoute(world, ids.from, ids.to, mode) : null;
  if (road) {
    const minutesR = Math.max(1, Math.round((travel.overheadMin?.[mode] ?? 0) + (road.km / speed) * 60 * peak));
    const costR = Math.round(road.km * (travel.costPerKm?.[mode] ?? 0) * 100) / 100;
    return {
      ...ids, mode, km: Math.round(km * 1000) / 1000, minutes: minutesR, cost: costR,
      roadKm: Math.round(road.km * 1000) / 1000, routed: true, routeKey: road.key,
      ...(Number.isSafeInteger(road.eventId) && road.eventId > 0 ? { routeEventId: road.eventId } : {}),
    };
  }
  const moving = ((km * (travel.roadFactor ?? 1)) / speed) * 60 * peak;
  const minutes = Math.max(1, Math.round((travel.overheadMin?.[mode] ?? 0) + moving));
  return { ...ids, mode, km: Math.round(km * 1000) / 1000, minutes, cost: travelCost(km, mode, world) };
}

/** The 014 route keys of a planned trip (only when routed) — for commute blocks and travel.started. */
export function routedFields(tr) {
  if (!tr || tr.routed !== true) return {};
  return {
    routed: true,
    ...(Number.isFinite(tr.roadKm) ? { roadKm: tr.roadKm } : {}),
    ...(typeof tr.routeKey === 'string' ? { routeKey: tr.routeKey } : {}),
    ...(Number.isSafeInteger(tr.routeEventId) ? { routeEventId: tr.routeEventId } : {}),
  };
}

// Road modes ride the car route; walk/cycle the foot route, else the car
// route's distance; metro and unknown modes keep today's estimate.
export const CAR_LIKE_MODES = Object.freeze(['cab', 'car', 'drive', 'scooter', 'motorbike', 'bike', 'bus']);
export const FOOT_MODES = Object.freeze(['walk', 'cycle']);

function roadRoute(world, from, to, mode) {
  if (!world?.routes) return null;
  if (CAR_LIKE_MODES.includes(mode)) return routeFor(world, from, to, 'car');
  if (FOOT_MODES.includes(mode)) return routeFor(world, from, to, 'foot') ?? routeFor(world, from, to, 'car');
  return null;
}

/** Minutes to get from `from` to `to` leaving at `at` (planTrip(...).minutes). */
export function travelMinutes(from, to, at, weather, world, opts = {}) {
  return planTrip(from, to, at, weather, world, opts).minutes;
}

/** Straight-line position a fraction `frac` (clamped 0–1) of the way from a to b. */
export function lerpPosition(a, b, frac) {
  const f = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 0));
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}
