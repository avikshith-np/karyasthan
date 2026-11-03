// 014 geo (plan §A7, §4 life-tests/53): no negative event attached to a named
// real business. A fixture world with ONE invented venue place ("Bean Counter",
// a cafe) and a generic one; scratch DB (real events), fake clock, no network.
//   wording   placeLabel / innerState: a venue while sick → "a cafe"; a generic
//             place keeps its name (fixtures unchanged); a colliding venue → kind
//   position  negativeAt is computed from where he was (sick carries no placeId)
//   journal   activity / travel bullets near a negative event → kind word; the
//             stored "decided:" label is scrubbed (also after the switch is
//             reverted: venueNamesEver counts excluded events, R5); a good meal
//             keeps the name
//   day rows  a negative row words the venue by kind
//   mouth     the tone line appears only when a venue name is in the tail
//   scrubs    scrubNegativeVenue only touches sentences with a cue word
import { setupScratchDb, fakeClock, section, check, eq, report } from './_helpers.js';
import { setClock, atLocal } from '../../src/life/clock.js';
import { appendEvent, revertEvent, listEvents } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, rebuild } from '../../src/life/projector.js';
import { innerStateLine } from '../../src/life/innerState.js';
import { bulletFor, selfFacts } from '../../src/life/story/journal.js';
import * as places from '../../src/life/places.js';

await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const TZ = createInitialState(world).world.timezone;
const T0 = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '17:00', TZ);
const clock = fakeClock(T0);
setClock(clock.fn);
const H = 3600;

let state = createInitialState(world);
const add = (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; };
const g = add({ type: 'genesis', at: T0 - 48 * H, actor: 'engine', payload: { source: 'example', timezone: TZ, self: world.self, worldHash: 'x' } });
for (const p of world.places) add({ type: 'place.created', at: T0 - 48 * H, actor: 'engine', causeId: g.id, payload: { id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon } });
const action = add({ type: 'director.action', at: T0 - 24 * H, actor: 'owner', payload: { kind: 'place.real', previewAt: T0 - 24 * H, count: 1 } });
const swap = add({ type: 'place.updated', at: T0 - 24 * H, actor: 'owner', causeId: action.id, payload: {
  placeId: 'place:cafe', name: 'Bean Counter', kind: 'cafe', lat: 0.0161, lon: 0.0176, venue: { src: 'osm', ref: 'node/501', area: 'Northfield' },
  prev: { name: 'Café', kind: 'cafe', lat: 0.016, lon: 0.0175, venue: null } } });
// The facade's names reader (log, excluded events included) — here the same read, inline.
const venueNames = () => listEvents({ types: ['place.created', 'place.updated'], limit: 500 })
  .filter(e => e.payload?.venue && e.payload?.name).map(e => ({ name: e.payload.name, kind: e.payload.kind }));
places.setVenueNamesSource(venueNames);

section('wording');
{
  check('the cafe is a venue now', state.places.get('place:cafe')?.venue?.ref === 'node/501');
  eq('placeLabel, neutral context → the name', places.placeLabel(state, 'place:cafe'), 'Bean Counter');
  eq('placeLabel, negative → the kind word', places.placeLabel(state, 'place:cafe', { negative: true }), 'a cafe');
  eq('a generic place keeps its name even negative', places.placeLabel(state, 'place:gym', { negative: true }), 'Gym');
  places.setCollidingVenues(['place:cafe']);
  eq('a venue colliding with a real person → kind word everywhere', places.placeLabel(state, 'place:cafe'), 'a cafe');
  places.setCollidingVenues([]);
}

section('innerState while sick at the venue');
{
  const act = add({ type: 'activity.started', at: T0, actor: 'engine', payload: { kind: 'cafe', placeId: 'place:cafe', end: T0 + 2 * H, availability: 'light' } });
  const aud = { chatJid: '15550000009@s.whatsapp.net', kind: 'dm', members: new Set(['15550000009@s.whatsapp.net']) };
  const healthy = innerStateLine(state, T0 + 600, aud);
  check('healthy: the name may appear', /Bean Counter/.test(healthy) || !/a cafe/.test(healthy), healthy);
  add({ type: 'sick.started', at: T0 + 900, actor: 'engine', payload: { days: 1, until: T0 + 30 * H } });
  const sick = innerStateLine(state, T0 + 1200, aud);
  check('sick: no venue name in the inner state', !/Bean Counter/.test(sick), sick);
  void act;
}

