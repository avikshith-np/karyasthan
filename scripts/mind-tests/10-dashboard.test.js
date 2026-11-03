// Test 10 — the Mind dashboard API (spec 008 T021/T022, contracts/dashboard-api.md,
// quickstart §2 "10-dashboard").
//
// Boots the real dashboard (startDashboard: CIDR gate, auth, readonly, CSRF, rate
// limits) on the scratch DB, on a random loopback port, and drives it with
// app.inject (remote address 127.0.0.1 — which the GLOBAL limiter exempts, so a 429
// here proves the per-route `allowList: []`). The mind facade is a stub built on the
// real src/mind/store.js (routes/mind.js __setMindForTest), so this test runs before
// src/mind/index.js existed; a last section runs the reads and a set of writes (pause,
// exclusions, approve, runNow) through the REAL facade. Nothing touches the network or a model.
//
// Covers: every GET shape + query validation; the facade-absent fallback (reads 200
// empty, writes 409 not_initialised); every write → 403 readonly, 403 without CSRF,
// audited on success (no free text in the payload), body validation (unknown key,
// bad enum, bad id, JID pattern + existence, lengths); pause cancels queued; live
// without OWNER_JIDS → 409; approve/revert change the active version; reverting an
// invalid version → 409 not_revertible; exclusion add cancels queued; removing a
// detected exclusion → owner_cleared; bands validation; 429 on STRICT/LLM routes
// with no loopback exemption; PATCH /api/config: out-of-range mind.* rejected, the
// route drives onOwnerConfigChange (and a throwing hook neither 500s nor skips the
// audit), mind.* in /api/config/diff and persisted, 30/min limit.

import { setupScratchDb, seedPerson, seedGroup, blockNetwork, section, check, eq, report, PROJECT_ROOT, DAY, HOUR } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';

const USER = 'admin';
const PASS = 'mind-test-pass';
Object.assign(process.env, {
  DASHBOARD_ENABLED: 'true',
  DASHBOARD_HOST: '127.0.0.1',
  DASHBOARD_PORT: '0',
  DASHBOARD_USER: USER,
  DASHBOARD_PASS_HASH: await bcrypt.hash(PASS, 4),
  DASHBOARD_COOKIE_SECRET: 'mind-test-dashboard-cookie-secret-0123456789',
  DASHBOARD_ALLOW_CIDRS: '127.0.0.1/32,::1/128',
  DASHBOARD_READONLY: 'true',
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '',
  JEV_API_KEY: '', LLM_LOCAL_API_KEY: '', LLM_BASE_URL: '',
  IG_ADB_PATH: path.join(PROJECT_ROOT, 'data', 'no-such-adb'), IG_DEVICE_SERIAL: '', IG_ENABLED: 'false',
  CALLS_ENABLED: 'false',
});

const net = blockNetwork();
const { db } = await setupScratchDb();
const { config } = await import('../../src/utils/config.js');
const store = await import('../../src/mind/store.js');
const mindRoutes = await import('../../src/dashboard/routes/mind.js');
const { startDashboard } = await import('../../src/dashboard/server.js');

const now = () => Math.floor(Date.now() / 1000);

// ── seed: people, a group, mind rows (invented names, hostile strings) ───────
const XSS = '<img src=x onerror=alert(1)>';
const asha = await seedPerson({ jid: '155500001001@s.whatsapp.net', name: 'Avery' });
const biju = await seedPerson({ jid: '7001001@lid', name: 'Blake', pn: '155500001002@s.whatsapp.net' });
const grp = await seedGroup({ jid: '120363000000001001@g.us', name: 'Test circle', members: [asha, biju] });
const grp2 = await seedGroup({ jid: '120363000000001002@g.us', name: 'Other circle', members: [asha] });

const digestId = store.insertDigest({ chatJid: grp, originKind: 'group', fromRowid: 0, toRowid: 10, periodStart: now() - HOUR,
  periodEnd: now(), summary: `talked about ${XSS}`, tone: 'warm', threads: ['plans'] });
const epId = Number(db.prepare(`INSERT INTO memories (category, content, origin_kind, origin_jid, learned_at, attribute, source, importance)
  VALUES ('episode', ?, 'group', ?, ?, 'day:2026-10-27', 'mind.sleep', 0.4)`).run(`a quiet day ${XSS}`, grp, now() - DAY).lastInsertRowid);
db.prepare(`INSERT INTO item_evidence (item_type, item_id, msg_id, ts) VALUES ('memory', ?, 'M-ev-1', ?), ('memory', ?, 'M-ev-2', ?)`)
  .run(epId, now() - DAY, epId, now() - DAY);
db.prepare(`INSERT INTO memories (category, content, origin_kind, origin_jid, learned_at) VALUES ('fact', 'not an episode', 'group', ?, ?)`)
  .run(grp, now());

store.seedSelfModel();
const v1 = store.insertSelfModel({ text: 'Lately more patient.', source: 'mind', status: 'proposed', baseVersion: 0,
  diff: [{ op: '+', text: 'Lately more patient.' }], changesSummary: 'patience', rationale: `seemed calmer ${XSS}`, scrub: { names: 0 } });
const vInvalid = store.insertSelfModel({ text: 'leaked name', source: 'mind', status: 'invalid', scrub: { residual: 1 } });
const v3 = store.insertSelfModel({ text: 'Another idea.', source: 'mind', status: 'proposed', baseVersion: 0 });

const runId = store.insertRun({ kind: 'think', trigger: 'scheduled' });
store.finishRun(runId, { status: 'ok', model: 'stub-model', tokensIn: 100, tokensOut: 20, costUsd: 0.01,
  input: { labels: ['C1'], counts: { digests: 1 } }, output: { mood: 'calm' }, dropped: [] });

const nudgeId = store.insertNudge({ knob: 'reactTendency', scope: 'global', prevValue: 1, value: 1.2, requested: 1.2,
  band: { min: 0.7, max: 1.5 }, reason: 'more reactions', status: 'active', expiresAt: now() + DAY });

const draftBase = { chatKind: 'group', kind: 'share', basis: [], origins: [{ originJid: grp, originKind: 'group' }],
  intent: `share the link ${XSS}`, voicedText: 'look at this', mode: 'live', status: 'queued', sendAfter: now() + HOUR };
