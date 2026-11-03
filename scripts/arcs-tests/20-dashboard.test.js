// T021/T022 — the story dashboard API (src/dashboard/routes/{arcs,director}.js,
// contracts/director-api.md) on the real dashboard app (startDashboard, Fastify
// inject) against a STUB story facade (routes/arcs.js __setStoryForTest), so it
// passes before and after src/life/story/index.js lands:
//   - every route; reads answer 200 with an off shape (life stopped, arcs off,
//     facade missing), writes 409 ('life is not running' / 'arcs is off');
//   - readonly → 403 on every write AND on both preview routes; previews need
//     CSRF in write mode; a missing CSRF token → 403;
//   - an audit row for every accepted write, with no scene/claim/journal/narration
//     text in the payload; previews and the scene draft are not audited;
//   - StoryError codes → 400/404/409/429, never an unknown message;
//   - JID-pattern, id and length validation; card pick / veto races;
//   - 429 with no loopback exemption at each limit (WRITE 10/min, PREVIEW 20/min,
//     TOMORROW 4/min, NARRATE 2/min, JOURNAL_REGEN 2/h, SEED_REGEN 1/h);
//   - the six route entries have `load`; the six pages use html`` only (no raw(),
//     no innerHTML =, no EventSource) and carry no persona/region/timezone literal.
// Scratch DB, no network, no model.
import { PROJECT_ROOT, setupScratchDb, section, check, eq, report, setSkills } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import bcrypt from 'bcryptjs';

const USER = 'owner-test';
const PASS = 'arcs-dash-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true',
  DASHBOARD_HOST: '127.0.0.1',
  DASHBOARD_PORT: '0',
  DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'arcs-dashboard-test-cookie-secret-0123456789',
  // The whole loopback /8, so groups of probes can use their own peer address
  // (per-route limits key on the socket address).
  DASHBOARD_ALLOW_CIDRS: '127.0.0.0/8,::1/128',
  DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9',
  IG_ENABLED: 'false', IG_DEVICE_SERIAL: '', CALLS_ENABLED: 'false',
  IG_ADB_PATH: `${PROJECT_ROOT}/data/no-such-adb`,
  LIFE_ENABLED: 'false', ARCS_ENABLED: 'false', MIND_ENABLED: 'false',
});

const { db } = await setupScratchDb();

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in arcs tests'); };

