// 014 geo (plan §A2, §4 life-tests/52): road routes in the world.
//   fold       route.recorded: unordered key, newest wins, bounds, unknown ids
//              kept, s.routes / s.placesSig only once a 014 event folds;
//              snapshot round trip = full replay (R24)
//   travel     planTrip on a stored route = roadKm / speed × 60 × peak + overhead
//              (OSRM minutes ignored), cost roadKm × perKm (R33); foot route for
//              walks, else the car route; metro → today's estimate; a 50 m move
//              → the estimate; routed keys only when routed (byte-identical else)
//   blocks     cleanBlock keeps roadKm / routed / routeKey / routeEventId;
//              routedFields; rewind keeps route.recorded (REWIND_KEEP)
// Invented coordinates near (0,0), no network.
import { section, check, eq, report } from './_helpers.js';

const projector = await import('../../src/life/projector.js');
const { planTrip, routedFields } = await import('../../src/life/travel.js');
const { worldWithPlaces, routeFor, routeKey } = await import('../../src/life/places.js');
const { isRewindKept, worldOverlay } = await import('../../src/life/story/reducer.js');

const T0 = Date.UTC(2026, 9, 27, 12, 0) / 1000;   // a Tuesday, off-peak (UTC world)
const world = {
  timezone: 'UTC',
  self: { birthdate: '1999-04-12', homePlaceId: 'place:home', job: { title: 'X', employerName: 'Y', officePlaceId: 'place:office' } },
  routine: { weekend: [0, 6] },
  places: [
    { id: 'place:home', name: 'Home', kind: 'home', lat: 0.01, lon: 0.01 },
    { id: 'place:office', name: 'Office', kind: 'office', lat: 0.05, lon: 0.04 },
    { id: 'place:cafe', name: 'Cafe', kind: 'cafe', lat: 0.016, lon: 0.0175 },
  ],
  cast: [],
  travel: {
    roadFactor: 1.35, speedsKmh: { walk: 4.5, scooter: 22, metro: 30, cab: 20 }, overheadMin: { walk: 0, scooter: 5, metro: 10, cab: 8 },
    peakWindows: [], weekendFactor: 1, walkMaxKm: 1.2, defaultMode: 'scooter', costPerKm: { walk: 0, scooter: 2, metro: 1, cab: 15 },
  },
};

let id = 0;
const ev = (type, payload, extra = {}) => ({ id: ++id, at: T0 + id, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra });
const owner = (type, payload) => ev(type, payload, { actor: 'owner', originKind: 'owner', originJid: 'owner' });

function base() {
  id = 0;
  let s = projector.createInitialState(world);
  s = projector.project(s, ev('genesis', { source: 'test', timezone: 'UTC', self: world.self }), world);
  for (const p of world.places) s = projector.project(s, ev('place.created', { ...p }), world);
  return s;
}
const route = (a, b, profile, km, extra = {}) => ({
  a, b, profile, km, minutes: 7, src: 'osrm',
  aAt: { ...world.places.find(p => p.id === a) }, bAt: { ...world.places.find(p => p.id === b) },
  pts: [[1000, 1000], [1600, 1750]], ...extra,
});
const latLon = (o) => ({ lat: o.lat, lon: o.lon });

section('fold');
{
  let s = base();
  check('no 014 event → no routes, no placesSig', !('routes' in s) && !('placesSig' in s));
  check('…and worldWithPlaces / worldOverlay are the world itself', worldWithPlaces(s, world) === world && worldOverlay(s, world) === world);
  const r1 = route('place:cafe', 'place:home', 'car', 2.5);
  r1.aAt = latLon(world.places[2]); r1.bAt = latLon(world.places[0]);
  s = projector.project(s, owner('route.recorded', r1), world);
  const key = 'place:cafe|place:home|car';
  check('folded under the unordered key', !!s.routes?.[key] && s.routes[key].km === 2.5 && s.routes[key].eventId === id);
  check('placesSig set', typeof s.placesSig === 'string' && s.placesSig.length > 0);
  const sig1 = s.placesSig;
  s = projector.project(s, owner('route.recorded', { ...r1, km: 3.1 }), world);
  eq('newest wins', s.routes[key].km, 3.1);
  check('…and the signature changed', s.placesSig !== sig1);
  const bad = [
    { ...r1, a: 'place:home', b: 'place:cafe' },            // a > b
    { ...r1, km: 5000 }, { ...r1, minutes: -1 }, { ...r1, profile: 'bike' },
    { ...r1, pts: Array.from({ length: 201 }, () => [1, 1]) }, { ...r1, pts: [[1.5, 2]] }, { ...r1, pts: [[91e5, 0]] },
    { ...r1, aAt: { lat: 'x', lon: 0 } },
  ];
  for (const p of bad) {
    const before = JSON.stringify(s.routes);
    s = projector.project(s, owner('route.recorded', p), world);
    check(`refused at fold: ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k, v]) => r1[k] !== v))).slice(0, 60)}`, JSON.stringify(s.routes) === before);
  }
  s = projector.project(s, owner('route.recorded', { ...route('place:cafe', 'place:zzz-later', 'car', 1), bAt: { lat: 0.02, lon: 0.02 } }), world);
  check('an unknown place id is kept (a later place may appear)', !!s.routes['place:cafe|place:zzz-later|car']);
  const snap = projector.deserializeState(JSON.parse(JSON.stringify(projector.serializeState(s))));
  eq('snapshot round trip keeps routes and placesSig', [JSON.stringify(snap.routes), snap.placesSig], [JSON.stringify(s.routes), s.placesSig]);
  check('rewind keeps route.recorded (bookkeeping)', isRewindKept({ type: 'route.recorded', payload: {} }));
}

