// Mind (spec 008, data-model.md "v10") — the mind's own tables. Nothing here
// stores raw message text: digests and episodes hold clerk summaries (sanitized,
// capped), and the only chat-bound text is a proactive draft's voiced_text.
//
//   mind_state           singleton: scan/event cursors and run clocks
//   mind_settings        owner-only key/value (pause, proactive/review mode, bands …)
//   mind_runs            the run timeline (glance/think/sleep/… with cost + validated output)
//   mind_nights          one consolidation per night (PK = night_key)
//   mind_chat_activity   pulse counters per chat and local day
//   mind_digests         per-chat clerk digests (evidence in item_evidence 'mind_digest')
//   mind_episode_cursor  per-chat episode + monotonic digest cursors
//   mind_episode_log     one outcome row per chat-night (fenced/rebuild bookkeeping)
//   mind_self_state      self-state elements (mood, today picks, intentions)
//   mind_self_model      self-model versions (one active)
//   mind_nudges          lever overlay + its audit (one active per knob/scope)
//   mind_proactive       proactive drafts and sends (one queued per chat)
//   mind_exclusions      people/groups the mind never reaches out to
// plus a partial index on memories for episodes (category 'episode').
//
// Every surrogate id is INTEGER PRIMARY KEY AUTOINCREMENT (plan review S1-06):
// digest/run/element ids are referenced from JSON (basis_json, run_id), and digests
// are deleted often, so a reused rowid would make an old reference point at a newer
// row of another chat.
//
// v10 on spec 006's PRAGMA user_version ladder (registered in ./index.js). The
// ladder wraps each step in one transaction after the VACUUM INTO backup, so up()
// must NOT BEGIN/COMMIT itself. Re-run safe (IF NOT EXISTS). No table rebuilds.

