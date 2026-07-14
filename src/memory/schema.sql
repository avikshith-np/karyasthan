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
