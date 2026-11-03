// Usage ledger + Jev pre-filter log (spec 007 R13, data model in its plan.md).
// Purely additive and idempotent (CREATE … IF NOT EXISTS); no chat content and no
// keys are stored in either table.
//
// v7 on spec 006's ladder (registered in ./index.js). The live database reached v6
// without these tables, and a v6 database may already carry them from a pre-merge
// build of 007 that created them outside the ladder — so every statement stays
// IF NOT EXISTS.

export const LLM_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS llm_usage (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL DEFAULT (unixepoch()),
  role               TEXT    NOT NULL,           -- role or metered label
  provider           TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER,                    -- uncached input
  output_tokens      INTEGER,                    -- incl. reasoning/thinking when reported
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,                       -- NULL when unpriced
  cost_source        TEXT    NOT NULL CHECK (cost_source IN ('provider','table','unknown')),
  latency_ms         INTEGER,
  fell_back          INTEGER NOT NULL DEFAULT 0,
  ok                 INTEGER NOT NULL DEFAULT 1, -- 0 = link failed (HTTP error, empty, refusal, timeout)
  status             TEXT,                       -- 'ok' | 'http_<code>' | 'empty' | 'refusal' | 'timeout' | 'error' | 'no_key' | 'budget'
  caller             TEXT                        -- e.g. 'reply', 'batch', 'gate', 'ig.judge', 'transcribe'
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts   ON llm_usage(ts);
CREATE INDEX IF NOT EXISTS idx_llm_usage_role ON llm_usage(role, ts);

CREATE TABLE IF NOT EXISTS prefilter_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL DEFAULT (unixepoch()),
  message_id  TEXT,
  group_jid   TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('shadow','enforce')),
  p_reply     REAL,
  choice      TEXT,                              -- 'reply' | 'stay_silent' | NULL on error
  confidence  REAL,
  llm_outcome TEXT,                              -- 'reply' | 'skip' | 'error' | 'not_run'
  acted       INTEGER NOT NULL DEFAULT 0,        -- 1 = enforce skipped generation
  jev_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prefilter_ts ON prefilter_log(ts);
`;

export default {
  version: 7,
  name: 'llm-usage',
  up(db) {
    db.exec(LLM_USAGE_SQL);
  },
};
