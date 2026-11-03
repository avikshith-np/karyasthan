// The thought stream (plan 020 F2): what passes through his head, code-built. Adds only: world_events,
// 006, story and influence tables are not touched. Thoughts are not facts of his life, so they
// don't enter the log: one row per thought, with the events it rests on.
//
//   story_thoughts  evidence_event_ids  the world events it rests on (JSON array); one that leaves the
//                                       log (revert, rewind, redaction) takes the thought with it
//                   as_of_event_id      the log's head when it was thought: a rewind over it removes
//                                       even a thought with no evidence of its own
//                   dedupe_key          one thought per piece of evidence / per slot of a tick, so a
//                                       restart or a replay can't double it
//                   phrase_key          which phrase, for repeat memory; origin_* as in spec 006
//
// No chat text ever: a chat-origin thought is a code-built feeling and its origin. No FK to
// world_events (redaction/purge order, like story_scenes, story_messages).
// v16 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the step
// in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'thoughts';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_thoughts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        at                  INTEGER NOT NULL,
        family              TEXT NOT NULL CHECK (family IN ('reaction','want_should','putting_off','body','people','wordless','excuse')),
        text                TEXT NOT NULL,
        codes_json          TEXT,
        origin_kind         TEXT NOT NULL DEFAULT 'self' CHECK (origin_kind IN ('self','group','dm','call','ig','owner')),
        origin_jid          TEXT,
        evidence_event_ids  TEXT NOT NULL DEFAULT '[]',
        as_of_event_id      INTEGER,
        cause_code          TEXT,
        dedupe_key          TEXT,
        phrase_key          TEXT,
        created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_story_thoughts_at ON story_thoughts(at);
    CREATE INDEX IF NOT EXISTS idx_story_thoughts_origin ON story_thoughts(origin_jid, at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_story_thoughts_dedupe ON story_thoughts(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}
export const version = 16;

export default { version, name, up };
