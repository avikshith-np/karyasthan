// Memories and relationships with provenance (spec 006, R7/R9/R11/R15,
// contracts/recall.md "Writes").
//
// Every write names its origin: origin_kind ∈ {self, group, dm, call, ig, owner} and
// origin_jid = the chat it was learned in (a group JID, a canonical person id for a
// DM / call, 'ig:group', 'self' or 'owner'). learned_at is the earliest evidence
// timestamp, never the write time — recall.js shares an item with a later joiner of
// its group only when learned_at is after they joined. Unknown → NULL (never crosses
// chats).
//
// Reads for prompts go through recall.js. The getAll… readers at the bottom are
// unscoped and are for the dashboard (operator) only.

import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { memoryFingerprint, contentKey } from './migrations/fingerprint.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid, invalidateIdentityCache } from './identity.js';
import { redactPerson as lifeRedactPerson } from '../life/index.js';
import { revokeVoicesForPurge } from './voiceStore.js';
import { refreshSlangGlobal } from './groupStore.js';

const ORIGIN_KINDS = new Set(['self', 'group', 'dm', 'call', 'ig', 'owner']);
const VISIBILITIES = new Set(['subject_dm', 'subject_groups', 'everywhere']);
// item_evidence.item_type → the table holding that item and its id column.
const ITEM_TABLES = {
  memory: ['memories', 'id'],
  facet: ['person_facets', 'rowid'],
  nickname: ['nicknames', 'id'],
  relationship: ['relationships', 'id'],
  slang: ['slang', 'id'],
  mind_digest: ['mind_digests', 'id'],   // spec 008: the mind's per-chat clerk digests
};
const CONTENT_MAX = 1000;

const nowSec = () => Math.floor(Date.now() / 1000);
const marks = (n) => Array(n).fill('?').join(',');

function canonicalPerson(jid) {
  if (!jid || typeof jid !== 'string') return null;
  return resolvePerson(jid) || (isPersonJid(jid) ? bareJid(jid) : null);
}

/** Canonical origin chat id for a kind: DM/call → the person, group → bare JID. */
function canonicalOrigin(kind, originJid) {
  if (kind === 'owner') return 'owner';
  if (kind === 'self') return 'self';
  if (!originJid || typeof originJid !== 'string') return null;
  if (kind === 'dm' || kind === 'call') return canonicalPerson(originJid);
  if (kind === 'group') return originJid.endsWith('@g.us') ? bareJid(originJid) : null;
  return originJid.trim() || null;   // ig
}

function normEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  const out = new Map();
  for (const e of evidence) {
    const msgId = e && typeof e.msgId === 'string' ? e.msgId.trim() : '';
    if (!msgId || msgId.length > 200) continue;
    const ts = Number.isFinite(e.ts) ? Math.floor(e.ts) : null;
    if (!out.has(msgId)) out.set(msgId, { msgId, ts });
  }
  return [...out.values()];
}

function minTs(evidence) {
  const ts = evidence.map(e => e.ts).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : null;
}

// Message-backed evidence must still exist and must not be fenced by "forget that":
// a batch read before a revoke / forget must not write an item from it afterwards.
// Non-message evidence ('call:<id>') is kept as is.
function liveEvidence(db, evidence) {
  const msgIds = evidence.filter(e => !e.msgId.startsWith('call:')).map(e => e.msgId);
  if (!msgIds.length) return { evidence, fenced: false };
  const rows = db.prepare(`SELECT id, COALESCE(no_learn, 0) AS no_learn FROM messages
    WHERE id IN (${marks(msgIds.length)})`).all(...msgIds);
  if (rows.some(r => r.no_learn)) return { evidence: [], fenced: true };
  const present = new Set(rows.map(r => r.id));
  return { evidence: evidence.filter(e => e.msgId.startsWith('call:') || present.has(e.msgId)), fenced: false };
}

// ── Evidence / derived origins ───────────────────────────────────────────────

/** Record which messages an item was learned from. Idempotent. */
export function addEvidence(itemType, itemId, evidence) {
  if (!ITEM_TABLES[itemType] || !Number.isFinite(Number(itemId))) return 0;
  const list = normEvidence(evidence);
  if (!list.length) return 0;
  const stmt = getDb().prepare(`INSERT OR IGNORE INTO item_evidence (item_type, item_id, msg_id, ts)
    VALUES (?, ?, ?, ?)`);
  let n = 0;
  for (const e of list) n += stmt.run(itemType, Number(itemId), e.msgId, e.ts).changes;
  return n;
}

/**
 * Contributing origins of a derived item (R14). Every one must pass the audience
 * rule at recall time. A repeated origin keeps the EARLIEST min_learned_at (the
 * stricter floor); an unknown one stays NULL (never crosses chats).
 */
export function addItemOrigins(itemType, itemId, origins) {
  if (!ITEM_TABLES[itemType] || !Number.isFinite(Number(itemId)) || !Array.isArray(origins)) return 0;
  const stmt = getDb().prepare(`INSERT INTO item_origins (item_type, item_id, origin_jid, min_learned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(item_type, item_id, origin_jid) DO UPDATE SET
      min_learned_at = CASE WHEN excluded.min_learned_at IS NULL OR min_learned_at IS NULL THEN NULL
                            ELSE MIN(min_learned_at, excluded.min_learned_at) END`);
  let n = 0;
  for (const o of origins) {
    const jid = o && typeof o.originJid === 'string' ? o.originJid.trim() : '';
    if (!jid) continue;
    n += stmt.run(itemType, Number(itemId), jid, Number.isFinite(o.minLearnedAt) ? Math.floor(o.minLearnedAt) : null).changes;
  }
  return n;
}

