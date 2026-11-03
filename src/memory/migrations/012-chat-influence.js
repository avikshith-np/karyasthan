// Chats shape his life (spec 012, plan §1.3 "v12 table") — the influence layer's
// own bookkeeping. world_events is NOT touched: the new event types are
// code-validated (eventLog.js), and the log stays append-only.
//
//   chat_influence_items                one row per perceived message that influenced him
//                                       (or is held until he reads it): the evidence pointer
//                                       (chat + message id), never the message text
//   chat_influence_pending_withdrawals  a deletion hook that failed, persisted so a restart
//                                       can't lose it (applied later, then deleted)
//   chat_influence_state                singleton key/value bookkeeping ('degraded')
//
// Nothing here stores raw chat text: content_hash is a sha256 for edit detection
// (not reversible), `held` holds the codes of a perception (kind/affect/intensity),
// and the owner's excerpt view reads the live message row.
//
// v12 on spec 006's PRAGMA user_version ladder (registered in ./index.js after the
// v11 arcs step). The ladder makes the VACUUM INTO backup and wraps the step in one
// transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe (IF NOT EXISTS).
// No table rebuilds.

export const name = 'chat-influence';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_influence_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        kind              TEXT NOT NULL CHECK (kind IN ('mood','invite','live','advice')),
        chat_jid          TEXT NOT NULL,                   -- canonical chat key (group jid | DM person)
        origin_kind       TEXT NOT NULL CHECK (origin_kind IN ('group','dm')),
        msg_id            TEXT NOT NULL,                   -- evidence pointer; NO message text
        sender_jid        TEXT,                            -- canonical sender
        content_hash      TEXT,                            -- sha256 of the message at perceive time (edit detection)
        held              TEXT,                            -- JSON codes held for a deferred message (no text)
        pointer_event_id  INTEGER,                         -- the chat.perceived world event
        decision_id       INTEGER,
        category          TEXT,
        status            TEXT NOT NULL CHECK (status IN ('held','active','withdrawn','reverted','pending','approved',
                                                          'rejected','expired')),
        withdraw_reason   TEXT,
        followup_status   TEXT CHECK (followup_status IN ('due','attempted','sent','skipped','dropped')),
        created_at        INTEGER NOT NULL,
        expires_at        INTEGER,
        decided_at        INTEGER,
        decided_by        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_influence_items_msg ON chat_influence_items(chat_jid, msg_id);
    CREATE INDEX IF NOT EXISTS idx_chat_influence_items_status ON chat_influence_items(status, kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_influence_items_sender ON chat_influence_items(sender_jid);

    CREATE TABLE IF NOT EXISTS chat_influence_pending_withdrawals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        cause       TEXT NOT NULL CHECK (cause IN ('forget','revoke','edit')),
        chat_forms  TEXT NOT NULL,                         -- JSON array of chat forms (no text)
        msg_ids     TEXT NOT NULL,                         -- JSON array of message ids
        msg_ts      INTEGER,
        created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_influence_state (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
  `);
}

export const version = 12;

export default { version, name, up };
