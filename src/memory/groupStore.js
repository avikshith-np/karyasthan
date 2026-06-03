import { getDb } from './db.js';

const UPSERT_GROUP = `INSERT INTO groups (jid, name, joined_at, last_active)
  VALUES (?, ?, unixepoch(), unixepoch())
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    last_active = unixepoch(),
    updated_at = unixepoch()`;

const GET_GROUP = `SELECT * FROM groups WHERE jid = ?`;
const UPDATE_VIBE = `UPDATE groups SET vibe = ?, updated_at = unixepoch() WHERE jid = ?`;
const UPDATE_LANGUAGE = `UPDATE groups SET language = ?, updated_at = unixepoch() WHERE jid = ?`;
const UPDATE_CONFIG = `UPDATE groups SET config_json = ?, updated_at = unixepoch() WHERE jid = ?`;
const ALL_GROUPS = `SELECT * FROM groups ORDER BY last_active DESC`;

const UPSERT_MEMBER = `INSERT INTO group_members (group_jid, person_jid, role, joined_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(group_jid, person_jid) DO UPDATE SET
    role = COALESCE(excluded.role, role)`;

const GET_MEMBERS = `SELECT gm.*, p.push_name, p.real_name, p.summary FROM group_members gm
  JOIN people p ON p.jid = gm.person_jid
  WHERE gm.group_jid = ?`;

const UPSERT_SLANG = `INSERT INTO slang (term, meaning, group_jid, example, first_seen)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(term, group_jid) DO UPDATE SET
    use_count = use_count + 1,
    meaning = COALESCE(excluded.meaning, meaning),
    example = COALESCE(excluded.example, example)`;

const GET_TOP_SLANG = `SELECT * FROM slang
  WHERE group_jid = ? OR group_jid IS NULL
  ORDER BY use_count DESC LIMIT ?`;

const UPSERT_TOPIC = `INSERT INTO topics (group_jid, topic, started_at, last_active)
  VALUES (?, ?, unixepoch(), unixepoch())`;

const UPDATE_TOPIC = `UPDATE topics SET last_active = unixepoch(), message_count = message_count + 1
  WHERE id = ?`;

const ACTIVE_TOPICS = `SELECT * FROM topics WHERE group_jid = ? AND is_active = 1
  ORDER BY last_active DESC LIMIT ?`;

const DEACTIVATE_OLD_TOPICS = `UPDATE topics SET is_active = 0
  WHERE is_active = 1 AND last_active < unixepoch() - ?`;

export function upsertGroup(jid, name) {
  const db = getDb();
  return db.prepare(UPSERT_GROUP).run(jid, name || null);
}

export function getGroup(jid) {
  const db = getDb();
  return db.prepare(GET_GROUP).get(jid) || null;
}

export function updateVibe(jid, vibe) {
  const db = getDb();
  return db.prepare(UPDATE_VIBE).run(vibe, jid);
}

export function updateLanguage(jid, language) {
  const db = getDb();
  return db.prepare(UPDATE_LANGUAGE).run(language, jid);
}

export function updateGroupConfig(jid, config) {
  const db = getDb();
  return db.prepare(UPDATE_CONFIG).run(JSON.stringify(config), jid);
}

export function getAllGroups() {
  const db = getDb();
  return db.prepare(ALL_GROUPS).all();
}

export function upsertMember(groupJid, personJid, role = 'member') {
  const db = getDb();
  return db.prepare(UPSERT_MEMBER).run(groupJid, personJid, role);
}

export function getMembers(groupJid) {
  const db = getDb();
  return db.prepare(GET_MEMBERS).all(groupJid);
}

export function upsertSlang(term, meaning, groupJid, example) {
  const db = getDb();
  return db.prepare(UPSERT_SLANG).run(term, meaning || null, groupJid || null, example || null);
}

export function getTopSlang(groupJid, limit = 20) {
  const db = getDb();
  return db.prepare(GET_TOP_SLANG).all(groupJid, limit);
}

export function addTopic(groupJid, topic) {
  const db = getDb();
  return db.prepare(UPSERT_TOPIC).run(groupJid, topic);
}

export function touchTopic(topicId) {
  const db = getDb();
  return db.prepare(UPDATE_TOPIC).run(topicId);
}

export function getActiveTopics(groupJid, limit = 5) {
  const db = getDb();
  return db.prepare(ACTIVE_TOPICS).all(groupJid, limit);
}

export function deactivateOldTopics(maxAgeSec = 7 * 24 * 3600) {
  const db = getDb();
  return db.prepare(DEACTIVATE_OLD_TOPICS).run(maxAgeSec);
}
