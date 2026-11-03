// Life core (spec 009, plan §D/§R18) — the event-sourced world: an append-only
// world_events log projected into his state by src/life/projector.js, plus
// world_snapshots (a replay cache, NOT part of the log; freely deleted when a
// revert invalidates it).
//
// v8 on spec 006's PRAGMA user_version ladder (registered in ./index.js). The
// ladder wraps each step in one transaction, so up() must NOT BEGIN/COMMIT
// itself. Re-run safe (IF NOT EXISTS; triggers dropped then recreated).
//
// Append-only is enforced in SQL: DELETE always aborts; UPDATE aborts unless it
// is the redaction shape used by eventLog.redactPerson() (006 purgePerson):
// redacted 0 → 1 with every identifying/causal column unchanged, so payload_json
// and subject_jid are the only fields that may be cleared. A redacted row can
// never be updated again.

export const name = 'world-events';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            INTEGER NOT NULL,                        -- world time (when it happened in his life)
        recorded_at   INTEGER NOT NULL DEFAULT (unixepoch()),  -- wall time of the write
        type          TEXT NOT NULL,                           -- catalogue in plan §D (validated in eventLog.js)
        actor         TEXT NOT NULL CHECK (actor IN ('engine','jev','mind','owner','chat')),
        cause_id      INTEGER REFERENCES world_events(id),
        payload_json  TEXT NOT NULL DEFAULT '{}' CHECK (length(payload_json) <= 8192),  -- outcomes, never rolls
        origin_kind   TEXT NOT NULL DEFAULT 'self'
                      CHECK (origin_kind IN ('self','group','dm','call','ig','owner')),
        origin_jid    TEXT NOT NULL DEFAULT 'self',
        subject_jid   TEXT,                                    -- real person involved, if any
        heavy         INTEGER NOT NULL DEFAULT 0 CHECK (heavy IN (0, 1)),
        redacted      INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_world_events_at ON world_events(at);
    CREATE INDEX IF NOT EXISTS idx_world_events_type_at ON world_events(type, at);
    CREATE INDEX IF NOT EXISTS idx_world_events_cause ON world_events(cause_id);
    CREATE INDEX IF NOT EXISTS idx_world_events_origin_at ON world_events(origin_jid, at);
    CREATE INDEX IF NOT EXISTS idx_world_events_subject ON world_events(subject_jid);

    DROP TRIGGER IF EXISTS world_events_no_delete;
    CREATE TRIGGER world_events_no_delete BEFORE DELETE ON world_events
    BEGIN
        SELECT RAISE(ABORT, 'world_events is append-only');
    END;

    DROP TRIGGER IF EXISTS world_events_no_update;
    CREATE TRIGGER world_events_no_update BEFORE UPDATE ON world_events
    WHEN NOT (
        OLD.redacted = 0 AND NEW.redacted = 1
        AND NEW.id = OLD.id AND NEW.at = OLD.at AND NEW.type = OLD.type AND NEW.actor = OLD.actor
        AND NEW.cause_id IS OLD.cause_id AND NEW.recorded_at = OLD.recorded_at
        AND NEW.origin_kind = OLD.origin_kind AND NEW.origin_jid = OLD.origin_jid
        AND NEW.heavy = OLD.heavy
    )
    BEGIN
        SELECT RAISE(ABORT, 'world_events is append-only (only redaction may update a row)');
    END;

    -- Projection cache: the latest snapshot at or before a point plus a replay of
    -- later events rebuilds WorldState. Keep last 14 + one per month (projector.js).
    CREATE TABLE IF NOT EXISTS world_snapshots (
        id             INTEGER PRIMARY KEY,
        upto_event_id  INTEGER NOT NULL,
        at             INTEGER NOT NULL,
        state_json     TEXT NOT NULL,
        created_at     INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_world_snapshots_upto ON world_snapshots(upto_event_id);
    CREATE INDEX IF NOT EXISTS idx_world_snapshots_at ON world_snapshots(at);
  `);
}

export const version = 8;

export default { version, name, up };
