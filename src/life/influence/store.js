// Chat influence store (spec 012 plan §1.3): the ONLY SQL on the v12 tables
// (chat_influence_items, chat_influence_pending_withdrawals, chat_influence_state)
// outside the migration — test:privacy's guard and 00-guards check it. Rows hold
// evidence pointers (chat + message id), codes and world ids; never message text.
//
// Also the one read of the usage ledger the daily caps need (ledgerCalls): unlike
// usage.getUsageByCaller it tells "the read failed" (null → the caller treats the
// cap as reached, fail closed) from "no rows" (0).

import { getDb } from '../../memory/db.js';

const KINDS = new Set(['mood', 'invite', 'live', 'advice']);
const STATUSES = new Set(['held', 'active', 'withdrawn', 'reverted', 'pending', 'approved', 'rejected', 'expired']);
const ORIGIN_KINDS = new Set(['group', 'dm']);
const CAUSES = new Set(['forget', 'revoke', 'edit']);
const LIST_MAX = 500;
const FORMS_MAX = 32;
const IDS_MAX = 200;
const STR_MAX = 128;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = STR_MAX) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const strList = (v, max) => [...new Set((Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x).map(x => x.slice(0, STR_MAX)))].slice(0, max);

function parseJson(s) {
  if (typeof s !== 'string') return null;
  try { const v = JSON.parse(s); return isObj(v) ? v : null; } catch { return null; }
}

function rowOut(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, chatJid: r.chat_jid, originKind: r.origin_kind, msgId: r.msg_id, senderJid: r.sender_jid,
    contentHash: r.content_hash, held: parseJson(r.held), pointerEventId: r.pointer_event_id, decisionId: r.decision_id,
    category: r.category, status: r.status, withdrawReason: r.withdraw_reason, followupStatus: r.followup_status,
    createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
  };
}

// ── Items ─────────────────────────────────────────────────────────────────

/** Insert one item. → the row */
export function insertItem({ kind, chatJid, originKind, msgId, senderJid = null, contentHash = null, held = null,
  pointerEventId = null, decisionId = null, category = null, status, createdAt, expiresAt = null } = {}) {
  if (!KINDS.has(kind) || !STATUSES.has(status) || !ORIGIN_KINDS.has(originKind)) throw new Error('influence store: bad item');
  if (!str(chatJid) || !str(msgId) || !Number.isSafeInteger(createdAt)) throw new Error('influence store: bad item');
  const info = getDb().prepare(`
    INSERT INTO chat_influence_items (kind, chat_jid, origin_kind, msg_id, sender_jid, content_hash, held,
      pointer_event_id, decision_id, category, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, str(chatJid), originKind, str(msgId), str(senderJid), str(contentHash, 64),
    isObj(held) ? JSON.stringify(held).slice(0, 512) : null, int(pointerEventId), int(decisionId), str(category, 24), status, createdAt, int(expiresAt));
  return getItem(Number(info.lastInsertRowid));
}

export function getItem(id) {
  if (!Number.isSafeInteger(id)) return null;
  return rowOut(getDb().prepare('SELECT * FROM chat_influence_items WHERE id = ?').get(id));
}

/** Held rows of one chat (optionally only these message ids), oldest first. */
export function heldFor(chatJid, msgIds = null) {
  const db = getDb();
  if (Array.isArray(msgIds)) {
    const ids = strList(msgIds, IDS_MAX);
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM chat_influence_items WHERE status = 'held' AND chat_jid = ?
      AND msg_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(String(chatJid), JSON.stringify(ids)).map(rowOut);
  }
  return db.prepare(`SELECT * FROM chat_influence_items WHERE status = 'held' AND chat_jid = ? ORDER BY id`)
    .all(String(chatJid)).map(rowOut);
}

/** A held row was applied: active with its pointer (and, for a cancel, the decision it cancels). → true when it was still held */
export function activateHeld(id, pointerEventId, { decisionId = null } = {}) {
  return getDb().prepare(`UPDATE chat_influence_items SET status = 'active', held = NULL, pointer_event_id = ?,
    decision_id = COALESCE(?, decision_id) WHERE id = ? AND status = 'held'`).run(int(pointerEventId), int(decisionId), id).changes === 1;
}

export function deleteItem(id) {
  return getDb().prepare('DELETE FROM chat_influence_items WHERE id = ?').run(id).changes;
}

/** Held rows older than `before` (never read) are dropped. → count */
export function expireHeld(before) {
  return getDb().prepare(`DELETE FROM chat_influence_items WHERE status = 'held' AND created_at < ?`).run(Math.floor(before)).changes;
}

/** Active rows created since `since` (the evidence sweep), newest first. */
export function activeSince(since, limit = LIST_MAX) {
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE status = 'active' AND created_at >= ?
    ORDER BY id DESC LIMIT ?`).all(Math.floor(since), Math.min(LIST_MAX, limit)).map(rowOut);
}

