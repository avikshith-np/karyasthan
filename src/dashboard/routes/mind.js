// MIND page API (spec 008, contracts/dashboard-api.md): the owner's view of the
// mind (status, self-state, run timeline, digests, episodes, self-model versions,
// nudges + bands, proactive drafts, exclusions) and the owner's levers over it.
//
// The facade (src/mind/index.js) is loaded LAZILY and memoized through getMind(),
// never imported statically: the dashboard must boot (and the mind stay inert)
// while the facade is absent or broken. Without it, reads return their empty
// shapes (status says `not_initialised`) and every write is a 409.
//
// Global hooks already ran before these handlers: CIDR gate → session/basic auth →
// readOnlyGuard (403 when DASHBOARD_READONLY) → csrfGuard. Here: body validation
// (unknown keys → 400), JID pattern + existence checks, a per-route rate limit with
// `allowList: []` (loopback over an SSH tunnel is NOT exempt) and auditWrite on
// every successful write. Audit payloads carry ids, enums and lengths — never chat,
// model or owner free text. Errors carry codes only.

import { fileURLToPath } from 'url';
import { getDb } from '../../memory/db.js';
import { resolvePerson } from '../../memory/identity.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { auditWrite } from '../audit.js';
import { actorOf } from '../auth.js';

export const STRICT = { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } };
export const LLM = { rateLimit: { max: 2, timeWindow: '1 minute', allowList: [] } };

// The store's owner setters require by = 'owner:<user>' (store.checkOwnerActor).
const byOf = (req) => `owner:${String(actorOf(req) || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 100)}`;

// ── facade loader (shared with routes/config.js for onOwnerConfigChange) ─────

const FACADE_URL = new URL('../../mind/index.js', import.meta.url);
const FACADE_PATH = fileURLToPath(FACADE_URL);
const RETRY_MS = 30_000;
let override;            // undefined → the real facade; null/false → "unavailable"; object → test stub
let cached = null;
let failedAt = 0;
let loggedFailure = false;

/** Test seam: a stub facade, `false` to force "unavailable", `undefined` to restore. */
export function __setMindForTest(facade) {
  override = facade;
}

/** The mind facade, or null when it is absent or fails to load. Never throws. */
export async function getMind() {
  if (override !== undefined) return override || null;
  if (cached) return cached;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return null;
  try {
    cached = await import(FACADE_URL.href);
    return cached;
  } catch (err) {
    failedAt = Date.now();
    const absent = err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message || '').includes(FACADE_PATH);
    if (!absent && !loggedFailure) {
      loggedFailure = true;
      logger.warn({ evt: 'issue', err: err?.message }, 'mind facade failed to load; the Mind page is read-only empty');
    }
    return null;
  }
}

// ── validation ───────────────────────────────────────────────────────────────

