import crypto from 'crypto';
import { switchablePlaces, regionBox, inRegion } from '../places.js';
import { isMappedKind } from './kinds.js';
import { GeoError } from './client.js';

// 014 geo (plan §A2.3, §A4.2): one-at-a-time owner jobs over the geo client —
// "make places real" (nearest venue per switchable place + its routes) and
// "refresh routes". Results are kept under an opaque `resultId` (≥ the preview
// TTL) and handed to a Director preview, which freezes them; nothing is
// written by a job. Progress is codes and counts only.
//
// Also fetchRoutes(): the route fetcher both a job and place.real's preview use.

export const RESULT_TTL_SEC = 30 * 60;
export const JOBS_MAX = 20;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The job runner (one per facade). `now()` in unix seconds. */
export function createGeoJobs({ now = () => Math.floor(Date.now() / 1000), logger = null } = {}) {
  const jobs = new Map();      // jobId → { kind, done, total, phase, resultId, error, startedAt }
  const results = new Map();   // resultId → { value, expiresAt }
  let running = null;

  function sweep() {
    const t = now();
    for (const [id, r] of results) if (r.expiresAt <= t) results.delete(id);
    while (jobs.size > JOBS_MAX) {
      const oldest = [...jobs.keys()].find(id => jobs.get(id) !== running);
      if (!oldest) break;
      jobs.delete(oldest);
    }
  }

  return {
    busy: () => !!running,
    /** Start `fn(progress)` → {jobId}; throws GeoError('busy') while another job runs. */
    start(kind, fn) {
      if (running) throw new GeoError('busy');
      sweep();
      const jobId = crypto.randomUUID();
      const job = { kind, done: 0, total: 0, phase: 'start', resultId: null, error: null, startedAt: now() };
      jobs.set(jobId, job);
      running = job;
      const progress = (p) => { if (p && typeof p === 'object') Object.assign(job, pick(p)); };
      Promise.resolve().then(() => fn(progress)).then((value) => {
        const resultId = `res:${crypto.randomUUID()}`;
        results.set(resultId, { value: { ...value, kind }, expiresAt: now() + RESULT_TTL_SEC });
        Object.assign(job, { phase: 'done', resultId });
      }).catch((err) => {
        Object.assign(job, { phase: 'failed', error: err instanceof GeoError ? err.code : 'failed' });
        try { logger?.warn?.({ evt: 'issue', where: 'geo.job', kind, code: job.error }, 'geo: job failed'); } catch { /* ignore */ }
      }).finally(() => { if (running === job) running = null; sweep(); });
      return { jobId };
    },
    /** Progress of a job: {kind, done, total, phase, resultId?, error?} | null. */
    get(jobId) {
      if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return null;
      const j = jobs.get(jobId);
      return j ? { kind: j.kind, done: j.done, total: j.total, phase: j.phase, ...(j.resultId ? { resultId: j.resultId } : {}), ...(j.error ? { error: j.error } : {}) } : null;
    },
    /** A finished job's result (preview only), or null when unknown / expired. */
    result(resultId) {
      const r = results.get(resultId);
      if (!r) return null;
      if (r.expiresAt <= now()) { results.delete(resultId); return null; }
      return r.value;
    },
    clear() { jobs.clear(); results.clear(); running = null; },
  };
}

function pick(p) {
  const out = {};
  for (const k of ['done', 'total']) if (Number.isSafeInteger(p[k]) && p[k] >= 0) out[k] = p[k];
  if (typeof p.phase === 'string' && /^[a-z_]{1,24}$/.test(p.phase)) out.phase = p.phase;
  return out;
}

/**
 * Fetch road routes for place pairs [[a, b]] (a < b). `coordsOf(id)` → {lat, lon}
 * (overrides first: a place about to move), `isHome(id)` marks home-kind
 * endpoints (sent rounded, straightened near). Car always; foot when the
 * client has a foot host. Stops at `deadlineMs` (ms clock) or `max` requests.
 * → { routes:[route.recorded payloads], failed, state:'ok'|'later'|'off' }.
 */
