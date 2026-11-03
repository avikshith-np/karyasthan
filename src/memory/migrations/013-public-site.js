// Public site (spec 013, plan "Data") — the exporter's own bookkeeping. Adds only:
// world_events, 006 and story/influence tables are not touched.
//
//   public_people   the per-person "show on public site" switch (off by default) with the
//                   owner-chosen display name and a random public id (never derived from a JID)
//   public_journal  journal self parts the owner pressed PUBLISH on, frozen + scrubbed at publish
//   public_state    key/value: install salt, last export hash/time/status, last upload, last issue
//   public_votes    tallies pulled from the votes Worker (counts per exported decision/option)
//
// No chat text, no message ids, no copies of world-event payloads.
// v13 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the
// step in one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'public-site';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_people (
        person_jid    TEXT PRIMARY KEY,                    -- canonical person (identity.resolvePerson)
        public_id     TEXT NOT NULL UNIQUE,                -- 'f_' + 12 random hex
        display_name  TEXT NOT NULL,
        opted_in      INTEGER NOT NULL DEFAULT 0 CHECK (opted_in IN (0, 1)),
        updated_at    INTEGER NOT NULL,
        updated_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS public_journal (
        night_key     TEXT PRIMARY KEY,                    -- 'YYYY-MM-DD'
        text          TEXT NOT NULL,
        published_at  INTEGER NOT NULL,
        published_by  TEXT
    );

    CREATE TABLE IF NOT EXISTS public_state (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public_votes (
        decision_id  INTEGER NOT NULL,
        option_id    TEXT NOT NULL,
        count        INTEGER NOT NULL CHECK (count >= 0),
        pulled_at    INTEGER NOT NULL,
        PRIMARY KEY (decision_id, option_id)
    );
  `);
}

export const version = 13;

export default { version, name, up };
