import crypto from 'crypto';
import { config } from '../../utils/config.js';
import { logger as rootLogger } from '../../utils/logger.js';
import { inRegion } from '../places.js';
import { KIND_TAGS, isMappedKind, kindOfOsm, kindOfNominatim, isAreaResult, overpassQuery, accessOk } from './kinds.js';
import { cleanVenueName, cleanArea, nameFlags, realNamesOrThrow, simplify, toE5, straightenNear } from './clean.js';

// 014 geo client (spec 014 plan §A1.1, threat model T1/T2/T7/T14). The ONLY
// module in src/ that calls fetch for geo. One instance per process, built in
// src/index.js start() and handed to startLife({geo}); everything else reaches
// it through the life facade, so every caller shares one per-host queue and
// one daily cap.
//
//   search(q, {box, limit, areas})   Nominatim /search inside the region box
//   nearest(kind, {lat, lon}, m)     Overpass "nearest <kind>" (QL from constants only)
//   route(a, b, profile, {aHome, bHome})   OSRM /route between two known points
//   status()                          codes and counts only
//
// Requests are built ONLY from the fixed .env base URLs + encoded parameters
// (no URL ever comes from a request body, a chat or a model), redirect:'error',
// a per-host serial queue ≥ 1 s apart, a timeout, a JSON content-type and a
// byte cap, one Retry-After retry on 429/503 (counted), an in-memory LRU
// (search/nearest 24 h, route 7 d; the email is never part of a key) and a
// daily cap. Every failure is a bare GeoError(code) — no cause, no message
// text from fetch, no URL — and logs carry {evt:'geo', host, op, ms, code}
// only: never the query, names, coordinates or the contact email.

export const GEO_ERROR_CODES = Object.freeze(['off', 'unconfigured', 'cap', 'timeout', 'bad_type', 'too_big', 'bad_json',
  'bad_input', 'names_unavailable', 'network', 'busy']);

export class GeoError extends Error {
  constructor(code) {
    super(`geo: ${code}`);
    this.name = 'GeoError';
    this.code = code;
  }
}
const fail = (code) => { throw new GeoError(code); };

const MIN_GAP_MS = 1000;
const CACHE_MAX = 300;
const TTL_SEARCH_MS = 24 * 3600_000;
const TTL_ROUTE_MS = 7 * 24 * 3600_000;
const CAP_BYTES = { nominatim: 256 * 1024, overpass: 1024 * 1024, osrm: 256 * 1024 };
const QUERY_MAX = 80;
const ROUTE_PTS_MAX = 200;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

function dayOf(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

async function readCapped(res, cap) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > cap) fail('too_big');
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } fail('too_big'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > cap) fail('too_big');
  return text;
}

/**
 * Build the client. `fetch` has NO default (R11): src/index.js passes
 * globalThis.fetch, tests a fake. `now()` → ms, `sleep(ms)` → promise.
 * `names()` → the real people's names (throws → names_unavailable).
 */
