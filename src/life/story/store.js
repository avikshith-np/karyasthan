// Story store (spec 010, data-model.md §1 "Migration v11", contracts/story-api.md §2)
// — the ONLY door to the story_* tables. Every function is synchronous
// (better-sqlite3) and takes/returns plain objects: rows come back camelCase with
// every *_json column parsed under its name without the suffix (extraction_json →
// extraction, sources_json → sources, …).
//
// SQL is static: every statement is a literal string with `?` parameters, list
// filters go through json_each(?) with a JSON-encoded array, and no column name or
// fragment is ever built from input (test 18 greps this file for interpolation).
// Writes go through per-table allow-lists: an unknown field, a bad enum value or an
// oversized JSON body throws (fail closed) instead of being stored.
//
// Strings that can reach a page (journal and narration text, reasons) pass the
// world.js str() rules before storage: sanitizeWebContent, collapsed to one line,
// ">>>" stripped, capped. Nothing here logs; callers log ids, counts and reasons only.
//
// The only non-story table read here is 009's life_claims (ids only, for the
// reconciler's boot sweep). Times are unix seconds from the life clock
// (src/life/clock.js now(), which tests replace with setClock).

import { getDb } from '../../memory/db.js';
import { sanitizeWebContent } from '../../brain/webSearch.js';
import { now } from '../clock.js';

const HOUR = 3600;
const DAY = 86400;

// ── enums (data-model.md §1) ─────────────────────────────────────────────────

export const REVIEW_STATUSES = Object.freeze(['pending', 'extracting', 'adopted', 'tray', 'rejected', 'dismissed', 'expired',
  'withdrawn', 'returned', 'failed']);
export const REVIEW_REASONS = Object.freeze(['out_of_scope', 'out_of_window', 'unknown_place', 'ambiguous_place',
  'unknown_person', 'ambiguous_person', 'multi_person', 'conflict', 'blocked', 'cap', 'not_extracted', 'review_mode',
  'invalid_extraction', 'rewound', 'owner']);
// A review in one of these states is decided: it is pruned 180 days after decided_at.
export const REVIEW_DECIDED = Object.freeze(['adopted', 'rejected', 'dismissed', 'expired', 'withdrawn', 'returned', 'failed']);
export const REVIEW_ORIGIN_KINDS = Object.freeze(['group', 'dm']);
export const RUN_KINDS = Object.freeze(['weekly', 'seed', 'extract', 'journal', 'narrate', 'appraisal']);
export const RUN_STATUSES = Object.freeze(['running', 'ok', 'skipped', 'invalid', 'failed', 'partial']);
export const SKIP_REASONS = Object.freeze(['budget', 'caller_cap', 'cap_hour', 'cap_day', 'paused', 'disabled', 'not_due',
  'unpriced', 'no_key']);
export const STORY_CATEGORIES = Object.freeze(['romance', 'career', 'family', 'cast', 'health', 'social', 'heavy']);
export const PROPOSAL_KINDS = Object.freeze(['beat', 'new_cast', 'new_place', 'arc_decision', 'heavy_nomination']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'applied', 'rejected', 'refused', 'expired']);
export const NIGHT_STATUSES = Object.freeze(['running', 'done', 'partial', 'skipped', 'failed', 'missed']);
export const NIGHT_REASONS = Object.freeze(['budget', 'cap', 'nothing', 'disabled', 'downtime']);
export const PART_ORIGIN_KINDS = Object.freeze(['self', 'group', 'dm']);
export const PART_STATUSES = Object.freeze(['active', 'undone', 'fenced']);
export const NARRATION_KINDS = Object.freeze(['event', 'thought']);
export const REFUSAL_SOURCES = Object.freeze(['engine', 'mind', 'reconciler', 'owner']);
export const REFUSAL_ACTIONS = Object.freeze(['start', 'beat', 'decision', 'adopt', 'change', 'new_cast', 'heavy']);
export const REFUSAL_REASONS = Object.freeze(['paused', 'frozen', 'pinned', 'guided', 'cap', 'forbidden', 'name_collision',
  'region', 'lead_time', 'invalid']);
export const STATE_KEYS = Object.freeze(['last_weekly_at', 'last_weekly_run', 'seed', 'extract_counters', 'degraded',
  'scenes_cursor',   // 016: the last world_events id the scene detector scanned
  'scenes_on',       // 016: were the scenes on at the last job (R24: an off → on re-seeds the cursor)
  'phone_cursor',    // 019: the last world_events id the phone's trigger scan read
  'phone_on',        // 019: was the phone on at the last job (an off → on re-seeds the cursor)
  'phone_rolled',    // 019: the local date whose texts out of the blue were last rolled
  'phone_bond_rolled',    // 019 (2026-11-01): 'YYYY-MM-DD|w,w' — the day's windows a bond already rolled
  'sweep_findings',       // 020 E1: the nightly sweep's last run + its findings (derived: a re-run rebuilds them)
  'sweep_dismissed',      // 020 E1: the fingerprints the owner dismissed
  'phone_plan_outcomes',   // 020 E1: what the plan step decided on recent texts (the sweep's text_plan)
  'phone_plan_held']);     // agreements in texts still short of a detail, per member: codes only

// Limits (data-model.md §1, §6).
export const LIMITS = Object.freeze({
  reviewJson: 2048,          // extraction_json, resolution_json, conflict_json
  runJson: 8192,             // input_json, output_json, dropped_json
  proposalJson: 8192,
  refusalDetail: 1024,
  stateJson: 4096,
  partSelfChars: 600,
  partChatChars: 240,
  narrationChars: 400,
  sourceIds: 200,            // ids per sources list
  refusalDedupeSec: HOUR,
  proposalPendingDays: 14,
  narrationEventTtlSec: 30 * DAY,
  narrationThoughtTtlSec: HOUR,
  defaultTrayHours: 72,
});

// Retention (data-model.md §6). Journal parts are kept (the owner's diary) until purge/forget.
export const RETENTION_DAYS = Object.freeze({ runs: 180, refusals: 90, proposals: 90, reviews: 180 });

