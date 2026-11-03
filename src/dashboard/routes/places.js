// 014 real places (spec 014 plan §A3.1, §A4.2): the Director PLACES panel's
// lookups. Every POST is a write (readOnlyGuard: 403 in read-only; CSRF in
// write mode), rate-limited (loopback not exempt) and audited with lengths,
// counts and ids only — never the query, a venue name or a coordinate. 409
// while life or the `arcs` skill is off (the Director needs both), `geo_off`
// / `geo_unconfigured` when lookups are off or have no contact email.
//
// Lookups never write: a search keeps its candidates server-side under ids,
// a job keeps its result under a resultId; both are applied only through a
// Director preview → apply (place.real / places.realify / routes.refresh).
// Imports only the life facade (R10) and the arcs route helpers.
import * as life from '../../life/index.js';
import { auditWrite } from '../audit.js';
import { actorOf, writeGate } from './arcs.js';

const limit = (max, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow, allowList: [] } });
const SEARCH = limit(10);
const JOB_START = limit(2, '10 minutes');
const JOB_POLL = limit(60);
const QUERY_MAX = 80;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// GeoError code → HTTP (codes only).
const GEO_STATUS = Object.freeze({
  off: [409, 'geo_off'], unconfigured: [409, 'geo_unconfigured'], busy: [409, 'busy'], bad_input: [400, 'bad_query'],
  names_unavailable: [409, 'names_unavailable'], cap: [429, 'geo_cap'],
});

function sendGeoError(reply, err) {
  if (err?.name === 'GeoError' || typeof err?.code === 'string') {
    const hit = GEO_STATUS[err.code];
    if (hit) return reply.code(hit[0]).send({ error: hit[1] });
    if (err.name === 'GeoError') return reply.code(502).send({ error: 'lookup_failed', code: /^[a-z_0-9]{1,24}$/.test(err.code) ? err.code : 'failed' });
  }
  if (/not running/.test(String(err?.message))) return reply.code(409).send({ error: 'life is not running' });
  return reply.code(502).send({ error: 'lookup_failed' });
}

export default async function placesRoutes(app) {
  app.get('/api/places/geo-status', async () => {
    try { return life.geoStatus(); } catch { return { enabled: false }; }
  });

  // Submitted on Enter / SEARCH only (Nominatim forbids autocomplete): no as-you-type.
  app.post('/api/places/search', { config: SEARCH }, async (req, reply) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const q = body.q;
    if (typeof q !== 'string' || !q.trim()) return reply.code(400).send({ error: 'bad_query' });
    if (q.length > QUERY_MAX) return reply.code(400).send({ error: 'too_long' });
    if (body.areas !== undefined && typeof body.areas !== 'boolean') return reply.code(400).send({ error: 'bad_areas' });
    const story = await writeGate(reply);
    if (!story) return reply;
    let res;
    try {
      res = await life.placeSearch(q, { areas: body.areas === true });
    } catch (err) {
      return sendGeoError(reply, err);
    }
    auditWrite(actorOf(req), 'places.search', null, { len: q.length, results: res.candidates.length });
    return res;
  });

  app.post('/api/places/realify', { config: JOB_START }, async (req, reply) => {
    const story = await writeGate(reply);
    if (!story) return reply;
    let res;
    try {
      res = life.realifyStart();
    } catch (err) {
      return sendGeoError(reply, err);
    }
    auditWrite(actorOf(req), 'places.realify.start', res.jobId, {});
    return reply.code(202).send(res);
  });

  app.post('/api/places/routes/refresh', { config: JOB_START }, async (req, reply) => {
    const story = await writeGate(reply);
    if (!story) return reply;
    let res;
    try {
      res = life.routesRefreshStart();
    } catch (err) {
      return sendGeoError(reply, err);
    }
    auditWrite(actorOf(req), 'places.routes.refresh', res.jobId, {});
    return reply.code(202).send(res);
  });

  app.get('/api/places/jobs/:id', { config: JOB_POLL }, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!JOB_ID_RE.test(id)) return reply.code(400).send({ error: 'bad job id' });
    const j = life.geoJob(id);
    if (!j) return reply.code(404).send({ error: 'not_found' });
    return j;
  });
}
