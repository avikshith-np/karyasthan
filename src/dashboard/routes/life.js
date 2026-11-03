// Life (spec 009 plan §C3): the Life·Now / Day / Timeline / Map pages' API.
//
// Reads need the normal session (the global cookie/basic-auth hook). Writes are
// owner operations on the life engine: the global readOnlyGuard (403 while
// DASHBOARD_READONLY=true) and csrfGuard (X-CSRF-Token = csrf_token cookie) run
// first, then a per-route rate limit (allowList: [] — the global limiter
// exempts loopback, which is exactly where the owner's tunnel lands), and every
// accepted write is recorded in dashboard_audit.
//
// Everything goes through the engine facade (src/life/index.js); the queue and
// claim listings are plain reads from their own modules. With the engine not
// running (life skill off at boot, or not wired yet) every read still answers
// 200 with an "off" shape and every write answers 409 — never a 500.
//
// The dashboard is the operator view: it sees every event whatever its origin
// (innerStateLine's {kind:'dashboard'} audience). Nothing here reaches a prompt.
// GET /api/life/day (Life · Day) is the facade's dayView plus counts this route
// reads itself: replies he sent and deferred/answered-later messages per chat
// (messages, life_queue; chat names, never text) and the mind's runs (kind and
// status from mind_runs, never model output).
// GET /api/life/wallet (Life · Wallet, spec 018 §B) is the facade's walletView:
// his balance, salary, the month's in/out by category and the money log.
// GET /api/life/alerts + dismiss + run (plan 020 E1) are the nightly sweep's findings (codes and
// code-built words; dashboard only). GET /api/life/thought-deed (F1) is what he leaned to vs what he did.
import { config } from '../../utils/config.js';
import { getDb } from '../../memory/db.js';
import { isSkillEnabled } from '../../skills/skillRunner.js';
import { auditWrite } from '../audit.js';
import * as life from '../../life/index.js';
import { EVENT_TYPES, getEvent, lastEventId } from '../../life/eventLog.js';
import { pendingChats } from '../../life/queue.js';
import { listClaims, countFlagged, getClaim } from '../../life/claims.js';
import { isActive as embargoActive } from '../../life/embargo.js';
import { dateKey } from '../../life/clock.js';
import { actorOf } from '../auth.js';

export const WRITE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } };
export const PHONE_LIMIT = { rateLimit: { max: 2, timeWindow: '1 minute', allowList: [] } };
export const SWEEP_RUN_LIMIT = { rateLimit: { max: 4, timeWindow: '1 minute', allowList: [] } };   // 020 E1: code only, cheap
// How long POST /api/life/phone/check waits for the check before answering 202.
export const PHONE_WAIT_MS = 4000;

// GET /api/life/day: today and tomorrow carry the projection (simulation runs;
// day.js also bounds and caches them) — 12/min, loopback not exempt. A past day
// is a plain log read and is not limited, so paging back never hits a 429.
export const DAY_LIMIT = { rateLimit: { max: 12, timeWindow: '1 minute', allowList: (req) => isPastDay(req.query?.date) } };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_CHAT_ROWS_MAX = 1000;
const DAY_MIND_KINDS = ['glance', 'think', 'sleep', 'selfmodel', 'draft'];
const DAY_BUCKET_SEC = 900;

export const CLAIM_STATUSES = new Set(['flagged', 'dismissed', 'adopted', 'rejected']);
export const DECISION_MODES = new Set(['auto', 'ask']);
const EVENTS_MAX = 200;
const CLAIMS_MAX = 100;
const NEXT_BLOCKS = 6;
const UPCOMING_SEC = 12 * 3600;   // sched-fixes: plans in the next 12 h, across midnight
const UPCOMING_MAX = 8;
const REASON_MAX = 200;
const DECISION_WINDOW_SEC = 24 * 3600;
const TIMELINE_MAX_SEC = 48 * 3600;
const QUEUE_CHATS_MAX = 50;
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(Date.now() / 1000);

