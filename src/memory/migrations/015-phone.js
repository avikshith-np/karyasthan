// His phone (spec 019) — in-world texting with the fictional cast. Adds only:
// world_events, 006, story and influence tables are not touched.
//
//   story_messages  one row per message turn (≤ 3 short bubbles, one per line) in a
//                   thread with one cast member: pending (due_at) → running → live, or
//                   skipped; reverted when its phone.message left the log (text NULLed);
//                   superseded by an owner REGENERATE. The world log carries codes only
//                   (phone.message: ids, dir, length, a sha256 of the text); model text
//                   never enters world_events (010's rule). No chat text: the input has none.
//
// No FK to world_events (redaction/purge order, like story_scenes).
// v15 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the
// step in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'phone';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_messages (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        cast_id           TEXT NOT NULL,
        dir               TEXT NOT NULL CHECK (dir IN ('out','in')),
        status            TEXT NOT NULL CHECK (status IN ('pending','running','live','skipped','superseded','reverted')),
        skip_reason       TEXT,
        trigger           TEXT NOT NULL,
        trigger_event_id  INTEGER,
        exchange          INTEGER NOT NULL DEFAULT 0,
        due_at            INTEGER NOT NULL,
        tries             INTEGER NOT NULL DEFAULT 0,
        event_id          INTEGER,
        at                INTEGER,
        text              TEXT,
        edited_text       TEXT,
        edited_at         INTEGER,
        tone              TEXT,
        topic             TEXT,
        tier              TEXT CHECK (tier IN ('mouth','mind','clerk')),
        model             TEXT,
        fell_back         INTEGER NOT NULL DEFAULT 0,
        caller            TEXT,
        heavy_window      INTEGER NOT NULL DEFAULT 0,
        replaces_id       INTEGER,
        created_at        INTEGER NOT NULL,
        finished_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_story_messages_cast ON story_messages(cast_id, at);
    CREATE INDEX IF NOT EXISTS idx_story_messages_status ON story_messages(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_story_messages_event ON story_messages(event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_story_messages_trigger ON story_messages(trigger, trigger_event_id, cast_id, exchange)
      WHERE trigger_event_id IS NOT NULL AND replaces_id IS NULL;
  `);
}

export const version = 15;

export default { version, name, up };
