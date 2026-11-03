// How things stand (plan 020 D2): one short note per fictional cast member, rebuilt at night from what
// changed. Adds only: world_events, 006, story and mind tables are not touched.
//
//   story_standing           one row per version of the note. A new version closes the old one
//                            (valid_to, status 'superseded'); an old one is invalidated, never edited.
//                            as_of_event_id = everything up to here was considered. supersedes = the
//                            version this one was built on (not always the newest: an invalidated
//                            one is never built on).
//   story_standing_evidence  the world events each version read: its own, not its ancestors' (a walk
//                            over supersedes gives the rest). No FK to world_events.
//
// Fictional people only: no JID, no real name, no chat text, ever. At most one live row per member.
// v19 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the step in one
// transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'standing';
export const version = 19;

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_standing (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        cast_id             TEXT NOT NULL,
        text                TEXT NOT NULL,
        as_of_event_id      INTEGER NOT NULL,
        valid_from          INTEGER NOT NULL,
        valid_to            INTEGER,
        supersedes          INTEGER,
        status              TEXT NOT NULL CHECK (status IN ('live','superseded','invalidated')),
        invalid_reason      TEXT,
        words_sig           TEXT,
        night               TEXT,
        model               TEXT,
        fell_back           INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_story_standing_live ON story_standing(cast_id) WHERE status = 'live';
    CREATE INDEX IF NOT EXISTS idx_story_standing_cast ON story_standing(cast_id, id);

    CREATE TABLE IF NOT EXISTS story_standing_evidence (
        version_id          INTEGER NOT NULL,
        event_id            INTEGER NOT NULL,
        at                  INTEGER NOT NULL,
        source              TEXT NOT NULL,
        PRIMARY KEY (version_id, event_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_story_standing_evidence_event ON story_standing_evidence(event_id);
  `);
}

export default { version, name, up };
