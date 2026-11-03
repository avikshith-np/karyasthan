import crypto from 'crypto';

// 014 real places (spec 014 plan §A0, §A2, §A4, §A7). Pure helpers — no I/O,
// no clock, no RNG. The geo client (src/life/geo/) does the lookups; what it
// finds enters the world only as owner events (place.created {venue},
// place.updated {lat, lon, venue}, route.recorded), and everything here reads
// those through the projection.
//
//   worldWithPlaces(state, world)   the world with the projected places (projected
//                                   wins on every id) and the stored routes; the
//                                   world itself, by identity, while nothing moved
//   routeFor(world, a, b, profile)  a stored road route whose endpoints still sit
//                                   where they were when it was fetched (≤ 50 m)
//   placeLabel(state, id, opts)     the safe wording of a place: a real venue (or
//                                   an owner-named place) next to a negative event
//                                   is worded by its kind ("a cafe"), never named
//   negativeAt / negativeNow        is a place / "now" a negative context
//   scrubVenueNames / scrubNegativeVenue   stored labels and model text
//
// Nothing here names a real city, area or venue: names live only in the
// per-install log and world.

const EARTH_RADIUS_KM = 6371;
export const ROUTE_MATCH_M = 50;
export const REGION_MARGIN_KM = 10;
export const NEGATIVE_WINDOW_SEC = 3 * 3600;
export const ROUTE_PROFILES = Object.freeze(['car', 'foot']);
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Projected places are authoritative (A0) ───────────────────────────────

const fileIndexes = new WeakMap();
function fileIndex(world) {
  let idx = fileIndexes.get(world);
  if (idx && idx.src === world.places) return idx.map;
  const p = world?.places;
  const list = p instanceof Map ? [...p.values()] : (Array.isArray(p) ? p : []);
  const map = new Map(list.filter(x => x && typeof x.id === 'string').map(x => [x.id, x]));
  fileIndexes.set(world, { src: p, map });
  return map;
}

/**
 * The content key of the projected places against the file's: '' while every
 * projected place sits where the file has it (same id, lat, lon, kind) and no
 * 014 fold happened; else `placesSig` + the differing places. A name-only
 * rename is not a difference (travel and planners read ids, coordinates and
 * kinds). O(places), no hashing: the projector calls it per folded event.
 */
export function placesKey(state, world) {
  const sig = typeof state?.placesSig === 'string' ? state.placesSig : '';
  const proj = state?.places instanceof Map ? state.places : null;
  let diff = '';
  if (proj && proj.size && isObj(world)) {
    const file = fileIndex(world);
    for (const [id, p] of proj) {
      const f = file.get(id);
      if (!f || f.lat !== p?.lat || f.lon !== p?.lon || (f.kind ?? 'place') !== (p?.kind ?? 'place')) {
        diff += `${id}@${p?.lat},${p?.lon},${p?.kind};`;
      }
    }
  }
  return sig || diff ? `${sig}|${diff}` : '';
}

const mergedMemo = new WeakMap();

/**
 * The world every planner should see (plan §A0, R19): `world` itself, by
 * identity, while placesKey is '' (so every pre-014 fixture is untouched);
 * else a copy whose places are the file's overlaid by the projected ones
 * (projected wins on every id; projected-only places appended in fold order)
 * and whose `routes` are the stored road routes. Never mutates `world`.
 */
export function worldWithPlaces(state, world) {
  if (!isObj(world)) return world;
  const key = placesKey(state, world);
  if (!key) return world;
  const hit = mergedMemo.get(world);
  if (hit && hit.key === key && hit.routes === state?.routes) return hit.value;
  const file = Array.isArray(world.places) ? world.places : (world.places instanceof Map ? [...world.places.values()] : []);
  const proj = state?.places instanceof Map ? state.places : new Map();
  const strip = (p) => {
    const { eventId, ...rest } = p;
    return rest;
  };
  const merged = file.map(p => (proj.has(p?.id) ? strip(proj.get(p.id)) : p));
  const fileIds = new Set(file.map(p => p?.id));
  for (const [id, p] of proj) if (!fileIds.has(id) && isObj(p)) merged.push(strip(p));
  const value = { ...world, places: merged, ...(isObj(state?.routes) ? { routes: state.routes } : {}) };
  mergedMemo.set(world, { key, routes: state?.routes, value });
  return value;
}

