// The claim check's store (plan 020 E3): the only door to story_check_runs and story_check_claims. Synchronous, static SQL,
// nothing logged. The caller (worker.js) keeps every failure away from the writers.
import { getDb } from '../../../memory/db.js';

export const RETENTION_DAYS = 90;
const DAY = 86400;

const stmtCache = new WeakMap();
function q(sql) {
  const db = getDb();
  let m = stmtCache.get(db);
  if (!m) { m = new Map(); stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}

const parse = (v) => {
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
};
const row = (r) => (r ? {
  id: r.id, writer: r.writer, rowId: r.row_id, eventId: r.event_id, sha: r.output_sha, speaker: r.speaker, chatOrigin: r.chat_origin === 1,
  mode: r.mode, status: r.status, skipReason: r.skip_reason, rewrote: r.rewrote === 1, cut: r.cut === 1,
  grounding: parse(r.grounding_json), at: r.at, model: r.model, createdAt: r.created_at, checkedAt: r.checked_at,
} : null);

export const hasTables = () => {
  try { return q("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('story_check_runs','story_check_claims')").get().n === 2; } catch { return false; }
};

export const inTransaction = (fn) => getDb().transaction(fn)();

/** A new run, or null when this exact output already has one. Older runs of the same row go: it holds new words now. */
export function insertRun({ writer, rowId, eventId = null, sha, speaker, chatOrigin = false, mode = 'shadow', grounding = null, at, createdAt, status = 'pending', rewrote = false }) {
  return inTransaction(() => {
    for (const old of q('SELECT id FROM story_check_runs WHERE writer = ? AND row_id = ? AND output_sha != ?').all(writer, rowId, sha)) deleteRun(old.id);
    const info = q(`INSERT OR IGNORE INTO story_check_runs (writer, row_id, event_id, output_sha, speaker, chat_origin, mode, status, rewrote, grounding_json, at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(writer, rowId, eventId, sha, speaker, chatOrigin ? 1 : 0, mode, status, rewrote ? 1 : 0, grounding ? JSON.stringify(grounding) : null, at, createdAt);
    return info.changes ? Number(info.lastInsertRowid) : null;
  });
}

export const getRun = (id) => row(q('SELECT * FROM story_check_runs WHERE id = ?').get(id));
export const listPending = (limit = 5) => q("SELECT * FROM story_check_runs WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit).map(row);
export const claimRun = (id) => q("UPDATE story_check_runs SET status = 'running' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
export const resetRunning = () => q("UPDATE story_check_runs SET status = 'pending' WHERE status = 'running' AND grounding_json IS NOT NULL").run().changes;

/** Close a run: its verdicts in, the sheet lines gone. Chat-made output keeps verdicts and codes, never words. */
export function finishRun(id, { status, skipReason = null, model = null, cut = false, claims = [], at }) {
  return inTransaction(() => {
    const r = q('SELECT chat_origin FROM story_check_runs WHERE id = ?').get(id);
    if (!r) return false;
    const words = r.chat_origin !== 1;
    q('DELETE FROM story_check_claims WHERE run_id = ?').run(id);
    for (const c of claims) {
      q('INSERT INTO story_check_claims (run_id, source, about, claim, verdict, reason, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, c.source, c.about, words ? c.claim ?? null : null, c.verdict, String(c.reason).slice(0, 24), words ? c.evidence ?? null : null);
    }
    q(`UPDATE story_check_runs SET status = ?, skip_reason = ?, model = ?, cut = ?, grounding_json = NULL, checked_at = ? WHERE id = ?`)
      .run(status, skipReason, model, cut ? 1 : 0, at, id);
    return true;
  });
}

export function deleteRun(id) {
  q('DELETE FROM story_check_claims WHERE run_id = ?').run(id);
  return q('DELETE FROM story_check_runs WHERE id = ?').run(id).changes > 0;
}

/** Run keys for the sweep, newest first; with `before`, those older than that id. */
export const listKeys = (limit = 1000) => q('SELECT id, writer, row_id AS rowId, output_sha AS sha FROM story_check_runs ORDER BY id DESC LIMIT ?').all(limit);
export const listKeysBefore = (before, limit = 1000) => q('SELECT id, writer, row_id AS rowId, output_sha AS sha FROM story_check_runs WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);

export function prune(at) {
  const before = at - RETENTION_DAYS * DAY;
  return inTransaction(() => {
    const ids = q('SELECT id FROM story_check_runs WHERE at < ?').all(before);
    for (const { id } of ids) deleteRun(id);
    return ids.length;
  });
}

/** Counts per writer + speaker since `since`. */
export function counts(since) {
  const runs = q(`SELECT writer, speaker, status, COUNT(*) AS n FROM story_check_runs WHERE at >= ? GROUP BY writer, speaker, status`).all(since);
  const claims = q(`SELECT r.writer, r.speaker, c.source, c.verdict, COUNT(*) AS n
    FROM story_check_claims c JOIN story_check_runs r ON r.id = c.run_id
    WHERE r.at >= ? GROUP BY r.writer, r.speaker, c.source, c.verdict`).all(since);
  const skips = q(`SELECT skip_reason AS reason, COUNT(*) AS n FROM story_check_runs WHERE at >= ? AND skip_reason IS NOT NULL GROUP BY skip_reason`).all(since);
  const pending = q(`SELECT COUNT(*) AS n FROM story_check_runs WHERE status IN ('pending','running')`).get().n;
  const rewrites = q(`SELECT COUNT(*) AS n FROM story_check_runs WHERE at >= ? AND rewrote = 1`).get(since).n;
  return { runs, claims, skips, pending, rewrites };
}

/** The newest contradictions. */
export const lastContradictions = (limit = 30) => q(`SELECT c.id, c.source, c.about, c.claim, c.reason, c.evidence,
    r.id AS runId, r.writer, r.row_id AS rowId, r.output_sha AS sha, r.speaker, r.chat_origin AS chatOrigin, r.at, r.mode
  FROM story_check_claims c JOIN story_check_runs r ON r.id = c.run_id
  WHERE c.verdict = 'contradicted' ORDER BY r.id DESC, c.id LIMIT ?`).all(limit);
