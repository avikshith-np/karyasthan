// T035 — the Life dashboard API (src/dashboard/routes/life.js, plan §C3) on the
// real dashboard app (startDashboard, Fastify inject): reads answer with the
// engine stopped (an "off" shape, never a 500) and running (a simulated day on
// the example world); /api/status carries the life field; every write is
// refused while DASHBOARD_READONLY=true (403) and without the CSRF token (403),
// an accepted write is audited, bad input is a 4xx, and the per-route limits
// hold on loopback (10/min writes, 2/min phone check). Scratch DB, fake clock,
// fake socket, mocked Jev; no network.
import { PROJECT_ROOT, setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report } from './_helpers.js';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'life-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true',
  DASHBOARD_HOST: '127.0.0.1',
  DASHBOARD_PORT: '7074',
  DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'life-dashboard-test-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128',
  DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false',
  IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
  LIFE_MAP_TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
});

const { db } = await setupScratchDb();

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const { config } = await import('../../src/utils/config.js');
const { setClock, zonedToUnix } = await import('../../src/life/clock.js');
const { loadWorld, EXAMPLE_PATH } = await import('../../src/life/world.js');
const { setJev: setDecisionJev } = await import('../../src/life/decisions.js');
const { setJev: setClaimsJev } = await import('../../src/life/claims.js');
const { listEvents, appendEvent } = await import('../../src/life/eventLog.js');
const life = await import('../../src/life/index.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(27, 6));
setClock(clock.fn);
setDecisionJev(fakeJev(() => ({ pick: jevChoice('go', { go: 0.55, late: 0.15, stay: 0.3 }) })).fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('none', { none: 1 }) })).fn);

const GROUP = '120363000000000031@g.us';
const DM = '15550000031@s.whatsapp.net';
const sock = fakeSock();
db.prepare("INSERT INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Weekend <b>crew</b>', unixepoch(), unixepoch())").run(GROUP);

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'life-test-csrf-token';
const app = await startDashboard({ getSock: () => sock });
check('dashboard boots', !!app);

