// 014 geo — the Director's real-places actions (spec 014 plan §A2.3, §A3, §A4,
// §A5.9; P.3.5). Kept out of director.js so the shared file only gains a
// kinds line, three case branches and the preview resolver hook.
//
//   place.real {candidateId, as:'new'|'replace', placeId?}   one searched venue →
//        a new place, or an existing generic place moved + renamed; its routes
//   places.realify {resultId, untick?, tick?}   the "make places real" job's swaps
//   routes.refresh {resultId}                   the refresh job's routes
//   venuePlace(candidateId, ctx)                a schedule range's / a scene outing's
//                                               venue → descriptors
//
// An action carries ids only (R18): coordinates, names and routes come from the
// server-side candidate / job stores, resolved ONCE by preview()
// (resolveGeoAction, async, the only part that may fetch) into a frozen
// `resolved` copy; plan() is pure and reads only ctx.resolved; apply() re-plans
// with the same frozen copy (never the stores, never a re-fetch).
//
// Rules (§A3.2): the private set (his home, office incl. a career overlay,
// any home-kind place, a cast home, private kinds) is never switched; a place
// he is at or travelling to/from right now is `in_use`; one venue ref per place
// (`duplicate_venue`); ≤ 48 places (`full`). Venue places get an opaque id
// (`place:v<8 hex of sha256(ref)>`, R2): no venue name in an id, audit row or log.

import { isPrivatePlace, venuePlaceId, isRealVenue, routeKey, routePairsFor, refreshPairs, isHomeKind } from '../places.js';

export const GEO_ACTION_KINDS = Object.freeze(['place.real', 'places.realify', 'routes.refresh']);
export const GEO_PROMPT_KINDS = Object.freeze(['place.real']);
export const ROUTES_LATER = 'routes_later';
export const ROUTES_OFF = 'routes_off';
export const TODAY_TIMES = "today's trips keep today's times";
export const MAX_PLACES = 48;
export const PLACE_REAL_ROUTE_BUDGET_MS = 15_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const CAND_RE = /^cand:[0-9a-f-]{36}$/;
const RESULT_RE = /^res:[0-9a-f-]{36}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;

/** Is `id` in use right now (he is at it, or travelling to/from it)? */
export function inUseNow(state, id) {
  const pos = state?.position;
  if (pos?.placeId === id && !pos?.travel) return true;
  if (pos?.travel && (pos.travel.from === id || pos.travel.to === id)) return true;
  if (state?.activity?.placeId === id && state.activity.kind !== 'idle') return true;
  return false;
}

/** Is `id` an endpoint or a block place in the rest of today's plan (from `at`)? */
export function inTodaysPlan(state, id, at) {
  const blocks = Array.isArray(state?.plan?.blocks) ? state.plan.blocks : [];
  return blocks.some(b => finite(b?.end) && b.end > at && (b.placeId === id || b.from === id || b.to === id));
}

// Route pairs and home-kind endpoints live in places.js (pure; the facade's jobs use them too).
export { routePairsFor, refreshPairs, isHomeKind };

// ── Preview resolver (async; the only part that may fetch) ────────────────

// The geo ids an action carries: its own, or every part's of a bundle / retcon
// (one resolved map serves all parts: plan() hands it to each).
function geoIdsOf(action, cands, results, depth = 0) {
  if (!isObj(action) || depth > 1) return;
  if (action.kind === 'place.real') cands.push({ id: action.candidateId, action });
  // A scene outing at a real venue the owner picked (a prompt draft's lookup).
  if (action.kind === 'scene' && action.candidateId !== undefined && action.candidateId !== null) cands.push({ id: action.candidateId, action });
  if (action.kind === 'schedule' && Array.isArray(action.ranges)) {
    for (const r of action.ranges) if (r && r.candidateId !== undefined && r.candidateId !== null) cands.push({ id: r.candidateId, action });
  }
  if (action.kind === 'places.realify' || action.kind === 'routes.refresh') results.push({ id: action.resultId, kind: action.kind });
  if ((action.kind === 'bundle' || action.kind === 'retcon') && Array.isArray(action.actions)) {
    for (const a of action.actions.slice(0, 8)) geoIdsOf(a, cands, results, depth + 1);
  }
}

