import { getDb } from './db.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid } from './identity.js';

const INSERT_MSG = `INSERT OR IGNORE INTO messages
  (id, group_jid, sender_jid, sender_name, content, message_type, quoted_id, quoted_content, quoted_participant, is_from_self, timestamp, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// rowid DESC is a deterministic tie-breaker: WhatsApp timestamps are second-resolution,
// so without it same-second messages sort non-deterministically and adjacent A/B turns
// can swap, which scrambles the turn order the LLM uses to attribute who said what.
const RECENT_MSGS = `SELECT * FROM messages WHERE group_jid = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?`;

// Prompt-facing reads also drop messages fenced by "forget that" (no_learn) and
// disappearing messages past their timer (maintenance deletes those within 6 h).
const PROMPT_VISIBLE = `COALESCE(no_learn, 0) = 0 AND (expires_at IS NULL OR expires_at > unixepoch())`;

const SEARCH_MSGS = `SELECT m.* FROM messages_fts f
  JOIN messages m ON m.rowid = f.rowid
  WHERE messages_fts MATCH ? AND m.group_jid = ?
  ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`;

const COUNT_IN_WINDOW = `SELECT COUNT(*) as count FROM messages
  WHERE group_jid = ? AND is_from_self = 1 AND timestamp > ?`;

// Hourly global cap (R10): the bot's own messages across all GROUP chats. The
// '%@g.us' filter lives here, not in the caller, so DMs can never be counted.
const COUNT_SELF_GROUP_SINCE = `SELECT COUNT(*) as count FROM messages
  WHERE is_from_self = 1 AND group_jid LIKE '%@g.us' AND timestamp > ?`;

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

// A DM is one conversation across the person's JID forms. Messages are stored under
// the chat id they arrived on (sends keep using it) and a merge re-keys older rows to
// the canonical id, so a person's DM can sit under both their PN and LID: read every
// form. Group chats are read by their own JID only.
function chatForms(chatJid) {
  if (typeof chatJid !== 'string' || !isPersonJid(chatJid)) return [chatJid];
  const bare = bareJid(chatJid);
  const person = resolvePerson(bare);
  return [...new Set([chatJid, bare, ...(person ? identitiesOf(person) : [])])];
}

function recentIn(chatJid, limit, extra = '', extraParams = []) {
  const forms = chatForms(chatJid);
  if (forms.length === 1 && !extra) return getDb().prepare(RECENT_MSGS).all(forms[0], limit);
  return getDb().prepare(`SELECT * FROM messages WHERE group_jid IN (${forms.map(() => '?').join(',')}) ${extra}
    ORDER BY timestamp DESC, rowid DESC LIMIT ?`).all(...forms, ...extraParams, limit);
}

export function getRecentMessages(groupJid, limit = 50) {
  return recentIn(groupJid, limit).reverse(); // oldest first
}

/**
 * getRecentMessages for anything that reaches a model (reply / call / gate / relay
 * prompts): no forgotten (no_learn) or expired disappearing messages. `since`
 * (unix s) keeps only messages at or after it. Oldest first.
 */
export function getRecentMessagesForPrompt(chatJid, limit = 50, { since = null } = {}) {
  const hasSince = Number.isFinite(since);
  return recentIn(chatJid, limit, `AND ${PROMPT_VISIBLE}${hasSince ? ' AND timestamp >= ?' : ''}`,
    hasSince ? [Math.floor(since)] : []).reverse();
}

/**
 * Members' messages of one group by id that a prompt may still show (not fenced
 * by "forget that", not expired; a revoked message is no longer stored). Oldest
 * first. Used by the cap catch-up (src/behavior/capCatchUp.js) to re-read its
 * triggers before answering them.
 */
export function getPromptVisibleByIds(groupJid, ids) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id))] : [];
  if (!groupJid || !list.length) return [];
  return getDb().prepare(
    `SELECT * FROM messages
     WHERE group_jid = ? AND is_from_self = 0 AND ${PROMPT_VISIBLE}
       AND id IN (${list.map(() => '?').join(',')})
     ORDER BY timestamp ASC, rowid ASC`,
  ).all(groupJid, ...list);
}

export function searchMessages(query, groupJid, limit = 20) {
  const db = getDb();
  return db.prepare(SEARCH_MSGS).all(query, groupJid, limit);
}

export function countSelfMessagesInWindow(groupJid, sinceTimestamp) {
  const db = getDb();
  return db.prepare(COUNT_IN_WINDOW).get(groupJid, sinceTimestamp).count;
}

export function countSelfGroupMessagesSince(sinceTimestamp) {
  const db = getDb();
  return db.prepare(COUNT_SELF_GROUP_SINCE).get(sinceTimestamp).count;
}

export function getLastSelfMessage(groupJid) {
  const db = getDb();
  return db.prepare(LAST_SELF_MSG).get(groupJid) || null;
}

// ── Chat influence reads (spec 012) — counts and ids only, never text out ──

/** Incoming (not his), prompt-visible messages of one chat (every DM form) after `since`. */
export function countIncomingInWindow(chatJid, sinceTimestamp) {
  const forms = chatForms(chatJid);
  return getDb().prepare(`SELECT COUNT(*) AS count FROM messages
    WHERE group_jid IN (${forms.map(() => '?').join(',')}) AND is_from_self = 0 AND ${PROMPT_VISIBLE} AND timestamp > ?`)
    .get(...forms, sinceTimestamp).count;
}

/** His own sent messages across every chat (groups and DMs) after `since`. */
/**
 * Plan 020 H2: words he leans on in his own messages, as bare words for the phrase banks' fixation guard. Long words only:
 * the short ones are grammar in any language. Never a line of text, and never sent to a model.
 */
export function selfOverusedWords({ limit = 400, share = 0.03, minLength = 6 } = {}) {
  const rows = getDb().prepare(`SELECT content FROM messages WHERE is_from_self = 1 AND content IS NOT NULL AND ${PROMPT_VISIBLE} ORDER BY timestamp DESC LIMIT ?`).all(limit);
  if (rows.length < 40) return [];
  const counts = new Map();
  for (const r of rows) {
    for (const w of new Set(String(r.content).toLowerCase().match(/\p{L}[\p{L}\p{M}]*/gu) ?? [])) {
      if ([...w].length >= minLength) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= rows.length * share).map(([w]) => w);
}

export function countSelfMessagesSince(sinceTimestamp) {
  return getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE is_from_self = 1 AND timestamp > ?')
    .get(sinceTimestamp).count;
}

/**
 * Chat load in (from, to] (012 chat.load, counts only): his own sent messages, and
 * the prompt-visible incoming ones in the chats he sent in since `activeSince`
 * (the conversations he is in; a DM's stored forms count once).
 * → { sent, received, chats }
 */
export function chatLoadBetween(from, to, activeSince = from) {
  const db = getDb();
  const sent = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_from_self = 1 AND timestamp > ? AND timestamp <= ?').get(from, to).n;
  const active = db.prepare(`SELECT DISTINCT group_jid AS chatJid FROM messages
    WHERE is_from_self = 1 AND timestamp > ? AND timestamp <= ? LIMIT 50`).all(activeSince, to);
  const seen = new Set();
  let received = 0;
  let chats = 0;
  for (const { chatJid } of active) {
    if (!chatJid || seen.has(chatJid)) continue;
    const forms = chatForms(chatJid);
    for (const f of forms) seen.add(f);
    chats++;
    received += db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE group_jid IN (${forms.map(() => '?').join(',')}) AND is_from_self = 0 AND ${PROMPT_VISIBLE} AND timestamp > ? AND timestamp <= ?`)
      .get(...forms, from, to).n;
  }
  return { sent, received, chats };
}

