import { getDb } from './db.js';

const UPSERT_PERSON = `INSERT INTO people (jid, phone, push_name, first_seen, last_seen, message_count)
  VALUES (?, ?, ?, unixepoch(), unixepoch(), 1)
  ON CONFLICT(jid) DO UPDATE SET
    push_name = COALESCE(excluded.push_name, push_name),
    last_seen = unixepoch(),
    message_count = message_count + 1,
    updated_at = unixepoch()`;

const GET_PERSON = `SELECT * FROM people WHERE jid = ?`;

const UPDATE_TRAITS = `UPDATE people SET traits_json = ?, updated_at = unixepoch() WHERE jid = ?`;
const UPDATE_INTERESTS = `UPDATE people SET interests_json = ?, updated_at = unixepoch() WHERE jid = ?`;
const UPDATE_SUMMARY = `UPDATE people SET summary = ?, updated_at = unixepoch() WHERE jid = ?`;
const UPDATE_REAL_NAME = `UPDATE people SET real_name = ?, updated_at = unixepoch() WHERE jid = ?`;

const UPSERT_NICKNAME = `INSERT INTO nicknames (person_jid, nickname, group_jid, used_by, confidence, source, first_seen, last_used)
  VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  ON CONFLICT(person_jid, nickname, group_jid) DO UPDATE SET
    use_count = use_count + 1,
    confidence = MIN(1.0, confidence + 0.05),
    last_used = unixepoch()`;

// Demote old self-declared nicknames when a new one replaces them
const DEMOTE_OLD_SELF_DECLARED = `UPDATE nicknames
  SET confidence = 0.3, source = 'observed'
  WHERE person_jid = ? AND source = 'self_declared' AND nickname != ?`;

const GET_NICKNAMES = `SELECT * FROM nicknames WHERE person_jid = ? ORDER BY confidence DESC, use_count DESC`;
const GET_GROUP_NICKNAMES = `SELECT n.*, p.push_name, p.real_name FROM nicknames n
  JOIN people p ON p.jid = n.person_jid
  WHERE n.group_jid = ? OR n.group_jid IS NULL
  ORDER BY n.confidence DESC`;

const GET_ACTIVE_PEOPLE_IN_GROUP = `SELECT p.*, gm.role FROM people p
  JOIN group_members gm ON gm.person_jid = p.jid
  WHERE gm.group_jid = ?
  ORDER BY p.last_seen DESC`;

export function upsertPerson(jid, phone, pushName) {
  const db = getDb();
  return db.prepare(UPSERT_PERSON).run(jid, phone, pushName || null);
}

export function getPerson(jid) {
  const db = getDb();
  return db.prepare(GET_PERSON).get(jid) || null;
}

export function updateTraits(jid, traits) {
  const db = getDb();
  return db.prepare(UPDATE_TRAITS).run(JSON.stringify(traits), jid);
}

export function updateInterests(jid, interests) {
  const db = getDb();
  return db.prepare(UPDATE_INTERESTS).run(JSON.stringify(interests), jid);
}

export function updateSummary(jid, summary) {
  const db = getDb();
  return db.prepare(UPDATE_SUMMARY).run(summary, jid);
}

export function updateRealName(jid, realName) {
  const db = getDb();
  return db.prepare(UPDATE_REAL_NAME).run(realName, jid);
}

export function upsertNickname(personJid, nickname, groupJid, usedBy, confidence = 0.3, source = 'observed') {
  const db = getDb();
  // When someone declares a new preferred name, demote the old one
  if (source === 'self_declared') {
    db.prepare(DEMOTE_OLD_SELF_DECLARED).run(personJid, nickname);
  }
  return db.prepare(UPSERT_NICKNAME).run(personJid, nickname, groupJid || null, usedBy || null, confidence, source);
}

export function getNicknames(personJid) {
  const db = getDb();
  return db.prepare(GET_NICKNAMES).all(personJid);
}

export function getGroupNicknames(groupJid) {
  const db = getDb();
  return db.prepare(GET_GROUP_NICKNAMES).all(groupJid);
}

export function getActivePeopleInGroup(groupJid) {
  const db = getDb();
  return db.prepare(GET_ACTIVE_PEOPLE_IN_GROUP).all(groupJid);
}

/**
 * Find a person in a group by a phone suffix (e.g. last 4–10 digits).
 * Used when the bot emits "@9876543210" or "@+91..." tokens.
 * Returns { jid, push_name, real_name, phone } or null.
 */
export function findPersonInGroupByPhoneSuffix(groupJid, phoneSuffix) {
  if (!phoneSuffix) return null;
  const digits = String(phoneSuffix).replace(/\D/g, '');
  if (digits.length < 4) return null;
  const db = getDb();
  const rows = db.prepare(GET_ACTIVE_PEOPLE_IN_GROUP).all(groupJid);
  // Prefer longest match (full phone) to avoid ambiguous suffix collisions.
  let best = null;
  for (const row of rows) {
    if (!row.phone) continue;
    const rowDigits = String(row.phone).replace(/\D/g, '');
    if (!rowDigits.endsWith(digits)) continue;
    if (!best || rowDigits.length > String(best.phone).replace(/\D/g, '').length) best = row;
  }
  return best || null;
}

/**
 * Find a person in a group by a case-insensitive name match across
 * push_name, real_name, and any nickname they go by in this group.
 * Returns { jid, push_name, real_name, phone } or null.
 */
export function findPersonInGroupByName(groupJid, name) {
  if (!name) return null;
  const needle = String(name).toLowerCase().trim();
  if (!needle) return null;
  const db = getDb();
  const people = db.prepare(GET_ACTIVE_PEOPLE_IN_GROUP).all(groupJid);

  // 1. Exact match on push_name / real_name
  for (const p of people) {
    if ((p.push_name || '').toLowerCase() === needle) return p;
    if ((p.real_name || '').toLowerCase() === needle) return p;
  }
  // 2. Nickname match (scoped to this group or global)
  const nickRows = db.prepare(
    `SELECT n.person_jid FROM nicknames n
     WHERE LOWER(n.nickname) = ? AND (n.group_jid = ? OR n.group_jid IS NULL)
     ORDER BY n.confidence DESC, n.use_count DESC LIMIT 1`
  ).all(needle, groupJid);
  if (nickRows.length) {
    const hit = people.find(p => p.jid === nickRows[0].person_jid);
    if (hit) return hit;
  }
  // 3. Prefix / contains fallback (only if unambiguous)
  const starts = people.filter(p =>
    (p.push_name || '').toLowerCase().startsWith(needle)
    || (p.real_name || '').toLowerCase().startsWith(needle)
  );
  if (starts.length === 1) return starts[0];
  return null;
}
