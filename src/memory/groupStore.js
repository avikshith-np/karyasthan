import { getDb } from './db.js';
import { resolvePerson, bareJid, isPersonJid, isSelfJid } from './identity.js';

const UPSERT_GROUP = `INSERT INTO groups (jid, name, joined_at, last_active)
  VALUES (?, ?, unixepoch(), unixepoch())
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    last_active = unixepoch(),
    updated_at = unixepoch()`;

const GET_GROUP = `SELECT * FROM groups WHERE jid = ?`;
// Owner-set fields (dashboard) are marked in config_json.owner.<field>: learning
// may only write a field the owner hasn't set (or has handed back).
const OWNER_FIELDS = new Set(['vibe', 'language']);
const UPDATE_VIBE = `UPDATE groups SET vibe = ?, updated_at = unixepoch() WHERE jid = ?`;
const LEARN_VIBE = `UPDATE groups SET vibe = ?, updated_at = unixepoch()
  WHERE jid = ? AND json_extract(COALESCE(NULLIF(config_json, ''), '{}'), '$.owner.vibe') IS NULL`;
const UPDATE_LANGUAGE = `UPDATE groups SET language = ?, updated_at = unixepoch() WHERE jid = ?`;
const SET_OWNER_MARK = `UPDATE groups SET config_json = json_set(COALESCE(NULLIF(config_json, ''), '{}'), ?, 1) WHERE jid = ?`;
const CLEAR_OWNER_MARK = `UPDATE groups SET config_json = json_remove(COALESCE(NULLIF(config_json, ''), '{}'), ?) WHERE jid = ?`;
const ALL_GROUPS = `SELECT * FROM groups ORDER BY last_active DESC`;

// Membership rows are keyed by the canonical person id (spec 006, R3/R5). joined_at is
// set once, on insert, and never moved by a later upsert: it decides which
// group-origin items a member may see elsewhere (R4), so callers pass the right time
// (first-sync backfill, sync time, event time, or "now" for a newly seen sender).
const UPSERT_MEMBER = `INSERT INTO group_members (group_jid, person_jid, role, joined_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(group_jid, person_jid) DO UPDATE SET
    role = COALESCE(excluded.role, role),
    joined_at = COALESCE(joined_at, excluded.joined_at)`;

// group_members.person_jid references people(jid): a member seen only through a sync
// (never spoke) still needs a row. phone is only ever a real PN (never LID digits).
const ENSURE_PERSON = `INSERT OR IGNORE INTO people (jid, phone, first_seen, message_count)
  VALUES (?, ?, unixepoch(), 0)`;

const GET_MEMBERS = `SELECT gm.*, p.push_name, p.real_name FROM group_members gm
  JOIN people p ON p.jid = gm.person_jid
  WHERE gm.group_jid = ?`;

const INSERT_MEMBERSHIP_LOG = `INSERT INTO group_membership_log (group_jid, person_jid, action, at, source)
  VALUES (?, ?, ?, ?, ?)`;

// Slang is scoped to the chat it was heard in (spec 006, R9). Its meaning becomes
// global style (is_global) only when the term is explained in ≥ 2 group chats and
// the meaning names nobody we know — "X's word for when Arun is late" is content.
const UPSERT_SLANG = `INSERT INTO slang (term, meaning, origin_kind, origin_jid, example, first_seen)
  VALUES (?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(term, origin_jid) DO UPDATE SET
    use_count = use_count + 1,
    meaning = COALESCE(excluded.meaning, meaning),
    example = COALESCE(excluded.example, example)
  RETURNING id`;

// Only terms the batch LLM actually explained are worth putting in the prompt.
const GET_TOP_SLANG = `SELECT * FROM slang
  WHERE origin_jid = ? OR is_global = 1
  ORDER BY (origin_jid = ?) DESC, use_count DESC LIMIT ?`;
const GET_TOP_SLANG_WITH_MEANING = `SELECT * FROM slang
  WHERE (origin_jid = ? OR is_global = 1) AND meaning IS NOT NULL AND meaning != ''
  ORDER BY (origin_jid = ?) DESC, use_count DESC LIMIT ?`;

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

