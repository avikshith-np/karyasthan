// A changing mind (plan 020 B): his interests and opinions, what moved them and how. Adds only: world_events,
// 006, story and mind tables are not touched.
//
//   self_stance           one row per topic. topic is a namespaced key (kind:… place:… cast:… fixed:…, and
//                         later free:<slug> with no migration). value is a cache: base_value folded forward
//                         over the live evidence from base_night, so undoing evidence recomputes it exactly.
//   self_stance_evidence  what he lived, per night: world event ids + an origin (spec 006) + a signed weight
//                         and a cause code. Never a stance, a thought, an episode or a model's words.
//                         Kept 60 nights, then folded into base_value.
//   self_stance_history   the value after each night, for the trend.
//
// No chat text ever: chat evidence is codes and an origin. No FK to world_events (redaction / purge order).
// v17 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the step in one
// transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'stance';
export const version = 17;

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_stance (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        topic               TEXT NOT NULL UNIQUE,
        label               TEXT NOT NULL,
        kind                TEXT NOT NULL CHECK (kind IN ('interest','opinion')),
        value               REAL NOT NULL,
        confidence          REAL NOT NULL DEFAULT 0.5,
        anchor              REAL NOT NULL,
        uptake              REAL NOT NULL DEFAULT 1,
        base_value          REAL NOT NULL,
        base_confidence     REAL NOT NULL DEFAULT 0.5,
        base_night          TEXT,
        base_since          INTEGER NOT NULL DEFAULT 0,
        base_habit          TEXT,
        status              TEXT NOT NULL CHECK (status IN ('proposed','active','rejected','archived')),
        pinned              INTEGER NOT NULL DEFAULT 0,
        why                 TEXT,
        source              TEXT NOT NULL CHECK (source IN ('seed','owner','code')),
        last_reinforced_at  INTEGER,
        created_at          INTEGER NOT NULL,
        approved_at         INTEGER,
        updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_self_stance_status ON self_stance(status);

    CREATE TABLE IF NOT EXISTS self_stance_evidence (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        stance_id           INTEGER NOT NULL,
        night               TEXT NOT NULL,
        at                  INTEGER NOT NULL,
        source              TEXT NOT NULL,
        cause_code          TEXT NOT NULL,
        weight              REAL NOT NULL,
        event_ids           TEXT NOT NULL DEFAULT '[]',
        origin_kind         TEXT NOT NULL DEFAULT 'self' CHECK (origin_kind IN ('self','group','dm','call','ig','owner')),
        origin_jid          TEXT,
        subject_jid         TEXT,
        origin_at           INTEGER,
        details_json        TEXT,
        created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_self_stance_evidence_stance ON self_stance_evidence(stance_id, night);
    CREATE INDEX IF NOT EXISTS idx_self_stance_evidence_origin ON self_stance_evidence(origin_jid, at);
    CREATE INDEX IF NOT EXISTS idx_self_stance_evidence_subject ON self_stance_evidence(subject_jid);

    CREATE TABLE IF NOT EXISTS self_stance_history (
        stance_id           INTEGER NOT NULL,
        night               TEXT NOT NULL,
        before_value        REAL NOT NULL,
        after_value         REAL NOT NULL,
        confidence          REAL NOT NULL,
        evidence_count      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (stance_id, night)
    );
  `);
}

export default { version, name, up };