// Delete items plus their evidence/origin rows. byType: { memory: [ids], facet: [rowids], … }.
// Items a deleted memory had superseded stay superseded (history, never recalled).
// A deleted slang row can leave its term explained in fewer than 2 chats: the
// remaining rows' is_global is recomputed.
function deleteItems(db, byType) {
  let deleted = 0;
  const slangTerms = new Set();
  for (const [type, ids] of Object.entries(byType)) {
    const t = ITEM_TABLES[type];
    if (!t || !ids?.length) continue;
    const [table, idCol] = t;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const m = marks(chunk.length);
      if (type === 'slang') {
        for (const term of db.prepare(`SELECT DISTINCT term FROM slang WHERE id IN (${m})`).pluck().all(...chunk)) slangTerms.add(term);
      }
      deleted += db.prepare(`DELETE FROM ${table} WHERE ${idCol} IN (${m})`).run(...chunk).changes;
      db.prepare(`DELETE FROM item_evidence WHERE item_type = ? AND item_id IN (${m})`).run(type, ...chunk);
      db.prepare(`DELETE FROM item_origins WHERE item_type = ? AND item_id IN (${m})`).run(type, ...chunk);
    }
  }
  for (const term of slangTerms) refreshSlangGlobal(db, term);
  return deleted;
}

// Items (by type) whose evidence includes any of these message ids.
function itemsEvidencedBy(db, msgIds) {
  const byType = {};
  for (let i = 0; i < msgIds.length; i += 400) {
    const chunk = msgIds.slice(i, i + 400);
    const rows = db.prepare(`SELECT DISTINCT item_type, item_id FROM item_evidence
      WHERE msg_id IN (${marks(chunk.length)})`).all(...chunk);
    for (const r of rows) (byType[r.item_type] ||= new Set()).add(r.item_id);
  }
  return Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, [...v]]));
}

function audit(db, actor, action, target, payload) {
  db.prepare('INSERT INTO dashboard_audit (actor, action, target, payload_json) VALUES (?, ?, ?, ?)')
    .run(actor, action, target, JSON.stringify(payload));
}

// ── Deletion / purge hooks (spec 008 R9) ─────────────────────────────────────
// Derived state outside these tables (the mind's episode log, drafts, notes) must not
// outlive a forget, revoke, edit or purge. Listeners run synchronously inside the 006
// transaction, after deleteItems. forget/revoke/edit: each listener runs in its own
// savepoint and an error is logged and swallowed (a listener bug must never undo a
// user's revoke). purge: errors propagate and roll the whole purge back.

const itemsDeletedListeners = new Set();
const personPurgedListeners = new Set();

/**
 * fn(db, { chatJid, chatForms, msgIds, cause: 'forget'|'revoke'|'edit'|'purge'|'owner', byType, episodes, msgTs? })
 * byType: the deleted ids by item type; episodes: [{ id, originJid, attribute }] for
 * the deleted category-'episode' memories (read before the delete); msgTs (revoke/edit):
 * the message's own timestamp, or null when unknown; (owner) the deleted memory's
 * created_at. cause 'owner' = the owner deleted one memory on the dashboard
 * (deleteMemory): chatJid = its origin chat (null for owner/self notes), msgIds = []
 * (no message is fenced). For purge,
 * chatJid = the person, chatForms = their identity forms and msgIds = [] (their lines
 * in every chat are fenced, not listed). Returns an unsubscribe function.
 */
export function onItemsDeleted(fn) {
  if (typeof fn !== 'function') throw new TypeError('onItemsDeleted: function required');
  itemsDeletedListeners.add(fn);
  return () => itemsDeletedListeners.delete(fn);
}

/** fn(db, person, forms), inside purgePerson's transaction; errors roll the purge back. */
export function onPersonPurged(fn) {
  if (typeof fn !== 'function') throw new TypeError('onPersonPurged: function required');
  personPurgedListeners.add(fn);
  return () => personPurgedListeners.delete(fn);
}

// Episode rows about to be deleted (the hook can't read them afterwards).
function episodeRows(db, memoryIds) {
  const out = [];
  for (let i = 0; i < (memoryIds?.length || 0); i += 400) {
    const chunk = memoryIds.slice(i, i + 400);
    out.push(...db.prepare(`SELECT id, origin_jid AS originJid, attribute FROM memories
      WHERE category = 'episode' AND id IN (${marks(chunk.length)})`).all(...chunk));
  }
  return out;
}

// Listeners are synchronous (they run inside the transaction). An async one can't roll
// anything back: under purge that is an error (fail closed); otherwise it is logged.
function runListener(fn, args, cause) {
  const r = fn(...args);
  if (r && typeof r.then === 'function') {
    r.then(null, (err) => logger.warn({ evt: 'issue', where: 'onItemsDeleted', cause, err: err?.message },
      'async deletion listener failed'));
    throw new TypeError('deletion listeners must be synchronous');
  }
}

function notifyItemsDeleted(db, info, { propagate = false } = {}) {
  for (const fn of [...itemsDeletedListeners]) {
    if (propagate) { runListener(fn, [db, info], info.cause); continue; }
    try {
      db.transaction(() => { runListener(fn, [db, info], info.cause); })();   // nested → SAVEPOINT: its writes roll back on error
    } catch (err) {
      logger.warn({ evt: 'issue', where: 'onItemsDeleted', cause: info.cause, err: err?.message },
        'deletion listener failed (ignored)');
    }
  }
}

