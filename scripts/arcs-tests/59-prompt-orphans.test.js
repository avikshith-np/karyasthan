// The Director prompt's lone-bookmark bug (audit 2026-10-30), replayed: the
// owner wrote "he suddenly feels like eating out, goes to <a real venue> in
// <area>, it's busy so he ends up talking to <someone
// new>"; the model answered with TWO actions — a scene outing starting
// {"inMinutes": 15} and a {"kind":"bookmark"} "remember this moment". The outing
// failed the planner with too_soon and was DROPPED; only the bookmark survived
// and APPLY ALL applied it alone ("it got added as a bookmark", nothing happened).
//   1 charter   a bookmark only when the owner asks; backstop: a wish with no
//               bookmark / remember this / mark this / save this moment drops a
//               model bookmark `unrequested`
//   2 orphans   a side draft (a bookmark, or one marked `accompanies`) carries
//               `dependsOn` and is held (`depends_on_main`, not batchable) while
//               a main draft is dropped, waits for a venue pick, starts too soon
//               or needs review; the page opens it only once its mains are applied
//   3 too soon  the outing comes back as a card (`status:'too_soon'`, `earliestAt`
//               = outing.earliestStart), never moved by itself, never batchable;
//               MOVE TO EARLIEST (the page's movedTo) previews and applies
// The venue and area names are invented stand-ins. The REAL geo client on a FAKE
// fetch, a fake clock, a stubbed mind model — no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole } from './_helpers.js';
import { createGeoClient } from '../../src/life/geo/client.js';
import { earliestStart } from '../../src/life/story/outing.js';
import { movedTo, sideLock } from '../../src/dashboard/public/js/pages/life-director.js';

