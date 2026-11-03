// Scene store (spec 016, plan §1.2) — the ONLY door to story_scenes besides
// scenes/memory.js (the prompt/site reader). Synchronous (better-sqlite3), static SQL
// with `?` parameters, rows back camelCase with detail_json parsed as `detail`.
// Writes go through an allow-list; an unknown field or a bad enum throws (fail closed).
// The cursor (the last world_events id the detector scanned) lives in story_state.
//
// Model text is written only after its scene.played commits (worker.commit), so a
// row never holds text for a scene that isn't in the log. Nothing here logs.

import { getDb } from '../../../memory/db.js';
import { sanitizeWebContent } from '../../../brain/webSearch.js';
import { now } from '../../clock.js';
import { getState as storyStateGet, patchState as storyStatePatch } from '../store.js';

const DAY = 86400;

export const SCENE_STATUSES = Object.freeze(['pending', 'running', 'done', 'fallback', 'skipped', 'superseded', 'reverted']);
export const SCENE_TIERS = Object.freeze(['clerk', 'mind', 'code']);
export const SCENE_ROW_MODES = Object.freeze(['full', 'narration_only', 'self_only']);
/** A row whose scene is (or was) in the log as the live version. */
export const LIVE_STATUSES = Object.freeze(['done', 'fallback']);
export const RETENTION = Object.freeze({ undoneDays: 30, allDays: 365 });
export const DETAIL_MAX_BYTES = 4096;
export const TEXT_MAX = 2400;   // a long outing (schema NARRATION_MAX_LONG); a short one is still refused over 1200 before it is stored
export const TONE_MAX = 120;
export const OUTCOME_WORDS = Object.freeze(['well', 'fine', 'flat', 'badly']);
export const SHEET_MAX_BYTES = 6144;

const stmtCache = new WeakMap();
function q(sql) {
  const db = getDb();
  let cache = stmtCache.get(db);
  if (!cache) { cache = new Map(); stmtCache.set(db, cache); }
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  return st;
}

const nowSec = () => Math.floor(now());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function fail(msg) {
  throw new TypeError(`scene store: ${msg}`);
}

/** One stored string: sanitized, '>>>' stripped, whitespace kept to single spaces / paragraph breaks, capped. */
export function cleanStored(v, max) {
  if (typeof v !== 'string') return null;
  const s = sanitizeWebContent(v).replace(/>{3,}/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max) : null;
}

function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'detail_json') {
      try { out.detail = v === null ? null : JSON.parse(v); } catch { out.detail = null; }
    } else if (k === 'sheet_json') {
      try { out.sheet = v === null ? null : JSON.parse(v); } catch { out.sheet = null; }
    } else if (k === 'fell_back') out.fellBack = v === 1;
    else if (k === 'heavy_window') out.heavyWindow = v === 1;
    else out[camel(k)] = v;
  }
  return out;
}

/** Run fn inside one SQLite transaction (nested → a savepoint). → fn's result */
export function inTransaction(fn) {
  return getDb().transaction(fn)();
}

// ── cursor ───────────────────────────────────────────────────────────────────

