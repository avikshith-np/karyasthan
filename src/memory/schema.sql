-- ============================================================
-- FROZEN v0 BASELINE — do not change table shapes here.
-- This is the schema as of spec 006's start (commit c699f57). Fresh and existing
-- databases both run it (every statement is IF NOT EXISTS) and then climb the
-- versioned ladder in src/memory/migrations/ (PRAGMA user_version). Any schema
-- change is a new ladder step — add ladder steps, never edit this file.
-- ============================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- GROUPS
-- ============================================================
CREATE TABLE IF NOT EXISTS groups (
    jid             TEXT PRIMARY KEY,
    name            TEXT,
    vibe            TEXT,
    language        TEXT DEFAULT 'en',
    avg_messages_hr REAL DEFAULT 0,
    last_active     INTEGER,
    joined_at       INTEGER,
    config_json     TEXT DEFAULT '{}',
    created_at      INTEGER DEFAULT (unixepoch()),
    updated_at      INTEGER DEFAULT (unixepoch())
);

-- ============================================================
-- PEOPLE
-- ============================================================
CREATE TABLE IF NOT EXISTS people (
    jid             TEXT PRIMARY KEY,
    phone           TEXT,
    push_name       TEXT,
    real_name       TEXT,
    traits_json     TEXT DEFAULT '[]',
    interests_json  TEXT DEFAULT '[]',
    summary         TEXT,
    message_count   INTEGER DEFAULT 0,
    first_seen      INTEGER DEFAULT (unixepoch()),
    last_seen       INTEGER,
    updated_at      INTEGER DEFAULT (unixepoch())
);

-- ============================================================
-- NICKNAMES
-- ============================================================
CREATE TABLE IF NOT EXISTS nicknames (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    person_jid      TEXT NOT NULL REFERENCES people(jid),
    nickname        TEXT NOT NULL,
    group_jid       TEXT REFERENCES groups(jid),
    used_by         TEXT,
    confidence      REAL DEFAULT 0.5,
    source          TEXT,
    use_count       INTEGER DEFAULT 1,
    first_seen      INTEGER DEFAULT (unixepoch()),
    last_used       INTEGER,
    UNIQUE(person_jid, nickname, group_jid)
);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    group_jid       TEXT NOT NULL,
    sender_jid      TEXT NOT NULL,
    sender_name     TEXT,
    content         TEXT,
    message_type    TEXT DEFAULT 'text',
    quoted_id       TEXT,
    quoted_content  TEXT,
    quoted_participant TEXT,
    is_from_self    INTEGER DEFAULT 0,
    timestamp       INTEGER NOT NULL,
    metadata_json   TEXT DEFAULT '{}',
    created_at      INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_msg_group_ts ON messages(group_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_jid, timestamp DESC);

-- ============================================================
-- RELATIONSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS relationships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    person_a_jid    TEXT NOT NULL REFERENCES people(jid),
    person_b_jid    TEXT NOT NULL REFERENCES people(jid),
    relationship    TEXT,
    dynamic         TEXT,
    strength        REAL DEFAULT 0.5,
    group_jid       TEXT REFERENCES groups(jid),
    updated_at      INTEGER DEFAULT (unixepoch()),
    UNIQUE(person_a_jid, person_b_jid, group_jid)
);

-- ============================================================
-- GROUP MEMBERSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS group_members (
    group_jid       TEXT NOT NULL REFERENCES groups(jid),
    person_jid      TEXT NOT NULL REFERENCES people(jid),
    role            TEXT DEFAULT 'member',
    joined_at       INTEGER,
    PRIMARY KEY (group_jid, person_jid)
);

-- ============================================================
-- MEMORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT NOT NULL,
    subject_jid     TEXT,
    group_jid       TEXT,
    content         TEXT NOT NULL,
    importance      REAL DEFAULT 0.5,
    recall_count    INTEGER DEFAULT 0,
    created_at      INTEGER DEFAULT (unixepoch()),
    expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(subject_jid, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_group ON memories(group_jid, importance DESC);

-- ============================================================
-- TOPICS
-- ============================================================
CREATE TABLE IF NOT EXISTS topics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid       TEXT NOT NULL,
    topic           TEXT NOT NULL,
    started_at      INTEGER,
    last_active     INTEGER,
    message_count   INTEGER DEFAULT 1,
    is_active       INTEGER DEFAULT 1
);