/**
 * Resolve the ids of a geo action (or a schedule action's ranges[].candidateId,
 * or those of every part of a bundle / retcon)
 * into frozen data for plan(). `geo` = the facade's geo service:
 *   { candidates: {get(id)}, results: {get(id)}, fetchRoutes(pairs, {coords, deadlineMs}) }
 * → { [candidateId | resultId]: frozen data } (empty when the action has none).
 * Throws {code:'expired', reason:'expired_candidate'|'expired_result'} via `err`;
 * `geo_off` when the action needs geo and there is none.
 */
export async function resolveGeoAction(action, state, { geo = null, world = null, err, now = () => Date.now() } = {}) {
  const resolved = {};
  const cands = [];
  const results = [];
  geoIdsOf(action, cands, results);
  if (!cands.length && !results.length) return resolved;
  if (!geo) throw err('refused', 'geo_off');
  for (const { id, action: part } of cands) {
    if (typeof id !== 'string' || !CAND_RE.test(id)) throw err('invalid', 'bad_candidateId');
    if (resolved[id]) continue;
    const venue = geo.candidates?.get?.(id) ?? null;
    if (!venue) throw err('expired', 'expired_candidate');
    // The place this venue would be (replace keeps its id; new → the opaque id).
    const taken = new Set(state?.places instanceof Map ? state.places.keys() : []);
    const existing = [...(state?.places instanceof Map ? state.places.values() : [])].find(p => p?.venue?.ref === venue.ref);
    const pid = part.kind === 'place.real' && part.as === 'replace' && typeof part.placeId === 'string'
      ? part.placeId : (existing?.id ?? venuePlaceId(venue.ref, taken));
    const pairs = pid ? routePairsFor(state, world, pid) : [];
    let routes = [];
    let routesState = 'ok';
    if (typeof geo.fetchRoutes === 'function' && pairs.length) {
      const coords = { [pid]: { lat: venue.lat, lon: venue.lon } };
      const res = await geo.fetchRoutes(pairs, { coords, deadlineMs: now() + PLACE_REAL_ROUTE_BUDGET_MS, max: 6 });
      routes = Array.isArray(res?.routes) ? res.routes : [];
      routesState = res?.state ?? 'ok';
    } else if (pairs.length) routesState = 'off';
    resolved[id] = deepFreeze({ venue: { ...venue }, placeId: pid, routes, routesState });
  }
  for (const { id: resultId, kind } of results) {
    if (typeof resultId !== 'string' || !RESULT_RE.test(resultId)) throw err('invalid', 'bad_resultId');
    if (resolved[resultId]) continue;
    const r = geo.results?.get?.(resultId) ?? null;
    if (!r || r.kind !== kind) throw err('expired', 'expired_result');
    resolved[resultId] = deepFreeze(structuredClone(r));
  }
  return resolved;
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return o;
}

// ── Pure planners (read ctx.resolved only) ────────────────────────────────

function venuePayload(v) {
  return {
    src: 'osm', ref: v.ref,
    ...(typeof v.area === 'string' && v.area ? { area: v.area } : {}),
    ...(typeof v.kindTag === 'string' ? { kindTag: v.kindTag } : {}),
  };
}

