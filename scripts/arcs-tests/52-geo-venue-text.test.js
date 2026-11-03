// 014 geo (plan §A7, §4 arcs-tests/52): venue names in owner and mind text.
//   owner   cleanOwnerText refuses a venue name next to a negative cue
//           (negative_at_venue) in scene labels / beats; a venue name alone is fine
//   mind    the weekly pass refuses a new_place whose name matches or contains a
//           recorded venue name (R16; recorded as name_collision + why venue_name,
//           the refusal table's reasons being closed)
//   prompt  a draft whose text pairs a venue with a bad word is dropped
//           (the planner's own check: negative_at_venue)
// Invented names, scratch DB, fake clock, no network, no models.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, exampleArcSeed } from './_helpers.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import * as director from '../../src/life/story/director.js';
import * as weekly from '../../src/life/story/weekly.js';
import * as store from '../../src/life/story/store.js';
import * as places from '../../src/life/places.js';

await setupScratchDb();
const { world, clock } = await bootLife();
await simulateHours(3);
await stopLife();
let state = rebuild({ world });
const append = (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; };
const VENUES = [{ name: 'Bean Counter', kind: 'cafe' }];
places.setVenueNamesSource(() => VENUES);
const seed = await exampleArcSeed();
director.__setDepsForTest({ now: () => clock.now(), getState: () => state, world, append, knownNames: () => [], seed: () => seed, venueNames: () => VENUES });
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; } };

section('owner text');
{
  const ctx = { knownNames: [] };
  eq('a venue alone is fine', director.cleanOwnerText('Coffee at Bean Counter', 80, ctx), 'Coffee at Bean Counter');
  eq('venue + a bad cue → negative_at_venue', codeOf(() => director.cleanOwnerText('food poisoning at Bean Counter', 80, ctx)), 'invalid:negative_at_venue');
  eq('…case and spacing do not matter', codeOf(() => director.cleanOwnerText('the WORST night at bean  counter', 80, ctx)), 'invalid:negative_at_venue');
  eq('a bad cue without a venue is fine', director.cleanOwnerText('an awful commute', 80, ctx), 'an awful commute');
  const cast = [...state.cast.keys()][0];
  eq('a cast beat pairing the venue with a cue is refused', codeOf(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: cast, beatKind: 'news', text: 'got robbed outside Bean Counter' }, state)),
    'invalid:negative_at_venue');
}

section('weekly new_place (R16)');
{
  const at = clock.now();
  const base = { at, runId: store.recordRun({ kind: 'weekly', caller: 'life.arcs.weekly', status: 'ok' }), weekKey: '2026-W45', world, knownNames: [] };
  const before = state.places.size;
  const a = await weekly.applyWeekly({ newPlace: { name: 'Bean Counter Annex', kind: 'cafe', near: 'place:park', offsetKm: 1 } }, {}, state, append, base);
  eq('a name containing a venue name → not created', [a.newPlace, state.places.size], [0, before]);
  check('…refused (name_collision) with why venue_name on its proposal row',
    store.listRefusals({ source: 'mind', reason: 'name_collision' }).length >= 1
    && store.listProposals({ status: 'refused' }).some(r => r.kind === 'new_place' && JSON.stringify(r.payload).includes('venue_name')));
  const b = await weekly.applyWeekly({ newPlace: { name: 'Night market', kind: 'market', near: 'place:park', offsetKm: 1 } }, {}, state, append, { ...base, runId: store.recordRun({ kind: 'weekly', caller: 'life.arcs.weekly', status: 'ok' }) });
  eq('a generic name still works', b.newPlace, 1);
}

report();
