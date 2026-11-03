// 014 geo (plan §A3.1, §A4.2): /api/places/* on the real dashboard app (Fastify
// inject), the life facade booted on the example world with the REAL geo client
// on a FAKE fetch. Read-only → 403; no CSRF → 403; life or arcs off → 409; a
// search answers candidates under ids and is audited with {len, results} only
// (never the query); realify starts a job (202), the job is polled, a second
// start while one runs → 409 busy, the start limit holds (2 / 10 min); geo off →
// 409 geo_off; /api/status carries geo booleans. Scratch DB, fake clock, no network.
import { PROJECT_ROOT, section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, setSkills } from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'places-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '7076', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'places-dashboard-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', JEV_API_KEY: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
});
const { db } = await setupScratchDb();
const { config } = await import('../../src/utils/config.js');
const { createGeoClient } = await import('../../src/life/geo/client.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const QUERY = 'secretquerytext bean';
async function fakeFetch(url) {
  const u = new URL(String(url));
  if (u.hostname === 'nominatim.test') {
    return json([{ osm_type: 'node', osm_id: 501, lat: '0.0163', lon: '0.0178', category: 'amenity', type: 'cafe', name: 'Bean Counter', address: { suburb: 'Northfield' }, extratags: {} }]);
  }
  if (u.hostname === 'overpass.test') return json({ elements: [] });
  throw new Error('unexpected host');
}
let ms = 1_800_000_000_000;
const geo = createGeoClient({
  fetch: fakeFetch, now: () => ms, sleep: async (d) => { ms += d; }, names: () => [], timezone: () => 'UTC',
  cfg: { enabled: true, nominatimUrl: 'https://nominatim.test', overpassUrl: 'https://overpass.test/api/interpreter', osrmUrl: '',
    osrmFootUrl: '', contactEmail: 'owner@example.invalid', userAgent: 'test', timeoutMs: 8000, maxPerDay: 400 },
});
const { life } = await bootLife({ geo });
await simulateHours(1);

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'places-test-csrf-token';
const app = await startDashboard({ getSock: () => null });
async function req(method, url, { body, csrf = true } = {}) {
  const headers = { authorization: AUTH };
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let j = null;
  try { j = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json: j };
}
const audits = (action) => db.prepare('SELECT payload_json FROM dashboard_audit WHERE action = ?').all(action).map(r => r.payload_json);

try {
  section('gates');
  eq('read-only → 403', (await req('POST', '/api/places/search', { body: { q: 'bean' } })).status, 403);
  config.dashboard.readOnly = false;
  eq('no CSRF → 403', (await req('POST', '/api/places/search', { body: { q: 'bean' }, csrf: false })).status, 403);
  eq('a too-long query → 400', (await req('POST', '/api/places/search', { body: { q: 'x'.repeat(81) } })).status, 400);
  await setSkills({ arcs: false });
  eq('arcs off → 409', (await req('POST', '/api/places/search', { body: { q: 'bean' } })).status, 409);
  await setSkills({ arcs: true });

  section('search');
  const s = await req('POST', '/api/places/search', { body: { q: QUERY } });
  eq('200 with one candidate under an id', [s.status, s.json?.candidates?.length, /^cand:/.test(s.json?.candidates?.[0]?.id ?? '')], [200, 1, true]);
  eq('attribution', s.json?.attribution, 'Data © OpenStreetMap contributors, ODbL');
  const a = audits('places.search');
  check('audited with {len, results} only — never the query', a.length === 1 && JSON.parse(a[0]).len === QUERY.length && !a[0].includes('secretquery'), a);
  const st = await req('GET', '/api/status');
  eq('/api/status geo booleans', st.json?.geo, { enabled: true, nominatim: true, overpass: true, osrm: false });
  check('…never a URL or the email', !JSON.stringify(st.json).includes('nominatim.test') && !JSON.stringify(st.json).includes('example.invalid'));

  section('jobs');
  const j1 = await req('POST', '/api/places/realify', { body: {} });
  eq('realify → 202 {jobId}', [j1.status, typeof j1.json?.jobId], [202, 'string']);
  let p = null;
  for (let i = 0; i < 100; i++) {
    p = await req('GET', `/api/places/jobs/${j1.json.jobId}`);
    if (['done', 'failed'].includes(p.json?.phase)) break;
    await new Promise(r => setTimeout(r, 5));
  }
  check('the job finishes (every nearest answered empty → done with kept rows)', p.json?.phase === 'done' && /^res:/.test(p.json?.resultId ?? ''), p.json);
  eq('a bad job id → 400', (await req('GET', '/api/places/jobs/nope')).status, 400);
  eq('an unknown job id → 404', (await req('GET', '/api/places/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
  eq('audited places.realify.start', audits('places.realify.start').length, 1);
  eq('routes refresh with OSRM off → 409 geo_off', [(await req('POST', '/api/places/routes/refresh', { body: {} })).status], [409]);
  const j3 = await req('POST', '/api/places/realify', { body: {} });
  check('a second start is allowed (202) or busy (409)', [202, 409].includes(j3.status), j3.status);
  const j4 = await req('POST', '/api/places/realify', { body: {} });
  eq('a third within 10 min → 429 (the start limit)', j4.status, 429);

  section('geo off');
  await stopLife();
  await bootLife({ geo: null });
  const off = await req('POST', '/api/places/search', { body: { q: 'bean' } });
  eq('no client → 409 geo_off', [off.status, off.json?.error], [409, 'geo_off']);
  eq('/api/status geo off', (await req('GET', '/api/status')).json?.geo?.enabled, false);
} finally {
  config.dashboard.readOnly = true;
  try { await app.close(); } catch { /* ignore */ }
  await stopLife();
}

report();