await setupScratchDb();
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url) {
  const u = new URL(String(url));
  if (u.hostname === 'nominatim.test') {
    return json([{ osm_type: 'node', osm_id: 991, lat: '0.1', lon: '0.11', category: 'amenity', type: 'fast_food', name: 'Noodle Lantern', address: { suburb: 'Northfield' }, extratags: {} }]);
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
const { life, world, clock } = await bootLife({ geo });
await simulateHours(31);               // Wed, around noon
const story = await import('../../src/life/story/index.js');
const promptMod = await import('../../src/life/story/prompt.js');
const D = story.director;
const S = () => life.getState();

// The model's answer, as a stub: whatever JSON the case needs.
let answer = null;
const fcr = fakeCallRole({ 'director.prompt': () => JSON.stringify(answer) });
story.__setDepsForTest({ callRole: fcr.fn, getUsageByCaller: () => [], knownNames: () => [], mindBudgetOk: async () => ({ ok: true }) });
const ask = async (wish, actions) => { answer = { actions, cantDo: [] }; return D.prompt(wish); };

// He has been to the venue before (the owner hit this several times): it is in his world.
let venueId = null;
{
  const id = (await life.placeSearch('bun lantern')).candidates[0]?.id;
  const p = await D.preview({ kind: 'scene', shape: 'outing', candidateId: id, castIds: [], startAt: S().at + 6 * 3600, minutes: 60 });
  venueId = p.events.find(e => e.type === 'place.created')?.payload?.id ?? null;
  await D.apply(p.previewId, p.fingerprint);
}

const WISH = 'He suddenly feels like eating out, goes to Noodle Lantern in Northfield, it\'s busy so he ends up talking to someone new';
const outing = { kind: 'scene', shape: 'outing', placeId: venueId, castIds: [], newCast: { name: 'Rowan Pike', relation: 'acquaintance' },
  when: { inMinutes: 15 }, minutes: 60, label: 'a meal out with someone new' };
const bookmark = { kind: 'bookmark', name: 'remember this moment' };
const LIVE = [{ action: outing, why: 'the craving' }, { action: bookmark, why: 'remember it' }];

section('the live case: the outing comes back as a card, the unasked bookmark is dropped');
let tooSoon = null;
{
  check('the venue is a place in his world', !!S().places.get(venueId)?.venue, venueId);
  const now = clock.now();
  const r = await ask(WISH, LIVE);
  eq('status ok, one draft', [r.status, r.drafts.length], ['ok', 1]);
  tooSoon = r.drafts[0];
  eq('the outing is a too_soon card, never batchable', [tooSoon?.index, tooSoon?.status, tooSoon?.batchable, tooSoon?.reviewReason], [0, 'too_soon', false, 'too_soon']);
  eq('…its earliestAt is outing.earliestStart', tooSoon?.earliestAt, earliestStart({ state: S(), now, world }, { placeId: venueId }));
  check('…after the 15 minutes asked for', tooSoon?.earliestAt > now + 15 * 60, String((tooSoon?.earliestAt - now) / 60));
  eq('…not moved by itself (the action keeps its `when`)', tooSoon?.action?.when, { inMinutes: 15 });
  eq('the bookmark: dropped unrequested', r.dropped.map(x => [x.index, x.kind, x.reason]), [[1, 'bookmark', 'unrequested']]);
  check('nothing in the answer is batchable (APPLY ALL has nothing to apply)', !r.drafts.some(d => d.batchable));
}

section('asked for: the bookmark stays, held behind the outing');
{
  const r = await ask(`${WISH} — remember this moment`, LIVE);
  const bm = r.drafts.find(d => d.action.kind === 'bookmark');
  eq('two drafts: the too_soon outing and the bookmark', r.drafts.map(d => [d.index, d.status ?? null]), [[0, 'too_soon'], [1, null]]);
  eq('the bookmark: side, dependsOn the outing, held', [bm?.side, bm?.dependsOn, bm?.batchable, bm?.reviewReason], [true, [0], false, 'depends_on_main']);
  const cards = r.drafts.map(d => ({ draft: d, applied: false, removed: false }));
  eq('the page: it waits for card #1', sideLock(bm, cards), { waitFor: [1] });
  cards[0].applied = true;
  eq('…opens once the outing is applied', sideLock(bm, cards), null);
  cards[0].applied = false;
  cards[0].removed = true;
  eq('…never when the outing is removed', sideLock(bm, cards), { dropped: true });
}

section('a real venue named (fake geo): the outing waits for a pick, the bookmark with it');
{
  const venue = { ...outing, venue: { name: 'Noodle Lantern', area: 'Northfield' } };
  delete venue.placeId;
  const r = await ask(`${WISH}. Bookmark this.`, [{ action: venue, why: 'the craving' }, { action: bookmark, why: 'remember it' }]);
  const o = r.drafts.find(d => d.index === 0);
  const bm = r.drafts.find(d => d.index === 1);
  eq('the outing: needs_pick with the lookup\'s candidate', [o?.status, o?.venues?.[0]?.candidates?.[0]?.name], ['needs_pick', 'Noodle Lantern']);
  eq('the bookmark: held behind it', [bm?.batchable, bm?.reviewReason, bm?.dependsOn], [false, 'depends_on_main', [0]]);
}

section('MOVE TO EARLIEST: the card\'s moved action previews and applies');
{
  const moved = movedTo(tooSoon.action, tooSoon.earliestAt);
  eq('`when` becomes the earliest start', [moved?.startAt, 'when' in (moved ?? {})], [tooSoon.earliestAt, false]);
  const p = await D.preview(moved, { source: 'prompt' }).catch(e => e);
  check('previews: the outing opens at the venue', p?.events?.some(e => e.type === 'decision.opened' && e.payload?.subject?.placeId === venueId), `${p?.code}:${p?.reason}`);
  const res = await D.apply(p.previewId, p.fingerprint).catch(e => e);
  check('…and applies', res?.ok === true, `${res?.code}:${res?.reason}`);
}

section('the rule\'s other edges');
{
  let r = await ask('bookmark this moment', [{ action: bookmark, why: 'x' }]);
  eq('a bookmark asked for alone: free and batchable', [r.drafts[0]?.batchable, r.drafts[0]?.reviewReason, 'dependsOn' in (r.drafts[0] ?? {})], [true, null, false]);
  r = await ask('he is tired today, mark this', [{ action: bookmark, why: 'x' }, { action: { kind: 'quick', button: 'tired' }, why: 'y' }]);
  const bm = r.drafts.find(d => d.index === 0);
  eq('a batchable main: the bookmark stays batchable, dependsOn it', [bm?.batchable, bm?.dependsOn], [true, [1]]);
  eq('…the page applies it only after the main (APPLY ALL takes mains first)',
    sideLock(bm, r.drafts.map(d => ({ draft: d, applied: false, removed: false }))), { waitFor: [2] });
  r = await ask('a quiet evening after a long day', [
    { action: { ...outing, placeId: 'place:nowhere' }, why: 'x' },
    { action: { kind: 'quick', button: 'tired' }, why: 'y', accompanies: 0 },
  ]);
  const acc = r.drafts.find(d => d.index === 1);
  eq('`accompanies`: a side draft; its main dropped (unknown_place) → held', [r.dropped[0]?.reason, acc?.side, acc?.batchable, acc?.reviewReason, acc?.dependsOn],
    ['unknown_place', true, false, 'depends_on_main', [0]]);
  eq('…the page never opens it', sideLock(acc, r.drafts.map(d => ({ draft: d, applied: false, removed: false }))), { dropped: true });
  r = await ask('a quiet evening', [{ action: { kind: 'quick', button: 'tired' }, why: 'y', accompanies: 0 }]);
  eq('`accompanies` pointing at itself is ignored', [r.drafts[0]?.side, r.drafts[0]?.batchable], [undefined, true]);
}

section('the wish words and the charter');
{
  const asks = ['bookmark this', 'Book mark it', 'remember this moment', 'remember that', 'mark this', 'mark the moment', 'save this moment', 'save the night'];
  const not = ['he remembers he is vegetarian', 'remember he likes tea', 'a market trip', 'he saves money', 'goes to the bookstore'];
  eq('bookmark-ish wishes', asks.filter(w => !promptMod.asksForBookmark(w)), []);
  eq('…and not', not.filter(w => promptMod.asksForBookmark(w)), []);
  check('charter: a bookmark only when the owner asks', /"bookmark".{0,80}ONLY when the owner explicitly asks to bookmark, remember, mark or save this moment/.test(promptMod.PROMPT_CHARTER));
  check('charter: "suddenly / now / right away" outings start at least prep + travel ahead (leadMin), never in 0–15 minutes',
    /suddenly/.test(promptMod.PROMPT_CHARTER) && /right away/.test(promptMod.PROMPT_CHARTER) && /prep \+ the trip/.test(promptMod.PROMPT_CHARTER)
    && /never starts in 0–15 minutes/.test(promptMod.PROMPT_CHARTER) && /"leadMin"/.test(promptMod.PROMPT_CHARTER));
  check('charter: the accompanies marker', /"accompanies"/.test(promptMod.PROMPT_CHARTER));
}

story.__setDepsForTest({ mindBudgetOk: undefined, getUsageByCaller: undefined, knownNames: undefined, callRole: undefined });
await stopLife();
report();