// ── Region box (R1: one canonical box, fail closed) ───────────────────────

/** {minLat, maxLat, minLon, maxLon} of the places (state Map or world list) + 10 km, or null. */
export function regionBox(stateOrWorld) {
  const p = stateOrWorld?.places;
  const pts = (p instanceof Map ? [...p.values()] : (Array.isArray(p) ? p : [])).filter(x => finite(x?.lat) && finite(x?.lon));
  if (!pts.length) return null;
  const lat = pts.map(x => x.lat);
  const lon = pts.map(x => x.lon);
  const dLat = REGION_MARGIN_KM / 111;
  const midLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const dLon = REGION_MARGIN_KM / (111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
  return { minLat: Math.min(...lat) - dLat, maxLat: Math.max(...lat) + dLat, minLon: Math.min(...lon) - dLon, maxLon: Math.max(...lon) + dLon };
}

/** True only when all four box keys are finite and the point is inside (fail closed). */
export function inRegion(lat, lon, box) {
  if (!isObj(box) || !['minLat', 'maxLat', 'minLon', 'maxLon'].every(k => finite(box[k]))) return false;
  if (!finite(lat) || !finite(lon)) return false;
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

// ── Routes (A2) ───────────────────────────────────────────────────────────

/** The unordered route key `<a>|<b>|<profile>` (a < b lexically), or null. */
export function routeKey(a, b, profile) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === b || !ROUTE_PROFILES.includes(profile)) return null;
  return a < b ? `${a}|${b}|${profile}` : `${b}|${a}|${profile}`;
}

function placeIn(world, id) {
  const p = world?.places;
  if (p instanceof Map) return p.get(id) ?? null;
  return Array.isArray(p) ? fileIndex(world).get(id) ?? null : null;
}

/**
 * The stored route between two places for a profile, when both endpoints are
 * still within 50 m of where they were when it was fetched; else null (the
 * trip falls back to today's estimate). → {key, km, minutes, eventId, a, b}.
 */
export function routeFor(world, a, b, profile) {
  const key = routeKey(a, b, profile);
  const routes = world?.routes;
  if (!key || !isObj(routes)) return null;
  const r = routes[key];
  if (!isObj(r) || !finite(r.km) || !isObj(r.aAt) || !isObj(r.bAt)) return null;
  const [x, y] = key.split('|');
  const px = placeIn(world, x);
  const py = placeIn(world, y);
  if (!px || !py || !finite(px.lat) || !finite(py.lat)) return null;
  if (haversineKm(px, r.aAt) * 1000 > ROUTE_MATCH_M || haversineKm(py, r.bAt) * 1000 > ROUTE_MATCH_M) return null;
  return { key, km: r.km, minutes: r.minutes, eventId: r.eventId ?? null, a: x, b: y };
}

// ── Route pairs (§A2.3) ───────────────────────────────────────────────────

/**
 * The route pairs for a place `pid` (§A2.3): {home, office, family home} × {pid}.
 * → [[x, y]] with x < y, no self-pairs, no duplicates.
 */
export function routePairsFor(state, world, pid) {
  const out = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    out.set(`${x}|${y}`, [x, y]);
  };
  for (const id of anchorIds(state, world)) add(id, pid);
  return [...out.values()];
}

// His home, office (career overlay first) and the family home(s) that exist.
function anchorIds(state, world) {
  const ids = [];
  const home = state?.self?.homePlaceId ?? world?.self?.homePlaceId ?? null;
  const office = state?.story?.career?.officePlaceId ?? state?.self?.officePlaceId ?? world?.self?.job?.officePlaceId ?? null;
  if (home) ids.push(home);
  if (office) ids.push(office);
  for (const p of state?.places instanceof Map ? state.places.values() : []) {
    if (p?.kind === 'home' && p.id !== home) ids.push(p.id);
  }
  return ids.filter(id => state?.places?.has?.(id));
}

/**
 * Every pair a full refresh takes (§A2.3): all pairs among home, office and the
 * routine leisure places, plus each other place ↔ home; capped at `max`.
 */