/** Batch learning's vibe write: a no-op while the owner's vibe stands. */
export function learnVibe(jid, vibe) {
  return getDb().prepare(LEARN_VIBE).run(vibe, jid);
}

export function updateLanguage(jid, language) {
  const db = getDb();
  return db.prepare(UPDATE_LANGUAGE).run(language, jid);
}

/**
 * The owner sets a group's vibe or language (dashboard): the value and its owner
 * mark in one transaction, so learning leaves it alone from then on.
 */
export function setOwnerGroupField(jid, field, value) {
  if (!OWNER_FIELDS.has(field)) throw new Error(`not an owner field: ${field}`);
  const db = getDb();
  return db.transaction(() => {
    const info = db.prepare(field === 'vibe' ? UPDATE_VIBE : UPDATE_LANGUAGE).run(value, jid);
    if (info.changes) db.prepare(SET_OWNER_MARK).run(`$.owner.${field}`, jid);
    return info;
  })();
}

/**
 * Hand a field back to learning: drop the owner mark. The vibe keeps its value
 * until the next batch writes one; the language (nothing learns it) goes back to
 * the default, 'en'.
 */
export function releaseOwnerGroupField(jid, field) {
  if (!OWNER_FIELDS.has(field)) throw new Error(`not an owner field: ${field}`);
  const db = getDb();
  return db.transaction(() => {
    const info = db.prepare(CLEAR_OWNER_MARK).run(`$.owner.${field}`, jid);
    if (info.changes && field === 'language') db.prepare(UPDATE_LANGUAGE).run('en', jid);
    return info;
  })();
}

/**
 * { vibe: 'owner'|'learned', language: 'owner'|'default' } from a groups row.
 * Nothing learns the language, so any value other than the default 'en' is the
 * owner's, marked or not.
 */
export function groupFieldSources(group) {
  let owner = {};
  try { owner = JSON.parse(group?.config_json || '{}')?.owner || {}; } catch { owner = {}; }
  const language = (owner.language || (group?.language && group.language !== 'en')) ? 'owner' : 'default';
  return { vibe: owner.vibe ? 'owner' : 'learned', language };
}

/**
 * One-time (idempotent) boot backfill of owner marks for edits made before the
 * marks existed: for each group and field, the latest 'group.patch' audit row that
 * touched it (set it or handed it back) decides — a set whose value is still the
 * group's current one marks it as the owner's; a release, or a value learning has
 * since replaced, leaves it unmarked. A field already marked is left alone.
 * Returns the number of marks written.
 */
export function backfillOwnerGroupMarks() {
  const db = getDb();
  const rows = db.prepare(`SELECT target, payload_json FROM dashboard_audit
    WHERE action = 'group.patch' AND target IS NOT NULL ORDER BY id DESC`).all();
  const latest = new Map();   // `${jid}\0${field}` → { set: value } | { released: true }
  for (const row of rows) {
    let changes;
    try { changes = JSON.parse(row.payload_json || '{}') || {}; } catch { continue; }
    const released = Array.isArray(changes.released) ? changes.released : [];
    for (const field of OWNER_FIELDS) {
      const key = `${row.target}\0${field}`;
      if (latest.has(key)) continue;
      if (released.includes(field)) latest.set(key, { released: true });
      else if (typeof changes[field] === 'string') latest.set(key, { set: changes[field] });
    }
  }
  let marked = 0;
  db.transaction(() => {
    for (const [key, last] of latest) {
      if (last.released) continue;
      const [jid, field] = key.split('\0');
      const group = db.prepare(GET_GROUP).get(jid);
      if (!group) continue;
      let owner = {};
      try { owner = JSON.parse(group.config_json || '{}')?.owner || {}; } catch { owner = {}; }
      if (owner[field]) continue;
      const current = group[field];
      if (typeof current !== 'string' || !current.trim() || current.trim() !== last.set.trim()) continue;
      db.prepare(SET_OWNER_MARK).run(`$.owner.${field}`, jid);
      marked++;
    }
  })();
  return marked;
}

export function getAllGroups() {
  const db = getDb();
  return db.prepare(ALL_GROUPS).all();
}

