import { getDb } from './db.js';

// Instagram reels (specs/005): browsing sessions, every reel seen, the share queue and
// the phone command log. The live session state is in src/instagram/session.js; this
// is the durable record.

// share_state (on ig_reels): null (not queued) | 'queued' | 'approved' | 'sending' |
// 'sent' | 'vetoed' | 'failed'.

export function createSession({ trigger, initiatedBy = null, allowShare = false, plannedMin = null }) {
  const info = getDb().prepare(`
    INSERT INTO ig_sessions (trigger_kind, initiated_by, allow_share, planned_min) VALUES (?, ?, ?, ?)
  `).run(trigger, initiatedBy, allowShare ? 1 : 0, plannedMin);
  return Number(info.lastInsertRowid);
}

export function endSession(id, reason, counts) {
  getDb().prepare(`
    UPDATE ig_sessions SET ended_at = unixepoch(), end_reason = ?, seen = ?, liked = ?, queued = ?, shared = ?, cost_usd = ?,
      live_tokens = ?
    WHERE id = ? AND ended_at IS NULL
  `).run(reason, counts.seen, counts.liked, counts.queued, counts.shared, counts.cost, counts.liveTokens ?? null, id);
}

export function listSessions(limit = 20) {
  return getDb().prepare('SELECT * FROM ig_sessions ORDER BY id DESC LIMIT ?').all(limit);
}

/** Sessions left open by a crash/restart are closed on boot. */
export function closeStaleSessions() {
  return getDb().prepare("UPDATE ig_sessions SET ended_at = unixepoch(), end_reason = 'process restarted' WHERE ended_at IS NULL").run().changes;
}

export function firstSessionAt() {
  return getDb().prepare('SELECT MIN(started_at) AS t FROM ig_sessions').get()?.t || null;
}

const REEL_COLS = ['session_id', 'shortcode', 'url', 'account', 'caption', 'audio', 'like_count', 'description',
  'description_depth', 'language', 'humour_type', 'dwell_ms', 'jev_model', 'jev_answers', 'humour', 'fit',
  'confidence', 'hazards', 'for_whom', 'action', 'reason', 'liked', 'queued', 'thumb_path', 'cost_usd', 'comments',
  'saved', 'share_state'];

export function insertReel(row) {
  const cols = REEL_COLS.filter(c => row[c] !== undefined);
  const info = getDb().prepare(`INSERT INTO ig_reels (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => serialize(row[c])));
  return Number(info.lastInsertRowid);
}

export function updateReel(id, patch) {
  const cols = Object.keys(patch).filter(c => REEL_COLS.includes(c) || ['share_state', 'share_caption', 'shared_at',
    'share_error', 'saved', 'user_label', 'approved_by'].includes(c));
  if (!cols.length) return;
  getDb().prepare(`UPDATE ig_reels SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => serialize(patch[c])), id);
}

function serialize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function getReel(id) {
  return getDb().prepare('SELECT * FROM ig_reels WHERE id = ?').get(id);
}

/**
 * Reel log. Filters: action, sessionId, q (FTS over account/caption/description),
 * shareState. Newest first.
 */