export function refreshPairs(state, world, max = 48) {
  const out = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b || !state?.places?.has?.(a) || !state.places.has(b)) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    out.set(`${x}|${y}`, [x, y]);
  };
  const home = state?.self?.homePlaceId ?? world?.self?.homePlaceId ?? null;
  const office = state?.story?.career?.officePlaceId ?? state?.self?.officePlaceId ?? world?.self?.job?.officePlaceId ?? null;
  const leisure = (Array.isArray(world?.routine?.leisure) ? world.routine.leisure : []).map(l => l?.placeId).filter(Boolean);
  const core = [...new Set([home, office, ...leisure].filter(Boolean))].sort();
  for (let i = 0; i < core.length; i++) for (let j = i + 1; j < core.length; j++) add(core[i], core[j]);
  const all = [...(state?.places instanceof Map ? state.places.keys() : [])].sort();
  for (const id of all) add(id, home);
  return [...out.values()].slice(0, max);
}

/** Is a home-kind endpoint (sent rounded, straightened near it)? */
export function isHomeKind(state, id) {
  const p = state?.places?.get?.(id);
  return p?.kind === 'home' || id === state?.self?.homePlaceId;
}

// ── Venues ────────────────────────────────────────────────────────────────

/** A real venue: a place carrying OSM venue data (015 uses the same name). */
export function isRealVenue(place) {
  return !!(isObj(place) && isObj(place.venue));
}

/** A real venue, or a place the owner renamed (R16: the name may be a real business). */
export function isVenueLike(place) {
  return isRealVenue(place) || (isObj(place) && place.ownerNamed === true);
}

/** The opaque id of a venue place (R2): `place:v<8 hex of sha256(ref)>` — never a slug of its name. */
export function venuePlaceId(ref, taken = new Set()) {
  const base = `place:v${crypto.createHash('sha256').update(String(ref)).digest('hex').slice(0, 8)}`;
  let id = base;
  for (let i = 2; taken.has(id) && i < 100; i++) id = `${base}-${i}`;
  return PLACE_ID_RE.test(id) ? id : null;
}

const KIND_WORDS = Object.freeze({
  cafe: 'a cafe', coffee: 'a cafe', restaurant: 'a restaurant', 'eat-out': 'a restaurant', food: 'a restaurant',
  bar: 'a bar', pub: 'a bar', brewpub: 'a bar', drinks: 'a bar', cinema: 'the cinema', mall: 'a mall', gym: 'the gym',
  park: 'a park', shop: 'a shop', grocery: 'a shop', groceries: 'a shop', supermarket: 'a shop', bookshop: 'a bookshop',
  books: 'a bookshop', landmark: 'a landmark', attraction: 'a landmark',
});

/** A kind word for a place kind ("a cafe", "the gym"), else "out". */
export function kindWord(kind) {
  return KIND_WORDS[kind] ?? 'out';
}

// Venues whose name collides with a real person's (§A1.3 sweep): the facade
// refreshes this set; placeLabel words them by their kind everywhere.
let collidingIds = new Set();
export function setCollidingVenues(ids) {
  collidingIds = new Set(Array.isArray(ids) || ids instanceof Set ? ids : []);
}
export function collidingVenues() {
  return new Set(collidingIds);
}

/**
 * The safe wording of place `id`: a venue-like place next to a negative event
 * (`negative`), or one whose name collides with a real person's, → its kind
 * word; anything else → its name (generic places keep their names in every
 * context, so every pre-014 wording is unchanged). Null for an unknown id.
 */
export function placeLabel(state, id, { negative = false } = {}) {
  const place = state?.places instanceof Map ? state.places.get(id) : null;
  if (!place) return null;
  if (isVenueLike(place) && (negative || collidingIds.has(id))) return kindWord(place.kind);
  return place.name ?? null;
}

/** placeLabel for a site that already has a name in hand (keeps the site's own wording). */
export function safePlaceName(state, id, name, opts = {}) {
  const place = state?.places instanceof Map ? state.places.get(id) : null;
  if (!place || !isVenueLike(place)) return name;
  if (opts.negative || collidingIds.has(id)) return kindWord(place.kind);
  return name;
}