// route.recorded descriptors for the routes whose endpoints match `coords`
// (the place's planned coordinates after this action) and the current places.
function routeDescriptors(routes, ctx, coords, parent, b) {
  let n = 0;
  for (const r of Array.isArray(routes) ? routes : []) {
    if (!isObj(r) || !routeKey(r.a, r.b, r.profile) || !(r.a < r.b)) continue;
    const at = (id) => coords[id] ?? ctx.state.places.get(id) ?? null;
    const pa = at(r.a);
    const pb = at(r.b);
    if (!pa || !pb || !near(pa, r.aAt) || !near(pb, r.bAt)) continue;
    b.add({
      type: 'route.recorded', actor: 'owner', at: ctx.now, causeRef: parent,
      payload: { a: r.a, b: r.b, profile: r.profile, km: r.km, minutes: r.minutes, aAt: { ...r.aAt }, bAt: { ...r.bAt }, pts: r.pts.map(p => [p[0], p[1]]), src: 'osrm' },
    });
    n += 1;
  }
  return n;
}

function near(p, q) {
  if (!isObj(p) || !isObj(q) || !finite(p.lat) || !finite(q.lat)) return false;
  const dLat = (p.lat - q.lat) * 111320;
  const dLon = (p.lon - q.lon) * 111320 * Math.cos(p.lat * Math.PI / 180);
  return Math.hypot(dLat, dLon) <= 50;
}

function routesWarning(b, state) {
  if (state === 'later') b.warnings.push(ROUTES_LATER);
  else if (state === 'off') b.warnings.push(ROUTES_OFF);
}

/** place.real (§A3.2). h = director helpers {err, refuse, ownerParent, finishParent, placeRef, VISIBLE_EVERYWHERE}. */
export function planPlaceReal(action, ctx, b, h) {
  const { state } = ctx;
  if (typeof action.candidateId !== 'string' || !CAND_RE.test(action.candidateId)) throw h.err('invalid', 'bad_candidateId');
  if (action.as !== 'new' && action.as !== 'replace') throw h.err('invalid', 'bad_as');
  const res = ctx.resolved?.[action.candidateId];
  if (!isObj(res) || !isObj(res.venue)) throw h.err('expired', 'expired_candidate');
  const v = res.venue;
  const dup = [...state.places.values()].find(p => p?.venue?.ref === v.ref);
  if (action.as === 'new') {
    if (dup) { h.refuse(b, { reason: 'duplicate_venue', target: dup.id }); return { slices: ['places'] }; }
    if (state.places.size >= MAX_PLACES) { h.refuse(b, { reason: 'full', target: 'places' }); return { slices: ['places'] }; }
    const id = res.placeId && PLACE_ID_RE.test(res.placeId) && !state.places.has(res.placeId)
      ? res.placeId : venuePlaceId(v.ref, new Set(state.places.keys()));
    if (!id) { h.refuse(b, { reason: 'full', target: 'places' }); return { slices: ['places'] }; }
    const parent = h.ownerParent(b, action, ctx.now);
    b.add({ type: 'place.created', actor: 'owner', at: ctx.now, causeRef: parent,
      payload: { id, name: v.name, kind: v.kind, lat: v.lat, lon: v.lon, venue: venuePayload(v) } });
    routeDescriptors(res.routes, ctx, { [id]: { lat: v.lat, lon: v.lon } }, parent, b);
    h.finishParent(b, parent);
    routesWarning(b, res.routesState);
    b.warnings.push(h.VISIBLE_EVERYWHERE);
    return { slices: [`places.${id}`], extra: { place: { id, as: 'new', venue: true } } };
  }
  const placeId = h.placeRef(state, action.placeId);
  if (isPrivatePlace(state, placeId, ctx.world)) { h.refuse(b, { reason: 'private_place', target: placeId }); return { slices: [`places.${placeId}`] }; }
  if (dup && dup.id !== placeId) { h.refuse(b, { reason: 'duplicate_venue', target: dup.id }); return { slices: [`places.${placeId}`] }; }
  if (inUseNow(state, placeId)) { h.refuse(b, { reason: 'in_use', target: placeId }); return { slices: [`places.${placeId}`] }; }
  const old = state.places.get(placeId);
  const parent = h.ownerParent(b, action, ctx.now);
  b.add({ type: 'place.updated', actor: 'owner', at: ctx.now, causeRef: parent, payload: {
    placeId, name: v.name, kind: v.kind, lat: v.lat, lon: v.lon, venue: venuePayload(v),
    prev: { name: old.name, kind: old.kind, lat: old.lat, lon: old.lon, venue: isRealVenue(old) ? venuePayload(old.venue) : null },
  } });
  routeDescriptors(res.routes, ctx, { [placeId]: { lat: v.lat, lon: v.lon } }, parent, b);
  h.finishParent(b, parent);
  if (inTodaysPlan(state, placeId, ctx.now)) b.warnings.push(TODAY_TIMES);
  routesWarning(b, res.routesState);
  b.warnings.push(h.VISIBLE_EVERYWHERE);
  return { slices: [`places.${placeId}`], extra: { place: { id: placeId, as: 'replace', venue: true } } };
}

