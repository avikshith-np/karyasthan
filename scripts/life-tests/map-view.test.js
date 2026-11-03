// 014 map (plan §B.3) — life.mapView({date}) (src/life/mapView.js) and
// GET /api/life/map[?date=]:
//   - the pure builder on a hand-made state: route geometry by data contract
//     (travel.started.payload.routeEventId / a commute block's routeEventId →
//     a route.recorded → pts / 1e5, reversed for b → a), every fallback to a
//     straight line (no id, missing event, another type, an undone record, bad
//     points, a record between other places), undone trips left out, arrivals
//     paired, planned trips (rest of today only), place rows' area / venue,
//     home as a 400 m area, a date → that local day (no position, no planned
//     trips), a bad / impossible date → MapError;
//   - the engine: a simulated day on the example world → straight-line trips
//     (no route.recorded exists before 014 geo), mapData() unchanged;
//   - the route: shape, ?date=, 400 on a bad date, 401 without auth, off shape.
// Invented coordinates near (0,0); scratch DB, fake clock, mocked Jev; no network.
import {
  setupScratchDb, bootLife, simulateDays, simulateHours, fakeJevFixed, section, check, eq, report, PROJECT_ROOT,
} from '../arcs-tests/_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'life-map-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '7077',
  DASHBOARD_USER: USER, DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'life-map-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
  LIFE_MAP_TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
});

await setupScratchDb();
const { zonedToUnix } = await import('../../src/life/clock.js');
const { buildMapView, routePts, placeRow, dayBounds, MapError, HOME_RADIUS_M, MAP_TRIPS_SEC } = await import('../../src/life/mapView.js');

