// Plan 020 §E1 + §F1: the dashboard's side, on the real app (startDashboard, Fastify inject): the
// reads answer with the engine stopped and running, dismiss / run keep the write gate (readonly 403,
// CSRF 403, audited with codes only, rate limited on loopback), bad input is a 4xx, /api/status
// carries the badge count. Scratch DB, fake clock, stubbed models, no network.
import { PROJECT_ROOT, setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report } from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'sweep-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '7075', DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4), DASHBOARD_COOKIE_SECRET: 'sweep-dashboard-test-cookie-secret-012345',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128', DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false', IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
});

const { db } = await setupScratchDb();
globalThis.fetch = async () => { throw new Error('network is off'); };

const { config } = await import('../../src/utils/config.js');
const { setClock, zonedToUnix } = await import('../../src/life/clock.js');
const { loadWorld, EXAMPLE_PATH } = await import('../../src/life/world.js');
const { setJev: setDecisionJev } = await import('../../src/life/decisions.js');
const { setJev: setClaimsJev } = await import('../../src/life/claims.js');
const { appendEvent } = await import('../../src/life/eventLog.js');
const life = await import('../../src/life/index.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const clock = fakeClock(zonedToUnix(2026, 10, 27, 6, 0, world.timezone));
setClock(clock.fn);
setDecisionJev(fakeJev(() => ({ pick: jevChoice('go', { go: 0.55, late: 0.15, stay: 0.3 }) })).fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('none', { none: 1 }) })).fn);

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'sweep-test-csrf-token';
const sock = fakeSock();
const app = await startDashboard({ getSock: () => sock });

