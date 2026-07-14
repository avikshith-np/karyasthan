import { getDb } from './db.js';

const INSERT_MSG = `INSERT OR IGNORE INTO messages
  (id, group_jid, sender_jid, sender_name, content, message_type, quoted_id, quoted_content, quoted_participant, is_from_self, timestamp, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// rowid DESC is a deterministic tie-breaker: WhatsApp timestamps are second-resolution,
// so without it same-second messages sort non-deterministically and adjacent A/B turns
// can swap, which scrambles the turn order the LLM uses to attribute who said what.
const RECENT_MSGS = `SELECT * FROM messages WHERE group_jid = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`;

const RECENT_DM_MSGS = `SELECT * FROM messages
  WHERE group_jid = ? AND (sender_jid = ? OR is_from_self = 1)
  ORDER BY timestamp DESC, rowid DESC LIMIT ?`;

const SEARCH_MSGS = `SELECT m.* FROM messages_fts f
  JOIN messages m ON m.rowid = f.rowid
  WHERE messages_fts MATCH ? AND m.group_jid = ?
  ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`;

const COUNT_IN_WINDOW = `SELECT COUNT(*) as count FROM messages
  WHERE group_jid = ? AND is_from_self = 1 AND timestamp > ?`;

const LAST_SELF_MSG = `SELECT * FROM messages
  WHERE group_jid = ? AND is_from_self = 1
  ORDER BY timestamp DESC LIMIT 1`;

export function storeMessage(msg) {
  const db = getDb();
  return db.prepare(INSERT_MSG).run(
    msg.id,
    msg.groupJid,
    msg.senderJid,
    msg.senderName || null,
    msg.content || null,
    msg.messageType || 'text',
    msg.quotedId || null,
    msg.quotedContent || null,
    msg.quotedParticipant || null,
    msg.isFromSelf ? 1 : 0,
    msg.timestamp,
    JSON.stringify(msg.metadata || {})
  );
}

export function getRecentMessages(groupJid, limit = 50) {
  const db = getDb();
  return db.prepare(RECENT_MSGS).all(groupJid, limit).reverse(); // oldest first
}

export function getRecentDmMessages(chatJid, personJid, limit = 30) {
  const db = getDb();
  return db.prepare(RECENT_DM_MSGS).all(chatJid, personJid, limit).reverse();
}

export function searchMessages(query, groupJid, limit = 20) {
  const db = getDb();
  return db.prepare(SEARCH_MSGS).all(query, groupJid, limit);
}

export function countSelfMessagesInWindow(groupJid, sinceTimestamp) {
  const db = getDb();
  return db.prepare(COUNT_IN_WINDOW).get(groupJid, sinceTimestamp).count;
}

export function getLastSelfMessage(groupJid) {
  const db = getDb();
  return db.prepare(LAST_SELF_MSG).get(groupJid) || null;
}
