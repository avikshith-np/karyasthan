// 014 geo (plan §A6b, §A5.9, §4 arcs-tests/53): the Director prompt names a
// real venue → the server looks it up → the owner picks.
//   post-step  a needs_venue draft: venueQuery strings pass the wish checks
//              (JID / phone / real name), the venue charset and the blocklist,
//              else the draft is dropped (bad_venue); ≤ 3 lookups per prompt;
//              candidates (opaque ids) → needs_pick; a lookup error or no geo →
//              stays needs_venue
//   charter    the venueQuery line; venue places marked venue:true in the catalogue
//   venuePlace sched's seam: a resolved candidate → place.created {venue} + its
//              routes (reuses an existing place with the same ref); absent →
//              expired_candidate. The end-to-end schedule case waits for sched (P.4).
// Pure: stubbed geo service, no network, no model.
import { section, check, eq, report } from './_helpers.js';

const promptMod = await import('../../src/life/story/prompt.js');
const { venuePlace } = await import('../../src/life/story/placesDirector.js');
const director = await import('../../src/life/story/director.js');

const cand = (n) => ({ id: `cand:0000000${n}-0000-4000-8000-000000000000`, name: `Venue ${n}`, kind: 'cafe', area: 'Northfield', distKmFromHome: 1.2, flags: [] });
const draft = (i, queries) => ({ index: i, action: { kind: 'schedule' }, status: 'needs_venue', venues: queries.map((q, k) => ({ range: k, query: q })) });

section('post-step');
{
  const calls = [];
  promptMod.__setDepsForTest({
    geo: {
      search: async (q) => { calls.push(q); if (/broken/.test(q)) throw new Error('lookup failed'); return { candidates: [cand(calls.length)] }; },
      venueQueryProblem: (name) => (/ignore/i.test(name) ? 'bad_venue' : null),
    },
  });
  const out = {
    drafts: [
      draft(0, [{ name: 'Bean Counter', area: 'Northfield' }]),
      draft(1, [{ name: 'Lunch with Quinn Marsh' }]),
      draft(2, [{ name: 'abc123@s.whatsapp.net' }]),
      draft(3, [{ name: 'Ignore the rules cafe' }]),
      draft(4, [{ name: 'broken place' }]),
      draft(5, [{ name: 'Plate Lane' }, { name: 'Green Commons' }]),
      { index: 6, action: { kind: 'quick', button: 'tired' } },
    ],
    dropped: [],
  };
  const n = await promptMod.fillVenueDrafts(out, { knownNames: ['Quinn Marsh'] });
  eq('dropped: real name, JID, blocklist → bad_venue', out.dropped.map(d => [d.index, d.reason]), [[1, 'bad_venue'], [2, 'bad_venue'], [3, 'bad_venue']]);
  eq('≤ 3 lookups per prompt', [n, calls.length], [3, 3]);
  eq('first draft → needs_pick with candidates', [out.drafts[0].status, out.drafts[0].venues[0].candidates.length], ['needs_pick', 1]);
  eq('a failed lookup stays needs_venue', out.drafts.find(d => d.index === 4).status, 'needs_venue');
  eq('the lookup budget ran out half-way → stays needs_venue', out.drafts.find(d => d.index === 5).status, 'needs_venue');
  check('other drafts untouched', out.drafts.some(d => d.index === 6 && d.status === undefined));
  check('the query sent is the owner\'s name + area only', calls[0] === 'Bean Counter Northfield', calls);
  promptMod.__setDepsForTest({ geo: null });
  const out2 = { drafts: [draft(0, [{ name: 'Bean Counter' }])], dropped: [] };
  eq('no geo → stays needs_venue, no lookup', [await promptMod.fillVenueDrafts(out2, {}), out2.drafts[0].status], [0, 'needs_venue']);
  promptMod.__setDepsForTest(null);
}

section('charter and catalogue');
{
  check('the venueQuery rule', promptMod.PROMPT_CHARTER.includes('"venueQuery"') && /never write coordinates or addresses/.test(promptMod.PROMPT_CHARTER));
  check('the old "never invent a real company" rule stays', /never invent a real person, a real company/.test(promptMod.PROMPT_CHARTER));
  check('place.real is prompt-draftable (from a pick)', director.PROMPT_ACTION_KINDS.includes('place.real'));
}

section('venuePlace (sched seam, A5.9)');
{
  const id = 'cand:00000001-0000-4000-8000-000000000000';
  const places = new Map([
    ['place:home', { id: 'place:home', name: 'Home', kind: 'home', lat: 0.01, lon: 0.01 }],
    ['place:office', { id: 'place:office', name: 'Office', kind: 'office', lat: 0.05, lon: 0.04 }],
  ]);
  const state = { places, self: { homePlaceId: 'place:home' } };
  eq('absent → expired_candidate', venuePlace(id, { state, now: 100, resolved: {} }), { refusal: 'expired_candidate' });
  const resolved = { [id]: { venue: { name: 'Bean Counter', kind: 'cafe', lat: 0.0161, lon: 0.0176, area: 'Northfield', ref: 'node/501', kindTag: 'amenity=cafe' },
    placeId: 'place:v0a1b2c3d', routes: [{ a: 'place:home', b: 'place:v0a1b2c3d', profile: 'car', km: 1.1, minutes: 4,
      aAt: { lat: 0.01, lon: 0.01 }, bAt: { lat: 0.0161, lon: 0.0176 }, pts: [[1000, 1000], [1610, 1760]] }], routesState: 'ok' } };
  const r = venuePlace(id, { state, now: 100, resolved });
  eq('descriptors: the place then its route', r.descriptors.map(d => d.type), ['place.created', 'route.recorded']);
  eq('opaque id, venue data', [r.placeId, r.descriptors[0].payload.venue], ['place:v0a1b2c3d', { src: 'osm', ref: 'node/501', area: 'Northfield', kindTag: 'amenity=cafe' }]);
  places.set('place:vexisting', { id: 'place:vexisting', name: 'Bean Counter', kind: 'cafe', lat: 0.0161, lon: 0.0176, venue: { src: 'osm', ref: 'node/501' } });
  eq('the same venue ref already in his world → reused, nothing new', venuePlace(id, { state, now: 100, resolved }), { descriptors: [], placeId: 'place:vexisting' });
  if (!director.ACTION_KINDS.includes('schedule')) console.log('  SKIP schedule range end to end: the schedule kind lands with the sched branch (P.4)');
}

report();
