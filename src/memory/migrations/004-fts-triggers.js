// v4 — keep messages_fts consistent on edits and deletions (FR-025).
// messages_fts is an external-content FTS5 table: removing a row must use the
// 'delete' command with the OLD values. The v0 update trigger ran a plain
// DELETE (which re-reads the already-updated content) and there was no delete
// trigger at all. FTS5 also expects every content row to be indexed — a NULL
// content row is indexed as empty (no tokens) — so the v0 "skip NULL" guards
// left the index failing integrity-check. All three triggers are recreated
// under their v0 names (schema.sql's CREATE TRIGGER IF NOT EXISTS stays a no-op
// on boot) and a 'rebuild' re-derives the index from messages once.

export default {
  version: 4,
  name: 'fts-triggers',
  up(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS msg_fts_insert;
      CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages
      BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      DROP TRIGGER IF EXISTS msg_fts_update;
      CREATE TRIGGER msg_fts_update AFTER UPDATE OF content ON messages
      BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
          INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      DROP TRIGGER IF EXISTS msg_fts_delete;
      CREATE TRIGGER msg_fts_delete AFTER DELETE ON messages
      BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;

      INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
    `);
  },
};