// The canonical chat key of a stored chat id (group → bare JID, DM → person).
function chatKeyFor(chatJid) {
  const bare = bareJid(chatJid);
  if (!bare) return null;
  return bare.endsWith('@g.us') ? bare : (resolvePerson(bare) || bare);
}

// ── Memories ─────────────────────────────────────────────────────────────────

const SELECT_CURRENT_BY_FP = `SELECT id, learned_at, expires_at FROM memories WHERE fingerprint = ? AND superseded_by IS NULL`;
const INSERT_MEMORY = `INSERT INTO memories (category, subject_jid, group_jid, content, importance, expires_at,
    origin_kind, origin_jid, learned_at, attribute, fingerprint, source, visibility, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Store one memory with provenance. Dedupes by fingerprint (a re-observation merges:
 * evidence appended, learned_at = MAX(existing, MIN(new evidence ts))), refuses
 * tombstoned fingerprints ("forget that") and fenced / vanished evidence, and
 * supersedes the same-origin item for (subject, attribute) plus any explicit
 * same-origin `replaces`.
 *
 * @param {{ category: string, subjectJid?: string|null, originKind: string, originJid: string,
 *   content: string, importance?: number, attribute?: string|null, source?: string,
 *   evidence?: Array<{ msgId: string, ts: number }>, learnedAt?: number, expiresInDays?: number|null,
 *   visibility?: string, replaces?: number|number[], origins?: Array<{ originJid, minLearnedAt }> }} item
 * @returns {{ id: number|null, merged: boolean, superseded: number|null, refused?: string }}
 * Throws only on a missing/invalid origin or empty content (a caller bug).
 */
export function addMemory(item) {
  const m = (item && typeof item === 'object') ? item : {};
  const originKind = m.originKind;
  if (!ORIGIN_KINDS.has(originKind)) throw new TypeError('addMemory: originKind required');
  const originJid = canonicalOrigin(originKind, m.originJid);
  if (!originJid) throw new TypeError('addMemory: originJid required');
  const content = String(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTENT_MAX);
  if (!content) throw new TypeError('addMemory: content required');
  const category = String(m.category || 'fact').trim().slice(0, 32) || 'fact';
  const subjectJid = canonicalPerson(m.subjectJid);
  const attribute = m.attribute ? String(m.attribute).trim().toLowerCase().slice(0, 40) || null : null;
  const importance = Number.isFinite(Number(m.importance)) ? Math.max(0, Math.min(1, Number(m.importance))) : 0.5;
  const visibility = originKind === 'owner' ? (VISIBILITIES.has(m.visibility) ? m.visibility : 'subject_dm') : null;
  const source = m.source ? String(m.source).slice(0, 32) : null;
  const now = nowSec();
  const expiresAt = m.expiresInDays != null && Number.isFinite(Number(m.expiresInDays))
    ? now + Math.round(Number(m.expiresInDays) * 86400) : null;
  const fingerprint = memoryFingerprint({ originJid, subjectJid, content });
  const legacyGroup = (originKind === 'owner' || originKind === 'self') ? null : originJid;

  const db = getDb();
  return db.transaction(() => {
    // Forgotten here before: exact fingerprint, or the same text from the same origin
    // (the content key survives identity merges, which re-key origin_jid).
    if (db.prepare(`SELECT 1 FROM learning_exclusions WHERE fingerprint = ?
        OR (origin_jid = ? AND content_key = ?) LIMIT 1`).get(fingerprint, originJid, contentKey(content))) {
      return { id: null, merged: false, superseded: null, refused: 'tombstoned' };
    }
    const given = normEvidence(m.evidence);
    const { evidence, fenced } = liveEvidence(db, given);
    if (fenced) return { id: null, merged: false, superseded: null, refused: 'fenced' };
    if (given.length && !evidence.length) return { id: null, merged: false, superseded: null, refused: 'evidence_gone' };
    const newLearned = Number.isFinite(m.learnedAt) ? Math.floor(m.learnedAt) : minTs(evidence);

    const existing = db.prepare(SELECT_CURRENT_BY_FP).get(fingerprint);
    if (existing) {
      // Re-observation: visible to a later joiner only once a wholly later evidence
      // set re-derives it (R9). Unknown on either side stays unknown.
      const learned = existing.learned_at == null || newLearned == null ? null
        : Math.max(existing.learned_at, newLearned);
      // An expired copy (not yet cleaned) takes the new expiry, NULL for a lasting
      // claim — otherwise the restated claim stays expired and is never recalled.
      const lapsed = existing.expires_at != null && existing.expires_at <= now;
      db.prepare(`UPDATE memories SET learned_at = ?, importance = MAX(COALESCE(importance, 0), ?),
          expires_at = CASE WHEN ? THEN ? WHEN expires_at IS NULL OR ? IS NULL THEN expires_at ELSE MAX(expires_at, ?) END
        WHERE id = ?`).run(learned, importance, lapsed ? 1 : 0, expiresAt, expiresAt, expiresAt, existing.id);
      addEvidence('memory', existing.id, evidence);
      if (Array.isArray(m.origins)) addItemOrigins('memory', existing.id, m.origins);
      return { id: existing.id, merged: true, superseded: null };
    }

    const id = Number(db.prepare(INSERT_MEMORY).run(category, subjectJid, legacyGroup, content, importance, expiresAt,
      originKind, originJid, newLearned, attribute, fingerprint, source, visibility, now).lastInsertRowid);
    addEvidence('memory', id, evidence);
    if (Array.isArray(m.origins)) addItemOrigins('memory', id, m.origins);

    // Supersession: same origin only (a DM can't overwrite what a group knows).
    const victims = new Set();
    if (subjectJid && attribute && attribute !== 'other') {
      for (const r of db.prepare(`SELECT id FROM memories WHERE subject_jid = ? AND attribute = ? AND origin_jid = ?
          AND superseded_by IS NULL AND id != ?`).all(subjectJid, attribute, originJid, id)) victims.add(r.id);
    }
    const replaces = Array.isArray(m.replaces) ? m.replaces : m.replaces != null ? [m.replaces] : [];
    for (const rid of replaces.map(Number).filter(Number.isInteger)) {
      const r = db.prepare('SELECT id, origin_jid, subject_jid FROM memories WHERE id = ? AND superseded_by IS NULL').get(rid);
      if (r && r.id !== id && r.origin_jid === originJid && (r.subject_jid ?? null) === subjectJid) victims.add(r.id);
    }
    let superseded = null;
    for (const vid of victims) {
      db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?').run(id, now, vid);
      superseded ??= vid;
    }
    return { id, merged: false, superseded };
  })();
}

/**
 * The model said a new observation is the same claim as current item `id`, in other
 * words: append evidence and apply the re-observation rule (learned_at =
 * MAX(existing, MIN(new evidence ts))). Only for an item of the same origin and subject;
 * fenced or vanished evidence is refused. Returns { id, merged } or null.
 */
export function reobserveMemory(id, originJid, subjectJid, evidence) {
  const subject = canonicalPerson(subjectJid);
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT id, origin_jid, subject_jid, learned_at FROM memories WHERE id = ? AND superseded_by IS NULL`)
      .get(Number(id));
    if (!row || row.origin_jid !== originJid || (row.subject_jid ?? null) !== subject) return null;
    const given = normEvidence(evidence);
    const { evidence: ev, fenced } = liveEvidence(db, given);
    if (fenced || !ev.length) return null;
    const newMin = minTs(ev);
    const learned = row.learned_at == null || newMin == null ? null : Math.max(row.learned_at, newMin);
    db.prepare('UPDATE memories SET learned_at = ? WHERE id = ?').run(learned, row.id);
    addEvidence('memory', row.id, ev);
    return { id: row.id, merged: true };
  })();
}

