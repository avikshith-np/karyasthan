// Scene play-outs (spec 016, plan §1.2) — how an outing with someone went. Adds only:
// world_events, 006, story and influence tables are not touched.
//
//   story_scenes   one row per (activity.started, version): the validated narration and its
//                  detail (impressions, topics, highlight, awkward), the owner's edit and tone
//                  hint (+ its outcome word), the tier / model / skip reason, heavy_window (a
//                  session around a heavy stretch: DM/call only, never journal or site) and the
//                  code-built fact sheet v1 was written from (reused by every regenerate). The world log carries codes only
//                  (scene.played: ids, enums, chemistry, a sha256 of the text); model text
//                  never enters world_events (010's rule). No chat text: the input has none.
//
// No FK to world_events (redaction/purge order, like story_claim_reviews).
// v14 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the
// step in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'scenes';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_scenes (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_event_id INTEGER NOT NULL,
        version           INTEGER NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('pending','running','done','fallback','skipped','superseded','reverted')),
        skip_reason       TEXT,
        event_id          INTEGER,
        tier              TEXT CHECK (tier IN ('clerk','mind','code')),
        mode              TEXT CHECK (mode IN ('full','narration_only','self_only')),
        origin_kind       TEXT,
        origin_jid        TEXT,
        subject_jid       TEXT,
        ended_at          INTEGER NOT NULL,
        text              TEXT,
        edited_text       TEXT,
        edited_at         INTEGER,
        detail_json       TEXT,
        tone              TEXT,
        tone_outcome      TEXT,
        heavy_window      INTEGER NOT NULL DEFAULT 0,
        sheet_json        TEXT,
        model             TEXT,
        fell_back         INTEGER NOT NULL DEFAULT 0,
        caller            TEXT,
        created_at        INTEGER NOT NULL,
        finished_at       INTEGER,
        UNIQUE (activity_event_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_story_scenes_event ON story_scenes(event_id);
    CREATE INDEX IF NOT EXISTS idx_story_scenes_subject ON story_scenes(subject_jid);
  `);
}

export const version = 14;

export default { version, name, up };