class BadRequest extends Error {
  constructor(field) { super('bad_request'); this.field = field; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PERSON_JID_RE = /^[0-9]{5,20}(?::[0-9]{1,3})?@(?:s\.whatsapp\.net|lid)$/;
const GROUP_JID_RE = /^[0-9]{5,30}(?:-[0-9]{5,20})?@g\.us$/;
const isChatJid = (s) => typeof s === 'string' && (PERSON_JID_RE.test(s) || GROUP_JID_RE.test(s));
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

const RUN_KINDS = ['pulse', 'glance', 'think', 'sleep', 'selfmodel', 'draft', 'digest'];
const NUDGE_STATUSES = ['active', 'expired', 'reverted', 'overridden', 'replaced', 'refused', 'clamped'];
const DRAFT_STATUSES = ['drafting', 'shadow', 'would_send', 'queued', 'sent', 'dry_run', 'send_failed', 'dropped',
  'cancelled', 'expired'];
const PROACTIVE_MODES = ['off', 'shadow', 'live'];
const REVIEW_MODES = ['window', 'review', 'auto'];
const RUN_NOW_KINDS = ['glance', 'think', 'sleep'];
const EXCLUSION_KINDS = ['person', 'group'];
const REPLY_LENGTHS = ['shorter', 'normal', 'longer'];
const MULTIPLIER_KNOBS = ['groupResponseRate', 'reactTendency', 'proactiveAppetite'];
const KNOB_NAMES = ['responseRate', ...MULTIPLIER_KNOBS, 'replyLength'];

/** The JSON body as an object whose keys are all in `allowed` (missing body → {}). */
function bodyOf(req, allowed) {
  const b = req.body ?? {};
  if (!isObj(b)) throw new BadRequest('body');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new BadRequest(k);
  return b;
}

function idParam(req) {
  const s = String(req.params?.id ?? '');
  if (!/^[1-9][0-9]{0,11}$/.test(s)) throw new BadRequest('id');
  return Number(s);
}

function limitOf(q, def, max) {
  if (q?.limit == null || q.limit === '') return def;
  const n = Number.parseInt(String(q.limit), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function enumQuery(q, key, values) {
  const v = q?.[key];
  if (v == null || v === '') return undefined;
  if (!values.includes(String(v))) throw new BadRequest(key);
  return String(v);
}

function jidQuery(q, key) {
  const v = q?.[key];
  if (v == null || v === '') return undefined;
  if (!isChatJid(String(v))) throw new BadRequest(key);
  return String(v);
}

function beforeQuery(q) {
  const v = q?.before;
  if (v == null || v === '') return undefined;
  if (!/^[1-9][0-9]{0,11}$/.test(String(v))) throw new BadRequest('before');
  return Number(v);
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Structural check of a full `bands` object (contracts/levers.md) plus the hard
 * limits: responseRate floor ≤ ceil ≤ 0.5, factors in [0.01, 2], maxStep in (0, 0.1];
 * multiplier bands in [0.25, 2] with min ≤ max, maxStep in (0, 1]; replyLength a
 * non-empty subset of the three lengths. The same numbers as knobs.HARD_LIMITS (the
 * facade re-validates against them; this copy exists because the route never
 * imports the mind statically) — keep the two in step.
 */
export function validateBands(b) {
  if (!isObj(b)) throw new BadRequest('bands');
  for (const k of Object.keys(b)) if (!KNOB_NAMES.includes(k)) throw new BadRequest(k);
  for (const k of KNOB_NAMES) if (!isObj(b[k])) throw new BadRequest(k);
  const only = (knob, keys) => {
    for (const f of Object.keys(b[knob])) if (!keys.includes(f)) throw new BadRequest(`${knob}.${f}`);
    if ('disabled' in b[knob] && typeof b[knob].disabled !== 'boolean') throw new BadRequest(`${knob}.disabled`);
  };
  const num = (knob, f, lo, hi) => {
    const v = b[knob][f];
    if (!finite(v) || v < lo || v > hi) throw new BadRequest(`${knob}.${f}`);
    return v;
  };
  const step = (knob, hi) => {
    if (num(knob, 'maxStep', 0, hi) <= 0) throw new BadRequest(`${knob}.maxStep`);
  };

  only('responseRate', ['minFactor', 'maxFactor', 'floor', 'ceil', 'maxStep', 'disabled']);
  const minF = num('responseRate', 'minFactor', 0.01, 2);
  const maxF = num('responseRate', 'maxFactor', 0.01, 2);
  if (minF > maxF) throw new BadRequest('responseRate.minFactor');
  const floor = num('responseRate', 'floor', 0, 0.5);
  const ceil = num('responseRate', 'ceil', 0, 0.5);
  if (floor > ceil) throw new BadRequest('responseRate.floor');
  step('responseRate', 0.1);

  for (const knob of MULTIPLIER_KNOBS) {
    only(knob, ['min', 'max', 'maxStep', 'disabled']);
    const lo = num(knob, 'min', 0.25, 2);
    const hi = num(knob, 'max', 0.25, 2);
    if (lo > hi) throw new BadRequest(`${knob}.min`);
    step(knob, 1);
  }

  only('replyLength', ['allowed', 'disabled']);
  const allowed = b.replyLength.allowed;
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > REPLY_LENGTHS.length
    || allowed.some((v) => !REPLY_LENGTHS.includes(v)) || new Set(allowed).size !== allowed.length) {
    throw new BadRequest('replyLength.allowed');
  }
  return b;
}

// ── responses ────────────────────────────────────────────────────────────────

const badRequest = (reply, field) => reply.code(400).send({ error: 'bad_request', field: String(field || 'body').slice(0, 60) });
const conflict = (reply, reason) => reply.code(409).send({ error: 'conflict', reason });
const notFound = (reply) => reply.code(404).send({ error: 'not_found' });

/** Map an OwnerError-shaped throw ({code, http}) to a reply. False when it is not one. */
function sendOwnerError(reply, err) {
  const http = Number(err?.http ?? err?.status);
  const code = typeof err?.code === 'string' && CODE_RE.test(err.code) ? err.code : null;
  if (!code || ![400, 404, 409].includes(http)) return false;
  if (http === 404) notFound(reply);
  else if (http === 400) badRequest(reply, typeof err.field === 'string' && CODE_RE.test(err.field) ? err.field : code);
  else conflict(reply, code);
  return true;
}

/** Wrap a handler: BadRequest → 400, OwnerError → 400/404/409, anything else → the global handler. */
function wrap(fn) {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof BadRequest) return badRequest(reply, err.field);
      if (sendOwnerError(reply, err)) return reply;
      throw err;
    }
  };
}

/**
 * Run one owner write through the facade: 409 not_initialised without it; a
 * result of { ok:false } → 404 (missing) or 409 (its reason); success → audited.
 */
async function ownerWrite(req, reply, { action, target = null, payload = {}, run }) {
  const mind = await getMind();
  if (!mind?.owner) return conflict(reply, 'not_initialised');
  const result = await run(mind.owner, byOf(req));
  if (result && result.ok === false) {
    const reason = [result.reason, result.code, result.action].find((r) => typeof r === 'string' && CODE_RE.test(r));
    if (!reason || reason === 'missing' || reason === 'not_found') return notFound(reply);
    return conflict(reply, reason);
  }
  const act = typeof action === 'function' ? action(result) : action;
  const pay = typeof payload === 'function' ? payload(result) : payload;
  auditWrite(actorOf(req), act, target, pay);
  return { ...(isObj(result) ? result : {}), ok: true };
}

/** A facade read, with an empty fallback when the facade is absent or throws. */
async function facadeRead(name, fallback, args = []) {
  const mind = await getMind();
  if (typeof mind?.[name] !== 'function') return fallback;
  try {
    const out = await mind[name](...args);
    return out ?? fallback;
  } catch (err) {
    if (err instanceof BadRequest || (typeof err?.code === 'string' && Number.isInteger(err?.http))) throw err;
    logger.warn({ evt: 'issue', err: err?.message, read: name }, 'mind facade read failed');
    return fallback;
  }
}

const REMINDER_TEXT = {
  not_initialised: 'The mind is not initialised in this process yet; the page shows no mind data.',
  degraded: 'The mind status could not be read; check the logs.',
  owner_jids_unset: 'OWNER_JIDS is not set in .env, so proactive live mode is unavailable.',
};

function fallbackStatus(code) {
  const ownerJidsSet = Array.isArray(config.ownerJids) && config.ownerJids.length > 0;
  const reminders = [{ code, text: REMINDER_TEXT[code] }];
  if (!ownerJidsSet) reminders.push({ code: 'owner_jids_unset', text: REMINDER_TEXT.owner_jids_unset });
  let enabled = false;
  try { enabled = isSkillEnabled('mind'); } catch { /* skills not loaded */ }
  return {
    available: false,
    enabled,
    paused: false,
    pausedAt: null,
    proactiveMode: null,
    modeSince: null,
    ownerJidsSet,
    review: null,
    life: null,
    budget: null,
    spend: { monthUsd: 0, byCaller: [] },
    today: { glances: 0, thinks: 0, sleeps: 0, drafts: 0, sends: 0 },
    caps: { ...config.mind },
    next: null,
    lastRun: null,
    global: null,
    reminders,
  };
}

// ── operator reads straight from the DB (no facade function for these) ───────

function parseList(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** The chat's stored forms: the jid itself plus its canonical person id. */
function chatForms(jid) {
  const forms = new Set([jid]);
  if (PERSON_JID_RE.test(jid)) {
    const canon = resolvePerson(jid);
    if (canon) forms.add(canon);
  }
  return [...forms];
}

const marks = (n) => Array(n).fill('?').join(',');

function listDigests({ chat, limit }) {
  const forms = chat ? chatForms(chat) : null;
  const rows = getDb().prepare(`
    SELECT d.id, d.chat_jid, d.origin_kind, d.from_rowid, d.to_rowid, d.period_start, d.period_end, d.summary,
      d.today_note, d.tone, d.threads_json, d.model, d.run_id, d.created_at,
      COALESCE(g.name, p.real_name, p.push_name) AS chat_name
    FROM mind_digests d
    LEFT JOIN groups g ON g.jid = d.chat_jid
    LEFT JOIN people p ON p.jid = d.chat_jid
    ${forms ? `WHERE d.chat_jid IN (${marks(forms.length)})` : ''}
    ORDER BY d.id DESC
    LIMIT ?`).all(...(forms || []), limit);
  return rows.map((r) => ({
    id: r.id, chatJid: r.chat_jid, chatName: r.chat_name || null, originKind: r.origin_kind, originJid: r.chat_jid,
    fromRowid: r.from_rowid, toRowid: r.to_rowid, periodStart: r.period_start, periodEnd: r.period_end,
    summary: r.summary, todayNote: r.today_note, tone: r.tone, threads: parseList(r.threads_json),
    model: r.model, runId: r.run_id, createdAt: r.created_at,
  }));
}

function listEpisodes({ chat, limit }) {
  const forms = chat ? chatForms(chat) : null;
  const rows = getDb().prepare(`
    SELECT m.id, m.content, m.attribute, m.origin_kind, m.origin_jid, m.learned_at, m.created_at, m.expires_at,
      m.importance, m.source, m.superseded_by, m.superseded_at,
      (SELECT COUNT(*) FROM item_evidence e WHERE e.item_type = 'memory' AND e.item_id = m.id) AS evidence_count,
      COALESCE(g.name, p.real_name, p.push_name) AS origin_label
    FROM memories m
    LEFT JOIN groups g ON g.jid = m.origin_jid
    LEFT JOIN people p ON p.jid = m.origin_jid
    WHERE m.category = 'episode' ${forms ? `AND m.origin_jid IN (${marks(forms.length)})` : ''}
    ORDER BY COALESCE(m.learned_at, m.created_at) DESC, m.id DESC
    LIMIT ?`).all(...(forms || []), limit);
  return rows.map((r) => ({
    id: r.id, content: r.content, attribute: r.attribute, originKind: r.origin_kind, originJid: r.origin_jid,
    originLabel: r.origin_label || null, learnedAt: r.learned_at, createdAt: r.created_at, expiresAt: r.expires_at,
    importance: r.importance, source: r.source, current: r.superseded_by == null, supersededBy: r.superseded_by,
    supersededAt: r.superseded_at, evidenceCount: r.evidence_count,
  }));
}

// ── routes ───────────────────────────────────────────────────────────────────

export default async function mindRoutes(app) {
  // Reads
  app.get('/api/mind/status', wrap(async () => {
    const mind = await getMind();
    if (typeof mind?.getStatus !== 'function') return fallbackStatus('not_initialised');
    try {
      const st = await mind.getStatus();
      if (!isObj(st)) return fallbackStatus('degraded');
      return { available: true, ...st };
    } catch (err) {
      logger.warn({ evt: 'issue', err: err?.message }, 'mind status read failed');
      return fallbackStatus('degraded');
    }
  }));

  app.get('/api/mind/self-state', wrap(async (req) => {
    const asChatJid = jidQuery(req.query, 'as');
    return facadeRead('getSelfState', { elements: [] }, [asChatJid ? { asChatJid } : {}]);
  }));

  app.get('/api/mind/runs', wrap(async (req) => {
    const q = { kind: enumQuery(req.query, 'kind', RUN_KINDS), before: beforeQuery(req.query), limit: limitOf(req.query, 50, 100) };
    return facadeRead('listRuns', [], [q]);
  }));

  app.get('/api/mind/runs/:id', wrap(async (req, reply) => {
    const id = idParam(req);
    const run = await facadeRead('getRun', null, [id]);
    return run || notFound(reply);
  }));

  app.get('/api/mind/digests', wrap(async (req) => listDigests({
    chat: jidQuery(req.query, 'chat'), limit: limitOf(req.query, 20, 50),
  })));

  app.get('/api/mind/episodes', wrap(async (req) => listEpisodes({
    chat: jidQuery(req.query, 'chat'), limit: limitOf(req.query, 50, 100),
  })));

  app.get('/api/mind/self-model', wrap(async () => facadeRead('getSelfModel', { active: null, pending: [], versions: [] })));

  app.get('/api/mind/self-model/:id', wrap(async (req, reply) => {
    const id = idParam(req);
    const v = await facadeRead('getSelfModelDiff', null, [id]);
    return v || notFound(reply);
  }));

  app.get('/api/mind/nudges', wrap(async (req) => facadeRead('listNudges', [], [{
    status: enumQuery(req.query, 'status', NUDGE_STATUSES), limit: limitOf(req.query, 100, 200),
  }])));

  app.get('/api/mind/bands', wrap(async () => facadeRead('getBands', { bands: null, knobs: {} })));

  app.get('/api/mind/proactive', wrap(async (req) => facadeRead('listProactive', [], [{
    status: enumQuery(req.query, 'status', DRAFT_STATUSES),
    chatJid: jidQuery(req.query, 'chat'),
    before: beforeQuery(req.query),
    limit: limitOf(req.query, 50, 100),
  }])));

  app.get('/api/mind/exclusions', wrap(async () => facadeRead('listExclusions', { excludeAll: false, rows: [] })));

  // Writes
  app.post('/api/mind/pause', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['paused']);
    if (typeof b.paused !== 'boolean') throw new BadRequest('paused');
    return ownerWrite(req, reply, {
      action: b.paused ? 'mind.pause' : 'mind.resume',
      run: (owner, by) => owner.setPaused(b.paused, by),
    });
  }));

  app.post('/api/mind/proactive/mode', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['mode', 'confirm']);
    if (!PROACTIVE_MODES.includes(b.mode)) throw new BadRequest('mode');
    if ('confirm' in b && typeof b.confirm !== 'boolean') throw new BadRequest('confirm');
    if (b.mode === 'live') {
      if (b.confirm !== true) throw new BadRequest('confirm');
      if (!Array.isArray(config.ownerJids) || !config.ownerJids.length) return conflict(reply, 'owner_jids_unset');
    }
    return ownerWrite(req, reply, {
      action: 'mind.proactive.mode', target: b.mode, payload: { mode: b.mode },
      run: (owner, by) => owner.setProactiveMode(b.mode, by),
    });
  }));

  app.post('/api/mind/proactive/:id/drop', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, {
      action: 'mind.proactive.drop', target: String(id),
      run: (owner, by) => owner.dropDraft(id, by),
    });
  }));

  app.post('/api/mind/review', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['mode', 'extendDays']);
    if (!('mode' in b) && !('extendDays' in b)) throw new BadRequest('mode');
    if ('mode' in b && !REVIEW_MODES.includes(b.mode)) throw new BadRequest('mode');
    if ('extendDays' in b && !(Number.isInteger(b.extendDays) && b.extendDays >= 1 && b.extendDays <= 30)) {
      throw new BadRequest('extendDays');
    }
    const change = {};
    if ('mode' in b) change.mode = b.mode;
    if ('extendDays' in b) change.extendDays = b.extendDays;
    return ownerWrite(req, reply, {
      action: 'mind.review', payload: change,
      run: (owner, by) => owner.setReview(change, by),
    });
  }));

  // ── stances (plan 020 B): his interests and opinions ──────────────────────
  app.get('/api/mind/stances', wrap(async () => {
    const mind = await getMind();
    return (await mind?.listStances?.()) ?? { stances: [], counts: { proposed: 0, active: 0 } };
  }));

  app.get('/api/mind/stances/:id/why', wrap(async (req, reply) => {
    const mind = await getMind();
    const r = await mind?.getStanceWhy?.(idParam(req));
    if (!r || r.ok === false) return notFound(reply);
    return r;
  }));

  app.post('/api/mind/stances/seed', { config: LLM }, wrap(async (req, reply) => {
    bodyOf(req, []);
    return ownerWrite(req, reply, {
      action: 'mind.stance.seed',
      payload: (r) => ({ count: r.count }),
      run: (owner, by) => owner.stanceSeed(by),
    });
  }));

  app.post('/api/mind/stances/approve', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['ids']);
    if ('ids' in b && !(Array.isArray(b.ids) && b.ids.length <= 200 && b.ids.every((x) => Number.isSafeInteger(x) && x > 0))) throw new BadRequest('ids');
    return ownerWrite(req, reply, {
      action: 'mind.stance.approve',
      payload: (r) => ({ approved: r.approved }),
      run: (owner, by) => owner.stanceApprove(b.ids ?? null, by),
    });
  }));

  app.post('/api/mind/stances/:id/reject', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, { action: 'mind.stance.reject', target: String(id), run: (owner, by) => owner.stanceReject(id, by) });
  }));

  app.post('/api/mind/stances/:id/pin', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    const b = bodyOf(req, ['pinned']);
    if (typeof b.pinned !== 'boolean') throw new BadRequest('pinned');
    return ownerWrite(req, reply, { action: 'mind.stance.pin', target: String(id), payload: { pinned: b.pinned }, run: (owner, by) => owner.stancePin(id, b.pinned, by) });
  }));

  app.put('/api/mind/stances/:id/anchor', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    const b = bodyOf(req, ['anchor']);
    if (typeof b.anchor !== 'number' || !Number.isFinite(b.anchor)) throw new BadRequest('anchor');
    return ownerWrite(req, reply, { action: 'mind.stance.anchor', target: String(id), run: (owner, by) => owner.stanceAnchor(id, b.anchor, by) });
  }));

  app.post('/api/mind/stances/:id/reset', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, { action: 'mind.stance.reset', target: String(id), run: (owner, by) => owner.stanceReset(id, by) });
  }));

  app.post('/api/mind/self-model/:id/approve', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, {
      action: 'mind.selfmodel.approve', target: String(id),
      run: (owner, by) => owner.approve(id, by),
    });
  }));

  app.post('/api/mind/self-model/:id/reject', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    const b = bodyOf(req, ['reason']);
    if ('reason' in b && !(typeof b.reason === 'string' && b.reason.length <= 200)) throw new BadRequest('reason');
    const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : null;
    return ownerWrite(req, reply, {
      action: 'mind.selfmodel.reject', target: String(id), payload: { reasonLength: reason ? reason.length : 0 },
      run: (owner, by) => owner.reject(id, by, { reason }),
    });
  }));

  app.post('/api/mind/self-model/:id/revert', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, {
      action: 'mind.selfmodel.revert', target: String(id),
      payload: (r) => ({ fromId: id, version: r?.version ?? null }),
      run: (owner, by) => owner.revertTo(id, by),
    });
  }));

  app.put('/api/mind/self-model', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['text']);
    if (typeof b.text !== 'string' || b.text.length > 1500) throw new BadRequest('text');
    return ownerWrite(req, reply, {
      action: 'mind.selfmodel.edit',
      payload: (r) => ({ length: b.text.length, version: r?.version ?? null }),
      run: (owner, by) => owner.editSelfModel(b.text, by),
    });
  }));

  app.post('/api/mind/nudges/:id/revert', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    bodyOf(req, []);
    return ownerWrite(req, reply, {
      action: 'mind.nudge.revert', target: String(id),
      run: (owner, by) => owner.revertNudge(id, by),
    });
  }));

  app.put('/api/mind/bands', { config: STRICT }, wrap(async (req, reply) => {
    const bands = validateBands(req.body);
    return ownerWrite(req, reply, {
      action: 'mind.bands', payload: (r) => ({ knobs: KNOB_NAMES, overridden: Number(r?.overridden) || 0 }),
      run: (owner, by) => owner.setBands(bands, by),
    });
  }));

  app.post('/api/mind/exclusions', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['kind', 'jid', 'note']);
    if (!EXCLUSION_KINDS.includes(b.kind)) throw new BadRequest('kind');
    if ('note' in b && b.note !== null && !(typeof b.note === 'string' && b.note.length <= 120)) throw new BadRequest('note');
    let jid;
    if (b.kind === 'person') {
      if (typeof b.jid !== 'string' || !PERSON_JID_RE.test(b.jid)) throw new BadRequest('jid');
      jid = resolvePerson(b.jid);
      if (!jid || !getDb().prepare('SELECT 1 FROM people WHERE jid = ?').get(jid)) return notFound(reply);
    } else {
      if (typeof b.jid !== 'string' || !GROUP_JID_RE.test(b.jid)) throw new BadRequest('jid');
      if (!getDb().prepare('SELECT 1 FROM groups WHERE jid = ?').get(b.jid)) return notFound(reply);
      jid = b.jid;
    }
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
    return ownerWrite(req, reply, {
      action: 'mind.exclusion.add', target: jid, payload: { kind: b.kind, hasNote: !!note },
      run: (owner, by) => owner.addExclusion({ kind: b.kind, jid, note }, by),
    });
  }));

  app.delete('/api/mind/exclusions/:id', { config: STRICT }, wrap(async (req, reply) => {
    const id = idParam(req);
    return ownerWrite(req, reply, {
      action: 'mind.exclusion.remove', target: String(id),
      payload: (r) => ({ action: typeof r?.action === 'string' ? r.action.slice(0, 20) : null }),
      run: (owner, by) => owner.removeExclusion(id, by),
    });
  }));

  app.post('/api/mind/exclusions/global', { config: STRICT }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['excludeAll']);
    if (typeof b.excludeAll !== 'boolean') throw new BadRequest('excludeAll');
    return ownerWrite(req, reply, {
      action: 'mind.exclude_all', payload: { excludeAll: b.excludeAll },
      run: (owner, by) => owner.setExcludeAll(b.excludeAll, by),
    });
  }));

  app.post('/api/mind/run', { config: LLM }, wrap(async (req, reply) => {
    const b = bodyOf(req, ['kind']);
    if (!RUN_NOW_KINDS.includes(b.kind)) throw new BadRequest('kind');
    return ownerWrite(req, reply, {
      action: 'mind.run', target: b.kind,
      payload: (r) => ({ runId: r?.runId ?? null, status: typeof r?.status === 'string' ? r.status.slice(0, 20) : null }),
      run: (owner, by) => owner.runNow(b.kind, by),
    });
  }));
}
