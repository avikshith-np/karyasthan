import { getDb } from '../memory/db.js';
import { logger } from '../utils/logger.js';

// In-memory cache of muted groups, keyed by jid → muted_until (null = indefinite).
// Synced with DB on boot; stays authoritative because writes go through here.
const mutedCache = new Map();
let loaded = false;

export function loadMutedGroups() {
  try {
    const rows = getDb().prepare(`SELECT jid, muted_until FROM muted_groups`).all();
    mutedCache.clear();
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      if (r.muted_until && r.muted_until < now) continue; // already expired
      mutedCache.set(r.jid, r.muted_until ?? null);
    }
    loaded = true;
    logger.info({ count: mutedCache.size }, 'Muted groups loaded');
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load muted_groups');
  }
}

export function isGroupMuted(jid) {
  if (!loaded) return false;
  if (!mutedCache.has(jid)) return false;
  const until = mutedCache.get(jid);
  if (until == null) return true; // indefinite
  const now = Math.floor(Date.now() / 1000);
  if (until < now) {
    // Lazily expire in cache + DB
    mutedCache.delete(jid);
    try { getDb().prepare(`DELETE FROM muted_groups WHERE jid = ?`).run(jid); } catch {}
    return false;
  }
  return true;
}

export function muteGroup(jid, { durationMinutes, reason } = {}) {
  const until = durationMinutes
    ? Math.floor(Date.now() / 1000) + durationMinutes * 60
    : null;
  try {
    getDb().prepare(
      `INSERT INTO muted_groups (jid, muted_until, reason)
       VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET muted_until = excluded.muted_until, reason = excluded.reason, muted_at = unixepoch()`
    ).run(jid, until, reason || null);
    mutedCache.set(jid, until);
    return { jid, until };
  } catch (err) {
    logger.warn({ err: err.message, jid }, 'Failed to mute group');
    throw err;
  }
}

export function unmuteGroup(jid) {
  try {
    getDb().prepare(`DELETE FROM muted_groups WHERE jid = ?`).run(jid);
    mutedCache.delete(jid);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, jid }, 'Failed to unmute group');
    return false;
  }
}

export function listMutedGroups() {
  try {
    return getDb().prepare(`
      SELECT mg.*, g.name AS group_name
      FROM muted_groups mg
      LEFT JOIN groups g ON g.jid = mg.jid
      ORDER BY mg.muted_at DESC
    `).all();
  } catch {
    return [];
  }
}
