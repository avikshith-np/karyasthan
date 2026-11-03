import { getDb } from '../memory/db.js';
import { config } from '../utils/config.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { now } from './clock.js';

// The phone queue (spec 009 plan §R10/§D): messages the availability gate
// deferred ("he'll see it later"), persisted in life_queue so a restart loses
// nothing, and drained at his next phone check by phone.js — one catch-up
// reply per chat. A row holds what the drain needs and nothing more: the chat,
// the message id (the turn is rebuilt from the `messages` table), the minimal
// Baileys key for the read receipt, the gate features and his state when it
// was deferred. No message text is stored here.
//
// Lifecycle: pending → drained | dropped (muted / sender left / revoked) |
// expired (older than LIFE_QUEUE_MAX_AGE_HOURS: read, not answered). Every
// status change is guarded by status = 'pending', so a resolved row is never
// re-marked and a re-delivered message never resurrects one. Resolved rows are
// pruned after 7 days by maintenance.

export const AVAILABILITY_STATES = new Set(['free', 'light', 'busy', 'meeting', 'dnd', 'asleep']);
export const QUEUE_STATUSES = new Set(['pending', 'drained', 'dropped', 'expired']);

const JID_MAX = 128;
const JID_RE = /^[A-Za-z0-9._:+-]{1,96}@[a-z0-9.-]{1,30}$/;
const MSG_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_MAX_BYTES = 1024;
const REASON_MAX = 64;
const LIST_MAX = 500;
const PRUNE_DAYS = 7;

const fail = (msg) => { throw new Error(`queue: ${msg}`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function jidOk(jid) {
  return typeof jid === 'string' && jid.length <= JID_MAX && JID_RE.test(jid);
}

function toUnix(v, what) {
  if (!Number.isInteger(v) || v < 0) fail(`${what} must be integer unix seconds`);
  return v;
}

// Only the fields readMessages needs — never the message body.
function cleanKey(key, chatJid, msgId) {
  if (!isObj(key)) fail('msgKey must be a Baileys key object');
  if (key.id !== msgId) fail('msgKey.id must equal msgId');
  if (!jidOk(key.remoteJid)) fail('msgKey.remoteJid must be a jid');
  // A key for another chat (e.g. a LID vs phone-jid mix-up) could never be read later.
  if (key.remoteJid !== chatJid) fail('msgKey.remoteJid must equal chatJid');
  const out = { remoteJid: key.remoteJid, id: key.id, fromMe: key.fromMe === true };
  if (key.participant !== undefined && key.participant !== null && key.participant !== '') {
    if (!jidOk(key.participant)) fail('msgKey.participant must be a jid');
    out.participant = key.participant;
  }
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json, 'utf8') > KEY_MAX_BYTES) fail('msgKey is too large');
  return json;
}

// Reasons are short labels ('muted', 'left', 'revoked', 'max_age', …).
function cleanReason(reason) {
  const r = sanitizeWebContent(String(reason ?? '')).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, REASON_MAX);
  return r || null;
}

function toIds(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const out = [];
  for (const v of list) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) fail('ids must be positive integers');
    out.push(n);
  }
  return [...new Set(out)];
}