/**
 * Tombstone check (exposed for the dashboard and tests): the exact fingerprint, or —
 * given { originJid, content } — the same text forgotten in that origin.
 */
export function isTombstoned(fingerprint, { originJid = null, content = null } = {}) {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM learning_exclusions WHERE fingerprint = ?').get(fingerprint)) return true;
  if (!originJid || content == null) return false;
  return !!db.prepare('SELECT 1 FROM learning_exclusions WHERE origin_jid = ? AND content_key = ? LIMIT 1')
    .get(originJid, contentKey(content));
}

// ── Relationships ────────────────────────────────────────────────────────────

// learned_at: new → the evidence's earliest ts. A batch that gives BOTH relationship
// and dynamic either re-observes the same claim (MAX(existing, new), R9) or replaces
// it wholly (the new evidence's time alone — the old evidence no longer backs any of
// it). A batch giving only one leaves older content the new evidence doesn't vouch
// for, so the row keeps the earlier time (MIN, fail closed). NULL stays NULL (never
// crosses chats). Column references in SET read the row before the update.
const UPSERT_REL = `INSERT INTO relationships (person_a_jid, person_b_jid, relationship, dynamic, strength,
    origin_kind, origin_jid, learned_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(person_a_jid, person_b_jid, origin_jid) DO UPDATE SET
    relationship = COALESCE(excluded.relationship, relationship),
    dynamic = COALESCE(excluded.dynamic, dynamic),
    strength = excluded.strength,
    learned_at = CASE WHEN learned_at IS NULL OR excluded.learned_at IS NULL THEN NULL
                      WHEN excluded.relationship IS NOT NULL AND excluded.dynamic IS NOT NULL
                        THEN CASE WHEN excluded.relationship IS relationship AND excluded.dynamic IS dynamic
                                  THEN MAX(learned_at, excluded.learned_at) ELSE excluded.learned_at END
                      ELSE MIN(learned_at, excluded.learned_at) END,
    updated_at = unixepoch()
  RETURNING id`;

/**
 * Upsert a relationship between two people as seen in one origin chat.
 * opts (additive to the contract): { learnedAt, evidence } — evidence also sets
 * learnedAt when it isn't given. Returns { id } or null (unknown / same person, or
 * evidence that is fenced by "forget that" or no longer exists).
 */
export function upsertRelationship(personAJid, personBJid, originKind, originJid, relationship, dynamic,
  strength = 0.5, { learnedAt = null, evidence = null } = {}) {
  if (!ORIGIN_KINDS.has(originKind)) throw new TypeError('upsertRelationship: originKind required');
  const origin = canonicalOrigin(originKind, originJid);
  if (!origin) throw new TypeError('upsertRelationship: originJid required');
  const pa = canonicalPerson(personAJid);
  const pb = canonicalPerson(personBJid);
  if (!pa || !pb || pa === pb) return null;
  // Always store with the lexically smaller JID first for consistency
  const [a, b] = pa < pb ? [pa, pb] : [pb, pa];
  const given = normEvidence(evidence);
  const s = Number.isFinite(Number(strength)) ? Math.max(0, Math.min(1, Number(strength))) : 0.5;
  const db = getDb();
  return db.transaction(() => {
    const { evidence: ev, fenced } = liveEvidence(db, given);
    if (fenced || (given.length && !ev.length)) return null;
    const learned = Number.isFinite(learnedAt) ? Math.floor(learnedAt) : minTs(ev);
    const row = db.prepare(UPSERT_REL).get(a, b, relationship ? String(relationship).slice(0, 120) : null,
      dynamic ? String(dynamic).slice(0, 300) : null, s, originKind, origin, learned);
    if (!row) return null;
    addEvidence('relationship', row.id, ev);
    return { id: row.id };
  })();
}

