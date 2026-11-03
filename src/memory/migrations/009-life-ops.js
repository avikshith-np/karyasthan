// Life core (spec 009, plan §D/§R18) — operational tables of the life layer:
//   life_queue   messages deferred by the availability gate, drained at his next
//                phone check (src/life/queue.js, src/life/phone.js)
//   life_claims  self-claims/commitments in his sent replies, flagged for owner
//                review (src/life/claims.js; adopt/reject arrive with spec 010)
// Both are mutable (status changes, pruning) — unlike world_events.
//
// v9 on spec 006's PRAGMA user_version ladder (registered in ./index.js). The
// ladder wraps each step in one transaction, so up() must NOT BEGIN/COMMIT
// itself. Re-run safe (IF NOT EXISTS).

export const name = 'life-ops';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_queue (
        id            INTEGER PRIMARY KEY,
        chat_jid      TEXT NOT NULL,
        msg_id        TEXT NOT NULL,                 -- messages.id
        sender_jid    TEXT,
        msg_key_json  TEXT NOT NULL,                 -- Baileys key for readMessages at the next check
        is_dm         INTEGER NOT NULL DEFAULT 0,
        is_mention    INTEGER NOT NULL DEFAULT 0,
        is_question   INTEGER NOT NULL DEFAULT 0,
        availability  TEXT NOT NULL,                 -- his state when it was deferred
        enqueued_at   INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','drained','dropped','expired')),
        reason        TEXT,                          -- dropped/expired reason
        drained_at    INTEGER,
        UNIQUE (chat_jid, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_life_queue_status ON life_queue(status, enqueued_at);

    CREATE TABLE IF NOT EXISTS life_claims (
        id            INTEGER PRIMARY KEY,
        chat_jid      TEXT NOT NULL,
        origin_kind   TEXT NOT NULL,
        origin_jid    TEXT NOT NULL,
        reply_msg_id  TEXT,
        text          TEXT NOT NULL CHECK (length(text) <= 300),   -- sanitized reply excerpt
        kind          TEXT CHECK (kind IN ('claim','commitment')),
        p             REAL,
        status        TEXT NOT NULL DEFAULT 'flagged'
                      CHECK (status IN ('flagged','dismissed','adopted','rejected')),  -- adopted|rejected: 010
        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        reviewed_at   INTEGER,
        reviewed_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_life_claims_status ON life_claims(status, created_at);
  `);
}

export const version = 9;

export default { version, name, up };