export const name = 'mind';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        last_rowid      INTEGER NOT NULL DEFAULT 0,      -- messages scan cursor
        last_event_id   INTEGER NOT NULL DEFAULT 0,      -- life world_events cursor
        last_tick_at    INTEGER,
        last_glance_at  INTEGER,
        last_think_at   INTEGER,
        last_sleep_at   INTEGER,
        last_weekly_at  INTEGER,
        next_think_at   INTEGER,
        updated_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS mind_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,                       -- JSON-encoded
        updated_at  INTEGER,
        updated_by  TEXT                                 -- owner:<user> | system
    );

    CREATE TABLE IF NOT EXISTS mind_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL
                     CHECK (kind IN ('pulse','glance','think','sleep','selfmodel','draft','digest')),
        trigger      TEXT,
        trigger_ref  TEXT,
        day_key      TEXT NOT NULL,
        night_key    TEXT,
        started_at   INTEGER,
        finished_at  INTEGER,
        status       TEXT NOT NULL
                     CHECK (status IN ('running','ok','skipped','invalid','failed','partial')),
        skip_reason  TEXT,
        fell_back    INTEGER NOT NULL DEFAULT 0,
        degraded     INTEGER NOT NULL DEFAULT 0,
        input_json   TEXT,
        output_json  TEXT,
        dropped_json TEXT,
        model        TEXT,
        tokens_in    INTEGER,
        tokens_out   INTEGER,
        cache_read   INTEGER,
        cost_usd     REAL,
        error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mind_runs_kind ON mind_runs(kind, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mind_runs_day ON mind_runs(day_key, kind);

    CREATE TABLE IF NOT EXISTS mind_nights (
        night_key        TEXT PRIMARY KEY,
        status           TEXT NOT NULL CHECK (status IN ('running','done','failed','missed')),
        partial          TEXT,
        selfmodel_run_id INTEGER,
        attempts         INTEGER NOT NULL DEFAULT 0,
        episodes         INTEGER NOT NULL DEFAULT 0,
        run_id           INTEGER,
        started_at       INTEGER,
        finished_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS mind_chat_activity (
        chat_jid        TEXT NOT NULL,
        day_key         TEXT NOT NULL,
        msgs            INTEGER NOT NULL DEFAULT 0,
        human_msgs      INTEGER NOT NULL DEFAULT 0,
        senders         INTEGER NOT NULL DEFAULT 0,
        bot_mentions    INTEGER NOT NULL DEFAULT 0,
        open_questions  INTEGER NOT NULL DEFAULT 0,
        bot_msgs        INTEGER NOT NULL DEFAULT 0,
        last_human_at   INTEGER,
        last_bot_at     INTEGER,
        PRIMARY KEY (chat_jid, day_key)
    );

    CREATE TABLE IF NOT EXISTS mind_digests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid      TEXT NOT NULL,
        origin_kind   TEXT NOT NULL CHECK (origin_kind IN ('group','dm')),
        from_rowid    INTEGER NOT NULL,                  -- exclusive
        to_rowid      INTEGER NOT NULL,                  -- inclusive
        period_start  INTEGER NOT NULL,                  -- MIN(evidence ts) = minLearnedAt of elements pointing here
        period_end    INTEGER NOT NULL,
        summary       TEXT NOT NULL,
        today_note    TEXT,
        tone          TEXT NOT NULL CHECK (tone IN ('neutral','warm','playful','tense','sad','busy')),
        threads_json  TEXT NOT NULL DEFAULT '[]',
        model         TEXT,
        run_id        INTEGER,
        created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mind_digests_chat ON mind_digests(chat_jid, to_rowid DESC);

    CREATE TABLE IF NOT EXISTS mind_episode_cursor (
        chat_jid        TEXT PRIMARY KEY,
        last_rowid      INTEGER NOT NULL DEFAULT 0,
        digest_rowid    INTEGER NOT NULL DEFAULT 0,      -- monotonic high-water mark of the digest cursor
        last_night_key  TEXT,
        updated_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS mind_episode_log (
        chat_jid           TEXT NOT NULL,
        night_key          TEXT NOT NULL,
        outcome            TEXT NOT NULL
                           CHECK (outcome IN ('written','null','tombstoned','capped','deleted','fenced')),
        memory_id          INTEGER,
        cause              TEXT CHECK (cause IS NULL OR cause IN ('forget','revoke','edit','purge','retention')),
        rebuild_requested  INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER,
        PRIMARY KEY (chat_jid, night_key)
    );

    CREATE TABLE IF NOT EXISTS mind_self_state (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL CHECK (kind IN ('mood','base_mood','today','intention')),
        word            TEXT,
        intensity       REAL,
        intention_kind  TEXT CHECK (intention_kind IS NULL OR intention_kind IN
                        ('follow_up','check_in','share','wind_down','be_present','keep_quiet','catch_up')),
        target_chat     TEXT,
        basis_json      TEXT NOT NULL DEFAULT '[]',
        origins_json    TEXT NOT NULL DEFAULT '[]',
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active','expired','done','superseded')),
        run_id          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mind_self_state_status ON mind_self_state(status, kind);

    CREATE TABLE IF NOT EXISTS mind_self_model (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        version          INTEGER NOT NULL,
        text             TEXT NOT NULL,
        source           TEXT NOT NULL CHECK (source IN ('seed','owner','mind')),
        status           TEXT NOT NULL
                         CHECK (status IN ('proposed','approved','rejected','active','superseded','invalid')),
        base_version     INTEGER,
        diff_json        TEXT,
        changes_summary  TEXT,
        rationale        TEXT,
        scrub_json       TEXT,
        run_id           INTEGER,
        created_at       INTEGER,
        decided_at       INTEGER,
        activated_at     INTEGER,
        decided_by       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_self_model_version ON mind_self_model(version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_self_model_active ON mind_self_model(status) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS mind_nudges (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        knob           TEXT NOT NULL,
        scope          TEXT NOT NULL,                    -- 'global' or a group jid
        prev_value     TEXT NOT NULL,                    -- JSON scalars
        value          TEXT NOT NULL,
        requested      TEXT NOT NULL,
        band_json      TEXT NOT NULL,
        reason         TEXT,
        status         TEXT NOT NULL
                       CHECK (status IN ('active','expired','reverted','overridden','replaced','refused','clamped')),
        active         INTEGER NOT NULL DEFAULT 0,
        refuse_reason  TEXT,
        run_id         INTEGER,
        created_at     INTEGER,
        expires_at     INTEGER,
        ended_at       INTEGER,
        ended_by       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_nudges_active ON mind_nudges(knob, scope) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_mind_nudges_created ON mind_nudges(created_at DESC);

    CREATE TABLE IF NOT EXISTS mind_proactive (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid       TEXT NOT NULL,
        chat_kind      TEXT NOT NULL CHECK (chat_kind IN ('group','dm')),
        person_jid     TEXT,
        send_jid       TEXT,
        audience_json  TEXT,
        kind           TEXT NOT NULL CHECK (kind IN ('follow_up','check_in','share')),
        urgency        REAL,
        reason         TEXT,
        basis_json     TEXT NOT NULL,
        origins_json   TEXT NOT NULL,
        intent         TEXT,
        voiced_text    TEXT,
        alt_text       TEXT,
        alt_model      TEXT,
        gate_score     REAL,
        gate_reason    TEXT,
        mode           TEXT NOT NULL CHECK (mode IN ('shadow','live')),
        status         TEXT NOT NULL CHECK (status IN ('drafting','shadow','would_send','queued','sent','dry_run',
                                                       'send_failed','dropped','cancelled','expired')),
        drop_reason    TEXT,
        run_id         INTEGER,
        created_at     INTEGER NOT NULL,
        send_after     INTEGER,
        sent_at        INTEGER,
        msg_id         TEXT,
        replied_at     INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_proactive_queued ON mind_proactive(chat_jid) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS idx_mind_proactive_chat ON mind_proactive(chat_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mind_proactive_status ON mind_proactive(status, send_after);

    CREATE TABLE IF NOT EXISTS mind_exclusions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL CHECK (kind IN ('person','group')),
        jid         TEXT NOT NULL,
        source      TEXT NOT NULL CHECK (source IN ('owner','detected','owner_cleared')),
        msg_id      TEXT,                                -- the detected message (no text stored)
        cleared_at  INTEGER,
        p           REAL,                                -- Jev probability; NULL = prefilter-only (fail closed)
        note        TEXT,
        created_at  INTEGER NOT NULL,
        created_by  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mind_exclusions_jid ON mind_exclusions(kind, jid);

    CREATE INDEX IF NOT EXISTS idx_memories_episode ON memories(origin_jid, attribute) WHERE category = 'episode';
  `);
}

export const version = 10;

export default { version, name, up };