/** Mark rows withdrawn (DB half of a deletion; a pending advice row too). → count */
export function markWithdrawn(ids, reason) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Number.isSafeInteger);
  if (!list.length) return 0;
  return getDb().prepare(`UPDATE chat_influence_items SET status = 'withdrawn', withdraw_reason = ?
    WHERE status IN ('active', 'pending') AND id IN (SELECT value FROM json_each(?))`).run(str(reason, 32), JSON.stringify(list)).changes;
}

/**
 * Withdrawn rows whose world pointer still needs reverting. Advice has no
 * pointer (it never touched his world): it stays `withdrawn` and is not listed.
 */
export function listWithdrawn(limit = LIST_MAX) {
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE status = 'withdrawn' AND pointer_event_id IS NOT NULL
    ORDER BY id LIMIT ?`).all(Math.min(LIST_MAX, limit)).map(rowOut);
}

export function markReverted(id) {
  return getDb().prepare(`UPDATE chat_influence_items SET status = 'reverted' WHERE id = ? AND status = 'withdrawn'`).run(id).changes;
}

/**
 * The DB half of a forget/revoke/edit in one chat: active rows (and pending
 * advice) of these chat forms naming one of msgIds (or, `window` set, created
 * inside it) → withdrawn; held rows of them are deleted outright. Runs on the caller's connection
 * (inside 006's transaction). → { withdrawn, held }
 */
export function withdrawMatching(db, { chatForms, msgIds, window = null, reason }) {
  const forms = JSON.stringify(strList(chatForms, FORMS_MAX));
  const ids = JSON.stringify(strList(msgIds, IDS_MAX));
  const lo = window ? Math.floor(window.lo) : null;
  const hi = window ? Math.floor(window.hi) : null;
  const where = `chat_jid IN (SELECT value FROM json_each(?)) AND (msg_id IN (SELECT value FROM json_each(?))
    OR (? IS NOT NULL AND created_at BETWEEN ? AND ?))`;
  const held = db.prepare(`DELETE FROM chat_influence_items WHERE status = 'held' AND ${where}`).run(forms, ids, lo, lo, hi).changes;
  const withdrawn = db.prepare(`UPDATE chat_influence_items SET status = 'withdrawn', withdraw_reason = ?
    WHERE status IN ('active', 'pending') AND ${where}`).run(str(reason, 32), forms, ids, lo, lo, hi).changes;
  return { withdrawn, held };
}

/** 006 purge: every row sent by these forms, or of their DM. → count */
export function deleteForPerson(db, forms) {
  const f = JSON.stringify(strList(forms, FORMS_MAX));
  return db.prepare(`DELETE FROM chat_influence_items WHERE sender_jid IN (SELECT value FROM json_each(?))
    OR (origin_kind = 'dm' AND chat_jid IN (SELECT value FROM json_each(?)))`).run(f, f).changes;
}

/** Item counts by kind/status since `since` (dashboard). */
export function countsSince(since) {
  return getDb().prepare(`SELECT kind, status, COUNT(*) AS n FROM chat_influence_items WHERE created_at >= ?
    GROUP BY kind, status`).all(Math.floor(since));
}

/** Rows by pointer event id (the dashboard's blip list). */
export function itemsByPointers(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Number.isSafeInteger).slice(0, IDS_MAX);
  if (!list.length) return [];
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE pointer_event_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(list)).map(rowOut);
}

// ── Invitations (P2) ──────────────────────────────────────────────────────

const FOLLOWUP = new Set(['due', 'attempted', 'sent', 'skipped', 'dropped']);

/** An invitation row opened its decision. → true when the row was still active */
export function setItemDecision(id, decisionId) {
  return getDb().prepare(`UPDATE chat_influence_items SET decision_id = ? WHERE id = ? AND status = 'active'`)
    .run(int(decisionId), id).changes === 1;
}

/** The invitation row behind a decision, or null. */
export function itemByDecision(decisionId) {
  if (!Number.isSafeInteger(decisionId)) return null;
  return rowOut(getDb().prepare(`SELECT * FROM chat_influence_items WHERE kind = 'invite' AND category IS NULL
    AND decision_id = ? ORDER BY id DESC LIMIT 1`).get(decisionId));
}

/** Invitations that landed (a pointer; not a cancel) since `since`: { total, byChat: { chatJid: n } }. */
export function inviteCountsSince(since) {
  const rows = getDb().prepare(`SELECT chat_jid, COUNT(*) AS n FROM chat_influence_items WHERE kind = 'invite'
    AND category IS NULL AND pointer_event_id IS NOT NULL AND created_at >= ? GROUP BY chat_jid`).all(Math.floor(since));
  const byChat = {};
  let total = 0;
  for (const r of rows) { byChat[r.chat_jid] = r.n; total += r.n; }
  return { total, byChat };
}

/** Recent invitation rows (dashboard), newest first. */
export function listInvites(limit = 50) {
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE kind = 'invite' AND category IS NULL
    AND decision_id IS NOT NULL ORDER BY id DESC LIMIT ?`).all(Math.min(LIST_MAX, Math.max(1, limit))).map(rowOut);
}