// ── Forgetting, revokes, edits, purge (R11, R15) ─────────────────────────────

/**
 * "forget that" in a DM: the requester's last few messages there (≤ maxMessages,
 * within withinSec) are flagged no_learn, every item learned from them is deleted,
 * and deleted memories' fingerprints are tombstoned so they can't be re-learned.
 * Audited with counts only. Messages are kept (they're the chat log), just fenced.
 * @returns {{ deleted: number, fenced: number }}
 */
export function forgetRecent(personJid, dmJid, { withinSec = 600, maxMessages = 5 } = {}) {
  const person = canonicalPerson(personJid) || canonicalPerson(dmJid);
  if (!person) return { deleted: 0, fenced: 0 };
  const forms = [...new Set([...identitiesOf(person), ...(dmJid && isPersonJid(dmJid) ? [bareJid(dmJid)] : [])])];
  const db = getDb();
  const since = nowSec() - Math.max(0, Number(withinSec) || 0);
  const limit = Math.max(1, Math.min(Number(maxMessages) || 5, 50));
  // DM rows may carry a device-suffixed chat/sender JID: match the bare form too.
  const inForms = (col) => `(${col} IN (${marks(forms.length)})
    OR (instr(${col}, ':') > 0 AND substr(${col}, 1, instr(${col}, ':') - 1) || substr(${col}, instr(${col}, '@'))
        IN (${marks(forms.length)})))`;
  return db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM messages
      WHERE ${inForms('group_jid')} AND ${inForms('sender_jid')} AND COALESCE(is_from_self, 0) = 0 AND timestamp >= ?
      ORDER BY timestamp DESC, rowid DESC LIMIT ?`).pluck().all(...forms, ...forms, ...forms, ...forms, since, limit);
    if (!ids.length) {
      audit(db, `person:${person}`, 'memory.forget', person, { fenced: 0, deleted: 0 });
      return { deleted: 0, fenced: 0 };
    }
    const fenced = db.prepare(`UPDATE messages SET no_learn = 1 WHERE id IN (${marks(ids.length)})`).run(...ids).changes;
    const byType = itemsEvidencedBy(db, ids);
    if (byType.memory?.length) {
      const fps = db.prepare(`SELECT fingerprint, origin_jid, content FROM memories WHERE id IN (${marks(byType.memory.length)})
        AND fingerprint IS NOT NULL`).all(...byType.memory);
      const tomb = db.prepare(`INSERT OR IGNORE INTO learning_exclusions (fingerprint, person_jid, origin_jid, content_key, created_at)
        VALUES (?, ?, ?, ?, unixepoch())`);
      for (const f of fps) tomb.run(f.fingerprint, person, f.origin_jid, contentKey(f.content));
    }
    const episodes = episodeRows(db, byType.memory);
    const deleted = deleteItems(db, byType);
    if (fenced) notifyItemsDeleted(db, { chatJid: person, chatForms: forms, msgIds: ids, cause: 'forget', byType, episodes });
    audit(db, `person:${person}`, 'memory.forget', person, { fenced, deleted });
    return { deleted, fenced };
  })();
}

/**
 * The owner deletes one memory (dashboard DELETE /api/memories/:id). Same machinery as
 * "forget that": a learned memory's fingerprint + origin content key are tombstoned in
 * learning_exclusions so a later batch can't relearn the same claim from that chat,
 * the row and its evidence/origin links go, and the onItemsDeleted listeners (cause
 * 'owner') run so derived state — a deleted episode's night, drafts or notes built
 * since it existed — reacts. Owner notes are deleted without a tombstone (they were
 * never learned; the owner may write the same note again). Listener failures are
 * caught (the delete stands). The caller audits.
 * @returns {{ deleted: number, tombstoned: boolean }}
 */
export function deleteMemory(memoryId) {
  const id = Number(memoryId);
  if (!Number.isInteger(id)) return { deleted: 0, tombstoned: false };
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT id, origin_kind, origin_jid, subject_jid, content, fingerprint, created_at
      FROM memories WHERE id = ?`).get(id);
    if (!row) return { deleted: 0, tombstoned: false };
    let tombstoned = false;
    if (row.origin_kind !== 'owner' && row.content != null) {
      const fp = row.fingerprint || memoryFingerprint({ originJid: row.origin_jid, subjectJid: row.subject_jid, content: row.content });
      tombstoned = db.prepare(`INSERT OR IGNORE INTO learning_exclusions (fingerprint, person_jid, origin_jid, content_key, created_at)
        VALUES (?, ?, ?, ?, unixepoch())`).run(fp, row.subject_jid || null, row.origin_jid, contentKey(row.content)).changes > 0
        || !!db.prepare('SELECT 1 FROM learning_exclusions WHERE fingerprint = ?').get(fp);
    }
    const byType = { memory: [id] };
    const episodes = episodeRows(db, byType.memory);
    const deleted = deleteItems(db, byType);
    const chatJid = ['owner', 'self'].includes(row.origin_kind) ? null : row.origin_jid;
    const chatForms = !chatJid ? [] : chatJid.endsWith('@g.us') || !isPersonJid(chatJid) ? [chatJid]
      : [...new Set([chatJid, ...identitiesOf(chatJid)])];
    if (deleted) {
      notifyItemsDeleted(db, { chatJid, chatForms, msgIds: [], cause: 'owner', byType, episodes,
        msgTs: Number.isFinite(row.created_at) ? row.created_at : null });
    }
    return { deleted, tombstoned };
  })();
}