// ── the pure builder ────────────────────────────────────────────────────────
section('pure: route geometry by data contract');
const TZ = 'UTC';
const AT = zonedToUnix(2026, 10, 29, 12, 0, TZ);           // Thu 29 Oct 12:00 UTC
const H = 3600;
const places = new Map([
  ['place:home', { id: 'place:home', name: 'Home', kind: 'home', lat: 0.01, lon: 0.01 }],
  ['place:office', { id: 'place:office', name: 'Office', kind: 'office', lat: 0.048, lon: 0.042 }],
  ['place:cafe', { id: 'place:cafe', name: 'Test Bean', kind: 'cafe', lat: 0.016, lon: 0.0175, venue: { src: 'osm', ref: 'node/1', area: '  Invented Quarter ', kindTag: 'amenity=cafe' } }],
  ['place:gym', { id: 'place:gym', name: 'Gym', kind: 'gym', lat: 0.0135, lon: 0.006 }],
]);
const PTS = [[1000, 1000], [2500, 2200], [4800, 4200]];   // home → office, E5
const routes = {
  500: { id: 500, type: 'route.recorded', payload: { a: 'place:home', b: 'place:office', profile: 'car', km: 6, minutes: 14, pts: PTS } },
  501: { id: 501, type: 'plan.made', payload: { blocks: [] } },
  503: { id: 503, type: 'route.recorded', payload: { a: 'place:cafe', b: 'place:gym', pts: PTS } },
  504: { id: 504, type: 'route.recorded', payload: { a: 'place:home', b: 'place:office', pts: [[1000, 1000], [2500.5, 2200]] } },
  505: { id: 505, type: 'route.recorded', payload: { a: 'place:home', b: 'place:office', pts: Array.from({ length: 201 }, (_, i) => [i, i]) } },
  506: { id: 506, type: 'route.recorded', payload: { a: 'place:home', b: 'place:office', pts: PTS } },
  507: { id: 507, type: 'route.recorded', payload: { a: 'place:cafe', b: 'place:home', pts: [[1600, 1750], [1000, 1000]] } },
};
const getEvent = (id) => routes[id] ?? null;
const ev = (id, type, at, payload = {}, causeId = null) => ({ id, type, at, payload, causeId, actor: 'engine' });
const log = [
  ev(10, 'travel.started', AT - 30 * H, { from: 'place:home', to: 'place:office', mode: 'cab', minutes: 20, routeEventId: 500 }),
  ev(11, 'travel.arrived', AT - 30 * H + 25 * 60, { placeId: 'place:office' }, 10),
  ev(12, 'travel.started', AT - 20 * H, { from: 'place:office', to: 'place:home', mode: 'cab', minutes: 20, routeEventId: 500 }),
  ev(13, 'travel.started', AT - 10 * H, { from: 'place:home', to: 'place:office', mode: 'cab', minutes: 20, routeEventId: 501 }),
  ev(14, 'travel.started', AT - 9 * H, { from: 'place:office', to: 'place:home', mode: 'cab', minutes: 20, routeEventId: 502 }),
  ev(15, 'travel.started', AT - 8 * H, { from: 'place:home', to: 'place:office', mode: 'cab', minutes: 20, routeEventId: 503 }),
  ev(16, 'travel.started', AT - 7 * H, { from: 'place:office', to: 'place:home', mode: 'cab', minutes: 20, routeEventId: 500 }),
  ev(17, 'travel.started', AT - 6 * H, { from: 'place:home', to: 'place:office', mode: 'cab', minutes: 20, routeEventId: 504 }),
  ev(18, 'travel.started', AT - 5 * H, { from: 'place:office', to: 'place:home', mode: 'cab', minutes: 20, routeEventId: 505 }),
  ev(19, 'travel.started', AT - 4 * H, { from: 'place:home', to: 'place:office', mode: 'cab', minutes: 20, routeEventId: 506 }),
  ev(20, 'travel.started', AT - 3 * H, { from: 'place:office', to: 'place:cafe', mode: 'walk', minutes: 30 }),
  ev(21, 'travel.arrived', AT - 3 * H + 40 * 60, { placeId: 'place:cafe' }),
  ev(22, 'travel.started', AT - 60 * H, { from: 'place:home', to: 'place:gym', mode: 'walk', minutes: 10 }), // outside 48 h
];
const events = (from, to, types) => log.filter((e) => e.at >= from && e.at <= to && (!types || types.includes(e.type)));
const plan = {
  date: '2026-10-29',
  blocks: [
    { kind: 'commute', from: 'place:office', to: 'place:cafe', mode: 'walk', start: AT - 3 * H, end: AT - 3 * H + 1800 }, // already gone
    { kind: 'work', placeId: 'place:cafe', start: AT - 2 * H, end: AT + 2 * H },
    { kind: 'commute', from: 'place:cafe', to: 'place:home', mode: 'walk', start: AT + 2 * H, end: AT + 2 * H + 900, routeEventId: 507 },
    { kind: 'commute', from: 'place:home', to: 'place:gym', mode: 'walk', start: AT + 5 * H, end: AT + 5 * H + 600 },
  ],
};
const state = {
  world: { timezone: TZ },
  places,
  self: { homePlaceId: 'place:home' },
  position: { placeId: 'place:cafe', lat: 0.016, lon: 0.0175, travel: null },
  excluded: new Set([16, 506]),
  plan,
};
const v = buildMapView({ state, at: AT, events, getEvent });
const byId = new Map(v.trips.filter((t) => t.eventId).map((t) => [t.eventId, t]));
const E5 = PTS.map(([a, b]) => [a / 1e5, b / 1e5]);
eq('the window is the last 48 h', [v.from, v.to], [AT - MAP_TRIPS_SEC, AT]);
eq('past trip with a route.recorded → its pts / 1e5, a → b', byId.get(10)?.pts, E5);
eq('the same record for a b → a trip → reversed', byId.get(12)?.pts, [...E5].reverse());
check('routeEventId of another type → straight line', byId.has(13) && !('pts' in byId.get(13)));
check('routeEventId of a missing event → straight line', byId.has(14) && !('pts' in byId.get(14)));
check('a record between two other places → straight line', byId.has(15) && !('pts' in byId.get(15)));
check('non-integer points → straight line', byId.has(17) && !('pts' in byId.get(17)));
check('more than 200 points → straight line', byId.has(18) && !('pts' in byId.get(18)));
check('an undone route.recorded → straight line', byId.has(19) && !('pts' in byId.get(19)));
check('no routeEventId → straight line', byId.has(20) && !('pts' in byId.get(20)));
check('an undone trip is left out', !byId.has(16));
check('a trip older than 48 h is left out', !byId.has(22));
eq('arrival by cause, else the first uncaused one before the next start', [byId.get(10)?.arrivedAt, byId.get(20)?.arrivedAt, byId.get(12)?.arrivedAt],
  [AT - 30 * H + 25 * 60, AT - 3 * H + 40 * 60, null]);