/**
 * Move a row's follow-up state (the phone's attempt accounting). `from` (list)
 * guards the transition; null/[] = from any. → true when it changed
 */
export function setFollowup(id, status, from = null) {
  if (!FOLLOWUP.has(status) || !Number.isSafeInteger(id)) return false;
  const guard = Array.isArray(from) && from.length;
  const list = guard ? from.filter(x => x === null || FOLLOWUP.has(x)) : [];
  const allowNull = guard && list.includes(null);
  const vals = JSON.stringify(list.filter(x => x !== null));
  return getDb().prepare(`UPDATE chat_influence_items SET followup_status = ? WHERE id = ?
    ${guard ? `AND (followup_status IN (SELECT value FROM json_each(?))${allowNull ? ' OR followup_status IS NULL' : ''})` : ''}`)
    .run(...(guard ? [status, id, vals] : [status, id])).changes === 1;
}

// ── Advice (P3): the owner's tray, no world pointer ───────────────────────

const ADVICE_LIST_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'withdrawn']);

/** Pending advice rows (not expired at `at`) in one category. */
export function advicePendingCount(category, at) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM chat_influence_items WHERE kind = 'advice' AND status = 'pending'
    AND category = ? AND (expires_at IS NULL OR expires_at > ?)`).get(String(category), Math.floor(at)).n;
}

/** Does this sender already have pending advice in this category? */
export function advicePendingBySender(category, senderJid, at) {
  return !!getDb().prepare(`SELECT 1 FROM chat_influence_items WHERE kind = 'advice' AND status = 'pending'
    AND category = ? AND sender_jid = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`)
    .get(String(category), String(senderJid), Math.floor(at));
}

/** A held advice row was read: it joins the tray. → true when it was still held */
export function promoteHeldAdvice(id, { category, expiresAt }) {
  return getDb().prepare(`UPDATE chat_influence_items SET status = 'pending', held = NULL, category = ?, expires_at = ?
    WHERE id = ? AND status = 'held' AND kind = 'advice'`).run(str(category, 24), int(expiresAt), id).changes === 1;
}

/** Every pending advice row (the evidence sweep; a handful by the per-category cap). */
export function pendingAdvice(limit = LIST_MAX) {
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE kind = 'advice' AND status = 'pending' ORDER BY id LIMIT ?`)
    .all(Math.min(LIST_MAX, limit)).map(rowOut);
}

/** Pending advice past its expiry → expired. → count */
export function expireAdvice(at) {
  return getDb().prepare(`UPDATE chat_influence_items SET status = 'expired' WHERE kind = 'advice' AND status = 'pending'
    AND expires_at IS NOT NULL AND expires_at <= ?`).run(Math.floor(at)).changes;
}