async function req(method, url, { body, csrf = true, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = AUTH;
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const auditCount = (action) => db.prepare('SELECT COUNT(*) AS n FROM dashboard_audit WHERE action = ?').get(action).n;
const advance = async (hours) => {
  for (let i = 0; i < hours * 4; i++) { clock.advance({ minutes: 15 }); await life.tick(); }
};

try {
  section('auth');
  eq('no credentials → 401', (await req('GET', '/api/life/now', { auth: false, csrf: false })).status, 401);

  section('reads with the engine stopped');
  const offNow = await req('GET', '/api/life/now');
  eq('/api/life/now → 200', offNow.status, 200);
  eq('… off shape', [offNow.json?.running, offNow.json?.enabled, offNow.json?.activity, offNow.json?.next], [false, false, null, []]);
  for (const url of ['/api/life/timeline', '/api/life/map', '/api/life/events', '/api/life/decisions', '/api/life/claims']) {
    eq(`${url} → 200 while stopped`, (await req('GET', url)).status, 200);
  }
  const offMap = await req('GET', '/api/life/map');
  check('map off: tile URL + OSM attribution still reported', offMap.json?.tileUrl?.startsWith('https://') && /OpenStreetMap/.test(offMap.json?.attribution || ''));
  const st0 = await req('GET', '/api/status');
  eq('/api/status life field (stopped)', [st0.json?.life?.enabled, st0.json?.life?.running, st0.json?.life?.availability], [false, false, null]);
  config.dashboard.readOnly = false;
  eq('write while stopped → 409 (not 500)', (await req('POST', '/api/life/decisions/1/mode', { body: { mode: 'ask' } })).status, 409);
  eq('claim dismiss while stopped → 409 like the other life writes', (await req('POST', '/api/life/claims/1/dismiss', { body: {} })).status, 409);
  config.dashboard.readOnly = true;

  section('a simulated day');
  await life.startLife({
    world, timers: false, isEnabled: () => true, seed: 42,
    getSock: () => sock,
    processMessage: async () => {},
    loadMessage: (item) => ({ id: item.msgId, groupJid: item.chatJid, senderJid: item.senderJid ?? item.chatJid, content: 'you there?' }),
    isGroupMuted: () => false, isMember: () => true, sleep: async () => {},
  });
  await advance(13); // → 19:00
  life.enqueueDeferred({ id: 'M-1', groupJid: GROUP, senderJid: DM }, { isGroup: true, isMention: true }, { remoteJid: GROUP, id: 'M-1', participant: DM });
  db.prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text, kind, p, status, created_at)
    VALUES (?, 'group', ?, 'I''ll bring the <script>snacks</script> tomorrow', 'commitment', 0.9, 'flagged', ?)`).run(GROUP, GROUP, clock.now());

  const now = await req('GET', '/api/life/now');
  eq('/api/life/now → 200 running', [now.status, now.json?.running, now.json?.enabled, now.json?.worldSource], [200, true, true, 'example']);
  check('now: vitals + availability + activity', typeof now.json?.vitals?.energy === 'number' && typeof now.json?.availability?.state === 'string' && typeof now.json?.activity?.kind === 'string');
  check('now: thought is a template line', typeof now.json?.thought === 'string' && now.json.thought.length > 0 && now.json.thought.length <= 240, now.json?.thought);
  const q = now.json?.queue?.byChat?.[0];
  eq('now: queue by chat with the group name', [q?.chatJid, q?.name, q?.count, q?.mentions], [GROUP, 'Weekend <b>crew</b>', 1, 1]);
  eq('now: claimsFlagged', now.json?.claimsFlagged, 1);
  check('now: next blocks end after now', Array.isArray(now.json?.next) && now.json.next.every((b) => b.end > now.json.at));
  const st = await req('GET', '/api/status');
  check('/api/status life field (running)', st.json?.life?.enabled === true && st.json.life.availability === now.json.availability.state && st.json.life.activity === now.json.activity.kind);

  const tl = await req('GET', `/api/life/timeline?from=${local(27, 0)}&to=${local(27, 20)}`);
  check('timeline: planned + actual spans', tl.status === 200 && tl.json.planned.length > 0 && tl.json.actual.length > 0, `${tl.json?.planned?.length}/${tl.json?.actual?.length}`);
  eq('timeline: > 48 h window → 400', (await req('GET', `/api/life/timeline?from=${local(20, 0)}&to=${local(27, 0)}`)).status, 400);
  eq('timeline: from after to → 400', (await req('GET', `/api/life/timeline?from=${local(27, 10)}&to=${local(27, 9)}`)).status, 400);

  const map = await req('GET', '/api/life/map');
  check('map: places with coordinates + position + trips', map.json?.running === true && map.json.places.length === world.places.length
    && map.json.places.every((p) => typeof p.lat === 'number') && map.json.position && Array.isArray(map.json.trips), JSON.stringify(map.json?.position));
  check('map: today\'s commute is a trip', map.json.trips.some((t) => t.from && t.to));

  const ev = await req('GET', '/api/life/events?limit=5');
  eq('events: limit honoured, newest id first', [ev.status, ev.json?.events?.length, ev.json.events[0].id > ev.json.events[4].id], [200, 5, true]);
  const page2 = await req('GET', `/api/life/events?limit=5&before=${ev.json.nextBefore}`);
  check('events: before cursor pages back with no overlap', page2.json.events.every((e) => e.id < ev.json.events[4].id));
  eq('events: limit > 200 clamps to 200', (await req('GET', '/api/life/events?limit=5000')).json?.events?.length <= 200, true);
  eq('events: unknown type → 400', (await req('GET', '/api/life/events?type=secrets')).status, 400);
  eq('events: bad before → 400', (await req('GET', '/api/life/events?before=1;DROP')).status, 400);
  const meals = await req('GET', '/api/life/events?type=meal&limit=50');
  check('events: type filter', meals.json.events.length > 0 && meals.json.events.every((e) => e.type === 'meal'));
  check('events: revertible flag', meals.json.events.every((e) => e.revertible === true));

  const meal = meals.json.events[0];
  const ex = await req('GET', `/api/life/events/${meal.id}/explain`);
  check('explain: chain ends at the event', ex.status === 200 && ex.json.chain.at(-1).id === meal.id);
  eq('explain: unknown id → 404', (await req('GET', '/api/life/events/999999/explain')).status, 404);
  eq('explain: bad id → 400', (await req('GET', '/api/life/events/abc/explain')).status, 400);
  eq('decisions → 200', (await req('GET', '/api/life/decisions')).status, 200);
  eq('claims ?status=flagged', (await req('GET', '/api/life/claims?status=flagged')).json?.claims?.length, 1);
  eq('claims: unknown status → 400', (await req('GET', '/api/life/claims?status=sneaky')).status, 400);

  section('writes: readonly, CSRF, audit');
  const claimId = db.prepare('SELECT id FROM life_claims LIMIT 1').get().id;
  config.dashboard.readOnly = true;
  eq('readonly → dismiss 403', (await req('POST', `/api/life/claims/${claimId}/dismiss`, { body: {} })).status, 403);
  eq('readonly → revert 403', (await req('POST', `/api/life/events/${meal.id}/revert`, { body: {} })).status, 403);
  eq('readonly → mode 403', (await req('POST', '/api/life/decisions/1/mode', { body: { mode: 'ask' } })).status, 403);
  eq('readonly → phone check 403', (await req('POST', '/api/life/phone/check', { body: {} })).status, 403);
  config.dashboard.readOnly = false;
  eq('no CSRF → dismiss 403', (await req('POST', `/api/life/claims/${claimId}/dismiss`, { body: {}, csrf: false })).status, 403);
  eq('no CSRF → revert 403', (await req('POST', `/api/life/events/${meal.id}/revert`, { body: {}, csrf: false })).status, 403);
  eq('nothing audited yet', [auditCount('life.claim.dismiss'), auditCount('life.revert')], [0, 0]);

  const dis = await req('POST', `/api/life/claims/${claimId}/dismiss`, { body: {} });
  eq('dismiss → 200 + audited', [dis.status, auditCount('life.claim.dismiss')], [200, 1]);
  eq('… claim is dismissed', db.prepare('SELECT status, reviewed_by FROM life_claims WHERE id = ?').get(claimId), { status: 'dismissed', reviewed_by: USER });
  eq('dismiss again → 409', (await req('POST', `/api/life/claims/${claimId}/dismiss`, { body: {} })).status, 409);
  eq('dismiss unknown → 404', (await req('POST', '/api/life/claims/4242/dismiss', { body: {} })).status, 404);

  const rv = await req('POST', `/api/life/events/${meal.id}/revert`, { body: { reason: 'did not\nhappen <b>x</b>' } });
  eq('revert → 200 + audited', [rv.status, auditCount('life.revert')], [200, 1]);
  const revEv = listEvents({ types: ['event.reverted'], limit: 10 }).at(-1);
  eq('… an owner event.reverted with the reason on one line', [revEv?.actor, revEv?.payload?.targetId ?? revEv?.causeId], ['owner', meal.id]);
  const a1 = db.prepare("SELECT actor, target, payload_json FROM dashboard_audit WHERE action = 'life.revert'").get();
  check('… audit row names the actor and the event', a1.actor === USER && a1.target === String(meal.id) && !/\n/.test(JSON.parse(a1.payload_json).reason));
  const revAgain = await req('GET', `/api/life/events/${meal.id}/explain`);
  check('… the event now reads as reverted', revAgain.json.chain.at(-1).reverted === true);
  const genesisId = listEvents({ types: ['genesis'], limit: 1 })[0].id;
  eq('revert genesis (not revertible) → 409', (await req('POST', `/api/life/events/${genesisId}/revert`, { body: {} })).status, 409);
  // A started owner weather window: REVERT is neither offered nor accepted (the facade's rule, not the type list).
  const winAt = clock.now();
  const win = appendEvent({ type: 'weather.window_set', at: winAt, actor: 'owner', payload: { from: winAt - 600, to: winAt + 3600, sky: 'rain' } });
  const winRow = (await req('GET', '/api/life/events?type=weather.window_set&limit=5')).json?.events?.find((e) => e.id === win.id);
  eq('a started weather window lists as not revertible', winRow?.revertible, false);
  eq('… and its revert → 409', (await req('POST', `/api/life/events/${win.id}/revert`, { body: {} })).status, 409);
  const a2 = db.prepare("SELECT payload_json FROM dashboard_audit WHERE action = 'life.claim.dismiss'").get();
  check('the dismiss audit carries codes only (no chat JID)', !/@/.test(a2?.payload_json ?? '@'));
  eq('revert unknown → 404', (await req('POST', '/api/life/events/999999/revert', { body: {} })).status, 404);
  eq('revert: reason over 200 chars → 400', (await req('POST', `/api/life/events/${meal.id}/revert`, { body: { reason: 'x'.repeat(201) } })).status, 400);

  eq('mode: bad mode → 400', (await req('POST', '/api/life/decisions/1/mode', { body: { mode: 'yolo' } })).status, 400);
  eq('mode: unknown decision → 404', (await req('POST', '/api/life/decisions/999999/mode', { body: { mode: 'ask' } })).status, 404);
  // Find (or wait for) an open decision: the example world proposes evenings.
  let open = null;
  for (let h = 0; h < 72 && !open; h++) {
    open = [...(life.getState().decisions?.values?.() || [])].find((d) => d.status === 'open') || null;
    if (!open) await advance(1);
  }
  if (open) {
    const md = await req('POST', `/api/life/decisions/${open.id}/mode`, { body: { mode: 'ask' } });
    eq('mode on an open decision → 200 + audited', [md.status, auditCount('life.decision.mode')], [200, 1]);
    check('… a decision.mode_set owner event', listEvents({ types: ['decision.mode_set'], limit: 5 }).some((e) => e.actor === 'owner' && e.payload?.mode === 'ask'));
  } else {
    check('an open decision appeared within 3 simulated days (for the mode write)', false);
  }

  section('phone check + rate limits');
  const ph = await req('POST', '/api/life/phone/check', { body: {} });
  check('phone check → 200 + audited', ph.status === 200 && auditCount('life.phone.check') === 1, JSON.stringify(ph.json));
  // The readonly 403 above counted against this route's 2/min, so the next one is refused.
  const ph2 = await req('POST', '/api/life/phone/check', { body: {} });
  eq('phone check over 2/min → 429', ph2.status, 429);
  eq('… not audited', auditCount('life.phone.check'), 1);
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    limited = (await req('POST', '/api/life/events/999999/revert', { body: {} })).status === 429;
  }
  check('revert over 10/min → 429 (loopback is not exempt)', limited);
  eq('the global page reads still answer', (await req('GET', '/api/life/now')).status, 200);
  eq('no network calls', fetches, 0);
} catch (err) {
  check('harness', false, err?.stack || String(err));
} finally {
  config.dashboard.readOnly = true;
  try { await life.stopLife(); } catch { /* not started */ }
  try { await app?.close(); } catch { /* not booted */ }
}
report();
