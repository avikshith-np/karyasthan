// Relationships, arcs & Director (spec 010, data-model.md §1 "Migration v11") — the
// story layer's own tables. world_events is NOT touched: the new event types are
// code-validated (research R2), and the log stays append-only.
//
//   story_claim_reviews   the reconciler's view of one flagged 009 claim (one row per claim)
//   story_runs            model runs (weekly, seed, extract, journal, narrate, appraisal): ids + validated output only
//   story_proposals       weekly-pass parts waiting for the owner, or refused
//   story_journal_nights  one journal night (PK = night_key)
//   story_journal_parts   one journal part per night and origin (self or a chat)
//   story_narrations      cached dashboard narrations (event / thought)
//   story_refusals        changes refused by controls or caps (operational log)
//   story_state           singleton key/value bookkeeping (not world state)
//
// Nothing here stores raw chat text: the claim text stays in 009's life_claims; a
// review keeps only the validated extraction (NULLed on withdraw/forget/purge).
// claim_id has no FK on purpose: redactPerson deletes claims inside the purge
// transaction (research R22).
//
// Every surrogate id is INTEGER PRIMARY KEY AUTOINCREMENT: ids are referenced from
// JSON (sources_json, payloads, run_id) and rows are pruned, so a reused rowid would
// make an old reference point at a newer, unrelated row.
//
// v11 on spec 006's PRAGMA user_version ladder (registered in ./index.js after the
// v10 mind step). The ladder makes the VACUUM INTO backup and wraps the step in one
// transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe (IF NOT EXISTS).
// No table rebuilds.

export const name = 'arcs';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_claim_reviews (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id          INTEGER NOT NULL UNIQUE,         -- life_claims.id (no FK, R22)
        claim_event_id    INTEGER,                         -- the claim.flagged world event
        chat_jid          TEXT NOT NULL,
        origin_kind       TEXT NOT NULL CHECK (origin_kind IN ('group','dm')),
        origin_jid        TEXT NOT NULL,
        status            TEXT NOT NULL
                          CHECK (status IN ('pending','extracting','adopted','tray','rejected','dismissed',
                                            'expired','withdrawn','returned','failed')),
        reason            TEXT CHECK (reason IS NULL OR reason IN ('out_of_scope','out_of_window','unknown_place',
                                            'ambiguous_place','unknown_person','ambiguous_person','multi_person',
                                            'conflict','blocked','cap','not_extracted','review_mode',
                                            'invalid_extraction','rewound','owner')),
        extraction_json   TEXT,                            -- validated clerk output (≤ 2 KB)
        resolution_json   TEXT,                            -- {placeId, castIds, subjectJid, span, day} (≤ 2 KB)
        conflict_json     TEXT,
        adopted_event_id  INTEGER,
        run_id            INTEGER,
        created_at        INTEGER NOT NULL,
        decided_at        INTEGER,
        expires_at        INTEGER NOT NULL,
        decided_by        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_story_claim_reviews_status ON story_claim_reviews(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_story_claim_reviews_origin ON story_claim_reviews(origin_jid, created_at);

    CREATE TABLE IF NOT EXISTS story_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL CHECK (kind IN ('weekly','seed','extract','journal','narrate','appraisal')),
        caller        TEXT NOT NULL,                       -- matches llm_usage.caller
        status        TEXT NOT NULL CHECK (status IN ('running','ok','skipped','invalid','failed','partial')),
        skip_reason   TEXT,
        model         TEXT,
        fell_back     INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL,
        input_json    TEXT,                                -- label map + ids only (≤ 8 KB)
        output_json   TEXT,                                -- validated output (≤ 8 KB)
        dropped_json  TEXT,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_story_runs_kind ON story_runs(kind, started_at);

    CREATE TABLE IF NOT EXISTS story_proposals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        INTEGER NOT NULL,
        week_key      TEXT NOT NULL,                       -- YYYY-Www in world tz
        category      TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('beat','new_cast','new_place','arc_decision','heavy_nomination')),
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','refused','expired')),
        reason        TEXT,
        created_at    INTEGER NOT NULL,
        decided_at    INTEGER,
        decided_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_story_proposals_status ON story_proposals(status, created_at);

    CREATE TABLE IF NOT EXISTS story_journal_nights (
        night_key       TEXT PRIMARY KEY,                  -- YYYY-MM-DD of (sleep.started − 12 h) in world tz
        status          TEXT NOT NULL CHECK (status IN ('running','done','partial','skipped','failed','missed')),
        reason          TEXT,
        sleep_event_id  INTEGER,
        attempts        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        finished_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS story_journal_parts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        night_key     TEXT NOT NULL,
        origin_kind   TEXT NOT NULL CHECK (origin_kind IN ('self','group','dm')),
        origin_jid    TEXT NOT NULL,                       -- 'self' or the chat
        text          TEXT,                                -- NULL once fenced
        sources_json  TEXT NOT NULL,                       -- {events:[ids], claims:[ids]}
        status        TEXT NOT NULL CHECK (status IN ('active','undone','fenced')),
        run_id        INTEGER,
        created_at    INTEGER NOT NULL,
        UNIQUE (night_key, origin_jid)
    );

    CREATE TABLE IF NOT EXISTS story_narrations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL CHECK (kind IN ('event','thought')),
        event_id      INTEGER,                             -- NULL for a thought
        origins_json  TEXT NOT NULL,
        text          TEXT NOT NULL,
        sources_json  TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        UNIQUE (kind, event_id)
    );

    CREATE TABLE IF NOT EXISTS story_refusals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           INTEGER NOT NULL,
        source       TEXT NOT NULL CHECK (source IN ('engine','mind','reconciler','owner')),
        category     TEXT,
        action       TEXT NOT NULL,
        target       TEXT,
        reason       TEXT NOT NULL CHECK (reason IN ('paused','frozen','pinned','guided','cap','forbidden',
                                                     'name_collision','region','lead_time','invalid')),
        pin_key      TEXT,
        detail_json  TEXT                                  -- ≤ 1 KB, ids only
    );
    CREATE INDEX IF NOT EXISTS idx_story_refusals_at ON story_refusals(at);

    CREATE TABLE IF NOT EXISTS story_state (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );
  `);
}

export const version = 11;

export default { version, name, up };
