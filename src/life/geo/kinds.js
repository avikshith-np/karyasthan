// 014 geo (plan §A1.2): place kinds ↔ OpenStreetMap tags. Pure constants.
// Only public venues (restaurants, cafes, bars, malls, cinemas, gyms, parks,
// shops, landmarks) are allowed; homes, offices, schools, hospitals and places
// of worship are never switched or offered. The Overpass QL is built ONLY from
// these constants (threat T2): no owner or model text ever reaches it.

/** World place kind → its OSM filters [{key, value, evidence?}]; `evidence` = a public-business tag is required. */
export const KIND_TAGS = Object.freeze({
  cafe: [['amenity', 'cafe']],
  coffee: [['amenity', 'cafe']],
  restaurant: [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  'eat-out': [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  food: [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  bar: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten'], ['craft', 'brewery']],
  pub: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten'], ['craft', 'brewery']],
  brewpub: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten'], ['craft', 'brewery']],
  drinks: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten'], ['craft', 'brewery']],
  mall: [['shop', 'mall']],
  cinema: [['amenity', 'cinema']],
  gym: [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']],
  park: [['leisure', 'park']],
  shop: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'greengrocer']],
  grocery: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'greengrocer']],
  groceries: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'greengrocer']],
  supermarket: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'greengrocer']],
  bookshop: [['shop', 'books']],
  books: [['shop', 'books']],
  landmark: [['tourism', 'attraction'], ['tourism', 'museum'], ['historic', 'monument']],
  attraction: [['tourism', 'attraction'], ['tourism', 'museum'], ['historic', 'monument']],
});

// Gyms (leisure=fitness_centre|sports_centre) are kept only with evidence of a
// public business (R8): a private residential gym has none of these.
const GYM_EVIDENCE = ['opening_hours', 'website', 'brand', 'phone', 'contact:website', 'contact:phone'];
const EVIDENCE_KINDS = new Set(['fitness_centre', 'sports_centre']);

/** Kinds never switched and never offered (homes, offices, schools, health, worship). */
export const PRIVATE_KINDS = Object.freeze(['home', 'office', 'school', 'college', 'hospital', 'clinic',
  'place_of_worship', 'temple', 'church', 'mosque']);

/** Every allowed OSM (key, value) pair. */
export const ALLOWED_OSM_CLASSES = Object.freeze([...new Set(Object.values(KIND_TAGS).flat().map(([k, v]) => `${k}=${v}`))]);

// The canonical kind a (key, value) pair maps back to (first world kind listing it).
const CANONICAL = new Map();
for (const [kind, tags] of Object.entries(KIND_TAGS)) {
  for (const [k, v] of tags) if (!CANONICAL.has(`${k}=${v}`)) CANONICAL.set(`${k}=${v}`, kind);
}

/** Is `kind` a world kind with an OSM mapping? */
export function isMappedKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_TAGS, kind)
    && !PRIVATE_KINDS.includes(kind) && !kind.startsWith('family');
}

const ACCESS_BAD = new Set(['private', 'no', 'residents', 'customers', 'permissive']);

/** Post-filter on every result's tags (R8): no private access, no residential garden, no private operator. */
export function accessOk(tags) {
  if (!tags || typeof tags !== 'object') return true;
  if (ACCESS_BAD.has(String(tags.access ?? '').toLowerCase())) return false;
  if (String(tags['garden:type'] ?? '').toLowerCase() === 'residential') return false;
  if (String(tags['operator:type'] ?? '').toLowerCase() === 'private') return false;
  return true;
}

const DROP_KEYS = ['building', 'highway', 'boundary'];

/**
 * The world kind an OSM element maps to (from its tags), or null: an allowed
 * class, a name, access OK, gyms only with public-business evidence; never a
 * building/house/residential/highway/boundary element.
 */
export function kindOfOsm(tags) {
  if (!tags || typeof tags !== 'object' || typeof tags.name !== 'string' || !tags.name.trim()) return null;
  if (!accessOk(tags)) return null;
  if (['house', 'houses', 'apartments'].includes(tags.place) || tags.landuse === 'residential') return null;
  for (const k of DROP_KEYS) {
    if (tags[k] !== undefined && !Object.keys(tags).some(t => ['amenity', 'shop', 'leisure', 'tourism', 'historic', 'craft'].includes(t))) return null;
  }
  for (const key of ['amenity', 'shop', 'leisure', 'tourism', 'historic', 'craft']) {
    const v = tags[key];
    if (typeof v !== 'string') continue;
    const kind = CANONICAL.get(`${key}=${v}`);
    if (!kind) continue;
    if (key === 'leisure' && EVIDENCE_KINDS.has(v) && !GYM_EVIDENCE.some(e => typeof tags[e] === 'string' && tags[e].trim())) return null;
    return kind;
  }
  return null;
}

/** Nominatim (category, type) → a world kind, through the same table, or null. */
export function kindOfNominatim(category, type, extratags = {}) {
  if (typeof category !== 'string' || typeof type !== 'string') return null;
  return kindOfOsm({ ...extratags, name: 'x', [category]: type });
}

/** A neighbourhood result (accepted only as an area, never a place). */
export function isAreaResult(category, type) {
  return category === 'place' && ['suburb', 'neighbourhood', 'quarter'].includes(type);
}

/**
 * The Overpass QL for "nearest <kind> near <lat,lon>" (§A1.1): built only from
 * KIND_TAGS, the access filter and numbers. Throws `bad_input` for anything else.
 */
export function overpassQuery(kind, lat, lon, radiusM) {
  if (!isMappedKind(kind)) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
  }
  const r = Math.round(radiusM);
  if (!Number.isInteger(r) || r < 200 || r > 5000) throw Object.assign(new Error('bad_input'), { code: 'bad_input' });
  const at = `${r},${lat.toFixed(6)},${lon.toFixed(6)}`;
  const access = '[access!~"^(private|no|residents|customers|permissive)$"]';
  const parts = KIND_TAGS[kind].map(([k, v]) => `nwr[${k}=${v}][name]${access}(around:${at});`).join('');
  return `[out:json][timeout:20];(${parts});out center tags 40;`;
}
