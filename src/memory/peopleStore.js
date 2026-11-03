import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { resolvePerson, bareJid } from './identity.js';

// People rows hold identity only (spec 006): summary/traits/interests live per origin
// in person_facets and are read back through recall.js (recallFacets), never here.
// Nicknames carry their origin chat; prompt builders read them via recallNicknames.

const ORIGIN_KINDS = new Set(['self', 'group', 'dm', 'call', 'ig', 'owner']);
const VISIBILITIES = new Set(['subject_dm', 'subject_groups', 'everywhere']);
const LIST_MAX = 12;

const PERSON_COLS = 'jid, phone, push_name, real_name, message_count, first_seen, last_seen, updated_at';

const UPSERT_PERSON = `INSERT INTO people (jid, phone, push_name, first_seen, last_seen, message_count)
  VALUES (?, ?, ?, unixepoch(), unixepoch(), 1)
  ON CONFLICT(jid) DO UPDATE SET
    push_name = COALESCE(excluded.push_name, push_name),
    last_seen = unixepoch(),
    message_count = message_count + 1,
    updated_at = unixepoch()`;

const GET_PERSON = `SELECT ${PERSON_COLS} FROM people WHERE jid = ?`;

const UPDATE_REAL_NAME = `UPDATE people SET real_name = ?, updated_at = unixepoch() WHERE jid = ?`;

// Re-observation: count up, nudge confidence, learned_at = MAX(existing, new) (R9).
const UPSERT_NICKNAME = `INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid, used_by, confidence,
    source, first_seen, last_used, learned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), ?)
  ON CONFLICT(person_jid, nickname, origin_jid) DO UPDATE SET
    use_count = use_count + 1,
    confidence = MIN(1.0, MAX(confidence + 0.05, excluded.confidence)),
    source = CASE WHEN excluded.source = 'self_declared' THEN 'self_declared' ELSE source END,
    last_used = unixepoch(),
    learned_at = MAX(COALESCE(learned_at, 0), COALESCE(excluded.learned_at, 0))`;

// Demote old self-declared nicknames when a new one replaces them — in the same
// origin only: a preference stated in one chat never rewrites another chat's names.
const DEMOTE_OLD_SELF_DECLARED = `UPDATE nicknames
  SET confidence = 0.3, source = 'observed'
  WHERE person_jid = ? AND origin_jid = ? AND source = 'self_declared' AND nickname != ?`;

const GET_ALL_NICKNAMES = `SELECT * FROM nicknames WHERE person_jid = ? ORDER BY confidence DESC, use_count DESC`;
const GET_GROUP_NICKNAMES = `SELECT n.*, p.push_name, p.real_name FROM nicknames n
  JOIN people p ON p.jid = n.person_jid
  WHERE n.origin_jid = ?
  ORDER BY n.confidence DESC`;

const GET_ACTIVE_PEOPLE_IN_GROUP = `SELECT p.jid, p.phone, p.push_name, p.real_name, p.message_count,
    p.first_seen, p.last_seen, gm.role FROM people p
  JOIN group_members gm ON gm.person_jid = p.jid
  WHERE gm.group_jid = ? AND p.jid NOT LIKE '%@g.us'
  ORDER BY p.last_seen DESC`;

const nowSec = () => Math.floor(Date.now() / 1000);
const canonical = (jid) => resolvePerson(jid) || bareJid(jid);

function validOrigin(originKind, originJid) {
  return ORIGIN_KINDS.has(originKind) && typeof originJid === 'string' && originJid.trim().length > 0;
}

export function upsertPerson(jid, phone, pushName) {
  const db = getDb();
  return db.prepare(UPSERT_PERSON).run(jid, phone, pushName || null);
}

/** Identity fields only (jid, phone, names, counters) — no profile text. */
export function getPerson(jid) {
  const db = getDb();
  return db.prepare(GET_PERSON).get(jid) || null;
}

export function updateRealName(jid, realName) {
  const db = getDb();
  return db.prepare(UPDATE_REAL_NAME).run(realName, jid);
}

// ── Facets (per-origin profile) ──────────────────────────────────────────────

function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = []; const seen = new Set();
  for (const x of list) {
    const v = typeof x === 'string' ? x.trim().slice(0, 80) : '';
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Write one origin's view of a person (contracts/recall.md). Owner facets (dashboard
 * edits) replace the given fields and carry a visibility (default 'subject_dm');
 * learned facets merge — newest traits/interests first, capped — and learned_at =
 * MAX(existing, new), so a re-observation never back-dates (R9). Fails closed: an
 * invalid origin is refused (returns null), never written as unscoped.
 */
