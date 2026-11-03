// Canonical person identity across WhatsApp JID forms (spec 006, R5).
//
// people.jid stays the canonical id. person_identities maps every form we have seen
// (LID, PN, device-suffixed) to it. Sources are platform-attested only — group sync
// attributes, message key alt fields (participantAlt / remoteJidAlt), Baileys
// lid-mapping events — never display names, and never people.phone for @lid rows
// (that column holds LID digits there).
//
// Merge vs reassignment: a PN pairing with a LID merges two rows only when one side
// has no LID yet (the same human, seen first by phone). A PN that now pairs with a
// *different* LID is a recycled number: the PN mapping moves, nothing merges (a
// previous owner whose canonical id was the PN itself is first moved onto their
// LID, so the new owner inherits nothing). A merge where EITHER side has DM data
// (DM-origin items, owner notes about them, or DM messages) waits for the owner
// (identity_merge_queue, dashboard): a PN-only legacy row can be a stranger whose
// number was recycled, and nothing on the platform tells the two cases apart.
//
// DM messages stay readable across forms: messageStore reads a person chat over
// every identity form, so re-keying messages.group_jid on a merge never splits a
// transcript (new DMs keep arriving on whatever chat id WhatsApp uses).
//
// Nothing here throws into message handling: errors are logged and swallowed.

import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { getSelfIdDigits } from '../utils/selfIdentity.js';
import { memoryFingerprint } from './migrations/fingerprint.js';

const SOURCES = new Set(['sync', 'message', 'phone', 'lidmap', 'merge']);
// Sources allowed to merge or reassign. 'phone' (a number typed on the dashboard or
// derived from a call) may only add a mapping for an unseen JID.
const TRUSTED = new Set(['sync', 'message', 'lidmap', 'merge']);

const CACHE_MAX = 5000;
const cache = new Map();          // bare jid → canonical person jid (positive hits only)
const listeners = new Set();

/** "9198…:12@s.whatsapp.net" → "9198…@s.whatsapp.net". Non-strings → null. */
export function bareJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  return jid.trim().replace(/:\d+(?=@)/, '');
}

/** A JID that can be a person (LID or PN form). Groups, ig:*, 'self', 'owner' are not. */
export function isPersonJid(jid) {
  const b = bareJid(jid);
  return !!b && (b.endsWith('@lid') || b.endsWith('@s.whatsapp.net'));
}

function kindOf(jid) {
  if (jid.endsWith('@lid')) return 'lid';
  if (jid.endsWith('@s.whatsapp.net')) return 'pn';
  return null;
}

/** True for any of the bot's own JID forms (PN/LID, any device). */
export function isSelfJid(jid) {
  const b = bareJid(jid);
  if (!b) return false;
  const digits = b.split('@')[0].replace(/\D/g, '');
  return !!digits && getSelfIdDigits().has(digits);
}

/** fn({ type: 'record'|'merge'|'reassign', keepJid?, dropJid?, jid?, personJid? }) on identity changes. */
export function onIdentityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Drop cached resolutions after identity rows were deleted outside this module (purge). */
export function invalidateIdentityCache() {
  cache.clear();
}

function notify(change) {
  cache.clear();
  for (const fn of listeners) {
    try { fn(change); } catch { /* listeners never break identity writes */ }
  }
}

function normalizeInput(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const s = jid.trim();
  // A bare phone number ("+1 555…") is treated as its PN JID.
  if (/^\+?[\d\s-]{6,}$/.test(s)) return `${s.replace(/\D/g, '')}@s.whatsapp.net`;
  return bareJid(s);
}

/**
 * Canonical people.jid for any JID form (or a bare phone number), or null if this
 * person is unknown. Synchronous (DB + small cache). Never throws.
 */
