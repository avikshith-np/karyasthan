// A real venue in a scene outing (Director prompt × 014 geo): "meet Lena at
// <a real venue>, <area> at 6" must not become a made-up place near his home.
// The REAL geo client on a FAKE fetch (invented names near (0,0)), a fake clock,
// a stubbed mind model — no network.
//   validator  an outing may name a real venue: "venue": {name, area} → a
//              needs_venue draft (the query only in its venues slot, never on the
//              action); venue + placeId / newPlace, or a venue on a visit → bad_field
//   lookup     fillVenueDrafts fills the outing's slot → needs_pick (candidates);
//              no geo → stays needs_venue
//   route      a scene outing carries a geo candidate id (cand:<uuid>) only; venue
//              data on a scene is refused (venue_data)
//   apply      a picked candidate: ONE apply creates the venue (place.created
//              {venue}, opaque id, caused by the director.action) and the outing at it;
//              REVERT THIS CHANGE undoes both (the venue's routes ride along)
//   geo off    a scene candidate without geo → geo_off (never a made-up place)
//   safety     a newPlace named like a known venue or naming a known venue area →
//              continuity warning looks_real_place; in the prompt also a newPlace
//              name the owner typed in the wish
//   drops      the prompt's info log lists each dropped draft {index, kind, reason}
//   day view   a committed outing still ahead: its commit tick carries the outing
//              time (Life · Day says "decided: … (not yet)")
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole,
} from './_helpers.js';
import { createGeoClient } from '../../src/life/geo/client.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';
import { renderToString } from '../../src/dashboard/public/js/core/dom.js';
import { revertConfirmCard } from '../../src/dashboard/public/js/pages/life-director-god.js';