// ── small helpers ────────────────────────────────────────────────────────────

const stmtCache = new WeakMap();
/** A cached prepared statement for this connection. `sql` is always a literal. */
function q(sql) {
  const db = getDb();
  let cache = stmtCache.get(db);
  if (!cache) { cache = new Map(); stmtCache.set(db, cache); }
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  return st;
}

const nowSec = () => Math.floor(now());
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(msg) {
  throw new TypeError('story store: ' + msg);
}

function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function int(v, name, { required = false, min = -Infinity } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(name + ' is required');
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(Math.floor(n))) fail(name + ' must be a finite number');
  const f = Math.floor(n);
  if (f < min) fail(name + ' must be >= ' + min);
  return f;
}

function real(v, name) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(name + ' must be a finite number');
  return n;
}

function oneOf(v, values, name, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(name + ' is required');
    return null;
  }
  if (!values.includes(v)) fail(name + ' must be one of ' + values.join('|'));
  return v;
}

/** Short identifier-like text (jids, callers, keys, actors): trimmed, capped, no control chars. */
function ident(v, name, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) fail(name + ' is required');
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
  if (!s && required) fail(name + ' is required');
  return s || null;
}

/** world.js str() rules: sanitizeWebContent, one line, ">>>" stripped, capped after sanitizing. */
export function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const out = sanitizeWebContent(String(v)).replace(/>{3,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return out || null;
}

/** JSON body under a byte cap. Arrays are trimmed from the end to fit; an oversized object throws. */
function json(v, name, max, { required = false, list = false } = {}) {
  if (v === undefined || v === null) {
    if (required) fail(name + ' is required');
    return null;
  }
  let val = v;
  if (typeof val === 'string') {
    val = parseJson(val, undefined);
    if (val === undefined) fail(name + ' is not valid JSON');
  }
  if (list && !Array.isArray(val)) fail(name + ' must be an array');
  if (!list && (typeof val !== 'object' || val === null)) fail(name + ' must be an object or array');
  let s = JSON.stringify(val);
  if (s.length <= max) return s;
  if (Array.isArray(val)) {
    const arr = [...val];
    while (arr.length && s.length > max) { arr.pop(); s = JSON.stringify(arr); }
    return s;
  }
  fail(name + ' is larger than ' + max + ' bytes');
  return null;
}

/** A list of positive integer ids (deduped, ≤ LIMITS.sourceIds). */
function idList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    const n = Number(x);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= LIMITS.sourceIds) break;
  }
  return out;
}

/** A list of non-empty strings (deduped). */
function strList(v, max = 200) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    const s = ident(x, 'list item', max);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const statusList = (v, values, name) => {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  for (const s of arr) oneOf(s, values, name, { required: true });
  return arr.length ? JSON.stringify(arr) : null;
};

function clampLimit(limit, def, max) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

const NIGHT_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function nightKey(v) {
  if (typeof v !== 'string' || !NIGHT_KEY_RE.test(v)) fail('nightKey must be YYYY-MM-DD');
  return v;
}

const BOOL_COLS = new Set(['fell_back']);

/** A DB row → camelCase, *_json parsed (key without the suffix), bools as booleans. */
function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [col, v] of Object.entries(row)) {
    if (col.endsWith('_json')) out[camel(col.slice(0, -5))] = parseJson(v, null);
    else if (BOOL_COLS.has(col)) out[camel(col)] = !!v;
    else out[camel(col)] = v;
  }
  return out;
}
const decodeAll = (rows) => rows.map(decode);

/** Reject keys outside the allow-list. */
function allowKeys(obj, allowed, what) {
  if (obj == null) return {};
  if (!isObj(obj)) fail(what + ' must be an object');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(what + ' has no field "' + k + '"');
  return obj;
}

/** patch[k] when present (null clears), else the current value. */
const pick = (patch, k, current) => (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined ? patch[k] : current);

/** Run fn inside one transaction (nested calls use savepoints). */
export function inTransaction(fn) {
  return getDb().transaction(fn)();
}

// ── story_claim_reviews ──────────────────────────────────────────────────────

/**
 * One review per claim (claim_id UNIQUE). → { id, created } — an existing review is
 * returned untouched (created:false). expires_at = created_at + trayHours (default
 * config value passed by the caller, else 72 h).
 */
export function createReview({ claimId, claimEventId = null, chatJid, originKind, originJid, createdAt, trayHours,
  status = 'pending' } = {}) {
  const cid = int(claimId, 'claimId', { required: true, min: 1 });
  const at = int(createdAt, 'createdAt') ?? nowSec();
  const hours = int(trayHours, 'trayHours', { min: 1 }) ?? LIMITS.defaultTrayHours;
  const info = q(`INSERT INTO story_claim_reviews (claim_id, claim_event_id, chat_jid, origin_kind, origin_jid, status,
      created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING`)
    .run(cid, int(claimEventId, 'claimEventId'), ident(chatJid, 'chatJid', 200, { required: true }),
      oneOf(originKind, REVIEW_ORIGIN_KINDS, 'originKind', { required: true }), ident(originJid, 'originJid', 200, { required: true }),
      oneOf(status, ['pending', 'tray'], 'status', { required: true }), at, at + hours * HOUR);
  const id = q('SELECT id FROM story_claim_reviews WHERE claim_id = ?').pluck().get(cid);
  return { id, created: info.changes === 1 };
}

export function getReview(id) {
  return decode(q('SELECT * FROM story_claim_reviews WHERE id = ?').get(int(id, 'id', { required: true })));
}

export function getReviewByClaim(claimId) {
  return decode(q('SELECT * FROM story_claim_reviews WHERE claim_id = ?').get(int(claimId, 'claimId', { required: true })));
}

const REVIEW_PATCH = ['status', 'reason', 'extraction', 'resolution', 'conflict', 'adoptedEventId', 'runId', 'decidedAt',
  'decidedBy', 'expiresAt', 'claimEventId'];