let draftQ = store.insertDraft({ ...draftBase, chatJid: grp });
const draftShadow = store.insertDraft({ ...draftBase, chatJid: grp2, mode: 'shadow', status: 'shadow' });

const detected = store.upsertDetected({ jid: biju, kind: 'person', msgId: 'M-dt-1', msgTs: now() - HOUR, p: 0.9 }).id;

// ── stub facade on the real store ────────────────────────────────────────────
class OwnerError extends Error {
  constructor(code, http = 409) { super(code); this.name = 'OwnerError'; this.code = code; this.http = http; }
}
const seen = { args: {}, hook: [], hookThrows: false, owner: [] };
const record = (name, args) => { seen.args[name] = args; };
const BANDS0 = {
  responseRate: { minFactor: 0.6, maxFactor: 1.25, floor: 0.02, ceil: 0.5, maxStep: 0.03 },
  groupResponseRate: { min: 0.6, max: 1.3, maxStep: 0.2 },
  reactTendency: { min: 0.7, max: 1.5, maxStep: 0.3 },
  replyLength: { allowed: ['shorter', 'normal'] },
  proactiveAppetite: { min: 0.5, max: 1.2, maxStep: 0.25 },
};
const cancelQueued = (forms, reason) => store.updateDraftsWhere({ ...(forms ? { chatForms: forms } : {}), statuses: ['queued'] },
  { status: 'cancelled', dropReason: reason });
const getVersion = (id) => {
  const v = store.getSelfModel(id);
  if (!v) throw new OwnerError('not_found', 404);
  return v;
};

const stub = {
  getStatus() {
    const s = store.getSettings();
    return {
      enabled: false, paused: s.paused, pausedAt: s.pausedAt, proactiveMode: s.proactiveMode, modeSince: s.proactiveModeSince,
      ownerJidsSet: config.ownerJids.length > 0, review: store.reviewState(), life: { on: false, availability: null },
      budget: { allowed: true, reason: null, spentUsd: 0, budgetUsd: 0 }, spend: { monthUsd: 0.01, byCaller: [{ caller: 'mind.think', calls: 1, costUsd: 0.01 }] },
      today: { glances: 0, thinks: 1, sleeps: 0, drafts: 2, sends: 0 }, caps: { ...config.mind },
      next: { glanceAt: null, thinkAt: null, sleepNight: null }, lastRun: { kind: 'think', status: 'ok', at: now(), skipReason: null },
      global: { spentUsd: 0.01, budgetUsd: 0, headroomPct: null }, reminders: [],
    };
  },
  getSelfState(q) { record('getSelfState', q); return { elements: [], ...(q?.asChatJid ? { preview: '' } : {}) }; },
  listRuns(q) { record('listRuns', q); return store.listRuns(q); },
  getRun(id) { return store.getRun(id); },
  getSelfModel() {
    const versions = store.listSelfModel({ limit: 200 });
    const a = store.activeSelfModel();
    return { active: a, pending: versions.filter((v) => v.status === 'proposed'), versions };
  },
  getSelfModelDiff(id) { return getVersion(id); },
  listNudges(q) { record('listNudges', q); return store.listNudges(q); },
  getBands() { return { bands: store.getSettings().bands || BANDS0, knobs: { reactTendency: { label: 'reactions', valueType: 'multiplier' } } }; },
  listProactive(q) { record('listProactive', q); return store.listDrafts(q); },
  listExclusions() { return { excludeAll: store.getSettings().excludeAll, rows: store.listExclusions() }; },
  onOwnerConfigChange(keys) {
    seen.hook.push(keys);
    if (seen.hookThrows) throw new Error('hook boom');
  },
  owner: {
    stanceSeed: async () => (seen.stanceSeed === 'budget' ? { ok: false, reason: 'budget' } : { ok: true, count: 3 }),
    stanceApprove: async (ids) => { seen.owner.push(['stanceApprove', ids]); return { ok: true, approved: 2 }; },
    stanceReject: (id) => (id === 404 ? { ok: false, reason: 'not_found' } : { ok: true }),
    stancePin: (id, pinned) => { seen.owner.push(['stancePin', id, pinned]); return { ok: true }; },
    stanceAnchor: (id, a) => (a > 1 ? { ok: false, reason: 'out_of_range' } : { ok: true, anchor: a }),
    stanceReset: () => ({ ok: true }),
    setPaused(paused, by) {
      seen.owner.push(['setPaused', by]);
      store.owner.setSetting('paused', paused, by);
      store.owner.setSetting('paused_at', paused ? now() : null, by);
      if (paused) cancelQueued(null, 'paused');
      return { ok: true, paused };
    },
    setProactiveMode(mode, by) {
      if (mode === 'live' && !config.ownerJids.length) throw new OwnerError('owner_jids_unset');
      store.owner.setSetting('proactive_mode', mode, by);
      store.owner.setSetting('proactive_mode_since', now(), by);
      if (mode !== 'live') cancelQueued(null, 'mode');
      return { ok: true, mode };
    },
    setReview(change, by) {
      seen.args.setReview = change;
      if (change.mode) store.owner.setSetting('review_mode', change.mode, by);
      if (change.extendDays) store.owner.setSetting('review_until', (store.getSettings().reviewUntil || now()) + change.extendDays * DAY, by);
      return { ok: true };
    },
    approve(id, by) {
      const v = getVersion(id);
      if (v.status !== 'proposed') throw new OwnerError('not_pending');
      store.setSelfModelStatus(id, 'active', { decidedBy: by, decidedAt: now() });
      return { ok: true, version: v.version };
    },
    reject(id, by, opts) {
      seen.args.reject = opts;
      const v = getVersion(id);
      if (v.status !== 'proposed') throw new OwnerError('not_pending');
      store.setSelfModelStatus(id, 'rejected', { decidedBy: by, decidedAt: now() });
      return { ok: true };
    },
    revertTo(id, by) {
      const v = getVersion(id);
      if (v.status === 'invalid' || !v.text) throw new OwnerError('not_revertible');
      const nid = store.insertSelfModel({ text: v.text, source: 'owner', status: 'active', baseVersion: v.version, decidedBy: by });
      return { ok: true, id: nid, version: store.getSelfModel(nid).version };
    },
    editSelfModel(text, by) {
      const nid = store.insertSelfModel({ text, source: 'owner', status: 'active', decidedBy: by });
      return { ok: true, id: nid, version: store.getSelfModel(nid).version };
    },
    revertNudge(id, by) {
      const n = store.getNudge(id);
      if (!n) throw new OwnerError('not_found', 404);
      if (!store.endNudge(id, 'reverted', by)) throw new OwnerError('not_pending');
      return { ok: true };
    },
    setBands(bands, by) { store.owner.setSetting('bands', bands, by); return { ok: true, overridden: 0 }; },
    dropDraft(id, by) {
      const d = store.getDraft(id);
      if (!d) throw new OwnerError('not_found', 404);
      if (!store.DRAFT_PENDING.includes(d.status)) throw new OwnerError('not_pending');
      store.updateDraft(id, { status: 'dropped', dropReason: 'owner' });
      seen.owner.push(['dropDraft', by]);
      return { ok: true };
    },
    addExclusion(row, by) {
      seen.args.addExclusion = row;
      const r = store.owner.addExclusion(row, by);
      cancelQueued([row.jid], 'excluded');
      return r;
    },
    removeExclusion(id, by) { return store.owner.removeExclusion(id, by); },
    setExcludeAll(on, by) {
      store.owner.setSetting('exclude_all', on, by);
      if (on) cancelQueued(null, 'exclude_all');
      return { ok: true, excludeAll: on };
    },
    async runNow(kind) { seen.args.runNow = kind; throw new OwnerError('skill_off'); },
  },
};