await setupScratchDb();
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url) {
  const u = new URL(String(url));
  if (u.hostname === 'nominatim.test') {
    return json([{ osm_type: 'node', osm_id: 778, lat: '0.0262', lon: '0.0288', category: 'amenity', type: 'restaurant', name: 'Plate Lane', address: { suburb: 'Northfield' }, extratags: {} }]);
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
await simulateHours(31);               // Wed, around noon
const story = await import('../../src/life/story/index.js');
const promptMod = await import('../../src/life/story/prompt.js');
const schema = await import('../../src/life/story/schema.js');
const placesDirector = await import('../../src/life/story/placesDirector.js');
const D = story.director;
const S = () => life.getState();
const cand = async () => (await life.placeSearch('plate lane')).candidates[0]?.id;
async function codeOf(p) {
  try { await p; return 'ok'; } catch (e) { return `${e.code}:${e.reason ?? ''}`; }
}
const contCodes = (p) => (p?.continuity?.warnings ?? []).map(w => w.code);

// The prompt's catalogue as the validator sees it (ids from his world).
const today = new Date(S().at * 1000).toISOString().slice(0, 10);
const cat = { today, castIds: new Set(['cast:flatmate', 'cast:coworker-a']), placeIds: new Set(['place:home', 'place:cafe', 'place:restaurant']),
  arcIds: new Set(), pinKeys: new Set(), pins: new Set(), sliders: {} };
const validate = (actions) => schema.validatePromptOutput(JSON.stringify({ actions: actions.map(a => ({ action: a, why: 'w' })) }), cat, promptMod.VOCAB);
const outing = (extra) => ({ kind: 'scene', shape: 'outing', castIds: ['cast:flatmate'], when: { day: 0, time: '18:00' }, minutes: 120, ...extra });

section('validator: an outing may name a real venue');
{
  const v = validate([outing({ venue: { name: 'Lantern Cafe', area: 'Old Quarter' } })]);
  const d = v.drafts[0];
  eq('venue → needs_venue with the query in its slot', [d?.status, d?.venues], ['needs_venue', [{ field: 'place', query: { name: 'Lantern Cafe', area: 'Old Quarter' } }]]);
  eq('…and no place, no venue data on the action', ['placeId' in (d?.action ?? {}), 'newPlace' in (d?.action ?? {}), 'venue' in (d?.action ?? {})], [false, false, false]);
  eq('venue + placeId → bad_field', validate([outing({ venue: { name: 'Lantern Cafe' }, placeId: 'place:cafe' })]).dropped[0]?.reason, 'bad_field');
  eq('venue + newPlace → bad_field', validate([outing({ venue: { name: 'Lantern Cafe' }, newPlace: { name: 'Corner', placeKind: 'cafe', near: 'place:home', offsetKm: 1 } })]).dropped[0]?.reason, 'bad_field');
  eq('a venue on a visit → bad_field', validate([{ ...outing({ venue: { name: 'Lantern Cafe' } }), shape: 'visit' }]).dropped[0]?.reason, 'bad_field');
  eq('a URL in a venue name → identifier_in_text', validate([outing({ venue: { name: 'see https://x.example' } })]).dropped[0]?.reason, 'identifier_in_text');
  check('the charter tells the model: venue for a real business, newPlace only for an invented one',
    promptMod.PROMPT_CHARTER.includes('"venue":{"name"') && /newPlace.{0,80}invented/i.test(promptMod.PROMPT_CHARTER));
  check('the schedule venueQuery rule stays', promptMod.PROMPT_CHARTER.includes('"venueQuery"') && /never write coordinates or addresses/.test(promptMod.PROMPT_CHARTER));
}

section('route: a scene outing carries a candidate id only');
{
  const id = await cand();
  eq('outing + candidateId is a good shape', actionProblem({ kind: 'scene', shape: 'outing', candidateId: id, startAt: S().at + 6 * 3600, minutes: 120 }), null);
  eq('a bad candidate id → bad_candidateId', actionProblem({ kind: 'scene', shape: 'outing', candidateId: 'cand_1', startAt: S().at + 6 * 3600, minutes: 120 }), 'bad_candidateId');
  eq('venue data on a scene → venue_data', actionProblem({ kind: 'scene', shape: 'outing', candidateId: id, venue: { lat: 1 }, startAt: S().at + 6 * 3600, minutes: 120 }), 'venue_data');
}

section('geo off: a picked venue is never a made-up place');
{
  const code = await codeOf(placesDirector.resolveGeoAction({ kind: 'scene', shape: 'outing', candidateId: await cand() }, S(),
    { geo: null, err: (c, r) => Object.assign(new Error(r), { code: c, reason: r }) }));
  eq('scene candidate without geo → geo_off', code, 'refused:geo_off');
}

let venueId = null;
section('apply: the picked venue + the outing, one apply');
{
  const id = await cand();
  const a = { kind: 'scene', shape: 'outing', candidateId: id, castIds: ['cast:flatmate'], startAt: S().at + 6 * 3600, minutes: 120, label: 'dinner' };
  const p = await D.preview(a, { source: 'prompt' }).catch(e => e);
  check('previews', Array.isArray(p?.events), `${p?.code}:${p?.reason}`);
  const created = p?.events?.find(e => e.type === 'place.created');
  const parent = p?.events?.find(e => e.type === 'director.action');
  venueId = created?.payload?.id ?? null;
  check('place.created with the venue and an opaque id', !!created?.payload?.venue && /^place:v[0-9a-f]{8}/.test(venueId ?? ''), JSON.stringify(created?.payload));
  check('…caused by the director.action', created?.causeRef === parent?.ref);
  const opened = p?.events?.find(e => e.type === 'decision.opened');
  eq('the outing is at the venue', opened?.payload?.subject?.placeId, venueId);
  check('…and committed', p?.events?.some(e => e.type === 'decision.committed'));
  const res = await D.apply(p.previewId, p.fingerprint).catch(e => e);
  check('applies', res?.ok === true, `${res?.code}:${res?.reason}`);
  check('the venue is in his world (real)', !!S().places.get(venueId)?.venue);
  const dec = [...S().decisions.values()].find(d => d.subject?.placeId === venueId);
  eq('the committed outing is at it', dec?.status, 'committed');
  eq('a candidate + a placeId → refused', await codeOf(D.preview({ ...a, candidateId: await cand(), placeId: 'place:cafe' })), 'invalid:bad_fields');
  const rp = life.revertChangePreview(res.actionEventId);
  check('REVERT THIS CHANGE covers the venue and the outing (no refusal)', !rp.refusals.length && rp.targets.some(t => t.type === 'place.created') && rp.targets.some(t => t.type === 'decision.opened'),
    JSON.stringify({ t: rp.targets, r: rp.refusals }));
  check('…its routes ride along with the venue', rp.riding.some(x => x.type === 'route.recorded'), rp.riding);
  const card = renderToString(revertConfirmCard(rp));
  check('…the confirm lists them under ALSO GOES WITH IT', card.includes(`ALSO GOES WITH IT (${rp.riding.length})`) && rp.riding.every(x => card.includes(`#${x.id}<`)), card);
  // Revert it for real, then pick again: the rest of the test uses a live venue.
  const rr = life.revertChange(res.actionEventId, { fingerprint: rp.fingerprint });
  check('reverted: the venue and the outing are gone', rr.reverted.length === rp.targets.length && !S().places.has(venueId) && dec?.id && S().decisions.get(dec.id)?.status !== 'committed',
    JSON.stringify({ n: rr.reverted.length, st: S().decisions.get(dec?.id)?.status }));
  const again = await D.preview({ ...a, candidateId: await cand(), startAt: S().at + 6 * 3600 });
  await D.apply(again.previewId, again.fingerprint);
  // Life · Day: the commit tick carries the outing's time, so the page can say "(not yet)".
  const v = await life.dayView({});
  const dec2 = [...S().decisions.values()].find(d => d.subject?.placeId === venueId && d.status === 'committed');
  const tick = v.past.ticks.find(t => t.type === 'decision.committed' && t.decisionId === dec2?.id);
  eq('the Day view\'s commit tick carries the outing time (ahead of now)', [tick?.detail?.eventAt, tick?.detail?.eventAt > v.at], [dec2?.subject?.eventAt, true]);
}

section('safety net: a newPlace that looks like a real venue');
{
  const base = { kind: 'scene', shape: 'outing', castIds: ['cast:flatmate'], startAt: S().at + 30 * 3600, minutes: 90 };
  const np = (name) => ({ ...base, newPlace: { name, kind: 'restaurant', near: 'place:home', offsetKm: 2 } });
  const p1 = await D.preview(np('Plate Lane'));
  check('named like a known venue → looks_real_place', contCodes(p1).includes('looks_real_place'), contCodes(p1));
  const w = p1.continuity?.warnings?.find(x => x.code === 'looks_real_place');
  check('…a warn with the place-search text', w?.severity === 'warn' && /real place; use the place search/.test(w?.text ?? ''), w);
  const p2 = await D.preview(np('Northfield Bistro'));
  check('naming a known venue area → looks_real_place', contCodes(p2).includes('looks_real_place'), contCodes(p2));
  const p3 = await D.preview(np('Corner Diner'));
  check('a generic invented name → no warning', !contCodes(p3).includes('looks_real_place'), contCodes(p3));
  const p4 = await D.preview({ kind: 'scene', shape: 'new_place', name: 'Plate Lane', placeKind: 'restaurant', near: 'place:home', offsetKm: 2 });
  check('the new_place shape too', contCodes(p4).includes('looks_real_place'), contCodes(p4));
}

section('the prompt: venue → lookup → pick; newPlace from the wish → warned; drops logged');
{
  const logs = [];
  const logger = { info: (o) => logs.push(o), warn: () => {}, error: () => {}, debug: () => {} };
  let reply = '';
  const cr = fakeCallRole({ 'director.prompt': () => reply });
  promptMod.__setDepsForTest({ callRole: cr.fn, mindBudgetOk: async () => ({ ok: true }), getUsageByCaller: () => [], knownNames: () => [], logger });
  const send = (actions) => { reply = JSON.stringify({ actions: actions.map(a => ({ action: a, why: 'w' })) }); };

  send([outing({ venue: { name: 'Plate Lane', area: 'Northfield' }, newCast: { name: 'Mira Vale', relation: 'friend' }, castIds: [] })]);
  const r1 = await promptMod.runPrompt('Take the rest of the day off and meet Mira at Plate Lane, Northfield at 6');
  const d1 = r1.drafts[0];
  eq('a venue outing → needs_pick after one lookup', [d1?.status, r1.venueLookups, d1?.venues?.[0]?.field], ['needs_pick', 1, 'place']);
  check('…with candidates (opaque ids)', /^cand:/.test(d1?.venues?.[0]?.candidates?.[0]?.id ?? ''), d1?.venues);
  check('…never in APPLY ALL', d1?.batchable === false);

  send([outing({ newPlace: { name: 'Truffle Room', kind: 'restaurant', near: 'place:home', offsetKm: 5 } })]);
  const r2 = await promptMod.runPrompt('meet her at Truffle Room, Eastgate at 6');
  const d2 = r2.drafts[0];
  check('a newPlace named as in the wish → the looks-real warning on the draft', (d2?.warnings ?? []).some(w => /real place; use the place search/.test(w)), d2?.warnings);
  eq('…and it is reviewed one by one', [d2?.batchable, d2?.reviewReason], [false, 'continuity']);

  send([outing({ placeId: 'place:nowhere' }), { kind: 'quick', button: 'tired' }]);
  logs.length = 0;
  const r3 = await promptMod.runPrompt('go somewhere and be tired');
  const line = logs.find(o => o?.evt === 'arcs.director.prompt');
  eq('the dropped draft is in the result', r3.dropped, [{ index: 0, kind: 'scene', reason: 'unknown_place' }]);
  eq('…and in the info log as codes', line?.drops, [{ index: 0, kind: 'scene', reason: 'unknown_place' }]);
  check('the log carries no wish text', !JSON.stringify(logs).includes('somewhere'));
  promptMod.__setDepsForTest({ logger: (await import('../../src/utils/logger.js')).logger });
}

await stopLife();
report();