export function upsertFacet(personJid, originKind, originJid, { summary, traits, interests } = {},
  { learnedAt = null, visibility = null } = {}) {
  const person = canonical(personJid);
  if (!person || !validOrigin(originKind, originJid)) {
    logger.debug({ originKind, hasOrigin: !!originJid }, 'upsertFacet refused: missing person or origin');
    return null;
  }
  const isOwner = originKind === 'owner';
  const learned = Number.isFinite(learnedAt) ? Math.floor(learnedAt) : nowSec();
  const newSummary = typeof summary === 'string' ? summary.trim().slice(0, 1000) : undefined;
  const newTraits = cleanList(traits);
  const newInterests = cleanList(interests);

  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare(`SELECT summary, traits_json, interests_json, visibility, learned_at FROM person_facets
      WHERE person_jid = ? AND origin_jid = ?`).get(person, originJid);
    const merge = (fresh, old) => {
      if (!fresh) return parseList(old);
      return isOwner ? fresh : cleanList([...fresh, ...parseList(old)]);
    };
    const row = {
      summary: newSummary !== undefined ? (newSummary || null) : (cur?.summary ?? null),
      traits: JSON.stringify(merge(newTraits, cur?.traits_json)),
      interests: JSON.stringify(merge(newInterests, cur?.interests_json)),
      visibility: isOwner ? (VISIBILITIES.has(visibility) ? visibility : (cur?.visibility || 'subject_dm')) : null,
      learnedAt: isOwner ? (cur?.learned_at ?? learned) : Math.max(cur?.learned_at ?? 0, learned),
    };
    db.prepare(`INSERT INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, interests_json,
        visibility, learned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(person_jid, origin_jid) DO UPDATE SET
        summary = excluded.summary, traits_json = excluded.traits_json, interests_json = excluded.interests_json,
        visibility = excluded.visibility, learned_at = excluded.learned_at, updated_at = unixepoch()`)
      .run(person, originKind, originJid, row.summary, row.traits, row.interests, row.visibility, row.learnedAt);
    return { personJid: person, originJid, visibility: row.visibility };
  })();
}

/** Dashboard-only: every facet of a person, one row per origin (operator view, unfiltered). */
export function getAllFacets(personJid) {
  const person = canonical(personJid);
  if (!person) return [];
  return getDb().prepare(`SELECT person_jid, origin_kind, origin_jid, summary, traits_json, interests_json, visibility,
      learned_at, updated_at FROM person_facets WHERE person_jid = ?
    ORDER BY origin_kind = 'owner' DESC, updated_at DESC`)
    .all(person).map(r => ({ ...r, traits: parseList(r.traits_json), interests: parseList(r.interests_json) }));
}

// Dashboard-only shims for the owner facet (the person page's summary / traits /
// interests fields): they write origin 'owner' and keep its visibility. Never call
// them from a learning path — learned facets carry their own origin.
export function updateSummary(jid, summary) {
  return upsertFacet(jid, 'owner', 'owner', { summary: summary ?? '' });
}
export function updateTraits(jid, traits) {
  return upsertFacet(jid, 'owner', 'owner', { traits: Array.isArray(traits) ? traits : [] });
}
export function updateInterests(jid, interests) {
  return upsertFacet(jid, 'owner', 'owner', { interests: Array.isArray(interests) ? interests : [] });
}

// ── Nicknames ────────────────────────────────────────────────────────────────

/**
 * Record a nickname observed in one chat (contracts/recall.md). Fails closed: a
 * missing origin is refused (returns null). opts.learnedAt defaults to now (an
 * ingest-time observation).
 */
export function upsertNickname(personJid, nickname, originKind, originJid, usedBy = null, confidence = 0.3,
  source = 'observed', { learnedAt = null } = {}) {
  const person = canonical(personJid);
  const nick = typeof nickname === 'string' ? nickname.trim().slice(0, 60) : '';
  if (!person || !nick || !validOrigin(originKind, originJid)) {
    logger.debug({ originKind, hasOrigin: !!originJid }, 'upsertNickname refused: missing person, nickname or origin');
    return null;
  }
  const db = getDb();
  const learned = Number.isFinite(learnedAt) ? Math.floor(learnedAt) : nowSec();
  return db.transaction(() => {
    // When someone declares a new preferred name, demote the old one (same origin).
    if (source === 'self_declared') db.prepare(DEMOTE_OLD_SELF_DECLARED).run(person, originJid, nick);
    return db.prepare(UPSERT_NICKNAME).run(person, nick, originKind, originJid,
      usedBy ? canonical(usedBy) : null, confidence, source || 'observed', learned);
  })();
}

/**
 * Dashboard-only: every nickname of a person across all origins (operator view).
 * Prompt builders read nicknames through recall.js recallNicknames (import guard).
 */
export function getAllNicknames(personJid) {
  const db = getDb();
  return db.prepare(GET_ALL_NICKNAMES).all(canonical(personJid) || personJid);
}

/** Dashboard-only: nicknames observed in one group. */
export function getGroupNicknames(groupJid) {
  const db = getDb();
  return db.prepare(GET_GROUP_NICKNAMES).all(groupJid);
}

/** Members of a group with identity fields + role (no profile text). */
export function getActivePeopleInGroup(groupJid) {
  const db = getDb();
  return db.prepare(GET_ACTIVE_PEOPLE_IN_GROUP).all(groupJid);
}

/**
 * Find a person in a group by a phone suffix (e.g. last 4–10 digits).
 * Used when the bot emits "@5550100123" or "@+1..." tokens.
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
  // 2. Nickname match (observed in this group, or owner-set) — only if exactly one
  // current member goes by it. This only maps a name the reply already contains to
  // a tag, so it discloses nothing. An ambiguous nickname must not silently tag
  // whichever row happens to sort first.
  const nickJids = new Set(db.prepare(
    `SELECT DISTINCT n.person_jid FROM nicknames n
     WHERE LOWER(n.nickname) = ? AND (n.origin_jid = ? OR n.origin_kind = 'owner')`
  ).all(needle, groupJid).map(r => r.person_jid));
  const nickHits = people.filter(p => nickJids.has(p.jid));
  if (nickHits.length === 1) return nickHits[0];
  // 3. Prefix / contains fallback (only if unambiguous)
  const starts = people.filter(p =>
    (p.push_name || '').toLowerCase().startsWith(needle)
    || (p.real_name || '').toLowerCase().startsWith(needle)
  );
  if (starts.length === 1) return starts[0];
  return null;
}
