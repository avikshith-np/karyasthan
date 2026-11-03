// 014 geo (plan §A0, §4 life-tests/50): projected places are authoritative.
//   identity   no 014 event and genesis places matching the file → the world
//              itself (every pre-014 fixture untouched); a name-only rename
//              leaves placesSig unset and the identity intact
//   fix (R28)  an owner-created place resolves in planTrip / tripFor /
//              amendPlanForOuting (it threw `unknown place` before); a projected
//              move wins over the file's coordinates
//   memo (R27) story.worldOf / worldOverlay never share a result between two
//              states whose places differ (a preview and a live state)
//   seams      reconciler / decisions use the one merge (no file-wins copy left)
// Invented coordinates near (0,0); no network.
import fs from 'fs';
import path from 'path';
import { section, check, eq, report, PROJECT_ROOT } from './_helpers.js';

const projector = await import('../../src/life/projector.js');
const { planTrip } = await import('../../src/life/travel.js');
const { tripFor } = await import('../../src/life/decisions.js');
const { amendPlanForOuting } = await import('../../src/life/pulse.js');
const { worldWithPlaces, placesKey } = await import('../../src/life/places.js');
const { worldOverlay } = await import('../../src/life/story/reducer.js');
const story = await import('../../src/life/story/index.js');

const T0 = Date.UTC(2026, 9, 27, 12, 0) / 1000;
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
    roadFactor: 1.35, speedsKmh: { walk: 4.5, scooter: 22, cab: 20 }, overheadMin: { walk: 0, scooter: 5, cab: 8 },
    peakWindows: [], weekendFactor: 1, walkMaxKm: 1.2, defaultMode: 'scooter', costPerKm: { walk: 0, scooter: 2, cab: 15 },
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

section('identity (golden-inert)');
{
  let s = base();
  eq('placesKey is empty', placesKey(s, world), '');
  check('worldWithPlaces → the world itself', worldWithPlaces(s, world) === world);
  check('worldOverlay → the world itself', worldOverlay(s, world) === world);
  check('story.worldOf → the world itself', story.worldOf(s, world) === world);
  s = projector.project(s, owner('place.updated', { placeId: 'place:cafe', name: 'Corner Cafe' }), world);
  check('a name-only rename leaves placesSig unset', !('placesSig' in s));
  check('…and the identity intact', worldOverlay(s, world) === world);
  eq('…the rename itself folds (ownerNamed: R16)', [s.places.get('place:cafe').name, s.places.get('place:cafe').ownerNamed], ['Corner Cafe', true]);
}

section('event-created and moved places resolve (R28)');
{
  let s = base();
  s = projector.project(s, owner('place.created', { id: 'place:new-spot', name: 'New spot', kind: 'bar', lat: 0.02, lon: 0.022 }), world);
  let threw = false;
  try { planTrip('place:home', 'place:new-spot', T0, null, world); } catch { threw = true; }
  check('the file world alone does not know it (before 014: unknown place)', threw);
  const W = worldOverlay(s, world);
  check('the overlay is a copy that knows it', W !== world && W.places.some(p => p.id === 'place:new-spot'));
  check('…and the file world is untouched', world.places.length === 3);
  check('planTrip resolves it', planTrip('place:home', 'place:new-spot', T0, null, W).minutes > 0);
  check('decisions.tripFor resolves it', tripFor('place:home', 'place:new-spot', T0 + 3600, null, W).minutes > 0);
  const plan = { date: '2026-10-27', eventId: 2, wakeAt: T0 - 6 * 3600, blocks: [{ kind: 'free', placeId: 'place:home', start: T0 - 3600, end: T0 + 10 * 3600, availability: 'free', withCast: [] }] };
  s = { ...s, plan, position: { placeId: 'place:home', lat: 0.01, lon: 0.01 }, activity: { kind: 'free', placeId: 'place:home' } };
  const d = { id: 99, status: 'committed', subject: { placeId: 'place:new-spot', eventAt: T0 + 2 * 3600 }, options: [{ id: 'go' }, { id: 'stay' }] };
  eq('amendPlanForOuting with the file world: no route (null)', amendPlanForOuting(s, d, T0 + 3600, world), null);
  const amended = amendPlanForOuting(s, d, T0 + 3600, W);
  check('…with the overlay: the outing is planned', !!amended && amended.blocks.some(b => b.placeId === 'place:new-spot'));
  let m = base();
  m = projector.project(m, owner('place.updated', { placeId: 'place:cafe', lat: 0.03, lon: 0.03 }), world);
  const Wm = worldOverlay(m, world);
  eq('a projected move wins over the file', Wm.places.find(p => p.id === 'place:cafe').lat, 0.03);
  check('…and the move set placesSig', typeof m.placesSig === 'string');
  check('…the trip uses the moved coordinates', planTrip('place:home', 'place:cafe', T0, null, Wm).km > planTrip('place:home', 'place:cafe', T0, null, world).km);
}

section('memo safety (R27)');
{
  let a = base();
  let b = base();
  a = projector.project(a, owner('place.updated', { placeId: 'place:cafe', lat: 0.03, lon: 0.03 }), world);
  b = projector.project(b, owner('place.updated', { placeId: 'place:cafe', lat: 0.04, lon: 0.04 }), world);
  eq('same ids, same counters, different content → different worlds (story.worldOf)',
    [story.worldOf(a, world).places.find(p => p.id === 'place:cafe').lat, story.worldOf(b, world).places.find(p => p.id === 'place:cafe').lat], [0.03, 0.04]);
  eq('…and back again (no stale memo)', story.worldOf(a, world).places.find(p => p.id === 'place:cafe').lat, 0.03);
  check('the same state twice → the memoised object', story.worldOf(a, world) === story.worldOf(a, world));
}

section('one merge (no copy that lets the file win)');
{
  const read = (p) => fs.readFileSync(path.join(PROJECT_ROOT, p), 'utf8');
  check('decisions.js travelWorld delegates to worldWithPlaces', /function travelWorld\(state, world\) \{\s*return worldWithPlaces\(state, world\);/.test(read('src/life/decisions.js')));
  check('reconciler.js travelWorld delegates to worldWithPlaces', /return world \? worldWithPlaces\(state, world\) : world;/.test(read('src/life/story/reconciler.js')));
  check('reducer.worldOverlay composes worldWithPlaces first', /const world = worldWithPlaces\(state, worldIn\);/.test(read('src/life/story/reducer.js')));
}

report();
