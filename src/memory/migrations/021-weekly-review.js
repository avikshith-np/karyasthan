// The weekly review (plan 020 E4): the owner marks a sample of what the writers wrote. Adds only.
//
//   review_items  one row per sampled output: a pointer (surface + the source row's id), never its
//                 words, so a revert, a rewind or a purge takes the text with the source. No JID:
//                 outputs about real people are never sampled.
//                 verdict  NULL until marked; note_code one of the page's fixed codes, no free text.
//   review_weeks  one row per week sampled. closed = 1 once the finished week had its sample; a
//                 sample of the week so far leaves 0, and the finished week tops it up.
//
// v21 on spec 006's PRAGMA user_version ladder: the ladder makes the backup and wraps the step in
// one transaction, so up() must NOT BEGIN/COMMIT itself. Re-run safe.

export const name = 'weekly-review';
export const version = 21;

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        week        TEXT NOT NULL,
        surface     TEXT NOT NULL CHECK (surface IN ('scene','phone','thought','dream')),
        source_id   INTEGER NOT NULL,
        rank        TEXT NOT NULL,
        sampled_at  INTEGER NOT NULL,
        verdict     TEXT CHECK (verdict IN ('pass','fail')),
        note_code   TEXT,
        marked_at   INTEGER,
        UNIQUE (surface, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_review_items_open ON review_items(week, rank) WHERE verdict IS NULL;
    CREATE INDEX IF NOT EXISTS idx_review_items_week ON review_items(week, surface);
    CREATE TABLE IF NOT EXISTS review_weeks (
        week        TEXT PRIMARY KEY,
        closed      INTEGER NOT NULL DEFAULT 0,
        sampled_at  INTEGER NOT NULL
    );
  `);
}

export default { version, name, up };