/** Chats he sent in after `since`, with his message count: [{ chatJid, n }], busiest first. */
export function selfChatsSince(sinceTimestamp, limit = 20) {
  return getDb().prepare(`SELECT group_jid AS chatJid, COUNT(*) AS n FROM messages
    WHERE is_from_self = 1 AND timestamp > ? GROUP BY group_jid ORDER BY n DESC LIMIT ?`).all(sinceTimestamp, limit);
}

/** The newest incoming prompt-visible message of a chat after `since`: { id, senderJid, timestamp } | null. */
export function lastIncomingSince(chatJid, sinceTimestamp) {
  const forms = chatForms(chatJid);
  const row = getDb().prepare(`SELECT id, sender_jid, timestamp FROM messages
    WHERE group_jid IN (${forms.map(() => '?').join(',')}) AND is_from_self = 0 AND ${PROMPT_VISIBLE} AND timestamp > ?
    ORDER BY timestamp DESC, rowid DESC LIMIT 1`).get(...forms, sinceTimestamp);
  return row ? { id: row.id, senderJid: row.sender_jid, timestamp: row.timestamp } : null;
}

/** getPromptVisibleByIds across every stored form of a DM (a group reads its own JID). Oldest first. */
export function getPromptVisibleInChat(chatJid, ids) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id))] : [];
  if (!chatJid || !list.length) return [];
  const forms = chatForms(chatJid);
  return getDb().prepare(
    `SELECT * FROM messages
     WHERE group_jid IN (${forms.map(() => '?').join(',')}) AND is_from_self = 0 AND ${PROMPT_VISIBLE}
       AND id IN (${list.map(() => '?').join(',')})
     ORDER BY timestamp ASC, rowid ASC`,
  ).all(...forms, ...list);
}

/** Is message `id` of this chat one of his own? (a reply to him) */
export function isOwnMessage(chatJid, id) {
  if (!chatJid || typeof id !== 'string' || !id) return false;
  const forms = chatForms(chatJid);
  return getDb().prepare(`SELECT is_from_self FROM messages WHERE id = ? AND group_jid IN (${forms.map(() => '?').join(',')})`)
    .get(id, ...forms)?.is_from_self === 1;
}