section('negativeAt is position-based');
{
  const evs = listEvents({ from: T0 - H, to: T0 + 3 * H, limit: 500 });
  check('sick with no placeId while at the venue → negative there', places.negativeAt(state, T0 + 900, { placeId: 'place:cafe', events: evs }));
  check('…not at another place', !places.negativeAt(state, T0 + 900, { placeId: 'place:park', events: evs }));
  const meal = [{ id: 1, at: T0, type: 'activity.started', payload: { placeId: 'place:cafe' } }, { id: 2, at: T0 + 60, type: 'meal', payload: { kind: 'dinner', good: true } }];
  check('a good meal is not negative', !places.negativeAt(state, T0, { placeId: 'place:cafe', events: meal }));
  const soaked = [{ id: 3, at: T0, type: 'travel.started', payload: { from: 'place:home', to: 'place:cafe' } }, { id: 4, at: T0, type: 'commute.soaked', payload: {} }];
  check('soaked on the way there → negative there', places.negativeAt(state, T0, { placeId: 'place:cafe', events: soaked }));
}

section('journal bullets');
{
  const evs = listEvents({ from: T0 - H, to: T0 + 3 * H, limit: 500 });
  const actEv = evs.find(e => e.type === 'activity.started' && e.payload.placeId === 'place:cafe');
  eq('near the sick event → kind word', bulletFor(actEv, { state, events: evs, tz: TZ }).replace(/^\d\d:\d\d /, ''), 'cafe at a cafe');
  eq('without context → the name', bulletFor(actEv, { state, tz: TZ }).replace(/^\d\d:\d\d /, ''), 'cafe at Bean Counter');
  const self = selfFacts(evs, { state, tz: TZ });
  check('selfFacts passes its own events as context', self.bullets.every(b => !/Bean Counter/.test(b)), self.bullets);
  // A stored decision label naming the venue, then could_not_go.
  const opened = add({ type: 'decision.opened', at: T0 + 2 * H, actor: 'engine', payload: { kind: 'cafe', options: [
    { id: 'go', label: 'Go to Bean Counter', go: true }, { id: 'stay', label: 'Stay in' }], subject: { placeId: 'place:cafe', eventAt: T0 + 4 * H }, decideBy: T0 + 3 * H } });
  const committed = add({ type: 'decision.committed', at: T0 + 2 * H + 60, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, optionId: 'go', p: 1 } });
  add({ type: 'decision.expired', at: T0 + 3 * H, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, reason: 'could_not_go' } });
  const night = listEvents({ from: T0 - H, to: T0 + 5 * H, limit: 500 });
  const b = bulletFor(night.find(e => e.id === committed.id), { state, events: night, tz: TZ });
  check('decided: the stored label is scrubbed', /decided: Go to a cafe/.test(b), b);
  // Revert the switch: the name is still scrubbed (venue names ever, R5).
  revertEvent(swap.id, { reason: 'test', by: 'owner', at: T0 + 4 * H });
  state = rebuild({ world });
  check('reverted: the cafe has its generic name back', state.places.get('place:cafe').name === 'Café' && !state.places.get('place:cafe').venue);
  const b2 = bulletFor(night.find(e => e.id === committed.id), { state, events: night, tz: TZ });
  check('…and the stored label is still scrubbed', !/Bean Counter/.test(b2), b2);
}

section('mouth tone line and scrubs');
{
  eq('no venue name in the tail → no line', places.venueToneNote('Free at home; dinner later'), '');
  check('a venue name in the tail → the line', /Don't say anything bad about Bean Counter/.test(places.venueToneNote('Out at Bean Counter with a friend')));
  eq('scrubNegativeVenue: only cue sentences', places.scrubNegativeVenue('Met a friend at Bean Counter. The food at Bean Counter was awful.', venueNames()),
    'Met a friend at Bean Counter. The food at a cafe was awful.');
  check('negativeAtVenue: name + cue', places.negativeAtVenue('he got food poisoning at bean counter', venueNames()) && !places.negativeAtVenue('lunch at Bean Counter', venueNames()));
}

report();