/** life_queue row → item (camelCase, key parsed, flags as booleans). */
export function rowToItem(row) {
  if (!row) return null;
  let msgKey = null;
  try { msgKey = JSON.parse(row.msg_key_json); } catch { msgKey = null; }
  return {
    id: row.id,
    chatJid: row.chat_jid,
    msgId: row.msg_id,
    senderJid: row.sender_jid ?? null,
    msgKey: isObj(msgKey) ? msgKey : null,
    isDm: row.is_dm === 1,
    isMention: row.is_mention === 1,
    isQuestion: row.is_question === 1,
    availability: row.availability,
    enqueuedAt: row.enqueued_at,
    status: row.status,
    reason: row.reason ?? null,
    drainedAt: row.drained_at ?? null,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Queue a deferred message. Idempotent on (chat_jid, msg_id): a second enqueue
 * of the same message — pending or already resolved — changes nothing and
 * returns the existing row with inserted:false. Returns { id, inserted, item }.
 */
export function enqueue({
  chatJid, msgId, senderJid = null, msgKey,
  isDm = false, isMention = false, isQuestion = false, availability, enqueuedAt,
} = {}) {
  if (!jidOk(chatJid)) fail('chatJid must be a jid');
  if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) fail('msgId must be a message id');
  if (senderJid !== null && senderJid !== undefined && !jidOk(senderJid)) fail('senderJid must be a jid');
  if (!AVAILABILITY_STATES.has(availability)) fail(`unknown availability "${String(availability).slice(0, 20)}"`);
  const keyJson = cleanKey(msgKey, chatJid, msgId);
  const at = toUnix(enqueuedAt === undefined ? now() : enqueuedAt, 'enqueuedAt');

  const db = getDb();
  const info = db.prepare(`
    INSERT OR IGNORE INTO life_queue
      (chat_jid, msg_id, sender_jid, msg_key_json, is_dm, is_mention, is_question, availability, enqueued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatJid, msgId, senderJid ?? null, keyJson, isDm ? 1 : 0, isMention ? 1 : 0, isQuestion ? 1 : 0, availability, at);
  const item = rowToItem(db.prepare('SELECT * FROM life_queue WHERE chat_jid = ? AND msg_id = ?').get(chatJid, msgId));
  return { id: item.id, inserted: info.changes === 1, item };
}

// Shared status change: only pending rows move. `sel` is an id / id array, or
// { chatJid, maxId? } — pass the largest id the drain saw, so a message queued
// while the catch-up turn ran stays pending for the next check.
function resolve(status, sel, { reason = null, at } = {}) {
  const when = toUnix(at === undefined ? now() : at, 'at');
  const db = getDb();
  const sets = status === 'drained'
    ? 'status = ?, reason = ?, drained_at = ?'
    : 'status = ?, reason = ?';
  const setArgs = status === 'drained' ? [status, reason, when] : [status, reason];

  if (isObj(sel) && sel.chatJid !== undefined) {
    if (!jidOk(sel.chatJid)) fail('chatJid must be a jid');
    const where = ["status = 'pending'", 'chat_jid = ?'];
    const args = [sel.chatJid];
    if (sel.maxId !== undefined && sel.maxId !== null) { where.push('id <= ?'); args.push(toIds(sel.maxId)[0]); }
    return db.prepare(`UPDATE life_queue SET ${sets} WHERE ${where.join(' AND ')}`).run(...setArgs, ...args).changes;
  }
  const ids = toIds(sel);
  if (!ids.length) return 0;
  return db.prepare(`UPDATE life_queue SET ${sets} WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(', ')})`)
    .run(...setArgs, ...ids).changes;
}

/** Pending → drained (answered by a catch-up turn). Returns rows changed. */
export function markDrained(sel, { at } = {}) {
  return resolve('drained', sel, { at });
}

/** Pending → dropped with a reason ('muted', 'left', 'revoked'). Returns rows changed. */
export function markDropped(sel, reason, { at } = {}) {
  const r = cleanReason(reason);
  if (!r) fail('markDropped needs a reason');
  return resolve('dropped', sel, { reason: r, at });
}

/** Pending → expired (read, not answered). Returns rows changed. */
export function markExpired(sel, reason = 'max_age', { at } = {}) {
  return resolve('expired', sel, { reason: cleanReason(reason) || 'max_age', at });
}

/**
 * Expire pending items queued more than `maxAgeHours` ago (default
 * LIFE_QUEUE_MAX_AGE_HOURS). Returns the expired items — phone.js still marks
 * them read at the check ("seen, too late to answer").
 */
export function expireOlderThan(maxAgeHours = config.life.queueMaxAgeHours, { at } = {}) {
  const hours = Number(maxAgeHours);
  if (!Number.isFinite(hours) || hours <= 0) fail('maxAgeHours must be a positive number');
  const when = toUnix(at === undefined ? now() : at, 'at');
  const cutoff = when - Math.round(hours * 3600);
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM life_queue WHERE status = 'pending' AND enqueued_at < ? ORDER BY enqueued_at, id`)
      .all(cutoff);
    if (!rows.length) return [];
    markExpired(rows.map(r => r.id), 'max_age', { at: when });
    return rows.map(r => rowToItem({ ...r, status: 'expired', reason: 'max_age' }));
  })();
}