export function resolvePerson(jid) {
  const bare = normalizeInput(jid);
  if (!bare || !isPersonJid(bare)) return null;
  const hit = cache.get(bare);
  if (hit) return hit;
  try {
    const db = getDb();
    let person = db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck().get(bare)
      || db.prepare('SELECT jid FROM people WHERE jid = ?').pluck().get(bare)
      || null;
    if (!person && bare.endsWith('@s.whatsapp.net')) {
      // people.phone is only trusted on PN rows (on @lid rows it holds LID digits).
      person = db.prepare(`SELECT jid FROM people WHERE phone = ? AND jid LIKE '%@s.whatsapp.net' LIMIT 1`)
        .pluck().get(bare.split('@')[0]) || null;
    }
    if (person) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(bare, person);
    }
    return person;
  } catch (err) {
    logger.debug({ err: err.message }, 'resolvePerson failed');
    return null;
  }
}

/** Every known JID form of a canonical person (always includes the person id itself). */
export function identitiesOf(personJid) {
  const p = bareJid(personJid);
  if (!p) return [];
  try {
    const rows = getDb().prepare('SELECT jid FROM person_identities WHERE person_jid = ?').pluck().all(p);
    return [...new Set([p, ...rows])];
  } catch {
    return [p];
  }
}

function hasLid(db, personJid) {
  if (personJid.endsWith('@lid')) return true;
  return !!db.prepare(`SELECT 1 FROM person_identities WHERE person_jid = ? AND kind = 'lid' LIMIT 1`).get(personJid);
}

function lidOf(db, personJid) {
  if (personJid.endsWith('@lid')) return personJid;
  return db.prepare(`SELECT jid FROM person_identities WHERE person_jid = ? AND kind = 'lid' ORDER BY seen_at DESC LIMIT 1`)
    .pluck().get(personJid) || null;
}

/**
 * Anything private to this person's DM: DM/call-origin memories or facets, owner
 * notes about them, or DM messages they wrote (a DM that was never batched still
 * holds the whole conversation).
 */
function hasDmData(db, personJid) {
  const forms = identitiesOf(personJid);
  const marks = forms.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM memories WHERE origin_kind IN ('dm', 'call') AND origin_jid IN (${marks}) LIMIT 1`).get(...forms)
    || !!db.prepare(`SELECT 1 FROM memories WHERE origin_kind = 'owner' AND subject_jid IN (${marks}) LIMIT 1`).get(...forms)
    || !!db.prepare(`SELECT 1 FROM person_facets WHERE (origin_kind IN ('dm', 'call') AND origin_jid IN (${marks}))
        OR (origin_kind = 'owner' AND person_jid IN (${marks})) LIMIT 1`).get(...forms, ...forms)
    || !!db.prepare(`SELECT 1 FROM messages WHERE group_jid IN (${marks}) AND COALESCE(is_from_self, 0) = 0 LIMIT 1`).get(...forms);
}

function upsertIdentityRow(db, jid, personJid, source) {
  db.prepare(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(jid) DO UPDATE SET person_jid = excluded.person_jid, source = excluded.source, seen_at = unixepoch()`)
    .run(jid, personJid, kindOf(jid), source);
}

// A pair the owner rejected stays rejected (either orientation) until evidence of
// another kind turns up. `reason` is `<conflict|dm_data>:<source>`; the source is only
// the channel the pairing came in on (message, sync, lidmap — the same platform fact),
// so a rejection is keyed on the class alone: only a reason of another class (dm_data
// turning into conflict, or back) queues the pair again. recordIdentity runs on every
// message and sync, so a skip is logged at debug only.
const reasonClass = (reason) => String(reason ?? '').split(':')[0];

function queueMerge(db, keepJid, dropJid, reason) {
  const pair = 'AND ((keep_jid = ? AND drop_jid = ?) OR (keep_jid = ? AND drop_jid = ?))';
  const pending = db.prepare(`SELECT id FROM identity_merge_queue WHERE decided_at IS NULL ${pair}`)
    .get(keepJid, dropJid, dropJid, keepJid);
  if (pending) return pending.id;
  const rejectedReasons = db.prepare(`SELECT reason FROM identity_merge_queue WHERE decision = 'rejected' ${pair}`)
    .pluck().all(keepJid, dropJid, dropJid, keepJid);
  if (rejectedReasons.some(r => reasonClass(r) === reasonClass(reason))) {
    logger.debug({ keepJid, dropJid, reason }, 'identity merge not re-queued: the owner rejected this pair');
    return null;
  }
  const info = db.prepare('INSERT INTO identity_merge_queue (keep_jid, drop_jid, reason) VALUES (?, ?, ?)')
    .run(keepJid, dropJid, reason);
  logger.info({ keepJid, dropJid, reason }, 'identity_merge_queued');
  return Number(info.lastInsertRowid);
}