/**
 * Amend a review (allow-listed fields; null clears). `fromStatus` (string|array)
 * makes it a compare-and-set: nothing changes unless the row is in one of those
 * states. A decided status without decidedAt gets now. → true when the row changed.
 */
export function updateReview(id, patch = {}, { fromStatus = null } = {}) {
  allowKeys(patch, REVIEW_PATCH, 'review patch');
  const cur = q('SELECT * FROM story_claim_reviews WHERE id = ?').get(int(id, 'id', { required: true }));
  if (!cur) return false;
  const status = oneOf(pick(patch, 'status', cur.status), REVIEW_STATUSES, 'status', { required: true });
  const reason = oneOf(pick(patch, 'reason', cur.reason), REVIEW_REASONS, 'reason');
  const enc = (k, col) => (Object.prototype.hasOwnProperty.call(patch, k)
    ? json(patch[k], k, LIMITS.reviewJson) : cur[col]);
  let decidedAt = int(pick(patch, 'decidedAt', cur.decided_at), 'decidedAt');
  if (decidedAt === null && REVIEW_DECIDED.includes(status) && status !== cur.status) decidedAt = nowSec();
  const from = statusList(fromStatus, REVIEW_STATUSES, 'fromStatus');
  const info = q(`UPDATE story_claim_reviews SET status = ?, reason = ?, extraction_json = ?, resolution_json = ?,
      conflict_json = ?, adopted_event_id = ?, run_id = ?, decided_at = ?, decided_by = ?, expires_at = ?, claim_event_id = ?
    WHERE id = ? AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))`)
    .run(status, reason, enc('extraction', 'extraction_json'), enc('resolution', 'resolution_json'),
      enc('conflict', 'conflict_json'), int(pick(patch, 'adoptedEventId', cur.adopted_event_id), 'adoptedEventId'),
      int(pick(patch, 'runId', cur.run_id), 'runId'), decidedAt, ident(pick(patch, 'decidedBy', cur.decided_by), 'decidedBy', 100),
      int(pick(patch, 'expiresAt', cur.expires_at), 'expiresAt', { required: true }),
      int(pick(patch, 'claimEventId', cur.claim_event_id), 'claimEventId'), cur.id, from, from);
  return info.changes === 1;
}

/** Tray/listing, newest first. q: { status (string|array), originJid, before (id), limit ≤ 200 } */
export function listReviews({ status = null, originJid = null, before = null, limit = 50 } = {}) {
  const st = statusList(status, REVIEW_STATUSES, 'status');
  return decodeAll(q(`SELECT * FROM story_claim_reviews
    WHERE (? IS NULL OR status IN (SELECT value FROM json_each(?))) AND (? IS NULL OR origin_jid = ?) AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`)
    .all(st, st, originJid ?? null, originJid ?? null, int(before, 'before'), int(before, 'before'), clampLimit(limit, 50, 200)));
}

/** Count reviews. q: { status (string|array), since (created_at ≥) } */
export function countReviews({ status = null, since = null } = {}) {
  const st = statusList(status, REVIEW_STATUSES, 'status');
  return q(`SELECT COUNT(*) FROM story_claim_reviews
    WHERE (? IS NULL OR status IN (SELECT value FROM json_each(?))) AND (? IS NULL OR created_at >= ?)`)
    .pluck().get(st, st, int(since, 'since'), int(since, 'since'));
}

/** Reviews whose expires_at has passed (oldest first), in the given states (default pending + tray). */
export function listExpiredReviews(at = nowSec(), { status = ['pending', 'tray'], limit = 100 } = {}) {
  const st = statusList(status, REVIEW_STATUSES, 'status');
  return decodeAll(q(`SELECT * FROM story_claim_reviews
    WHERE expires_at <= ? AND status IN (SELECT value FROM json_each(?)) ORDER BY expires_at, id LIMIT ?`)
    .all(int(at, 'at', { required: true }), st, clampLimit(limit, 100, 500)));
}

/** Adopted reviews whose claim.adopted event id lies in [fromEventId, toEventId] (a rewound range). */
export function reviewsAdoptedBetween(fromEventId, toEventId) {
  return decodeAll(q(`SELECT * FROM story_claim_reviews
    WHERE status = 'adopted' AND adopted_event_id BETWEEN ? AND ? ORDER BY id`)
    .all(int(fromEventId, 'fromEventId', { required: true }), int(toEventId, 'toEventId', { required: true })));
}

/**
 * Forget/revoke/owner withdrawal (research R22): every review of these claims loses its
 * extraction, resolution and conflict at once, whatever its state, and goes to
 * `withdrawn` (decided now, by `by`). DB-only; safe with life stopped. → the rows as
 * they were before ({id, claimId, status, adoptedEventId}), so the caller knows which
 * adoptions still need their world-side withdrawal.
 */
