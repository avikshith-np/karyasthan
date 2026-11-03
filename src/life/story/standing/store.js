// How things stand (plan 020 D2): the ONLY door to story_standing and story_standing_evidence.
// Synchronous (better-sqlite3), static SQL with `?` parameters, rows back camelCase. An old version is
// closed or invalidated, its text never changes. Fictional people only. Nothing here logs.
import { getDb } from '../../../memory/db.js';

export const TEXT_MAX = 600;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;

const stmtCache = new WeakMap();
function q(sql) {
  const db = getDb();
  let cache = stmtCache.get(db);
  if (!cache) { cache = new Map(); stmtCache.set(db, cache); }
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  return st;
}

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const COLUMNS = `id, cast_id AS castId, text, as_of_event_id AS asOfEventId, valid_from AS validFrom, valid_to AS validTo,
  supersedes, status, invalid_reason AS invalidReason, words_sig AS wordsSig, night, model, fell_back AS fellBack, created_at AS createdAt`;

function fail(msg) {
  throw new TypeError(`standing store: ${msg}`);
}

/** The one live version of a member, or null. */
export function live(castId) {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE cast_id = ? AND status = 'live'`).get(castId) ?? null;
}

/** Every live version. */
export function allLive() {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE status = 'live' ORDER BY cast_id`).all();
}

/** The version that held at `at` (valid_from ≤ at < valid_to), never an invalidated one. */
export function asOf(castId, at) {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE cast_id = ? AND status != 'invalidated' AND valid_from <= ?
    AND (valid_to IS NULL OR valid_to > ?) ORDER BY id DESC LIMIT 1`).get(castId, at, at) ?? null;
}

/** A member's versions, newest first. */
export function versions(castId, { limit = 400 } = {}) {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE cast_id = ? ORDER BY id DESC LIMIT ?`).all(castId, limit);
}

export function get(id) {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE id = ?`).get(id) ?? null;
}

/** The newest version still standing: the one to build on, or null. */
export function newestStanding(castId) {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE cast_id = ? AND status != 'invalidated' ORDER BY id DESC LIMIT 1`).get(castId) ?? null;
}

/** Versions not yet invalidated, oldest first (the sweep's list). */
export function standingVersions() {
  return q(`SELECT ${COLUMNS} FROM story_standing WHERE status != 'invalidated' ORDER BY cast_id, id`).all();
}

/** Evidence of every version not yet invalidated: [{ versionId, eventId, at, source }]. */
export function standingEvidence() {
  return q(`SELECT e.version_id AS versionId, e.event_id AS eventId, e.at, e.source FROM story_standing_evidence e
    JOIN story_standing v ON v.id = e.version_id WHERE v.status != 'invalidated'`).all();
}

/** { versionId → [{ eventId, at, source }] } for these version ids. */
export function evidenceOf(versionIds) {
  const out = new Map();
  for (const id of versionIds) {
    out.set(id, q('SELECT event_id AS eventId, at, source FROM story_standing_evidence WHERE version_id = ? ORDER BY event_id').all(id));
  }
  return out;
}

/** The version and every version it was built on, newest first. */
export function chainOf(version) {
  const out = [];
  const seen = new Set();
  for (let v = version; v && !seen.has(v.id); v = posInt(v.supersedes) ? get(v.supersedes) : null) {
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/**
 * The new live version, in one transaction: the old live one closes at `at`, its text untouched.
 * `evidence`: [{ eventId, at, source }], its own only.
 */
export function addVersion({ castId, text, asOfEventId, at, supersedes = null, wordsSig = null, night = null, model = null, fellBack = false, evidence = [] }) {
  if (!CAST_ID_RE.test(String(castId))) fail('bad cast id');
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) fail('bad text');
  if (!posInt(asOfEventId) || !Number.isSafeInteger(at)) fail('bad as-of');
  const db = getDb();
  return db.transaction(() => {
    q("UPDATE story_standing SET status = 'superseded', valid_to = ? WHERE cast_id = ? AND status = 'live'").run(at, castId);
    const r = q(`INSERT INTO story_standing (cast_id, text, as_of_event_id, valid_from, supersedes, status, words_sig, night, model, fell_back, created_at)
      VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?)`).run(castId, text, asOfEventId, at, posInt(supersedes), wordsSig, night, model, fellBack ? 1 : 0, at);
    const id = Number(r.lastInsertRowid);
    const ins = q('INSERT OR IGNORE INTO story_standing_evidence (version_id, event_id, at, source) VALUES (?, ?, ?, ?)');
    for (const e of evidence) ins.run(id, e.eventId, e.at, e.source);
    return id;
  })();
}

/** Close a version for good. Its text stays, for the dashboard. */
export function invalidate(id, reason, at) {
  return q(`UPDATE story_standing SET status = 'invalidated', invalid_reason = ?, valid_to = COALESCE(valid_to, ?) WHERE id = ? AND status != 'invalidated'`)
    .run(String(reason).slice(0, 40), at, id).changes > 0;
}
