// Life · Map / Life · Day's trip map (spec 014 §B.3): places, his position,
// past trips from the log and the rest of today's planned trips, each with the
// road geometry it was planned with when there is one. Read only, pure: the
// facade (src/life/index.js mapView) hands it the state, the clock and two
// readers (events in a time range, one event by id). No geo code: route
// geometry is found by data contract only (plan §P.3.4) —
//   travel.started.payload.routeEventId (past) / a commute block's routeEventId
//   (planned) → that event, of type route.recorded, not undone → payload.pts
//   ([latE5, lonE5] integers, ordered a → b) / 1e5, reversed when the trip runs
//   b → a.
// Absent at any step (no id, missing event, another type, bad points, the trip
// isn't between the record's two places) → no pts: the page draws a straight
// line. A past trip keeps the geometry it was planned with after a place moves
// (R38). Place rows carry `area` (place.venue?.area ?? null) and `venue`
// (!!place.venue): null / false until a place has a real venue (014 geo).

import { dateKey, addDays, zonedToUnix } from './clock.js';
import { positionAt, isExcludedId } from './projector.js';

export const MAP_TRIPS_SEC = 48 * 3600;   // date null: the last 48 h
export const HOME_RADIUS_M = 400;         // home is drawn as an area, not a pin
export const PTS_MAX = 200;               // route.recorded's bound (plan §1.2)
const ARRIVAL_SLACK_SEC = 6 * 3600;       // a trip leaving late in the window may arrive after it
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AREA_MAX = 80;

export class MapError extends Error {
  constructor(code) { super(`map: ${code}`); this.name = 'MapError'; this.code = code; }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Local-day bounds of 'YYYY-MM-DD' in tz, or null for a malformed / impossible date. */
export function dayBounds(date, tz) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const d0 = zonedToUnix(y, m, d, 0, 0, tz);
  if (!finite(d0) || dateKey(d0, tz) !== date) return null;
  return { d0, d1: addDays(d0, 1, tz) };
}

/** A place row of the map: 009's fields plus 014's venue flag and area. */
export function placeRow(p) {
  const area = typeof p?.venue?.area === 'string' && p.venue.area.trim() ? p.venue.area.trim().slice(0, AREA_MAX) : null;
  return { id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, area, venue: isObj(p.venue) };
}

/**
 * The geometry of a trip by data contract, as [[lat, lon]…] ordered from
 * trip.from to trip.to, or null (→ a straight line). `routeEventId` is read
 * from the trip (copied from the travel.started payload / plan block).
 */
export function routePts(trip, getEvent, isOut = () => false) {
  const id = trip?.routeEventId;
  if (!posInt(id) || typeof getEvent !== 'function') return null;
  let ev;
  try { ev = getEvent(id); } catch { return null; }
  if (!ev || ev.type !== 'route.recorded' || ev.id !== id || isOut(id)) return null;
  const p = ev.payload;
  if (!isObj(p) || !Array.isArray(p.pts) || p.pts.length < 2 || p.pts.length > PTS_MAX) return null;
  const out = [];
  for (const q of p.pts) {
    if (!Array.isArray(q) || q.length !== 2 || !Number.isSafeInteger(q[0]) || !Number.isSafeInteger(q[1])) return null;
    if (Math.abs(q[0]) > 9_000_000 || Math.abs(q[1]) > 18_000_000) return null;
    out.push([q[0] / 1e5, q[1] / 1e5]);
  }
  if (trip.from === p.a && trip.to === p.b) return out;
  if (trip.from === p.b && trip.to === p.a) return out.reverse();
  return null;
}

/**
 * Past trips: every travel.started in [from, to) (undone ones left out), with
 * its arrival — the travel.arrived caused by that start, else the first one
 * before the next departure (as mapData) — and its planned arrival (endAt).
 */