// Listeners for membership writes (membership.js invalidates its map). Kept as a
// hook so this store doesn't import membership.js (which imports this store).
const membershipListeners = new Set();

/** Register fn({ groupJid, personJid, action: 'add'|'remove'|'sync', inserted }) — returns an unsubscribe. */
export function onMembershipChange(fn) {
  membershipListeners.add(fn);
  return () => membershipListeners.delete(fn);
}

function notifyMembership(change) {
  for (const fn of membershipListeners) {
    try { fn(change); } catch { /* a listener must never break a write */ }
  }
}

/** Canonical person id for a membership row; null for the bot, the group itself, non-person JIDs. */
export function canonicalMemberJid(jid) {
  if (!isPersonJid(jid) || isSelfJid(jid)) return null;
  return resolvePerson(jid) || bareJid(jid);
}

/**
 * Add (or refresh the role of) a group member, canonicalised. joinedAt (unix s) is
 * only used when the row is new; default now. Returns { personJid, inserted } —
 * personJid null when the JID is not a person (e.g. the group's own JID).
 */
export function upsertMember(groupJid, personJid, role = 'member', joinedAt = null) {
  const canonical = canonicalMemberJid(personJid);
  if (!groupJid || !canonical) return { personJid: null, inserted: false };
  const db = getDb();
  const at = Number.isFinite(joinedAt) ? Math.floor(joinedAt) : Math.floor(Date.now() / 1000);
  const phone = canonical.endsWith('@s.whatsapp.net') ? canonical.split('@')[0] : null;
  const inserted = db.transaction(() => {
    db.prepare(ENSURE_PERSON).run(canonical, phone);
    const existed = db.prepare('SELECT 1 FROM group_members WHERE group_jid = ? AND person_jid = ?').get(groupJid, canonical);
    db.prepare(UPSERT_MEMBER).run(groupJid, canonical, role || null, at);
    return !existed;
  })();
  notifyMembership({ groupJid, personJid: canonical, action: 'add', inserted });
  return { personJid: canonical, inserted };
}

/** Remove a member: the canonical row and any raw-form row of the same person. */
export function removeMember(groupJid, personJid) {
  const canonical = canonicalMemberJid(personJid);
  const raw = bareJid(personJid);
  if (!groupJid || !canonical) return { changes: 0, personJid: null };
  const db = getDb();
  const info = db.prepare(`DELETE FROM group_members WHERE group_jid = ? AND person_jid IN (?, ?)`)
    .run(groupJid, canonical, raw || canonical);
  notifyMembership({ groupJid, personJid: canonical, action: 'remove', inserted: false });
  return { changes: info.changes, personJid: canonical };
}

export function getMembers(groupJid) {
  const db = getDb();
  return db.prepare(GET_MEMBERS).all(groupJid);
}

/** Every membership row (membership.js map load). */
export function getAllMemberships() {
  return getDb().prepare('SELECT group_jid, person_jid, role, joined_at FROM group_members').all();
}

/** Append a join/leave to group_membership_log. source: 'event' | 'sync' | 'message' | 'backfill'. */
export function logMembership(groupJid, personJid, action, source, at = null) {
  const ts = Number.isFinite(at) ? Math.floor(at) : Math.floor(Date.now() / 1000);
  return getDb().prepare(INSERT_MEMBERSHIP_LOG).run(groupJid, personJid, action, ts, source || null);
}

/** Record a group seen by a membership sync without touching last_active. */
export function ensureGroup(jid, name = null) {
  return getDb().prepare(`INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(jid) DO UPDATE SET name = COALESCE(name, excluded.name)`).run(jid, name || null);
}

/** groups.members_synced_at — the last completed full participant sync (R3). */
export function setMembersSyncedAt(groupJid, at = null) {
  const ts = Number.isFinite(at) ? Math.floor(at) : Math.floor(Date.now() / 1000);
  getDb().prepare('UPDATE groups SET members_synced_at = ? WHERE jid = ?').run(ts, groupJid);
  notifyMembership({ groupJid, personJid: null, action: 'sync', inserted: false });
}

export function getMembersSyncedAt(groupJid) {
  return getDb().prepare('SELECT members_synced_at FROM groups WHERE jid = ?').pluck().get(groupJid) ?? null;
}