export function createGeoClient({ fetch, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  cfg = config.geo, logger = rootLogger, names = () => realNamesOrThrow(), timezone = () => config.timezone } = {}) {
  if (typeof fetch !== 'function') throw new Error('geo: createGeoClient needs an explicit fetch');
  const log = typeof logger?.child === 'function' ? logger.child({ mod: 'geo' }) : logger;
  const c = { ...(cfg || {}) };
  const hosts = {
    nominatim: { base: c.nominatimUrl || '', needsContact: true },
    overpass: { base: c.overpassUrl || '', needsContact: true },
    osrm: { base: c.osrmUrl || '', needsContact: false },
    osrmFoot: { base: c.osrmFootUrl || '', needsContact: false },
  };
  const state = {};
  for (const h of Object.keys(hosts)) state[h] = { chain: Promise.resolve(), lastStart: -Infinity, ok: null, lastErrorCode: null };
  const cache = new Map();   // key → { value, expiresAt }
  let today = { day: null, count: 0 };

  const configured = (h) => !!hosts[h].base && (!hosts[h].needsContact || !!c.contactEmail);

  function gate(h) {
    if (!c.enabled) fail('off');
    if (!hosts[h].base) fail(h.startsWith('osrm') ? 'off' : 'unconfigured');
    if (hosts[h].needsContact && !c.contactEmail) fail('unconfigured');
  }

  function capOk() {
    const d = dayOf(now(), timezone());
    if (today.day !== d) today = { day: d, count: 0 };
    return today.count < (Number.isFinite(c.maxPerDay) ? c.maxPerDay : 400);
  }

  function cacheGet(key) {
    const v = cache.get(key);
    if (!v) return undefined;
    if (v.expiresAt <= now()) { cache.delete(key); return undefined; }
    cache.delete(key); cache.set(key, v);   // LRU touch
    return v.value;
  }
  function cachePut(key, value, ttl) {
    cache.set(key, { value, expiresAt: now() + ttl });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // One request through the host's serial queue (≥ 1 s between starts).
  function enqueue(h, fn) {
    const st = state[h];
    const run = st.chain.then(async () => {
      const wait = st.lastStart + MIN_GAP_MS - now();
      if (wait > 0) await sleep(wait);
      st.lastStart = now();
      return fn();
    });
    st.chain = run.catch(() => {});
    return run;
  }

  async function once(h, url, init) {
    if (!capOk()) fail('cap');
    today.count += 1;
    const ctrl = new AbortController();
    const timeoutMs = h === 'overpass' ? Math.max(c.timeoutMs || 8000, 20000) : (c.timeoutMs || 8000);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      let res;
      try {
        res = await fetch(url, {
          ...init, redirect: 'error', signal: ctrl.signal,
          headers: { 'User-Agent': c.userAgent || 'karyasthan-life-sim', Accept: 'application/json', 'Accept-Language': 'en', ...(init?.headers || {}) },
        });
      } catch (e) {
        fail(e?.name === 'AbortError' || ctrl.signal.aborted ? 'timeout' : 'network');
      }
      if (res.status === 429 || res.status === 503) return { retry: true, status: res.status, retryAfter: res.headers?.get?.('retry-after') };
      if (!res.ok) fail(`http_${Number(res.status) || 0}`);
      const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (!type.includes('json')) fail('bad_type');
      let text;
      try { text = await readCapped(res, CAP_BYTES[h.startsWith('osrm') ? 'osrm' : h]); } catch (e) {
        if (e instanceof GeoError) throw e;
        fail(ctrl.signal.aborted ? 'timeout' : 'network');
      }
      try { return { body: JSON.parse(text) }; } catch { fail('bad_json'); }
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  // The transport boundary: everything thrown becomes a bare GeoError(code).
  async function request(h, op, url, init) {
    const t0 = now();
    let code = 'ok';
    try {
      return await enqueue(h, async () => {
        let r = await once(h, url, init);
        if (r?.retry) {
          const ra = Number(r.retryAfter);
          await sleep(Number.isFinite(ra) && ra >= 0 && ra <= 10 ? ra * 1000 : 5000);
          state[h].lastStart = now();
          r = await once(h, url, init);
          if (r?.retry) fail(`http_${r.status}`);
        }
        return r.body;
      });
    } catch (e) {
      code = e instanceof GeoError ? e.code : 'network';
      throw e instanceof GeoError ? e : new GeoError('network');
    } finally {
      state[h].ok = code === 'ok';
      if (code !== 'ok') state[h].lastErrorCode = code;
      try { log.info({ evt: 'geo', host: h.startsWith('osrm') ? 'osrm' : h, op, ms: Math.max(0, now() - t0), code }, 'geo: request'); } catch { /* never fatal */ }
    }
  }

  function readNames() {
    try { return names(); } catch { fail('names_unavailable'); }
    return [];
  }

  // ── search (Nominatim) ──────────────────────────────────────────────────

  async function search(q, { box, limit = 8, areas = false } = {}) {
    const query = typeof q === 'string' ? q.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim() : '';
    if (!query || query.length > QUERY_MAX) fail('bad_input');
    if (!box || !['minLat', 'maxLat', 'minLon', 'maxLon'].every(k => Number.isFinite(box[k]))) fail('bad_input');
    const lim = Math.min(10, Math.max(1, Number.isInteger(limit) ? limit : 8));
    gate('nominatim');
    const knownNames = readNames();
    const params = {
      format: 'jsonv2', q: query,
      viewbox: [box.minLon, box.maxLat, box.maxLon, box.minLat].map(n => n.toFixed(6)).join(','),
      bounded: '1', limit: String(lim), addressdetails: '1', extratags: '1', namedetails: '0',
    };
    const key = crypto.createHash('sha256').update(`search${canonical(params)}`).digest('hex');
    let body = cacheGet(key);
    if (body === undefined) {
      const sp = new URLSearchParams(params);
      if (c.contactEmail) sp.set('email', c.contactEmail);
      body = await request('nominatim', 'search', `${hosts.nominatim.base}/search?${sp.toString()}`, { method: 'GET' });
      cachePut(key, body, TTL_SEARCH_MS);
    }
    const out = { candidates: [], areas: [], dropped: { unsafe_name: 0, out_of_region: 0, not_allowed: 0 } };
    for (const r of Array.isArray(body) ? body : []) {
      if (!r || typeof r !== 'object') continue;
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      if (isAreaResult(r.category, r.type)) {
        if (!areas) continue;
        const name = cleanArea(r.name, { knownNames });
        if (name && inRegion(lat, lon, box)) out.areas.push({ name, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
        continue;
      }
      const ex = r.extratags && typeof r.extratags === 'object' ? r.extratags : {};
      const kind = r.category === 'building' ? null : kindOfNominatim(r.category, r.type, ex);
      if (!kind || typeof r.name !== 'string' || !r.name.trim() || !['node', 'way', 'relation'].includes(r.osm_type)
        || !Number.isSafeInteger(Number(r.osm_id)) || !accessOk(ex)) {
        out.dropped.not_allowed += 1; continue;
      }
      if (!inRegion(lat, lon, box)) { out.dropped.out_of_region += 1; continue; }
      const name = cleanVenueName(r.name, { knownNames });
      if (!name) { out.dropped.unsafe_name += 1; continue; }
      const a = r.address && typeof r.address === 'object' ? r.address : {};
      out.candidates.push({
        name, kind, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        area: cleanArea(a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? null, { knownNames }),
        ref: `${r.osm_type}/${Number(r.osm_id)}`, kindTag: `${r.category}=${r.type}`.slice(0, 57), flags: nameFlags(name),
      });
    }
    return out;
  }

  // ── nearest (Overpass) ──────────────────────────────────────────────────

  async function nearest(kind, at, radiusM) {
    if (!isMappedKind(kind) || !KIND_TAGS[kind]) fail('bad_input');
    let ql;
    try { ql = overpassQuery(kind, at?.lat, at?.lon, radiusM); } catch { fail('bad_input'); }
    gate('overpass');
    const knownNames = readNames();
    const key = crypto.createHash('sha256').update(`nearest${ql}`).digest('hex');
    let body = cacheGet(key);
    if (body === undefined) {
      body = await request('overpass', 'nearest', hosts.overpass.base, {
        method: 'POST', body: new URLSearchParams({ data: ql }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      cachePut(key, body, TTL_SEARCH_MS);
    }
    const out = { candidates: [], dropped: { unsafe_name: 0, out_of_region: 0, not_allowed: 0 } };
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const distKm = (lat, lon) => {
      const h = Math.sin(rad(lat - at.lat) / 2) ** 2 + Math.cos(rad(at.lat)) * Math.cos(rad(lat)) * Math.sin(rad(lon - at.lon) / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    for (const e of Array.isArray(body?.elements) ? body.elements : []) {
      if (!e || !['node', 'way', 'relation'].includes(e.type) || !Number.isSafeInteger(e.id)) { out.dropped.not_allowed += 1; continue; }
      const tags = e.tags && typeof e.tags === 'object' ? e.tags : {};
      const k = kindOfOsm(tags);
      if (!k || !KIND_TAGS[kind].some(([tk, tv]) => tags[tk] === tv)) { out.dropped.not_allowed += 1; continue; }
      const lat = Number(e.lat ?? e.center?.lat);
      const lon = Number(e.lon ?? e.center?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { out.dropped.not_allowed += 1; continue; }
      const d = distKm(lat, lon);
      if (d * 1000 > radiusM + 1) { out.dropped.out_of_region += 1; continue; }
      const name = cleanVenueName(tags.name, { knownNames });
      if (!name) { out.dropped.unsafe_name += 1; continue; }
      const tagPair = KIND_TAGS[kind].find(([tk, tv]) => tags[tk] === tv);
      out.candidates.push({
        name, kind, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        area: cleanArea(tags['addr:suburb'] ?? tags['addr:neighbourhood'] ?? null, { knownNames }),
        ref: `${e.type}/${e.id}`, kindTag: tagPair ? `${tagPair[0]}=${tagPair[1]}` : null, flags: nameFlags(name),
        distKm: Math.round(d * 1000) / 1000,
      });
    }
    out.candidates.sort((a, b) => (a.distKm - b.distKm) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  // ── route (OSRM) ────────────────────────────────────────────────────────

  async function route(a, b, profile = 'car', { aHome = false, bHome = false } = {}) {
    if (!['car', 'foot'].includes(profile)) fail('bad_input');
    for (const p of [a, b]) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) fail('bad_input');
    }
    const h = profile === 'foot' ? 'osrmFoot' : 'osrm';
    gate(h);
    // A home-kind endpoint is sent rounded to 3 dp (R14); the caller keeps the exact one.
    const send = (p, home) => (home ? { lat: Math.round(p.lat * 1e3) / 1e3, lon: Math.round(p.lon * 1e3) / 1e3 } : p);
    const sa = send(a, aHome);
    const sb = send(b, bHome);
    const coords = `${sa.lon.toFixed(6)},${sa.lat.toFixed(6)};${sb.lon.toFixed(6)},${sb.lat.toFixed(6)}`;
    const key = crypto.createHash('sha256').update(`route|${profile}|${coords}`).digest('hex');
    let body = cacheGet(key);
    if (body === undefined) {
      const qs = new URLSearchParams({ overview: 'simplified', geometries: 'geojson', alternatives: 'false', steps: 'false' });
      body = await request(h, 'route', `${hosts[h].base}/route/v1/${profile === 'foot' ? 'foot' : 'driving'}/${coords}?${qs.toString()}`, { method: 'GET' });
      cachePut(key, body, TTL_ROUTE_MS);
    }
    const r = Array.isArray(body?.routes) ? body.routes[0] : null;
    if (body?.code !== 'Ok' || !r || !Number.isFinite(r.distance) || !Number.isFinite(r.duration)) fail('bad_json');
    let pts = (Array.isArray(r.geometry?.coordinates) ? r.geometry.coordinates : [])
      .filter(q => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])).map(q => [q[1], q[0]]);
    pts = simplify(pts, ROUTE_PTS_MAX);
    if (aHome) pts = straightenNear(pts, a, 400);
    if (bHome) pts = straightenNear(pts, b, 400);
    if (pts.length > ROUTE_PTS_MAX) pts = [];
    return {
      km: Math.round(r.distance) / 1000,
      minutes: Math.max(0, Math.round(r.duration / 60)),
      pts: toE5(pts),
    };
  }

  function status() {
    capOk();
    const host = (h) => ({ ok: state[h].ok, configured: configured(h), lastErrorCode: state[h].lastErrorCode });
    return {
      enabled: !!c.enabled,
      today: { count: today.count, cap: Number.isFinite(c.maxPerDay) ? c.maxPerDay : 400 },
      hosts: { nominatim: host('nominatim'), overpass: host('overpass'), osrm: host('osrm'), osrmFoot: host('osrmFoot') },
    };
  }

  return { search, nearest, route, status };
}
