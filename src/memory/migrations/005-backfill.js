// v5 — backfill provenance for existing rows (spec 006 data-model v5, R4, R12).
// Self-contained on purpose: the runtime identity/recall modules evolve, a ladder
// step must not. "resolvePerson" here is the seeded person_identities table
// (device suffix stripped), falling back to the raw JID.
//
// Order matters (R12): identities first; memories in call → group → dm → owner
// order; fingerprints and duplicate supersession BEFORE the partial unique index.

import { logger } from '../../utils/logger.js';
import { memoryFingerprint } from './fingerprint.js';
import { bareJid } from './util.js';

// The regex heuristics that wrote v0 memories (learningPipeline.extractFacts).
const HEURISTIC_RE = /^.{1,80}?( is a | is from |'s birthday: | bought\/got | is getting married| got a new job| is sick\/unwell| is feeling stressed\/low| is on leave| is traveling to | has exams\/deadline| is watching | is reading | started )/;

export default {
  version: 5,
  name: 'backfill',
  up(db) {
    const now = Math.floor(Date.now() / 1000);
    const counts = {};

    // 1. Identities: one row per person (kind from the suffix). PN is never derived
    //    from people.phone for @lid rows (it holds LID digits there). Group JIDs that
    //    leaked into people are not persons.
    counts.identities = db.prepare(`
      INSERT OR IGNORE INTO person_identities (jid, person_jid, kind, source, seen_at)
      SELECT jid, jid,
             CASE WHEN jid LIKE '%@lid' THEN 'lid' WHEN jid LIKE '%@s.whatsapp.net' THEN 'pn' ELSE NULL END,
             'backfill', COALESCE(last_seen, first_seen, ${now})
      FROM people WHERE jid NOT LIKE '%@g.us'
    `).run().changes;

    const identityOf = db.prepare('SELECT person_jid FROM person_identities WHERE jid = ?').pluck();
    const resolve = (jid) => {
      if (!jid) return null;
      const bare = bareJid(jid);
      return identityOf.get(bare) || identityOf.get(jid) || bare;
    };

    // 2. Memory origins.
    const mems = db.prepare(`SELECT id, category, subject_jid, group_jid, content, created_at
                             FROM memories WHERE origin_jid IS NULL ORDER BY id`).all();
    const setOrigin = db.prepare(`UPDATE memories SET origin_kind = ?, origin_jid = ?, learned_at = ?, source = ?,
                                  visibility = ? WHERE id = ?`);
    const callsFor = db.prepare(`SELECT id, summary, COALESCE(answered_at, started_at) AS ts FROM calls
                                 WHERE person_jid = ? AND summary IS NOT NULL`);
    const addEvidence = db.prepare(`INSERT OR IGNORE INTO item_evidence (item_type, item_id, msg_id, ts)
                                    VALUES ('memory', ?, ?, ?)`);
    const byKind = { call: 0, group: 0, dm: 0, owner: 0, ig: 0 };
    for (const m of mems) {
      const learnedAt = m.created_at ?? now;
      let kind, origin, source, visibility = null;
      if (/^Phone call/.test(m.content || '')) {
        // Call summaries are private to the caller's DM (R2), even "about" a group.
        const caller = resolve(m.subject_jid) || (m.group_jid && !m.group_jid.endsWith('@g.us') ? resolve(m.group_jid) : null);
        if (caller) { kind = 'call'; origin = caller; source = 'call'; }
        else { kind = 'owner'; origin = 'owner'; source = 'call'; visibility = 'subject_dm'; }
        // Tie it to its call record (FR-023): the memory text ends with calls.summary.
        if (caller && m.subject_jid) {
          for (const c of callsFor.all(m.subject_jid)) {
            if (c.summary && m.content.endsWith(c.summary)) { addEvidence.run(m.id, `call:${c.id}`, c.ts ?? learnedAt); break; }
          }
        }
      } else if (m.group_jid && m.group_jid.endsWith('@g.us')) {
        kind = 'group'; origin = m.group_jid; source = HEURISTIC_RE.test(m.content || '') ? 'heuristic' : 'legacy';
      } else if (m.group_jid && m.group_jid.startsWith('ig:')) {
        kind = 'ig'; origin = m.group_jid; source = 'legacy';
      } else if (m.group_jid) {
        kind = 'dm'; origin = resolve(m.group_jid); source = HEURISTIC_RE.test(m.content || '') ? 'heuristic' : 'legacy';
      } else {
        // No chat recorded: written from the dashboard. Owner note, subject's DM only (R8).
        kind = 'owner'; origin = 'owner'; source = 'dashboard'; visibility = 'subject_dm';
      }
      setOrigin.run(kind, origin, learnedAt, source, visibility, m.id);
      byKind[kind]++;
    }
    counts.memories = byKind;

    // 3. Fingerprints → supersede duplicates (older → newest) → partial unique index.
    const all = db.prepare(`SELECT id, subject_jid, origin_jid, content FROM memories
                            WHERE fingerprint IS NULL`).all();
    const setFp = db.prepare('UPDATE memories SET fingerprint = ? WHERE id = ?');
    for (const m of all) {
      setFp.run(memoryFingerprint({ originJid: m.origin_jid, subjectJid: m.subject_jid, content: m.content }), m.id);
    }
    counts.superseded = db.prepare(`
      UPDATE memories AS old SET superseded_by = (
          SELECT MAX(n.id) FROM memories n
          WHERE n.fingerprint = old.fingerprint AND n.superseded_by IS NULL),
        superseded_at = ${now}
      WHERE old.superseded_by IS NULL AND old.fingerprint IS NOT NULL
        AND old.id < (SELECT MAX(n.id) FROM memories n
                      WHERE n.fingerprint = old.fingerprint AND n.superseded_by IS NULL)
    `).run().changes;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_fingerprint_current
             ON memories(fingerprint) WHERE superseded_by IS NULL`);

    // 4. people.summary / traits / interests → owner facets (subject's DM only), then drop.
    counts.facets = db.prepare(`
      INSERT OR IGNORE INTO person_facets (person_jid, origin_kind, origin_jid, summary, traits_json, interests_json,
                                           visibility, learned_at, updated_at)
      SELECT jid, 'owner', 'owner', NULLIF(TRIM(summary), ''),
             COALESCE(NULLIF(traits_json, ''), '[]'), COALESCE(NULLIF(interests_json, ''), '[]'),
             'subject_dm', COALESCE(updated_at, first_seen, ${now}), COALESCE(updated_at, ${now})
      FROM people
      WHERE jid NOT LIKE '%@g.us'
        AND ((summary IS NOT NULL AND TRIM(summary) != '')
             OR COALESCE(traits_json, '[]') NOT IN ('', '[]')
             OR COALESCE(interests_json, '[]') NOT IN ('', '[]'))
    `).run().changes;
    db.exec(`
      ALTER TABLE people DROP COLUMN summary;
      ALTER TABLE people DROP COLUMN traits_json;
      ALTER TABLE people DROP COLUMN interests_json;
    `);

    // 5. Membership: the group's own JID (and any other group JID) is not a member.
    //    Existing members are back-dated to the group's first observation (R4), with a
    //    'backfill' join in the log.
    counts.memberRowsRemoved = db.prepare(
      `DELETE FROM group_members WHERE person_jid = group_jid OR person_jid LIKE '%@g.us'`,
    ).run().changes;
    db.exec(`
      UPDATE group_members SET joined_at = COALESCE((
        SELECT MIN(v) FROM (
          SELECT g.joined_at AS v FROM groups g WHERE g.jid = group_members.group_jid AND g.joined_at IS NOT NULL
          UNION ALL
          SELECT MIN(m.timestamp) FROM messages m WHERE m.group_jid = group_members.group_jid
          UNION ALL
          SELECT group_members.joined_at WHERE group_members.joined_at IS NOT NULL
        ) WHERE v IS NOT NULL
      ), ${now})
    `);
    counts.joinLog = db.prepare(`
      INSERT INTO group_membership_log (group_jid, person_jid, action, at, source)
      SELECT group_jid, person_jid, 'join', COALESCE(joined_at, ${now}), 'backfill' FROM group_members
    `).run().changes;

    // 6. Stored LLM voice descriptors may quote other chats; rebuilt from the same group (R13).
    counts.descriptorsCleared = db.prepare(
      'UPDATE person_style_card SET voice_descriptor = NULL WHERE voice_descriptor IS NOT NULL',
    ).run().changes;

    // 7. Learning cadence starts at "now" so history is not re-analysed at once.
    //    Keyed by the canonical chat id (device suffix stripped, DM → person).
    const lastRowid = new Map();
    for (const r of db.prepare('SELECT group_jid, MAX(rowid) AS max_rowid FROM messages GROUP BY group_jid').all()) {
      const chat = r.group_jid.endsWith('@g.us') ? bareJid(r.group_jid) : resolve(r.group_jid);
      lastRowid.set(chat, Math.max(lastRowid.get(chat) || 0, r.max_rowid));
    }
    const seed = db.prepare(`INSERT OR IGNORE INTO learning_state (chat_jid, msgs_since_batch, last_batch_rowid, last_batch_at)
                             VALUES (?, 0, ?, ${now})`);
    counts.learningState = 0;
    for (const [chat, rowid] of lastRowid) counts.learningState += seed.run(chat, rowid).changes;

    logger.info({ counts }, 'Migration v5: backfill');
  },
};