// The stored chat forms a revoke/edit for `chatJid` may touch: the group itself, or
// every form of the DM person. null → no check (internal callers and tests).
function chatFormsOf(chatJid) {
  if (chatJid == null) return null;
  const bare = bareJid(chatJid);
  if (!bare) return [];
  if (!isPersonJid(bare)) return [...new Set([chatJid, bare])];
  const person = resolvePerson(bare);
  return [...new Set([chatJid, bare, ...(person ? identitiesOf(person) : [])])];
}

// Is message `msgId` stored in one of these chats? (A protocol message from one chat
// must not reach a row of another: ids are only unique per chat in practice.)
function inChat(db, msgId, forms) {
  if (forms == null) return true;
  if (!forms.length) return false;
  return !!db.prepare(`SELECT 1 FROM messages WHERE id = ? AND group_jid IN (${marks(forms.length)})`).get(msgId, ...forms);
}

// chatJid for the hook: the stored row's chat (the caller may pass null).
// msgTs: the message's own timestamp (read before the delete), so a listener can tell
// which of its rows could have seen the message (nothing made before it could).
function notifyRevokeOrEdit(db, cause, msgId, chatJid, forms, storedChats, byType, episodes, msgTs = null) {
  const key = chatKeyFor(storedChats[0] || chatJid);
  const chatForms = [...new Set([...(forms || []), ...storedChats, ...(key && !key.endsWith('@g.us') ? identitiesOf(key) : []),
    ...(key ? [key] : [])])];
  notifyItemsDeleted(db, { chatJid: key, chatForms, msgIds: [msgId], cause, byType, episodes,
    msgTs: Number.isFinite(Number(msgTs)) && msgTs !== null ? Math.floor(Number(msgTs)) : null });
}

const messageTs = (db, msgId) => db.prepare('SELECT MIN(timestamp) FROM messages WHERE id = ?').pluck().get(msgId);

/**
 * Delete-for-everyone: items learned from the message are dropped, then the row (FTS
 * via trigger); quoted copies of its text in later replies are cleared. `chatJid` (the
 * revoke's key.remoteJid) must match the stored row's chat, or nothing happens.
 */
export function onMessageRevoked(msgId, chatJid = null) {
  if (!msgId || typeof msgId !== 'string') return { deleted: 0, removed: 0 };
  const db = getDb();
  const forms = chatFormsOf(chatJid);
  return db.transaction(() => {
    if (!inChat(db, msgId, forms)) return { deleted: 0, removed: 0 };
    const stored = db.prepare('SELECT group_jid FROM messages WHERE id = ?').pluck().all(msgId);
    const msgTs = messageTs(db, msgId);
    const byType = itemsEvidencedBy(db, [msgId]);
    const episodes = episodeRows(db, byType.memory);
    const deleted = deleteItems(db, byType);
    const removed = db.prepare('DELETE FROM messages WHERE id = ?').run(msgId).changes;
    db.prepare('UPDATE messages SET quoted_content = NULL WHERE quoted_id = ?').run(msgId);
    if (removed) notifyRevokeOrEdit(db, 'revoke', msgId, chatJid, forms, stored, byType, episodes, msgTs);
    return { deleted, removed };
  })();
}

/**
 * An edited message: content replaced (FTS via trigger) and anything learned from
 * the old text dropped. The new text is learned only if the message is still inside
 * the next batch window (rowid after last_batch_rowid); an older edited message is
 * not re-analysed. Quoted copies in later replies get the new text. `chatJid` as for
 * onMessageRevoked.
 */
export function onMessageEdited(msgId, newContent, chatJid = null) {
  if (!msgId || typeof msgId !== 'string') return { deleted: 0, updated: 0 };
  const db = getDb();
  const forms = chatFormsOf(chatJid);
  return db.transaction(() => {
    if (!inChat(db, msgId, forms)) return { deleted: 0, updated: 0 };
    const updated = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(newContent ?? null, msgId).changes;
    if (!updated) return { deleted: 0, updated: 0 };
    db.prepare('UPDATE messages SET quoted_content = ? WHERE quoted_id = ? AND quoted_content IS NOT NULL')
      .run(newContent ?? null, msgId);
    const stored = db.prepare('SELECT group_jid FROM messages WHERE id = ?').pluck().all(msgId);
    const byType = itemsEvidencedBy(db, [msgId]);
    const episodes = episodeRows(db, byType.memory);
    const deleted = deleteItems(db, byType);
    notifyRevokeOrEdit(db, 'edit', msgId, chatJid, forms, stored, byType, episodes, messageTs(db, msgId));
    return { deleted, updated };
  })();
}

