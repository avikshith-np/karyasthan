// v3 — rebuild nicknames / relationships / slang with a NOT NULL scope
// (origin_kind + origin_jid) and uniqueness on it (spec 006 data-model, R7).
// SQLite can't drop the FK to groups or tighten NULL via ALTER, so each table is
// recreated and copied. Runs with foreign_keys OFF (set by the runner before
// BEGIN) and a foreign_key_check before COMMIT.
//
// Duplicate rows (the old UNIQUE let NULL scopes repeat) merge per new key:
// counts summed, confidence/strength maxed, first_seen min, last_used max, text
// columns from the most recent / most used row, id = MIN(id) so dashboard links
// keep working. NULL scope → 'owner' for nicknames/relationships; slang rows
// with no scope are dropped (only their count and ids are logged).

import { logger } from '../../utils/logger.js';

const KIND = `CASE WHEN group_jid IS NULL THEN 'owner'
                   WHEN group_jid LIKE '%@g.us' THEN 'group'
                   WHEN group_jid LIKE 'ig:%' THEN 'ig'
                   ELSE 'dm' END`;
const OJID = `COALESCE(group_jid, 'owner')`;

export default {
  version: 3,
  name: 'rebuild-scoped',
  rebuild: ['nicknames', 'relationships', 'slang'],
  up(db) {
    // ── nicknames ──────────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE nicknames_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          person_jid      TEXT NOT NULL REFERENCES people(jid),
          nickname        TEXT NOT NULL,
          origin_kind     TEXT NOT NULL,
          origin_jid      TEXT NOT NULL,
          used_by         TEXT,
          confidence      REAL DEFAULT 0.5,
          source          TEXT,
          use_count       INTEGER DEFAULT 1,
          first_seen      INTEGER DEFAULT (unixepoch()),
          last_used       INTEGER,
          learned_at      INTEGER,
          UNIQUE(person_jid, nickname, origin_jid)
      );
      INSERT INTO nicknames_new (id, person_jid, nickname, origin_kind, origin_jid, used_by, confidence,
                                 source, use_count, first_seen, last_used, learned_at)
      SELECT min_id, person_jid, nickname, kind, ojid, used_by, max_conf, source, sum_count, min_first, max_last, min_first
      FROM (
        SELECT n.*, ${KIND} AS kind, ${OJID} AS ojid,
               ROW_NUMBER() OVER w_recent AS rn,
               MIN(id) OVER w AS min_id,
               MAX(confidence) OVER w AS max_conf,
               SUM(COALESCE(use_count, 1)) OVER w AS sum_count,
               MIN(first_seen) OVER w AS min_first,
               MAX(last_used) OVER w AS max_last
        FROM nicknames n
        WINDOW w AS (PARTITION BY person_jid, nickname, ${OJID}),
               w_recent AS (PARTITION BY person_jid, nickname, ${OJID}
                            ORDER BY COALESCE(last_used, first_seen) DESC, id DESC)
      ) WHERE rn = 1;
      DROP TABLE nicknames;
      ALTER TABLE nicknames_new RENAME TO nicknames;
      CREATE INDEX IF NOT EXISTS idx_nick_origin ON nicknames(origin_jid);
    `);

    // ── relationships ──────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE relationships_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          person_a_jid    TEXT NOT NULL REFERENCES people(jid),
          person_b_jid    TEXT NOT NULL REFERENCES people(jid),
          relationship    TEXT,
          dynamic         TEXT,
          strength        REAL DEFAULT 0.5,
          origin_kind     TEXT NOT NULL,
          origin_jid      TEXT NOT NULL,
          learned_at      INTEGER,
          updated_at      INTEGER DEFAULT (unixepoch()),
          UNIQUE(person_a_jid, person_b_jid, origin_jid)
      );
      INSERT INTO relationships_new (id, person_a_jid, person_b_jid, relationship, dynamic, strength,
                                     origin_kind, origin_jid, learned_at, updated_at)
      SELECT min_id, person_a_jid, person_b_jid, relationship, dynamic, max_strength, kind, ojid, min_upd, max_upd
      FROM (
        SELECT r.*, ${KIND} AS kind, ${OJID} AS ojid,
               ROW_NUMBER() OVER w_recent AS rn,
               MIN(id) OVER w AS min_id,
               MAX(strength) OVER w AS max_strength,
               MIN(updated_at) OVER w AS min_upd,
               MAX(updated_at) OVER w AS max_upd
        FROM relationships r
        WINDOW w AS (PARTITION BY person_a_jid, person_b_jid, ${OJID}),
               w_recent AS (PARTITION BY person_a_jid, person_b_jid, ${OJID} ORDER BY updated_at DESC, id DESC)
      ) WHERE rn = 1;
      DROP TABLE relationships;
      ALTER TABLE relationships_new RENAME TO relationships;
      CREATE INDEX IF NOT EXISTS idx_rel_b ON relationships(person_b_jid);
      CREATE INDEX IF NOT EXISTS idx_rel_origin ON relationships(origin_jid);
    `);

    // ── slang ──────────────────────────────────────────────────────────────
    const unscoped = db.prepare('SELECT id FROM slang WHERE group_jid IS NULL ORDER BY id').all().map(r => r.id);
    db.exec(`
      CREATE TABLE slang_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          term            TEXT NOT NULL,
          meaning         TEXT,
          origin_kind     TEXT NOT NULL,
          origin_jid      TEXT NOT NULL,
          example         TEXT,
          use_count       INTEGER DEFAULT 1,
          first_seen      INTEGER DEFAULT (unixepoch()),
          is_global       INTEGER DEFAULT 0,
          UNIQUE(term, origin_jid)
      );
      INSERT INTO slang_new (id, term, meaning, origin_kind, origin_jid, example, use_count, first_seen, is_global)
      SELECT min_id, term, meaning, kind, group_jid, example, sum_count, min_first, 0
      FROM (
        SELECT s.*, ${KIND} AS kind,
               ROW_NUMBER() OVER w_best AS rn,
               MIN(id) OVER w AS min_id,
               SUM(COALESCE(use_count, 1)) OVER w AS sum_count,
               MIN(first_seen) OVER w AS min_first
        FROM slang s
        WHERE group_jid IS NOT NULL
        WINDOW w AS (PARTITION BY term, group_jid),
               w_best AS (PARTITION BY term, group_jid
                          ORDER BY (meaning IS NOT NULL AND meaning != '') DESC, use_count DESC, id DESC)
      ) WHERE rn = 1;
      DROP TABLE slang;
      ALTER TABLE slang_new RENAME TO slang;
      CREATE INDEX IF NOT EXISTS idx_slang_origin ON slang(origin_jid);
    `);
    if (unscoped.length) {
      logger.warn({ count: unscoped.length, ids: unscoped.slice(0, 50) }, 'Migration v3: dropped slang rows with no scope');
    }
  },
};
