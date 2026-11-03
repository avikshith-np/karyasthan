// Relationships, arcs & Director (spec 010, contracts/director-api.md §1, §2, §6):
// story reads, Ask-me cards, the claim tray, proposals, the journal, narration
// and the arc seed; scenes (016) and his phone (019: threads with his fictional cast).
//
// Everything goes through the story facade (src/life/story/index.js), which is
// loaded lazily: the dashboard must boot (and every other page work) even when
// the facade is missing or fails to import. Then every read answers 200 with an
// "off" shape and every write 409 — never a 500.
//
// Writes are owner operations: the global readOnlyGuard (403 while
// DASHBOARD_READONLY=true) and csrfGuard run first (neither is edited), then a
// per-route rate limit with allowList: [] (the global limiter exempts loopback,
// which is where the owner's tunnel lands), and every accepted write is recorded
// in dashboard_audit with ids, kinds, counts and lengths only — never claim,
// scene, journal or narration text.
//
// The dashboard is the operator view: it sees every origin. Nothing here reaches
// a prompt.
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getDb } from '../../memory/db.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { auditWrite } from '../audit.js';
import * as life from '../../life/index.js';
import { getClaim } from '../../life/claims.js';
import { toId } from './life.js';
import * as publicSite from '../../public/index.js';
import { actorOf } from '../auth.js';

// ── Limits (director-api §0) ───────────────────────────────────────────────

const limit = (max, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow, allowList: [] } });
export const WRITE = limit(10);
export const PREVIEW = limit(20);
export const TOMORROW = limit(4);
export const NARRATE = limit(2);
export const JOURNAL_REGEN = limit(2, '1 hour');
export const SEED_REGEN = limit(1, '1 hour');
export const PROMPT = limit(6);   // spec 011: the Director prompt (one mind call each)
export const CONTINUITY = limit(10);   // spec 015: the story read (one mind call each, cached per preview)
export const SCENE_REGEN = limit(2);   // spec 016: REGENERATE (one model call each)
export const PHONE_REGEN = limit(2);   // spec 019: one message rewritten (one model call each)

// ── Enums and patterns kept at the route layer (the facade re-validates) ───

export const REVIEW_STATUSES = new Set(['pending', 'extracting', 'adopted', 'tray', 'rejected', 'dismissed', 'expired',
  'withdrawn', 'returned', 'failed']);
export const PROPOSAL_STATUSES = new Set(['pending', 'applied', 'rejected', 'refused', 'expired']);
export const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
export const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
export const OPTION_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const NIGHT_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// A JID or an @-mention inside owner text (the Director refuses more: phone
// numbers and real names). Route-level defence in depth.
export const JID_IN_TEXT_RE = /[0-9A-Za-z._:+-]{3,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)|@\d{5,}/i;

const CLAIMS_MAX = 100;
const PROPOSALS_MAX = 100;
const NIGHTS_MAX = 60;
const REFUSALS_MAX = 200;
const CAST_EVENTS_MAX = 100;
// Body shape caps: a generous backstop; the facade applies each field's own cap.
const BODY_STRING_MAX = 400;
const BODY_DEPTH_MAX = 5;
const BODY_ARRAY_MAX = 32;
const BODY_KEYS_MAX = 40;

export { actorOf };

function toInt(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** A clamped list limit from a query value. */
export function limitOf(v, dflt, max) {
  return Math.min(max, Math.max(1, toInt(v, dflt)));
}

/**
 * Walk a parsed body: every string ≤ BODY_STRING_MAX chars and free of JIDs,
 * bounded depth/arrays/keys. → null when fine, else a reason code (400).
 * Oversize is refused, never truncated.
 */
export function bodyProblem(v, depth = 0) {
  if (depth > BODY_DEPTH_MAX) return 'too_deep';
  if (typeof v === 'string') {
    if (v.length > BODY_STRING_MAX) return 'too_long';
    if (JID_IN_TEXT_RE.test(v)) return 'jid_in_text';
    return null;
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) {
    return typeof v === 'number' && !Number.isFinite(v) ? 'bad_number' : null;
  }
  if (Array.isArray(v)) {
    if (v.length > BODY_ARRAY_MAX) return 'too_many';
    for (const x of v) { const p = bodyProblem(x, depth + 1); if (p) return p; }
    return null;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > BODY_KEYS_MAX) return 'too_many';
    for (const k of keys) {
      if (k.length > 60) return 'too_long';
      if (JID_IN_TEXT_RE.test(k)) return 'jid_in_text';
      const p = bodyProblem(v[k], depth + 1);
      if (p) return p;
    }
    return null;
  }
  return 'bad_value';
}

const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// ── The story facade (lazy, test-overridable) ──────────────────────────────

let testDeps = null;   // { story, lifeRunning } from __setStoryForTest
let cached = null;
let failedAt = 0;
const RETRY_MS = 60_000;

/** Test seam: a stub facade (and optionally whether life counts as running). null restores the real ones. */
export function __setStoryForTest(story, { lifeRunning = null } = {}) {
  testDeps = story === null ? null : { story, lifeRunning };
}