-- ============================================================
-- SLANG — learned group vocabulary
-- ============================================================
CREATE TABLE IF NOT EXISTS slang (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    term            TEXT NOT NULL,
    meaning         TEXT,
    group_jid       TEXT,
    example         TEXT,
    use_count       INTEGER DEFAULT 1,
    first_seen      INTEGER DEFAULT (unixepoch()),
    UNIQUE(term, group_jid)
);

-- ============================================================
-- FULL TEXT SEARCH on messages
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS msg_fts_insert AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Update FTS when content is modified (e.g. background media description)
CREATE TRIGGER IF NOT EXISTS msg_fts_update AFTER UPDATE OF content ON messages
WHEN NEW.content IS NOT NULL
BEGIN
    DELETE FROM messages_fts WHERE rowid = OLD.rowid;
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- ============================================================
-- RESPONSE LOG — for tuning the decision engine
-- ============================================================
CREATE TABLE IF NOT EXISTS response_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      TEXT,
    group_jid       TEXT,
    score           REAL,
    decided         TEXT,
    factors_json    TEXT,
    response_time_ms INTEGER,
    created_at      INTEGER DEFAULT (unixepoch())
);

-- ============================================================
-- RESPONSE QUALITY — quality gate scores + user feedback
-- ============================================================
CREATE TABLE IF NOT EXISTS response_quality (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         TEXT UNIQUE,
    group_jid          TEXT NOT NULL,
    response_text      TEXT,
    trigger_msg_id     TEXT,
    quality_score      REAL,
    quality_reason     TEXT,
    quality_latency_ms INTEGER,
    user_reactions     TEXT DEFAULT '[]',
    reaction_count     INTEGER DEFAULT 0,
    positive_reactions INTEGER DEFAULT 0,
    negative_reactions INTEGER DEFAULT 0,
    was_gated          INTEGER DEFAULT 0,
    created_at         INTEGER DEFAULT (unixepoch()),
    updated_at         INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_rq_group ON response_quality(group_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rq_score ON response_quality(quality_score);

-- ============================================================
-- BILL SPLITS — parsed bills and split flow state
-- ============================================================
CREATE TABLE IF NOT EXISTS bill_splits (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid               TEXT NOT NULL,
    image_msg_id            TEXT,
    restaurant              TEXT,
    bill_json               TEXT NOT NULL,
    people_json             TEXT DEFAULT '[]',
    assignments_json        TEXT DEFAULT '[]',
    state                   TEXT DEFAULT 'PARSED',
    initiator_jid           TEXT,
    participant_jids_json   TEXT DEFAULT '[]',
    created_at              INTEGER DEFAULT (unixepoch()),
    updated_at              INTEGER DEFAULT (unixepoch()),
    completed_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bs_group_state ON bill_splits(group_jid, state);
CREATE INDEX IF NOT EXISTS idx_bs_image ON bill_splits(image_msg_id);

-- ============================================================
-- MUTED GROUPS — dashboard-driven blacklist
-- ============================================================
CREATE TABLE IF NOT EXISTS muted_groups (
    jid         TEXT PRIMARY KEY,
    muted_until INTEGER,             -- NULL = indefinite, else unixepoch cutoff
    reason      TEXT,
    muted_at    INTEGER DEFAULT (unixepoch())
);

-- ============================================================
-- IMITATE MODE — per-group active impersonation target
-- ============================================================
CREATE TABLE IF NOT EXISTS group_imitation (
    group_jid    TEXT PRIMARY KEY,     -- one active target per group
    target_jid   TEXT NOT NULL,        -- the impersonated member (people.jid)
    target_label TEXT,                 -- snapshot display label for UI/audit
    active_until INTEGER NOT NULL,     -- unixepoch cutoff; ALWAYS set (safety expiry)
    enabled_by   TEXT,
    reason       TEXT,
    enabled_at   INTEGER DEFAULT (unixepoch()),
    use_voice        INTEGER DEFAULT 0,  -- 1 = voice notes in the target's enrolled cloned voice
    voice_notes_sent INTEGER DEFAULT 0   -- cloned notes sent this activation (per-session cap)
);

-- ============================================================
-- PERSON VOICE — cloned voices for imitate-voice (Voice Replication)
-- Created only from the person's own sample + consent recording; the
-- recordings themselves are never stored, only Google's voice id.
-- ============================================================
CREATE TABLE IF NOT EXISTS person_voice (
    person_jid     TEXT PRIMARY KEY,
    voice_id       TEXT NOT NULL,        -- voice_… in the Gemini project
    language_code  TEXT,
    consent_ref    TEXT,                 -- WA message id of the consent note, or dashboard upload ref
    enrolled_via   TEXT,                 -- 'dm' | 'dashboard'
    expire_time    INTEGER,              -- unixepoch; Google keeps stored voices 1 year
    created_at     INTEGER DEFAULT (unixepoch()),
    revoked_at     INTEGER,
    revoke_reason  TEXT
);

-- ============================================================
-- PERSON STYLE CARDS — optional LLM voice descriptor for imitate mode
-- ============================================================
CREATE TABLE IF NOT EXISTS person_style_card (
    person_jid             TEXT NOT NULL,
    group_jid              TEXT NOT NULL,
    card_json              TEXT,
    voice_descriptor       TEXT,
    model                  TEXT,          -- generation model at build time (fallback-corruption diagnosable)
    built_at               INTEGER DEFAULT (unixepoch()),
    message_count_at_build INTEGER,
    PRIMARY KEY (person_jid, group_jid)
);

-- ============================================================
-- DASHBOARD AUDIT — every write from the dashboard
-- ============================================================
CREATE TABLE IF NOT EXISTS dashboard_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER DEFAULT (unixepoch()),
    actor        TEXT,
    action       TEXT NOT NULL,
    target       TEXT,
    payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON dashboard_audit(ts DESC);

-- ============================================================
-- PHONE CALLS — cellular calls bridged to Gemini Live (src/calls/)
-- ============================================================
-- context: 'dm' (1:1 chat context of person_jid), 'group' (group_jid's context),
-- 'unknown' (inbound from a number that maps to nobody).
CREATE TABLE IF NOT EXISTS calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    direction     TEXT NOT NULL,               -- 'inbound' | 'outbound'
    context       TEXT NOT NULL,               -- 'dm' | 'group' | 'unknown'
    person_jid    TEXT,
    group_jid     TEXT,
    phone         TEXT,                        -- E.164 of the other party
    status        TEXT NOT NULL DEFAULT 'dialing', -- dialing|ringing|active|ended|failed|missed
    end_reason    TEXT,
    model         TEXT,
    started_at    INTEGER DEFAULT (unixepoch()),
    answered_at   INTEGER,
    ended_at      INTEGER,
    summary       TEXT,
    initiated_by  TEXT                         -- dashboard user for outbound
);
CREATE INDEX IF NOT EXISTS idx_calls_person ON calls(person_jid, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_group ON calls(group_jid, started_at DESC);

CREATE TABLE IF NOT EXISTS call_transcript (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id   INTEGER NOT NULL REFERENCES calls(id),
    speaker   TEXT NOT NULL,                   -- 'them' | 'bot'
    text      TEXT NOT NULL,
    ts        INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_call_transcript ON call_transcript(call_id, id);

-- ============================================================
-- INSTAGRAM REELS — browsing sessions on the Instagram phone (src/instagram/, specs/005)
-- ============================================================
CREATE TABLE IF NOT EXISTS ig_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_kind  TEXT NOT NULL,               -- 'auto' | 'manual'
    initiated_by  TEXT,                        -- dashboard user for manual
    allow_share   INTEGER DEFAULT 0,
    planned_min   REAL,
    started_at    INTEGER DEFAULT (unixepoch()),
    ended_at      INTEGER,
    end_reason    TEXT,
    seen          INTEGER DEFAULT 0,
    liked         INTEGER DEFAULT 0,
    queued        INTEGER DEFAULT 0,
    shared        INTEGER DEFAULT 0,
    cost_usd      REAL DEFAULT 0,
    live_tokens   INTEGER                      -- Gemini Live context tokens at the end (watch mode 'live')
);

-- One row per reel seen. description_depth: 'first_look' / 'full_live' (Gemini Live, with audio),
-- 'full' (recorded clip + audio) | 'quick' (one screenshot).
-- action: 'skip' | 'like' | 'like_and_queue'. user_label: 1 (good call) | -1 (bad call).
CREATE TABLE IF NOT EXISTS ig_reels (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         INTEGER REFERENCES ig_sessions(id),
    shortcode          TEXT,
    url                TEXT,
    account            TEXT,
    caption            TEXT,
    audio              TEXT,
    like_count         TEXT,
    description        TEXT,
    description_depth  TEXT,
    language           TEXT,
    humour_type        TEXT,
    dwell_ms           INTEGER,
    jev_model          TEXT,
    jev_answers        TEXT,                   -- JSON: raw answers (quick + full)
    humour             REAL,
    fit                REAL,
    confidence         REAL,
    hazards            TEXT,                   -- JSON array
    for_whom           TEXT,
    action             TEXT,
    reason             TEXT,
    comments           TEXT,                   -- JSON array of top comments (untrusted, sanitized)
    liked              INTEGER DEFAULT 0,
    queued             INTEGER DEFAULT 0,
    saved              INTEGER DEFAULT 0,      -- saved in Instagram (how a queued reel is found again)
    share_state        TEXT,                   -- null|queued|approved|sending|sent|vetoed|failed
    share_caption      TEXT,
    share_error        TEXT,
    approved_by        TEXT,
    shared_at          INTEGER,
    user_label         INTEGER,
    thumb_path         TEXT,
    cost_usd           REAL DEFAULT 0,
    created_at         INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ig_reels_created ON ig_reels(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_reels_session ON ig_reels(session_id);
CREATE INDEX IF NOT EXISTS idx_ig_reels_share ON ig_reels(share_state);

CREATE VIRTUAL TABLE IF NOT EXISTS ig_reels_fts USING fts5(account, caption, description);

CREATE TRIGGER IF NOT EXISTS ig_reels_fts_insert AFTER INSERT ON ig_reels
BEGIN
    INSERT INTO ig_reels_fts(rowid, account, caption, description)
    VALUES (NEW.id, COALESCE(NEW.account, ''), COALESCE(NEW.caption, ''), COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS ig_reels_fts_update AFTER UPDATE OF account, caption, description ON ig_reels
BEGIN
    DELETE FROM ig_reels_fts WHERE rowid = OLD.id;
    INSERT INTO ig_reels_fts(rowid, account, caption, description)
    VALUES (NEW.id, COALESCE(NEW.account, ''), COALESCE(NEW.caption, ''), COALESCE(NEW.description, ''));
END;

-- Every command sent to the Instagram phone (src/instagram/device.js), for the dashboard
-- Device log. Pruned to 14 days by maintenance.
CREATE TABLE IF NOT EXISTS ig_device_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,              -- ms epoch
    op          TEXT NOT NULL,
    args        TEXT,
    foreground  TEXT,
    ok          INTEGER NOT NULL,
    ms          INTEGER,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ig_device_log_ts ON ig_device_log(ts DESC);

-- Members of the Instagram group (read from its People screen). person_jid links an
-- Instagram member to their WhatsApp profile (people.jid) — set on the dashboard.
CREATE TABLE IF NOT EXISTS ig_members (
    username      TEXT PRIMARY KEY,
    display_name  TEXT,
    is_self       INTEGER DEFAULT 0,
    is_admin      INTEGER DEFAULT 0,
    person_jid    TEXT,
    linked_by     TEXT,
    in_group      INTEGER DEFAULT 1,
    last_seen_at  INTEGER DEFAULT (unixepoch())
);

-- The Instagram group thread as the bot read it. msg_key = sender|kind|text (see
-- screens.messageKey); occurrence disambiguates repeats. kind: 'text' | 'reel'.
-- bot_action: what the bot did about it (null | 'replied' | 'reacted' | 'ignored' | 'watched').
CREATE TABLE IF NOT EXISTS ig_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_key          TEXT NOT NULL,
    occurrence       INTEGER NOT NULL DEFAULT 1,
    from_me          INTEGER NOT NULL DEFAULT 0,
    sender           TEXT,                     -- username or display name as shown
    kind             TEXT NOT NULL,
    text             TEXT,
    reel_account     TEXT,
    reel_description TEXT,
    reply_to_me      INTEGER DEFAULT 0,
    bot_action       TEXT,
    bot_reply_id     INTEGER,                  -- ig_messages.id of the bot's reply
    jev_answers      TEXT,
    seen_at          INTEGER DEFAULT (unixepoch()),
    UNIQUE (msg_key, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_ig_messages_seen ON ig_messages(id DESC);