// Every venue name ever recorded (R5), for render-time scrubs of stored labels:
// the facade installs its log reader (venueEntriesEver); default none.
let venueNamesSource = () => [];
export function setVenueNamesSource(fn) {
  venueNamesSource = typeof fn === 'function' ? fn : () => [];
}
/** [{name, kind}] of every venue ever recorded ([] when none / unreadable). */
export function venueNamesNow() {
  try { const v = venueNamesSource(); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** A stored label read in a negative context: every venue name → its kind word (R5). */
export function negativeLabel(text, negative) {
  return negative ? scrubVenueNames(text, venueNamesNow()) : text;
}

/** The mouth's tail line (§A7), only when a venue name appears in `text`; else ''. */
export function venueToneNote(text) {
  const hits = entriesOf(venueNamesNow()).filter(e => mentionsVenue(text, [e]));
  if (!hits.length) return '';
  const names = hits.slice(0, 3).map(e => e.name).join(', ');
  return `Don't say anything bad about ${names}; if something went wrong there, don't name the place.`;
}

// ── Private places (§A3.2) ────────────────────────────────────────────────

export const PRIVATE_KINDS = Object.freeze(['home', 'office', 'school', 'college', 'hospital', 'clinic',
  'place_of_worship', 'temple', 'church', 'mosque']);

/**
 * Home, office (career overlay too), any home-kind place, a cast home, a private kind (family* incl.),
 * and (015 §1.8) every former home in `self.homeHistory` (a god move keeps the old one private).
 */
export function isPrivatePlace(state, id, world = null) {
  if (typeof id !== 'string') return true;
  const place = state?.places instanceof Map ? state.places.get(id) : null;
  const kind = place?.kind ?? '';
  if (PRIVATE_KINDS.includes(kind) || kind.startsWith('family')) return true;
  if (id === state?.self?.homePlaceId || id === state?.self?.officePlaceId) return true;
  if (Array.isArray(state?.self?.homeHistory) && state.self.homeHistory.includes(id)) return true;
  if (id === state?.story?.career?.officePlaceId) return true;
  if (id === world?.self?.homePlaceId || id === world?.self?.officePlaceId || id === world?.self?.job?.officePlaceId) return true;
  for (const c of state?.cast instanceof Map ? state.cast.values() : []) if (c?.home === id) return true;
  return false;
}

/**
 * Places "make places real" may switch (A4.1), ordered by id: not private, no
 * venue yet, and a kind `mapped(kind)` knows. → {places, noMapping:[ids]}.
 */
export function switchablePlaces(state, { mapped = () => false, world = null } = {}) {
  const places = [];
  const noMapping = [];
  const all = [...(state?.places instanceof Map ? state.places.values() : [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of all) {
    if (!p?.id || isPrivatePlace(state, p.id, world) || isRealVenue(p)) continue;
    if (!finite(p.lat) || !finite(p.lon)) continue;
    if (mapped(p.kind)) places.push(p);
    else noMapping.push(p.id);
  }
  return { places, noMapping };
}

// ── Negative events (A7, R4) ──────────────────────────────────────────────

const neg = (v) => finite(v) && v < 0;
// Conditional rules from the real payloads; a type listed here is negative only
// when its rule says so (else it is neutral for that event).
const NEGATIVE_RULES = Object.freeze({
  'sick.started': () => true,
  'sick.ended': () => true,
  'commute.soaked': () => true,
  'heavy.proposed': () => true,
  'heavy.vetoed': () => true,
  'heavy.lapsed': () => true,
  'heavy.started': () => true,
  'heavy.ended': () => true,
  'work.behind': () => true,
  'money.spent': (p) => p?.for === 'setback',
  // 015: a god "it fell through" cancel is negative like a missed outing.
  'decision.expired': (p) => p?.reason === 'could_not_go' || p?.reason === 'fell_through',
  'relationship.changed': (p) => ['decision', 'outing', 'scene'].includes(p?.reason)
    && (neg(p?.delta?.closeness) || neg(p?.delta?.trust) || (finite(p?.delta?.tension) && p.delta.tension > 0)),
  'mood.chat': (p) => neg(p?.delta?.valence),
  'cast.beat': (p) => p?.kind === 'away' || p?.kind === 'news',
  // 015 Director as god (plan §1.8): an outcome that went badly, losing his job, an expense.
  'outcome.happened': (p) => p?.outcome === 'badly',
  'career.set': (p) => p?.reason === 'fire' || p?.reason === 'quit',
  'money.adjusted': (p) => p?.mode === 'expense',
  // 016: a scene that ended badly (the place is worded by its kind nearby).
  'scene.played': (p) => p?.ending === 'parted_badly' || p?.ending === 'left_early' || p?.outcome === 'badly',
});
export const NEGATIVE_TYPES = Object.freeze(new Set(Object.keys(NEGATIVE_RULES)));

/** Every other catalogue type (a guard test checks NEGATIVE ∪ NEUTRAL covers EVENT_TYPES). */
export const NEUTRAL_TYPES = Object.freeze(new Set([
  'genesis', 'place.created', 'cast.created', 'world.reanchored', 'plan.made',
  'activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'meal',
  'sleep.started', 'woke', 'work.late', 'work.crunch', 'weather.changed',
  'money.salary', 'vitals.checkpoint', 'birthday', 'wallet.started',
  'phone.message', 'phone.text_set',   // 019: texts with the fictional cast
  'dream.had',                         // 020 G: kind words only, and a dream isn't a bad thing at a venue
  'phone.check.started', 'phone.check.ended', 'availability.changed',
  'decision.opened', 'decision.lean', 'decision.committed', 'decision.reversed', 'decision.mode_set',
  'chat.trigger', 'call.answered', 'claim.flagged',
  'embargo.started', 'embargo.ended', 'alert.raised', 'event.reverted',
  'cast.updated', 'cast.history_added', 'place.updated',
  'arc.started', 'arc.stage', 'arc.ended',
  'career.appraisal', 'career.hunt', 'career.resigned', 'career.job_changed',
  'family.call', 'family.occasion', 'story.daily_done',
  'claim.adopted', 'activity.recorded', 'commitment.recorded', 'claim.withdrawn',
  'director.action', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
  'director.paused', 'director.resumed', 'director.bookmark', 'director.bookmark_removed',
  'director.seed_set', 'director.reconciler_mode',
  'vitals.nudged', 'world.rewound',
  'wake.set',   // wake him
  'chat.perceived', 'sleep.delayed', 'invite.answered', 'invite.followed_up', 'chat.load',
  'weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled',
  'goal.fitted', 'goal.deferred', 'goal.done', 'goal.expired',
  // 014 (geo + sched, by name: P.3.1)
  'route.recorded', 'schedule.override_set', 'schedule.override_cleared',
  // 015 (the rest of its god types; outcome.happened / career.set / money.adjusted are conditional above)
  'outcome.set', 'self.moved', 'change.applied', 'vitals.planned', 'sick.planned', 'cast.departed', 'cast.returned',
  // 016 (scene.played is conditional above)
  'scene.followup', 'scene.followup_lapsed', 'scene.tone_set', 'scene.regenerated',
]));

/** Is this event (type + payload) negative? */
export function isNegativeEvent(ev) {
  const rule = NEGATIVE_RULES[ev?.type];
  if (!rule) return false;
  try { return rule(isObj(ev.payload) ? ev.payload : {}) === true; } catch { return true; }
}

// Where he was at time `t`, from the events (sorted by at, then id): the
// newest activity/travel/sleep start at or before t.
function whereAt(events, t, home) {
  let where = null;
  for (const e of events) {
    if (!finite(e?.at) || e.at > t) continue;
    const p = isObj(e.payload) ? e.payload : {};
    if (e.type === 'activity.started' && typeof p.placeId === 'string') where = { placeId: p.placeId, travelTo: null };
    else if (e.type === 'travel.started') where = { placeId: null, travelTo: typeof p.to === 'string' ? p.to : null };
    else if (e.type === 'travel.arrived' && typeof p.to === 'string') where = { placeId: p.to, travelTo: null };
    else if (e.type === 'sleep.started') where = { placeId: home, travelTo: null };
  }
  return where;
}

/**
 * Is `placeId` a negative context at `at`? True when a negative event within
 * ±3 h had him at that place, or travelling to it (computed from his position
 * in `events`, not from a payload placeId — sick, heavy and mood events carry
 * none), or names it (a could_not_go decision's place, a soaked trip's
 * destination). `events` = the log around `at` (the caller's window).
 */
export function negativeAt(state, at, { placeId, events = [] } = {}) {
  if (typeof placeId !== 'string' || !finite(at)) return false;
  const list = (Array.isArray(events) ? events : []).filter(e => finite(e?.at))
    .slice().sort((a, b) => (a.at - b.at) || ((a.id ?? 0) - (b.id ?? 0)));
  const home = state?.self?.homePlaceId ?? null;
  for (const e of list) {
    if (Math.abs(e.at - at) > NEGATIVE_WINDOW_SEC || !isNegativeEvent(e)) continue;
    const p = isObj(e.payload) ? e.payload : {};
    if (p.placeId === placeId || p.to === placeId) return true;
    // A could_not_go / fell_through decision, or an outing that went badly (015
    // outcome.happened fires as he leaves): the decision's place.
    if (e.type === 'decision.expired' || e.type === 'outcome.happened') {
      const d = state?.decisions instanceof Map ? state.decisions.get(p.decisionId) : null;
      if (d?.subject?.placeId === placeId) return true;
    }
    const w = whereAt(list, e.at, home);
    if (w && (w.placeId === placeId || w.travelTo === placeId)) return true;
  }
  return false;
}

/**
 * Is "now" a negative context (innerState: the place he is at / heading to is
 * worded by its kind)? Sick, a heavy stretch or embargo, soaked in the last
 * 3 h, or a negative chat mood still in force.
 */
export function negativeNow(state, at) {
  if (!state) return false;
  if (state.vitals?.sick === true || state.sick?.since) return true;
  if (state.embargo && finite(state.embargo.until) && finite(at) && at < state.embargo.until) return true;
  const h = state.story?.heavy?.active;
  if (isObj(h) && finite(h.until) && finite(at) && at < h.until) return true;
  if (isObj(state.soakedAt) && finite(state.soakedAt.at) && finite(at) && at - state.soakedAt.at <= NEGATIVE_WINDOW_SEC) return true;
  if (finite(state.soakedAt) && finite(at) && at - state.soakedAt <= NEGATIVE_WINDOW_SEC) return true;
  const cm = state.chatMood;
  if (Array.isArray(cm) && cm.some(m => neg(m?.dv) && finite(m?.at) && finite(at) && at - m.at <= NEGATIVE_WINDOW_SEC)) return true;
  return false;
}

// ── Text scrubs (stored labels, model text, owner text) ───────────────────

export const NEGATIVE_CUES = Object.freeze(['sick', 'ill', 'food poisoning', 'robbed', 'stolen', 'fight', 'awful', 'terrible',
  'worst', 'cockroach', 'soaked', 'accident', 'fired', 'poisoned', 'rude', 'dirty', 'horrible', 'disgusting']);
const CUE_RE = new RegExp(`\\b(?:${NEGATIVE_CUES.map(c => c.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Entries: 'name' or {name, kind}. Longest first, so "Foo Bar" wins over "Foo".
function entriesOf(names) {
  return (Array.isArray(names) ? names : [])
    .map(n => (typeof n === 'string' ? { name: n, kind: null } : (isObj(n) && typeof n.name === 'string' ? n : null)))
    .filter(n => n && n.name.trim().length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
}
function nameRe(name) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name.trim()).replace(/\s+/g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'giu');
}

/** Replace every venue name in `text` by its kind word (a stored label read in a negative context, R5). */
export function scrubVenueNames(text, names) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const e of entriesOf(names)) out = out.replace(nameRe(e.name), (m, pre) => `${pre}${kindWord(e.kind)}`);
  return out;
}

/** Model text: in any sentence with a negative cue word, venue names become kind words. */
export function scrubNegativeVenue(text, names) {
  if (typeof text !== 'string' || !text) return text;
  const list = entriesOf(names);
  if (!list.length) return text;
  return text.split(/(?<=[.!?\n])/).map(s => (CUE_RE.test(s) ? scrubVenueNames(s, list) : s)).join('');
}

/** Owner text naming a venue (normalised, whole word) together with a negative cue (refused `negative_at_venue`). */
export function negativeAtVenue(text, names) {
  if (typeof text !== 'string' || !text || !CUE_RE.test(text)) return false;
  const norm = ` ${normName(text)} `;
  return entriesOf(names).some(e => {
    const n = normName(e.name);
    return n.length >= 2 && norm.includes(` ${n} `);
  });
}

/** Does `text` contain a venue name (normalised, whole word)? */
export function mentionsVenue(text, names) {
  if (typeof text !== 'string' || !text) return false;
  const norm = ` ${normName(text)} `;
  return entriesOf(names).some(e => {
    const n = normName(e.name);
    return n.length >= 2 && norm.includes(` ${n} `);
  });
}

// world.js normalizeName's rule (format characters first), kept local so this
// module stays import-free.
function normName(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