section('travel on a stored route (R33)');
{
  let s = base();
  const home = world.places[0];
  const cafe = world.places[2];
  const office = world.places[1];
  const rc = { ...route('place:home', 'place:office', 'car', 9.0), aAt: latLon(home), bAt: latLon(office) };
  s = projector.project(s, owner('route.recorded', rc), world);
  const routeEventId = id;
  const W = worldWithPlaces(s, world);
  check('the overlaid world carries routes', !!W.routes && W !== world);
  const est = planTrip('place:home', 'place:office', T0, null, world);
  const tr = planTrip('place:home', 'place:office', T0, null, W);
  eq('mode from the straight-line km (unchanged)', tr.mode, est.mode);
  eq('km stays straight-line', tr.km, est.km);
  eq('minutes = overhead + roadKm / speed × 60 (OSRM minutes ignored)', tr.minutes, Math.round(5 + (9.0 / 22) * 60));
  eq('cost = roadKm × perKm (no roadFactor)', tr.cost, Math.round(9.0 * 2 * 100) / 100);
  eq('routed keys', [tr.roadKm, tr.routed, tr.routeKey, tr.routeEventId], [9, true, 'place:home|place:office|car', routeEventId]);
  eq('the reverse direction uses the same record', planTrip('place:office', 'place:home', T0, null, W).routeKey, 'place:home|place:office|car');
  eq('metro keeps today\'s estimate', planTrip('place:home', 'place:office', T0, null, W, { mode: 'metro' }), planTrip('place:home', 'place:office', T0, null, world, { mode: 'metro' }));
  check('unrouted payload is byte-identical (no extra keys)', JSON.stringify(planTrip('place:home', 'place:cafe', T0, null, W)) === JSON.stringify(planTrip('place:home', 'place:cafe', T0, null, world)));
  const walkCar = planTrip('place:home', 'place:office', T0, null, W, { mode: 'walk' });
  eq('a walk with no foot route uses the car route\'s distance', walkCar.minutes, Math.round((9.0 / 4.5) * 60));
  s = projector.project(s, owner('route.recorded', { ...rc, profile: 'foot', km: 7.5 }), world);
  const W2 = worldWithPlaces(s, world);
  eq('…and the foot route when there is one', planTrip('place:home', 'place:office', T0, null, W2, { mode: 'walk' }).roadKm, 7.5);
  eq('…while a scooter keeps the car route', planTrip('place:home', 'place:office', T0, null, W2).roadKm, 9);
  // An endpoint moved more than 50 m → the route no longer matches.
  s = projector.project(s, owner('place.updated', { placeId: 'place:office', lat: office.lat + 0.001, lon: office.lon }), world);
  const W3 = worldWithPlaces(s, world);
  eq('a 110 m move → no route', routeFor(W3, 'place:home', 'place:office', 'car'), null);
  check('…and the trip is today\'s estimate again', planTrip('place:home', 'place:office', T0, null, W3).routed === undefined);
  void cafe;
}

section('blocks and travel.started');
{
  const tr = { from: 'place:home', to: 'place:office', mode: 'scooter', km: 5, minutes: 30, cost: 18, roadKm: 9, routed: true, routeKey: 'place:home|place:office|car', routeEventId: 7 };
  eq('routedFields', routedFields(tr), { routed: true, roadKm: 9, routeKey: 'place:home|place:office|car', routeEventId: 7 });
  eq('routedFields of an unrouted trip', routedFields({ km: 1 }), {});
  let s = base();
  const block = { kind: 'commute', placeId: null, start: T0 + 100, end: T0 + 1900, from: 'place:home', to: 'place:office', mode: 'scooter', km: 5, minutes: 30, cost: 18, availability: 'light', withCast: [], ...routedFields(tr) };
  s = projector.project(s, ev('plan.made', { date: '2026-10-27', dayType: 'office', wakeAt: T0, blocks: [block] }), world);
  const b = s.plan?.blocks?.[0];
  eq('cleanBlock keeps the route keys', [b?.roadKm, b?.routed, b?.routeKey, b?.routeEventId], [9, true, 'place:home|place:office|car', 7]);
  s = projector.project(s, ev('plan.made', { date: '2026-10-27', dayType: 'office', wakeAt: T0, blocks: [{ ...block, routeKey: 'nope', routeEventId: -1 }] }), world);
  eq('…and drops malformed ones', [s.plan.blocks[0].routeKey, s.plan.blocks[0].routeEventId], [undefined, undefined]);
  eq('routeKey helper: unordered, profile-checked', [routeKey('place:b', 'place:a', 'car'), routeKey('place:a', 'place:a', 'car'), routeKey('place:a', 'place:b', 'bike')], ['place:a|place:b|car', null, null]);
}

report();
