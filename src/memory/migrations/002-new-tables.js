// v2 — new tables for identity, facets, evidence, membership log, learning
// cadence, relays and the Instagram sync marker (spec 006 data-model).

export default {
  version: 2,
  name: 'new-tables',
  up(db) {
    db.exec(`
      -- Every JID form (LID, PN, device-less) → canonical people.jid.
      CREATE TABLE IF NOT EXISTS person_identities (
          jid         TEXT PRIMARY KEY,
          person_jid  TEXT NOT NULL,
          kind        TEXT,                    -- 'lid' | 'pn'
          source      TEXT,                    -- 'sync' | 'message' | 'phone' | 'lidmap' | 'merge' | 'backfill'
          seen_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_identities_person ON person_identities(person_jid);

      -- Per-origin profile (summary/traits/interests) of a person; merged at read time.
      CREATE TABLE IF NOT EXISTS person_facets (
          person_jid      TEXT NOT NULL,
          origin_kind     TEXT NOT NULL,
          origin_jid      TEXT NOT NULL,
          summary         TEXT,
          traits_json     TEXT DEFAULT '[]',
          interests_json  TEXT DEFAULT '[]',
          visibility      TEXT,                -- owner facets: 'subject_dm' | 'subject_groups' | 'everywhere'
          learned_at      INTEGER,
          updated_at      INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (person_jid, origin_jid)
      );

      -- Which messages an item was learned from (drives learned_at, forget, revoke).
      CREATE TABLE IF NOT EXISTS item_evidence (
          item_type   TEXT NOT NULL,           -- 'memory' | 'facet' | 'nickname' | 'relationship' | 'slang' | …
          item_id     INTEGER NOT NULL,
          msg_id      TEXT NOT NULL,
          ts          INTEGER,
          PRIMARY KEY (item_type, item_id, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_item_evidence_msg ON item_evidence(msg_id);

      -- Every contributing origin of a derived item (R14); all must pass the audience rule.
      CREATE TABLE IF NOT EXISTS item_origins (
          item_type       TEXT NOT NULL,
          item_id         INTEGER NOT NULL,
          origin_jid      TEXT NOT NULL,
          min_learned_at  INTEGER,
          PRIMARY KEY (item_type, item_id, origin_jid)
      );

      -- "forget that" tombstones: addMemory refuses these fingerprints.
      CREATE TABLE IF NOT EXISTS learning_exclusions (
          fingerprint TEXT PRIMARY KEY,
          person_jid  TEXT,
          origin_jid  TEXT,
          created_at  INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS group_membership_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          group_jid   TEXT NOT NULL,
          person_jid  TEXT NOT NULL,
          action      TEXT NOT NULL CHECK (action IN ('join', 'leave')),
          at          INTEGER NOT NULL,
          source      TEXT                     -- 'event' | 'sync' | 'message' | 'backfill'
      );
      CREATE INDEX IF NOT EXISTS idx_membership_log ON group_membership_log(group_jid, person_jid, at);
      CREATE INDEX IF NOT EXISTS idx_membership_log_person ON group_membership_log(person_jid, at);

      -- Batch-learning cadence per chat (counter at ingest, last analysed rowid).
      CREATE TABLE IF NOT EXISTS learning_state (
          chat_jid          TEXT PRIMARY KEY,
          msgs_since_batch  INTEGER DEFAULT 0,
          last_batch_rowid  INTEGER DEFAULT 0,
          last_batch_at     INTEGER
      );

      -- Explicit DM → group relays (R10). state: pending|confirmed|sent|declined|expired|failed.
      CREATE TABLE IF NOT EXISTS relays (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          requester_jid  TEXT NOT NULL,
          source_dm_jid  TEXT NOT NULL,
          target_jid     TEXT,
          content        TEXT,
          source_msg_id  TEXT,
          state          TEXT NOT NULL DEFAULT 'pending',
          created_at     INTEGER DEFAULT (unixepoch()),
          confirmed_at   INTEGER,
          sent_at        INTEGER,
          error          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_relays_state ON relays(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_relays_requester ON relays(requester_jid, created_at DESC);

      CREATE TABLE IF NOT EXISTS ig_sync_state (
          id                 INTEGER PRIMARY KEY CHECK (id = 1),
          members_synced_at  INTEGER
      );
      INSERT OR IGNORE INTO ig_sync_state (id, members_synced_at) VALUES (1, NULL);

      -- Identity merges that need the owner's confirmation (both rows hold DM-origin items).
      CREATE TABLE IF NOT EXISTS identity_merge_queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          keep_jid    TEXT NOT NULL,
          drop_jid    TEXT NOT NULL,
          reason      TEXT,
          created_at  INTEGER DEFAULT (unixepoch()),
          decided_at  INTEGER,
          decision    TEXT                     -- NULL (pending) | 'approved' | 'rejected'
      );
      CREATE INDEX IF NOT EXISTS idx_merge_queue_pending ON identity_merge_queue(decided_at, created_at);
    `);
  },
};
