// Dreams (plan 020 G): what he remembers of a night. Adds only. The fact of it is an engine `dream.had` (codes, caused by
// the night's sleep.started); the words are here, swept when the event leaves the log, like story_scenes. Built only from
// his own and the owner's events, so there's no origin to keep and no chat or real person to purge.
//
//   story_dreams  plan_json    the code-built dream: scenes (place word, a fictional first name, a twist), task, ending
//                 text         a fragment from the phrase table, or a vivid dream's words (a template until the model has answered)
//                 phrase_key   which phrase, so one doesn't come back soon
//                 needs_words  1 while a vivid dream waits for its one model call
//
// No FK to world_events (redaction order, like story_scenes). v18 on spec 006's PRAGMA user_version ladder: the ladder
// makes the backup and wraps the step in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'dreams';
export const version = 18;

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_dreams (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            INTEGER NOT NULL UNIQUE,
        sleep_event_id      INTEGER NOT NULL,
        night               TEXT NOT NULL,
        at                  INTEGER NOT NULL,
        recall              TEXT NOT NULL CHECK (recall IN ('fragment','vivid')),
        tone                TEXT NOT NULL CHECK (tone IN ('good','flat','bad','nightmare')),
        plan_json           TEXT NOT NULL,
        text                TEXT,
        tier                TEXT NOT NULL DEFAULT 'code' CHECK (tier IN ('code','clerk')),
        phrase_key          TEXT,
        needs_words         INTEGER NOT NULL DEFAULT 0,
        attempts            INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','reverted')),
        created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_dreams_at ON story_dreams(at);
    CREATE INDEX IF NOT EXISTS idx_story_dreams_words ON story_dreams(needs_words) WHERE needs_words = 1;
  `);
}

export default { version, name, up };