/**
 * Record that `jid` is a form of `personJid`. Idempotent. When `jid` already maps to
 * a different person and the source is trusted: one side without a LID → merge
 * (or queue it when either side has DM data); a PN between two different LIDs →
 * reassignment (the PN mapping moves). Never throws.
 * @param {'sync'|'message'|'phone'|'lidmap'|'merge'} source
 */
export function recordIdentity(jid, personJid, source) {
  try {
    const a = bareJid(jid);
    const target = bareJid(personJid);
    if (!a || !target || !isPersonJid(a) || !isPersonJid(target)) return;
    if (!SOURCES.has(source)) { logger.debug({ source }, 'recordIdentity: unknown source ignored'); return; }
    if (isSelfJid(a) || isSelfJid(target)) return;   // the bot is not a person in its own memory
    const db = getDb();
    const p = resolvePerson(target) || target;
    if (!db.prepare('SELECT 1 FROM person_identities WHERE jid = ?').get(p)) upsertIdentityRow(db, p, p, source);

    const current = db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck().get(a)
      || db.prepare('SELECT jid FROM people WHERE jid = ?').pluck().get(a)
      || null;

    if (current === p) {
      db.prepare('UPDATE person_identities SET seen_at = unixepoch() WHERE jid = ?').run(a);
      if (a === p || db.prepare('SELECT 1 FROM person_identities WHERE jid = ?').get(a)) return;
    }
    if (!current || current === p) {
      // First binding of this form: rows stored under the raw form (before we knew
      // whose it was) belong to that person. Messages stay keyed by their chat id.
      db.transaction(() => {
        if (a !== p) moveRows(db, p, a, Math.floor(Date.now() / 1000), { messages: false });
        upsertIdentityRow(db, a, p, source);
      })();
      notify({ type: 'record', jid: a, personJid: p });
      return;
    }

    // `a` already belongs to someone else.
    if (!TRUSTED.has(source)) {
      logger.debug({ jid: a, source }, 'recordIdentity: untrusted source cannot move a mapping');
      return;
    }
    const qHasLid = hasLid(db, current);
    const pHasLid = hasLid(db, p);
    if (qHasLid && pHasLid) {
      if (kindOf(a) === 'pn' && lidOf(db, current) !== lidOf(db, p)) {
        // Recycled number: the PN now belongs to another account. Never merge. Rows
        // still keyed by the raw PN are the previous owner's — re-key them to that
        // owner BEFORE the PN moves, so the new owner never inherits them. When the
        // previous owner's canonical id IS the PN, they move to their LID first
        // (people row, items, DM messages, identity forms); otherwise every row keyed
        // by the PN would follow the PN to the new owner.
        const prevLid = lidOf(db, current);
        if (current === a && !prevLid) {
          logger.warn({ jid: a, source }, 'identity reassignment refused: previous owner has no LID to move to');
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const prevOwner = current === a ? prevLid : current;
        db.transaction(() => {
          if (current === a) {
            mergePeopleRow(db, prevLid, a);
            // The number is no longer theirs.
            db.prepare('UPDATE people SET phone = NULL WHERE jid = ? AND phone = ?').run(prevLid, a.split('@')[0]);
            if (!db.prepare('SELECT 1 FROM person_identities WHERE jid = ?').get(prevLid)) {
              upsertIdentityRow(db, prevLid, prevLid, 'merge');
            }
          }
          moveRows(db, prevOwner, a, now, { messages: true });
          if (current === a) db.prepare('DELETE FROM people WHERE jid = ?').run(a);
          upsertIdentityRow(db, a, p, source);
          db.prepare('INSERT INTO dashboard_audit (actor, action, target, payload_json) VALUES (?, ?, ?, ?)')
            .run('system:identity', 'identity.reassign', a, JSON.stringify({ from: prevOwner, to: p, source }));
        })();
        logger.info({ jid: a, from: prevOwner, to: p, source }, 'identity_reassigned');
        notify({ type: 'reassign', jid: a, personJid: p });
      } else {
        queueMerge(db, p, current, `conflict:${source}`);
      }
      return;
    }
    // One side has no LID yet → the same human seen under two forms. Keep the LID side.
    // A PN-only row may be a stranger whose number was recycled: DM data on either
    // side waits for the owner rather than flowing to the other row.
    const [keep, drop] = pHasLid || !qHasLid ? [p, current] : [current, p];
    if (hasDmData(db, keep) || hasDmData(db, drop)) {
      queueMerge(db, keep, drop, `dm_data:${source}`);
      return;
    }
    mergePeople(keep, drop, `auto:${source}`);
  } catch (err) {
    logger.warn({ err: err.message, source }, 'recordIdentity failed');
  }
}

// ── mergePeople ──────────────────────────────────────────────────────────────

const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const unionList = (a, b) => {
  const out = []; const seen = new Set();
  for (const x of [...parseList(a), ...parseList(b)]) {
    const k = String(x).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return JSON.stringify(out);
};
const minDefined = (...v) => { const n = v.filter(Number.isFinite); return n.length ? Math.min(...n) : null; };
const maxDefined = (...v) => { const n = v.filter(Number.isFinite); return n.length ? Math.max(...n) : null; };
// learned_at: unknown on either side stays unknown (NULL never crosses chats), like
// addItemOrigins and addMemory's re-observation.
const minLearned = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.min(a, b) : null);

function mergeMemories(db, keep, drop, now) {
  const rows = db.prepare(`SELECT id, subject_jid, origin_jid, content, superseded_by FROM memories
    WHERE subject_jid = ? OR origin_jid = ?`).all(drop, drop);
  const setRow = db.prepare('UPDATE memories SET subject_jid = ?, origin_jid = ?, fingerprint = ? WHERE id = ?');
  const supersede = db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?');
  const currentByFp = db.prepare('SELECT id FROM memories WHERE fingerprint = ? AND superseded_by IS NULL AND id != ?').pluck();
  for (const r of rows) {
    const subject = r.subject_jid === drop ? keep : r.subject_jid;
    const origin = r.origin_jid === drop ? keep : r.origin_jid;
    const fp = memoryFingerprint({ originJid: origin, subjectJid: subject, content: r.content });
    if (r.superseded_by == null) {
      const other = currentByFp.get(fp, r.id);
      if (other != null) {
        // The same claim now exists twice: the older is kept as history (R9).
        if (other < r.id) supersede.run(r.id, now, other);
        else { supersede.run(other, now, r.id); setRow.run(subject, origin, fp, r.id); continue; }
      }
    }
    setRow.run(subject, origin, fp, r.id);
  }
}

function mergeFacets(db, keep, drop) {
  const rows = db.prepare('SELECT rowid AS rid, * FROM person_facets WHERE person_jid = ? OR origin_jid = ?').all(drop, drop);
  const find = db.prepare('SELECT rowid AS rid, * FROM person_facets WHERE person_jid = ? AND origin_jid = ?');
  for (const r of rows) {
    const person = r.person_jid === drop ? keep : r.person_jid;
    const origin = r.origin_jid === drop ? keep : r.origin_jid;
    const into = find.get(person, origin);
    if (into && into.rid !== r.rid) {
      db.prepare(`UPDATE person_facets SET summary = COALESCE(summary, ?), traits_json = ?, interests_json = ?,
          learned_at = ?, updated_at = unixepoch() WHERE rowid = ?`)
        .run(r.summary, unionList(into.traits_json, r.traits_json), unionList(into.interests_json, r.interests_json),
          minLearned(into.learned_at, r.learned_at), into.rid);
      db.prepare('DELETE FROM person_facets WHERE rowid = ?').run(r.rid);
    } else {
      db.prepare('UPDATE person_facets SET person_jid = ?, origin_jid = ? WHERE rowid = ?').run(person, origin, r.rid);
    }
  }
}

function mergeNicknames(db, keep, drop) {
  db.prepare('UPDATE nicknames SET used_by = ? WHERE used_by = ?').run(keep, drop);
  const rows = db.prepare('SELECT * FROM nicknames WHERE person_jid = ? OR origin_jid = ?').all(drop, drop);
  const find = db.prepare('SELECT * FROM nicknames WHERE person_jid = ? AND nickname = ? AND origin_jid = ? AND id != ?');
  for (const r of rows) {
    const person = r.person_jid === drop ? keep : r.person_jid;
    const origin = r.origin_jid === drop ? keep : r.origin_jid;
    const into = find.get(person, r.nickname, origin, r.id);
    if (into) {
      db.prepare(`UPDATE nicknames SET use_count = ?, confidence = ?, first_seen = ?, last_used = ?, learned_at = ? WHERE id = ?`)
        .run((into.use_count || 0) + (r.use_count || 0), maxDefined(into.confidence, r.confidence),
          minDefined(into.first_seen, r.first_seen), maxDefined(into.last_used, r.last_used),
          minLearned(into.learned_at, r.learned_at), into.id);
      db.prepare('DELETE FROM nicknames WHERE id = ?').run(r.id);
    } else {
      db.prepare('UPDATE nicknames SET person_jid = ?, origin_jid = ? WHERE id = ?').run(person, origin, r.id);
    }
  }
}

function mergeRelationships(db, keep, drop) {
  const rows = db.prepare('SELECT * FROM relationships WHERE person_a_jid = ? OR person_b_jid = ? OR origin_jid = ?')
    .all(drop, drop, drop);
  const find = db.prepare('SELECT * FROM relationships WHERE person_a_jid = ? AND person_b_jid = ? AND origin_jid = ? AND id != ?');
  for (const r of rows) {
    const x = r.person_a_jid === drop ? keep : r.person_a_jid;
    const y = r.person_b_jid === drop ? keep : r.person_b_jid;
    const origin = r.origin_jid === drop ? keep : r.origin_jid;
    if (x === y) { db.prepare('DELETE FROM relationships WHERE id = ?').run(r.id); continue; }
    const [a, b] = x < y ? [x, y] : [y, x];
    const into = find.get(a, b, origin, r.id);
    if (into) {
      db.prepare(`UPDATE relationships SET relationship = COALESCE(relationship, ?), dynamic = COALESCE(dynamic, ?),
          strength = ?, learned_at = ?, updated_at = ? WHERE id = ?`)
        .run(r.relationship, r.dynamic, maxDefined(into.strength, r.strength), minLearned(into.learned_at, r.learned_at),
          maxDefined(into.updated_at, r.updated_at), into.id);
      db.prepare('DELETE FROM relationships WHERE id = ?').run(r.id);
    } else {
      db.prepare('UPDATE relationships SET person_a_jid = ?, person_b_jid = ?, origin_jid = ? WHERE id = ?').run(a, b, origin, r.id);
    }
  }
}

function mergeSlang(db, keep, drop) {
  for (const r of db.prepare('SELECT * FROM slang WHERE origin_jid = ?').all(drop)) {
    const into = db.prepare('SELECT * FROM slang WHERE term = ? AND origin_jid = ?').get(r.term, keep);
    if (into) {
      db.prepare('UPDATE slang SET use_count = ?, meaning = COALESCE(meaning, ?), first_seen = ? WHERE id = ?')
        .run((into.use_count || 0) + (r.use_count || 0), r.meaning, minDefined(into.first_seen, r.first_seen), into.id);
      db.prepare('DELETE FROM slang WHERE id = ?').run(r.id);
    } else {
      db.prepare('UPDATE slang SET origin_jid = ? WHERE id = ?').run(keep, r.id);
    }
  }
}

function mergeItemOrigins(db, keep, drop) {
  // A conflict keeps the earlier min_learned_at (the stricter join-time floor); an
  // unknown floor on either side stays unknown.
  db.prepare(`UPDATE item_origins AS k SET min_learned_at = CASE
        WHEN k.min_learned_at IS NULL OR d.min_learned_at IS NULL THEN NULL
        ELSE MIN(k.min_learned_at, d.min_learned_at) END
      FROM item_origins AS d
      WHERE k.origin_jid = ? AND d.origin_jid = ? AND d.item_type = k.item_type AND d.item_id = k.item_id`).run(keep, drop);
  db.prepare('UPDATE OR IGNORE item_origins SET origin_jid = ? WHERE origin_jid = ?').run(keep, drop);
  db.prepare('DELETE FROM item_origins WHERE origin_jid = ?').run(drop);
}

function mergeMembership(db, keep, drop) {
  // Two rows for one human in one group: keep the LATER join time (fail closed — a
  // later join can only hide items, never reveal them).
  for (const r of db.prepare('SELECT * FROM group_members WHERE person_jid = ?').all(drop)) {
    const into = db.prepare('SELECT * FROM group_members WHERE group_jid = ? AND person_jid = ?').get(r.group_jid, keep);
    if (into) {
      db.prepare('UPDATE group_members SET joined_at = ?, role = COALESCE(role, ?) WHERE group_jid = ? AND person_jid = ?')
        .run(maxDefined(into.joined_at, r.joined_at), r.role, r.group_jid, keep);
      db.prepare('DELETE FROM group_members WHERE group_jid = ? AND person_jid = ?').run(r.group_jid, drop);
    } else {
      db.prepare('UPDATE group_members SET person_jid = ? WHERE group_jid = ? AND person_jid = ?').run(keep, r.group_jid, drop);
    }
  }
  db.prepare('UPDATE group_membership_log SET person_jid = ? WHERE person_jid = ?').run(keep, drop);
}

function mergeLearningState(db, keep, drop) {
  const d = db.prepare('SELECT * FROM learning_state WHERE chat_jid = ?').get(drop);
  if (!d) return;
  const k = db.prepare('SELECT * FROM learning_state WHERE chat_jid = ?').get(keep);
  if (k) {
    db.prepare('UPDATE learning_state SET msgs_since_batch = ?, last_batch_rowid = ?, last_batch_at = ? WHERE chat_jid = ?')
      .run((k.msgs_since_batch || 0) + (d.msgs_since_batch || 0), maxDefined(k.last_batch_rowid, d.last_batch_rowid) || 0,
        maxDefined(k.last_batch_at, d.last_batch_at), keep);
    db.prepare('DELETE FROM learning_state WHERE chat_jid = ?').run(drop);
  } else {
    db.prepare('UPDATE learning_state SET chat_jid = ? WHERE chat_jid = ?').run(keep, drop);
  }
}

function mergePeopleRow(db, keep, drop) {
  const d = db.prepare('SELECT * FROM people WHERE jid = ?').get(drop);
  const k = db.prepare('SELECT * FROM people WHERE jid = ?').get(keep);
  if (!d) return;
  if (!k) {
    // Insert the keep row first so child rows can point at it under foreign_keys=ON.
    db.prepare(`INSERT INTO people (jid, phone, push_name, real_name, message_count, first_seen, last_seen, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`)
      .run(keep, d.phone && drop.endsWith('@s.whatsapp.net') ? d.phone : null, d.push_name, d.real_name,
        d.message_count || 0, d.first_seen, d.last_seen);
    return;
  }
  // phone is only kept from a PN row (on @lid rows it holds LID digits).
  db.prepare(`UPDATE people SET
      phone = COALESCE(CASE WHEN jid LIKE '%@s.whatsapp.net' THEN phone END, ?, phone),
      push_name = COALESCE(push_name, ?), real_name = COALESCE(real_name, ?),
      message_count = COALESCE(message_count, 0) + ?, first_seen = ?, last_seen = ?, updated_at = unixepoch()
    WHERE jid = ?`)
    .run(drop.endsWith('@s.whatsapp.net') ? d.phone : null, d.push_name, d.real_name, d.message_count || 0,
      minDefined(k.first_seen, d.first_seen), maxDefined(k.last_seen, d.last_seen), keep);
}

/**
 * Re-key every row that names `drop` (as a person or as a DM chat) onto `keep`:
 * memories (fingerprints recomputed), facets, item_origins, nicknames, relationships,
 * slang, membership + log, learning_state, forget tombstones, relays, voice, style cards, imitation,
 * IG links, calls and — with { messages: true } — messages. Runs inside the caller's
 * transaction; the caller owns the people rows and the identity rows of drop.
 */
function moveRows(db, keep, drop, now, { messages = true } = {}) {
  // Child rows with an FK to people need the keep row to exist first.
  const referenced = db.prepare(`SELECT 1 FROM group_members WHERE person_jid = ?
      UNION ALL SELECT 1 FROM nicknames WHERE person_jid = ?
      UNION ALL SELECT 1 FROM relationships WHERE person_a_jid = ? OR person_b_jid = ? LIMIT 1`).get(drop, drop, drop, drop);
  if (referenced) {
    db.prepare(`INSERT OR IGNORE INTO people (jid, phone, first_seen, message_count) VALUES (?, ?, unixepoch(), 0)`)
      .run(keep, keep.endsWith('@s.whatsapp.net') ? keep.split('@')[0] : null);
  }
  db.prepare('UPDATE person_identities SET person_jid = ? WHERE person_jid = ?').run(keep, drop);

  mergeMemories(db, keep, drop, now);
  mergeFacets(db, keep, drop);
  mergeItemOrigins(db, keep, drop);
  mergeNicknames(db, keep, drop);
  mergeRelationships(db, keep, drop);
  mergeSlang(db, keep, drop);
  mergeMembership(db, keep, drop);
  mergeLearningState(db, keep, drop);
  // "forget that" tombstones follow the person: their content key is matched with
  // origin_jid, so a forgotten claim restated after the merge is still refused.
  db.prepare('UPDATE learning_exclusions SET origin_jid = ? WHERE origin_jid = ?').run(keep, drop);
  db.prepare('UPDATE learning_exclusions SET person_jid = ? WHERE person_jid = ?').run(keep, drop);

  db.prepare('UPDATE relays SET requester_jid = ? WHERE requester_jid = ?').run(keep, drop);
  db.prepare('UPDATE relays SET source_dm_jid = ? WHERE source_dm_jid = ?').run(keep, drop);
  db.prepare('UPDATE relays SET target_jid = ? WHERE target_jid = ?').run(keep, drop);
  // A consented cloned voice belongs to the human; if both rows have one, keep's wins
  // and drop's row stays for maintenance to revoke.
  db.prepare('UPDATE OR IGNORE person_voice SET person_jid = ? WHERE person_jid = ?').run(keep, drop);
  const voiceLeft = !!db.prepare('SELECT 1 FROM person_voice WHERE person_jid = ?').get(drop);
  db.prepare('UPDATE OR IGNORE person_style_card SET person_jid = ? WHERE person_jid = ?').run(keep, drop);
  db.prepare('DELETE FROM person_style_card WHERE person_jid = ?').run(drop);
  db.prepare('UPDATE group_imitation SET target_jid = ? WHERE target_jid = ?').run(keep, drop);
  db.prepare('UPDATE ig_members SET person_jid = ? WHERE person_jid = ?').run(keep, drop);
  db.prepare('UPDATE calls SET person_jid = ? WHERE person_jid = ?').run(keep, drop);
  if (messages) {
    db.prepare('UPDATE messages SET sender_jid = ? WHERE sender_jid = ?').run(keep, drop);
    db.prepare('UPDATE messages SET group_jid = ? WHERE group_jid = ?').run(keep, drop);   // DM chat
    db.prepare('UPDATE messages SET quoted_participant = ? WHERE quoted_participant = ?').run(keep, drop);
  }
  return { voiceLeft };
}

/**
 * Fold `dropJid` into `keepJid` across every column that names a person or a DM
 * (R5), in one transaction, audited. Returns { merged, error? } — never throws.
 */
export function mergePeople(keepJid, dropJid, reason) {
  const keep = bareJid(keepJid);
  const drop = bareJid(dropJid);
  if (!keep || !drop || keep === drop || !isPersonJid(keep) || !isPersonJid(drop)) {
    return { merged: false, error: 'invalid' };
  }
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      mergePeopleRow(db, keep, drop);

      upsertIdentityRow(db, drop, keep, 'merge');
      if (!db.prepare('SELECT 1 FROM person_identities WHERE jid = ?').get(keep)) upsertIdentityRow(db, keep, keep, 'merge');
      const { voiceLeft } = moveRows(db, keep, drop, now, { messages: true });

      // Pending queue entries about the dropped row are moot now.
      db.prepare(`UPDATE identity_merge_queue SET decided_at = unixepoch(), decision = 'merged'
        WHERE decided_at IS NULL AND (keep_jid = ? OR drop_jid = ?)`).run(drop, drop);

      db.prepare('DELETE FROM people WHERE jid = ?').run(drop);

      db.prepare(`INSERT INTO dashboard_audit (actor, action, target, payload_json) VALUES (?, ?, ?, ?)`)
        .run('system:identity', 'identity.merge', keep, JSON.stringify({ drop, reason: String(reason || '').slice(0, 120) }));
      if (voiceLeft) logger.warn({ keep, drop }, 'identity merge: both people had a cloned voice; the dropped one is orphaned');
    })();
    logger.info({ keep, drop, reason }, 'identity_merged');
    notify({ type: 'merge', keepJid: keep, dropJid: drop });
    return { merged: true };
  } catch (err) {
    logger.warn({ err: err.message, keep, drop }, 'mergePeople failed');
    return { merged: false, error: err.message };
  }
}