/** Advice rows for the dashboard (one status or all), newest first. */
export function listAdvice({ status = null, limit = 50 } = {}) {
  const n = Math.min(LIST_MAX, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
  if (status !== null && !ADVICE_LIST_STATUSES.has(status)) return [];
  if (status) {
    return getDb().prepare(`SELECT * FROM chat_influence_items WHERE kind = 'advice' AND status = ? ORDER BY id DESC LIMIT ?`)
      .all(status, n).map(rowOut);
  }
  return getDb().prepare(`SELECT * FROM chat_influence_items WHERE kind = 'advice' AND status <> 'held' ORDER BY id DESC LIMIT ?`)
    .all(n).map(rowOut);
}

/** The owner's verdict on a pending, unexpired advice row (approved | rejected). → true when it changed */
export function decideAdvice(id, status, { by, at }) {
  if (status !== 'approved' && status !== 'rejected') return false;
  return getDb().prepare(`UPDATE chat_influence_items SET status = ?, decided_at = ?, decided_by = ?
    WHERE id = ? AND kind = 'advice' AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`)
    .run(status, Math.floor(at), str(by, 60), id, Math.floor(at)).changes === 1;
}

// ── Pending withdrawals (a failed hook, persisted) ────────────────────────

export function addPendingWithdrawal(db, { cause, chatForms, msgIds, msgTs = null, at }) {
  if (!CAUSES.has(cause)) return null;
  return Number(db.prepare(`INSERT INTO chat_influence_pending_withdrawals (cause, chat_forms, msg_ids, msg_ts, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(cause, JSON.stringify(strList(chatForms, FORMS_MAX)), JSON.stringify(strList(msgIds, IDS_MAX)),
    Number.isFinite(msgTs) ? Math.floor(msgTs) : null, Math.floor(at)).lastInsertRowid);
}

export function listPendingWithdrawals() {
  return getDb().prepare('SELECT * FROM chat_influence_pending_withdrawals ORDER BY id LIMIT ?').all(LIST_MAX).map(r => ({
    id: r.id, cause: r.cause, chatForms: safeList(r.chat_forms), msgIds: safeList(r.msg_ids), msgTs: r.msg_ts, createdAt: r.created_at,
  }));
}

function safeList(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function deletePendingWithdrawal(id) {
  return getDb().prepare('DELETE FROM chat_influence_pending_withdrawals WHERE id = ?').run(id).changes;
}

export function countPendingWithdrawals() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM chat_influence_pending_withdrawals').get().n;
}

// ── State ─────────────────────────────────────────────────────────────────

export function getStateValue(key, db = getDb()) {
  const row = db.prepare('SELECT value FROM chat_influence_state WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

export function setStateValue(key, value, db = getDb()) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM chat_influence_state WHERE key = ?').run(String(key));
    return;
  }
  db.prepare(`INSERT INTO chat_influence_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(key), String(value).slice(0, 200));
}

/** The state keys of this prefix. */
export function stateKeys(prefix, db = getDb()) {
  const p = String(prefix);
  return db.prepare(`SELECT key FROM chat_influence_state WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT ${LIST_MAX}`).pluck().all(p.length, p);
}

/** Delete the keys of this prefix that sort before `key` (dated keys: the older days). */
export function deleteStateBefore(prefix, key, db = getDb()) {
  return db.prepare(`DELETE FROM chat_influence_state WHERE key >= ? AND key < ?`).run(String(prefix), String(key)).changes;
}

// ── Perception outcomes (per day; codes and counts only) ──────────────────
//
// One row per day + outcome + reason in chat_influence_state:
// key `outcome:<YYYY-MM-DD>:<outcome>:<reason>` → a count. Survives a restart;
// days older than OUTCOME_DAYS are pruned on write.

export const OUTCOMES = Object.freeze(['applied', 'held', 'dropped', 'nothing']);
const OUTCOME_SET = new Set(OUTCOMES);
const OUTCOME_DAYS = 7;
const CODE_RE = /^[a-z0-9_]{1,32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Count one perception outcome for `dayKey`. → true when counted. */
export function bumpOutcome(dayKey, outcome, reason) {
  if (!DAY_RE.test(String(dayKey)) || !OUTCOME_SET.has(outcome)) return false;
  const code = CODE_RE.test(String(reason)) ? String(reason) : 'other';
  const db = getDb();
  db.prepare(`INSERT INTO chat_influence_state (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).run(`outcome:${dayKey}:${outcome}:${code}`);
  const cutoff = new Date(Date.parse(`${dayKey}T00:00:00Z`) - OUTCOME_DAYS * 86400_000).toISOString().slice(0, 10);
  db.prepare(`DELETE FROM chat_influence_state WHERE key LIKE 'outcome:%' AND key < ?`).run(`outcome:${cutoff}`);
  return true;
}

/** One day's outcome counts → { applied, held, dropped, nothing, reasons: { '<outcome>:<reason>': n } }. */
export function outcomesFor(dayKey) {
  const out = { applied: 0, held: 0, dropped: 0, nothing: 0, reasons: {} };
  if (!DAY_RE.test(String(dayKey))) return out;
  const rows = getDb().prepare(`SELECT key, value FROM chat_influence_state WHERE key LIKE ? ORDER BY key`).all(`outcome:${dayKey}:%`);
  for (const r of rows) {
    const [, , outcome, reason] = String(r.key).split(':');
    const n = Number.parseInt(r.value, 10);
    if (!OUTCOME_SET.has(outcome) || !(n > 0)) continue;
    out[outcome] += n;
    out.reasons[`${outcome}:${reason}`] = n;
  }
  return out;
}

// ── Ledger ────────────────────────────────────────────────────────────────

/** llm_usage rows for exactly `caller` since `since`, or null when the read failed. */
export function ledgerCalls(caller, since) {
  try {
    return getDb().prepare('SELECT COUNT(*) AS n FROM llm_usage WHERE caller = ? AND ts >= ?')
      .get(String(caller).slice(0, 60), Math.max(0, Math.floor(since))).n;
  } catch {
    return null;
  }
}