/** The story facade module, or null when it is missing or failed to import (retried after a minute). */
export async function loadStory() {
  if (testDeps) return testDeps.story ?? null;
  if (cached) return cached;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return null;
  try {
    cached = await import('../../life/story/index.js');
    failedAt = 0;
    return cached;
  } catch (err) {
    failedAt = Date.now();
    logger.warn({ evt: 'issue', where: 'dashboard.arcs', err: err?.code || err?.name }, 'arcs: story facade not available');
    return null;
  }
}

export function lifeRunning() {
  if (typeof testDeps?.lifeRunning === 'function') {
    try { return !!testDeps.lifeRunning(); } catch { return false; }
  }
  try { return life.getState() !== null; } catch { return false; }
}

export function arcsSkillOn() {
  try { return isSkillEnabled('arcs'); } catch { return false; }
}

/** { story, running, enabled }: enabled = life running + the arcs skill + the facade attached. */
export async function storyContext() {
  const running = lifeRunning();
  const story = await loadStory();
  let on = false;
  if (running && story && arcsSkillOn()) {
    try { on = typeof story.storyOn === 'function' && story.storyOn() === true; } catch { on = false; }
  }
  return { story, running, enabled: on };
}

/** Writes: 409 unless life runs and arcs is on. → the facade, or null after replying. */
export async function writeGate(reply) {
  const c = await storyContext();
  if (!c.running) { reply.code(409).send({ error: 'life is not running' }); return null; }
  if (!c.enabled) { reply.code(409).send({ error: 'arcs is off' }); return null; }
  return c.story;
}

// ── StoryError → HTTP ──────────────────────────────────────────────────────

const CODE_STATUS = Object.freeze({
  invalid: 400, not_found: 404, rate: 429,
  not_running: 409, stale: 409, refused: 409, expired: 409, conflict: 409,
});
const SLUG_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;   // reason codes (bad_startAt, heavy_cap, …)

function cleanRefusals(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 20).map((r) => ({
    reason: typeof r?.reason === 'string' && SLUG_RE.test(r.reason) ? r.reason : 'refused',
    target: typeof r?.target === 'string' ? r.target.slice(0, 80) : null,
  }));
}

/** Map a facade error (duck-typed StoryError{code, reason}) to a reply. Never echoes an unknown message. */
export function sendStoryError(reply, err, where = 'arcs') {
  const code = typeof err?.code === 'string' && Object.prototype.hasOwnProperty.call(CODE_STATUS, err.code) ? err.code : null;
  if (!code) {
    logger.warn({ evt: 'issue', where: `dashboard.${where}`, err: err?.name || 'Error' }, 'arcs: owner operation failed');
    return reply.code(409).send({ error: 'failed' });
  }
  const reason = typeof err.reason === 'string' && SLUG_RE.test(err.reason) ? err.reason : null;
  let error;
  if (code === 'not_running') error = 'life is not running';
  else if (code === 'expired') error = 'expired_preview';
  else if (code === 'stale') error = 'stale';
  else error = reason || code;
  const out = { error, code };
  if (reason && reason !== error) out.reason = reason;
  if (Number.isInteger(err.part) && err.part >= 0 && err.part < 16) out.part = err.part;   // 015 cont: a bundle part
  if (Number.isSafeInteger(err.earliestAt) && err.earliestAt > 0) out.earliestAt = err.earliestAt;   // too_soon: the first start he can make
  const refusals = cleanRefusals(err.refusals);
  if (refusals?.length) out.refusals = refusals;
  return reply.code(CODE_STATUS[code]).send(out);
}

// ── Read helpers ───────────────────────────────────────────────────────────

const arr = (v) => (Array.isArray(v) ? v : []);

/** Call a reader; readers never throw by contract, but a broken one yields `fallback`. */
function read(story, name, args, fallback) {
  if (!story || typeof story[name] !== 'function') return fallback;
  try {
    const v = story[name](...args);
    return v ?? fallback;
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'dashboard.arcs', reader: name, err: err?.name || 'Error' }, 'arcs: story reader failed');
    return fallback;
  }
}

const ZERO_COUNTS = Object.freeze({ cards: 0, vetoCards: 0, tray: 0, proposals: 0, refusals24h: 0 });

/** /api/arcs/status (also its off shape). Never throws. */
export async function arcsStatus() {
  const c = await storyContext();
  const base = {
    enabled: false,
    running: c.running,
    skill: arcsSkillOn(),
    lifeSkill: (() => { try { return isSkillEnabled('life'); } catch { return false; } })(),
    facade: !!c.story,
    paused: false,
    fate: {},
    sliders: {},
    pins: [],
    reconcilerMode: config.arcs?.reconcilerMode ?? 'auto',
    seed: { source: null, missing: [] },
    counts: { ...ZERO_COUNTS },
    budgets: null,
    degraded: false,
  };
  if (!c.enabled) return base;
  const s = read(c.story, 'status', [], null);
  if (!s || typeof s !== 'object') return { ...base, enabled: true };
  return {
    ...base,
    ...s,
    enabled: true,
    running: true,
    skill: true,
    facade: true,
    pins: arr(s.pins),
    counts: { ...ZERO_COUNTS, ...(s.counts && typeof s.counts === 'object' ? s.counts : {}) },
  };
}