/**
 * places.realify (§A4.2): one owner place.updated per ticked swap (flagged
 * rows only when the owner ticked them), then the routes that match. extra =
 * the dry table (rows, kept-generic rows, the unsafe_name count).
 */
export function planRealify(action, ctx, b, h) {
  const { state } = ctx;
  if (typeof action.resultId !== 'string' || !RESULT_RE.test(action.resultId)) throw h.err('invalid', 'bad_resultId');
  const res = ctx.resolved?.[action.resultId];
  if (!isObj(res) || res.kind !== 'places.realify') throw h.err('expired', 'expired_result');
  const untick = new Set((Array.isArray(action.untick) ? action.untick : []).filter(x => typeof x === 'string'));
  const tick = new Set((Array.isArray(action.tick) ? action.tick : []).filter(x => typeof x === 'string'));
  const rows = [];
  const coords = {};
  const usedRefs = new Set([...state.places.values()].map(p => p?.venue?.ref).filter(Boolean));
  let parent = null;
  for (const s of Array.isArray(res.swaps) ? res.swaps : []) {
    const place = state.places.get(s.placeId);
    const v = s.venue;
    const flagged = Array.isArray(v?.flags) && v.flags.length > 0;
    const ticked = flagged ? tick.has(s.placeId) : !untick.has(s.placeId);
    const row = { placeId: s.placeId, oldName: place?.name ?? null, newName: v?.name ?? null, area: v?.area ?? null,
      kind: place?.kind ?? null, movedKm: finite(s.distKm) ? s.distKm : null, flags: Array.isArray(v?.flags) ? [...v.flags] : [], ticked, outcome: 'swap' };
    if (!place) row.outcome = 'gone';
    else if (isPrivatePlace(state, s.placeId, ctx.world)) row.outcome = 'private_place';
    else if (isRealVenue(place)) row.outcome = 'already_real';
    else if (inUseNow(state, s.placeId)) row.outcome = 'in_use';
    else if (!isObj(v) || usedRefs.has(v.ref)) row.outcome = 'duplicate_venue';
    else if (!ticked) row.outcome = 'unticked';
    rows.push(row);
    if (row.outcome !== 'swap') {
      if (['in_use', 'duplicate_venue', 'private_place'].includes(row.outcome)) h.refuse(b, { reason: row.outcome, target: s.placeId });
      continue;
    }
    usedRefs.add(v.ref);
    if (!parent) parent = h.ownerParent(b, action, ctx.now);
    b.add({ type: 'place.updated', actor: 'owner', at: ctx.now, causeRef: parent, payload: {
      placeId: s.placeId, name: v.name, kind: place.kind, lat: v.lat, lon: v.lon, venue: venuePayload(v),
      prev: { name: place.name, kind: place.kind, lat: place.lat, lon: place.lon, venue: null },
    } });
    coords[s.placeId] = { lat: v.lat, lon: v.lon };
    if (inTodaysPlan(state, s.placeId, ctx.now)) b.warnings.push(TODAY_TIMES);
  }
  let routes = 0;
  if (parent) {
    routes = routeDescriptors((res.routes ?? []).filter(r => coords[r.a] || coords[r.b]), ctx, coords, parent, b);
    h.finishParent(b, parent);
    routesWarning(b, res.routesState);
    b.warnings.push(h.VISIBLE_EVERYWHERE);
  } else if (!b.refusals.length) h.refuse(b, { reason: 'nothing', target: 'places' });
  const kept = (Array.isArray(res.kept) ? res.kept : []).map(k => ({ placeId: k.placeId, name: state.places.get(k.placeId)?.name ?? null, reason: k.reason }));
  return {
    slices: ['places'],
    extra: { realify: { rows, kept, unsafeName: Number.isSafeInteger(res.unsafeName) ? res.unsafeName : 0, routes, swaps: rows.filter(r => r.outcome === 'swap').length } },
  };
}