eq('endAt = departure + the trip\'s minutes', byId.get(10)?.endAt, AT - 30 * H + 20 * 60);
eq('a past trip keeps the 009 keys (+ pts only when routed)', Object.keys(byId.get(20)).sort(), ['arrivedAt', 'endAt', 'eventId', 'from', 'mode', 'startAt', 'to']);

section('pure: planned trips, places, home');
const planned = v.trips.filter((t) => t.planned);
eq('planned = the plan\'s commutes still ahead, after his last departure', planned.map((t) => [t.from, t.to]), [['place:cafe', 'place:home'], ['place:home', 'place:gym']]);
eq('a planned trip with a routeEventId → that record\'s pts (cafe → home is a → b: as stored)', planned[0]?.pts, [[0.016, 0.0175], [0.01, 0.01]]);
check('planned trips carry planned:true, eventId null, arrivedAt null and come after the past ones',
  planned.every((t) => t.planned === true && t.eventId === null && t.arrivedAt === null) && v.trips.indexOf(planned[0]) === v.trips.length - 2);
check('another day\'s plan adds no planned trips', !buildMapView({ state: { ...state, plan: { ...plan, date: '2026-10-28' } }, at: AT, events, getEvent }).trips.some((t) => t.planned));
const cafe = v.places.find((p) => p.id === 'place:cafe');
const gym = v.places.find((p) => p.id === 'place:gym');
eq('a real venue: area (trimmed) + venue true', [cafe?.area, cafe?.venue], ['Invented Quarter', true]);
eq('a plain place: area null, venue false', [gym?.area, gym?.venue], [null, false]);
eq('place rows: 009\'s fields + area + venue', Object.keys(gym).sort(), ['area', 'id', 'kind', 'lat', 'lon', 'name', 'venue']);
eq('home is an area around his home place', v.home, { placeId: 'place:home', lat: 0.01, lon: 0.01, radiusM: HOME_RADIUS_M });
eq('home radius is 400 m', HOME_RADIUS_M, 400);
eq('position now', [v.position?.placeId, v.position?.travelling], ['place:cafe', false]);
eq('no home place → home null', buildMapView({ state: { ...state, self: { homePlaceId: 'place:none' } }, at: AT, events, getEvent }).home, null);
eq('placeRow ignores a non-object venue / blank area', placeRow({ id: 'x', name: 'X', kind: 'k', lat: 0, lon: 0, venue: { area: '   ' } }).area, null);

section('pure: a date');
const d28 = buildMapView({ state, at: AT, date: '2026-10-28', events, getEvent });
const b28 = dayBounds('2026-10-28', TZ);
eq('a date → that local day', [d28.from, d28.to, d28.date], [b28.d0, b28.d1, '2026-10-28']);
eq('only that day\'s departures', d28.trips.map((t) => t.eventId), [10, 12]);
check('another day: no position, no planned trips', d28.position === null && !d28.trips.some((t) => t.planned));
const d29 = buildMapView({ state, at: AT, date: '2026-10-29', events, getEvent });
check('today by date: up to now + the planned rest of today, with his position',
  d29.trips.some((t) => t.eventId === 20) && !d29.trips.some((t) => t.eventId === 12) && d29.trips.filter((t) => t.planned).length === 2 && d29.position?.placeId === 'place:cafe');