export function withdrawReviews(claimIds, { by = 'engine', at = nowSec() } = {}) {
  const ids = JSON.stringify(idList(claimIds));
  return inTransaction(() => {
    const before = q(`SELECT id, claim_id, status, adopted_event_id FROM story_claim_reviews
      WHERE claim_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(ids);
    q(`UPDATE story_claim_reviews SET extraction_json = NULL, resolution_json = NULL, conflict_json = NULL,
        status = 'withdrawn',
        decided_at = CASE WHEN status = 'withdrawn' THEN decided_at ELSE ? END,
        decided_by = CASE WHEN status = 'withdrawn' THEN decided_by ELSE ? END
      WHERE claim_id IN (SELECT value FROM json_each(?))`).run(int(at, 'at', { required: true }), ident(by, 'by', 100), ids);
    return decodeAll(before);
  });
}

/** Purge: delete every review of these claims. → rows deleted */
export function deleteReviewsByClaims(claimIds) {
  return q('DELETE FROM story_claim_reviews WHERE claim_id IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(idList(claimIds))).changes;
}

/** Purge: delete every review from these chats (origin_jid). → rows deleted */
export function deleteReviewsByOrigins(originJids) {
  return q('DELETE FROM story_claim_reviews WHERE origin_jid IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(strList(originJids))).changes;
}

/**
 * Boot sweep (reconciler.md §1): 009 flagged claims created at or after `since` with no
 * review yet, oldest first, ≤ 50. Ids and routing only — the claim text is read
 * through claims.getClaim(), never here.
 */
export function claimsWithoutReview({ since, limit = 50 } = {}) {
  return q(`SELECT c.id AS claim_id, c.chat_jid, c.origin_kind, c.origin_jid, c.created_at
      FROM life_claims c LEFT JOIN story_claim_reviews r ON r.claim_id = c.id
      WHERE r.id IS NULL AND c.status = 'flagged' AND c.created_at >= ?
      ORDER BY c.created_at, c.id LIMIT ?`)
    .all(int(since, 'since', { required: true }), clampLimit(limit, 50, 50)).map(decode);
}

// ── story_runs ───────────────────────────────────────────────────────────────

/** Start a model run (status 'running'). → id */
export function startRun({ kind, caller, input = null, model = null, startedAt } = {}) {
  return Number(q(`INSERT INTO story_runs (kind, caller, status, model, input_json, started_at)
      VALUES (?, ?, 'running', ?, ?, ?)`)
    .run(oneOf(kind, RUN_KINDS, 'kind', { required: true }), ident(caller, 'caller', 80, { required: true }),
      ident(model, 'model', 120), json(input, 'input', LIMITS.runJson), int(startedAt, 'startedAt') ?? nowSec())
    .lastInsertRowid);
}

const RUN_PATCH = ['status', 'skipReason', 'model', 'fellBack', 'costUsd', 'input', 'output', 'dropped', 'finishedAt'];

/**
 * Amend a run (the "bump" of contracts/story-api.md §2: finish it, or record cost,
 * model, output as they arrive). A final status without finishedAt gets now.
 * → true when the row changed.
 */
export function bumpRun(id, patch = {}) {
  allowKeys(patch, RUN_PATCH, 'run patch');
  const cur = q('SELECT * FROM story_runs WHERE id = ?').get(int(id, 'id', { required: true }));
  if (!cur) return false;
  const status = oneOf(pick(patch, 'status', cur.status), RUN_STATUSES, 'status', { required: true });
  let finishedAt = int(pick(patch, 'finishedAt', cur.finished_at), 'finishedAt');
  if (finishedAt === null && status !== 'running') finishedAt = nowSec();
  const enc = (k, col, list) => (Object.prototype.hasOwnProperty.call(patch, k)
    ? json(patch[k], k, LIMITS.runJson, { list }) : cur[col]);
  return q(`UPDATE story_runs SET status = ?, skip_reason = ?, model = ?, fell_back = ?, cost_usd = ?, input_json = ?,
      output_json = ?, dropped_json = ?, finished_at = ? WHERE id = ?`)
    .run(status, oneOf(pick(patch, 'skipReason', cur.skip_reason), SKIP_REASONS, 'skipReason'),
      ident(pick(patch, 'model', cur.model), 'model', 120), pick(patch, 'fellBack', !!cur.fell_back) ? 1 : 0,
      real(pick(patch, 'costUsd', cur.cost_usd), 'costUsd'), enc('input', 'input_json', false),
      enc('output', 'output_json', false), enc('dropped', 'dropped_json', true), finishedAt, cur.id).changes === 1;
}

/** Alias of bumpRun for readability at call sites that close a run. */
export const finishRun = bumpRun;

/** One-shot finished run (e.g. a skip: {kind, caller, status:'skipped', skipReason}). → id */
export function recordRun({ kind, caller, status, skipReason = null, model = null, fellBack = false, costUsd = null,
  input = null, output = null, dropped = null, startedAt, finishedAt } = {}) {
  const st = oneOf(status, RUN_STATUSES.filter(s => s !== 'running'), 'status', { required: true });
  const at = int(startedAt, 'startedAt') ?? nowSec();
  return Number(q(`INSERT INTO story_runs (kind, caller, status, skip_reason, model, fell_back, cost_usd, input_json,
      output_json, dropped_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(oneOf(kind, RUN_KINDS, 'kind', { required: true }), ident(caller, 'caller', 80, { required: true }), st,
      oneOf(skipReason, SKIP_REASONS, 'skipReason'), ident(model, 'model', 120), fellBack ? 1 : 0, real(costUsd, 'costUsd'),
      json(input, 'input', LIMITS.runJson), json(output, 'output', LIMITS.runJson),
      json(dropped, 'dropped', LIMITS.runJson, { list: true }), at, int(finishedAt, 'finishedAt') ?? at)
    .lastInsertRowid);
}

export function getRun(id) {
  return decode(q('SELECT * FROM story_runs WHERE id = ?').get(int(id, 'id', { required: true })));
}

/** Runs page, newest first, without the JSON bodies. q: { kind, status, before (id), limit ≤ 200 } */
export function listRuns({ kind = null, status = null, before = null, limit = 50 } = {}) {
  const k = statusList(kind, RUN_KINDS, 'kind');
  const st = statusList(status, RUN_STATUSES, 'status');
  return decodeAll(q(`SELECT id, kind, caller, status, skip_reason, model, fell_back, cost_usd, started_at, finished_at
    FROM story_runs WHERE (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR status IN (SELECT value FROM json_each(?))) AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`)
    .all(k, k, st, st, int(before, 'before'), int(before, 'before'), clampLimit(limit, 50, 200)));
}

/**
 * Count runs for caps (extraction per hour/day, clerk calls per day, journal calls per
 * night, narrations). q: { kind (string|array), caller, status (string|array),
 * excludeStatus (string|array), since (started_at ≥), until (started_at <) }
 */
export function countRuns({ kind = null, caller = null, status = null, excludeStatus = null, since = null, until = null } = {}) {
  const k = statusList(kind, RUN_KINDS, 'kind');
  const st = statusList(status, RUN_STATUSES, 'status');
  const ex = statusList(excludeStatus, RUN_STATUSES, 'excludeStatus');
  const s = int(since, 'since');
  const u = int(until, 'until');
  return q(`SELECT COUNT(*) FROM story_runs
    WHERE (? IS NULL OR kind IN (SELECT value FROM json_each(?))) AND (? IS NULL OR caller = ?)
      AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR status NOT IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at < ?)`)
    .pluck().get(k, k, caller ?? null, caller ?? null, st, st, ex, ex, s, s, u, u);
}

/** The latest run of a kind (optionally only in some statuses), or null. */
export function lastRun({ kind, status = null } = {}) {
  const st = statusList(status, RUN_STATUSES, 'status');
  return decode(q(`SELECT * FROM story_runs WHERE kind = ? AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))
    ORDER BY started_at DESC, id DESC LIMIT 1`).get(oneOf(kind, RUN_KINDS, 'kind', { required: true }), st, st));
}

// ── story_proposals ──────────────────────────────────────────────────────────

/** A weekly-pass part waiting for the owner (or refused). → id */
export function createProposal({ runId, weekKey, category, kind, payload, status = 'pending', reason = null, createdAt } = {}) {
  if (typeof weekKey !== 'string' || !/^\d{4}-W\d{2}$/.test(weekKey)) fail('weekKey must be YYYY-Www');
  const st = oneOf(status, PROPOSAL_STATUSES, 'status', { required: true });
  const at = int(createdAt, 'createdAt') ?? nowSec();
  return Number(q(`INSERT INTO story_proposals (run_id, week_key, category, kind, payload_json, status, reason, created_at,
      decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(int(runId, 'runId', { required: true }), weekKey, oneOf(category, STORY_CATEGORIES, 'category', { required: true }),
      oneOf(kind, PROPOSAL_KINDS, 'kind', { required: true }), json(payload, 'payload', LIMITS.proposalJson, { required: true }),
      st, ident(reason, 'reason', 40), at, st === 'pending' ? null : at)
    .lastInsertRowid);
}

export function getProposal(id) {
  return decode(q('SELECT * FROM story_proposals WHERE id = ?').get(int(id, 'id', { required: true })));
}

/** Newest first. q: { status (string|array), weekKey, before (id), limit ≤ 200 } */
export function listProposals({ status = null, weekKey = null, before = null, limit = 50 } = {}) {
  const st = statusList(status, PROPOSAL_STATUSES, 'status');
  return decodeAll(q(`SELECT * FROM story_proposals
    WHERE (? IS NULL OR status IN (SELECT value FROM json_each(?))) AND (? IS NULL OR week_key = ?) AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`)
    .all(st, st, weekKey ?? null, weekKey ?? null, int(before, 'before'), int(before, 'before'), clampLimit(limit, 50, 200)));
}

export function countProposals({ status = null, weekKey = null } = {}) {
  const st = statusList(status, PROPOSAL_STATUSES, 'status');
  return q(`SELECT COUNT(*) FROM story_proposals
    WHERE (? IS NULL OR status IN (SELECT value FROM json_each(?))) AND (? IS NULL OR week_key = ?)`)
    .pluck().get(st, st, weekKey ?? null, weekKey ?? null);
}

/** Decide a PENDING proposal (applied | rejected | refused | expired). → true when it was pending. */
export function decideProposal(id, { status, reason = null, by = null, at = nowSec() } = {}) {
  const st = oneOf(status, PROPOSAL_STATUSES.filter(s => s !== 'pending'), 'status', { required: true });
  return q(`UPDATE story_proposals SET status = ?, reason = COALESCE(?, reason), decided_at = ?, decided_by = ?
    WHERE id = ? AND status = 'pending'`)
    .run(st, ident(reason, 'reason', 40), int(at, 'at', { required: true }), ident(by, 'by', 100),
      int(id, 'id', { required: true })).changes === 1;
}

/** An APPLIED proposal whose change the owner reverted → rejected 'reverted'. → true when it was applied. */
export function unapplyProposal(id, { by = null, at = nowSec() } = {}) {
  return q(`UPDATE story_proposals SET status = 'rejected', reason = 'reverted', decided_at = ?, decided_by = ?
    WHERE id = ? AND status = 'applied'`)
    .run(int(at, 'at', { required: true }), ident(by, 'by', 100), int(id, 'id', { required: true })).changes === 1;
}

/** Pending proposals older than 14 days → expired. → rows changed */
export function expireProposals(at = nowSec(), { maxAgeDays = LIMITS.proposalPendingDays } = {}) {
  const t = int(at, 'at', { required: true });
  return q(`UPDATE story_proposals SET status = 'expired', decided_at = ?, decided_by = 'engine'
    WHERE status = 'pending' AND created_at <= ?`).run(t, t - int(maxAgeDays, 'maxAgeDays', { min: 0 }) * DAY).changes;
}

// ── story_journal_nights ─────────────────────────────────────────────────────

export function getNight(key) {
  return decode(q('SELECT * FROM story_journal_nights WHERE night_key = ?').get(nightKey(key)));
}

const NIGHT_PATCH = ['status', 'reason', 'sleepEventId', 'attempts', 'finishedAt'];

/** Insert or amend a night (status required on insert). A final status without finishedAt gets now. → the night */
export function upsertNight(key, patch = {}) {
  allowKeys(patch, NIGHT_PATCH, 'night patch');
  const nk = nightKey(key);
  const cur = q('SELECT * FROM story_journal_nights WHERE night_key = ?').get(nk);
  const status = oneOf(pick(patch, 'status', cur?.status), NIGHT_STATUSES, 'status', { required: true });
  let finishedAt = int(pick(patch, 'finishedAt', cur?.finished_at ?? null), 'finishedAt');
  if (finishedAt === null && status !== 'running') finishedAt = nowSec();
  const attempts = int(pick(patch, 'attempts', cur?.attempts ?? 0), 'attempts', { min: 0 });
  q(`INSERT INTO story_journal_nights (night_key, status, reason, sleep_event_id, attempts, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(night_key) DO UPDATE SET status = excluded.status, reason = excluded.reason,
      sleep_event_id = excluded.sleep_event_id, attempts = excluded.attempts, finished_at = excluded.finished_at`)
    .run(nk, status, oneOf(pick(patch, 'reason', cur?.reason ?? null), NIGHT_REASONS, 'reason'),
      int(pick(patch, 'sleepEventId', cur?.sleep_event_id ?? null), 'sleepEventId'), attempts, cur?.created_at ?? nowSec(),
      finishedAt);
  return getNight(nk);
}

/** attempts + 1 on an existing night. → the new count, or null when the night does not exist. */
export function bumpNightAttempts(key) {
  const nk = nightKey(key);
  const info = q('UPDATE story_journal_nights SET attempts = attempts + 1 WHERE night_key = ?').run(nk);
  return info.changes ? q('SELECT attempts FROM story_journal_nights WHERE night_key = ?').pluck().get(nk) : null;
}

/** Newest night first. q: { before (night_key), limit ≤ 120 } */
export function listNights({ before = null, limit = 30 } = {}) {
  const b = before == null ? null : nightKey(before);
  return decodeAll(q(`SELECT * FROM story_journal_nights WHERE (? IS NULL OR night_key < ?)
    ORDER BY night_key DESC LIMIT ?`).all(b, b, clampLimit(limit, 30, 120)));
}

// ── story_journal_parts ──────────────────────────────────────────────────────

function sourcesOf(v) {
  if (v != null && !isObj(v)) fail('sources must be {events, claims}');
  return JSON.stringify({ events: idList(v?.events), claims: idList(v?.claims) });
}

/**
 * Write the part of a night for one origin (UNIQUE night_key + origin_jid). An existing
 * part is replaced (a rebuild) unless it is fenced: a fenced part is never rebuilt and
 * null is returned. Text: cleaned, ≤ 600 (self) / ≤ 240 (a chat). → id | null
 */
export function putPart({ nightKey: nk, originKind, originJid, text, sources, runId = null, status = 'active', createdAt } = {}) {
  const key = nightKey(nk);
  const kind = oneOf(originKind, PART_ORIGIN_KINDS, 'originKind', { required: true });
  const ojid = kind === 'self' ? 'self' : ident(originJid, 'originJid', 200, { required: true });
  if (kind !== 'self' && ojid === 'self') fail('a chat part needs a chat origin');
  const st = oneOf(status, ['active', 'undone'], 'status', { required: true });
  const body = cleanText(text, kind === 'self' ? LIMITS.partSelfChars : LIMITS.partChatChars);
  if (!body) fail('text is required');
  const info = q(`INSERT INTO story_journal_parts (night_key, origin_kind, origin_jid, text, sources_json, status, run_id,
      created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(night_key, origin_jid) DO UPDATE SET origin_kind = excluded.origin_kind, text = excluded.text,
      sources_json = excluded.sources_json, status = excluded.status, run_id = excluded.run_id, created_at = excluded.created_at
    WHERE story_journal_parts.status != 'fenced'`)
    .run(key, kind, ojid, body, sourcesOf(sources), st, int(runId, 'runId'), int(createdAt, 'createdAt') ?? nowSec());
  if (!info.changes) return null;
  return q('SELECT id FROM story_journal_parts WHERE night_key = ? AND origin_jid = ?').pluck().get(key, ojid);
}

export function getPart(id) {
  return decode(q('SELECT * FROM story_journal_parts WHERE id = ?').get(int(id, 'id', { required: true })));
}

/** One night's parts: the self part first, then the chats in id order. */
export function listParts(key) {
  return decodeAll(q(`SELECT * FROM story_journal_parts WHERE night_key = ?
    ORDER BY CASE origin_kind WHEN 'self' THEN 0 ELSE 1 END, id`).all(nightKey(key)));
}

/** Parts citing any of these world event ids (sources_json.events). */
export function partsBySourceEvents(eventIds) {
  return decodeAll(q(`SELECT * FROM story_journal_parts p WHERE EXISTS (SELECT 1 FROM json_each(p.sources_json, '$.events') e
    WHERE e.value IN (SELECT value FROM json_each(?))) ORDER BY id`).all(JSON.stringify(idList(eventIds))));
}

/** Parts citing any of these claim ids (sources_json.claims). */
export function partsBySourceClaims(claimIds) {
  return decodeAll(q(`SELECT * FROM story_journal_parts p WHERE EXISTS (SELECT 1 FROM json_each(p.sources_json, '$.claims') c
    WHERE c.value IN (SELECT value FROM json_each(?))) ORDER BY id`).all(JSON.stringify(idList(claimIds))));
}

/** active ⇄ undone (a fenced part never changes back). → rows changed */
export function setPartStatus(ids, status) {
  const st = oneOf(status, ['active', 'undone'], 'status', { required: true });
  return q(`UPDATE story_journal_parts SET status = ? WHERE status != 'fenced' AND id IN (SELECT value FROM json_each(?))`)
    .run(st, JSON.stringify(idList(ids))).changes;
}

/** Forget/revoke in chat X: fence X's parts for these nights (text NULL, never rebuilt). → rows changed */
export function fencePartsByOrigin(originJid, nightKeys) {
  const keys = (Array.isArray(nightKeys) ? nightKeys : [nightKeys]).filter(k => typeof k === 'string' && NIGHT_KEY_RE.test(k));
  return q(`UPDATE story_journal_parts SET status = 'fenced', text = NULL
    WHERE origin_jid = ? AND night_key IN (SELECT value FROM json_each(?))`)
    .run(ident(originJid, 'originJid', 200, { required: true }), JSON.stringify(keys)).changes;
}

/** Withdrawn claims: fence every part citing one of them, whatever its night. → rows changed */
export function fencePartsByClaims(claimIds) {
  return q(`UPDATE story_journal_parts SET status = 'fenced', text = NULL
    WHERE EXISTS (SELECT 1 FROM json_each(story_journal_parts.sources_json, '$.claims') c
      WHERE c.value IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(idList(claimIds))).changes;
}

/** Purge: delete the parts of these origins. → rows deleted */
export function deletePartsByOrigins(originJids) {
  return q('DELETE FROM story_journal_parts WHERE origin_jid IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(strList(originJids).filter(j => j !== 'self'))).changes;
}

/** Purge: delete the parts citing any of these (now redacted) events. → rows deleted */
export function deletePartsBySourceEvents(eventIds) {
  return q(`DELETE FROM story_journal_parts WHERE EXISTS (SELECT 1 FROM json_each(story_journal_parts.sources_json, '$.events') e
    WHERE e.value IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(idList(eventIds))).changes;
}

/** Purge: delete the parts citing any of these (deleted) claims. → rows deleted */
export function deletePartsBySourceClaims(claimIds) {
  return q(`DELETE FROM story_journal_parts WHERE EXISTS (SELECT 1 FROM json_each(story_journal_parts.sources_json, '$.claims') c
    WHERE c.value IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(idList(claimIds))).changes;
}

// ── story_narrations ─────────────────────────────────────────────────────────

/**
 * Cache a narration. kind 'event' is one row per event (replaced); 'thought' rows are
 * appended (event_id NULL). Text cleaned, ≤ 400. Default expiry: event +30 d, thought +1 h.
 * → id
 */
export function putNarration({ kind, eventId = null, origins, text, sources, createdAt, expiresAt } = {}) {
  const k = oneOf(kind, NARRATION_KINDS, 'kind', { required: true });
  const ev = k === 'event' ? int(eventId, 'eventId', { required: true, min: 1 }) : null;
  const body = cleanText(text, LIMITS.narrationChars);
  if (!body) fail('text is required');
  const at = int(createdAt, 'createdAt') ?? nowSec();
  const exp = int(expiresAt, 'expiresAt') ?? at + (k === 'event' ? LIMITS.narrationEventTtlSec : LIMITS.narrationThoughtTtlSec);
  const params = [k, ev, JSON.stringify(strList(origins)), body, JSON.stringify(idList(sources)), at, exp];
  if (k === 'thought') {
    return Number(q(`INSERT INTO story_narrations (kind, event_id, origins_json, text, sources_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...params).lastInsertRowid);
  }
  q(`INSERT INTO story_narrations (kind, event_id, origins_json, text, sources_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, event_id) DO UPDATE SET origins_json = excluded.origins_json, text = excluded.text,
      sources_json = excluded.sources_json, created_at = excluded.created_at, expires_at = excluded.expires_at`).run(...params);
  return q(`SELECT id FROM story_narrations WHERE kind = 'event' AND event_id = ?`).pluck().get(ev);
}

/** The cached narration of an event, unless expired. */
export function getEventNarration(eventId, at = nowSec()) {
  return decode(q(`SELECT * FROM story_narrations WHERE kind = 'event' AND event_id = ? AND expires_at > ?`)
    .get(int(eventId, 'eventId', { required: true }), int(at, 'at', { required: true })));
}

/** The newest unexpired thought, or null. */
export function latestThought(at = nowSec()) {
  return decode(q(`SELECT * FROM story_narrations WHERE kind = 'thought' AND expires_at > ?
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(int(at, 'at', { required: true })));
}

/** Forget/purge: delete narrations that used any of these origins. → rows deleted */
export function deleteNarrationsByOrigins(originJids) {
  return q(`DELETE FROM story_narrations WHERE EXISTS (SELECT 1 FROM json_each(story_narrations.origins_json) o
    WHERE o.value IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(strList(originJids))).changes;
}

/** Forget/purge: delete narrations of, or citing, any of these events. → rows deleted */
export function deleteNarrationsBySourceEvents(eventIds) {
  const ids = JSON.stringify(idList(eventIds));
  return q(`DELETE FROM story_narrations WHERE event_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(story_narrations.sources_json) s WHERE s.value IN (SELECT value FROM json_each(?)))`)
    .run(ids, ids).changes;
}

// ── story_refusals ───────────────────────────────────────────────────────────

/**
 * Log a refused change (FR-005). A storm is bounded: a refusal with the same
 * (source, target, reason) inside the last hour is not written again.
 * → { id, deduped }
 */
export function recordRefusal({ source, category = null, action, target = null, reason, pinKey = null, detail = null, at } = {}) {
  // Validate everything first: a deduped call must still fail closed on bad input.
  const src = oneOf(source, REFUSAL_SOURCES, 'source', { required: true });
  const why = oneOf(reason, REFUSAL_REASONS, 'reason', { required: true });
  const cat = oneOf(category, STORY_CATEGORIES, 'category');
  const act = oneOf(action, REFUSAL_ACTIONS, 'action', { required: true });
  const tgt = ident(target, 'target', 120);
  const pin = ident(pinKey, 'pinKey', 120);
  const det = json(detail, 'detail', LIMITS.refusalDetail);
  const t = int(at, 'at') ?? nowSec();
  return inTransaction(() => {
    const prior = q(`SELECT id FROM story_refusals WHERE source = ? AND target IS ? AND reason = ? AND at > ? AND at <= ?
      ORDER BY id DESC LIMIT 1`).pluck().get(src, tgt, why, t - LIMITS.refusalDedupeSec, t);
    if (prior) return { id: prior, deduped: true };
    const id = Number(q(`INSERT INTO story_refusals (at, source, category, action, target, reason, pin_key, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(t, src, cat, act, tgt, why, pin, det).lastInsertRowid);
    return { id, deduped: false };
  });
}

/** Newest first. q: { source, reason, before (id), limit ≤ 200 } */
export function listRefusals({ source = null, reason = null, before = null, limit = 50 } = {}) {
  return decodeAll(q(`SELECT * FROM story_refusals WHERE (? IS NULL OR source = ?) AND (? IS NULL OR reason = ?)
      AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
    .all(source ?? null, source ?? null, reason ?? null, reason ?? null, int(before, 'before'), int(before, 'before'),
      clampLimit(limit, 50, 200)));
}

export function countRefusals({ source = null, reason = null, since = null } = {}) {
  return q(`SELECT COUNT(*) FROM story_refusals WHERE (? IS NULL OR source = ?) AND (? IS NULL OR reason = ?)
      AND (? IS NULL OR at >= ?)`)
    .pluck().get(source ?? null, source ?? null, reason ?? null, reason ?? null, int(since, 'since'), int(since, 'since'));
}

// ── story_state ──────────────────────────────────────────────────────────────

// Keys that hold a bounded list instead of one small value (every other key: LIMITS.stateJson).
const STATE_JSON_LIMITS = Object.freeze({ sweep_findings: 65536, sweep_dismissed: 65536, phone_plan_outcomes: 16384 });

const STATE_ALIASES = Object.fromEntries(STATE_KEYS.flatMap(k => [[k, k], [camel(k), k]]));
function stateKey(k) {
  const key = STATE_ALIASES[k];
  if (!key) fail('story_state has no key "' + k + '"');
  return key;
}

/**
 * story_state bookkeeping. getState() → every known key (absent → null);
 * getState(key) → that value or null. Keys: last_weekly_at, last_weekly_run, seed,
 * extract_counters, degraded (camelCase accepted).
 */
export function getState(key) {
  if (key !== undefined) {
    return parseJson(q('SELECT value_json FROM story_state WHERE key = ?').pluck().get(stateKey(key)), null);
  }
  const out = Object.fromEntries(STATE_KEYS.map(k => [k, null]));
  for (const row of q('SELECT key, value_json FROM story_state').all()) {
    if (STATE_KEYS.includes(row.key)) out[row.key] = parseJson(row.value_json, null);
  }
  return out;
}

/** One key, telling an absent value from one that doesn't parse: { value, corrupt }. */
export function getStateChecked(key) {
  const text = q('SELECT value_json FROM story_state WHERE key = ?').pluck().get(stateKey(key));
  if (text === undefined || text === null) return { value: null, corrupt: false };
  try { return { value: JSON.parse(text), corrupt: false }; } catch { return { value: null, corrupt: true }; }
}

/** Set keys (each value replaced whole; null deletes the key). → getState() */
export function patchState(patch = {}) {
  if (!isObj(patch)) fail('state patch must be an object');
  const entries = Object.entries(patch).map(([k, v]) => [stateKey(k), v]);
  const at = nowSec();
  inTransaction(() => {
    for (const [k, v] of entries) {
      if (v === undefined) continue;
      if (v === null) { q('DELETE FROM story_state WHERE key = ?').run(k); continue; }
      if (typeof v === 'number' && !Number.isFinite(v)) fail(k + ' must be finite');
      const s = JSON.stringify(v);
      const max = STATE_JSON_LIMITS[k] ?? LIMITS.stateJson;
      if (s === undefined || s.length > max) fail(k + ' is not storable (≤ ' + max + ' bytes)');
      q(`INSERT INTO story_state (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(k, s, at);
    }
  });
  return getState();
}

/**
 * The arc-seed gate (research R19): write `seed = {source:'pending', attemptedAt}` only
 * if no seed record exists yet. → true when this call wrote it (the caller may run the
 * one generation), false when an attempt (or a result) is already recorded.
 */
export function beginSeedAttempt({ at = nowSec() } = {}) {
  const t = int(at, 'at', { required: true });
  return q(`INSERT INTO story_state (key, value_json, updated_at) VALUES ('seed', ?, ?) ON CONFLICT(key) DO NOTHING`)
    .run(JSON.stringify({ source: 'pending', attemptedAt: t }), t).changes === 1;
}

// ── retention (data-model.md §6) ─────────────────────────────────────────────

export function pruneRuns(at = nowSec(), days = RETENTION_DAYS.runs) {
  return q(`DELETE FROM story_runs WHERE started_at < ? AND status != 'running'`).run(at - days * DAY).changes;
}

export function pruneRefusals(at = nowSec(), days = RETENTION_DAYS.refusals) {
  return q('DELETE FROM story_refusals WHERE at < ?').run(at - days * DAY).changes;
}

export function pruneProposals(at = nowSec(), days = RETENTION_DAYS.proposals) {
  return q(`DELETE FROM story_proposals WHERE status != 'pending' AND COALESCE(decided_at, created_at) < ?`)
    .run(at - days * DAY).changes;
}

/** Decided reviews 180 days after decided_at (and undecided leftovers 180 days past expiry). */
export function pruneReviews(at = nowSec(), days = RETENTION_DAYS.reviews) {
  const cut = at - days * DAY;
  return q(`DELETE FROM story_claim_reviews WHERE
      (status IN (SELECT value FROM json_each(?)) AND COALESCE(decided_at, created_at) < ?)
      OR (status NOT IN (SELECT value FROM json_each(?)) AND expires_at < ?)`)
    .run(JSON.stringify(REVIEW_DECIDED), cut, JSON.stringify(REVIEW_DECIDED), cut).changes;
}

export function pruneNarrations(at = nowSec()) {
  return q('DELETE FROM story_narrations WHERE expires_at <= ?').run(at).changes;
}

/**
 * Every story prune in one transaction (the life facade's daily onDay). Pending
 * proposals older than 14 days are expired first. Journal parts are never pruned.
 * → counts per table
 */
export function pruneStory(at = nowSec()) {
  const t = int(at, 'at', { required: true });
  return inTransaction(() => ({
    proposalsExpired: expireProposals(t),
    runs: pruneRuns(t),
    refusals: pruneRefusals(t),
    proposals: pruneProposals(t),
    reviews: pruneReviews(t),
    narrations: pruneNarrations(t),
  }));
}
