// Dreams' table (plan 020 G). Only the dreams worker and the story facade read it; no prompt builder reads it directly.
import { getDb } from '../../../memory/db.js';

const decode = (r) => r && ({
  id: r.id, eventId: r.event_id, sleepEventId: r.sleep_event_id, night: r.night, at: r.at, recall: r.recall, tone: r.tone,
  plan: (() => { try { return JSON.parse(r.plan_json); } catch { return null; } })(), text: r.text, tier: r.tier, phraseKey: r.phrase_key,
  needsWords: r.needs_words === 1, attempts: r.attempts, status: r.status,
});

export function insertDream(d, createdAt) {
  const r = getDb().prepare(`INSERT OR IGNORE INTO story_dreams (event_id, sleep_event_id, night, at, recall, tone, plan_json, text, tier, phrase_key, needs_words, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'code', ?, ?, ?)`)
    .run(d.eventId, d.sleepEventId, d.night, d.at, d.recall, d.tone, JSON.stringify(d.plan), d.text, d.phraseKey ?? null, d.needsWords ? 1 : 0, createdAt);
  return r.changes > 0 ? r.lastInsertRowid : null;
}

export function byEvent(eventId) {
  return decode(getDb().prepare('SELECT * FROM story_dreams WHERE event_id = ?').get(eventId));
}

export function listDreams({ limit = 30 } = {}) {
  return getDb().prepare("SELECT * FROM story_dreams WHERE status = 'live' ORDER BY at DESC LIMIT ?").all(limit).map(decode);
}

export function recentDreams(from) {
  return getDb().prepare("SELECT * FROM story_dreams WHERE status = 'live' AND at >= ? ORDER BY at DESC").all(from).map(decode);
}

export function pendingWords(limit = 1) {
  return getDb().prepare("SELECT * FROM story_dreams WHERE needs_words = 1 AND status = 'live' ORDER BY at LIMIT ?").all(limit).map(decode);
}

export function setWords(id, text, tier) {
  getDb().prepare('UPDATE story_dreams SET text = ?, tier = ?, needs_words = 0 WHERE id = ?').run(text, tier, id);
}

export function giveUpWords(id) {
  getDb().prepare('UPDATE story_dreams SET needs_words = 0, attempts = attempts + 1 WHERE id = ?').run(id);
}

export function countCallsSince(from) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM story_dreams WHERE tier = 'clerk' AND at >= ?").get(from).n;
}

/** A dream that left the log (a revert, a rewind, a redaction) loses its words. */
export function sweep(isGone) {
  const db = getDb();
  let n = 0;
  for (const r of db.prepare("SELECT id, event_id FROM story_dreams WHERE status = 'live'").all()) {
    if (!isGone(r.event_id)) continue;
    db.prepare("UPDATE story_dreams SET status = 'reverted', text = NULL, needs_words = 0, plan_json = '{}' WHERE id = ?").run(r.id);
    n += 1;
  }
  return n;
}

export function prune(at, days = 180) {
  return getDb().prepare('DELETE FROM story_dreams WHERE at < ?').run(at - days * 86400).changes;
}