// ── Merge queue (dashboard: approve / reject) ────────────────────────────────

/**
 * Merge queue rows, newest first. Default: pending only. `decision: 'rejected'`
 * lists the rejected pairs (kept so the same pair isn't queued again, see queueMerge);
 * `pendingOnly: false` lists every row.
 */
export function listMergeQueue({ pendingOnly = true, decision = null, limit = 100 } = {}) {
  const where = decision ? 'WHERE decision = ?' : pendingOnly ? 'WHERE decided_at IS NULL' : '';
  const args = decision ? [decision] : [];
  return getDb().prepare(`SELECT * FROM identity_merge_queue ${where}
    ORDER BY COALESCE(decided_at, created_at) DESC, id DESC LIMIT ?`).all(...args, Math.min(limit, 500));
}

/**
 * Owner decision on a queued merge. 'approved' runs mergePeople; 'rejected' only
 * records the decision. Returns { ok, merged?, error? }.
 */
export function decideMerge(id, decision, actor = 'dashboard') {
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: 'invalid decision' };
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM identity_merge_queue WHERE id = ? AND decided_at IS NULL').get(id);
    if (!row) return { ok: false, error: 'not found' };
    let merged = false;
    if (decision === 'approved') {
      const res = mergePeople(row.keep_jid, row.drop_jid, `owner:${actor}`);
      if (!res.merged) return { ok: false, error: res.error || 'merge failed' };
      merged = true;
    }
    db.prepare('UPDATE identity_merge_queue SET decided_at = unixepoch(), decision = ? WHERE id = ?').run(decision, id);
    return { ok: true, merged };
  } catch (err) {
    logger.warn({ err: err.message, id }, 'decideMerge failed');
    return { ok: false, error: err.message };
  }
}

/** Test-only: drop the resolve cache (after seeding identities with raw SQL). */
export function __clearIdentityCacheForTest() {
  cache.clear();
}