/** routes.refresh (§A2.3): one owner route.recorded per fetched route that still matches. */
export function planRoutesRefresh(action, ctx, b, h) {
  if (typeof action.resultId !== 'string' || !RESULT_RE.test(action.resultId)) throw h.err('invalid', 'bad_resultId');
  const res = ctx.resolved?.[action.resultId];
  if (!isObj(res) || res.kind !== 'routes.refresh') throw h.err('expired', 'expired_result');
  const parent = h.ownerParent(b, action, ctx.now);
  const n = routeDescriptors(res.routes, ctx, {}, parent, b);
  if (!n) {
    b.events.splice(b.events.findIndex(e => e.ref === parent), 1);
    h.refuse(b, { reason: res.routesState === 'off' ? ROUTES_OFF : 'nothing', target: 'routes' });
    return { slices: [], extra: { routes: { pairs: res.pairs ?? 0, recorded: 0, failed: res.failed ?? 0 } } };
  }
  h.finishParent(b, parent);
  return { slices: [], extra: { routes: { pairs: res.pairs ?? 0, recorded: n, failed: res.failed ?? 0 } } };
}

/**
 * sched's seam (A5.9, P.3.5): a schedule range's `candidateId` → the place to
 * use. Pure; reads ctx.resolved only. An existing place with the same venue
 * ref is reused (no descriptors). → { descriptors:[…], placeId } | { refusal }.
 * Descriptors carry no causeRef: the caller adds them under its own parent.
 */
export function venuePlace(candidateId, ctx) {
  const res = ctx?.resolved?.[candidateId];
  if (!isObj(res) || !isObj(res.venue)) return { refusal: 'expired_candidate' };
  const state = ctx.state;
  const v = res.venue;
  const existing = [...(state?.places instanceof Map ? state.places.values() : [])].find(p => p?.venue?.ref === v.ref);
  if (existing) return { descriptors: [], placeId: existing.id };
  if ((state?.places?.size ?? 0) >= MAX_PLACES) return { refusal: 'full' };
  const id = res.placeId && PLACE_ID_RE.test(res.placeId) && !state.places.has(res.placeId)
    ? res.placeId : venuePlaceId(v.ref, new Set(state.places.keys()));
  if (!id) return { refusal: 'full' };
  const descriptors = [{ type: 'place.created', actor: 'owner', at: ctx.now, payload: { id, name: v.name, kind: v.kind, lat: v.lat, lon: v.lon, venue: venuePayload(v) } }];
  const coords = { [id]: { lat: v.lat, lon: v.lon } };
  for (const r of Array.isArray(res.routes) ? res.routes : []) {
    if (!routeKey(r.a, r.b, r.profile) || !(r.a < r.b)) continue;
    const pa = coords[r.a] ?? state.places.get(r.a);
    const pb = coords[r.b] ?? state.places.get(r.b);
    if (!pa || !pb || !near(pa, r.aAt) || !near(pb, r.bAt)) continue;
    descriptors.push({ type: 'route.recorded', actor: 'owner', at: ctx.now,
      payload: { a: r.a, b: r.b, profile: r.profile, km: r.km, minutes: r.minutes, aAt: { ...r.aAt }, bAt: { ...r.bAt }, pts: r.pts.map(p => [p[0], p[1]]), src: 'osrm' } });
  }
  return { descriptors, placeId: id };
}