// A trip leaving just before midnight that arrives after it.
const late = [ev(30, 'travel.started', b28.d1 - 600, { from: 'place:gym', to: 'place:home', minutes: 20 }), ev(31, 'travel.arrived', b28.d1 + 600, {}, 30)];
const dl = buildMapView({ state, at: AT, date: '2026-10-28', events: (f, t, ty) => late.filter((e) => e.at >= f && e.at <= t && ty.includes(e.type)), getEvent });
eq('an arrival after midnight still pairs with its departure', dl.trips.map((t) => [t.eventId, t.arrivedAt]), [[30, b28.d1 + 600]]);
const fut = buildMapView({ state, at: AT, date: '2026-10-30', events, getEvent });
eq('tomorrow: nothing has happened yet', fut.trips, []);
for (const bad of ['2026-02-31', '29-10-2026', '2026-1-1', 'x']) {
  let code = null;
  try { buildMapView({ state, at: AT, date: bad, events, getEvent }); } catch (err) { code = err instanceof MapError ? err.code : err.message; }
  eq(`bad date ${bad} → MapError bad_date`, code, 'bad_date');
}
eq('routePts: a getEvent that throws → null', routePts({ from: 'a', to: 'b', routeEventId: 5 }, () => { throw new Error('db'); }), null);

// ── the engine ───────────────────────────────────────────────────────────────
section('engine: a simulated day');
const { life, world } = await bootLife({ jev: fakeJevFixed({ go: 0.5, late: 0.2, stay: 0.3 }) });
void world;
await simulateDays(1);
await simulateHours(3);                                   // → Wed 28 Oct 09:00
const s = life.getState();
const m = life.mapView();
check('mapView: places of the projection, his position, trips', m.places.length === s.places.size && !!m.position && Array.isArray(m.trips));
check('trips happened (straight lines: no route.recorded before 014 geo)', m.trips.some((t) => !t.planned) && m.trips.every((t) => !('pts' in t)), m.trips.length);
check('every trip names its places and times', m.trips.every((t) => s.places.has(t.from) && s.places.has(t.to) && t.endAt >= t.startAt));
check('every place row: area null, venue false (no venues yet)', m.places.every((p) => p.area === null && p.venue === false));
eq('home = his home place as a 400 m area', [m.home?.placeId, m.home?.radiusM], [s.self.homePlaceId, 400]);
const md = life.mapData();
eq('mapData() is unchanged: 009 place fields only', Object.keys(md.places[0]).sort(), ['id', 'kind', 'lat', 'lon', 'name']);
eq('mapData() trips: 009 fields only', Object.keys(md.trips[0] || {}).sort(), ['arrivedAt', 'endAt', 'eventId', 'from', 'mode', 'startAt', 'to']);
eq('mapView\'s past trips are mapData\'s (same window)', m.trips.filter((t) => !t.planned).map((t) => t.eventId), md.trips.map((t) => t.eventId));
const y = life.mapView({ date: '2026-10-27' });
check('a past date: that day\'s trips, no position', y.position === null && y.trips.every((t) => !t.planned) && y.trips.every((t) => t.startAt >= y.from && t.startAt < y.to));

// ── the route ────────────────────────────────────────────────────────────────
section('the route');
const { startDashboard } = await import('../../src/dashboard/server.js');
const app = await startDashboard({ getSock: () => null });
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const get = async (url, auth = true) => {
  const res = await app.inject({ method: 'GET', url, headers: auth ? { authorization: AUTH } : {} });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
};
eq('no credentials → 401', (await get('/api/life/map', false)).status, 401);
const r = await get('/api/life/map');
check('200 running with places, trips, home, position and the tile settings',
  r.status === 200 && r.json?.running === true && Array.isArray(r.json.places) && Array.isArray(r.json.trips)
  && r.json.home?.radiusM === 400 && !!r.json.position && r.json.tileUrl === process.env.LIFE_MAP_TILE_URL && r.json.attribution === '© OpenStreetMap contributors', r.json);
const rd = await get('/api/life/map?date=2026-10-27');
check('?date= → that day', rd.status === 200 && rd.json?.date === '2026-10-27' && rd.json.position === null && Number.isSafeInteger(rd.json.from));
eq('malformed date → 400', (await get('/api/life/map?date=27-10-2026')).status, 400);
eq('impossible date → 400', (await get('/api/life/map?date=2026-02-31')).status, 400);
eq('empty date = no date', (await get('/api/life/map?date=')).json?.date, null);
await life.stopLife();
const off = await get('/api/life/map');
check('engine stopped → the off shape (running false, home null, tile settings kept)',
  off.status === 200 && off.json?.running === false && off.json.home === null && Array.isArray(off.json.trips) && 'tileUrl' in off.json && 'attribution' in off.json, off.json);
await app.close();

report();
