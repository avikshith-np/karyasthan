// T037 — POST /api/life/phone/check does not hang for the 1–4 min he stays on
// the phone: the route waits at most PHONE_WAIT_MS, answers 202 {started}
// (audited) while the check lingers, refuses a second check while one runs
// (409 in_check), and the check still ends (phone.check.ended). Real dashboard
// app (Fastify inject), scratch DB, fake clock, a hand-released "stay on the
// phone" sleep; no network.
import { PROJECT_ROOT, setupScratchDb, fakeClock, fakeSock, section, check, eq, report } from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'life-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true',
  DASHBOARD_HOST: '127.0.0.1',
  DASHBOARD_PORT: '7075',
  DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'life-dashboard-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128',
  DASHBOARD_READONLY: 'false',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false',
  IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
});

const { db } = await setupScratchDb();
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const { config } = await import('../../src/utils/config.js');
const { setClock, zonedToUnix } = await import('../../src/life/clock.js');
const { loadWorld, EXAMPLE_PATH } = await import('../../src/life/world.js');
const { listEvents } = await import('../../src/life/eventLog.js');
const { PHONE_WAIT_MS } = await import('../../src/dashboard/routes/life.js');
const life = await import('../../src/life/index.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const clock = fakeClock(zonedToUnix(2026, 10, 28, 11, 0, world.timezone));
setClock(clock.fn);
const sock = fakeSock();

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'life-test-csrf-token';
const app = await startDashboard({ getSock: () => sock });
async function req(method, url, { body } = {}) {
  const headers = { authorization: AUTH, 'x-csrf-token': CSRF, cookie: `csrf_token=${CSRF}` };
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const auditCount = (action) => db.prepare('SELECT COUNT(*) AS n FROM dashboard_audit WHERE action = ?').get(action).n;

// Short sleeps (spacing) pass; the long "stay on the phone" sleep waits for release().
let release = null;
const sleep = (ms) => (ms >= 60_000 ? new Promise((r) => { release = r; }) : Promise.resolve());

try {
  config.dashboard.readOnly = false;
  await life.startLife({
    world, timers: false, isEnabled: () => true, seed: 31, getSock: () => sock,
    processMessage: async () => {}, withChatLock: async (c, fn) => fn({}),
    isGroupMuted: () => false, isMember: () => true, sleep,
  });
  check('engine running', life.isLifeOn());

  section('the route answers before the check ends');
  const t0 = Date.now();
  const ph = await req('POST', '/api/life/phone/check', { body: {} });
  const took = Date.now() - t0;
  eq('202 started', [ph.status, ph.json?.started], [202, true]);
  check(`answered within PHONE_WAIT_MS + 1 s (${took} ms)`, took < PHONE_WAIT_MS + 1000);
  eq('… audited once', auditCount('life.phone.check'), 1);
  check('the check is still running (he is on his phone)', life.isPhoneInCheck() === true);

  const ph2 = await req('POST', '/api/life/phone/check', { body: {} });
  eq('a second check while one runs → 409 in_check', [ph2.status, ph2.json?.skipped], [409, 'in_check']);
  eq('… not audited', auditCount('life.phone.check'), 1);

  check('the linger sleep is waiting', typeof release === 'function');
  release?.();
  for (let i = 0; i < 50 && life.isPhoneInCheck(); i++) await new Promise((r) => setTimeout(r, 10));
  eq('the check ended after the linger', life.isPhoneInCheck(), false);
  check('… phone.check.ended by the owner', listEvents({ types: ['phone.check.ended'], limit: 5 }).some((e) => e.actor === 'owner'));
  eq('no network calls', fetches, 0);
} catch (err) {
  check('harness', false, err?.stack || String(err));
} finally {
  config.dashboard.readOnly = true;
  try { await life.stopLife(); } catch { /* not started */ }
  try { await app?.close(); } catch { /* not booted */ }
}
report();