export function listReels({ action, sessionId, q, shareState, limit = 50, beforeId } = {}) {
  const where = [];
  const args = [];
  if (action) { where.push('r.action = ?'); args.push(action); }
  if (sessionId) { where.push('r.session_id = ?'); args.push(sessionId); }
  if (shareState) { where.push('r.share_state = ?'); args.push(shareState); }
  if (beforeId) { where.push('r.id < ?'); args.push(beforeId); }
  let from = 'ig_reels r';
  if (q) {
    from = 'ig_reels r JOIN ig_reels_fts f ON f.rowid = r.id';
    where.push('ig_reels_fts MATCH ?');
    args.push(ftsQuery(q));
  }
  const sql = `SELECT r.* FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, Math.min(limit, 200));
}

// Quote each term so user input can't use FTS operators.
function ftsQuery(q) {
  return String(q).split(/\s+/).filter(Boolean).slice(0, 8).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/** The share queue: queued/approved/sending/failed, best first. */
export function listQueue() {
  return getDb().prepare(`
    SELECT * FROM ig_reels WHERE share_state IN ('queued', 'approved', 'sending', 'failed')
    ORDER BY CASE share_state WHEN 'sending' THEN 0 WHEN 'approved' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
             (COALESCE(humour, 0) + COALESCE(fit, 0)) DESC, id DESC
  `).all();
}

export function countToday(column, tz) {
  // "Today" in the bot's timezone, computed by the caller as a unix-seconds lower bound.
  return getDb().prepare(`SELECT COUNT(*) AS n FROM ig_reels WHERE ${column === 'liked' ? 'liked = 1' : "share_state = 'sent'"} AND ${column === 'liked' ? 'created_at' : 'shared_at'} >= ?`).get(tz)?.n || 0;
}

export function labelReel(id, label) {
  getDb().prepare('UPDATE ig_reels SET user_label = ? WHERE id = ?').run(label, id);
}

export function reelStats(sinceUnix) {
  return getDb().prepare(`
    SELECT COUNT(*) AS seen, SUM(liked) AS liked, SUM(CASE WHEN share_state IS NOT NULL THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN share_state = 'sent' THEN 1 ELSE 0 END) AS shared, SUM(cost_usd) AS cost,
           SUM(CASE WHEN user_label = 1 THEN 1 ELSE 0 END) AS good, SUM(CASE WHEN user_label = -1 THEN 1 ELSE 0 END) AS bad
    FROM ig_reels WHERE created_at >= ?
  `).get(sinceUnix);
}

export function insertDeviceLog(e) {
  getDb().prepare('INSERT INTO ig_device_log (ts, op, args, foreground, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(e.ts, e.op, e.args || null, e.foreground || null, e.ok ? 1 : 0, e.ms ?? null, e.error || null);
}

export function listDeviceLog(limit = 200) {
  return getDb().prepare('SELECT * FROM ig_device_log ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000));
}

/** Retention: device log and reel thumbnails older than `days`. Returns thumb paths to delete. */
export function pruneInstagram(days = 14) {
  const db = getDb();
  const cutoffMs = Date.now() - days * 86400_000;
  db.prepare('DELETE FROM ig_device_log WHERE ts < ?').run(cutoffMs);
  const old = db.prepare('SELECT id, thumb_path FROM ig_reels WHERE thumb_path IS NOT NULL AND created_at < ?')
    .all(Math.floor(cutoffMs / 1000));
  db.prepare('UPDATE ig_reels SET thumb_path = NULL WHERE thumb_path IS NOT NULL AND created_at < ?').run(Math.floor(cutoffMs / 1000));
  return old.map(r => r.thumb_path);
}

// ── Instagram group chat ─────────────────────────────────────────────────────

export function upsertMembers(members) {
  const db = getDb();
  const up = db.prepare(`
    INSERT INTO ig_members (username, display_name, is_self, is_admin, in_group, last_seen_at)
    VALUES (?, ?, ?, ?, 1, unixepoch())
    ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, is_self = excluded.is_self,
      is_admin = excluded.is_admin, in_group = 1, last_seen_at = unixepoch()
  `);
  db.transaction(() => {
    db.prepare('UPDATE ig_members SET in_group = 0').run();
    for (const m of members) up.run(m.username, m.displayName, m.isSelf ? 1 : 0, m.admin ? 1 : 0);
  })();
}

export function listMembers() {
  return getDb().prepare(`
    SELECT m.*, p.real_name, p.push_name FROM ig_members m LEFT JOIN people p ON p.jid = m.person_jid
    ORDER BY m.is_self DESC, m.in_group DESC, COALESCE(m.display_name, m.username)
  `).all();
}

export function linkMember(username, personJid, actor) {
  return getDb().prepare('UPDATE ig_members SET person_jid = ?, linked_by = ? WHERE username = ?')
    .run(personJid || null, personJid ? actor : null, username).changes;
}

/** A sender as shown in the thread (username, or display name in "X replied to you"). */
export function findMember(senderShown) {
  if (!senderShown) return null;
  return getDb().prepare('SELECT * FROM ig_members WHERE username = ? OR display_name = ? ORDER BY in_group DESC LIMIT 1')
    .get(senderShown, senderShown) || null;
}

export function recentMessages(limit = 30) {
  return getDb().prepare('SELECT * FROM ig_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

export function messageExists(key, occurrence) {
  return !!getDb().prepare('SELECT 1 FROM ig_messages WHERE msg_key = ? AND occurrence = ?').get(key, occurrence);
}

export function insertMessage(m) {
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO ig_messages (msg_key, occurrence, from_me, sender, kind, text, reel_account, reply_to_me, bot_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.key, m.occurrence, m.fromMe ? 1 : 0, m.sender || null, m.kind, m.text || null, m.reelAccount || null,
    m.replyToMe ? 1 : 0, m.botAction || null);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function updateMessage(id, patch) {
  const cols = Object.keys(patch).filter(c => ['reel_description', 'bot_action', 'bot_reply_id', 'jev_answers'].includes(c));
  if (!cols.length) return;
  getDb().prepare(`UPDATE ig_messages SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => serialize(patch[c])), id);
}

export function countBotRepliesSince(sinceUnix) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM ig_messages WHERE from_me = 1 AND kind = 'text' AND bot_action = 'sent' AND seen_at >= ?").get(sinceUnix)?.n || 0;
}