const { config } = await import('../../src/utils/config.js');
const arcsRoutes = await import('../../src/dashboard/routes/arcs.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

// ── a stub story facade ────────────────────────────────────────────────────

class StubError extends Error {
  constructor(code, reason = null, extra = {}) { super(`story: ${code} (${reason}) SECRET-MESSAGE`); this.code = code; this.reason = reason; Object.assign(this, extra); }
}
const SECRET = 'SECRET-TEXT-never-in-audit';
const GROUP = '120363000000000201@g.us';
const claimId = Number(db.prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, text, kind, p, status, created_at)
  VALUES (?, 'group', ?, ?, 'commitment', 0.9, 'flagged', unixepoch())`).run(GROUP, GROUP, `${SECRET} <script>x</script>`).lastInsertRowid);
db.prepare("INSERT INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Weekend <b>crew</b>', unixepoch(), unixepoch())").run(GROUP);

const calls = [];
let storyOn = true;
let committed = new Set();
let vetoed = new Set();
const previews = new Map();
let applyMode = 'ok';

const stub = {
  storyOn: () => storyOn,
  status: () => ({
    paused: false, fate: { romance: 'natural', heavy: 'guided' }, sliders: { drama: 0.5 }, pins: ['self.job'],
    reconcilerMode: 'review', seed: { source: 'example', missing: ['career'] },
    counts: { cards: 2, vetoCards: 1, tray: 1, proposals: 0, refusals24h: 3 },
    budgets: { mindMonthUsd: 0.1, mindCapUsd: 1, clerkToday: 2, clerkCap: 80, extractHour: 1, extractDay: 4, arcJevToday: 0 },
    degraded: false,
  }),
  cast: () => [{ id: 'cast:avery', name: 'Avery <img src=x>', initials: 'AV', relation: 'flatmate', label: 'flatmate', age: 29,
    status: 'busy with a course', away: null, metrics: { closeness: 0.6, trust: 0.5, tension: 0.1 }, pinned: false }],
  castDetail: (id, opts) => {
    calls.push(['castDetail', id, opts]);
    return id === 'cast:avery' ? { member: { id }, history: [{ text: 'met at a course' }], events: [{ id: 9, at: 1, type: 'cast.beat', actor: 'engine', origin: 'self', summary: 'beat' }] } : null;
  },
  web: () => ({ nodes: [{ id: 'self', label: 'self', initials: 'ME' }, { id: 'cast:avery', label: 'Avery', initials: 'AV' }], edges: [{ a: 'self', b: 'cast:avery', closeness: 0.6, kind: 'flatmate' }] }),
  arcsBoard: () => ({ categories: [{ category: 'romance', fate: 'natural', arcs: [], inert: 'no_seed_section' }] }),
  cards: (opts) => { calls.push(['cards', opts]); return [{ id: 41, type: 'decision', category: 'career', kind: 'offer', options: [] }]; },
  tray: (opts) => { calls.push(['tray', opts]); return [{ id: 7, claimId, status: 'tray', reason: 'conflict', expiresAt: 2 }]; },
  proposals: () => [{ id: 3, kind: 'beat', status: 'pending' }],
  journal: ({ nightKey }) => ({ night: nightKey ?? '2026-10-28', status: 'done', reason: null, parts: [{ originKind: 'self', originLabel: 'self', text: `${SECRET} journal`, status: 'active' }] }),
  journalNights: () => [{ night: '2026-10-28', status: 'done', parts: 1 }],
  refusals: () => [{ source: 'engine', action: 'beat', reason: 'pinned', target: 'cast:avery' }],
  bookmarks: () => [{ id: 5, name: 'before the move', eventId: 100, at: 1, inWindow: true }],
  cardPick: async (id, optionId, { by }) => {
    calls.push(['cardPick', id, optionId, by]);
    if (id === 404) throw new StubError('not_found', 'decision');
    if (optionId === 'stale') throw new StubError('conflict', 'expired_option');
    await new Promise((r) => setTimeout(r, 5));
    if (committed.has(id)) throw new StubError('conflict', 'already_committed');
    committed.add(id);
    return { eventId: 1000 + id };
  },
  heavyVeto: async (id) => {
    if (vetoed.has(id)) throw new StubError('conflict', 'not_pending');
    vetoed.add(id);
    return { eventId: 2000 + id };
  },
  trayReject: async (id) => { calls.push(['trayReject', id]); return { claimId }; },
  trayDismiss: async (id) => { calls.push(['trayDismiss', id]); if (id === 99) throw new Error(`boom ${SECRET}`); return { claimId }; },
  trayScene: async (id) => ({ shape: 'outing', placeId: 'place:cafe', castIds: ['cast:avery'], startAt: 5, minutes: 90, fromReviewId: id }),
  proposalReject: async (id) => { calls.push(['proposalReject', id]); },
  narrate: async (req) => {
    calls.push(['narrate', req]);
    if (req.eventId === 13) throw new StubError('refused', 'budget');
    return { text: `${SECRET} narration`, origins: ['self'], cached: false };
  },
  journalRegenerate: async (night) => ({ status: 'done', night }),
  seedRegenerate: async () => ({ status: 'skipped', reason: 'exists' }),
  director: {
    preview: async (action) => {
      calls.push(['preview', action]);
      if (action.label === 'Real Person') throw new StubError('invalid', 'real_person_name');
      if (action.label === 'Too early') throw new StubError('invalid', 'bad_startAt');
      if (action.shape === 'heavy') throw new StubError('refused', 'heavy_cap');
      if (action.label === 'Rush') throw new StubError('refused', 'too_soon', { earliestAt: 1793170200 });
      if (action.label === 'No way') throw new StubError('refused', 'no_route', { earliestAt: '1793170200' });
      const previewId = crypto.randomUUID();
      const fingerprint = crypto.createHash('sha256').update(previewId).digest('hex');
      previews.set(previewId, fingerprint);
      return { previewId, fingerprint, expiresAt: 600, before: {}, after: {}, diff: [{ path: 'vitals.energy', from: 60, to: 35 }],
        events: [{ ref: '$1', type: 'director.action', actor: 'owner', payload: {} }, { ref: '$2', type: 'vitals.nudged', actor: 'owner', causeRef: '$1', payload: { energy: -25 } }],
        warnings: ['visible in every chat'], refusals: [] };
    },
    apply: async (previewId, fingerprint, { by }) => {
      calls.push(['apply', previewId, by]);
      if (!previews.has(previewId)) throw new StubError('expired', 'expired_preview');
      if (previews.get(previewId) !== fingerprint || applyMode === 'stale') throw new StubError('stale', 'stale');
      previews.delete(previewId);
      return { ok: true, actionEventId: 500, eventIds: [500, 501] };
    },
    // 011: the Director prompt (drafts only; the route re-checks every action).
    prompt: async (wish, { by }) => {
      calls.push(['prompt', wish.length, by]);
      if (wish === 'cap reached') throw new StubError('refused', 'caller_cap');
      if (wish === 'cap today') throw new StubError('rate', 'rate');
      if (wish === 'budget stop') return { status: 'skipped', reason: 'budget', drafts: [], dropped: [], cantDo: [], model: null, fellBack: false, usage: { today: 2, cap: 20 } };
      if (wish === 'unparseable') return { status: 'invalid_output', drafts: [], dropped: [], cantDo: [], model: 'fake', fellBack: false, usage: { today: 2, cap: 20 } };
      // Audit 2026-10-30: an outing he can't make in time stays a card; a side draft whose main the route drops is held.
      if (wish === 'too soon replay') {
        const out = { kind: 'scene', shape: 'outing', placeId: 'place:cafe', when: { inMinutes: 15 }, minutes: 60 };
        return {
          status: 'ok', model: 'fake-mind', fellBack: false, usage: { today: 3, cap: 20 }, cantDo: [],
          drafts: [
            { index: 0, action: out, summary: 'SCENE · OUTING', why: null, texts: [], refusals: [], warnings: [], events: 0, batchable: false, reviewReason: 'too_soon', status: 'too_soon', earliestAt: 1793170200 },
            { index: 1, action: { kind: 'nuke_everything' }, summary: 'x', why: null, texts: [], refusals: [], warnings: [], events: 0, batchable: true },
            { index: 2, action: { kind: 'bookmark', name: 'shared table' }, summary: 'BOOKMARK', why: null, texts: [], refusals: [], warnings: [], events: 1, batchable: true, reviewReason: null, side: true, dependsOn: [0, 1, 'x'] },
            { index: 3, action: { ...out, placeId: 'place:park' }, summary: 'SCENE · OUTING', why: null, texts: [], refusals: [], warnings: [], events: 0, batchable: false, reviewReason: 'no_route', status: 'no_route', earliestAt: 5 },
          ],
          dropped: [{ index: 4, kind: 'bookmark', reason: 'unrequested', side: true }],
        };
      }
      return {
        status: 'ok', model: 'fake-mind', fellBack: true, usage: { today: 1, cap: 20 },
        drafts: [
          { index: 0, action: { kind: 'scene', shape: 'outing', placeId: 'place:cafe', when: { date: '2026-10-30', time: '19:30' }, minutes: 90, label: `${SECRET} <img src=x>` },
            summary: 'SCENE · OUTING', why: `${SECRET} why`, texts: [{ field: 'label', value: `${SECRET} <img src=x>` }], refusals: [], warnings: [], events: 2, batchable: true, reviewReason: null },
          { index: 1, action: { kind: 'nuke_everything' }, summary: 'x', why: null, texts: [], refusals: [], warnings: [], events: 0, batchable: true },
        ],
        dropped: [{ index: 2, kind: 'evil<script>', reason: 'not allowed!' }, { index: 3, kind: 'rewind', reason: 'not_allowed' }],
        cantDo: [`${SECRET} cannot`],
      };
    },
    previewTomorrow: async () => { calls.push(['tomorrow']); return { from: 1, to: 2, planned: [], birthdays: [], beats: [], decisions: [], heavy: null, notes: ['no model calls', 'nothing written'] }; },
  },
};

// ── harness ────────────────────────────────────────────────────────────────

const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CSRF = 'arcs-test-csrf-token';
const app = await startDashboard({ getSock: () => null });
check('dashboard boots with the story routes registered', !!app);

async function req(method, url, { body, csrf = true, auth = true, ip = '127.0.0.1' } = {}) {
  const headers = {};
  if (auth) headers.authorization = AUTH;
  if (csrf) { headers['x-csrf-token'] = CSRF; headers.cookie = `csrf_token=${CSRF}`; }
  const res = await app.inject({ method, url, headers, remoteAddress: ip, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, json };
}
const auditRows = (action) => db.prepare('SELECT * FROM dashboard_audit WHERE action = ? ORDER BY id').all(action);
const auditCount = (action) => auditRows(action).length;
const allAudit = () => db.prepare("SELECT action, target, payload_json FROM dashboard_audit WHERE action LIKE 'arcs.%' OR action LIKE 'director.%'").all();
const setRO = (v) => { config.dashboard.readOnly = v; };

const READS = ['/api/arcs/status', '/api/arcs/cast', '/api/arcs/cast/cast:avery', '/api/arcs/web', '/api/arcs/story',
  '/api/arcs/cards', '/api/arcs/cards?closed=1', '/api/arcs/claims', '/api/arcs/claims?status=adopted&limit=5',
  '/api/arcs/proposals', '/api/arcs/journal', '/api/arcs/journal?night=2026-10-28', '/api/arcs/journal/nights',
  '/api/arcs/refusals', '/api/director/bookmarks'];

// One body per write route (the WRITE-class ones; narrate/journal/seed have their own limits).
const WRITES = [
  ['/api/arcs/cards/41/pick', { optionId: 'go' }],
  ['/api/arcs/cards/heavy/77/veto', {}],
  ['/api/arcs/claims/7/reject', {}],
  ['/api/arcs/claims/7/dismiss', {}],
  ['/api/arcs/claims/7/scene', {}],
  ['/api/arcs/proposals/3/reject', {}],
  ['/api/director/apply', { previewId: crypto.randomUUID(), fingerprint: 'a'.repeat(64) }],
  ['/api/director/preview', { action: { kind: 'quick', button: 'tired' } }],
  ['/api/director/preview-tomorrow', {}],
  ['/api/arcs/narrate', { thought: true }],
  ['/api/arcs/journal/2026-10-28/regenerate', {}],
  ['/api/arcs/seed/regenerate', { confirm: true }],
  ['/api/director/prompt', { wish: 'a quiet evening' }],
];

try {
  section('auth');
  eq('no credentials → 401', (await req('GET', '/api/arcs/status', { auth: false, csrf: false })).status, 401);

  section('off: life stopped, real facade loader (whatever state src/life/story/index.js is in)');
  for (const url of READS) {
    const r = await req('GET', url);
    check(`${url} → 200 off shape`, r.status === 200 && r.json?.enabled === false, `${r.status} ${JSON.stringify(r.json)?.slice(0, 80)}`);
  }
  const off = await req('GET', '/api/arcs/status');
  eq('status off shape: counts all zero (the topbar chip can render)', off.json?.counts, { cards: 0, vetoCards: 0, tray: 0, proposals: 0, refusals24h: 0 });
  check('status off shape: running false, pins [], seed {source,missing}', off.json?.running === false && Array.isArray(off.json?.pins) && Array.isArray(off.json?.seed?.missing));
  setRO(false);
  for (const [url, body] of WRITES.slice(0, 6)) {
    const r = await req('POST', url, { body, ip: '127.0.0.20' });
    check(`${url} → 409 life is not running`, r.status === 409 && r.json?.error === 'life is not running', `${r.status} ${r.json?.error}`);
  }
  const pvOff = await req('POST', '/api/director/preview', { body: { action: { kind: 'quick', button: 'tired' } }, ip: '127.0.0.20' });
  check('preview while life stopped → 409', pvOff.status === 409 && pvOff.json?.error === 'life is not running');
  setRO(true);

  section('off: life running (stub), arcs skill off');
  arcsRoutes.__setStoryForTest(stub, { lifeRunning: () => true });
  await setSkills({ life: true, arcs: false });
  check('reads: enabled false while the arcs skill is off', (await req('GET', '/api/arcs/cast')).json?.enabled === false);
  setRO(false);
  const arcsOff = await req('POST', '/api/arcs/cards/41/pick', { body: { optionId: 'go' }, ip: '127.0.0.20' });
  check('write → 409 arcs is off', arcsOff.status === 409 && arcsOff.json?.error === 'arcs is off', `${arcsOff.status} ${arcsOff.json?.error}`);
  const promptOff = await req('POST', '/api/director/prompt', { body: { wish: 'a quiet evening' }, ip: '127.0.0.20' });
  check('011 prompt → 409 arcs is off (no facade call)', promptOff.status === 409 && promptOff.json?.error === 'arcs is off' && !calls.some(c => c[0] === 'prompt'));
  await setSkills({ life: true, arcs: true });
  storyOn = false;
  const notAttached = await req('POST', '/api/arcs/cards/41/pick', { body: { optionId: 'go' }, ip: '127.0.0.20' });
  check('skill on but the story not attached (storyOn false) → 409 arcs is off', notAttached.status === 409 && notAttached.json?.error === 'arcs is off');
  storyOn = true;
  check('no facade call was made while off', !calls.some((c) => c[0] === 'cardPick'));
  setRO(true);

  section('reads (on)');
  for (const url of READS) {
    const r = await req('GET', url);
    check(`${url} → 200 enabled`, r.status === 200 && r.json?.enabled === true, `${r.status}`);
  }
  const st = (await req('GET', '/api/arcs/status')).json;
  check('status carries the facade fields + counts', st.counts.cards === 2 && st.reconcilerMode === 'review' && st.pins[0] === 'self.job' && st.seed.source === 'example');
  const cast = (await req('GET', '/api/arcs/cast')).json;
  eq('cast → model/world strings returned as plain JSON (escaped by the page)', cast.cast[0].name, 'Avery <img src=x>');
  const cd = await req('GET', '/api/arcs/cast/cast:avery?before=50&limit=500');
  check('cast detail: limit clamped to 100, before passed', cd.status === 200 && calls.some((c) => c[0] === 'castDetail' && c[2].limit === 100 && c[2].before === 50));
  const enc = await req('GET', '/api/arcs/cast/cast%3Aavery');
  check('cast detail: a URL-encoded id (as the member page sends it) → 200', enc.status === 200 && calls.filter((c) => c[0] === 'castDetail').at(-1)[1] === 'cast:avery');
  eq('cast detail unknown member → 404', (await req('GET', '/api/arcs/cast/cast:nobody')).status, 404);
  eq('cast detail bad id → 400', (await req('GET', '/api/arcs/cast/123@s.whatsapp.net')).status, 400);
  eq('cast detail bad before → 400', (await req('GET', '/api/arcs/cast/cast:avery?before=1;DROP')).status, 400);
  check('cards: closed=1 → includeClosed', calls.some((c) => c[0] === 'cards' && c[1].includeClosed === true) && calls.some((c) => c[0] === 'cards' && c[1].includeClosed === false));
  const claims = (await req('GET', '/api/arcs/claims')).json;
  check('claims: tray joined with life_claims text + chat name', claims.claims[0].text.startsWith(SECRET) && claims.claims[0].chatName === 'Weekend <b>crew</b>' && claims.claims[0].claimKind === 'commitment');
  check('claims: default status tray, limit clamped to 100', calls.some((c) => c[0] === 'tray' && c[1].status === 'tray') && (await req('GET', '/api/arcs/claims?limit=999')).status === 200 && calls.filter((c) => c[0] === 'tray').at(-1)[1].limit === 100);
  eq('claims: unknown status → 400', (await req('GET', '/api/arcs/claims?status=everything')).status, 400);
  eq('proposals: unknown status → 400', (await req('GET', '/api/arcs/proposals?status=x')).status, 400);
  eq('journal: bad night → 400', (await req('GET', '/api/arcs/journal?night=2026-13-01')).status, 400);
  eq('journal: night param passed through', (await req('GET', '/api/arcs/journal?night=2026-10-27')).json?.night, '2026-10-27');
  eq('bookmarks from the facade', (await req('GET', '/api/director/bookmarks')).json?.bookmarks?.[0]?.id, 5);

  section('readonly → 403 on every write and both previews');
  setRO(true);
  for (const [url, body] of WRITES) {
    // NARRATE/JOURNAL/SEED are counted per peer: a separate address keeps the
    // accepted-write checks below inside their budgets.
    const r = await req('POST', url, { body, ip: '127.0.0.30' });
    eq(`readonly: ${url} → 403`, r.status, 403);
  }
  check('readonly: no facade write or preview ran', !calls.some((c) => ['preview', 'apply', 'tomorrow', 'trayReject', 'narrate'].includes(c[0])));

  section('write mode: CSRF required (previews too)');
  setRO(false);
  for (const [url, body] of WRITES) {
    const r = await req('POST', url, { body, csrf: false, ip: '127.0.0.31' });
    eq(`no CSRF: ${url} → 403`, r.status, 403);
  }
  const mism = await app.inject({ method: 'POST', url: '/api/director/preview', remoteAddress: '127.0.0.31',
    headers: { authorization: AUTH, 'x-csrf-token': 'a', cookie: 'csrf_token=b' }, payload: { action: { kind: 'quick', button: 'tired' } } });
  eq('mismatched CSRF on preview → 403', mism.statusCode, 403);
  check('no facade call without CSRF', !calls.some((c) => ['preview', 'tomorrow'].includes(c[0])));

  section('cards');
  const pick = await req('POST', '/api/arcs/cards/41/pick', { body: { optionId: 'go' } });
  check('pick → 200 + eventId', pick.status === 200 && pick.json?.eventId === 1041);
  const pr = auditRows('arcs.card.pick');
  check('pick audited (target id, optionId, eventId)', pr.length === 1 && pr[0].target === '41' && JSON.parse(pr[0].payload_json).optionId === 'go');
  check('the actor is the dashboard user', calls.some((c) => c[0] === 'cardPick' && c[3] === USER));
  const [a, b] = await Promise.all([
    req('POST', '/api/arcs/cards/42/pick', { body: { optionId: 'go' } }),
    req('POST', '/api/arcs/cards/42/pick', { body: { optionId: 'stay' } }),
  ]);
  const statuses = [a.status, b.status].sort();
  check('pick race: exactly one wins, the other 409 already_committed', statuses[0] === 200 && statuses[1] === 409 && [a, b].some((x) => x.json?.error === 'already_committed'));
  eq('pick race: one audit row for the winner', auditRows('arcs.card.pick').filter((r) => r.target === '42').length, 1);
  const exp = await req('POST', '/api/arcs/cards/43/pick', { body: { optionId: 'stale' } });
  check('expired option → 409 expired_option', exp.status === 409 && exp.json?.error === 'expired_option');
  check('error never echoes the facade message', !JSON.stringify(exp.json).includes('SECRET'));
  eq('unknown decision → 404', (await req('POST', '/api/arcs/cards/404/pick', { body: { optionId: 'go' } })).status, 404);
  eq('bad decision id → 400', (await req('POST', '/api/arcs/cards/abc/pick', { body: { optionId: 'go' } })).status, 400);
  eq('bad optionId → 400', (await req('POST', '/api/arcs/cards/44/pick', { body: { optionId: 'GO <b>' } })).status, 400);
  eq('missing optionId → 400', (await req('POST', '/api/arcs/cards/44/pick', { body: {} })).status, 400);
  const [v1, v2] = await Promise.all([req('POST', '/api/arcs/cards/heavy/77/veto', { body: {} }), req('POST', '/api/arcs/cards/heavy/77/veto', { body: {} })]);
  check('veto race: one 200, one 409', [v1.status, v2.status].sort().join() === '200,409');
  eq('veto audited once', auditCount('arcs.card.veto'), 1);
  eq('veto bad id → 400', (await req('POST', '/api/arcs/cards/heavy/x/veto', { body: {} })).status, 400);

  section('tray + proposals');
  eq('reject → 200', (await req('POST', '/api/arcs/claims/7/reject', { body: {} })).status, 200);
  eq('dismiss → 200', (await req('POST', '/api/arcs/claims/7/dismiss', { body: {} })).status, 200);
  check('reject/dismiss audited with ids only', auditCount('arcs.claim.reject') === 1 && auditCount('arcs.claim.dismiss') === 1
    && JSON.parse(auditRows('arcs.claim.reject')[0].payload_json).claimId === claimId);
  const boom = await req('POST', '/api/arcs/claims/99/dismiss', { body: {} });
  check('a non-story error → 409 failed, no message', boom.status === 409 && boom.json?.error === 'failed' && !JSON.stringify(boom.json).includes('SECRET'));
  eq('… and is not audited', auditCount('arcs.claim.dismiss'), 1);
  const auditBefore = allAudit().length;
  const scene = await req('POST', '/api/arcs/claims/7/scene', { body: {} });
  check('scene draft: a scene action with structured ids', scene.status === 200 && scene.json?.draft?.kind === 'scene' && scene.json.draft.fromReviewId === 7);
  eq('scene draft: not audited', allAudit().length, auditBefore);
  eq('bad review id → 400', (await req('POST', '/api/arcs/claims/0/reject', { body: {} })).status, 400);
  eq('proposal reject → 200 + audited', [(await req('POST', '/api/arcs/proposals/3/reject', { body: {} })).status, auditCount('arcs.proposal.reject')], [200, 1]);

  section('director');
  const pv = await req('POST', '/api/director/preview', { body: { action: { kind: 'quick', button: 'tired' } }, ip: '127.0.0.50' });
  check('preview → 200 with previewId + fingerprint + events + warnings', pv.status === 200 && pv.json?.previewId && pv.json?.fingerprint && pv.json.events.length === 2 && pv.json.warnings[0] === 'visible in every chat');
  eq('preview: not audited', auditRows('director.quick').length + auditRows('director.preview').length, 0);
  const ap = await req('POST', '/api/director/apply', { body: { previewId: pv.json.previewId, fingerprint: pv.json.fingerprint } });
  check('apply → 200 with the event ids', ap.status === 200 && ap.json?.actionEventId === 500 && ap.json.eventIds.length === 2);
  const aq = auditRows('director.quick');
  check('apply audited as director.<kind> with {fingerprint, eventIds, count}', aq.length === 1 && (() => { const p = JSON.parse(aq[0].payload_json); return p.fingerprint === pv.json.fingerprint && p.count === 2 && p.eventIds[1] === 501; })());
  const again = await req('POST', '/api/director/apply', { body: { previewId: pv.json.previewId, fingerprint: pv.json.fingerprint } });
  check('applying the same preview twice → 409 expired_preview', again.status === 409 && again.json?.error === 'expired_preview');
  const pv2 = await req('POST', '/api/director/preview', { body: { action: { kind: 'fate', category: 'heavy', mode: 'frozen' } }, ip: '127.0.0.50' });
  applyMode = 'stale';
  const stale = await req('POST', '/api/director/apply', { body: { previewId: pv2.json.previewId, fingerprint: pv2.json.fingerprint } });
  applyMode = 'ok';
  check('a material event in between → 409 stale', stale.status === 409 && stale.json?.error === 'stale');
  eq('… not audited', auditRows('director.fate').length, 0);
  eq('apply: bad previewId → 400', (await req('POST', '/api/director/apply', { body: { previewId: 'x', fingerprint: 'a'.repeat(64) } })).status, 400);
  eq('apply: bad fingerprint → 400', (await req('POST', '/api/director/apply', { body: { previewId: crypto.randomUUID(), fingerprint: 'a b' } })).status, 400);
  const bad = async (action) => (await req('POST', '/api/director/preview', { body: { action }, ip: '127.0.0.50' })).json?.error;
  eq('preview: missing action → 400', (await req('POST', '/api/director/preview', { body: {}, ip: '127.0.0.50' })).status, 400);
  eq('preview: unknown kind → 400 bad_kind', await bad({ kind: 'delete_everything' }), 'bad_kind');
  eq('preview: unknown quick button → 400 bad_button', await bad({ kind: 'quick', button: 'win_lottery' }), 'bad_button');
  eq('preview: unknown scene shape → 400 bad_shape', await bad({ kind: 'scene', shape: 'wedding' }), 'bad_shape');
  eq('preview: a JID in scene text → 400 jid_in_text', await bad({ kind: 'scene', shape: 'cast.beat', castId: 'cast:avery', beatKind: 'news', text: 'ask 15550001234@s.whatsapp.net' }), 'jid_in_text');
  eq('preview: an @-mention in text → 400 jid_in_text', await bad({ kind: 'cast.history', castId: 'cast:avery', text: 'with @155500000001' }), 'jid_in_text');
  eq('preview: oversize text → 400 too_long (never truncated)', await bad({ kind: 'scene', shape: 'outing', label: 'x'.repeat(401) }), 'too_long');
  eq('preview: a too-deep body → 400', await bad({ kind: 'seed.set', path: 'x', value: [[[[[[[1]]]]]]] }), 'too_deep');
  const rp = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene', shape: 'outing', label: 'Real Person' } }, ip: '127.0.0.50' });
  check('planner invalid → 400 with its reason code', rp.status === 400 && rp.json?.error === 'real_person_name');
  const be = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene', shape: 'outing', label: 'Too early' } }, ip: '127.0.0.50' });
  check('planner field reason (camelCase) is forwarded', be.status === 400 && be.json?.error === 'bad_startAt', JSON.stringify(be.json));
  const hc = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene', shape: 'heavy', heavyKind: 'minor_accident' } }, ip: '127.0.0.50' });
  check('planner refused → 409 with its reason code', hc.status === 409 && hc.json?.error === 'heavy_cap');
  // Audit 2026-10-30: a too_soon outing carries the earliest start he can make (the page's MOVE TO).
  const ts = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene', shape: 'outing', label: 'Rush' } }, ip: '127.0.0.50' });
  check('too_soon → 409 with earliestAt', ts.status === 409 && ts.json?.error === 'too_soon' && ts.json?.earliestAt === 1793170200, JSON.stringify(ts.json));
  const nroute = await req('POST', '/api/director/preview', { body: { action: { kind: 'scene', shape: 'outing', label: 'No way' } }, ip: '127.0.0.50' });
  check('…a non-integer earliestAt is never forwarded', nroute.status === 409 && nroute.json?.error === 'no_route' && !('earliestAt' in (nroute.json ?? {})), JSON.stringify(nroute.json));
  // 011 Phase 2: the new kinds pass the route's shape check like the others.
  eq('preview: weather with an unknown sky → 400 bad_weatherKind', await bad({ kind: 'weather', weatherKind: 'snow', from: 1, to: 2 }), 'bad_weatherKind');
  eq('preview: weather.end without a numeric id → 400 bad_windowId', await bad({ kind: 'weather.end', windowId: '3' }), 'bad_windowId');
  eq('preview: goal with an unknown kind → 400 bad_goalKind', await bad({ kind: 'goal', goalKind: 'party', fromDay: 0, toDay: 1 }), 'bad_goalKind');
  eq('preview: goal.cancel without a numeric id → 400 bad_goalId', await bad({ kind: 'goal.cancel', goalId: 'x' }), 'bad_goalId');
  eq('preview: a JID in a goal label → 400 jid_in_text', await bad({ kind: 'goal', goalKind: 'outing', fromDay: 0, toDay: 1, label: 'see 15550001234@s.whatsapp.net' }), 'jid_in_text');
  const tm = await req('POST', '/api/director/preview-tomorrow', { body: {} });
  check('preview tomorrow → 200, not audited', tm.status === 200 && tm.json?.notes?.includes('nothing written') && auditRows('director.tomorrow').length === 0);

  section('011: the Director prompt');
  const PIP = '127.0.0.60';
  eq('prompt: a non-string wish → 400', (await req('POST', '/api/director/prompt', { body: { wish: 5 }, ip: PIP })).json?.error, 'bad_wish');
  eq('prompt: oversize → 400 too_long', (await req('POST', '/api/director/prompt', { body: { wish: 'x'.repeat(401) }, ip: PIP })).json?.error, 'too_long');
  eq('prompt: a JID → 400 jid_in_text', (await req('POST', '/api/director/prompt', { body: { wish: 'ask 15551234567@s.whatsapp.net' }, ip: PIP })).json?.error, 'jid_in_text');
  check('…no facade call for those', !calls.some(c => c[0] === 'prompt'));
  const pa = await req('POST', '/api/director/prompt', { body: { wish: 'he has dinner out on friday' }, ip: PIP });
  check('prompt → 200 ok with drafts', pa.status === 200 && pa.json?.status === 'ok' && pa.json.drafts.length === 1, `${pa.status} ${JSON.stringify(pa.json)?.slice(0, 120)}`);
  eq('a draft failing the route shape check is dropped route_shape', pa.json?.dropped?.find(x => x.index === 1)?.reason, 'route_shape');
  eq('a model-chosen kind outside ACTION_KINDS → null; a non-code reason → bad_field', pa.json?.dropped?.find(x => x.index === 2), { index: 2, kind: null, reason: 'bad_field' });
  eq('…a real kind is kept', pa.json?.dropped?.find(x => x.index === 3)?.kind, 'rewind');
  eq('draft strings come back as JSON strings (the page escapes them)', pa.json?.drafts?.[0]?.texts?.[0]?.value, `${SECRET} <img src=x>`);
  check('fellBack and usage passed through', pa.json?.fellBack === true && pa.json?.usage?.today === 1 && pa.json?.usage?.cap === 20);
  check('the facade got the actor', calls.some(c => c[0] === 'prompt' && c[2] === USER));
  const prow = auditRows('director.prompt');
  check('prompt audited: status, length and counts only', prow.length === 1 && (() => { const p = JSON.parse(prow[0].payload_json);
    return p.status === 'ok' && p.length === 'he has dinner out on friday'.length && p.drafts === 1 && p.dropped === 3 && p.cantDo === 1 && p.fellBack === true; })());
  check('…never the wish, a why or a cantDo line', !prow[0].payload_json.includes('dinner') && !prow[0].payload_json.includes(SECRET));
  const pi = await req('POST', '/api/director/prompt', { body: { wish: 'unparseable' }, ip: PIP });
  check('a failed model answer → 409 with its status, audited', pi.status === 409 && pi.json?.error === 'invalid_output' && JSON.parse(auditRows('director.prompt').at(-1).payload_json).status === 'invalid_output');
  const pc = await req('POST', '/api/director/prompt', { body: { wish: 'cap reached' }, ip: PIP });
  check('a pre-call refusal → 409 caller_cap, not audited', pc.status === 409 && pc.json?.error === 'caller_cap' && auditRows('director.prompt').length === 2);
  const pb = await req('POST', '/api/director/prompt', { body: { wish: 'budget stop' }, ip: '127.0.0.63' });
  check('a skipped run (budget, no model call) → 409 skipped', pb.status === 409 && pb.json?.error === 'skipped', `${pb.status}`);
  eq('…and not audited (no model ran)', auditRows('director.prompt').length, 2);
  eq('the day cap → 429', (await req('POST', '/api/director/prompt', { body: { wish: 'cap today' }, ip: '127.0.0.61' })).status, 429);
  const sp = await req('POST', '/api/director/preview', { body: { action: { kind: 'quick', button: 'tired' }, source: 'prompt' }, ip: '127.0.0.62' });
  eq('preview with source:prompt → 200', sp.status, 200);
  eq('preview with an unknown source → 400', (await req('POST', '/api/director/preview', { body: { action: { kind: 'quick', button: 'tired' }, source: 'model' }, ip: '127.0.0.62' })).json?.error, 'bad_source');
  await req('POST', '/api/director/apply', { body: { previewId: sp.json.previewId, fingerprint: sp.json.fingerprint }, ip: '127.0.0.62' });
  check('the apply audit says source:prompt (R11)', JSON.parse(auditRows('director.quick').at(-1).payload_json).source === 'prompt');
  const hand = await req('POST', '/api/director/preview', { body: { action: { kind: 'quick', button: 'energised' } }, ip: '127.0.0.62' });
  await req('POST', '/api/director/apply', { body: { previewId: hand.json.previewId, fingerprint: hand.json.fingerprint }, ip: '127.0.0.62' });
  check('…a hand-built apply has no source', !('source' in JSON.parse(auditRows('director.quick').at(-1).payload_json)));
  // Audit 2026-10-30: too_soon / no_route drafts and the no-orphans rule through the route.
  const pt = await req('POST', '/api/director/prompt', { body: { wish: 'too soon replay' }, ip: '127.0.0.64' });
  const ptd = (i) => pt.json?.drafts?.find(d => d.index === i);
  eq('a too_soon draft keeps its status and earliestAt', [ptd(0)?.status, ptd(0)?.earliestAt, ptd(0)?.batchable], ['too_soon', 1793170200, false]);
  eq('a no_route draft keeps its status (no earliestAt)', [ptd(3)?.status, 'earliestAt' in (ptd(3) ?? {})], ['no_route', false]);
  eq('the main the route drops (route_shape) holds the side bookmark', [ptd(2)?.side, ptd(2)?.batchable, ptd(2)?.reviewReason, ptd(2)?.dependsOn],
    [true, false, 'depends_on_main', [0, 1]]);
  eq('…an unrequested bookmark is listed with its reason', pt.json?.dropped?.find(x => x.index === 4), { index: 4, kind: 'bookmark', reason: 'unrequested' });

  section('narration, journal, seed');
  const nr = await req('POST', '/api/arcs/narrate', { body: { thought: true }, ip: '127.0.0.40' });
  check('narrate thought → 200 text', nr.status === 200 && nr.json?.text?.startsWith(SECRET) && nr.json.cached === false);
  const nrow = auditRows('arcs.narrate');
  check('narrate audited with chars, never the text', nrow.length === 1 && JSON.parse(nrow[0].payload_json).chars === nr.json.text.length && !nrow[0].payload_json.includes('SECRET'));
  const nb = await req('POST', '/api/arcs/narrate', { body: { eventId: 13 }, ip: '127.0.0.41' });
  check('narrate over budget → 409 budget', nb.status === 409 && nb.json?.error === 'budget');
  eq('narrate: both eventId and thought → 400', (await req('POST', '/api/arcs/narrate', { body: { eventId: 5, thought: true }, ip: '127.0.0.42' })).status, 400);
  eq('narrate: neither → 400', (await req('POST', '/api/arcs/narrate', { body: {}, ip: '127.0.0.43' })).status, 400);
  eq('narrate: bad eventId → 400', (await req('POST', '/api/arcs/narrate', { body: { eventId: '1 OR 1' }, ip: '127.0.0.43' })).status, 400);
  const jr = await req('POST', '/api/arcs/journal/2026-10-28/regenerate', { body: {}, ip: '127.0.0.44' });
  check('journal regenerate → 200 + audited (night, status)', jr.status === 200 && auditRows('arcs.journal.regenerate')[0]?.target === '2026-10-28');
  eq('journal regenerate: bad night → 400', (await req('POST', '/api/arcs/journal/yesterday/regenerate', { body: {}, ip: '127.0.0.45' })).status, 400);
  eq('seed regenerate: confirm missing → 400', (await req('POST', '/api/arcs/seed/regenerate', { body: {}, ip: '127.0.0.46' })).status, 400);
  const sr = await req('POST', '/api/arcs/seed/regenerate', { body: { confirm: true }, ip: '127.0.0.47' });
  check('seed regenerate → 200 + audited', sr.status === 200 && auditCount('arcs.seed.regenerate') === 1);

  section('audit payloads carry no text');
  const rows = allAudit();
  check('every audited write has a row; none holds claim/scene/journal/narration text',
    rows.length >= 10 && rows.every((r) => !String(r.payload_json || '').includes('SECRET') && !String(r.payload_json || '').includes('<script>')), `${rows.length} rows`);

  section('rate limits (no loopback exemption)');
  // 127.0.0.1 is exempt from the GLOBAL limiter; the per-route limits must still bite.
  const burst = async (n, url, body, ip) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await req('POST', url, { body, ip })).status);
    return out;
  };
  const w = await burst(11, '/api/arcs/proposals/3/reject', {}, '127.0.0.1');
  check('WRITE: 10/min then 429 on loopback', w.slice(0, 9).every((s) => s === 200) && w[10] === 429, w.join(','));
  const p = await burst(21, '/api/director/preview', { action: { kind: 'quick', button: 'rain' } }, '127.0.0.1');
  check('PREVIEW: 20/min then 429', w.length && p.slice(0, 20).every((s) => s === 200) && p[20] === 429, p.join(','));
  const t = await burst(5, '/api/director/preview-tomorrow', {}, '127.0.0.1');
  check('TOMORROW: 4/min then 429', t[4] === 429 && t.slice(0, 3).every((s) => s === 200), t.join(','));
  const n = await burst(3, '/api/arcs/narrate', { thought: true }, '127.0.0.1');
  check('NARRATE: 2/min then 429', n[0] === 200 && n[1] === 200 && n[2] === 429, n.join(','));
  const j = await burst(3, '/api/arcs/journal/2026-10-27/regenerate', {}, '127.0.0.1');
  check('JOURNAL_REGEN: 2/hour then 429', j[0] === 200 && j[1] === 200 && j[2] === 429, j.join(','));
  const s2 = await burst(2, '/api/arcs/seed/regenerate', { confirm: true }, '127.0.0.1');
  check('SEED_REGEN: 1/hour then 429', s2[0] === 200 && s2[1] === 429, s2.join(','));
  const pr7 = await burst(7, '/api/director/prompt', { wish: 'a quiet evening' }, '127.0.0.1');
  check('PROMPT: 6/min then 429 (011)', pr7.slice(0, 6).every((s) => s === 200) && pr7[6] === 429, pr7.join(','));

  section('route entries + pages (static)');
  const { ROUTES } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/routes.js')).href);
  const want = { 'life/cast': 'life-cast', 'life/cast/member': 'life-cast-member', 'life/story': 'life-story', 'life/pending': 'life-pending',
    'life/journal': 'life-journal', 'life/director': 'life-director' };
  for (const [hash, mod] of Object.entries(want)) {
    const r = ROUTES.find((x) => x.hash === hash);
    check(`route ${hash}: section Life, load(), module pages/${mod}.js`, !!r && r.section === 'Life' && typeof r.load === 'function' && r.module === `pages/${mod}.js`);
  }
  const navd = ['life/pending', 'life/journal', 'life/director'];
  check('Cast and Story in the nav, the others tabs of Story, the member page lights up Cast', ['life/cast', 'life/story'].every((h) => ROUTES.find((x) => x.hash === h)?.nav === true)
    && navd.every((h) => ROUTES.find((x) => x.hash === h)?.tabs === 'story' && ROUTES.find((x) => x.hash === h)?.navKey === 'life/story')
    && !ROUTES.find((x) => x.hash === 'life/cast/member')?.nav && ROUTES.find((x) => x.hash === 'life/cast/member')?.navKey === 'life/cast');
  const match = (h) => ROUTES.find((r) => r.re.test(h))?.hash;
  eq('hash routing', ['#life/cast', '#life/cast/cast:avery', '#life/story', '#life/pending', '#life/journal', '#life/director', '#life', '#life/timeline'].map(match),
    ['life/cast', 'life/cast/member', 'life/story', 'life/pending', 'life/journal', 'life/director', 'life', 'life/timeline']);
  eq('member route captures the cast id', ROUTES.find((r) => r.hash === 'life/cast/member').re.exec('#life/cast/cast:avery')?.[1], 'cast:avery');
  const PAGES = Object.values(want).map((m) => path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages', `${m}.js`));
  const persona = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/persona.example.json'), 'utf-8'));
  const personaFile = path.join(PROJECT_ROOT, 'src/personality/persona.json');
  const real = fs.existsSync(personaFile) ? JSON.parse(fs.readFileSync(personaFile, 'utf-8')) : null;
  const literals = [persona, real].filter(Boolean).flatMap((p) => [p.name, p.displayName, ...(p.aliases || []), p.region, p.language])
    .filter((s) => typeof s === 'string' && s.length >= 3);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const css = fs.readFileSync(path.join(PROJECT_ROOT, 'src/dashboard/public/css/components.css'), 'utf-8');
  for (const f of PAGES) {
    const rel = path.relative(PROJECT_ROOT, f);
    const exists = fs.existsSync(f);
    check(`${rel} exists`, exists);
    if (!exists) continue;
    const src = fs.readFileSync(f, 'utf-8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    check(`${rel}: html\`\` templates, no raw(), no innerHTML =, no EventSource`, /html`/.test(code) && !/\braw\(/.test(code) && !/innerHTML\s*=/.test(code) && !/new EventSource/.test(code) && !/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(code));
    check(`${rel}: exports mount(ctx) and polls through ctx.setInterval`, /export (async )?function mount\(ctx/.test(code) && /ctx\.setInterval\(/.test(code));
    check(`${rel}: no fetch outside api() and no external URL`, !/\bfetch\(/.test(code) && !/https?:\/\//.test(code));
    const hits = literals.filter((l) => new RegExp(`\\b${esc(l)}\\b`, 'i').test(src));
    check(`${rel}: no persona/region/language literal`, !hits.length, hits.length ? '(literal found)' : '');
    check(`${rel}: no hardcoded timezone`, !/\b(Asia|Europe|America|Africa|Australia)\/[A-Z]/.test(src));
  }
  check('components.css has .story-* styles', /\.story-[a-z]/.test(css));
  const storyCss = css.split('\n').filter((l) => /\.story-/.test(l)).join('\n');
  check('.story-* css: no persona literal, no external URL', !literals.some((l) => new RegExp(`\\b${esc(l)}\\b`, 'i').test(storyCss)) && !/url\(\s*['"]?https?:/.test(css));

  section('page helpers escape model/world strings');
  const dom = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/core/dom.js')).href);
  const helpers = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages/life-cast.js')).href);
  const evil = '<img src=x onerror=alert(1)>';
  const webOut = dom.renderToString(helpers.webSvg({ nodes: [{ id: 'self', label: evil, initials: '<b>' }, { id: 'cast:x', label: evil, initials: 'X' }], edges: [{ a: 'self', b: 'cast:x', kind: '"><script>', closeness: 0.5 }] }));
  check('relationship web: labels, initials and kinds escaped', !webOut.includes('<img') && !webOut.includes('<script') && !webOut.includes('<b>') && webOut.includes('&lt;img'));
  check('avatar + sparkline + metric bars escape and stay numeric', !dom.renderToString(helpers.avatar(evil)).includes('<img')
    && /polyline/.test(dom.renderToString(helpers.sparkline([0.2, 0.9, 'x', 0.5]))) && /width:60%/.test(dom.renderToString(helpers.metricBars({ closeness: 0.6 }))));
  eq('countdown text', [helpers.countdownText(Date.now() / 1000 - 5), helpers.countdownText(Date.now() / 1000 + 30).endsWith('s')], ['PASSED', true]);
  // 011 Phase 2: the WEATHER / GOALS forms and the Day page's goals strip.
  const dir = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages/life-director.js')).href);
  const form = (vals) => ({ elements: { namedItem: (n) => (n in vals ? { value: vals[n] } : null) } });
  const wa = dir.weatherAction(form({ weatherKind: 'rain', intensity: '0.7', fromHours: '2', hours: '3' }));
  check('WEATHER form → a weather action 2 h ahead, 3 h long', wa.kind === 'weather' && wa.weatherKind === 'rain' && wa.intensity === 0.7
    && Math.abs(wa.from - (Date.now() / 1000 + 7200)) < 5 && wa.to - wa.from === 3 * 3600, wa);
  const ga = dir.goalAction(form({ goalKind: 'meet', castId: 'cast:avery', placeId: '', fromDay: '0', toDay: '6', minutes: '', label: ' a catch-up ' }));
  eq('GOALS form → a goal action (empty fields left out)', ga, { kind: 'goal', goalKind: 'meet', fromDay: 0, toDay: 6, castId: 'cast:avery', label: 'a catch-up' });
  // Audit 2026-10-30: a refused outing in plain words, and MOVE TO's moved action.
  const tooSoon = dir.refusalOf({ message: '409: too_soon', body: { error: 'too_soon', earliestAt: 1793170200 } });
  check('too_soon in plain words, with the earliest start', /can't get there in time — the earliest he could arrive is \d\d:\d\d$/.test(tooSoon.text) && tooSoon.fixAt === 1793170200, tooSoon.text);
  check('no_route in plain words, no fix', /no way to get there/.test(dir.refusalOf({ body: { error: 'no_route' } }).text) && dir.refusalOf({ body: { error: 'no_route' } }).fixAt === null);
  eq('another refusal keeps its message', dir.refusalOf({ message: '409: heavy_cap', body: { error: 'heavy_cap' } }).text, '409: heavy_cap');
  eq('MOVE TO: a scene\'s `when` becomes startAt', dir.movedTo({ kind: 'scene', shape: 'outing', placeId: 'place:x', when: { inMinutes: 15 } }, 1793170200),
    { kind: 'scene', shape: 'outing', placeId: 'place:x', startAt: 1793170200 });
  eq('…a bundle moves only the refused part', dir.movedTo({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, { kind: 'scene', shape: 'visit', startAt: 1 }] }, 5, 1),
    { kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, { kind: 'scene', shape: 'visit', startAt: 5 }] });
  eq('…nothing to move on other kinds', [dir.movedTo({ kind: 'quick', button: 'tired' }, 5), dir.movedTo({ kind: 'scene' }, null)], [null, null]);
  check('plain words: unrequested, depends_on_main, too_soon, no_route', /did not ask for/.test(dir.DROP_REASONS.unrequested)
    && dir.REVIEW_REASONS.depends_on_main === 'GOES WITH ANOTHER DRAFT' && dir.REVIEW_REASONS.too_soon && dir.REVIEW_REASONS.no_route);
  const sc = (index, extra = {}) => ({ draft: { index }, applied: false, removed: false, ...extra });
  eq('sideLock: waits for its main (card numbers)', dir.sideLock({ dependsOn: [1] }, [sc(2), sc(1)]), { waitFor: [2] });
  eq('…free once the main is applied', dir.sideLock({ dependsOn: [1] }, [sc(2), sc(1, { applied: true })]), null);
  eq('…a main removed on the page or dropped by the server → never', [dir.sideLock({ dependsOn: [1] }, [sc(1, { removed: true })]), dir.sideLock({ dependsOn: [0] }, [sc(1)])],
    [{ dropped: true }, { dropped: true }]);
  eq('…no dependsOn → free', dir.sideLock({}, []), null);
  const day = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages/life-day.js')).href);
  const strip = dom.renderToString(day.goalsStrip([{ id: 7, goalKind: 'meet', with: evil, place: evil, label: evil, from: 1793000000, to: 1793100000, status: 'open', lastTry: { reason: 'tired' } }]));
  check('goals strip: names and labels escaped, the deferral reason shown', !strip.includes('<img') && strip.includes('&lt;img') && strip.includes('deferred: tired'));
  eq('goals strip: nothing for no goals', day.goalsStrip([]), null);

  eq('no network', fetches, 0);
} catch (err) {
  check(`unexpected throw: ${err?.stack || err}`, false);
} finally {
  arcsRoutes.__setStoryForTest(null);
  setRO(true);
  try { await app?.close(); } catch { /* closed */ }
}
report();