/** The detector's cursor (the last scanned world_events id), or null before the first scan. */
export function getCursor() {
  const v = storyStateGet('scenes_cursor');
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export function setCursor(id) {
  if (!Number.isSafeInteger(id) || id < 0) fail('cursor must be a non-negative integer');
  storyStatePatch({ scenes_cursor: id });
}

/** Were the scenes on at the last job (R24: an off → on re-seeds the cursor)? true | false | null (never ran). */
export function getScenesOn() {
  const v = storyStateGet('scenes_on');
  return typeof v === 'boolean' ? v : null;
}

export function setScenesOn(on) {
  storyStatePatch({ scenes_on: on === true });
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * A pending row for (activity, version); INSERT OR IGNORE (the UNIQUE key makes a
 * crash / restart idempotent). → the new row id, or null when it already existed.
 */
export function insertPending({ activityEventId, version = 1, endedAt, originKind = null, originJid = null,
  subjectJid = null, tone = null, toneOutcome = null, mode = null, createdAt = nowSec(), status = 'pending', skipReason = null } = {}) {
  if (!posInt(activityEventId) || !posInt(version) || !posInt(endedAt)) fail('pending row needs activity, version, endedAt');
  if (mode !== null && !SCENE_ROW_MODES.includes(mode)) fail('bad mode');
  if (toneOutcome !== null && !OUTCOME_WORDS.includes(toneOutcome)) fail('bad toneOutcome');
  if (status !== 'pending' && status !== 'skipped') fail('a new row is pending or skipped');
  const info = q(`INSERT OR IGNORE INTO story_scenes
    (activity_event_id, version, status, skip_reason, ended_at, origin_kind, origin_jid, subject_jid, tone, tone_outcome, mode, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(activityEventId, version, status, status === 'skipped' ? value('skipReason', skipReason ?? 'skipped') : null, endedAt,
      originKind, originJid, subjectJid, cleanStored(tone, TONE_MAX), toneOutcome, mode, createdAt, status === 'skipped' ? createdAt : null);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function getScene(id) {
  return posInt(id) ? decode(q('SELECT * FROM story_scenes WHERE id = ?').get(id)) : null;
}

/** The row of a scene.played event id. */
export function getByEvent(eventId) {
  return posInt(eventId) ? decode(q('SELECT * FROM story_scenes WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(eventId)) : null;
}

/** Every version of an activity's scene, newest first. */
export function versionsOf(activityEventId) {
  return posInt(activityEventId)
    ? q('SELECT * FROM story_scenes WHERE activity_event_id = ? ORDER BY version DESC LIMIT 50').all(activityEventId).map(decode)
    : [];
}

export function hasAny(activityEventId) {
  return !!q('SELECT 1 FROM story_scenes WHERE activity_event_id = ? LIMIT 1').get(activityEventId);
}

/** Pending rows, oldest first (the worker's queue). */
export function listPending(limit = 3) {
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 3));
  return q(`SELECT * FROM story_scenes WHERE status = 'pending' ORDER BY ended_at, id LIMIT ?`).all(lim).map(decode);
}

export function countPending() {
  return q(`SELECT COUNT(*) FROM story_scenes WHERE status = 'pending'`).pluck().get();
}

/**
 * Chat-origin (narration-only) scenes that tried a model call since `since` (their own day
 * cap, R10): a row's `caller` is set when its call starts.
 */
export function countChatAttemptsSince(since) {
  return q(`SELECT COUNT(*) FROM story_scenes WHERE mode = 'narration_only' AND caller IS NOT NULL AND created_at >= ?`)
    .pluck().get(Math.floor(Number(since) || 0));
}

/**
 * Rows left 'running' by a crash or a restart mid-call (the chain is in-process, so none
 * can legitimately exist at boot): the lowest version on its start back to 'pending' (or 'skipped:interrupted'
 * once it ended before `tooOldBefore`), a regenerate → 'skipped:interrupted'. → count
 */
export function resetRunning({ tooOldBefore = 0, at = nowSec() } = {}) {
  return getDb().transaction(() =>
    q(`UPDATE story_scenes SET status = 'pending' WHERE status = 'running' AND ended_at >= ?
      AND NOT EXISTS (SELECT 1 FROM story_scenes o WHERE o.activity_event_id = story_scenes.activity_event_id AND o.version < story_scenes.version)`).run(Math.floor(Number(tooOldBefore) || 0)).changes
    + q(`UPDATE story_scenes SET status = 'skipped', skip_reason = 'interrupted', finished_at = ? WHERE status = 'running'`).run(Math.floor(at)).changes)();
}

/** Regenerated versions created since `since` (the owner's day cap). */
export function countRegensSince(since) {
  // A resumed outing's row is a later version with nothing below it on its start: the engine's, not the owner's.
  return q(`SELECT COUNT(*) FROM story_scenes s WHERE s.version > 1 AND s.created_at >= ?
    AND EXISTS (SELECT 1 FROM story_scenes o WHERE o.activity_event_id = s.activity_event_id AND o.version < s.version)`).pluck().get(Math.floor(Number(since) || 0));
}

/** Live rows (in the log as the newest version) with ended_at ≥ since, newest first. */
export function listLive({ since = 0, limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
  return q(`SELECT * FROM story_scenes WHERE status IN ('done','fallback') AND event_id IS NOT NULL AND ended_at >= ?
    ORDER BY ended_at DESC, id DESC LIMIT ?`).all(Math.floor(Number(since) || 0), lim).map(decode);
}

/** Rows of these scene.played event ids. */
export function byEventIds(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(posInt).slice(0, 500);
  if (!list.length) return [];
  return q('SELECT * FROM story_scenes WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(list)).map(decode);
}

const PATCH = ['status', 'skipReason', 'eventId', 'tier', 'mode', 'text', 'detail', 'tone', 'toneOutcome', 'heavyWindow', 'sheet',
  'model', 'fellBack', 'caller', 'finishedAt', 'originKind', 'originJid', 'subjectJid'];
const COLS = {
  status: 'status', skipReason: 'skip_reason', eventId: 'event_id', tier: 'tier', mode: 'mode', text: 'text',
  detail: 'detail_json', tone: 'tone', toneOutcome: 'tone_outcome', heavyWindow: 'heavy_window', sheet: 'sheet_json',
  model: 'model', fellBack: 'fell_back', caller: 'caller', finishedAt: 'finished_at',
  originKind: 'origin_kind', originJid: 'origin_jid', subjectJid: 'subject_jid',
};

function value(k, v) {
  if (v === null) return null;
  switch (k) {
    case 'status': if (!SCENE_STATUSES.includes(v)) fail('bad status'); return v;
    case 'tier': if (!SCENE_TIERS.includes(v)) fail('bad tier'); return v;
    case 'mode': if (!SCENE_ROW_MODES.includes(v)) fail('bad mode'); return v;
    case 'skipReason': return typeof v === 'string' ? v.replace(/[^a-z0-9_:.,-]/gi, '').slice(0, 96) : fail('bad skipReason');
    case 'eventId': case 'finishedAt': if (!posInt(v)) fail(`bad ${k}`); return v;
    case 'text': return cleanStored(v, TEXT_MAX);
    case 'tone': return cleanStored(v, TONE_MAX);
    case 'detail': {
      if (!isObj(v)) fail('detail must be an object');
      const json = JSON.stringify(v);
      if (Buffer.byteLength(json, 'utf8') > DETAIL_MAX_BYTES) fail('detail too large');
      return json;
    }
    case 'fellBack': case 'heavyWindow': return v ? 1 : 0;
    case 'toneOutcome': if (!OUTCOME_WORDS.includes(v)) fail('bad toneOutcome'); return v;
    case 'sheet': {
      if (!isObj(v)) fail('sheet must be an object');
      const json = JSON.stringify(v);
      if (Buffer.byteLength(json, 'utf8') > SHEET_MAX_BYTES) fail('sheet too large');
      return json;
    }
    case 'model': case 'caller': case 'originKind': case 'originJid': case 'subjectJid':
      return typeof v === 'string' ? v.slice(0, 128) : fail(`bad ${k}`);
    default: return fail(`unknown field ${k}`);
  }
}

// Static statements per field (no SQL built from input): one UPDATE per key.
const UPDATE_SQL = Object.fromEntries(PATCH.map(k => [k, `UPDATE story_scenes SET ${COLS[k]} = ? WHERE id = ?`]));

/** Patch a row (allow-listed fields). `fromStatus` → only when the row is in that status. → true when it changed. */
export function update(id, patch = {}, { fromStatus = null } = {}) {
  if (!posInt(id) || !isObj(patch)) fail('update needs an id and a patch');
  for (const k of Object.keys(patch)) if (!PATCH.includes(k)) fail(`unknown field ${k}`);
  const db = getDb();
  return db.transaction(() => {
    if (fromStatus) {
      const cur = q('SELECT status FROM story_scenes WHERE id = ?').pluck().get(id);
      if (cur !== fromStatus) return false;
    }
    let n = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      n += q(UPDATE_SQL[k]).run(value(k, v), id).changes;
    }
    return n > 0;
  })();
}

/** The owner's edit of the narration (effects unchanged; no world event). */
export function setEditedText(id, text, at = nowSec()) {
  if (!posInt(id)) fail('bad id');
  const t = cleanStored(text, TEXT_MAX);
  return q('UPDATE story_scenes SET edited_text = ?, edited_at = ? WHERE id = ?').run(t, t ? at : null, id).changes > 0;
}

// ── sweeps, purge, retention ─────────────────────────────────────────────────

/**
 * Live rows whose scene.played is out of the log (reverted, rewound, redacted) →
 * 'reverted' with text, edit and detail NULLed (the code-built sheet stays: a REGENERATE
 * of a reverted scene reuses it, R16/R32). `isGone(eventId)` decides.
 * A superseded row (regenerated) keeps its text (dashboard history only). → count
 */
export function sweep(isGone) {
  if (typeof isGone !== 'function') return 0;
  const rows = q(`SELECT id, event_id FROM story_scenes WHERE status IN ('done','fallback') AND event_id IS NOT NULL LIMIT 500`).all();
  let n = 0;
  const db = getDb();
  db.transaction(() => {
    for (const r of rows) {
      let gone = false;
      try { gone = isGone(r.event_id) === true; } catch { gone = false; }
      if (!gone) continue;
      n += q(`UPDATE story_scenes SET status = 'reverted', text = NULL, edited_text = NULL, edited_at = NULL, detail_json = NULL
        WHERE id = ?`).run(r.id).changes;
    }
  })();
  return n;
}

/**
 * Every version of an outing whose activity.started left the log (a revert, a cascade, a
 * rewind) or was redacted — superseded and skipped rows included (R9): 'reverted' with
 * text, edit, detail, tone and sheet NULLed, so no chat-derived text survives a forget up
 * the chain. `isActivityGone(activityEventId)` decides. → count
 */
export function sweepActivities(isActivityGone) {
  if (typeof isActivityGone !== 'function') return 0;
  const ids = q(`SELECT DISTINCT activity_event_id AS id FROM story_scenes
    WHERE text IS NOT NULL OR edited_text IS NOT NULL OR detail_json IS NOT NULL OR sheet_json IS NOT NULL OR tone IS NOT NULL
      OR status IN ('pending','done','fallback','superseded') LIMIT 500`).pluck().all();
  let n = 0;
  getDb().transaction(() => {
    for (const id of ids) {
      let gone = false;
      try { gone = isActivityGone(id) === true; } catch { gone = false; }
      if (!gone) continue;
      n += q(`UPDATE story_scenes SET status = CASE WHEN status = 'running' THEN status ELSE 'reverted' END,
          text = NULL, edited_text = NULL, edited_at = NULL, detail_json = NULL, tone = NULL, sheet_json = NULL
        WHERE activity_event_id = ? AND status <> 'running'`).run(id).changes;
    }
  })();
  return n;
}

/** Mark one row reverted at once (an owner revert of its scene.played), text NULLed. */
export function markReverted(eventId) {
  if (!posInt(eventId)) return 0;
  return q(`UPDATE story_scenes SET status = 'reverted', text = NULL, edited_text = NULL, edited_at = NULL, detail_json = NULL
    WHERE event_id = ? AND status IN ('done','fallback')`).run(eventId).changes;
}

/** 006 purge (inside purgePerson's transaction): rows about that person. → count */
export function deleteBySubject(jids) {
  const list = (Array.isArray(jids) ? jids : [jids]).filter(j => typeof j === 'string' && j);
  let n = 0;
  for (const j of list) n += q('DELETE FROM story_scenes WHERE subject_jid = ? OR origin_jid = ?').run(j, j).changes;
  return n;
}

/** Retention: superseded / reverted / skipped rows after 30 days, everything after 365. → count */
export function prune(at = nowSec()) {
  const t = Math.floor(Number(at) || nowSec());
  return getDb().transaction(() =>
    q(`DELETE FROM story_scenes WHERE status IN ('superseded','reverted','skipped') AND created_at < ?`).run(t - RETENTION.undoneDays * DAY).changes
    + q('DELETE FROM story_scenes WHERE created_at < ?').run(t - RETENTION.allDays * DAY).changes)();
}

/** Rows in a status, newest first (dashboard / tests). */
export function listByStatus(status, limit = 50) {
  if (!SCENE_STATUSES.includes(status)) fail('bad status');
  return q('SELECT * FROM story_scenes WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, Math.min(200, Math.max(1, limit))).map(decode);
}