// ── harness ──────────────────────────────────────────────────────────────────
const app = await startDashboard({ getSock: () => ({ user: null }) });
check('dashboard boots on the scratch DB with the mind routes registered', !!app && app.hasRoute({ method: 'GET', url: '/api/mind/status' }));
if (!app) report();

const jar = {};
function absorb(res) {
  for (const line of [].concat(res.headers['set-cookie'] || [])) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function req(method, url, { body, csrf = true, auth = false } = {}) {
  const headers = { cookie: cookieHeader() };
  if (auth) headers.authorization = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (csrf && jar.csrf_token) headers['x-csrf-token'] = jar.csrf_token;
  const opts = { method, url, headers, remoteAddress: '127.0.0.1' };
  if (body !== undefined) opts.payload = body;
  const res = await app.inject(opts);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not json */ }
  return { status: res.statusCode, json, body: res.body };
}
const auditCount = (action) => db.prepare('SELECT COUNT(*) FROM dashboard_audit WHERE action = ?').pluck().get(action);
const lastAudit = (action) => db.prepare('SELECT * FROM dashboard_audit WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

const login = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1',
  headers: { authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') } });
absorb(login);
check('login issues session + csrf cookies', login.statusCode === 200 && !!jar.dash_session && !!jar.csrf_token);

const WRITES = [
  ['POST', '/api/mind/pause', { paused: true }],
  ['POST', '/api/mind/proactive/mode', { mode: 'shadow' }],
  ['POST', `/api/mind/proactive/${draftShadow}/drop`, {}],
  ['POST', '/api/mind/review', { extendDays: 7 }],
  ['POST', `/api/mind/self-model/${v1}/approve`, {}],
  ['POST', `/api/mind/self-model/${v3}/reject`, {}],
  ['POST', '/api/mind/self-model/1/revert', {}],
  ['PUT', '/api/mind/self-model', { text: 'x' }],
  ['POST', `/api/mind/nudges/${nudgeId}/revert`, {}],
  ['PUT', '/api/mind/bands', BANDS0],
  ['POST', '/api/mind/exclusions', { kind: 'group', jid: grp }],
  ['DELETE', `/api/mind/exclusions/${detected}`, undefined],
  ['POST', '/api/mind/exclusions/global', { excludeAll: false }],
  ['POST', '/api/mind/stances/approve', {}],
  ['POST', '/api/mind/stances/7/reject', {}],
  ['POST', '/api/mind/stances/7/pin', { pinned: true }],
  ['PUT', '/api/mind/stances/7/anchor', { anchor: 0.5 }],
  ['POST', '/api/mind/stances/7/reset', {}],
  ['POST', '/api/mind/run', { kind: 'think' }],
];

try {
  // ── facade absent ───────────────────────────────────────────────────────────
  section('facade absent → reads 200 empty, writes 409 not_initialised');
  {
    mindRoutes.__setMindForTest(false);
    const st = await req('GET', '/api/mind/status');
    check('status 200 with available:false', st.status === 200 && st.json?.available === false, st.json);
    const codes = (st.json?.reminders || []).map((r) => r.code);
    check('reminders: not_initialised + owner_jids_unset (codes + fixed texts)', codes.includes('not_initialised') && codes.includes('owner_jids_unset')
      && st.json.reminders.every((r) => typeof r.text === 'string'));
    check('status never carries owner JIDs, only ownerJidsSet', st.json?.ownerJidsSet === false && !('ownerJids' in st.json));
    const empties = {
      '/api/mind/self-state': (j) => Array.isArray(j?.elements) && !j.elements.length,
      '/api/mind/runs': (j) => Array.isArray(j) && !j.length,
      '/api/mind/self-model': (j) => j?.active === null && Array.isArray(j?.versions),
      '/api/mind/nudges': (j) => Array.isArray(j),
      '/api/mind/bands': (j) => j && 'bands' in j,
      '/api/mind/proactive': (j) => Array.isArray(j),
      '/api/mind/exclusions': (j) => j?.excludeAll === false && Array.isArray(j?.rows),
    };
    const bad = [];
    for (const [url, ok] of Object.entries(empties)) {
      const r = await req('GET', url);
      if (r.status !== 200 || !ok(r.json)) bad.push(`${url} ${r.status}`);
    }
    check('every facade read → 200 with its empty shape', !bad.length, bad.join(', '));
    const d = await req('GET', '/api/mind/digests');
    check('digests read straight from the DB even without the facade', d.status === 200 && d.json?.length === 1);
    config.dashboard.readOnly = false;
    const w = await req('POST', '/api/mind/exclusions/global', { body: { excludeAll: true } });
    check('a write → 409 not_initialised, nothing audited', w.status === 409 && w.json?.reason === 'not_initialised' && auditCount('mind.exclude_all') === 0, w.json);
    config.dashboard.readOnly = true;
    mindRoutes.__setMindForTest(stub);
  }

  // ── reads ───────────────────────────────────────────────────────────────────
  section('reads');
  {
    const st = await req('GET', '/api/mind/status');
    check('status: facade shape + available:true', st.status === 200 && st.json?.available === true && st.json?.proactiveMode === 'shadow'
      && typeof st.json?.review?.mode === 'string' && Array.isArray(st.json?.spend?.byCaller) && st.json?.caps?.thinkMaxPerDay === config.mind.thinkMaxPerDay);

    const ss = await req('GET', `/api/mind/self-state?as=${encodeURIComponent(grp)}`);
    check('self-state ?as=<group> → 200 and the facade gets {asChatJid}', ss.status === 200 && seen.args.getSelfState?.asChatJid === grp);
    eq('self-state ?as=<not a jid> → 400 field as', (await req('GET', '/api/mind/self-state?as=nope')).json, { error: 'bad_request', field: 'as' });

    const runs = await req('GET', '/api/mind/runs?limit=1000');
    check('runs → array, limit clamped to 100 before the facade', runs.status === 200 && runs.json?.[0]?.id === runId && seen.args.listRuns?.limit === 100);
    eq('runs ?kind=bogus → 400', (await req('GET', '/api/mind/runs?kind=bogus')).status, 400);
    eq('runs ?before=-1 → 400', (await req('GET', '/api/mind/runs?before=-1')).status, 400);
    const run = await req('GET', `/api/mind/runs/${runId}`);
    check('runs/:id → the full row (input/output/dropped)', run.status === 200 && run.json?.input?.labels?.[0] === 'C1' && run.json?.output?.mood === 'calm');
    eq('runs/abc → 400 field id', (await req('GET', '/api/mind/runs/abc')).json, { error: 'bad_request', field: 'id' });
    eq('runs/999999 → 404', (await req('GET', '/api/mind/runs/999999')).status, 404);

    const dg = await req('GET', `/api/mind/digests?chat=${encodeURIComponent(grp)}&limit=500`);
    const d0 = dg.json?.[0];
    check('digests: summary, tone, threads, origin, chat name (raw JSON; the page escapes)', dg.status === 200 && d0?.id === digestId
      && d0.summary.includes(XSS) && d0.tone === 'warm' && d0.threads?.[0] === 'plans' && d0.originKind === 'group' && d0.chatName === 'Test circle');
    eq('digests ?chat=<other group> → none', (await req('GET', `/api/mind/digests?chat=${encodeURIComponent(grp2)}`)).json, []);
    eq('digests ?chat=bad → 400', (await req('GET', '/api/mind/digests?chat=x@y')).status, 400);
    const ep = await req('GET', '/api/mind/episodes');
    check('episodes: only category episode, with attribute, origin, evidence count, current', ep.status === 200 && ep.json?.length === 1
      && ep.json[0].id === epId && ep.json[0].attribute === 'day:2026-10-27' && ep.json[0].evidenceCount === 2 && ep.json[0].current === true
      && ep.json[0].originLabel === 'Test circle');

    const sm = await req('GET', '/api/mind/self-model');
    check('self-model: active + pending + versions', sm.status === 200 && sm.json?.active?.version === 0 && sm.json?.pending?.length === 2 && sm.json?.versions?.length === 4);
    const smd = await req('GET', `/api/mind/self-model/${v1}`);
    check('self-model/:id → diff + scrub + rationale', smd.status === 200 && smd.json?.diff?.[0]?.op === '+' && smd.json?.scrub?.names === 0 && !!smd.json?.rationale);
    eq('self-model/999999 → 404 (OwnerError not_found)', (await req('GET', '/api/mind/self-model/999999')).json, { error: 'not_found' });

    const nd = await req('GET', '/api/mind/nudges?limit=9999');
    check('nudges → rows, limit clamped to 200', nd.status === 200 && nd.json?.[0]?.id === nudgeId && seen.args.listNudges?.limit === 200);
    eq('nudges ?status=bogus → 400', (await req('GET', '/api/mind/nudges?status=bogus')).status, 400);
    const bd = await req('GET', '/api/mind/bands');
    check('bands → bands + knob metadata', bd.status === 200 && !!bd.json?.bands?.responseRate && !!bd.json?.knobs);
    const pr = await req('GET', `/api/mind/proactive?status=queued&chat=${encodeURIComponent(grp)}&limit=500`);
    check('proactive → drafts, filters passed through, limit ≤ 100', pr.status === 200 && pr.json?.[0]?.id === draftQ
      && seen.args.listProactive?.status === 'queued' && seen.args.listProactive?.chatJid === grp && seen.args.listProactive?.limit === 100);
    eq('proactive ?status=bogus → 400', (await req('GET', '/api/mind/proactive?status=bogus')).status, 400);
    const ex = await req('GET', '/api/mind/exclusions');
    check('exclusions → {excludeAll, rows}', ex.status === 200 && ex.json?.excludeAll === false && ex.json?.rows?.[0]?.source === 'detected');
  }

  // ── readonly + CSRF ─────────────────────────────────────────────────────────
  section('every write: 403 readonly, 403 without CSRF, nothing audited');
  {
    const before = db.prepare(`SELECT COUNT(*) FROM dashboard_audit WHERE action LIKE 'mind.%'`).pluck().get();
    config.dashboard.readOnly = true;
    const ro = [];
    for (const [m, u, b] of WRITES) { const r = await req(m, u, { body: b }); if (r.status !== 403) ro.push(`${m} ${u} ${r.status}`); }
    check(`readonly → 403 on all ${WRITES.length} writes`, !ro.length, ro.join(', '));
    config.dashboard.readOnly = false;
    const nc = [];
    for (const [m, u, b] of WRITES.filter(([, u]) => u !== '/api/mind/run')) {
      const r = await req(m, u, { body: b, csrf: false });
      if (r.status !== 403) nc.push(`${m} ${u} ${r.status}`);
    }
    check('readonly off, no X-CSRF-Token → 403 on every write', !nc.length, nc.join(', '));
    const after = db.prepare(`SELECT COUNT(*) FROM dashboard_audit WHERE action LIKE 'mind.%'`).pluck().get();
    eq('no audit rows from refused writes', after, before);
  }

  // ── writes ──────────────────────────────────────────────────────────────────
  section('pause / resume');
  {
    eq('pause {paused:"yes"} → 400', (await req('POST', '/api/mind/pause', { body: { paused: 'yes' } })).json, { error: 'bad_request', field: 'paused' });
    eq('pause with an unknown key → 400 naming it', (await req('POST', '/api/mind/pause', { body: { paused: true, evil: 1 } })).json, { error: 'bad_request', field: 'evil' });
    const p = await req('POST', '/api/mind/pause', { body: { paused: true } });
    check('pause → 200, paused, queued draft cancelled', p.status === 200 && p.json?.ok === true && store.getSettings().paused === true
      && store.getDraft(draftQ).status === 'cancelled');
    const a = lastAudit('mind.pause');
    check('audited mind.pause by the dashboard user; store got by = "owner:<user>"', a?.actor === USER && seen.owner.at(-1)?.[1] === `owner:${USER}`);
    const r = await req('POST', '/api/mind/pause', { body: { paused: false } });
    check('resume → 200 + mind.resume audited', r.status === 200 && store.getSettings().paused === false && auditCount('mind.resume') === 1);
  }

  section('proactive mode');
  {
    eq('mode bogus → 400', (await req('POST', '/api/mind/proactive/mode', { body: { mode: 'loud' } })).json, { error: 'bad_request', field: 'mode' });
    eq('live without confirm → 400 field confirm', (await req('POST', '/api/mind/proactive/mode', { body: { mode: 'live' } })).json, { error: 'bad_request', field: 'confirm' });
    const nj = await req('POST', '/api/mind/proactive/mode', { body: { mode: 'live', confirm: true } });
    check('live without OWNER_JIDS → 409 owner_jids_unset, mode unchanged', nj.status === 409 && nj.json?.reason === 'owner_jids_unset'
      && store.getSettings().proactiveMode === 'shadow', nj.json);
    const savedOwners = config.ownerJids;
    config.ownerJids = ['155500009999'];
    const live = await req('POST', '/api/mind/proactive/mode', { body: { mode: 'live', confirm: true } });
    check('live with OWNER_JIDS + confirm → 200', live.status === 200 && store.getSettings().proactiveMode === 'live');
    config.ownerJids = savedOwners;
    const sh = await req('POST', '/api/mind/proactive/mode', { body: { mode: 'shadow' } });
    const a = lastAudit('mind.proactive.mode');
    check('shadow → 200, audited with the mode only', sh.status === 200 && a?.target === 'shadow' && a.payload_json === JSON.stringify({ mode: 'shadow' }));
  }

  section('review');
  {
    eq('review {} → 400', (await req('POST', '/api/mind/review', { body: {} })).status, 400);
    eq('review extendDays 31 → 400', (await req('POST', '/api/mind/review', { body: { extendDays: 31 } })).json, { error: 'bad_request', field: 'extendDays' });
    eq('review extendDays 1.5 → 400', (await req('POST', '/api/mind/review', { body: { extendDays: 1.5 } })).status, 400);
    const e = await req('POST', '/api/mind/review', { body: { extendDays: 7 } });
    check('extend 7 days → 200 + audited', e.status === 200 && seen.args.setReview?.extendDays === 7 && auditCount('mind.review') === 1);
    const m = await req('POST', '/api/mind/review', { body: { mode: 'review' } });
    check('always review → 200, review_mode = review', m.status === 200 && store.getSettings().reviewMode === 'review');
  }

  section('self-model');
  {
    const ap = await req('POST', `/api/mind/self-model/${v1}/approve`, { body: {} });
    check('approve a proposal → it becomes the active version', ap.status === 200 && store.activeSelfModel()?.id === v1);
    eq('approve it again → 409 not_pending', (await req('POST', `/api/mind/self-model/${v1}/approve`, { body: {} })).json, { error: 'conflict', reason: 'not_pending' });
    eq('approve /abc → 400 field id', (await req('POST', '/api/mind/self-model/abc/approve', { body: {} })).json, { error: 'bad_request', field: 'id' });
    eq('reject with a 201-char reason → 400', (await req('POST', `/api/mind/self-model/${v3}/reject`, { body: { reason: 'r'.repeat(201) } })).status, 400);
    const rj = await req('POST', `/api/mind/self-model/${v3}/reject`, { body: { reason: `nah ${XSS}` } });
    const ra = lastAudit('mind.selfmodel.reject');
    check('reject → 200, rejected; reason reaches the facade but not the audit', rj.status === 200 && store.getSelfModel(v3).status === 'rejected'
      && seen.args.reject?.reason?.startsWith('nah') && !String(ra?.payload_json).includes('nah'));
    const inv = await req('POST', `/api/mind/self-model/${vInvalid}/revert`, { body: {} });
    check('revert an invalid version → 409 not_revertible, active unchanged', inv.status === 409 && inv.json?.reason === 'not_revertible'
      && store.activeSelfModel()?.id === v1);
    // The version-0 seed is empty: give revert a version with text to restore.
    const old = store.insertSelfModel({ text: 'Older notes.', source: 'owner', status: 'superseded' });
    const rv = await req('POST', `/api/mind/self-model/${old}/revert`, { body: {} });
    const act = store.activeSelfModel();
    check('revert → a new active owner version copied from it', rv.status === 200 && act?.text === 'Older notes.' && act.source === 'owner' && act.id !== old);
    check('revert audited with ids/version only', lastAudit('mind.selfmodel.revert')?.payload_json === JSON.stringify({ fromId: old, version: act.version }));
    eq('PUT text > 1500 → 400 field text', (await req('PUT', '/api/mind/self-model', { body: { text: 'x'.repeat(1501) } })).json, { error: 'bad_request', field: 'text' });
    eq('PUT without text → 400', (await req('PUT', '/api/mind/self-model', { body: {} })).status, 400);
    const SECRET = 'Feeling steady these days, private-marker-77.';
    const ed = await req('PUT', '/api/mind/self-model', { body: { text: SECRET } });
    const ea = lastAudit('mind.selfmodel.edit');
    check('owner edit → new active version', ed.status === 200 && store.activeSelfModel()?.text === SECRET);
    check('edit audit carries length + version, never the text', ea?.payload_json === JSON.stringify({ length: SECRET.length, version: store.activeSelfModel().version })
      && !String(ea.payload_json).includes('private-marker'));
  }

  section('nudges + bands');
  {
    const r = await req('POST', `/api/mind/nudges/${nudgeId}/revert`, { body: {} });
    check('revert an active nudge → reverted by the owner', r.status === 200 && store.getNudge(nudgeId).status === 'reverted'
      && store.getNudge(nudgeId).endedBy === `owner:${USER}` && auditCount('mind.nudge.revert') === 1);
    eq('revert it again → 409 not_pending', (await req('POST', `/api/mind/nudges/${nudgeId}/revert`, { body: {} })).json, { error: 'conflict', reason: 'not_pending' });
    eq('revert a missing nudge → 404', (await req('POST', '/api/mind/nudges/999999/revert', { body: {} })).status, 404);
    const clone = () => JSON.parse(JSON.stringify(BANDS0));
    const tooHigh = clone(); tooHigh.responseRate.ceil = 0.7;
    eq('bands: responseRate.ceil 0.7 → 400', (await req('PUT', '/api/mind/bands', { body: tooHigh })).json, { error: 'bad_request', field: 'responseRate.ceil' });
    const lowMult = clone(); lowMult.reactTendency.min = 0.1;
    const unknown = { ...clone(), dryRun: { min: 0, max: 1 } };
    const missing = clone(); delete missing.replyLength;
    const inverted = clone(); inverted.groupResponseRate = { min: 1.2, max: 0.8, maxStep: 0.2 };
    const badLen = clone(); badLen.replyLength.allowed = ['shorter', 'huge'];
    const r2 = await Promise.all([lowMult, unknown, missing, inverted].map((b) => req('PUT', '/api/mind/bands', { body: b })));
    check('bands: multiplier < 0.25, an unknown knob, a missing knob, min > max → all 400', r2.every((x) => x.status === 400), r2.map((x) => x.json?.field));
    const r3 = await req('PUT', '/api/mind/bands', { body: badLen });
    eq('bands: replyLength value outside shorter|normal|longer → 400', r3.json?.field, 'replyLength.allowed');
    // Audit fix: maxStep 0 is refused by the route with its field (knobs refuses it too),
    // and the hardLimits GET shows are the route's own numbers.
    const zeroStep = clone(); zeroStep.responseRate.maxStep = 0;
    eq('bands: responseRate.maxStep 0 → 400 with the field', (await req('PUT', '/api/mind/bands', { body: zeroStep })).json,
      { error: 'bad_request', field: 'responseRate.maxStep' });
    const { HARD_LIMITS, validateBands: knobBands } = await import('../../src/mind/knobs.js');
    const hl = HARD_LIMITS.responseRate;
    eq('knobs.HARD_LIMITS (shown by GET bands) match the route (factors [0.01, 2], maxStep ≤ 0.1)',
      [hl.minFactor, hl.maxFactor, hl.maxStep, HARD_LIMITS.multiplier.min, HARD_LIMITS.multiplier.max, HARD_LIMITS.multiplier.maxStep],
      [0.01, 2, 0.1, 0.25, 2, 1]);
    const wide = clone(); wide.responseRate.maxFactor = 3;
    eq('…and the facade check refuses what the route refuses (maxFactor 3)', knobBands(wide).ok, false);
    // 6 band requests so far + 1 readonly + 1 no-csrf = 8 of 10
    const narrowed = clone(); narrowed.reactTendency = { min: 1, max: 1, maxStep: 0.1, disabled: true };
    const ok = await req('PUT', '/api/mind/bands', { body: narrowed });
    check('a valid (narrowed, disabled) band set → 200, stored, audited', ok.status === 200 && store.getSettings().bands?.reactTendency?.disabled === true
      && auditCount('mind.bands') === 1);
  }

  section('proactive drafts');
  {
    draftQ = store.insertDraft({ ...draftBase, chatJid: grp });
    const d = await req('POST', `/api/mind/proactive/${draftQ}/drop`, { body: {} });
    check('drop a queued draft → dropped:owner + audited', d.status === 200 && store.getDraft(draftQ).status === 'dropped'
      && store.getDraft(draftQ).dropReason === 'owner' && lastAudit('mind.proactive.drop')?.target === String(draftQ));
    eq('drop a shadow row → 409 not_pending', (await req('POST', `/api/mind/proactive/${draftShadow}/drop`, { body: {} })).json, { error: 'conflict', reason: 'not_pending' });
    eq('drop with a body key → 400', (await req('POST', `/api/mind/proactive/${draftQ}/drop`, { body: { why: 1 } })).status, 400);
  }

  section('exclusions');
  {
    draftQ = store.insertDraft({ ...draftBase, chatJid: grp });
    eq('kind bogus → 400', (await req('POST', '/api/mind/exclusions', { body: { kind: 'chat', jid: grp } })).json, { error: 'bad_request', field: 'kind' });
    eq('a person kind with a group jid → 400 field jid', (await req('POST', '/api/mind/exclusions', { body: { kind: 'person', jid: grp } })).json, { error: 'bad_request', field: 'jid' });
    eq('an unknown group → 404', (await req('POST', '/api/mind/exclusions', { body: { kind: 'group', jid: '120363999999999999@g.us' } })).status, 404);
    eq('note > 120 chars → 400', (await req('POST', '/api/mind/exclusions', { body: { kind: 'group', jid: grp, note: 'n'.repeat(121) } })).status, 400);
    const g = await req('POST', '/api/mind/exclusions', { body: { kind: 'group', jid: grp, note: `noisy ${XSS}` } });
    const ga = lastAudit('mind.exclusion.add');
    check('exclude a group → 200, owner row, queued draft cancelled', g.status === 200 && store.exclusionsFor([grp])[0]?.source === 'owner'
      && store.getDraft(draftQ).status === 'cancelled');
    check('exclusion audit: target jid, kind + hasNote, no note text', ga?.target === grp && ga.payload_json === JSON.stringify({ kind: 'group', hasNote: true }));
    const p = await req('POST', '/api/mind/exclusions', { body: { kind: 'person', jid: '155500001002@s.whatsapp.net' } });
    check('a person by their PN form is canonicalised before it is stored', p.status === 200 && seen.args.addExclusion?.jid === biju);
    // The PN add above turned the seeded detected row into an owner row; detect another person to test a dismissal.
    const dId = store.upsertDetected({ jid: asha, kind: 'person', msgId: 'M-dt-2', msgTs: now() - 60, p: 0.8 }).id;
    const dis = await req('DELETE', `/api/mind/exclusions/${dId}`);
    const row = store.getExclusion(dId);
    check('remove a detected exclusion → owner_cleared with cleared_at', dis.status === 200 && row?.source === 'owner_cleared' && row.clearedAt > 0);
    const ownerRow = store.exclusionsFor([grp])[0];
    const del = await req('DELETE', `/api/mind/exclusions/${ownerRow.id}`);
    check('remove an owner exclusion → deleted, audited with the action', del.status === 200 && !store.getExclusion(ownerRow.id)
      && lastAudit('mind.exclusion.remove')?.payload_json === JSON.stringify({ action: 'deleted' }));
    eq('remove a missing exclusion → 404', (await req('DELETE', '/api/mind/exclusions/999999')).status, 404);
    draftQ = store.insertDraft({ ...draftBase, chatJid: grp });
    const ga2 = await req('POST', '/api/mind/exclusions/global', { body: { excludeAll: true } });
    check('exclude everyone → 200, queued cancelled, audited', ga2.status === 200 && store.getSettings().excludeAll === true
      && store.getDraft(draftQ).status === 'cancelled' && lastAudit('mind.exclude_all')?.payload_json === JSON.stringify({ excludeAll: true }));
    eq('excludeAll "on" → 400', (await req('POST', '/api/mind/exclusions/global', { body: { excludeAll: 'on' } })).status, 400);
  }

  section('rate limits: no loopback exemption');
  {
    // POST /api/mind/run is LLM-limited (2/min): 1 readonly 403 already counted; this one is the 2nd.
    const r1 = await req('POST', '/api/mind/run', { body: { kind: 'think' } });
    check('run now → the facade refusal surfaces as 409 skill_off', r1.status === 409 && r1.json?.reason === 'skill_off' && seen.args.runNow === 'think', r1.json);
    const r2 = await req('POST', '/api/mind/run', { body: { kind: 'think' } });
    eq('the 3rd run request in a minute → 429 (from 127.0.0.1, which the global limiter allow-lists)', r2.status, 429);
    // STRICT (10/min) on exclusions/global: count what this route has had so far, then go over.
    let n = 0;
    let first429 = null;
    for (let i = 0; i < 12 && first429 === null; i++) {
      const r = await req('POST', '/api/mind/exclusions/global', { body: { excludeAll: false } });
      n++;
      if (r.status === 429) first429 = n;
    }
    // 1 (absent facade) + 1 readonly + 1 no-csrf + 2 above = 5 before the loop → the 6th loop call is #11
    eq('STRICT route: request #11 in a minute → 429', first429, 6);
  }

  section('PATCH /api/config: bounded mind.* keys + the owner-config hook');
  {
    const cap = config.mind.thinkMaxPerDay;
    const big = await req('PATCH', '/api/config', { body: { 'mind.thinkMaxPerDay': 1000 } });
    check('mind.thinkMaxPerDay = 1000 → rejected, unchanged', big.status === 200 && !!big.json?.rejected?.['mind.thinkMaxPerDay'] && config.mind.thinkMaxPerDay === cap);
    const pct = await req('PATCH', '/api/config', { body: { 'mind.sleepReservePct': 150 } });
    check('mind.sleepReservePct = 150 → rejected', !!pct.json?.rejected?.['mind.sleepReservePct'] && config.mind.sleepReservePct !== 150);
    check('a PATCH that applied nothing does not call the hook', seen.hook.length === 0);
    const before = auditCount('config.patch');
    const rr = await req('PATCH', '/api/config', { body: { responseRate: 0.2 } });
    check('responseRate PATCH → the route calls onOwnerConfigChange(Object.keys(applied)) after auditing', rr.status === 200
      && JSON.stringify(seen.hook.at(-1)) === JSON.stringify(['responseRate']) && auditCount('config.patch') === before + 1);
    seen.hookThrows = true;
    const th = await req('PATCH', '/api/config', { body: { responseRate: 0.18, 'mind.glanceMinutes': 60 } });
    check('a throwing hook → still 200 and still audited', th.status === 200 && auditCount('config.patch') === before + 2
      && JSON.stringify(seen.hook.at(-1)) === JSON.stringify(['responseRate', 'mind.glanceMinutes']));
    seen.hookThrows = false;
    const diff = await req('GET', '/api/config/diff');
    const row = (diff.json?.diffs || []).find((x) => x.key === 'mind.glanceMinutes');
    check('mind.* change shows in /api/config/diff with its MIND_* name', row?.envKey === 'MIND_GLANCE_MINUTES' && String(row.liveValue) === '60');

    // Persist into a scratch project root (never the worktree's .env).
    const scratchRoot = path.join(PROJECT_ROOT, 'data', `mind-test-env-${process.pid}`);
    fs.mkdirSync(scratchRoot, { recursive: true });
    const savedRoot = config.projectRoot;
    config.projectRoot = scratchRoot;
    try {
      const ps = await req('POST', '/api/config/persist', { body: { confirm: true, keys: ['mind.glanceMinutes'] } });
      const text = fs.existsSync(path.join(scratchRoot, '.env')) ? fs.readFileSync(path.join(scratchRoot, '.env'), 'utf-8') : '';
      check('…and persists as MIND_GLANCE_MINUTES=60', ps.status === 200 && /^MIND_GLANCE_MINUTES=60$/m.test(text), ps.json);
    } finally {
      config.projectRoot = savedRoot;
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }

    let first429 = null;
    for (let i = 1; i <= 32 && first429 === null; i++) {
      const r = await req('PATCH', '/api/config', { body: {} });
      if (r.status === 429) first429 = i;
    }
    // 4 PATCHes above → the 27th loop call is the 31st in this minute
    eq('PATCH /api/config: request #31 in a minute → 429 (no loopback exemption)', first429, 27);
  }

  section('audit hygiene + no network');
  {
    const rows = db.prepare(`SELECT action, payload_json FROM dashboard_audit WHERE action LIKE 'mind.%'`).all();
    check('mind.* audit payloads carry no free text (no hostile marker, no note/reason/text)', rows.length > 5
      && rows.every((r) => !String(r.payload_json || '').includes('<img') && !/private-marker|noisy|nah/.test(String(r.payload_json || ''))));
    eq('no network call was attempted', net, []);
  }

  // ── the page module (pages/mind.js, T022) ──────────────────────────────────
  section('page module: escaping, no unescaped markup, 30 s poll, no SSE');
  {
    const PAGE = path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages/mind.js');
    const src = fs.readFileSync(PAGE, 'utf-8');
    const { pathToFileURL } = await import('url');
    const page = await import(pathToFileURL(PAGE).href);
    const { renderToString } = await import(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/public/js/core/dom.js')).href);
    check('exports mount() and loads without a DOM', typeof page.mount === 'function');
    check('never calls raw( (test 11 greps the same)', !/\braw\(/.test(src));
    check('polls through ctx.setInterval every 30 s and opens no EventSource / ctx.on topic',
      /ctx\.setInterval\(/.test(src) && /POLL_MS = 30_000/.test(src) && !/EventSource/.test(src) && !/ctx\.on\(/.test(src));
    check('writes carry the CSRF cookie as X-CSRF-Token', /readCookie\('csrf_token'\)/.test(src) && /X-CSRF-Token/.test(src));
    check('live mode asks first and sends confirm:true', /ask\('Go live', 'Go LIVE\?/.test(src) && /mode: 'live', confirm: true/.test(src));
    check('the fun A/B toggle states the data flow', src.includes("group targets only; sends the group\\'s recent messages, recall and profile to the fun provider (Grok via OpenRouter)"));
    const diff = renderToString(page.diffView([{ op: '+', text: XSS }, { op: '-', text: 'old <b>line</b>' }, { op: ' ', text: 'same' }, `+${XSS}`]));
    check('diffView: <ins>/<del> per line, every line escaped', diff.includes('<ins') && diff.includes('<del') && !diff.includes('<img')
      && diff.includes('&lt;img') && diff.includes('&lt;b&gt;line'), diff);
    const tags = renderToString(page.originTags([{ originJid: grp, originKind: 'group' }, { originJid: biju, originKind: 'dm' }], () => XSS));
    check('originTags: origin chips via originCell, labels escaped; no origins → self', tags.includes('chip warn') && !tags.includes('<img')
      && renderToString(page.originTags([])).includes('self'));
  }

  // ── the real facade, once it exists (T020) ──────────────────────────────────
  section('real facade (src/mind/index.js)');
  {
    const exists = fs.existsSync(path.join(PROJECT_ROOT, 'src/mind/index.js'));
    if (!exists) {
      check('src/mind/index.js not present yet → stub-only run (T020 pending)', true);
    } else {
      mindRoutes.__setMindForTest(undefined);
      const mind = await mindRoutes.getMind();
      check('getMind() loads the real facade lazily', !!mind && typeof mind.getStatus === 'function' && typeof mind.owner === 'object');
      const st = await req('GET', '/api/mind/status');
      check('real status → 200, available, codes-only reminders', st.status === 200 && st.json?.available === true
        && (st.json.reminders || []).every((r) => /^[a-z_0-9]+$/.test(r.code)));
      const reads = ['/api/mind/self-state', '/api/mind/runs', '/api/mind/self-model', '/api/mind/nudges', '/api/mind/bands',
        '/api/mind/proactive', '/api/mind/exclusions'];
      const bad = [];
      for (const u of reads) { const r = await req('GET', u); if (r.status !== 200) bad.push(`${u} ${r.status}`); }
      check('every real read → 200', !bad.length, bad.join(', '));

      // Writes through the REAL owner namespace (T020): the same routes, audits and limits.
      config.dashboard.readOnly = false;
      draftQ = store.insertDraft({ ...draftBase, chatJid: grp });
      const p = await req('POST', '/api/mind/pause', { body: { paused: true } });
      check('real pause → 200, paused, the queued draft cancelled, audited', p.status === 200 && store.getSettings().paused === true
        && store.getDraft(draftQ).status === 'cancelled' && lastAudit('mind.pause')?.actor === USER, p.json);
      const rs = await req('POST', '/api/mind/pause', { body: { paused: false } });
      check('real resume → 200', rs.status === 200 && store.getSettings().paused === false);
      const rst = await req('GET', '/api/mind/status');
      check('real status reflects it (paused false, codes-only reminders, no owner JIDs)', rst.json?.paused === false
        && !('ownerJids' in rst.json) && typeof rst.json?.ownerJidsSet === 'boolean');
      draftQ = store.insertDraft({ ...draftBase, chatJid: grp2 });
      const ex = await req('POST', '/api/mind/exclusions', { body: { kind: 'group', jid: grp2 } });
      const exRow = store.exclusionsFor([grp2])[0];
      check('real exclusion add → owner row + that chat\'s queued draft cancelled', ex.status === 200 && exRow?.source === 'owner'
        && store.getDraft(draftQ).status === 'cancelled', ex.json);
      const rm = await req('DELETE', `/api/mind/exclusions/${exRow?.id}`);
      check('real exclusion remove → deleted', rm.status === 200 && !store.getExclusion(exRow?.id));
      eq('real remove of a missing exclusion → 404', (await req('DELETE', '/api/mind/exclusions/999998')).status, 404);
      const base = store.activeSelfModel()?.version ?? 0;
      const prop = store.insertSelfModel({ text: 'Lately a little quieter.', source: 'mind', status: 'proposed', baseVersion: base });
      const ap = await req('POST', `/api/mind/self-model/${prop}/approve`, { body: {} });
      check('real approve (proposal on the active base) → active', ap.status === 200 && store.activeSelfModel()?.id === prop, ap.json);
      eq('real approve again → 409 not_pending', (await req('POST', `/api/mind/self-model/${prop}/approve`, { body: {} })).json?.reason, 'not_pending');
      let runErr = null;
      try { await mind.owner.runNow('think', `owner:${USER}`); } catch (e) { runErr = e; }
      check('real runNow with the skill off → OwnerError skill_off 409 (the route maps it)', runErr?.code === 'skill_off' && runErr?.http === 409);
    }
  }
} catch (err) {
  check('harness error', false, err?.stack || String(err));
} finally {
  config.dashboard.readOnly = true;
  mindRoutes.__setMindForTest(undefined);
  try { await app?.close(); } catch { /* closed */ }
}

report();
