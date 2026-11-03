// The claim check (plan 020 E3): what was said about his life, checked against the fact sheet it was written from. Adds only.
// Shadow by default: these rows change nothing. Nothing here is chat text: an output from a chat's plan keeps verdicts and
// codes with `claim` and `evidence` NULL, so a purge has nothing to find here.
//
//   story_check_runs    one output of one writer (scene | phone | journal), keyed by the row it lives in + the sha of its
//                       words. grounding_json holds the code-built sheet lines only until the check has run.
//   story_check_claims  one verdict: code (time words, how he left) or clerk (extracted claims).
//
// No FK to world_events or the writers' tables (redaction order, like story_scenes): the worker's sweep removes a run whose
// output left the log or changed. v20 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the step
// in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'claim-check';
export const version = 20;

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_check_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        writer          TEXT NOT NULL CHECK (writer IN ('scene','phone','journal')),
        row_id          INTEGER NOT NULL,
        event_id        INTEGER,
        output_sha      TEXT NOT NULL,
        speaker         TEXT NOT NULL CHECK (speaker IN ('narrator','his','cast')),
        chat_origin     INTEGER NOT NULL DEFAULT 0,
        mode            TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','enforce')),
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','checked','code_only')),
        skip_reason     TEXT,
        rewrote         INTEGER NOT NULL DEFAULT 0,
        cut             INTEGER NOT NULL DEFAULT 0,
        grounding_json  TEXT,
        at              INTEGER NOT NULL,
        model           TEXT,
        created_at      INTEGER NOT NULL,
        checked_at      INTEGER,
        UNIQUE (writer, row_id, output_sha)
    );
    CREATE INDEX IF NOT EXISTS idx_story_check_runs_status ON story_check_runs(status);
    CREATE INDEX IF NOT EXISTS idx_story_check_runs_at ON story_check_runs(at);
    CREATE TABLE IF NOT EXISTS story_check_claims (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER NOT NULL,
        source      TEXT NOT NULL CHECK (source IN ('code','clerk')),
        about       TEXT NOT NULL CHECK (about IN ('who','where','when','left','money','plan')),
        claim       TEXT,
        verdict     TEXT NOT NULL CHECK (verdict IN ('supported','contradicted','unknown')),
        reason      TEXT NOT NULL,
        evidence    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_story_check_claims_run ON story_check_claims(run_id);
    CREATE INDEX IF NOT EXISTS idx_story_check_claims_verdict ON story_check_claims(verdict);
  `);
}

export default { version, name, up };