async function req(method, url, { body, csrf = true, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = AUTH;
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const audits = (action) => db.prepare('SELECT target, payload_json FROM dashboard_audit WHERE action = ?').all(action);
const FP = 'a'.repeat(32);

try {
  section('auth and the engine stopped');
  eq('alerts unauthenticated → 401', (await req('GET', '/api/life/alerts', { auth: false, csrf: false })).status, 401);
  eq('thought vs deed unauthenticated → 401', (await req('GET', '/api/life/thought-deed', { auth: false, csrf: false })).status, 401);
  const off = await req('GET', '/api/life/alerts');
  eq('alerts → 200, off', [off.status, off.json?.running, off.json?.count], [200, false, 0]);
  const tdOff = await req('GET', '/api/life/thought-deed');
  eq('thought vs deed → 200, off', [tdOff.status, tdOff.json?.running, tdOff.json?.rows], [200, false, []]);
  eq('commitments unauthenticated → 401', (await req('GET', '/api/life/commitments', { auth: false, csrf: false })).status, 401);
  const coOff = await req('GET', '/api/life/commitments');
  eq('commitments → 200, off', [coOff.status, coOff.json?.running, coOff.json?.rows], [200, false, []]);
  const st0 = await req('GET', '/api/status');
  eq('/api/status: no alerts', st0.json?.life?.alerts, 0);
  config.dashboard.readOnly = false;
  eq('dismiss while stopped → 409', (await req('POST', `/api/life/alerts/${FP}/dismiss`, { body: {} })).status, 409);
  eq('run while stopped → 409', (await req('POST', '/api/life/alerts/run', { body: {} })).status, 409);
  config.dashboard.readOnly = true;

  section('running, with a finding');
  await life.startLife({ world, timers: false, isEnabled: () => true, seed: 42, getSock: () => sock, processMessage: async () => {}, loadMessage: () => null, isGroupMuted: () => false, isMember: () => true, sleep: async () => {} });
  for (let i = 0; i < 4; i++) { clock.advance({ minutes: 15 }); await life.tick(); }
  const t = clock.now();
  appendEvent({ type: 'money.salary', at: t, actor: 'engine', payload: { amount: 1, month: '2026-10' } });
  appendEvent({ type: 'money.salary', at: t, actor: 'engine', payload: { amount: 1, month: '2026-10' } });

  const coOn = await req('GET', '/api/life/commitments');
  eq('commitments while running → 200, a list', [coOn.status, coOn.json?.running, Array.isArray(coOn.json?.rows)], [200, true, true]);

  section('the write gate');
  eq('readonly: run → 403', (await req('POST', '/api/life/alerts/run', { body: {} })).status, 403);
  eq('readonly: dismiss → 403', (await req('POST', `/api/life/alerts/${FP}/dismiss`, { body: {} })).status, 403);
  eq('…nothing audited', audits('life.alert.run').length + audits('life.alert.dismiss').length, 0);
  config.dashboard.readOnly = false;
  eq('no CSRF token: run → 403', (await req('POST', '/api/life/alerts/run', { body: {}, csrf: false })).status, 403);
  eq('no CSRF token: dismiss → 403', (await req('POST', `/api/life/alerts/${FP}/dismiss`, { body: {}, csrf: false })).status, 403);

  section('run + read + badge');
  const run = await req('POST', '/api/life/alerts/run', { body: {} });
  eq('run → 200', run.status, 200);
  const f = run.json?.findings?.find(x => x.rule === 'salary_once');
  check('it found the second salary', !!f, JSON.stringify(run.json));
  const read = await req('GET', '/api/life/alerts');
  check('the read lists it', read.json?.findings?.some(x => x.fp === f.fp) && read.json?.running === true);
  eq('/api/status carries the count', (await req('GET', '/api/status')).json?.life?.alerts, read.json.count);
  eq('run audited, a count only', JSON.parse(audits('life.alert.run')[0].payload_json), { count: read.json.count });

  section('dismiss');
  for (const bad of ['nope', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}0`]) {
    eq(`bad id ${bad.slice(0, 8)}… → 400`, (await req('POST', `/api/life/alerts/${bad}/dismiss`, { body: {} })).status, 400);
  }
  eq('unknown → 404', (await req('POST', `/api/life/alerts/${FP}/dismiss`, { body: {} })).status, 404);
  const d = await req('POST', `/api/life/alerts/${f.fp}/dismiss`, { body: {} });
  eq('dismissed', [d.status, d.json?.ok], [200, true]);
  const a = audits('life.alert.dismiss');
  eq('audited: fingerprint + rule only', [a.length, a[0].target, JSON.parse(a[0].payload_json)], [1, f.fp, { rule: 'salary_once' }]);
  check('gone from the read', !(await req('GET', '/api/life/alerts')).json.findings.some(x => x.fp === f.fp));
  eq('again → 404', (await req('POST', `/api/life/alerts/${f.fp}/dismiss`, { body: {} })).status, 404);

  section('thought vs deed');
  const today = await req('GET', '/api/life/thought-deed');
  eq('today → 200, running', [today.status, today.json?.running, Array.isArray(today.json?.rows)], [200, true, true]);
  eq('a date', (await req('GET', '/api/life/thought-deed?date=2026-10-27')).json?.date, '2026-10-27');
  for (const bad of ['nope', '2026-1-1', '2026-13-01', '2026-02-31']) eq(`bad date ${bad} → 400`, (await req('GET', `/api/life/thought-deed?date=${bad}`)).status, 400);

  section('rate limits hold on loopback');
  let limited = false;
  for (let i = 0; i < 6 && !limited; i++) limited = (await req('POST', '/api/life/alerts/run', { body: {} })).status === 429;
  check('run over 4/min → 429', limited);
  limited = false;
  for (let i = 0; i < 14 && !limited; i++) limited = (await req('POST', `/api/life/alerts/${FP}/dismiss`, { body: {} })).status === 429;
  check('dismiss over 10/min → 429', limited);
} catch (err) {
  check('harness', false, err?.stack || String(err));
} finally {
  config.dashboard.readOnly = true;
  try { await life.stopLife(); } catch { /* not started */ }
  try { await app?.close(); } catch { /* not booted */ }
}
report();
