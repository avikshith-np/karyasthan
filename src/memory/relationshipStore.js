import { getDb } from './db.js';

const UPSERT_REL = `INSERT INTO relationships (person_a_jid, person_b_jid, relationship, dynamic, strength, group_jid)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(person_a_jid, person_b_jid, group_jid) DO UPDATE SET
    relationship = COALESCE(excluded.relationship, relationship),
    dynamic = COALESCE(excluded.dynamic, dynamic),
    strength = excluded.strength,
    updated_at = unixepoch()`;

const GET_RELATIONSHIPS_FOR_PERSON = `SELECT r.*,
    pa.push_name as person_a_name, pb.push_name as person_b_name
  FROM relationships r
  JOIN people pa ON pa.jid = r.person_a_jid
  JOIN people pb ON pb.jid = r.person_b_jid
  WHERE (r.person_a_jid = ? OR r.person_b_jid = ?)
  ORDER BY r.strength DESC`;

const GET_GROUP_RELATIONSHIPS = `SELECT r.*,
    pa.push_name as person_a_name, pb.push_name as person_b_name
  FROM relationships r
  JOIN people pa ON pa.jid = r.person_a_jid
  JOIN people pb ON pb.jid = r.person_b_jid
  WHERE r.group_jid = ?
  ORDER BY r.strength DESC`;

const UPSERT_MEMORY = `INSERT INTO memories (category, subject_jid, group_jid, content, importance, expires_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const GET_MEMORIES_FOR_PERSON = `SELECT * FROM memories
  WHERE subject_jid = ? AND (expires_at IS NULL OR expires_at > unixepoch())
  ORDER BY importance DESC, created_at DESC LIMIT ?`;

const GET_MEMORIES_FOR_GROUP = `SELECT * FROM memories
  WHERE group_jid = ? AND (expires_at IS NULL OR expires_at > unixepoch())
  ORDER BY importance DESC, created_at DESC LIMIT ?`;

const DECAY_MEMORIES = `DELETE FROM memories
  WHERE importance < 0.3 AND recall_count = 0
  AND created_at < unixepoch() - ?`;

const BUMP_RECALL = `UPDATE memories SET recall_count = recall_count + 1 WHERE id = ?`;

export function upsertRelationship(personAJid, personBJid, groupJid, relationship, dynamic, strength = 0.5) {
  const db = getDb();
  // Always store with the lexically smaller JID first for consistency
  const [a, b] = personAJid < personBJid ? [personAJid, personBJid] : [personBJid, personAJid];
  return db.prepare(UPSERT_REL).run(a, b, relationship || null, dynamic || null, strength, groupJid || null);
}

export function getRelationshipsForPerson(personJid) {
  const db = getDb();
  return db.prepare(GET_RELATIONSHIPS_FOR_PERSON).all(personJid, personJid);
}

export function getGroupRelationships(groupJid) {
  const db = getDb();
  return db.prepare(GET_GROUP_RELATIONSHIPS).all(groupJid);
}

export function addMemory(category, subjectJid, groupJid, content, importance = 0.5, expiresInDays = null) {
  const db = getDb();
  const expiresAt = expiresInDays != null
    ? Math.floor(Date.now() / 1000) + expiresInDays * 86400
    : null;
  return db.prepare(UPSERT_MEMORY).run(category, subjectJid || null, groupJid || null, content, importance, expiresAt);
}

export function getMemoriesForPerson(personJid, limit = 10) {
  const db = getDb();
  return db.prepare(GET_MEMORIES_FOR_PERSON).all(personJid, limit);
}

export function getMemoriesForGroup(groupJid, limit = 10) {
  const db = getDb();
  return db.prepare(GET_MEMORIES_FOR_GROUP).all(groupJid, limit);
}

export function getRelevantMemories(personJids, groupJid, limit = 5) {
  const db = getDb();
  if (!personJids.length) return db.prepare(GET_MEMORIES_FOR_GROUP).all(groupJid, limit);

  const placeholders = personJids.map(() => '?').join(',');
  const sql = `SELECT * FROM memories
    WHERE (subject_jid IN (${placeholders}) OR group_jid = ?)
    AND (expires_at IS NULL OR expires_at > unixepoch())
    ORDER BY importance DESC, created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...personJids, groupJid, limit);
}

export function cleanExpiredMemories() {
  const db = getDb();
  const result = db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run();
  return result.changes;
}

export function decayMemories(maxAgeSec = 30 * 24 * 3600) {
  const db = getDb();
  return db.prepare(DECAY_MEMORIES).run(maxAgeSec);
}

export function bumpRecall(memoryId) {
  const db = getDb();
  return db.prepare(BUMP_RECALL).run(memoryId);
}