// Chat names for the tray (dashboard routes may read these tables directly).
function chatName(db, jid) {
  if (typeof jid !== 'string' || !jid) return null;
  try {
    if (jid.endsWith('@g.us')) return db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name || null;
    const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(jid);
    return p?.real_name || p?.push_name || null;
  } catch {
    return null;
  }
}

/** A tray review joined with its life_claims row (text, kind) and chat name. */
function reviewOut(r, db) {
  if (!r || typeof r !== 'object') return null;
  let claim = null;
  if (Number.isSafeInteger(r.claimId)) {
    try { claim = getClaim(r.claimId); } catch { claim = null; }
  }
  const chatJid = r.chatJid ?? claim?.chatJid ?? null;
  return {
    ...r,
    text: r.text ?? claim?.text ?? null,
    claimKind: r.claimKind ?? claim?.kind ?? null,
    claimStatus: r.claimStatus ?? claim?.status ?? null,
    chatJid,
    chatName: r.chatName ?? chatName(db, chatJid),
    originKind: r.originKind ?? claim?.originKind ?? null,
    expiresAt: r.expiresAt ?? null,
  };
}

// ── Scenes (spec 016 P1.9 / P2.4) ──────────────────────────────────────────

export const SCENE_ENDINGS = new Set(['nothing', 'swapped_numbers', 'plan_to_meet', 'stayed_late', 'left_early', 'parted_badly']);
export const SCENE_TONE_MAX = 120;
export const SCENE_TEXT_MAX = 1200;
export const SCENE_TEXT_LONG_MAX = 2400;   // a long outing; the facade still refuses a short one over 1200
const SCENE_STATUSES = new Set(['pending', 'running', 'done', 'fallback', 'skipped', 'superseded', 'reverted']);
const SCENE_OUTCOMES = new Set(['well', 'fine', 'flat', 'badly']);
const sStr = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const sNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const sCode = (v) => (typeof v === 'string' && /^[a-z][a-z0-9_:.-]{0,39}$/i.test(v) ? v : null);

// ── His phone (spec 019): threads with his fictional cast ──────────────────
// Reads and owner writes over the facade's phoneThreads / phoneThread / phoneEdit /
// phoneRegenerate. SEND A TEXT is the Director kind `text` (preview → apply);
// REVERT is the life revert route on a message's eventId. Real people never have a
// thread (the facade's rule). Audits carry ids and lengths, never the text.

export const PHONE_TEXT_MAX = 300;
const PHONE_THREADS_MAX = 100;
const PHONE_PAGE = 50;
const PHONE_PAGE_MAX = 100;
const PHONE_PREVIEW_MAX = 80;
const PHONE_SHOWN_MAX = 2000;   // a message as stored (an owner edit is ≤ 300; a generous backstop)
const PHONE_BAD_INPUT = new Set(['too_long', 'real_name', 'jid_in_text', 'empty', 'bad_text', 'bad_id', 'invalid']);

let phoneTest = null;   // { stub, running, enabled } from __setPhoneForTest

/** Test seam: a stub with the phone calls (null restores the real facade). */
export function __setPhoneForTest(stub, { running = true, enabled = true } = {}) {
  phoneTest = stub === null ? null : { stub, running, enabled };
}

async function phoneContext() {
  if (phoneTest) return { story: phoneTest.stub, running: !!phoneTest.running, enabled: !!phoneTest.running && !!phoneTest.enabled };
  return storyContext();
}

async function phoneWriteGate(reply) {
  const c = await phoneContext();
  if (!c.running) { reply.code(409).send({ error: 'life is not running' }); return null; }
  if (!c.enabled) { reply.code(409).send({ error: 'arcs is off' }); return null; }
  return c.story;
}

const phoneDir = (v) => (v === 'in' ? 'in' : 'out');
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/** One message, closed shape. */
export function phoneMessageOut(m) {
  return {
    id: sId(m?.id), eventId: sId(m?.eventId), at: Number.isSafeInteger(m?.at) ? m.at : null, dir: phoneDir(m?.dir),
    text: str(m?.text, PHONE_SHOWN_MAX) ?? '', edited: m?.edited === true, status: m?.status === 'reverted' ? 'reverted' : 'live',
    tier: sCode(m?.tier), trigger: sCode(m?.trigger), revertible: m?.revertible === true, regenerable: m?.regenerable === true,
  };
}

function phoneThreadRow(t) {
  const last = t?.last && typeof t.last === 'object'
    ? { at: Number.isSafeInteger(t.last.at) ? t.last.at : null, dir: phoneDir(t.last.dir), preview: str(t.last.preview, PHONE_PREVIEW_MAX) ?? '' }
    : null;
  return { castId: CAST_ID_RE.test(String(t?.castId ?? '')) ? t.castId : null, name: str(t?.name, 80) ?? '', departed: t?.departed === true,
    count: Number.isSafeInteger(t?.count) && t.count >= 0 ? t.count : 0, last };
}