/** The group's first observation: MIN(groups.joined_at, first message) — the R4 backfill join time. */
export function getGroupFirstObservedAt(groupJid) {
  return getDb().prepare(`SELECT MIN(v) FROM (
      SELECT joined_at AS v FROM groups WHERE jid = ? AND joined_at IS NOT NULL
      UNION ALL SELECT MIN(timestamp) FROM messages WHERE group_jid = ?
    ) WHERE v IS NOT NULL`).pluck().get(groupJid, groupJid) ?? null;
}

const SLANG_ORIGIN_KINDS = new Set(['group', 'ig']);   // DMs extract no slang (R9)
const NAME_CACHE_MS = 60_000;
let nameCache = null;   // { words: Set<string>, at }

// Lower-cased words (≥ 3 chars) of every known member's push/real name, every
// nickname and every Instagram member name. A meaning containing one is content.
function knownNameWords(db) {
  if (nameCache && Date.now() - nameCache.at < NAME_CACHE_MS) return nameCache.words;
  const words = new Set();
  const add = (s) => {
    for (const w of String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 3) words.add(w);
    }
  };
  for (const r of db.prepare(`SELECT p.push_name, p.real_name FROM people p
      WHERE p.jid IN (SELECT person_jid FROM group_members)`).all()) { add(r.push_name); add(r.real_name); }
  for (const n of db.prepare('SELECT DISTINCT nickname FROM nicknames').pluck().all()) add(n);
  try {
    for (const r of db.prepare('SELECT username, display_name FROM ig_members').all()) { add(r.username); add(r.display_name); }
  } catch { /* no Instagram table on very old DBs */ }
  nameCache = { words, at: Date.now() };
  return words;
}

function namesSomeone(text, words) {
  return String(text || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).some(w => words.has(w));
}

// Recompute is_global for every row of a term: group rows only (a DM/IG row must
// never be flagged — recallSlang serves any is_global row anywhere). Also run after
// slang rows are deleted (relationshipStore.deleteItems), so a term left in one chat
// stops being global.
export function refreshSlangGlobal(db, term) {
  const rows = db.prepare('SELECT id, meaning, origin_kind, origin_jid FROM slang WHERE term = ?').all(term);
  const explained = rows.filter(r => r.origin_kind === 'group' && r.meaning && r.meaning.trim());
  const chats = new Set(explained.map(r => r.origin_jid));
  const words = chats.size >= 2 ? knownNameWords(db) : null;
  const termIsName = words ? namesSomeone(term, words) : true;
  const set = db.prepare('UPDATE slang SET is_global = ? WHERE id = ?');
  for (const r of rows) {
    const g = words && !termIsName && r.origin_kind === 'group' && r.meaning && r.meaning.trim()
      && !namesSomeone(r.meaning, words) ? 1 : 0;
    set.run(g, r.id);
  }
}

/**
 * Record a slang term as heard in one group (or the Instagram group). Returns
 * { id } or null when the origin may not hold slang (DM, call, owner, self) or the
 * term is empty. The example is content: it never leaves its origin.
 */
export function upsertSlang(term, meaning, originKind, originJid, example) {
  if (!SLANG_ORIGIN_KINDS.has(originKind) || !originJid || typeof originJid !== 'string') return null;
  if (originKind === 'group' && !originJid.endsWith('@g.us')) return null;
  const t = String(term || '').trim().toLowerCase().slice(0, 40);
  if (!t) return null;
  const m = meaning ? String(meaning).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
  const ex = example ? String(example).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(UPSERT_SLANG).get(t, m, originKind, originJid, ex);
    refreshSlangGlobal(db, t);
    return row ? { id: row.id } : null;
  })();
}

/** @deprecated prompts use recall.recallSlang; kept for the dashboard. This chat's own + global terms. */
export function getTopSlang(groupJid, limit = 20, { withMeaningOnly = false } = {}) {
  const db = getDb();
  if (withMeaningOnly) return db.prepare(GET_TOP_SLANG_WITH_MEANING).all(groupJid, groupJid, limit);
  return db.prepare(GET_TOP_SLANG).all(groupJid, groupJid, limit);
}