/** A positive safe integer from a path/query value, else null. */
export function toId(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function toInt(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Owner free text for the log: one line, no control characters, capped. */
export function cleanReason(v, max = REASON_MAX) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function running() {
  try { return life.getState() !== null; } catch { return false; }
}

function enabledNow() {
  try { return life.isLifeOn(); } catch { return false; }
}

function skillOn() {
  try { return isSkillEnabled('life'); } catch { return false; }
}

function stateOrNull() {
  try { return life.getState(); } catch { return null; }
}

// 018 wallet: the facade's walletView, or a test stub (with whether life counts as running).
let walletTest = null;

/** Test seam: `{ view, running }` stands in for life.walletView / the engine; null restores the real ones. */
export function __setWalletForTest(stub) {
  walletTest = stub ? { view: stub.view, running: stub.running !== false } : null;
}

// The facade's rule (type list + state/time rules), so REVERT shows only where it would work.
const revertible = (ev) => life.isRevertible(ev);

/** Event → the dashboard's shape (payload kept: the operator sees everything). */
function eventOut(ev, excluded) {
  return {
    id: ev.id,
    at: ev.at,
    recordedAt: ev.recordedAt,
    type: ev.type,
    actor: ev.actor,
    causeId: ev.causeId,
    payload: ev.payload,
    originKind: ev.originKind,
    originJid: ev.originJid,
    subjectJid: ev.subjectJid,
    heavy: ev.heavy,
    redacted: ev.redacted,
    reverted: excluded ? excluded.has(ev.id) : false,
    revertible: revertible(ev),
  };
}

function excludedSet() {
  const s = stateOrNull();
  return s?.excluded instanceof Set ? s.excluded : new Set();
}

// Chat names for the queue panel (dashboard routes may read these tables directly).
function chatName(db, jid) {
  try {
    if (jid.endsWith('@g.us')) {
      return db.prepare('SELECT name FROM groups WHERE jid = ?').get(jid)?.name || null;
    }
    const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(jid);
    return p?.real_name || p?.push_name || null;
  } catch {
    return null;
  }
}

function queueByChat() {
  let rows = [];
  try { rows = pendingChats(); } catch { return []; }
  const db = getDb();
  return rows.slice(0, QUEUE_CHATS_MAX).map((r) => ({
    chatJid: r.chatJid,
    name: chatName(db, r.chatJid),
    count: r.count,
    oldestAt: r.oldestAt,
    newestAt: r.newestAt,
    mentions: r.mentions || 0,
    dms: r.dms || 0,
  }));
}

function placeName(state, id) {
  if (!id || !(state?.places instanceof Map)) return null;
  return state.places.get(id)?.name ?? null;
}

function decisionOut(d, state) {
  const opts = Array.isArray(d.options) ? d.options : [];
  const label = (id) => opts.find((o) => o.id === id)?.label ?? id;
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    mode: d.mode,
    opensAt: d.opensAt ?? null,
    decideBy: d.decideBy ?? null,
    ponrAt: d.ponrAt ?? null,
    closedAt: d.closedAt ?? null,
    subject: d.subject ? {
      eventAt: d.subject.eventAt ?? null,
      placeId: d.subject.placeId ?? null,
      place: placeName(state, d.subject.placeId),
      cast: (d.subject.castIds || []).map((id) => state?.cast?.get?.(id)?.name ?? id),
    } : null,
    options: opts.map((o) => ({ id: o.id, label: o.label, expiresAt: o.expiresAt ?? null })),
    lean: d.lean ? { optionId: d.lean.optionId, label: label(d.lean.optionId), p: d.lean.p ?? null } : null,
    committed: d.committed ? { optionId: d.committed.optionId, label: label(d.committed.optionId), at: d.committed.at ?? null } : null,
    reversals: d.reversals ?? 0,
  };
}

/**
 * sched-fixes: his open / committed plans whose time falls in the next 12 h
 * (midnight included), whether or not today's plan blocks hold them yet.
 */
function upcomingOf(state, at, blocks) {
  if (!(state?.decisions instanceof Map)) return [];
  const list = Array.isArray(blocks) ? blocks : [];
  const stamped = new Set(list.map((b) => b?.decisionId).filter(Number.isSafeInteger));
  // In the plan: a block stamped with it (a locked outing), the plan amended for it (009's
  // outing amendment stamps no block), or a stay at its place over its start.
  const inPlanOf = (d) => stamped.has(d.id) || state.plan?.amendedFor === d.id
    || list.some((b) => b?.kind !== 'commute' && b?.placeId && b.placeId === d.subject?.placeId && b.start <= d.subject.eventAt && d.subject.eventAt < b.end);
  return [...state.decisions.values()]
    .filter((d) => (d.status === 'open' || d.status === 'committed') && finite(d.subject?.eventAt)
      && d.subject.eventAt + 3600 > at && d.subject.eventAt < at + UPCOMING_SEC)
    .sort((a, b) => a.subject.eventAt - b.subject.eventAt).slice(0, UPCOMING_MAX)
    .map((d) => {
      const opts = Array.isArray(d.options) ? d.options : [];
      const go = opts.find((o) => o.id === 'go');
      const end = opts.find((o) => o.id === 'late')?.expiresAt;
      return {
        id: d.id, kind: d.kind ?? null, status: d.status, label: typeof go?.label === 'string' ? go.label.slice(0, 80) : (d.kind ?? 'plan'),
        start: d.subject.eventAt, end: finite(end) && end > d.subject.eventAt ? end : null,
        placeId: d.subject.placeId ?? null, place: placeName(state, d.subject.placeId),
        committed: d.committed?.optionId ?? null, inPlan: inPlanOf(d),
      };
    });
}

function decisionsOf(state, at) {
  if (!(state?.decisions instanceof Map)) return [];
  return [...state.decisions.values()]
    .filter((d) => d.status === 'open' || d.status === 'committed' || (finite(d.closedAt) && d.closedAt >= at - DECISION_WINDOW_SEC))
    .sort((a, b) => (b.opensAt ?? 0) - (a.opensAt ?? 0))
    .map((d) => decisionOut(d, state));
}

/** Is `date` a day before his today (world timezone)? Only then is the Day read projection-free. */
function isPastDay(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const s = stateOrNull();
  if (!s) return true;            // not running: nothing to project
  try { return date < dateKey(s.viewAt ?? nowSec(), s.world?.timezone); } catch { return false; }
}

function personName(db, jid) {
  if (typeof jid !== 'string' || !jid) return null;
  try {
    const p = db.prepare('SELECT real_name, push_name FROM people WHERE jid = ?').get(jid);
    return p?.real_name || p?.push_name || null;
  } catch {
    return null;
  }
}

/**
 * Chat activity for the Day page, per chat and 15-min bucket: replies he sent
 * (messages.is_from_self, reactions left out), messages the gate deferred
 * (life_queue.enqueued_at) and deferred ones answered later (drained_at).
 * Counts and chat names only, never message text.
 */
function dayChats(db, from, to) {
  const rows = new Map();
  const bump = (jid, at, field) => {
    const b = Math.floor(at / DAY_BUCKET_SEC) * DAY_BUCKET_SEC;
    const k = `${jid}|${b}`;
    if (!rows.has(k)) {
      if (rows.size >= DAY_CHAT_ROWS_MAX) return;
      rows.set(k, { at: b, chatJid: jid, sent: 0, deferred: 0, answered: 0 });
    }
    rows.get(k)[field] += 1;
  };
  try {
    for (const r of db.prepare(`SELECT group_jid AS jid, timestamp AS at FROM messages
      WHERE is_from_self = 1 AND timestamp >= ? AND timestamp < ? AND COALESCE(message_type, 'text') <> 'reaction'
      ORDER BY timestamp LIMIT 5000`).all(from, to)) bump(r.jid, r.at, 'sent');
  } catch { /* table missing on an old schema */ }
  try {
    for (const r of db.prepare('SELECT chat_jid AS jid, enqueued_at AS at FROM life_queue WHERE enqueued_at >= ? AND enqueued_at < ? LIMIT 5000').all(from, to)) bump(r.jid, r.at, 'deferred');
    for (const r of db.prepare(`SELECT chat_jid AS jid, drained_at AS at FROM life_queue
      WHERE status = 'drained' AND drained_at >= ? AND drained_at < ? LIMIT 5000`).all(from, to)) bump(r.jid, r.at, 'answered');
  } catch { /* table missing */ }
  const names = new Map();
  const nameOf = (jid) => { if (!names.has(jid)) names.set(jid, chatName(db, jid)); return names.get(jid); };
  return [...rows.values()].sort((a, b) => a.at - b.at)
    .map((r) => ({ ...r, name: nameOf(r.chatJid), dm: !r.chatJid.endsWith('@g.us') }));
}

/** The mind's runs that day (kinds, statuses and code reasons only). */
function dayMind(db, from, to) {
  try {
    return db.prepare(`SELECT id, kind, status, trigger, skip_reason AS skipReason, started_at AS at, finished_at AS endAt
      FROM mind_runs WHERE started_at >= ? AND started_at < ? AND kind IN (${DAY_MIND_KINDS.map(() => '?').join(', ')})
      ORDER BY started_at LIMIT 300`).all(from, to, ...DAY_MIND_KINDS);
  } catch {
    return [];
  }
}

/** Map tile settings for the page: config.life.mapTileUrl ('' = no tiles). */
function tileInfo() {
  const url = config.life?.mapTileUrl || '';
  const osm = /(^|\.)openstreetmap\.org\//i.test(url.replace(/^https?:\/\//i, ''));
  return { tileUrl: url || null, attribution: url ? (osm ? OSM_ATTRIBUTION : 'Map tiles: see LIFE_MAP_TILE_URL') : null };
}

/** /api/status's life field (also used by tests). Never throws. */
export function lifeStatus() {
  const s = stateOrNull();
  const avail = s?.availability || null;
  return {
    enabled: enabledNow(),
    skill: skillOn(),
    running: !!s,
    availability: avail?.state ?? null,
    until: avail?.until ?? null,
    onPhone: !!avail?.onPhone,
    activity: s?.activity?.kind ?? null,
    alerts: s ? life.alertsCount() : 0,   // 020 E1: open sweep findings (the topbar badge)
  };
}

export default async function lifeRoutes(app) {
  // ── Reads ────────────────────────────────────────────────────────────────

  app.get('/api/life/now', async () => {
    const s = stateOrNull();
    const at = s?.viewAt ?? nowSec();
    let claimsFlagged = 0;
    try { claimsFlagged = countFlagged(); } catch { /* table missing on an old schema */ }
    if (!s) {
      return {
        enabled: false, skill: skillOn(), running: false, worldSource: null, timezone: null, at,
        activity: null, position: null, vitals: null, availability: null, phone: null, weather: null,
        queue: { byChat: queueByChat() }, next: [], upcoming: [], thought: '', embargo: null, decisions: [], claimsFlagged,
        urge: null,
      };
    }
    let thought = '';
    try { thought = life.innerStateLine({ kind: 'dashboard' }, { overBudget: false }) || ''; } catch { thought = ''; }
    const blocks = Array.isArray(s.plan?.blocks) ? s.plan.blocks : [];
    const next = blocks
      .filter((b) => finite(b.end) && b.end > at)
      .slice(0, NEXT_BLOCKS)
      .map((b) => ({ kind: b.kind, placeId: b.placeId ?? null, place: placeName(s, b.placeId), start: b.start, end: b.end, availability: b.availability ?? null }));
    const pos = s.position || {};
    const act = s.activity || {};
    return {
      enabled: enabledNow(),
      skill: skillOn(),
      running: true,
      worldSource: s.world?.source ?? null,
      timezone: s.world?.timezone ?? null,
      at,
      age: s.self?.age ?? null,
      activity: {
        kind: act.kind ?? null, placeId: act.placeId ?? null, place: placeName(s, act.placeId),
        startAt: act.startAt ?? null, endAt: act.endAt ?? null, eventId: act.eventId ?? null,
        withCast: (act.withCast || []).map((id) => s.cast?.get?.(id)?.name ?? id),
      },
      position: {
        placeId: pos.placeId ?? null, place: placeName(s, pos.placeId), lat: pos.lat ?? null, lon: pos.lon ?? null,
        travelling: !!pos.travelling || !!pos.travel,
        travel: pos.travel ? {
          from: pos.travel.from ?? null, to: pos.travel.to ?? null, fromName: placeName(s, pos.travel.from), toName: placeName(s, pos.travel.to),
          mode: pos.travel.mode ?? null, startAt: pos.travel.startAt ?? null, endAt: pos.travel.endAt ?? null,
        } : null,
      },
      vitals: s.vitals ?? null,
      availability: s.availability ? {
        state: s.availability.state ?? null, since: s.availability.since ?? null,
        until: s.availability.until ?? null, onPhone: !!s.availability.onPhone,
      } : null,
      phone: s.phone ? {
        lastCheckAt: s.phone.lastCheckAt ?? null, checkStartedAt: s.phone.checkStartedAt ?? null,
        checkUntil: s.phone.checkUntil ?? null, lastCheckEndAt: s.phone.lastCheckEndAt ?? null,
        nextCheckAt: s.phone.nextCheckAt ?? null,
      } : null,
      weather: s.weather ?? null,
      queue: { byChat: queueByChat() },
      next,
      upcoming: upcomingOf(s, at, blocks),
      thought,
      embargo: s.embargo && embargoActive(s.embargo, at) ? { until: s.embargo.until ?? null, eventId: s.embargo.eventId ?? null } : null,
      decisions: decisionsOf(s, at),
      claimsFlagged,
      urge: (() => { try { return life.urgeNow(); } catch { return null; } })(),
    };
  });

  app.get('/api/life/timeline', async (req, reply) => {
    const q = req.query || {};
    const to = toInt(q.to, nowSec());
    const from = toInt(q.from, to - 24 * 3600);
    if (from >= to) return reply.code(400).send({ error: 'from must be before to' });
    if (to - from > TIMELINE_MAX_SEC) return reply.code(400).send({ error: 'window is at most 48 h' });
    const s = stateOrNull();
    let tl;
    try { tl = life.timeline({ from, to }); } catch { tl = { from, to, planned: [], actual: [], decisions: [], links: [], orphaned: [] }; }
    const name = (id) => placeName(s, id);
    return {
      running: !!s,
      timezone: s?.world?.timezone ?? null,
      from: tl.from,
      to: tl.to,
      planned: tl.planned.map((b) => ({ ...b, place: name(b.placeId) })),
      actual: tl.actual.map((b) => ({ ...b, place: name(b.placeId) })),
      decisions: tl.decisions,
      links: tl.links,
      orphaned: tl.orphaned || [],
    };
  });

  // 014 map (plan §B.3): ?date=YYYY-MM-DD → that local day; none → the last
  // 48 h plus the rest of today's planned trips. Trips may carry `pts` (road
  // geometry by data contract), place rows `area` / `venue`, and home is an area.
  // 020 H2: today's lines beside the bank's, for the owner to judge before the switch. Read only; no chat text is in either.
  app.get('/api/life/phrases', async (req, reply) => {
    const { bank = 'thought', q = '', only = '' } = req.query ?? {};
    if (!['thought', 'live', 'dream'].includes(bank)) return reply.code(400).send({ error: 'bad_bank' });
    if (typeof q !== 'string' || q.length > 60) return reply.code(400).send({ error: 'bad_q' });
    if (!['', 'voiced', 'english'].includes(only)) return reply.code(400).send({ error: 'bad_only' });
    const offset = req.query?.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query?.limit === undefined ? 40 : Number(req.query.limit);
    if (!(Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000) || !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)) return reply.code(400).send({ error: 'bad_page' });
    return life.phraseBankView({ bank, q, only: only || null, offset, limit });
  });

  // 020 F2: the thought stream, one local day (default today), or today's newest `limit`. Dashboard only.
  app.get('/api/life/thoughts', async (req, reply) => {
    const date = req.query?.date;
    if (date !== undefined && date !== '' && (typeof date !== 'string' || !DATE_RE.test(date))) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    const lim = req.query?.limit;
    const limit = lim === undefined ? null : Number(lim);
    if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200)) return reply.code(400).send({ error: 'limit must be 1..200' });
    try {
      return life.thoughtsView({ date: date || null, limit });
    } catch (err) {
      if (err instanceof life.ThoughtDeedError) return reply.code(400).send({ error: err.code });
      throw err;
    }
  });

  // 020 C2: the live outing. Read only, from the log; an off shape while the engine isn't running.
  app.get('/api/life/live', async () => life.liveSession({}));

  app.get('/api/life/map', async (req, reply) => {
    const tiles = tileInfo();
    const q = req.query || {};
    let date = null;
    if (q.date !== undefined && q.date !== '') {
      if (typeof q.date !== 'string' || !DATE_RE.test(q.date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
      date = q.date;
    }
    const off = { running: false, date, places: [], position: null, trips: [], home: null, ...tiles };
    const s = stateOrNull();
    if (!s) return off;
    let m;
    try {
      m = life.mapView({ date });
    } catch (err) {
      if (err?.name === 'MapError') return reply.code(400).send({ error: 'bad date' });
      return off;
    }
    return { running: true, date, from: m.from, to: m.to, places: m.places, position: m.position, trips: m.trips, home: m.home, ...tiles };
  });

  // 018 wallet (plan §B): ?month=YYYY-MM → that local month; none → this month.
  // Engine stopped → the off shape; a facade without walletView (this page
  // merged before the engine half) → 409 not_available.
  // 020 E1: the sweep's findings. 200 with an off shape while the engine isn't running, like every life read.
  app.get('/api/life/alerts', async () => life.alertsView());

  // 020 D3: what he said he'd do. Read-only, code-built, nothing stored; no JID on a row.
  app.get('/api/life/commitments', async () => life.commitmentsView());

  // 020 F1: thought vs deed, one local day (default today). No model call, nothing stored.
  app.get('/api/life/thought-deed', async (req, reply) => {
    const date = req.query?.date;
    if (date !== undefined && date !== '' && (typeof date !== 'string' || !DATE_RE.test(date))) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    try {
      return life.thoughtDeed({ date: date || null });
    } catch (err) {
      if (err instanceof life.ThoughtDeedError) return reply.code(400).send({ error: err.code });
      throw err;
    }
  });

  app.get('/api/life/wallet', async (req, reply) => {
    const q = req.query || {};
    let month = null;
    if (q.month !== undefined && q.month !== '') {
      if (typeof q.month !== 'string' || !MONTH_RE.test(q.month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
      month = q.month;
    }
    const isRunning = walletTest ? walletTest.running : running();
    if (!isRunning) return { running: false, skill: skillOn(), month };
    const view = walletTest ? walletTest.view : life.walletView;
    if (typeof view !== 'function') return reply.code(409).send({ error: 'not_available' });
    let w;
    try {
      w = await view({ month: month ?? undefined });
    } catch (err) {
      if (err?.name === 'WalletError') {
        return reply.code(err.code === 'out_of_range' ? 404 : 400).send({ error: err.code === 'out_of_range' ? 'no such month in his life' : 'bad month' });
      }
      req.log?.warn?.({ err: err?.message }, 'life: wallet view failed');
      return reply.code(500).send({ error: 'wallet view failed' });
    }
    if (!w) return { running: false, skill: skillOn(), month };
    return { ...w, running: true, enabled: enabledNow() };
  });

  app.get('/api/life/day', { config: DAY_LIMIT }, async (req, reply) => {
    const q = req.query || {};
    let date = null;
    if (q.date !== undefined && q.date !== '') {
      if (typeof q.date !== 'string' || !DATE_RE.test(q.date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
      date = q.date;
    }
    let view;
    try {
      view = await life.dayView({ date });
    } catch (err) {
      if (err?.name === 'DayError') {
        return reply.code(err.code === 'out_of_range' ? 404 : 400).send({ error: err.code === 'out_of_range' ? 'no such day in his life (genesis … tomorrow)' : 'bad date' });
      }
      req.log?.warn?.({ err: err?.message }, 'life: day view failed');
      return reply.code(500).send({ error: 'day view failed' });
    }
    if (!view) return { running: false, skill: skillOn(), date };
    const db = getDb();
    const subjects = new Map();
    const withSubject = (r) => {
      if (!r.subjectJid) return r;
      if (!subjects.has(r.subjectJid)) subjects.set(r.subjectJid, personName(db, r.subjectJid));
      return { ...r, subject: subjects.get(r.subjectJid) };
    };
    const pastEnd = Math.min(view.to, view.at);
    return {
      running: true,
      enabled: enabledNow(),
      ...view,
      past: { ...view.past, spans: view.past.spans.map(withSubject), ticks: view.past.ticks.map(withSubject) },
      chats: pastEnd > view.from ? dayChats(db, view.from, pastEnd) : [],
      mind: pastEnd > view.from ? dayMind(db, view.from, pastEnd) : [],
    };
  });

  app.get('/api/life/events', async (req, reply) => {
    const q = req.query || {};
    const limit = Math.min(EVENTS_MAX, Math.max(1, toInt(q.limit, 100)));
    const opts = { limit, order: 'desc' };
    if (q.before !== undefined && q.before !== '') {
      const b = toId(q.before);
      if (!b) return reply.code(400).send({ error: 'before must be an event id' });
      opts.before = b;
    }
    if (q.from !== undefined && q.from !== '') opts.from = toInt(q.from, null);
    if (q.to !== undefined && q.to !== '') opts.to = toInt(q.to, null);
    if (opts.from === null || opts.to === null) return reply.code(400).send({ error: 'from/to must be unix seconds' });
    if (q.type !== undefined && q.type !== '') {
      const types = [...new Set(String(q.type).split(',').map((t) => t.trim()).filter(Boolean))];
      if (types.length > 20 || types.some((t) => !EVENT_TYPES.has(t))) return reply.code(400).send({ error: 'unknown event type' });
      opts.types = types;
    }
    // Always page in id order (newest first): world time is not monotone in id,
    // so an (at, id) first page followed by id-cursor pages could skip events.
    if (opts.before === undefined) {
      try { opts.before = lastEventId() + 1; } catch { return { events: [], nextBefore: null }; }
    }
    let rows;
    try { rows = life.listEvents(opts); } catch { return reply.code(400).send({ error: 'bad event query' }); }
    const excluded = excludedSet();
    const events = rows.map((ev) => eventOut(ev, excluded));
    return { events, nextBefore: events.length === limit ? events[events.length - 1].id : null };
  });

  app.get('/api/life/events/:id/explain', async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad event id' });
    const chain = life.explain(id);
    if (!chain.length) return reply.code(404).send({ error: 'event not found' });
    const excluded = excludedSet();
    return { id, chain: chain.map((ev) => eventOut(ev, excluded)) };
  });

  app.get('/api/life/decisions', async () => {
    const s = stateOrNull();
    return { running: !!s, decisions: s ? decisionsOf(s, s.viewAt ?? nowSec()) : [] };
  });

  app.get('/api/life/claims', async (req, reply) => {
    const q = req.query || {};
    let status = null;
    if (q.status !== undefined && q.status !== '') {
      if (!CLAIM_STATUSES.has(String(q.status))) return reply.code(400).send({ error: 'unknown claim status' });
      status = String(q.status);
    }
    const limit = Math.min(CLAIMS_MAX, Math.max(1, toInt(q.limit, 50)));
    let claims = [];
    try { claims = listClaims({ status, limit }); } catch { claims = []; }
    return { claims };
  });

  // ── Writes (readonly + CSRF are global preHandlers; limits + audit here) ──

  const notRunning = (reply) => reply.code(409).send({ error: 'life is not running' });

  app.post('/api/life/events/:id/revert', { config: WRITE_LIMIT }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad event id' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.reason !== undefined && typeof body.reason !== 'string') return reply.code(400).send({ error: 'reason must be text' });
    if (typeof body.reason === 'string' && body.reason.length > REASON_MAX) return reply.code(400).send({ error: `reason is at most ${REASON_MAX} characters` });
    const reason = cleanReason(body.reason);
    if (!running()) return notRunning(reply);
    const target = getEvent(id);
    if (!target) return reply.code(404).send({ error: 'event not found' });
    if (!revertible(target)) return reply.code(409).send({ error: `${target.type} cannot be reverted` });
    const actor = actorOf(req);
    let res;
    try {
      res = life.revertEvent(id, { reason, by: actor });
    } catch (err) {
      return reply.code(409).send({ error: /cannot be reverted|not running/.test(err?.message || '') ? err.message : 'revert refused' });
    }
    auditWrite(actor, 'life.revert', String(id), { type: target.type, reason, revertEventId: res.revertEventId, already: res.already });
    return { ok: true, revertEventId: res.revertEventId, already: res.already };
  });

  app.post('/api/life/decisions/:id/mode', { config: WRITE_LIMIT }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad decision id' });
    const mode = req.body?.mode;
    if (typeof mode !== 'string' || !DECISION_MODES.has(mode)) return reply.code(400).send({ error: "mode must be 'auto' or 'ask'" });
    const s = stateOrNull();
    if (!s) return notRunning(reply);
    const d = s.decisions?.get?.(id);
    if (!d) return reply.code(404).send({ error: 'decision not found' });
    if (d.status !== 'open') return reply.code(409).send({ error: 'decision is no longer open' });
    const actor = actorOf(req);
    try {
      life.setDecisionMode(id, mode, { by: actor });
    } catch {
      return reply.code(409).send({ error: 'mode change refused' });
    }
    auditWrite(actor, 'life.decision.mode', String(id), { mode, previous: d.mode ?? null });
    return { ok: true, id, mode };
  });

  app.post('/api/life/claims/:id/dismiss', { config: WRITE_LIMIT }, async (req, reply) => {
    const id = toId(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad claim id' });
    if (!running()) return notRunning(reply);
    const claim = getClaim(id);
    if (!claim) return reply.code(404).send({ error: 'claim not found' });
    const actor = actorOf(req);
    const ok = life.dismissClaim(id, { by: actor });
    if (!ok) return reply.code(409).send({ error: 'claim is not flagged' });
    auditWrite(actor, 'life.claim.dismiss', String(id), { kind: claim.kind ?? null });
    return { ok: true, id };
  });

  // 020 E1: dismiss one finding; it doesn't come back. Audited with its fingerprint and rule only.
  app.post('/api/life/alerts/:fp/dismiss', { config: WRITE_LIMIT }, async (req, reply) => {
    const fp = String(req.params.fp ?? '');
    if (!/^[0-9a-f]{32}$/.test(fp)) return reply.code(400).send({ error: 'bad finding id' });
    if (!running()) return notRunning(reply);
    const actor = actorOf(req);
    const r = life.dismissAlert(fp, { by: actor });
    if (!r.ok) return reply.code(r.code === 'not_found' ? 404 : 409).send({ error: r.code });
    auditWrite(actor, 'life.alert.dismiss', fp, { rule: r.rule });
    return { ok: true, fp };
  });

  // 020 E1: a sweep now, over its longest window.
  app.post('/api/life/alerts/run', { config: SWEEP_RUN_LIMIT }, async (req, reply) => {
    if (!running()) return notRunning(reply);
    const r = life.runSweepNow();
    if (!r.ok) return reply.code(409).send({ error: r.code });
    auditWrite(actorOf(req), 'life.alert.run', 'sweep', { count: r.count });
    return r;
  });

  // A check keeps him on the phone for 1–4 min after the drain: the request
  // waits at most a few seconds for a quick answer (skipped, or a short check),
  // then answers 202 while the check carries on (its outcome is in the logs and
  // on the Now page).
  app.post('/api/life/phone/check', { config: PHONE_LIMIT }, async (req, reply) => {
    if (!running()) return notRunning(reply);
    if (life.isPhoneInCheck?.()) return reply.code(409).send({ error: 'a phone check is already running', skipped: 'in_check' });
    const actor = actorOf(req);
    let check;
    try {
      check = Promise.resolve(life.checkPhoneNow({ by: actor }));
    } catch {
      return reply.code(409).send({ error: 'phone check refused' });
    }
    check.then(
      (r) => req.log?.info?.({ drained: r?.drained ?? 0, skipped: r?.skipped ?? null }, 'life: owner phone check finished'),
      (err) => req.log?.warn?.({ err: err?.message }, 'life: owner phone check failed'),
    );
    let timer;
    const PENDING = Symbol('pending');
    let res;
    try {
      res = await Promise.race([check, new Promise((resolve) => { timer = setTimeout(resolve, PHONE_WAIT_MS, PENDING); })]);
    } catch {
      clearTimeout(timer);
      return reply.code(409).send({ error: 'phone check refused' });
    }
    clearTimeout(timer);
    if (res === PENDING) {
      auditWrite(actor, 'life.phone.check', null, { started: true });
      return reply.code(202).send({ ok: true, started: true, drained: null, skipped: null });
    }
    auditWrite(actor, 'life.phone.check', null, { drained: res.drained, skipped: res.skipped, readOnly: res.readOnly === true });
    return { ok: !res.skipped, drained: res.drained, skipped: res.skipped, readOnly: res.readOnly === true };
  });
}