/** A facade refusal ({code} thrown or returned) → a reply; never echoes a message. */
function sendPhoneError(reply, err, where) {
  if (typeof err?.code === 'string' && Object.prototype.hasOwnProperty.call(CODE_STATUS, err.code)) return sendStoryError(reply, err, where);
  const code = sCode(err?.code);
  if (!code) {
    logger.warn({ evt: 'issue', where: `dashboard.${where}`, err: err?.name || 'Error' }, 'arcs: phone operation failed');
    return reply.code(409).send({ error: 'failed' });
  }
  return reply.code(code === 'not_found' ? 404 : PHONE_BAD_INPUT.has(code) ? 400 : 409).send({ error: code });
}

/**
 * A scene detail from the facade (story.sceneDetail) → the route's closed shape. The
 * operator view: the facade already reads a real person's `{FRIEND}` token as their push
 * name and sends `realPerson` + `friend` (never the JID); a leftover token reads as that name.
 */
export function sceneOut(d) {
  if (!d || typeof d !== 'object') return null;
  const realPerson = d.realPerson === true || (typeof d.subjectJid === 'string' && d.subjectJid.length > 0);
  const friendName = realPerson ? (sStr(d.friend, 60) || 'a friend') : null;
  const friend = (t) => (typeof t === 'string' ? t.replace(/\{FRIEND\}/g, friendName || 'a friend') : t);
  const text = (v, max) => friend(sStr(v, max));
  const person = (x) => (x && typeof x === 'object' ? {
    castId: sStr(x.castId, 48), name: sStr(x.name, 60), pronouns: sStr(x.pronouns, 24), text: text(x.text, 200), firstMeet: x.firstMeet === true,
  } : null);
  const imp = d.impressions && typeof d.impressions === 'object' ? {
    him: arr(d.impressions.him).map(person).filter((x) => x?.text).slice(0, 4),
    them: arr(d.impressions.them).map(person).filter((x) => x?.text).slice(0, 4),
  } : null;
  const sum = d.summary && typeof d.summary === 'object' ? d.summary : {};
  const excluded = d.excluded === true || d.status === 'reverted' || d.status === 'superseded';
  const effect = (e) => {
    const t = sStr(typeof e === 'string' ? e : (e?.summary ?? e?.text), 160);
    return t && e?.excluded === true ? `${t} (reverted)` : t;
  };
  return {
    id: sId(d.sceneId ?? d.id), eventId: sId(d.eventId), activityEventId: sId(d.activityEventId), version: sId(d.version),
    status: SCENE_STATUSES.has(d.status) ? d.status : null, live: d.live !== false,
    at: sNum(d.at ?? sum.at), end: sNum(d.endedAt ?? sum.endedAt ?? d.end), kind: sStr(d.kindWords ?? sum.kindWords ?? d.kind ?? sum.kind, 40),
    place: sStr(d.place ?? sum.place, 80),
    with: arr(d.with).map(person).filter(Boolean).slice(0, 8),
    realPerson, friend: friendName,
    mode: sCode(d.mode), tier: sCode(d.tier), model: sStr(d.model, 80), fellBack: d.fellBack === true, fallback: d.fallback === true || d.status === 'fallback',
    text: text(d.text, SCENE_TEXT_LONG_MAX + 200), editedText: text(d.editedText, SCENE_TEXT_LONG_MAX + 200), editedAt: sNum(d.editedAt),
    impressions: imp && (imp.him.length || imp.them.length) ? imp : null,
    topics: arr(d.topics).map((t) => text(t, 60)).filter(Boolean).slice(0, 5),
    highlight: text(d.highlight, 200), awkward: text(d.awkward, 200),
    chemistry: sNum(d.chemistry), ending: SCENE_ENDINGS.has(d.ending) ? d.ending : null,
    outcome: sCode(d.outcome), outcomeBy: sCode(d.outcomeBy), tone: sStr(d.tone, SCENE_TONE_MAX),
    toneOutcome: SCENE_OUTCOMES.has(d.toneOutcome) ? d.toneOutcome : null,
    effects: arr(d.effects).map(effect).filter(Boolean).slice(0, 12),
    costUsd: sNum(d.costUsd), skipReason: sCode(d.skipReason),
    excluded, revertible: d.revertible === true && !excluded && d.live !== false, revertReason: sCode(d.revertReason),
    // REGENERATE: the live version, or a reverted one whose outing is still in his day (R32); never a real person's.
    regenerable: !realPerson && (d.regenerable === true || (d.regenerable === undefined && d.live !== false && !excluded)),
    versions: arr(d.versions).map((v) => ({ id: sId(v?.sceneId ?? v?.id), version: sId(v?.version), status: SCENE_STATUSES.has(v?.status) ? v.status : null,
      at: sNum(v?.createdAt ?? v?.at), skipReason: sCode(v?.skipReason) }))
      .filter((v) => v.id).slice(0, 20),
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

export default async function arcsRoutes(app) {
  // ── Reads ──────────────────────────────────────────────────────────────

  app.get('/api/arcs/status', async () => arcsStatus());

  app.get('/api/arcs/cast', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, cast: [] };
    return { enabled: true, running: true, cast: arr(read(c.story, 'cast', [], [])) };
  });

  app.get('/api/arcs/cast/:id', async (req, reply) => {
    let id = String(req.params.id || '');
    try { id = decodeURIComponent(id); } catch { return reply.code(400).send({ error: 'bad cast id' }); }
    if (!CAST_ID_RE.test(id)) return reply.code(400).send({ error: 'bad cast id' });
    const q = req.query || {};
    let before = null;
    if (q.before !== undefined && q.before !== '') {
      before = toId(q.before);
      if (!before) return reply.code(400).send({ error: 'before must be an event id' });
    }
    const lim = limitOf(q.limit, 50, CAST_EVENTS_MAX);
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, member: null, history: [], events: [], nextBefore: null };
    const d = read(c.story, 'castDetail', [id, { before, limit: lim }], null);
    if (!d || !d.member) return reply.code(404).send({ error: 'cast member not found' });
    const events = arr(d.events).slice(0, lim);
    return {
      enabled: true,
      running: true,
      member: d.member,
      history: arr(d.history),
      metrics: arr(d.metrics),
      scenes: arr(d.scenes).slice(0, 20),   // 016 P2.5: how his outings with them went
      standing: d.standing ?? null,   // 020 D2: how things stand, and its versions
      events,
      nextBefore: d.nextBefore ?? (events.length === lim ? events[events.length - 1]?.id ?? null : null),
    };
  });

  app.get('/api/arcs/web', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, nodes: [], edges: [] };
    const w = read(c.story, 'web', [], {});
    return { enabled: true, running: true, nodes: arr(w.nodes), edges: arr(w.edges) };
  });

  app.get('/api/arcs/story', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, categories: [] };
    const b = read(c.story, 'arcsBoard', [], {});
    return { enabled: true, running: true, categories: arr(b.categories) };
  });

  app.get('/api/arcs/cards', async (req) => {
    const q = req.query || {};
    const includeClosed = q.closed === '1' || q.closed === 'true';
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, cards: [] };
    // 013: the public site's audience tallies ride along on open decision cards (a
    // suggestion for the owner; nothing is applied).
    const cards = arr(read(c.story, 'cards', [{ includeClosed }], [])).map((card) => {
      if (card?.type !== 'decision' || card.status !== 'open') return card;
      let audience = null;
      try { const v = publicSite.votesFor(card.id); audience = v.total > 0 ? v : null; } catch { audience = null; }
      return audience ? { ...card, audience } : card;
    });
    return { enabled: true, running: true, cards };
  });

  app.get('/api/arcs/claims', async (req, reply) => {
    const q = req.query || {};
    let status = 'tray';
    if (q.status !== undefined && q.status !== '') {
      if (!REVIEW_STATUSES.has(String(q.status))) return reply.code(400).send({ error: 'unknown review status' });
      status = String(q.status);
    }
    const lim = limitOf(q.limit, 50, CLAIMS_MAX);
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, claims: [] };
    const db = getDb();
    const rows = arr(read(c.story, 'tray', [{ status, limit: lim }], [])).slice(0, lim);
    return { enabled: true, running: true, claims: rows.map((r) => reviewOut(r, db)).filter(Boolean) };
  });

  app.get('/api/arcs/proposals', async (req, reply) => {
    const q = req.query || {};
    let status = null;
    if (q.status !== undefined && q.status !== '') {
      if (!PROPOSAL_STATUSES.has(String(q.status))) return reply.code(400).send({ error: 'unknown proposal status' });
      status = String(q.status);
    }
    const lim = limitOf(q.limit, 50, PROPOSALS_MAX);
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, proposals: [] };
    return { enabled: true, running: true, proposals: arr(read(c.story, 'proposals', [{ status, limit: lim }], [])).slice(0, lim) };
  });

  // 020 G: what he remembered of his nights, for the Mind page. Fictional names and kind words only.
  app.get('/api/arcs/dreams', async () => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, dreams: [] };
    return { enabled: true, running: true, dreams: arr(read(c.story, 'dreamsView', [{ limit: 30 }], [])) };
  });

  // 020 E3: the claim check's counts and last contradictions, read-only. Verdicts and codes; words only where no chat is behind them.
  app.get('/api/arcs/claim-checks', async (req) => {
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running };
    const days = Number(req.query?.days);
    let v = null;
    try { v = await read(c.story, 'claimChecksView', [{ days: Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30 }], null); } catch (err) {
      logger.warn({ evt: 'issue', where: 'dashboard.arcs', reader: 'claimChecksView', err: err?.name || 'Error' }, 'arcs: story reader failed');
    }
    return { enabled: true, running: true, ...(v ?? { ready: false }) };
  });

  app.get('/api/arcs/journal', async (req, reply) => {
    const q = req.query || {};
    let night = null;
    if (q.night !== undefined && q.night !== '') {
      if (!NIGHT_RE.test(String(q.night))) return reply.code(400).send({ error: 'night must be YYYY-MM-DD' });
      night = String(q.night);
    }
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, night, status: null, reason: null, parts: [] };
    const j = read(c.story, 'journal', [{ nightKey: night }], null);
    if (!j || typeof j !== 'object') return { enabled: true, running: true, night, status: null, reason: null, parts: [] };
    return { enabled: true, running: true, night: j.night ?? night, status: j.status ?? null, reason: j.reason ?? null, parts: arr(j.parts) };
  });

  app.get('/api/arcs/journal/nights', async (req) => {
    const lim = limitOf(req.query?.limit, 30, NIGHTS_MAX);
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, nights: [] };
    return { enabled: true, running: true, nights: arr(read(c.story, 'journalNights', [{ limit: lim }], [])).slice(0, lim) };
  });

  app.get('/api/arcs/refusals', async (req) => {
    const lim = limitOf(req.query?.limit, 100, REFUSALS_MAX);
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, refusals: [] };
    return { enabled: true, running: true, refusals: arr(read(c.story, 'refusals', [{ limit: lim }], [])).slice(0, lim) };
  });

  // ── Scenes (spec 016): read, regenerate, edit the text ─────────────────
  // REVERT THIS CHANGE is the life revert route on the scene.played event.

  app.get('/api/arcs/scenes/:id', async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad scene id' });
    const c = await storyContext();
    if (!c.enabled) return { enabled: false, running: c.running, scene: null };
    if (typeof c.story?.sceneDetail !== 'function') return { enabled: true, running: true, available: false, scene: null };
    const d = read(c.story, 'sceneDetail', [id], null);
    if (!d) return reply.code(404).send({ error: 'scene not found' });
    return { enabled: true, running: true, available: true, scene: sceneOut(d) };
  });

  app.post('/api/arcs/scenes/:id/regenerate', { config: SCENE_REGEN }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad scene id' });
    const body = bodyOf(req);
    const bp = bodyProblem(body);
    if (bp) return reply.code(400).send({ error: bp });
    let tone = null;
    if (body.tone !== undefined && body.tone !== null && body.tone !== '') {
      if (typeof body.tone !== 'string' || body.tone.length > SCENE_TONE_MAX) return reply.code(400).send({ error: 'bad tone' });
      tone = body.tone.trim() || null;
    }
    // R23: a tone carries its outcome word (well / fine / flat / badly), which sets the outcome.
    let outcome = null;
    if (body.outcome !== undefined && body.outcome !== null && body.outcome !== '') {
      if (!SCENE_OUTCOMES.has(body.outcome)) return reply.code(400).send({ error: 'bad outcome' });
      outcome = body.outcome;
    }
    if (tone && !outcome) return reply.code(400).send({ error: 'outcome_required' });
    const story = await writeGate(reply);
    if (!story) return reply;
    if (typeof story.sceneRegenerate !== 'function') return reply.code(409).send({ error: 'not_available' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.sceneRegenerate(id, { tone, outcome, by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.scene.regenerate');
    }
    // The facade answers a refusal (regen_cap, not_live, busy) or a failed model call (the old
    // version kept, nothing appended) in its result: a 409 with the code, nothing audited.
    if (res?.status !== 'done' && res?.status !== 'fallback') {
      return reply.code(409).send({ error: sCode(res?.reason) || sCode(res?.status) || 'failed', status: sCode(res?.status) });
    }
    const newId = sId(res?.sceneId);
    const version = sId(res?.version) ?? (newId ? sId(read(story, 'sceneDetail', [newId], null)?.version) : null);
    const out = { sceneId: newId, version, eventId: sId(res?.eventId), status: res.status };
    // ids, version and whether a hint was given (its length) — never the hint or the text.
    auditWrite(actor, 'arcs.scene.regenerate', String(id), { id, ...out, toneChars: tone ? tone.length : 0, outcome });
    return { ok: true, id, ...out };
  });

  app.put('/api/arcs/scenes/:id/text', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad scene id' });
    const text = bodyOf(req).text;
    if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'text is required' });
    if (text.length > SCENE_TEXT_LONG_MAX) return reply.code(400).send({ error: 'too_long' });
    if (JID_IN_TEXT_RE.test(text)) return reply.code(400).send({ error: 'jid_in_text' });
    const story = await writeGate(reply);
    if (!story) return reply;
    if (typeof story.sceneEditText !== 'function') return reply.code(409).send({ error: 'not_available' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.sceneEditText(id, text, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.scene.edit');
    }
    auditWrite(actor, 'arcs.scene.edit', String(id), { id, length: text.length });
    return { ok: true, id, length: Number.isSafeInteger(res?.length) ? res.length : text.trim().length };
  });

  // ── His phone (spec 019) ───────────────────────────────────────────────

  app.get('/api/arcs/phone', async (req, reply) => {
    const c = await phoneContext();
    if (!c.enabled) return { enabled: false, running: c.running, threads: [] };
    if (typeof c.story?.phoneThreads !== 'function') return reply.code(409).send({ error: 'not_available' });
    const list = arr(read(c.story, 'phoneThreads', [], [])).slice(0, PHONE_THREADS_MAX).map(phoneThreadRow).filter((t) => t.castId);
    return { enabled: true, running: true, threads: list };
  });

  app.get('/api/arcs/phone/:castId', async (req, reply) => {
    const castId = String(req.params.castId ?? '');
    if (!CAST_ID_RE.test(castId)) return reply.code(400).send({ error: 'bad cast id' });
    const rawBefore = req.query?.before;
    const before = rawBefore === undefined || rawBefore === '' ? null : toId(rawBefore);
    if (rawBefore !== undefined && rawBefore !== '' && !before) return reply.code(400).send({ error: 'bad before' });
    const lim = limitOf(req.query?.limit, PHONE_PAGE, PHONE_PAGE_MAX);
    const c = await phoneContext();
    if (!c.enabled) return { enabled: false, running: c.running, thread: null };
    if (typeof c.story?.phoneThread !== 'function') return reply.code(409).send({ error: 'not_available' });
    const t = read(c.story, 'phoneThread', [castId, { ...(before ? { before } : {}), limit: lim }], null);
    if (!t) return reply.code(404).send({ error: 'thread not found' });
    return {
      enabled: true, running: true,
      thread: { castId, name: str(t.name, 80) ?? '', departed: t.departed === true, messages: arr(t.messages).slice(-lim).map(phoneMessageOut).filter((m) => m.id) },
    };
  });

  app.put('/api/arcs/phone/messages/:id/text', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad message id' });
    const text = bodyOf(req).text;
    if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'text is required' });
    if (text.length > PHONE_TEXT_MAX) return reply.code(400).send({ error: 'too_long' });
    if (JID_IN_TEXT_RE.test(text)) return reply.code(400).send({ error: 'jid_in_text' });
    const story = await phoneWriteGate(reply);
    if (!story) return reply;
    if (typeof story.phoneEdit !== 'function') return reply.code(409).send({ error: 'not_available' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.phoneEdit(id, text, { by: actor });
    } catch (err) {
      return sendPhoneError(reply, err, 'arcs.phone.edit');
    }
    if (res && res.ok !== true && res.code) return sendPhoneError(reply, res, 'arcs.phone.edit');
    auditWrite(actor, 'arcs.phone.edit', String(id), { id, length: text.trim().length });
    return { ok: true, id };
  });

  app.post('/api/arcs/phone/messages/:id/regenerate', { config: PHONE_REGEN }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad message id' });
    const story = await phoneWriteGate(reply);
    if (!story) return reply;
    if (typeof story.phoneRegenerate !== 'function') return reply.code(409).send({ error: 'not_available' });
    const actor = actorOf(req);
    let res;
    try {
      res = await story.phoneRegenerate(id, { by: actor });
    } catch (err) {
      return sendPhoneError(reply, err, 'arcs.phone.regenerate');
    }
    if (res?.ok !== true) return sendPhoneError(reply, res?.code ? res : { code: 'failed' }, 'arcs.phone.regenerate');
    const newId = sId(res.id);
    auditWrite(actor, 'arcs.phone.regenerate', String(id), { id, newId });
    return { ok: true, id: newId ?? id };
  });

  // ── Ask-me cards (§2) ──────────────────────────────────────────────────

  app.post('/api/arcs/cards/:id/pick', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad decision id' });
    const optionId = bodyOf(req).optionId;
    if (typeof optionId !== 'string' || !OPTION_ID_RE.test(optionId)) return reply.code(400).send({ error: 'bad optionId' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.cardPick(id, optionId, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.card.pick');
    }
    auditWrite(actor, 'arcs.card.pick', String(id), { optionId, eventId: res?.eventId ?? null });
    return { ok: true, id, optionId, eventId: res?.eventId ?? null };
  });

  app.post('/api/arcs/cards/heavy/:proposedId/veto', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.proposedId);
    if (!id) return reply.code(400).send({ error: 'bad proposal id' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.heavyVeto(id, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.card.veto');
    }
    auditWrite(actor, 'arcs.card.veto', String(id), { eventId: res?.eventId ?? null });
    return { ok: true, proposedId: id, eventId: res?.eventId ?? null };
  });

  // ── Claim tray (§6) ────────────────────────────────────────────────────

  for (const [verb, fn, action] of [['reject', 'trayReject', 'arcs.claim.reject'], ['dismiss', 'trayDismiss', 'arcs.claim.dismiss']]) {
    app.post(`/api/arcs/claims/:id/${verb}`, { config: WRITE }, async (req, reply) => {
      const id = toId(req.params.id);
      if (!id) return reply.code(400).send({ error: 'bad review id' });
      const story = await writeGate(reply);
      if (!story) return reply;
      const actor = actorOf(req);
      let res;
      try {
        res = await story[fn](id, { by: actor });
      } catch (err) {
        return sendStoryError(reply, err, action);
      }
      auditWrite(actor, action, String(id), { reviewId: id, claimId: Number.isSafeInteger(res?.claimId) ? res.claimId : null });
      return { ok: true, id };
    });
  }

  // A pre-filled scene action draft (structured ids only); writes nothing, not audited.
  app.post('/api/arcs/claims/:id/scene', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad review id' });
    const story = await writeGate(reply);
    if (!story) return reply;
    try {
      const draft = await story.trayScene(id);
      return { ok: true, draft: { kind: 'scene', ...(draft && typeof draft === 'object' ? draft : {}) } };
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.claim.scene');
    }
  });

  app.post('/api/arcs/proposals/:id/reject', { config: WRITE }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad proposal id' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    try {
      await story.proposalReject(id, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.proposal.reject');
    }
    auditWrite(actor, 'arcs.proposal.reject', String(id), { proposalId: id });
    return { ok: true, id };
  });

  // ── Narration, journal, seed ───────────────────────────────────────────

  app.post('/api/arcs/narrate', { config: NARRATE }, async (req, reply) => {
    const body = bodyOf(req);
    const thought = body.thought === true;
    const hasEvent = body.eventId !== undefined && body.eventId !== null;
    if (thought === hasEvent) return reply.code(400).send({ error: 'send exactly one of {eventId} or {thought:true}' });
    let eventId = null;
    if (hasEvent) {
      eventId = toId(body.eventId);
      if (!eventId) return reply.code(400).send({ error: 'bad eventId' });
    }
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.narrate(thought ? { thought: true } : { eventId }, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.narrate');
    }
    const text = typeof res?.text === 'string' ? res.text : '';
    auditWrite(actor, 'arcs.narrate', eventId ? String(eventId) : 'thought', {
      eventId, thought, cached: res?.cached === true, chars: text.length,
    });
    return { ok: true, text, origins: arr(res?.origins).filter((o) => typeof o === 'string').slice(0, 12), cached: res?.cached === true };
  });

  app.post('/api/arcs/journal/:night/regenerate', { config: JOURNAL_REGEN }, async (req, reply) => {
    const night = String(req.params.night || '');
    if (!NIGHT_RE.test(night)) return reply.code(400).send({ error: 'night must be YYYY-MM-DD' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.journalRegenerate(night, { by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.journal.regenerate');
    }
    const status = typeof res?.status === 'string' ? res.status.slice(0, 20) : null;
    auditWrite(actor, 'arcs.journal.regenerate', night, { night, status, reason: typeof res?.reason === 'string' ? res.reason.slice(0, 40) : null });
    return { ok: true, night, status };
  });

  // Public site (spec 013, plan P4): PUBLISH freezes a night's SELF part (built from
  // self/owner events only) into the exporter's own table, scrubbed; chat parts are never
  // publishable. The journal stays readable only here — the exporter never reads it.
  app.post('/api/arcs/journal/:night/publish', { config: WRITE }, async (req, reply) => {
    const night = String(req.params.night || '');
    if (!NIGHT_RE.test(night)) return reply.code(400).send({ error: 'night must be YYYY-MM-DD' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const j = read(story, 'journal', [{ nightKey: night }], null);
    const self = arr(j?.parts).find((p) => p?.originKind === 'self' && p?.status === 'active' && typeof p.text === 'string' && p.text.trim());
    if (!j || j.night !== night || !self) return reply.code(409).send({ error: 'no publishable self part for that night' });
    const res = publicSite.publishJournal(night, self.text, actorOf(req));
    if (!res.ok) return reply.code(409).send({ error: 'refused', reason: String(res.reason || 'failed').slice(0, 24) });
    auditWrite(actorOf(req), 'public.journal.publish', night, { night, chars: self.text.length });
    return { ok: true, night };
  });

  app.post('/api/arcs/journal/:night/unpublish', { config: WRITE }, async (req, reply) => {
    const night = String(req.params.night || '');
    if (!NIGHT_RE.test(night)) return reply.code(400).send({ error: 'night must be YYYY-MM-DD' });
    const res = publicSite.unpublishJournal(night);
    if (!res.ok) return reply.code(404).send({ error: 'not published' });
    auditWrite(actorOf(req), 'public.journal.unpublish', night, { night });
    return { ok: true, night };
  });

  app.get('/api/arcs/journal/published', async () => ({
    nights: publicSite.journalPublished().map((j) => ({ night: j.night, publishedAt: j.publishedAt })),
  }));

  app.post('/api/arcs/seed/regenerate', { config: SEED_REGEN }, async (req, reply) => {
    if (bodyOf(req).confirm !== true) return reply.code(400).send({ error: 'confirm:true is required (never overwrites an existing arcs.json)' });
    const story = await writeGate(reply);
    if (!story) return reply;
    const actor = actorOf(req);
    let res;
    try {
      res = await story.seedRegenerate({ by: actor });
    } catch (err) {
      return sendStoryError(reply, err, 'arcs.seed.regenerate');
    }
    const status = typeof res?.status === 'string' ? res.status.slice(0, 20) : null;
    auditWrite(actor, 'arcs.seed.regenerate', null, { status, reason: typeof res?.reason === 'string' ? res.reason.slice(0, 40) : null });
    return { ok: true, status };
  });
}