export async function fetchRoutes(client, pairs, { coordsOf, isHome = () => false, deadlineMs = Infinity, max = 96, nowMs = () => Date.now(), onPair = null } = {}) {
  if (!client) return { routes: [], failed: 0, state: 'off' };
  const st = client.status();
  if (!st.enabled || !st.hosts?.osrm?.configured) return { routes: [], failed: 0, state: 'off' };
  const profiles = st.hosts?.osrmFoot?.configured ? ['car', 'foot'] : ['car'];
  const routes = [];
  let failed = 0;
  let sent = 0;
  let i = 0;
  for (const [a, b] of pairs) {
    i += 1;
    const pa = coordsOf(a);
    const pb = coordsOf(b);
    if (!pa || !pb) { failed += 1; continue; }
    for (const profile of profiles) {
      if (sent >= max || nowMs() >= deadlineMs) { failed += 1; continue; }
      sent += 1;
      try {
        const r = await client.route(pa, pb, profile, { aHome: isHome(a), bHome: isHome(b) });
        routes.push({ a, b, profile, km: r.km, minutes: r.minutes, aAt: { lat: pa.lat, lon: pa.lon }, bAt: { lat: pb.lat, lon: pb.lon }, pts: r.pts, src: 'osrm' });
      } catch (err) {
        if (err instanceof GeoError && (err.code === 'off' || err.code === 'unconfigured')) return { routes, failed: failed + 1, state: 'off' };
        failed += 1;
      }
    }
    try { onPair?.(i); } catch { /* progress only */ }
  }
  return { routes, failed, state: failed ? 'later' : 'ok' };
}

/**
 * "Make places real" (§A4.2): per switchable place, in id order, the nearest
 * venue of its kind within the radius that cleaned without a flag and isn't
 * taken; a flagged one is offered unticked; none → kept_generic {no_match};
 * a lookup error → kept_generic {lookup_failed} (the job fails only if every
 * lookup failed). Then the routes for the swapped places.
 */
export async function realifyJob({ client, state, world, radiusKm = 2, progress = () => {}, coordsOf, isHome, routePairs, nowMs = () => Date.now() }) {
  const { places, noMapping } = switchablePlaces(state, { mapped: isMappedKind, world });
  const box = regionBox(state);
  const taken = new Set([...(state?.places instanceof Map ? state.places.values() : [])].map(p => p?.venue?.ref).filter(Boolean));
  const swaps = [];
  const kept = noMapping.map(placeId => ({ placeId, reason: 'no_mapping' }));
  let unsafeName = 0;
  let lookups = 0;
  let lookupFails = 0;
  progress({ phase: 'venues', done: 0, total: places.length });
  for (const [i, p] of places.entries()) {
    lookups += 1;
    let res;
    try {
      res = await client.nearest(p.kind, { lat: p.lat, lon: p.lon }, Math.round(radiusKm * 1000));
    } catch (err) {
      lookupFails += 1;
      kept.push({ placeId: p.id, reason: 'lookup_failed' });
      progress({ done: i + 1 });
      continue;
    }
    unsafeName += res.dropped?.unsafe_name ?? 0;
    const free = res.candidates.filter(c => !taken.has(c.ref) && inRegion(c.lat, c.lon, box));
    const pickC = free.find(c => !c.flags?.length) ?? free[0] ?? null;
    if (!pickC) kept.push({ placeId: p.id, reason: 'no_match' });
    else {
      taken.add(pickC.ref);
      swaps.push({ placeId: p.id, venue: { ...pickC, kind: p.kind }, distKm: pickC.distKm ?? null });
    }
    progress({ done: i + 1 });
  }
  if (lookups && lookupFails === lookups) throw new GeoError('network');
  const moved = Object.fromEntries(swaps.map(s => [s.placeId, { lat: s.venue.lat, lon: s.venue.lon }]));
  const pairs = [];
  const seen = new Set();
  for (const s of swaps) {
    for (const pr of routePairs(s.placeId)) {
      const k = pr.join('|');
      if (!seen.has(k)) { seen.add(k); pairs.push(pr); }
    }
  }
  progress({ phase: 'routes', done: 0, total: pairs.length });
  const r = await fetchRoutes(client, pairs, {
    coordsOf: (id) => moved[id] ?? coordsOf(id), isHome, nowMs, onPair: (n) => progress({ done: n }),
  });
  return { swaps, kept, unsafeName, routes: r.routes, routesState: r.state, pairs: pairs.length, failed: r.failed };
}

/** "Refresh routes" (§A2.3): every pair whose current route doesn't match any more. */
export async function routesRefreshJob({ client, pairs, progress = () => {}, coordsOf, isHome, nowMs = () => Date.now() }) {
  progress({ phase: 'routes', done: 0, total: pairs.length });
  const r = await fetchRoutes(client, pairs, { coordsOf, isHome, nowMs, onPair: (n) => progress({ done: n }) });
  return { routes: r.routes, routesState: r.state, pairs: pairs.length, failed: r.failed };
}