/**
 * Delete resolved rows (drained/dropped/expired) resolved — or, lacking a
 * drain time, queued — more than `olderThanDays` ago. Pending rows are never
 * pruned. Returns rows deleted.
 */
export function prune({ olderThanDays = PRUNE_DAYS, at } = {}) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) fail('olderThanDays must be a non-negative number');
  const when = toUnix(at === undefined ? now() : at, 'at');
  return getDb().prepare(`
    DELETE FROM life_queue WHERE status != 'pending' AND COALESCE(drained_at, enqueued_at) < ?
  `).run(when - Math.round(days * 86400)).changes;
}

/**
 * Purge hook (eventLog.redactPerson ← 006 purgePerson): delete every row the
 * person sent and every row of their DM chat, in any status. Returns rows deleted.
 */
export function deleteForPerson(personJid) {
  if (!jidOk(personJid)) fail('personJid must be a jid');
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'life_queue'").get();
  if (!exists) return 0;
  return db.prepare('DELETE FROM life_queue WHERE sender_jid = ? OR chat_jid = ?').run(personJid, personJid).changes;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** One item by id, or null. */
export function getItem(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return rowToItem(getDb().prepare('SELECT * FROM life_queue WHERE id = ?').get(n));
}

/** True when (chatJid, msgId) is queued and still pending. */
export function isPending(chatJid, msgId) {
  return !!getDb().prepare("SELECT 1 FROM life_queue WHERE chat_jid = ? AND msg_id = ? AND status = 'pending'")
    .get(String(chatJid ?? ''), String(msgId ?? ''));
}

/**
 * Chats with pending items, oldest first — the drain order and the
 * dashboard's queue.byChat: [{ chatJid, count, oldestAt, newestAt, maxId,
 * mentions, dms }].
 */
export function pendingChats() {
  return getDb().prepare(`
    SELECT chat_jid AS chatJid, COUNT(*) AS count, MIN(enqueued_at) AS oldestAt, MAX(enqueued_at) AS newestAt,
           MAX(id) AS maxId, SUM(is_mention) AS mentions, SUM(is_dm) AS dms
    FROM life_queue WHERE status = 'pending'
    GROUP BY chat_jid ORDER BY oldestAt, MIN(id)
  `).all();
}

/**
 * Pending items, oldest first. With `chatJid`, that chat's items; without,
 * every pending item. `limit` 1..500 (500).
 */
export function listPendingByChat(chatJid, { limit = LIST_MAX } = {}) {
  const lim = Math.min(LIST_MAX, Math.max(1, Math.floor(Number(limit)) || LIST_MAX));
  const db = getDb();
  if (chatJid === undefined || chatJid === null) {
    return db.prepare("SELECT * FROM life_queue WHERE status = 'pending' ORDER BY enqueued_at, id LIMIT ?")
      .all(lim).map(rowToItem);
  }
  return db.prepare("SELECT * FROM life_queue WHERE status = 'pending' AND chat_jid = ? ORDER BY enqueued_at, id LIMIT ?")
    .all(String(chatJid), lim).map(rowToItem);
}

/** Pending count — one chat's, or the whole queue's. */
export function pendingCount(chatJid) {
  const db = getDb();
  if (chatJid === undefined || chatJid === null) {
    return db.prepare("SELECT COUNT(*) AS n FROM life_queue WHERE status = 'pending'").get().n;
  }
  return db.prepare("SELECT COUNT(*) AS n FROM life_queue WHERE status = 'pending' AND chat_jid = ?").get(String(chatJid)).n;
}