/**
 * Remove everything remembered about a person: memories about them or learned in
 * their DM / calls, their facets, nicknames (theirs; used_by cleared on others'),
 * relationships, evidence, style cards (built from their messages), call summaries
 * and transcripts, the text of relays they asked for, imitation targets on them and
 * identity forms. Their people row goes too unless they're still in a group (rows
 * there need it). Unconditional — the R11 gate (left every group, no shared group,
 * 30 days of DM silence, fresh membership, not at startup) is the caller's
 * (maintenance). Audited once, as `actor`. Forget tombstones are kept. A cloned
 * voice is revoked here (never used again) and marked for its delete at Google,
 * which needs the network: the caller runs voiceClone.retryPendingVoiceDeletes()
 * after the commit, and the 6-hourly maintenance retries until Google confirms
 * (then the row goes). `voicePending` = how many voices await that delete.
 * @returns {{ deleted: number, voicePending: number }}
 */
export function purgePerson(personJid, reason = 'retention', actor = 'system:retention') {
  const person = canonicalPerson(personJid);
  if (!person) return { deleted: 0, voicePending: 0 };
  const forms = identitiesOf(person);
  const m = marks(forms.length);
  const db = getDb();
  const result = db.transaction(() => {
    const ids = (sql, ...p) => db.prepare(sql).pluck().all(...p);
    const inDm = `(origin_kind IN ('dm', 'call') AND origin_jid IN (${m}))`;
    const byType = {
      memory: ids(`SELECT id FROM memories WHERE subject_jid IN (${m}) OR ${inDm}`, ...forms, ...forms),
      facet: ids(`SELECT rowid FROM person_facets WHERE person_jid IN (${m}) OR ${inDm}`, ...forms, ...forms),
      nickname: ids(`SELECT id FROM nicknames WHERE person_jid IN (${m}) OR ${inDm}`, ...forms, ...forms),
      relationship: ids(`SELECT id FROM relationships WHERE person_a_jid IN (${m}) OR person_b_jid IN (${m}) OR ${inDm}`,
        ...forms, ...forms, ...forms),
      slang: ids(`SELECT id FROM slang WHERE ${inDm}`, ...forms),
    };
    let deleted = deleteItems(db, byType);
    db.prepare(`UPDATE nicknames SET used_by = NULL WHERE used_by IN (${m})`).run(...forms);
    deleted += db.prepare(`DELETE FROM person_style_card WHERE person_jid IN (${m})`).run(...forms).changes;
    deleted += db.prepare(`DELETE FROM call_transcript WHERE call_id IN (SELECT id FROM calls WHERE person_jid IN (${m}))`)
      .run(...forms).changes;
    db.prepare(`UPDATE calls SET summary = NULL WHERE person_jid IN (${m})`).run(...forms);
    db.prepare(`UPDATE relays SET content = NULL WHERE requester_jid IN (${m})`).run(...forms);
    db.prepare(`DELETE FROM group_imitation WHERE target_jid IN (${m})`).run(...forms);
    // A cloned voice is revoked now and deleted at Google after the commit (the
    // caller runs voiceClone.retryPendingVoiceDeletes; maintenance retries).
    const voicePending = revokeVoicesForPurge(db, forms);
    deleted += db.prepare(`DELETE FROM person_identities WHERE person_jid = ? OR jid IN (${m})`).run(person, ...forms).changes;
    db.prepare(`DELETE FROM learning_state WHERE chat_jid IN (${m})`).run(...forms);
    if (!db.prepare(`SELECT 1 FROM group_members WHERE person_jid IN (${m}) LIMIT 1`).get(...forms)) {
      db.prepare(`DELETE FROM people WHERE jid IN (${m})`).run(...forms);
    }
    // Mind traces go first: a mind hook that throws rolls the purge back before
    // life rebuilds its in-memory projection from the redacted events below.
    deleted += purgeMindTraces(db, person, forms, byType);   // spec 008 R9 (hooks propagate errors)
    // Life (spec 009 §R13): redact the world events about them (every identity
    // form) and drop their life_queue / life_claims rows; the facade also rebuilds
    // the live projection. Inside this transaction, so a failure rolls the whole
    // purge back instead of leaving their world events standing.
    const personForms = forms.filter(isPersonJid);
    const life = personForms.length ? lifeRedactPerson(personForms) : { events: 0, queue: 0, claims: 0 };
    deleted += (life.queue || 0) + (life.claims || 0);
    audit(db, String(actor || 'system:retention').slice(0, 120), 'memory.purge', person,
      { deleted, lifeRedacted: life.events || 0, voicePending, reason: String(reason || '').slice(0, 80) });
    return { deleted, voicePending };
  })();
  invalidateIdentityCache();   // their identity rows are gone: no stale resolvePerson hit
  return result;
}

// spec 008 R9, inside purgePerson's transaction. Fences the person's own lines in every
// chat and every line of their DM (no_learn: no reader learns from them again, the 006
// transcript included), deletes their DM's mind digests and every episode / digest
// their messages are evidence for (a group episode has subject NULL and would
// otherwise survive), then runs the onItemsDeleted ('purge') and onPersonPurged
// listeners. Nothing here is caught: an error rolls the purge back.
function purgeMindTraces(db, person, forms, byType006) {
  const inForms = (col) => `(${col} IN (${marks(forms.length)})
    OR (instr(${col}, ':') > 0 AND substr(${col}, 1, instr(${col}, ':') - 1) || substr(${col}, instr(${col}, '@'))
        IN (${marks(forms.length)})))`;
  db.prepare(`UPDATE messages SET no_learn = 1 WHERE COALESCE(no_learn, 0) = 0 AND (${inForms('sender_jid')} OR ${inForms('group_jid')})`)
    .run(...forms, ...forms, ...forms, ...forms);

  const evidenced = db.prepare(`SELECT DISTINCT e.item_type, e.item_id FROM item_evidence e JOIN messages msg ON msg.id = e.msg_id
    WHERE e.item_type IN ('memory', 'mind_digest') AND ${inForms('msg.sender_jid')}`).all(...forms, ...forms);
  const hasDigests = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mind_digests'`).get();
  const digestIds = new Set(hasDigests
    ? db.prepare(`SELECT id FROM mind_digests WHERE chat_jid IN (${marks(forms.length)})`).pluck().all(...forms) : []);
  const evMemIds = [];
  for (const r of evidenced) (r.item_type === 'mind_digest' ? digestIds.add(r.item_id) : evMemIds.push(r.item_id));
  const episodes = episodeRows(db, evMemIds);
  const extra = { memory: episodes.map(e => e.id), mind_digest: hasDigests ? [...digestIds] : [] };
  const deleted = deleteItems(db, extra);

  const byType = {};
  for (const src of [byType006, extra]) {
    for (const [k, v] of Object.entries(src)) if (v?.length) byType[k] = [...new Set([...(byType[k] || []), ...v])];
  }
  notifyItemsDeleted(db, { chatJid: person, chatForms: forms, msgIds: [], cause: 'purge', byType, episodes },
    { propagate: true });
  for (const fn of [...personPurgedListeners]) runListener(fn, [db, person, forms], 'purge');
  return deleted;
}