function pastTrips(evs, isOut, getEvent) {
  const live = evs.filter((ev) => !isOut(ev.id));
  const starts = live.filter((ev) => ev.type === 'travel.started');
  const arrivals = live.filter((ev) => ev.type === 'travel.arrived');
  const used = new Set();
  return starts.map((ev, i) => {
    const nextStart = starts[i + 1]?.at ?? Infinity;
    const arrived = arrivals.find((a) => !used.has(a.id) && a.causeId === ev.id)
      || arrivals.find((a) => !used.has(a.id) && a.causeId == null && a.at >= ev.at && a.at <= nextStart);
    if (arrived) used.add(arrived.id);
    const p = ev.payload || {};
    const trip = {
      from: p.from ?? null, to: p.to ?? null, mode: p.mode ?? null,
      startAt: ev.at, endAt: ev.at + Math.round((Number(p.minutes) || 0) * 60),
      arrivedAt: arrived?.at ?? null, eventId: ev.id,
    };
    const pts = routePts({ ...trip, routeEventId: p.routeEventId }, getEvent, isOut);
    if (pts) trip.pts = pts;
    return trip;
  });
}

/**
 * Planned trips: the plan in force's commute blocks that haven't started —
 * on the plan's own date, starting after his latest departure and still ahead.
 */
function plannedTrips(plan, { at, lastStartAt, getEvent, isOut }) {
  if (!plan || !Array.isArray(plan.blocks)) return [];
  const out = [];
  for (const b of plan.blocks) {
    if (b?.kind !== 'commute' || !b.from || !b.to || !finite(b.start) || !finite(b.end)) continue;
    if (b.end <= at || b.start <= lastStartAt) continue;
    const trip = {
      from: b.from, to: b.to, mode: b.mode ?? null, startAt: b.start, endAt: b.end,
      arrivedAt: null, eventId: null, planned: true,
    };
    const pts = routePts({ ...trip, routeEventId: b.routeEventId }, getEvent, isOut);
    if (pts) trip.pts = pts;
    out.push(trip);
  }
  return out.sort((a, b) => a.startAt - b.startAt);
}

/**
 * The map view. date null → the last 48 h plus the rest of today's planned
 * trips and his position now; 'YYYY-MM-DD' → that local day (planned trips and
 * his position only when it is today). Throws MapError('bad_date').
 *   events(from, to, types) → world events in [from, to] (any order)
 *   getEvent(id)            → one event or null
 */
export function buildMapView({ state, world = null, at, date = null, events, getEvent }) {
  const tz = state?.world?.timezone ?? world?.timezone;
  const isOut = (id) => isExcludedId(state, id);
  const todayKey = dateKey(at, tz);
  let from;
  let to;          // the window's end (date: the next local midnight)
  let lastDeparture; // the latest departure the window takes (inclusive; never in the future)
  let isToday;
  if (date == null) {
    from = at - MAP_TRIPS_SEC;
    to = at;
    lastDeparture = at;
    isToday = true;
  } else {
    const b = dayBounds(date, tz);
    if (!b) throw new MapError('bad_date');
    from = b.d0;
    to = b.d1;
    lastDeparture = Math.min(b.d1 - 1, at);
    isToday = date === todayKey;
  }
  const places = state?.places instanceof Map ? [...state.places.values()].map(placeRow) : [];
  let trips = [];
  if (lastDeparture >= from) {
    // Departures inside the window; arrivals up to the slack after it (never past now).
    const evs = (events(from, Math.min(at, lastDeparture + ARRIVAL_SLACK_SEC), ['travel.started', 'travel.arrived']) || [])
      .filter((ev) => ev.type !== 'travel.started' || ev.at <= lastDeparture)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    trips = pastTrips(evs, isOut, getEvent);
  }
  if (isToday && state?.plan?.date === todayKey) {
    const lastStartAt = trips.length ? trips[trips.length - 1].startAt : -Infinity;
    trips = trips.concat(plannedTrips(state.plan, { at, lastStartAt, getEvent, isOut }));
  }
  const homeId = state?.self?.homePlaceId ?? world?.self?.homePlaceId ?? null;
  const home = homeId ? state?.places?.get?.(homeId) : null;
  return {
    date: date ?? null,
    from,
    to,
    places,
    position: isToday ? positionAt(state, at) : null,
    trips,
    home: home && finite(home.lat) && finite(home.lon) ? { placeId: homeId, lat: home.lat, lon: home.lon, radiusM: HOME_RADIUS_M } : null,
  };
}
