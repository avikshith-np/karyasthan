// Integration review fixes (014 geo × sched): "the rest of the day off and go
// to <a real venue>" end to end, with the REAL geo client on a FAKE fetch
// (invented names near (0,0)) and a fake clock — no network.
//   route    the preview route accepts geo's candidate ids (cand:<uuid>) on a
//            schedule range (the sched-only id pattern refused every one)
//   fit      a venue new to his world fits: the trial plan folds the venue's
//            place.created / route.recorded first (it was always "unfit")
//   bundle   a bundle / retcon resolves the candidates of its parts (APPLY WITH
//            suggestions on a venue schedule was "expired_candidate")
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours,
} from './_helpers.js';
import { createGeoClient } from '../../src/life/geo/client.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url) {
  const u = new URL(String(url));
  if (u.hostname === 'nominatim.test') {
    return json([{ osm_type: 'node', osm_id: 777, lat: '0.0262', lon: '0.0288', category: 'amenity', type: 'restaurant', name: 'Plate Lane', address: { suburb: 'Northfield' }, extratags: {} }]);
  }
  if (u.hostname === 'overpass.test') return json({ elements: [] });
  if (u.hostname === 'osrm.test') {
    const [a, b] = u.pathname.split('/').pop().split(';').map(s => s.split(',').map(Number));
    const km = Math.hypot(a[0] - b[0], a[1] - b[1]) * 111 * 1.3;
    return json({ code: 'Ok', routes: [{ distance: km * 1000, duration: km * 120, geometry: { coordinates: [a, b] } }] });
  }
  throw new Error('unexpected host');
}
let ms = 1_800_000_000_000;
const geo = createGeoClient({
  fetch: fakeFetch, now: () => ms, sleep: async (d) => { ms += d; }, names: () => [], timezone: () => 'UTC',
  cfg: { enabled: true, nominatimUrl: 'https://nominatim.test', overpassUrl: 'https://overpass.test/api/interpreter', osrmUrl: 'https://osrm.test',
    osrmFootUrl: '', contactEmail: 'owner@example.invalid', userAgent: 'test', timeoutMs: 8000, maxPerDay: 400 },
});
const { life } = await bootLife({ geo });
await simulateHours(31);               // Wed (office day), around noon
const story = await import('../../src/life/story/index.js');
const D = story.director;
const S = () => life.getState();
const cand = async () => (await life.placeSearch('plate lane')).candidates[0]?.id;
async function codeOf(p) {
  try { await p; return 'ok'; } catch (e) { return `${e.code}:${e.reason ?? ''}${Number.isInteger(e.part) ? `#${e.part}` : ''}`; }
}

section('route: geo candidate ids pass the schedule shape check');
{
  const id = await cand();
  check('a candidate id looks like cand:<uuid>', /^cand:[0-9a-f-]{36}$/.test(id ?? ''), id);
  eq('a range with it is a good shape', actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'out', candidateId: id, from: '16:00', to: '18:00' }] }), null);
  eq('anything else is bad_candidateId', actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'out', candidateId: 'cand_0001', from: '16:00', to: '18:00' }] }), 'bad_candidateId');
}

section('a venue he has never been to fits a schedule range');
{
  const id = await cand();
  const evening = { kind: 'schedule', day: 0, ranges: [{ activity: 'out', candidateId: id, from: '19:00', to: '20:30' }] };
  const p = await D.preview(evening, { source: 'prompt' }).catch(e => e);
  check('out at the new venue in the evening previews (not unfit)', Array.isArray(p?.events), `${p?.code}:${p?.reason}`);
  check('…with the venue\'s place.created first', p?.events?.[0]?.type === 'place.created');
  const id2 = await cand();
  const offAndOut = { kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' }, ranges: [{ activity: 'out', candidateId: id2, from: '15:30', to: '17:30' }] };
  const p2 = await D.preview(offAndOut, { source: 'prompt' });
  const res = await D.apply(p2.previewId, p2.fingerprint);
  check('the rest of the day off + the new venue applies', res.ok);
  const venueId = p2.events.find(e => e.type === 'place.created')?.payload?.id;
  check('the plan in force has him out at the venue', S().plan.blocks.some(b => b.placeId === venueId && b.kind !== 'commute'),
    JSON.stringify(S().plan.blocks.map(b => [b.kind, b.placeId])));
}

section('a bundle resolves its parts\' candidates');
{
  const id = await cand();
  const main = { kind: 'schedule', day: 1, ranges: [{ activity: 'out', candidateId: id, from: '19:00', to: '20:30' }] };
  eq('the change alone previews', await codeOf(D.preview(main, { source: 'prompt' })), 'ok');
  const withSug = { kind: 'bundle', actions: [{ ...main, source: 'hand' }, { kind: 'mood', preset: 'low', wakeDay: 2, source: 'continuity' }] };
  eq('APPLY WITH a suggestion: the bundle previews too', await codeOf(D.preview(withSug, { source: 'prompt' })), 'ok');
  const second = { kind: 'bundle', actions: [{ kind: 'mood', preset: 'calm', wakeDay: 2, source: 'hand' }, { ...main, source: 'code' }] };
  eq('…and with the venue schedule as the second part', await codeOf(D.preview(second, { source: 'prompt' })), 'ok');
}

await stopLife();
report();