/**
 * Clear superseded_by on these memories when their superseder no longer exists (a
 * deleted weekly episode leaves its dailies pointing at a dead row, invisible to
 * recall). A row is skipped when another current row has its fingerprint (the
 * current-fingerprint index is unique). Returns how many were cleared.
 */
export function unsupersede(memoryIds) {
  const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : [memoryIds]).map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;
  const db = getDb();
  const stmt = db.prepare(`UPDATE memories SET superseded_by = NULL, superseded_at = NULL
    WHERE id = ? AND superseded_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM memories s WHERE s.id = memories.superseded_by)
      AND (fingerprint IS NULL OR NOT EXISTS (SELECT 1 FROM memories c WHERE c.fingerprint = memories.fingerprint
                                              AND c.superseded_by IS NULL AND c.id != memories.id))`);
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

// ── Maintenance ──────────────────────────────────────────────────────────────

function deleteMemoriesWhere(whereSql, ...params) {
  const db = getDb();
  return db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM memories WHERE ${whereSql}`).pluck().all(...params);
    return ids.length ? deleteItems(db, { memory: ids }) : 0;
  })();
}

export function cleanExpiredMemories() {
  return deleteMemoriesWhere('expires_at IS NOT NULL AND expires_at < unixepoch()');
}

// Decay spares anything ever recalled (FR-018) and owner notes; superseded rows are
// pruned separately. Returns { changes } like the v0 statement result.
export function decayMemories(maxAgeSec = 30 * 24 * 3600) {
  const changes = deleteMemoriesWhere(`importance < 0.3 AND COALESCE(recall_count, 0) = 0
    AND last_recalled_at IS NULL AND COALESCE(origin_kind, '') != 'owner'
    AND superseded_by IS NULL AND COALESCE(learned_at, created_at) < unixepoch() - ?`, maxAgeSec);
  return { changes };
}

/** Superseded items are history; drop them after maxAgeSec (default 180 days). */
export function pruneSuperseded(maxAgeSec = 180 * 24 * 3600) {
  return deleteMemoriesWhere('superseded_by IS NOT NULL AND COALESCE(superseded_at, created_at) < unixepoch() - ?', maxAgeSec);
}

// ── Dashboard-only reads (unscoped: operator view) ───────────────────────────

const MEM_DASH_COLS = `m.id, m.category, m.subject_jid, m.group_jid, m.content, m.importance, m.recall_count,
  m.created_at, m.expires_at, m.origin_kind, m.origin_jid, m.learned_at, m.attribute, m.source,
  m.superseded_by, m.superseded_at, m.last_recalled_at, m.visibility`;

/** Every current memory about a person (all origins). Dashboard only. */
export function getAllMemoriesForPerson(personJid, limit = 50) {
  const forms = identitiesOf(canonicalPerson(personJid) || personJid);
  if (!forms.length) return [];
  return getDb().prepare(`SELECT ${MEM_DASH_COLS} FROM memories m
    WHERE m.subject_jid IN (${marks(forms.length)}) AND m.superseded_by IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
    ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`).all(...forms, limit);
}

/** Every current memory learned in a chat. Dashboard only. */
export function getAllMemoriesForGroup(groupJid, limit = 20) {
  return getDb().prepare(`SELECT ${MEM_DASH_COLS} FROM memories m
    WHERE (m.origin_jid = ? OR (m.origin_jid IS NULL AND m.group_jid = ?)) AND m.superseded_by IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
    ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`).all(groupJid, groupJid, limit);
}

const REL_DASH = `SELECT r.*, pa.push_name AS person_a_name, pb.push_name AS person_b_name
  FROM relationships r
  JOIN people pa ON pa.jid = r.person_a_jid
  JOIN people pb ON pb.jid = r.person_b_jid`;

/** A person's relationships in every origin. Dashboard only. */
export function getAllRelationshipsForPerson(personJid) {
  const p = canonicalPerson(personJid) || personJid;
  return getDb().prepare(`${REL_DASH} WHERE r.person_a_jid = ? OR r.person_b_jid = ? ORDER BY r.strength DESC`).all(p, p);
}

/** Relationships learned in one chat. Dashboard only. */
export function getAllGroupRelationships(groupJid) {
  return getDb().prepare(`${REL_DASH} WHERE r.origin_jid = ? ORDER BY r.strength DESC`).all(groupJid);
}
