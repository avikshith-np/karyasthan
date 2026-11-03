// Mind store (spec 008, contracts/mind-api.md "Store API", data-model.md v10) —
// the ONLY door to the mind_* tables. Every function is synchronous
// (better-sqlite3), uses parameterised SQL only, and takes/returns plain objects:
// rows come back camelCase with every *_json column parsed (threads_json → threads,
// origins_json → origins, …). Column names never come from callers: each write
// maps its keys through a per-table allow-list, and an unknown key throws.
//
// Owner-only settings (pause, proactive/review mode, bands, exclusions, exclude-all)
// are written only through the `owner` namespace below, which only src/mind/index.js
// imports (and only routes/mind.js reaches, via the facade; a static test checks
// both). The only system writes to mind_settings are seedDefaults (first boot),
// initFirstLive (once), setLastAutoApply, addJevClearedOptOut (message ids Jev
// cleared, for the opt-out lookback) and setDegraded (the hooks' durable marker).
//
// This module reads two non-mind tables directly: `messages` / `world_events` (MAX
// cursors only, seedCursorsToMax) and `item_evidence` rows of item_type
// 'mind_digest' (the digests' own evidence). It never reads or writes the 006
// provenance tables (memories, nicknames, relationships, person_facets, slang).
//
// Times are unix seconds from the store clock (setStoreClock; src/mind/clock.js
// wires it), or from the explicit `now`/timestamps a caller passes. Nothing here
// logs chat- or model-derived text (plan review S1-13).

import { getDb } from '../memory/db.js';
import { config } from '../utils/config.js';
import { chatKeyOf } from '../memory/learningPipeline.js';

// ── clock ────────────────────────────────────────────────────────────────────

let nowFn = () => Math.floor(Date.now() / 1000);

/** Point the store at the mind clock (or a test's fake clock). fn() → unix seconds. */
export function setStoreClock(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Math.floor(Date.now() / 1000);
}
const nowSec = () => Math.floor(nowFn());

const DAY = 86400;

// Local YYYY-MM-DD in config.timezone (data-model "day_key"). Kept local so the
// store has no dependency on the wave-1 clock module; clock.dayKey must agree.
let dateFmt = null;
let dateFmtTz = null;
export function localDateKey(t) {
  const tz = config.timezone || 'UTC';
  if (!dateFmt || dateFmtTz !== tz) {
    try {
      dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    dateFmtTz = tz;
  }
  return dateFmt.format(new Date(Math.floor(t) * 1000));
}

// ── enums (data-model.md) ────────────────────────────────────────────────────

export const RUN_KINDS = ['pulse', 'glance', 'think', 'sleep', 'selfmodel', 'draft', 'digest'];
export const RUN_TRIGGERS = ['tick', 'glance', 'anchor', 'scheduled', 'owner', 'catchup', 'night'];
// 'running' is the interim status between insertRun and finishRun (stale ones are
// failed by retention); the rest are the final statuses of data-model.md.
export const RUN_STATUSES = ['running', 'ok', 'skipped', 'invalid', 'failed', 'partial'];
export const SKIP_REASONS = ['budget', 'global_cap', 'unpriced', 'no_key', 'disabled', 'paused', 'cap', 'gap',
  'nothing_new', 'asleep', 'not_initialised', 'error'];
export const NIGHT_STATUSES = ['running', 'done', 'failed', 'missed'];
export const NIGHT_PARTIALS = ['budget', 'no_key', 'global_cap', 'fell_back'];
export const TONES = ['neutral', 'warm', 'playful', 'tense', 'sad', 'busy'];
export const EPISODE_OUTCOMES = ['written', 'null', 'tombstoned', 'capped', 'deleted', 'fenced'];
export const EPISODE_CAUSES = ['forget', 'revoke', 'edit', 'purge', 'retention'];
export const ELEMENT_KINDS = ['mood', 'base_mood', 'today', 'intention'];
export const ELEMENT_STATUSES = ['active', 'expired', 'done', 'superseded'];
export const INTENTION_KINDS = ['follow_up', 'check_in', 'share', 'wind_down', 'be_present', 'keep_quiet', 'catch_up'];
export const SELF_MODEL_SOURCES = ['seed', 'owner', 'mind'];
export const SELF_MODEL_STATUSES = ['proposed', 'approved', 'rejected', 'active', 'superseded', 'invalid'];
export const KNOBS = ['responseRate', 'groupResponseRate', 'reactTendency', 'replyLength', 'proactiveAppetite'];
export const NUDGE_STATUSES = ['active', 'expired', 'reverted', 'overridden', 'replaced', 'refused', 'clamped'];
export const NUDGE_REFUSALS = ['not_allowed', 'bad_scope', 'cooldown', 'too_many', 'no_change', 'fell_back'];
export const DRAFT_KINDS = ['follow_up', 'check_in', 'share'];
export const DRAFT_MODES = ['shadow', 'live'];
export const DRAFT_STATUSES = ['drafting', 'shadow', 'would_send', 'queued', 'sent', 'dry_run', 'send_failed', 'dropped',
  'cancelled', 'expired'];
// Pending rows can still change or be dispatched; every other status is terminal.
export const DRAFT_PENDING = ['drafting', 'queued'];
// Rows that count toward caps and back-off (proactive.md A5/A6).
export const DRAFT_COUNTED = ['sent', 'dry_run', 'send_failed', 'would_send', 'queued'];
export const EXCLUSION_KINDS = ['person', 'group'];
export const EXCLUSION_SOURCES = ['owner', 'detected', 'owner_cleared'];

// Settings keys. OWNER_SETTINGS may only be written through owner.setSetting.
const OWNER_SETTINGS = {
  paused: 'bool',
  paused_at: 'time?',
  proactive_mode: ['off', 'shadow', 'live'],
  proactive_mode_since: 'time?',
  review_mode: ['window', 'review', 'auto'],
  review_until: 'time?',
  exclude_all: 'bool',
  bands: 'object?',
};
export const OWNER_SETTING_KEYS = Object.keys(OWNER_SETTINGS);
export const SYSTEM_SETTING_KEYS = ['first_enabled_at', 'last_auto_apply_at', 'stance_cursor', 'stance_cursor_at', 'stance_last_night', 'stance_exclusion_sig', 'stance_free_night'];

// ── small helpers ────────────────────────────────────────────────────────────

const marks = (n) => Array(n).fill('?').join(',');
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function asList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x);
}

function clampLimit(limit, def, max) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

// Column specs per table: { col: { t, max?, values?, required? } }.
//   t: 'int' | 'real' | 'bool' | 'text' | 'enum' | 'json' (object/array) | 'jsonList'
//      (array, trimmed from the end to fit) | 'scalar' (any JSON scalar, stored JSON-encoded)
const SPECS = {
  mind_state: {
    last_rowid: { t: 'int' }, last_event_id: { t: 'int' }, last_tick_at: { t: 'int' }, last_glance_at: { t: 'int' },
    last_think_at: { t: 'int' }, last_sleep_at: { t: 'int' }, last_weekly_at: { t: 'int' }, next_think_at: { t: 'int' },
  },
  mind_runs: {
    kind: { t: 'enum', values: RUN_KINDS, required: true },
    trigger: { t: 'enum', values: RUN_TRIGGERS },
    trigger_ref: { t: 'text', max: 80 },
    day_key: { t: 'text', max: 10 },
    night_key: { t: 'text', max: 10 },
    started_at: { t: 'int' }, finished_at: { t: 'int' },
    status: { t: 'enum', values: RUN_STATUSES },
    skip_reason: { t: 'enum', values: SKIP_REASONS },
    fell_back: { t: 'bool' }, degraded: { t: 'bool' },
    input_json: { t: 'json', max: 4096 },
    output_json: { t: 'json', max: 16384 },
    dropped_json: { t: 'jsonList', max: 4096 },
    model: { t: 'text', max: 120 },
    tokens_in: { t: 'int' }, tokens_out: { t: 'int' }, cache_read: { t: 'int' },
    cost_usd: { t: 'real' },
    error: { t: 'text', max: 300 },
  },
  mind_nights: {
    status: { t: 'enum', values: NIGHT_STATUSES },
    partial: { t: 'enum', values: NIGHT_PARTIALS },
    selfmodel_run_id: { t: 'int' }, attempts: { t: 'int' }, episodes: { t: 'int' }, run_id: { t: 'int' },
    started_at: { t: 'int' }, finished_at: { t: 'int' },
  },
  mind_digests: {
    chat_jid: { t: 'text', max: 200, required: true },
    origin_kind: { t: 'enum', values: ['group', 'dm'], required: true },
    from_rowid: { t: 'int', required: true }, to_rowid: { t: 'int', required: true },
    period_start: { t: 'int', required: true }, period_end: { t: 'int', required: true },
    summary: { t: 'text', max: 400, required: true },
    today_note: { t: 'text', max: 80 },
    tone: { t: 'enum', values: TONES, required: true },
    threads_json: { t: 'jsonList', max: 4096 },
    model: { t: 'text', max: 120 },
    run_id: { t: 'int' },
    created_at: { t: 'int' },
  },
  mind_episode_cursor: {
    last_rowid: { t: 'int' }, digest_rowid: { t: 'int' }, last_night_key: { t: 'text', max: 10 },
  },
  mind_episode_log: {
    outcome: { t: 'enum', values: EPISODE_OUTCOMES, required: true },
    memory_id: { t: 'int' },
    cause: { t: 'enum', values: EPISODE_CAUSES },
    rebuild_requested: { t: 'bool' },
  },
  mind_self_state: {
    kind: { t: 'enum', values: ELEMENT_KINDS, required: true },
    word: { t: 'text', max: 20 },
    intensity: { t: 'real' },
    intention_kind: { t: 'enum', values: INTENTION_KINDS },
    target_chat: { t: 'text', max: 200 },
    basis_json: { t: 'jsonList', max: 2048 },
    origins_json: { t: 'jsonList', max: 4096 },
    created_at: { t: 'int' },
    expires_at: { t: 'int', required: true },
    status: { t: 'enum', values: ELEMENT_STATUSES },
    run_id: { t: 'int' },
  },
  mind_self_model: {
    version: { t: 'int' },
    text: { t: 'text', max: 1500 },
    source: { t: 'enum', values: SELF_MODEL_SOURCES, required: true },
    status: { t: 'enum', values: SELF_MODEL_STATUSES, required: true },
    base_version: { t: 'int' },
    diff_json: { t: 'jsonList', max: 16384 },
    changes_summary: { t: 'text', max: 200 },
    rationale: { t: 'text', max: 400 },
    scrub_json: { t: 'json', max: 4096 },
    run_id: { t: 'int' },
    created_at: { t: 'int' }, decided_at: { t: 'int' }, activated_at: { t: 'int' },
    decided_by: { t: 'text', max: 100 },
  },
  mind_nudges: {
    knob: { t: 'enum', values: KNOBS, required: true },
    scope: { t: 'text', max: 200, required: true },
    prev_value: { t: 'scalar', required: true },
    value: { t: 'scalar', required: true },
    requested: { t: 'scalar', required: true },
    band_json: { t: 'json', max: 1024, required: true },
    reason: { t: 'text', max: 160 },
    status: { t: 'enum', values: NUDGE_STATUSES, required: true },
    active: { t: 'bool' },
    refuse_reason: { t: 'enum', values: NUDGE_REFUSALS },
    run_id: { t: 'int' },
    created_at: { t: 'int' }, expires_at: { t: 'int' }, ended_at: { t: 'int' },
    ended_by: { t: 'text', max: 100 },
  },
  mind_proactive: {
    chat_jid: { t: 'text', max: 200, required: true },
    chat_kind: { t: 'enum', values: ['group', 'dm'], required: true },
    person_jid: { t: 'text', max: 200 },
    send_jid: { t: 'text', max: 200 },
    audience_json: { t: 'json', max: 16384 },
    kind: { t: 'enum', values: DRAFT_KINDS, required: true },
    urgency: { t: 'real' },
    reason: { t: 'text', max: 160 },
    basis_json: { t: 'jsonList', max: 2048, required: true },
    origins_json: { t: 'jsonList', max: 4096, required: true },
    intent: { t: 'text', max: 200 },
    voiced_text: { t: 'text', max: 1000 },
    alt_text: { t: 'text', max: 1000 },
    alt_model: { t: 'text', max: 120 },
    gate_score: { t: 'real' },
    gate_reason: { t: 'text', max: 200 },
    mode: { t: 'enum', values: DRAFT_MODES, required: true },
    status: { t: 'enum', values: DRAFT_STATUSES, required: true },
    drop_reason: { t: 'text', max: 40 },
    run_id: { t: 'int' },
    created_at: { t: 'int' }, send_after: { t: 'int' }, sent_at: { t: 'int' },
    msg_id: { t: 'text', max: 200 },
    replied_at: { t: 'int' },
  },
  mind_exclusions: {},
};

// Caller key → column, for one table: snake_case, camelCase, and for *_json columns
// also the bare name (`threads`, `origins`, …) for the parsed value.
const KEY_MAPS = Object.fromEntries(Object.entries(SPECS).map(([table, spec]) => {
  const map = {};
  for (const col of Object.keys(spec)) {
    map[col] = col;
    map[camel(col)] = col;
    if (col.endsWith('_json')) map[camel(col.slice(0, -5))] = col;
  }
  return [table, map];
}));

function fitJson(value, max, list) {
  if (value == null) return null;
  let v = value;
  if (typeof v === 'string') {
    v = parseJson(v, undefined);
    if (v === undefined) throw new TypeError('store: JSON column given an unparsable string');
  }
  if (list && !Array.isArray(v)) throw new TypeError('store: list column expects an array');
  if (!list && typeof v !== 'object') throw new TypeError('store: JSON column expects an object or array');
  let s = JSON.stringify(v);
  if (s.length <= max) return s;
  if (Array.isArray(v)) {
    const arr = [...v];
    while (arr.length && s.length > max) { arr.pop(); s = JSON.stringify(arr); }
    return s;
  }
  return JSON.stringify({ _truncated: true, bytes: s.length });
}

function encodeValue(col, spec, value) {
  if (value === undefined) return undefined;
  if (value === null) {
    if (spec.required) throw new TypeError(`store: ${col} is required`);
    return null;
  }
  switch (spec.t) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new TypeError(`store: ${col} must be a finite number`);
      return Math.floor(n);
    }
    case 'real': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new TypeError(`store: ${col} must be a finite number`);
      return n;
    }
    case 'bool': return value ? 1 : 0;
    case 'text': return String(value).slice(0, spec.max ?? 1000);
    case 'enum':
      if (!spec.values.includes(value)) throw new TypeError(`store: ${col} must be one of ${spec.values.join('|')}`);
      return value;
    case 'json': return fitJson(value, spec.max ?? 4096, false);
    case 'jsonList': return fitJson(value, spec.max ?? 4096, true);
    case 'scalar': {
      if (value !== null && typeof value === 'object') throw new TypeError(`store: ${col} must be a JSON scalar`);
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`store: ${col} must be finite`);
      return JSON.stringify(value);
    }
    default: throw new TypeError(`store: unknown column type for ${col}`);
  }
}

/** Map a caller object onto allow-listed columns. Unknown keys throw. */
function encode(table, fields, { omit = [] } = {}) {
  const spec = SPECS[table];
  const map = KEY_MAPS[table];
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const col = map[k];
    if (!col || omit.includes(col)) throw new TypeError(`store: ${table} has no writable field "${k}"`);
    const enc = encodeValue(col, spec[col], v);
    if (enc !== undefined) out[col] = enc;
  }
  return out;
}

function requireCols(table, cols) {
  for (const [col, spec] of Object.entries(SPECS[table])) {
    if (spec.required && (cols[col] === undefined || cols[col] === null)) throw new TypeError(`store: ${table}.${col} is required`);
  }
}

const BOOL_COLS = new Set(['fell_back', 'degraded', 'rebuild_requested', 'active']);
const SCALAR_COLS = new Set(['prev_value', 'value', 'requested']);

/** A DB row → camelCase, *_json parsed (key without the suffix), bools as booleans. */
function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [col, v] of Object.entries(row)) {
    if (col.endsWith('_json')) out[camel(col.slice(0, -5))] = parseJson(v, null);
    else if (BOOL_COLS.has(col)) out[camel(col)] = !!v;
    else if (SCALAR_COLS.has(col)) out[camel(col)] = parseJson(v, null);
    else out[camel(col)] = v;
  }
  return out;
}
const decodeAll = (rows) => rows.map(decode);

function insertRow(db, table, cols) {
  const names = Object.keys(cols);
  const info = db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${marks(names.length)})`)
    .run(...names.map(n => cols[n]));
  return Number(info.lastInsertRowid);
}

function updateById(db, table, id, cols) {
  const names = Object.keys(cols);
  if (!names.length) return 0;
  return db.prepare(`UPDATE ${table} SET ${names.map(n => `${n} = ?`).join(', ')} WHERE id = ?`)
    .run(...names.map(n => cols[n]), id).changes;
}

// ── mind_state ───────────────────────────────────────────────────────────────

const STATE_DEFAULTS = {
  lastRowid: 0, lastEventId: 0, lastTickAt: null, lastGlanceAt: null, lastThinkAt: null, lastSleepAt: null,
  lastWeeklyAt: null, nextThinkAt: null, updatedAt: null,
};

/** The singleton cursors/clocks row (defaults when it was never written). */
export function getState() {
  const row = getDb().prepare('SELECT * FROM mind_state WHERE id = 1').get();
  if (!row) return { ...STATE_DEFAULTS };
  const { id, ...rest } = decode(row);
  return { ...STATE_DEFAULTS, ...rest };
}

/** Set cursors/clocks (allow-listed columns; null clears a clock). Returns the new state. */
export function patchState(fields) {
  const cols = encode('mind_state', fields);
  const names = Object.keys(cols);
  const db = getDb();
  const at = nowSec();
  db.prepare(`INSERT INTO mind_state (id, ${[...names, 'updated_at'].join(', ')}) VALUES (1, ${marks(names.length + 1)})
    ON CONFLICT(id) DO UPDATE SET ${[...names, 'updated_at'].map(n => `${n} = excluded.${n}`).join(', ')}`)
    .run(...names.map(n => cols[n]), at);
  return getState();
}

// ── mind_settings ────────────────────────────────────────────────────────────

function rawSetting(db, key) {
  return db.prepare('SELECT value, updated_at, updated_by FROM mind_settings WHERE key = ?').get(key) || null;
}

function writeSetting(db, key, value, by) {
  db.prepare(`INSERT INTO mind_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(key, JSON.stringify(value), nowSec(), by);
}

const UNPARSABLE = Symbol('unparsable');
function settingValue(db, key) {
  const row = rawSetting(db, key);
  if (!row) return undefined;
  const v = parseJson(row.value, UNPARSABLE);
  return v;
}

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Every setting, normalised and fail closed:
 *   paused / excludeAll: missing → false, unparsable → true;
 *   proactiveMode: missing → the .env seed (off|shadow), invalid → 'off';
 *   reviewMode: missing/invalid → 'review', and 'window' without a finite
 *   reviewUntil → 'review' (research R13: `now >= null` would auto-apply).
 */
export function getSettings() {
  const db = getDb();
  const get = (k) => settingValue(db, k);
  const boolOf = (v) => (v === undefined ? false : v === UNPARSABLE ? true : v === true);
  const paused = boolOf(get('paused'));
  const excludeAll = boolOf(get('exclude_all'));
  const pm = get('proactive_mode');
  const proactiveMode = pm === undefined ? config.mind.proactiveMode
    : (OWNER_SETTINGS.proactive_mode.includes(pm) ? pm : 'off');
  const reviewUntil = finiteOrNull(get('review_until'));
  const rm = get('review_mode');
  let reviewMode = OWNER_SETTINGS.review_mode.includes(rm) ? rm : 'review';
  if (reviewMode === 'window' && reviewUntil === null) reviewMode = 'review';
  const bands = get('bands');
  return {
    paused,
    pausedAt: finiteOrNull(get('paused_at')),
    proactiveMode,
    proactiveModeSince: finiteOrNull(get('proactive_mode_since')),
    reviewMode,
    reviewUntil,
    firstEnabledAt: finiteOrNull(get('first_enabled_at')),
    lastAutoApplyAt: finiteOrNull(get('last_auto_apply_at')),
    excludeAll,
    bands: isObj(bands) ? bands : null,
  };
}

const SETTING_FIELD = {
  paused: 'paused', paused_at: 'pausedAt', proactive_mode: 'proactiveMode', proactive_mode_since: 'proactiveModeSince',
  review_mode: 'reviewMode', review_until: 'reviewUntil', first_enabled_at: 'firstEnabledAt',
  last_auto_apply_at: 'lastAutoApplyAt', exclude_all: 'excludeAll', bands: 'bands',
};

/**
 * One setting by its DB key. Known keys return the normalised value of
 * getSettings() (so review_mode is never missing); unknown keys return the parsed
 * value or `fallback`.
 */
export function getSetting(key, fallback = null) {
  if (SETTING_FIELD[key]) {
    const v = getSettings()[SETTING_FIELD[key]];
    return v === null || v === undefined ? fallback : v;
  }
  const v = settingValue(getDb(), key);
  return v === undefined || v === UNPARSABLE ? fallback : v;
}

/** Effective review state at `now`: auto-apply is active only in 'auto' or after a finite window. */
export function reviewState(now = nowSec()) {
  const s = getSettings();
  const autoActive = s.reviewMode === 'auto'
    || (s.reviewMode === 'window' && Number.isFinite(s.reviewUntil) && now >= s.reviewUntil);
  return { mode: s.reviewMode, until: s.reviewUntil, autoActive, firstEnabledAt: s.firstEnabledAt };
}

/**
 * First-boot seed (system): the proactive mode from .env (off|shadow only), written
 * once so a later .env edit never changes a mode the owner may have set. Returns
 * true when it wrote.
 */
export function seedDefaults() {
  const db = getDb();
  const mode = config.mind.proactiveMode === 'off' ? 'off' : 'shadow';
  const info = db.prepare(`INSERT OR IGNORE INTO mind_settings (key, value, updated_at, updated_by) VALUES ('proactive_mode', ?, ?, 'system')`)
    .run(JSON.stringify(mode), nowSec());
  return info.changes > 0;
}

/**
 * The lazy first-live initialisation (research R1/R13), once: first_enabled_at,
 * review_until = now + reviewDays, and review_mode = 'window' unless the owner has
 * already chosen a mode. One transaction. Returns true when it initialised, false
 * when first_enabled_at was already set.
 */
export function initFirstLive(now, reviewDays = config.mind.reviewDays) {
  const t = Math.floor(Number(now));
  const days = Math.floor(Number(reviewDays));
  if (!Number.isFinite(t) || !Number.isFinite(days) || days < 0) throw new TypeError('initFirstLive: now and reviewDays required');
  const db = getDb();
  return db.transaction(() => {
    if (rawSetting(db, 'first_enabled_at')) return false;
    writeSetting(db, 'first_enabled_at', t, 'system');
    writeSetting(db, 'review_until', t + days * DAY, 'system');
    const mode = rawSetting(db, 'review_mode');
    const ownerChose = mode && String(mode.updated_by || '').startsWith('owner:')
      && OWNER_SETTINGS.review_mode.includes(parseJson(mode.value, null));
    if (!ownerChose) writeSetting(db, 'review_mode', 'window', 'system');
    return true;
  })();
}

/** System write: the time of the last auto-applied self-model (selfModel.applyProposal only). */
export function setLastAutoApply(now) {
  const t = Math.floor(Number(now));
  if (!Number.isFinite(t)) throw new TypeError('setLastAutoApply: now required');
  writeSetting(getDb(), 'last_auto_apply_at', t, 'system');
}

/**
 * System write: a prefilter hit Jev judged NOT an opt-out (dontText.checkCandidates),
 * so the eligibility lookback does not re-judge it. Message id + a hash of the text
 * Jev judged (never the text): an edit keeps the id but changes the text, and the
 * clearance must not cover the edited line. The newest JEV_CLEARED_MAX kept, older
 * than the 180-day lookback dropped.
 */
export const JEV_CLEARED_MAX = 500;
const TEXT_HASH_RE = /^[0-9a-f]{16,64}$/;
export function addJevClearedOptOut(msgId, ts, now = nowSec(), textHash = null) {
  if (typeof msgId !== 'string' || !msgId || msgId.length > 200) return false;
  if (typeof textHash !== 'string' || !TEXT_HASH_RE.test(textHash)) return false;
  const t = ts != null && Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Math.floor(Number(now));
  const db = getDb();
  return db.transaction(() => {
    const cur = settingValue(db, 'dont_text_jev_cleared');
    const floor = Math.floor(Number(now)) - 180 * DAY;
    const list = (Array.isArray(cur) ? cur : [])
      .filter(e => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && e[1] > floor && e[0] !== msgId);
    list.push([msgId, t, textHash]);
    writeSetting(db, 'dont_text_jev_cleared', list.slice(-JEV_CLEARED_MAX), 'system');
    return true;
  })();
}

/**
 * The message ids Jev cleared → the hash of the text it judged (see addJevClearedOptOut).
 * An entry without a hash (pre-hash rows) is left out, and unreadable → an empty map:
 * the lookback then re-checks those lines (fail closed).
 */
export function jevClearedOptOuts() {
  const cur = settingValue(getDb(), 'dont_text_jev_cleared');
  return new Map((Array.isArray(cur) ? cur : [])
    .filter(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[2] === 'string' && TEXT_HASH_RE.test(e[2]))
    .map(e => [e[0], e[2]]));
}

/** System write: the hooks' degraded marker ({at, source, cause}), or null to clear it. Survives a restart. */
export function setDegraded(info) {
  const db = getDb();
  if (info == null) { db.prepare(`DELETE FROM mind_settings WHERE key = 'degraded'`).run(); return; }
  const at = Math.floor(Number(info.at));
  if (!Number.isFinite(at)) throw new TypeError('setDegraded: at required');
  writeSetting(db, 'degraded', { at, source: String(info.source || 'unknown').slice(0, 40),
    cause: info.cause ? String(info.cause).slice(0, 40) : null }, 'system');
}

/** The stored degraded marker, or null when there is none. A row that can't be read stays degraded (at: null; fail closed). */
export function getDegraded() {
  const v = settingValue(getDb(), 'degraded');
  if (v === undefined) return null;
  return { at: isObj(v) && Number.isFinite(v.at) ? v.at : null, source: isObj(v) && typeof v.source === 'string' ? v.source : 'unknown',
    cause: isObj(v) && typeof v.cause === 'string' ? v.cause : null };
}

function checkOwnerActor(by) {
  if (typeof by !== 'string' || !/^owner:[^\r\n]{1,100}$/.test(by)) throw new TypeError('owner setters need by = "owner:<user>"');
}

function validateOwnerSetting(key, value) {
  const type = OWNER_SETTINGS[key];
  if (!type) throw new TypeError(`"${key}" is not an owner setting`);
  if (Array.isArray(type)) {
    if (!type.includes(value)) throw new TypeError(`${key} must be one of ${type.join('|')}`);
    return value;
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    return value;
  }
  if (type === 'time?') {
    if (value === null) return null;
    const n = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(n) || n < 0) throw new TypeError(`${key} must be a unix time or null`);
    return Math.floor(n);
  }
  if (type === 'object?') {
    if (value === null) return null;
    if (!isObj(value)) throw new TypeError(`${key} must be an object or null`);
    if (JSON.stringify(value).length > 4096) throw new TypeError(`${key} is too large`);
    return value;
  }
  throw new TypeError(`unsupported setting type for ${key}`);
}

// ── mind_runs ────────────────────────────────────────────────────────────────

/** Start a run row. Defaults: started_at = now, day_key = local date, status 'running'. → id */
export function insertRun(row) {
  const cols = encode('mind_runs', row);
  if (cols.started_at === undefined) cols.started_at = nowSec();
  if (!cols.day_key) cols.day_key = localDateKey(cols.started_at);
  if (!cols.status) cols.status = 'running';
  requireCols('mind_runs', cols);
  return insertRow(getDb(), 'mind_runs', cols);
}

/** Finish (or amend) a run. finished_at defaults to now when a final status is set. → changes */
export function finishRun(id, fields) {
  const cols = encode('mind_runs', fields, { omit: ['kind'] });
  if (cols.status && cols.status !== 'running' && cols.finished_at === undefined) cols.finished_at = nowSec();
  return updateById(getDb(), 'mind_runs', id, cols);
}

const RUN_SUMMARY_COLS = `id, kind, trigger, trigger_ref, day_key, night_key, started_at, finished_at, status, skip_reason,
  fell_back, degraded, model, tokens_in, tokens_out, cache_read, cost_usd, error`;

/** Timeline page (newest first, no JSON bodies). q: { kind?, status?, before? (id), limit ≤ 100 } */
export function listRuns(q = {}) {
  const where = [];
  const params = [];
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (Number.isFinite(Number(q.before)) && q.before != null) { where.push('id < ?'); params.push(Math.floor(Number(q.before))); }
  const limit = clampLimit(q.limit, 50, 100);
  return decodeAll(getDb().prepare(`SELECT ${RUN_SUMMARY_COLS} FROM mind_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).all(...params, limit));
}

/** One run with its input/output/dropped JSON. */
export function getRun(id) {
  return decode(getDb().prepare('SELECT * FROM mind_runs WHERE id = ?').get(id));
}

/** Count runs. q: { kind?, dayKey?, status? (string|array), since? (started_at ≥) } */
export function countRuns(q = {}) {
  const where = [];
  const params = [];
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  if (q.dayKey) { where.push('day_key = ?'); params.push(q.dayKey); }
  const statuses = asList(q.status);
  if (statuses.length) { where.push(`status IN (${marks(statuses.length)})`); params.push(...statuses); }
  if (q.since != null) { where.push('started_at >= ?'); params.push(Math.floor(Number(q.since))); }
  return getDb().prepare(`SELECT COUNT(*) FROM mind_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .pluck().get(...params);
}

/** started_at of the latest skipped run of this kind/reason (for the once-per-hour rule), or null. */
export function lastSkip(kind, reason) {
  return getDb().prepare(`SELECT MAX(started_at) FROM mind_runs WHERE kind = ? AND status = 'skipped' AND skip_reason = ?`)
    .pluck().get(kind, reason) ?? null;
}

// ── mind_nights ──────────────────────────────────────────────────────────────

export function getNight(nightKey) {
  return decode(getDb().prepare('SELECT * FROM mind_nights WHERE night_key = ?').get(nightKey));
}

/**
 * Create or update a night. fields: { status, partial, selfmodelRunId, attempts,
 * episodes, runId, startedAt, finishedAt, incAttempts: true }. A new night needs a
 * status. → the row.
 */
export function upsertNight(nightKey, fields = {}) {
  if (typeof nightKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nightKey)) throw new TypeError('upsertNight: bad night key');
  const { incAttempts = false, ...rest } = fields;
  const cols = encode('mind_nights', rest);
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM mind_nights WHERE night_key = ?').get(nightKey);
    if (!cur) {
      if (!cols.status) throw new TypeError('upsertNight: a new night needs a status');
      if (incAttempts) cols.attempts = (cols.attempts ?? 0) + 1;
      const names = Object.keys(cols);
      db.prepare(`INSERT INTO mind_nights (night_key, ${names.join(', ')}) VALUES (?, ${marks(names.length)})`)
        .run(nightKey, ...names.map(n => cols[n]));
    } else {
      if (incAttempts) cols.attempts = (cols.attempts ?? cur.attempts ?? 0) + 1;
      const names = Object.keys(cols);
      if (names.length) {
        db.prepare(`UPDATE mind_nights SET ${names.map(n => `${n} = ?`).join(', ')} WHERE night_key = ?`)
          .run(...names.map(n => cols[n]), nightKey);
      }
    }
    return decode(db.prepare('SELECT * FROM mind_nights WHERE night_key = ?').get(nightKey));
  })();
}

// ── mind_chat_activity ───────────────────────────────────────────────────────

const ACTIVITY_COUNTERS = ['msgs', 'human_msgs', 'senders', 'bot_mentions', 'open_questions', 'bot_msgs'];

/**
 * Add pulse counters for a chat-day. deltas: { msgs, humanMsgs, senders,
 * botMentions, openQuestions, botMsgs } (added) and { lastHumanAt, lastBotAt }
 * (kept as the max).
 */
export function bumpActivity(chatJid, dayKey, deltas = {}) {
  if (typeof chatJid !== 'string' || !chatJid || typeof dayKey !== 'string') throw new TypeError('bumpActivity: chatJid and dayKey required');
  const known = new Set([...ACTIVITY_COUNTERS.map(camel), ...ACTIVITY_COUNTERS, 'lastHumanAt', 'lastBotAt', 'last_human_at', 'last_bot_at']);
  for (const k of Object.keys(deltas)) if (!known.has(k)) throw new TypeError(`bumpActivity: unknown field "${k}"`);
  const num = (k) => {
    const v = deltas[camel(k)] ?? deltas[k] ?? 0;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : 0;
  };
  const time = (k) => {
    const v = deltas[camel(k)] ?? deltas[k];
    const n = Math.floor(Number(v));
    return v == null || !Number.isFinite(n) ? null : n;
  };
  getDb().prepare(`INSERT INTO mind_chat_activity (chat_jid, day_key, ${ACTIVITY_COUNTERS.join(', ')}, last_human_at, last_bot_at)
    VALUES (?, ?, ${marks(ACTIVITY_COUNTERS.length)}, ?, ?)
    ON CONFLICT(chat_jid, day_key) DO UPDATE SET
      ${ACTIVITY_COUNTERS.map(c => `${c} = ${c} + excluded.${c}`).join(', ')},
      last_human_at = MAX(COALESCE(last_human_at, 0), COALESCE(excluded.last_human_at, 0)),
      last_bot_at = MAX(COALESCE(last_bot_at, 0), COALESCE(excluded.last_bot_at, 0))`)
    .run(chatJid, dayKey, ...ACTIVITY_COUNTERS.map(num), time('last_human_at'), time('last_bot_at'));
  const row = getDb().prepare('SELECT * FROM mind_chat_activity WHERE chat_jid = ? AND day_key = ?').get(chatJid, dayKey);
  // MAX(0, NULL→0) turns a never-set time into 0; report it as null.
  const out = decode(row);
  if (out.lastHumanAt === 0) out.lastHumanAt = null;
  if (out.lastBotAt === 0) out.lastBotAt = null;
  return out;
}

/** Activity rows since a local day key ('YYYY-MM-DD', inclusive) or a unix time (last activity ≥ it). */
export function activityFor(since) {
  const db = getDb();
  const rows = typeof since === 'string'
    ? db.prepare('SELECT * FROM mind_chat_activity WHERE day_key >= ? ORDER BY day_key, chat_jid').all(since)
    : db.prepare(`SELECT * FROM mind_chat_activity WHERE MAX(COALESCE(last_human_at, 0), COALESCE(last_bot_at, 0)) >= ?
        ORDER BY day_key, chat_jid`).all(Math.floor(Number(since) || 0));
  return rows.map((r) => {
    const o = decode(r);
    if (o.lastHumanAt === 0) o.lastHumanAt = null;
    if (o.lastBotAt === 0) o.lastBotAt = null;
    return o;
  });
}

// ── mind_digests + the monotonic digest cursor ───────────────────────────────

function bumpCursor(db, chatJid, { lastRowid = null, digestRowid = null, lastNightKey } = {}) {
  db.prepare(`INSERT INTO mind_episode_cursor (chat_jid, last_rowid, digest_rowid, last_night_key, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      last_rowid = MAX(last_rowid, excluded.last_rowid),
      digest_rowid = MAX(digest_rowid, excluded.digest_rowid),
      last_night_key = CASE WHEN ? THEN excluded.last_night_key ELSE last_night_key END,
      updated_at = excluded.updated_at`)
    .run(chatJid, lastRowid ?? 0, digestRowid ?? 0, lastNightKey ?? null, nowSec(), lastNightKey !== undefined ? 1 : 0);
}

/**
 * Store one clerk digest and advance that chat's digest cursor to MAX(cursor,
 * to_rowid) in the same transaction (the cursor never steps back, even when this
 * digest is later deleted: plan review S2-01). `row.evidence` ([{msgId, ts}], every
 * input line, L and C) is written to item_evidence as item_type 'mind_digest'.
 * → id
 */
export function insertDigest(row) {
  const { evidence = [], ...rest } = row || {};
  const cols = encode('mind_digests', rest);
  if (cols.created_at === undefined) cols.created_at = nowSec();
  if (cols.threads_json === undefined) cols.threads_json = '[]';
  requireCols('mind_digests', cols);
  if (cols.to_rowid < cols.from_rowid) throw new TypeError('insertDigest: to_rowid < from_rowid');
  const db = getDb();
  return db.transaction(() => {
    const id = insertRow(db, 'mind_digests', cols);
    addDigestEvidence(db, id, evidence);
    bumpCursor(db, cols.chat_jid, { digestRowid: cols.to_rowid });
    return id;
  })();
}

function addDigestEvidence(db, digestId, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO item_evidence (item_type, item_id, msg_id, ts) VALUES ('mind_digest', ?, ?, ?)`);
  let n = 0;
  for (const e of evidence) {
    const msgId = typeof e?.msgId === 'string' ? e.msgId.trim() : '';
    if (!msgId || msgId.length > 200) continue;
    const ts = Number.isFinite(Number(e.ts)) && e.ts != null ? Math.floor(Number(e.ts)) : null;
    n += stmt.run(digestId, msgId, ts).changes;
  }
  return n;
}

/** The digest's evidence rows [{msgId, ts}] (mind-internal: episode evidence = union of these). */
export function digestEvidence(digestId) {
  return getDb().prepare(`SELECT msg_id AS msgId, ts FROM item_evidence WHERE item_type = 'mind_digest' AND item_id = ?
    ORDER BY ts, msg_id`).all(digestId);
}

export function getDigest(id) {
  return decode(getDb().prepare('SELECT * FROM mind_digests WHERE id = ?').get(id));
}

/** The chat's newest digest (by range end). */
export function latestDigest(chatJid) {
  return decode(getDb().prepare('SELECT * FROM mind_digests WHERE chat_jid = ? ORDER BY to_rowid DESC, id DESC LIMIT 1').get(chatJid));
}

/** The chat's digests, oldest first; opts.sinceAt keeps those with period_end ≥ it. */
export function digestsFor(chatJid, { sinceAt = null } = {}) {
  const db = getDb();
  const rows = sinceAt == null
    ? db.prepare('SELECT * FROM mind_digests WHERE chat_jid = ? ORDER BY to_rowid, id').all(chatJid)
    : db.prepare('SELECT * FROM mind_digests WHERE chat_jid = ? AND period_end >= ? ORDER BY to_rowid, id').all(chatJid, Math.floor(sinceAt));
  return decodeAll(rows);
}

/** The digest high-water mark for a chat (0 when never digested). Monotonic. */
export function digestCursor(chatJid) {
  return getDb().prepare('SELECT digest_rowid FROM mind_episode_cursor WHERE chat_jid = ?').pluck().get(chatJid) ?? 0;
}

// ── mind_episode_cursor ──────────────────────────────────────────────────────

export function getEpisodeCursor(chatJid) {
  return decode(getDb().prepare('SELECT * FROM mind_episode_cursor WHERE chat_jid = ?').get(chatJid));
}

/** fields: { lastRowid, digestRowid, lastNightKey }. Both rowids are monotonic (MAX with the stored one). */
export function setEpisodeCursor(chatJid, fields = {}) {
  if (typeof chatJid !== 'string' || !chatJid) throw new TypeError('setEpisodeCursor: chatJid required');
  const cols = encode('mind_episode_cursor', fields);
  bumpCursor(getDb(), chatJid, {
    lastRowid: cols.last_rowid ?? null,
    digestRowid: cols.digest_rowid ?? null,
    lastNightKey: 'last_night_key' in cols ? cols.last_night_key : undefined,
  });
  return getEpisodeCursor(chatJid);
}

/**
 * Seed every cursor to "now" (research R1): the message scan cursor to
 * MAX(messages.rowid), the life event cursor to MAX(world_events.id), and each
 * chat's episode + digest cursors to that chat's MAX(rowid) (chat key = chatKeyOf,
 * so a DM under several forms is one chat). Never steps a cursor back. One
 * transaction. → { lastRowid, lastEventId, chats }
 */
export function seedCursorsToMax() {
  const db = getDb();
  return db.transaction(() => {
    const maxRow = db.prepare('SELECT COALESCE(MAX(rowid), 0) FROM messages').pluck().get();
    let maxEvent = 0;
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_events'`).get()) {
      maxEvent = db.prepare('SELECT COALESCE(MAX(id), 0) FROM world_events').pluck().get();
    }
    const at = nowSec();
    db.prepare(`INSERT INTO mind_state (id, last_rowid, last_event_id, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_rowid = MAX(last_rowid, excluded.last_rowid),
        last_event_id = MAX(last_event_id, excluded.last_event_id), updated_at = excluded.updated_at`)
      .run(maxRow, maxEvent, at);
    const perChat = new Map();
    for (const r of db.prepare('SELECT group_jid AS chat, MAX(rowid) AS r FROM messages GROUP BY group_jid').all()) {
      const key = chatKeyOf(r.chat);
      if (!key) continue;
      perChat.set(key, Math.max(perChat.get(key) || 0, r.r || 0));
    }
    for (const [chat, r] of perChat) bumpCursor(db, chat, { lastRowid: r, digestRowid: r });
    const state = getState();
    return { lastRowid: state.lastRowid, lastEventId: state.lastEventId, chats: perChat.size };
  })();
}

// ── mind_episode_log ─────────────────────────────────────────────────────────

// A chat-night that must never be rebuilt keeps that status: forget-fenced,
// tombstoned, or deleted by a purge (research R9).
function isSticky(row) {
  return !!row && (row.outcome === 'fenced' || row.outcome === 'tombstoned'
    || (row.outcome === 'deleted' && row.cause === 'purge'));
}

/**
 * Record a chat-night outcome. fields: { outcome, memoryId?, cause?, rebuildRequested? }.
 * rebuild_requested is only ever 1 for outcome 'deleted' with cause revoke|edit;
 * a fenced / tombstoned / purge-deleted night stays that way. → the row
 */
export function logEpisodeNight(chatJid, nightKey, fields = {}) {
  if (typeof chatJid !== 'string' || !chatJid || typeof nightKey !== 'string' || !nightKey) {
    throw new TypeError('logEpisodeNight: chatJid and nightKey required');
  }
  const cols = encode('mind_episode_log', fields);
  requireCols('mind_episode_log', cols);
  const rebuildable = cols.outcome === 'deleted' && (cols.cause === 'revoke' || cols.cause === 'edit');
  cols.rebuild_requested = rebuildable && cols.rebuild_requested !== 0 ? 1 : 0;
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM mind_episode_log WHERE chat_jid = ? AND night_key = ?').get(chatJid, nightKey);
    if (isSticky(cur)) {
      // Only another never-rebuild outcome may replace it (e.g. a later forget on a tombstoned night).
      const next = { outcome: cols.outcome, cause: cols.cause ?? null };
      if (!isSticky(next)) return decode(cur);
    }
    const memoryId = cols.memory_id !== undefined ? cols.memory_id : (cur?.memory_id ?? null);
    db.prepare(`INSERT INTO mind_episode_log (chat_jid, night_key, outcome, memory_id, cause, rebuild_requested, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid, night_key) DO UPDATE SET outcome = excluded.outcome, memory_id = excluded.memory_id,
        cause = excluded.cause, rebuild_requested = excluded.rebuild_requested, updated_at = excluded.updated_at`)
      .run(chatJid, nightKey, cols.outcome, memoryId, cols.cause ?? null, cols.rebuild_requested, nowSec());
    return decode(db.prepare('SELECT * FROM mind_episode_log WHERE chat_jid = ? AND night_key = ?').get(chatJid, nightKey));
  })();
}

export function episodeNight(chatJid, nightKey) {
  return decode(getDb().prepare('SELECT * FROM mind_episode_log WHERE chat_jid = ? AND night_key = ?').get(chatJid, nightKey));
}

/**
 * Chat-nights the next sleep may rebuild: only revoke/edit-deleted nights flagged
 * rebuild_requested, night_key ≥ sinceNightKey, newest first, ≤ limit.
 */
export function nightsToRebuild(sinceNightKey, limit = 4) {
  return decodeAll(getDb().prepare(`SELECT * FROM mind_episode_log
    WHERE rebuild_requested = 1 AND outcome = 'deleted' AND cause IN ('revoke', 'edit') AND night_key >= ?
    ORDER BY night_key DESC, chat_jid LIMIT ?`).all(String(sinceNightKey || ''), clampLimit(limit, 4, 50)));
}

/** All chat-night rows that cite one of these episode memory ids (for the deletion hook). */
export function episodeNightsForMemories(memoryIds) {
  const ids = (memoryIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  return decodeAll(getDb().prepare(`SELECT * FROM mind_episode_log WHERE memory_id IN (${marks(ids.length)})`).all(...ids));
}

// ── mind_self_state ──────────────────────────────────────────────────────────

/** → id. Defaults: created_at = now, status 'active'. */
export function insertElement(row) {
  const cols = encode('mind_self_state', row);
  if (cols.created_at === undefined) cols.created_at = nowSec();
  if (!cols.status) cols.status = 'active';
  if (cols.basis_json === undefined) cols.basis_json = '[]';
  if (cols.origins_json === undefined) cols.origins_json = '[]';
  requireCols('mind_self_state', cols);
  return insertRow(getDb(), 'mind_self_state', cols);
}

export function getElement(id) {
  return decode(getDb().prepare('SELECT * FROM mind_self_state WHERE id = ?').get(id));
}

/** Active, unexpired elements (newest first). */
export function activeElements(now = nowSec()) {
  return decodeAll(getDb().prepare(`SELECT * FROM mind_self_state WHERE status = 'active' AND expires_at > ?
    ORDER BY created_at DESC, id DESC`).all(Math.floor(now)));
}

/** Set the status of these element ids. → changes */
export function setElementStatus(ids, status) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!ELEMENT_STATUSES.includes(status)) throw new TypeError('setElementStatus: bad status');
  if (!list.length) return 0;
  return getDb().prepare(`UPDATE mind_self_state SET status = ? WHERE id IN (${marks(list.length)})`).run(status, ...list).changes;
}

/** Active elements targeting or originating in these chat forms (made at or after `since`, when given) → 'superseded'. → changes */
export function supersedeElementsOf(forms, { since = null } = {}) {
  const list = asList(forms);
  if (!list.length) return 0;
  const quoted = list.map(f => JSON.stringify(f));
  const window = since === null ? '' : 'AND created_at >= ?';
  return getDb().prepare(`UPDATE mind_self_state SET status = 'superseded' WHERE status = 'active' ${window}
    AND (target_chat IN (${marks(list.length)}) OR ${quoted.map(() => 'instr(origins_json, ?) > 0').join(' OR ')})`)
    .run(...(since === null ? [] : [Math.floor(Number(since))]), ...list, ...quoted).changes;
}

/** active elements whose expires_at ≤ now → 'expired'. → changes */
export function expireElements(now = nowSec()) {
  return getDb().prepare(`UPDATE mind_self_state SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`)
    .run(Math.floor(now)).changes;
}

// ── mind_self_model ──────────────────────────────────────────────────────────

function activateSelfModel(db, id, at) {
  db.prepare(`UPDATE mind_self_model SET status = 'superseded' WHERE status = 'active' AND id != ?`).run(id);
  db.prepare(`UPDATE mind_self_model SET status = 'active', activated_at = ? WHERE id = ?`).run(at, id);
}

/**
 * → id. version defaults to MAX(version)+1; an 'invalid' row stores text '' (only
 * its scrub report is kept, plan review S1-14); inserting an 'active' row
 * supersedes the current active one in the same transaction.
 */
export function insertSelfModel(row) {
  const cols = encode('mind_self_model', row);
  requireCols('mind_self_model', cols);
  const cap = config.mind.selfModelMaxChars || 1500;
  cols.text = cols.status === 'invalid' ? '' : String(cols.text ?? '').slice(0, cap);
  if (cols.created_at === undefined) cols.created_at = nowSec();
  const db = getDb();
  return db.transaction(() => {
    if (cols.version === undefined) {
      cols.version = (db.prepare('SELECT MAX(version) FROM mind_self_model').pluck().get() ?? -1) + 1;
    }
    const wantActive = cols.status === 'active';
    if (wantActive) cols.status = 'approved';   // activated below, after the old one steps down
    const id = insertRow(db, 'mind_self_model', cols);
    if (wantActive) activateSelfModel(db, id, cols.activated_at ?? nowSec());
    return id;
  })();
}

/** The version-0 empty seed, written once when the table is empty. → the active row */
export function seedSelfModel() {
  const db = getDb();
  db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) FROM mind_self_model').pluck().get() > 0) return;
    const at = nowSec();
    db.prepare(`INSERT INTO mind_self_model (version, text, source, status, created_at, activated_at, decided_by)
      VALUES (0, '', 'seed', 'active', ?, ?, 'system')`).run(at, at);
  })();
  return activeSelfModel();
}

export function activeSelfModel() {
  return decode(getDb().prepare(`SELECT * FROM mind_self_model WHERE status = 'active'`).get());
}

export function getSelfModel(id) {
  return decode(getDb().prepare('SELECT * FROM mind_self_model WHERE id = ?').get(id));
}

/** Versions, newest first. q: { status? (string|array), before? (version), limit ≤ 200 } */
export function listSelfModel(q = {}) {
  const where = [];
  const params = [];
  const statuses = asList(q.status);
  if (statuses.length) { where.push(`status IN (${marks(statuses.length)})`); params.push(...statuses); }
  if (q.before != null && Number.isFinite(Number(q.before))) { where.push('version < ?'); params.push(Math.floor(Number(q.before))); }
  return decodeAll(getDb().prepare(`SELECT * FROM mind_self_model ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY version DESC LIMIT ?`).all(...params, clampLimit(q.limit, 50, 200)));
}

/**
 * Change a version's status (+ allow-listed fields: decidedAt, decidedBy,
 * activatedAt, rationale, scrub, changesSummary, diff). 'active' supersedes the
 * current active version in one transaction; 'invalid' blanks the text. → changes
 */
export function setSelfModelStatus(id, status, fields = {}) {
  if (!SELF_MODEL_STATUSES.includes(status)) throw new TypeError('setSelfModelStatus: bad status');
  const cols = encode('mind_self_model', fields, { omit: ['version', 'source', 'status', 'text', 'base_version', 'run_id', 'created_at'] });
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT id FROM mind_self_model WHERE id = ?').get(id);
    if (!cur) return 0;
    if (status === 'invalid') cols.text = '';
    if (status === 'active') {
      const at = cols.activated_at ?? nowSec();
      delete cols.activated_at;
      updateById(db, 'mind_self_model', id, cols);
      activateSelfModel(db, id, at);
      return 1;
    }
    return updateById(db, 'mind_self_model', id, { ...cols, status });
  })();
}

// ── mind_nudges ──────────────────────────────────────────────────────────────

/**
 * → id. An active row (status active|clamped, or active: true) replaces the active
 * nudge on the same (knob, scope) in the same transaction (that one becomes
 * 'replaced', ended_by 'replaced'). A refused row is never active.
 */
export function insertNudge(row) {
  const cols = encode('mind_nudges', row);
  requireCols('mind_nudges', cols);
  if (cols.created_at === undefined) cols.created_at = nowSec();
  if (cols.active === undefined) cols.active = cols.status === 'active' || cols.status === 'clamped' ? 1 : 0;
  if (cols.status === 'refused') cols.active = 0;
  if (cols.active && !['active', 'clamped'].includes(cols.status)) throw new TypeError('insertNudge: only active|clamped rows can be active');
  const db = getDb();
  return db.transaction(() => {
    if (cols.active) {
      db.prepare(`UPDATE mind_nudges SET active = 0, status = 'replaced', ended_at = ?, ended_by = 'replaced'
        WHERE knob = ? AND scope = ? AND active = 1`).run(cols.created_at, cols.knob, cols.scope);
    }
    return insertRow(db, 'mind_nudges', cols);
  })();
}

export function getNudge(id) {
  return decode(getDb().prepare('SELECT * FROM mind_nudges WHERE id = ?').get(id));
}

/** Every row with active = 1 (expiry is the caller's check / expireNudges). */
export function activeNudges() {
  return decodeAll(getDb().prepare('SELECT * FROM mind_nudges WHERE active = 1 ORDER BY created_at, id').all());
}

/** Nudge history, newest first. q: { status?, knob?, before? (id), limit ≤ 200 } */
export function listNudges(q = {}) {
  const where = [];
  const params = [];
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.knob) { where.push('knob = ?'); params.push(q.knob); }
  if (q.before != null && Number.isFinite(Number(q.before))) { where.push('id < ?'); params.push(Math.floor(Number(q.before))); }
  return decodeAll(getDb().prepare(`SELECT * FROM mind_nudges ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).all(...params, clampLimit(q.limit, 50, 200)));
}

/** End an active nudge: status expired|reverted|overridden|replaced, ended_by 'expiry'|'owner:<u>'|'override'|'replaced'. → changes */
export function endNudge(id, status, endedBy) {
  if (!['expired', 'reverted', 'overridden', 'replaced'].includes(status)) throw new TypeError('endNudge: bad status');
  return getDb().prepare(`UPDATE mind_nudges SET active = 0, status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND active = 1`)
    .run(status, nowSec(), String(endedBy || '').slice(0, 100) || null, id).changes;
}

/** created_at of the last nudge actually applied (not refused) on (knob, scope), or null. */
export function lastApplied(knob, scope) {
  return getDb().prepare(`SELECT MAX(created_at) FROM mind_nudges WHERE knob = ? AND scope = ? AND status != 'refused'`)
    .pluck().get(knob, scope) ?? null;
}

// ── mind_proactive ───────────────────────────────────────────────────────────

/** → id. Defaults: created_at = now. A second 'queued' row for one chat throws (unique index). */
export function insertDraft(row) {
  const cols = encode('mind_proactive', row);
  if (cols.created_at === undefined) cols.created_at = nowSec();
  requireCols('mind_proactive', cols);
  return insertRow(getDb(), 'mind_proactive', cols);
}

/** → changes. Moving a row to 'queued' while the chat already has one throws (SQLITE_CONSTRAINT_UNIQUE). */
export function updateDraft(id, fields) {
  const cols = encode('mind_proactive', fields, { omit: ['created_at'] });
  return updateById(getDb(), 'mind_proactive', id, cols);
}

export function getDraft(id) {
  return decode(getDb().prepare('SELECT * FROM mind_proactive WHERE id = ?').get(id));
}

/** Drafts, newest first. q: { status? (string|array), chatJid? (string|forms), before? (id), limit ≤ 100 } */
export function listDrafts(q = {}) {
  const where = [];
  const params = [];
  const statuses = asList(q.status);
  if (statuses.length) { where.push(`status IN (${marks(statuses.length)})`); params.push(...statuses); }
  const chats = asList(q.chatJid);
  if (chats.length) { where.push(`chat_jid IN (${marks(chats.length)})`); params.push(...chats); }
  if (q.before != null && Number.isFinite(Number(q.before))) { where.push('id < ?'); params.push(Math.floor(Number(q.before))); }
  return decodeAll(getDb().prepare(`SELECT * FROM mind_proactive ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`).all(...params, clampLimit(q.limit, 50, 100)));
}

/**
 * Count drafts. q: { chatJid? (string|forms), statuses (required), since?
 * (created_at ≥), excludeId? } — e.g. caps over DRAFT_COUNTED excluding the row
 * being dispatched (proactive.md D3).
 */
export function countDrafts(q = {}) {
  const statuses = asList(q.statuses);
  if (!statuses.length) throw new TypeError('countDrafts: statuses required');
  const where = [`status IN (${marks(statuses.length)})`];
  const params = [...statuses];
  const chats = asList(q.chatJid);
  if (chats.length) { where.push(`chat_jid IN (${marks(chats.length)})`); params.push(...chats); }
  if (q.chatKind) { where.push('chat_kind = ?'); params.push(q.chatKind); }
  if (q.since != null) { where.push('created_at >= ?'); params.push(Math.floor(Number(q.since))); }
  if (q.excludeId != null) { where.push('id != ?'); params.push(Math.floor(Number(q.excludeId))); }
  return getDb().prepare(`SELECT COUNT(*) FROM mind_proactive WHERE ${where.join(' AND ')}`).pluck().get(...params);
}

/** The newest sent|dry_run|send_failed|would_send row for a chat (string or forms), or null (back-off). */
export function lastSentTo(chatJid) {
  const chats = asList(chatJid);
  if (!chats.length) return null;
  return decode(getDb().prepare(`SELECT * FROM mind_proactive WHERE chat_jid IN (${marks(chats.length)})
    AND status IN ('sent', 'dry_run', 'send_failed', 'would_send')
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT 1`).get(...chats));
}

/** Queued rows due at `now` (send_after ≤ now or unset), oldest first. */
export function dueQueued(now = nowSec()) {
  return decodeAll(getDb().prepare(`SELECT * FROM mind_proactive WHERE status = 'queued'
    AND COALESCE(send_after, 0) <= ? ORDER BY COALESCE(send_after, created_at), id`).all(Math.floor(now)));
}

/**
 * Bulk update (proactive.cancelQueued / cancelForChat build on it).
 * where: { chatForms?, statuses (required), createdBefore?, createdSince?, matchOrigins? };
 * fields as updateDraft. matchOrigins: also rows whose origins_json names one of the
 * chatForms (a draft in Y based on X). → changes
 */
export function updateDraftsWhere(where = {}, fields = {}) {
  const statuses = asList(where.statuses);
  if (!statuses.length) throw new TypeError('updateDraftsWhere: statuses required');
  const cols = encode('mind_proactive', fields, { omit: ['created_at', 'chat_jid', 'chat_kind'] });
  const names = Object.keys(cols);
  if (!names.length) return 0;
  const conds = [`status IN (${marks(statuses.length)})`];
  const params = [...statuses];
  if (where.chatForms !== undefined) {
    const chats = asList(where.chatForms);
    if (!chats.length) return 0;
    const quoted = where.matchOrigins === true ? chats.map(c => JSON.stringify(c)) : [];
    conds.push(`(chat_jid IN (${marks(chats.length)}) OR person_jid IN (${marks(chats.length)})${
      quoted.map(() => ` OR instr(COALESCE(origins_json, ''), ?) > 0`).join('')})`);
    params.push(...chats, ...chats, ...quoted);
  }
  if (where.createdBefore != null) { conds.push('created_at < ?'); params.push(Math.floor(Number(where.createdBefore))); }
  if (where.createdSince != null) { conds.push('created_at >= ?'); params.push(Math.floor(Number(where.createdSince))); }
  return getDb().prepare(`UPDATE mind_proactive SET ${names.map(n => `${n} = ?`).join(', ')} WHERE ${conds.join(' AND ')}`)
    .run(...names.map(n => cols[n]), ...params).changes;
}

/** 'drafting' rows created before `olderThan` → dropped:'stale_draft' (boot: pass now + 1). → changes */
export function dropStaleDrafting(olderThan) {
  return getDb().prepare(`UPDATE mind_proactive SET status = 'dropped', drop_reason = 'stale_draft'
    WHERE status = 'drafting' AND created_at < ?`).run(Math.floor(Number(olderThan))).changes;
}

// ── mind_exclusions ──────────────────────────────────────────────────────────

const SOURCE_RANK = { owner_cleared: 1, detected: 2, owner: 3 };

function exclusionRowsFor(db, forms, { includeCleared }) {
  const list = asList(forms);
  if (!list.length) return [];
  return decodeAll(db.prepare(`SELECT * FROM mind_exclusions WHERE jid IN (${marks(list.length)})
    ${includeCleared ? '' : `AND source != 'owner_cleared'`} ORDER BY id`).all(...list));
}

/** Exclusions in force for these jid forms (owner + detected; an owner_cleared row does not exclude). */
export function exclusionsFor(forms) {
  return exclusionRowsFor(getDb(), forms, { includeCleared: false });
}

/** Every exclusion row for these forms, owner_cleared included (the pulse needs cleared_at). */
export function exclusionRows(forms) {
  return exclusionRowsFor(getDb(), forms, { includeCleared: true });
}

export function getExclusion(id) {
  return decode(getDb().prepare('SELECT * FROM mind_exclusions WHERE id = ?').get(id));
}

export function listExclusions() {
  return decodeAll(getDb().prepare('SELECT * FROM mind_exclusions ORDER BY created_at DESC, id DESC').all());
}

/**
 * A detected "don't text me first" (research R16). row: { jid, kind = 'person',
 * msgId?, msgTs?, p? (null = prefilter-only / Jev failed), createdBy? }.
 * New → inserted 'detected'. An owner row is kept. An owner_cleared row comes back
 * as 'detected' only when msgTs > cleared_at (no msgTs → kept cleared).
 * → { id, action: 'inserted'|'kept'|'updated'|'reopened' }
 */
export function upsertDetected(row = {}) {
  const kind = row.kind ?? 'person';
  if (!EXCLUSION_KINDS.includes(kind)) throw new TypeError('upsertDetected: bad kind');
  const jid = typeof row.jid === 'string' ? row.jid.trim() : '';
  if (!jid || jid.length > 200) throw new TypeError('upsertDetected: jid required');
  const msgId = typeof row.msgId === 'string' ? row.msgId.slice(0, 200) : null;
  const p = row.p == null || !Number.isFinite(Number(row.p)) ? null : Math.max(0, Math.min(1, Number(row.p)));
  const msgTs = row.msgTs == null || !Number.isFinite(Number(row.msgTs)) ? null : Math.floor(Number(row.msgTs));
  const by = String(row.createdBy || 'mind').slice(0, 100);
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM mind_exclusions WHERE kind = ? AND jid = ?').get(kind, jid);
    if (!cur) {
      const id = insertRow(db, 'mind_exclusions', { kind, jid, source: 'detected', msg_id: msgId, p, created_at: nowSec(), created_by: by });
      return { id, action: 'inserted' };
    }
    if (cur.source === 'owner') return { id: cur.id, action: 'kept' };
    if (cur.source === 'owner_cleared') {
      if (msgTs === null || cur.cleared_at == null || msgTs <= cur.cleared_at) return { id: cur.id, action: 'kept' };
      db.prepare(`UPDATE mind_exclusions SET source = 'detected', msg_id = ?, p = ? WHERE id = ?`).run(msgId, p, cur.id);
      return { id: cur.id, action: 'reopened' };
    }
    // Already detected: keep the stricter (null = fail closed) probability record.
    if (msgId && msgId !== cur.msg_id) {
      db.prepare('UPDATE mind_exclusions SET msg_id = ?, p = ? WHERE id = ?').run(msgId, cur.p === null ? null : p, cur.id);
      return { id: cur.id, action: 'updated' };
    }
    return { id: cur.id, action: 'kept' };
  })();
}

// ── owner namespace (routes/mind.js via the facade only) ─────────────────────

// ── stances (plan 020 B): his interests and opinions ───────────────────────────
// Rows hold codes, numbers, fictional labels and event ids: never a chat's words. Evidence is
// world events only. The rules live in stanceRules.js, the flow in stance.js.

const STANCE_PATCH_COLUMNS = Object.freeze({
  label: 'label', value: 'value', confidence: 'confidence', anchor: 'anchor', uptake: 'uptake',
  baseValue: 'base_value', baseConfidence: 'base_confidence', baseNight: 'base_night', baseSince: 'base_since', baseHabit: 'base_habit', status: 'status',
  pinned: 'pinned', why: 'why', lastReinforcedAt: 'last_reinforced_at', approvedAt: 'approved_at',
});

function stanceRow(r) {
  if (!r) return null;
  return {
    id: r.id, topic: r.topic, label: r.label, kind: r.kind, value: r.value, confidence: r.confidence, anchor: r.anchor,
    uptake: r.uptake, baseValue: r.base_value, baseConfidence: r.base_confidence, baseNight: r.base_night, baseSince: r.base_since, baseHabit: parseJson(r.base_habit, []), status: r.status,
    pinned: r.pinned === 1, why: r.why, source: r.source, lastReinforcedAt: r.last_reinforced_at,
    createdAt: r.created_at, approvedAt: r.approved_at, updatedAt: r.updated_at,
  };
}

function stanceEvidenceRow(r) {
  return {
    id: r.id, stanceId: r.stance_id, night: r.night, at: r.at, source: r.source, cause: r.cause_code, weight: r.weight,
    eventIds: parseJson(r.event_ids, []), originKind: r.origin_kind, originJid: r.origin_jid, subjectJid: r.subject_jid, originAt: r.origin_at,
    details: parseJson(r.details_json, null),
  };
}

// Bumped by every write of a row, so the values his day reads can be held in memory.
let stanceWrites = 0;
export function stanceVersion() { return stanceWrites; }

/** Every stance, or only those of the given statuses, topic order. */
export function listStances({ status = null } = {}) {
  const want = asList(status);
  const rows = want.length
    ? getDb().prepare(`SELECT * FROM self_stance WHERE status IN (${marks(want.length)}) ORDER BY topic`).all(...want)
    : getDb().prepare('SELECT * FROM self_stance ORDER BY topic').all();
  return rows.map(stanceRow);
}

export function getStance(id) {
  return stanceRow(getDb().prepare('SELECT * FROM self_stance WHERE id = ?').get(id));
}

export function getStanceByTopic(topic) {
  return stanceRow(getDb().prepare('SELECT * FROM self_stance WHERE topic = ?').get(topic));
}

export function hasStances(statuses = ['proposed', 'active', 'archived']) {
  return getDb().prepare(`SELECT 1 FROM self_stance WHERE status IN (${marks(statuses.length)}) LIMIT 1`).get(...statuses) != null;
}

/** Insert a topic; a rejected row of the same topic is replaced. → the row */
export function putStance({ topic, label, kind, value, anchor = value, uptake = 1, status, why = null, source, confidence = 0.5, baseNight = null, approvedAt = null }) {
  stanceWrites += 1;
  const t = nowSec();
  const db = getDb();
  db.prepare("DELETE FROM self_stance WHERE topic = ? AND status = 'rejected'").run(topic);
  const r = db.prepare(`INSERT INTO self_stance (topic, label, kind, value, confidence, anchor, uptake, base_value, base_confidence, base_night,
      status, why, source, created_at, approved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(topic, label, kind, value, confidence, anchor, uptake, value, confidence, baseNight, status, why, source, t, approvedAt, t);
  return getStance(r.lastInsertRowid);
}

export function patchStance(id, patch = {}) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = STANCE_PATCH_COLUMNS[k];
    if (!col) throw new TypeError(`patchStance: unknown field ${k}`);
    sets.push(`${col} = ?`);
    vals.push(k === 'pinned' ? (v ? 1 : 0) : k === 'baseHabit' ? JSON.stringify(v ?? []) : v);
  }
  if (!sets.length) return getStance(id);
  stanceWrites += 1;
  sets.push('updated_at = ?');
  getDb().prepare(`UPDATE self_stance SET ${sets.join(', ')} WHERE id = ?`).run(...vals, nowSec(), id);
  return getStance(id);
}

export function addStanceEvidence(stanceId, night, item) {
  getDb().prepare(`INSERT INTO self_stance_evidence (stance_id, night, at, source, cause_code, weight, event_ids, origin_kind, origin_jid, subject_jid, origin_at, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(stanceId, night, item.at, item.source, item.cause, item.weight, JSON.stringify(item.eventIds ?? []), item.originKind ?? 'self',
      item.originJid ?? null, item.subjectJid ?? null, Number.isFinite(item.originAt) ? item.originAt : null, item.details ? JSON.stringify(item.details) : null, nowSec());
}

export function stanceEvidence(stanceId) {
  return getDb().prepare('SELECT * FROM self_stance_evidence WHERE stance_id = ? ORDER BY at, id').all(stanceId).map(stanceEvidenceRow);
}

export function allStanceEvidence() {
  return getDb().prepare('SELECT * FROM self_stance_evidence ORDER BY id').all().map(stanceEvidenceRow);
}

export function deleteStanceEvidenceIds(ids) {
  const del = getDb().prepare('DELETE FROM self_stance_evidence WHERE id = ?');
  let n = 0;
  for (const id of ids) n += del.run(id).changes;
  return n;
}

export function deleteStanceEvidenceOf(stanceId, { keepCited = false } = {}) {
  return getDb().prepare(`DELETE FROM self_stance_evidence WHERE stance_id = ?${keepCited ? " AND source != 'cited'" : ''}`).run(stanceId).changes;
}

/** A free topic whose every citation was revoked: the row goes, words and all. */
export function deleteStance(stanceId) {
  const db = getDb();
  stanceWrites += 1;
  db.prepare('DELETE FROM self_stance_evidence WHERE stance_id = ?').run(stanceId);
  db.prepare('DELETE FROM self_stance_history WHERE stance_id = ?').run(stanceId);
  db.prepare('DELETE FROM self_stance WHERE id = ?').run(stanceId);
}

/** The stance ids a chat or a person's evidence touches, after `since` if given. */
export function stanceEvidenceIdsFor(forms, { since = null, exceptSource = null } = {}) {
  const list = asList(forms);
  if (!list.length) return [];
  const m = marks(list.length);
  const rows = getDb().prepare(`SELECT id, stance_id, at, source FROM self_stance_evidence WHERE origin_jid IN (${m}) OR subject_jid IN (${m})`).all(...list, ...list);
  return rows.filter(r => (since === null || r.at >= since) && r.source !== exceptSource).map(r => ({ id: r.id, stanceId: r.stance_id }));
}

export function stanceHistory(stanceId, { limit = 400 } = {}) {
  const rows = getDb().prepare('SELECT * FROM self_stance_history WHERE stance_id = ? ORDER BY night DESC LIMIT ?').all(stanceId, limit);
  return rows.reverse().map(r => ({ night: r.night, before: r.before_value, after: r.after_value, confidence: r.confidence, count: r.evidence_count }));
}

/** Put the fold's rows; nights the fold doesn't cover (at or before the base) stay. */
export function writeStanceHistory(stanceId, rows) {
  const up = getDb().prepare(`INSERT INTO self_stance_history (stance_id, night, before_value, after_value, confidence, evidence_count) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stance_id, night) DO UPDATE SET before_value = excluded.before_value, after_value = excluded.after_value,
      confidence = excluded.confidence, evidence_count = excluded.evidence_count`);
  for (const r of rows) up.run(stanceId, r.night, r.before, r.after, r.confidence, r.count);
}

/** Only the newest `keep` nights of a row's trend are kept. */
export function pruneStanceHistory(stanceId, keep) {
  return getDb().prepare(`DELETE FROM self_stance_history WHERE stance_id = ? AND night NOT IN
    (SELECT night FROM self_stance_history WHERE stance_id = ? ORDER BY night DESC LIMIT ?)`).run(stanceId, stanceId, keep).changes;
}

export function deleteStanceHistoryOf(stanceId) {
  return getDb().prepare('DELETE FROM self_stance_history WHERE stance_id = ?').run(stanceId).changes;
}

export function deleteStanceEvidenceThrough(stanceId, night) {
  // A citation stays: it's what keeps a free topic's origin, and its words came from there.
  return getDb().prepare("DELETE FROM self_stance_evidence WHERE stance_id = ? AND night <= ? AND source != 'cited'").run(stanceId, night).changes;
}

/** A system setting of the stance flow (cursor, last night, exclusion signature). */
export function setStanceSetting(key, value) {
  if (!key.startsWith('stance_') || !SYSTEM_SETTING_KEYS.includes(key)) throw new TypeError(`setStanceSetting: ${key}`);
  writeSetting(getDb(), key, value, 'system');
}

export function stanceTx(fn) {
  return getDb().transaction(fn)();
}

export const owner = Object.freeze({
  /** Write one owner setting (validated). by = 'owner:<user>'. → { ok, key, value } */
  setSetting(key, value, by) {
    checkOwnerActor(by);
    const v = validateOwnerSetting(key, value);
    writeSetting(getDb(), key, v, by);
    return { ok: true, key, value: v };
  },

  /**
   * Exclude a person or group. row: { kind, jid, note? }. An existing detected /
   * owner_cleared row becomes an owner row. → { ok, id }
   */
  addExclusion(row = {}, by) {
    checkOwnerActor(by);
    if (!EXCLUSION_KINDS.includes(row.kind)) throw new TypeError('addExclusion: kind must be person|group');
    const jid = typeof row.jid === 'string' ? row.jid.trim() : '';
    if (!jid || jid.length > 200) throw new TypeError('addExclusion: jid required');
    const note = row.note == null ? null : String(row.note).slice(0, 120);
    const db = getDb();
    return db.transaction(() => {
      const cur = db.prepare('SELECT * FROM mind_exclusions WHERE kind = ? AND jid = ?').get(row.kind, jid);
      if (cur) {
        db.prepare(`UPDATE mind_exclusions SET source = 'owner', note = COALESCE(?, note), cleared_at = NULL, created_by = ? WHERE id = ?`)
          .run(note, by, cur.id);
        return { ok: true, id: cur.id };
      }
      const id = insertRow(db, 'mind_exclusions', { kind: row.kind, jid, source: 'owner', note, created_at: nowSec(), created_by: by });
      return { ok: true, id };
    })();
  },

  /**
   * Remove an exclusion: an owner row is deleted; a detected row becomes
   * owner_cleared with cleared_at = now (kept as the dismissal record, research R16).
   * → { ok, action: 'deleted'|'cleared'|'unchanged' } or { ok:false } when absent.
   */
  removeExclusion(id, by) {
    checkOwnerActor(by);
    const db = getDb();
    return db.transaction(() => {
      const cur = db.prepare('SELECT * FROM mind_exclusions WHERE id = ?').get(id);
      if (!cur) return { ok: false, action: 'missing' };
      if (cur.source === 'owner') {
        db.prepare('DELETE FROM mind_exclusions WHERE id = ?').run(id);
        return { ok: true, action: 'deleted' };
      }
      if (cur.source === 'detected') {
        db.prepare(`UPDATE mind_exclusions SET source = 'owner_cleared', cleared_at = ?, created_by = ? WHERE id = ?`)
          .run(nowSec(), by, id);
        return { ok: true, action: 'cleared' };
      }
      return { ok: true, action: 'unchanged' };
    })();
  },
});

// ── maintenance: retention, free-text nulling ────────────────────────────────

// Keys of free text inside a run's output_json (and its descendants) that are
// nulled after 7 days and by the deletion/purge hooks (data-model retention).
const FREE_TEXT_KEYS = ['note', 'reason', 'rationale', 'intent', 'text', 'summary', 'changes_summary', 'today_note',
  'message', 'voiced_text', 'alt_text'];
const FREE_TEXT_SQL = FREE_TEXT_KEYS.map(() => 'instr(output_json, ?) > 0').join(' OR ');
const FREE_TEXT_PARAMS = FREE_TEXT_KEYS.map(k => `"${k}":"`);

function stripFreeText(v) {
  if (Array.isArray(v)) return v.map(stripFreeText);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = FREE_TEXT_KEYS.includes(k) && typeof x === 'string' ? null : stripFreeText(x);
  return out;
}

function nullRunText(db, rows) {
  const upd = db.prepare('UPDATE mind_runs SET output_json = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const parsed = parseJson(r.output_json, null);
    const next = parsed === null ? null : JSON.stringify(stripFreeText(parsed));
    if (next !== r.output_json) n += upd.run(next, r.id).changes;
  }
  return n;
}

const PROACTIVE_TEXT_NULL = `reason = NULL, intent = NULL, alt_text = NULL, voiced_text = NULL, gate_reason = NULL`;

/**
 * Null mind free text tied to chats (the deletion/purge hooks, research R9):
 * opts { chatForms?: string[], sinceAt?: unix }. At least one is required.
 *   - mind_runs.output_json free-text fields, for runs whose input_json names any
 *     of the forms (and started_at ≥ sinceAt);
 *   - mind_self_model.rationale of those runs' versions;
 *   - mind_proactive reason/intent/voiced/alt text of non-pending rows of those
 *     chats or whose origins/audience name them (pending drafting|queued rows are
 *     the caller's to cancel first via updateDraftsWhere).
 * → { runs, selfModel, proactive }
 */
export function nullFreeText({ chatForms = null, sinceAt = null } = {}) {
  const forms = chatForms == null ? null : asList(chatForms);
  if ((forms === null || !forms.length) && sinceAt == null) return { runs: 0, selfModel: 0, proactive: 0 };
  if (forms !== null && !forms.length) return { runs: 0, selfModel: 0, proactive: 0 };
  const db = getDb();
  return db.transaction(() => {
    const conds = ['output_json IS NOT NULL'];
    const params = [];
    if (forms) {
      conds.push(`(${forms.map(() => 'instr(input_json, ?) > 0').join(' OR ')})`);
      params.push(...forms.map(f => JSON.stringify(f)));
    }
    if (sinceAt != null) { conds.push('started_at >= ?'); params.push(Math.floor(Number(sinceAt))); }
    const runRows = db.prepare(`SELECT id, output_json FROM mind_runs WHERE ${conds.join(' AND ')}`).all(...params);
    const runs = nullRunText(db, runRows);

    // Self-model rationale of the same runs (by run id, or, without forms, by time).
    let selfModel = 0;
    const runIdConds = forms
      ? (forms.length ? `run_id IN (SELECT id FROM mind_runs WHERE ${conds.slice(1).join(' AND ')})` : null)
      : 'created_at >= ?';
    if (runIdConds) {
      selfModel = db.prepare(`UPDATE mind_self_model SET rationale = NULL WHERE rationale IS NOT NULL AND ${runIdConds}`)
        .run(...(forms ? params : [Math.floor(Number(sinceAt))])).changes;
    }

    const pconds = [`status NOT IN ('drafting', 'queued')`];
    const pparams = [];
    if (forms) {
      const quoted = forms.map(f => JSON.stringify(f));
      pconds.push(`(chat_jid IN (${marks(forms.length)}) OR person_jid IN (${marks(forms.length)})
        OR ${quoted.map(() => 'instr(origins_json, ?) > 0').join(' OR ')}
        OR ${quoted.map(() => 'instr(COALESCE(audience_json, \'\'), ?) > 0').join(' OR ')})`);
      pparams.push(...forms, ...forms, ...quoted, ...quoted);
    }
    if (sinceAt != null) { pconds.push('created_at >= ?'); pparams.push(Math.floor(Number(sinceAt))); }
    const proactive = db.prepare(`UPDATE mind_proactive SET ${PROACTIVE_TEXT_NULL}
      WHERE ${pconds.join(' AND ')} AND (reason IS NOT NULL OR intent IS NOT NULL OR alt_text IS NOT NULL
        OR voiced_text IS NOT NULL OR gate_reason IS NOT NULL)`).run(...pparams).changes;
    return { runs, selfModel, proactive };
  })();
}

const SHORT_RUN_KINDS = ['pulse', 'glance', 'digest'];
const TERMINAL_DRAFT = DRAFT_STATUSES.filter(s => !DRAFT_PENDING.includes(s));

/**
 * Daily retention (data-model "Retention"), one transaction. Also fails runs left
 * 'running' for more than 6 h (a crash mid-run). → counts per table
 */
export function retention(now = nowSec()) {
  const t = Math.floor(now);
  const d7 = t - 7 * DAY;
  const db = getDb();
  return db.transaction(() => {
    const out = {};
    out.staleRuns = db.prepare(`UPDATE mind_runs SET status = 'failed', error = 'stale_running', finished_at = ?
      WHERE status = 'running' AND started_at < ?`).run(t, t - 6 * 3600).changes;
    out.runs = db.prepare(`DELETE FROM mind_runs WHERE kind IN (${marks(SHORT_RUN_KINDS.length)}) AND started_at < ?`)
      .run(...SHORT_RUN_KINDS, t - 30 * DAY).changes
      + db.prepare(`DELETE FROM mind_runs WHERE kind NOT IN (${marks(SHORT_RUN_KINDS.length)}) AND started_at < ?`)
        .run(...SHORT_RUN_KINDS, t - 180 * DAY).changes;
    out.runText = nullRunText(db, db.prepare(`SELECT id, output_json FROM mind_runs
      WHERE started_at < ? AND output_json IS NOT NULL AND (${FREE_TEXT_SQL})`).all(d7, ...FREE_TEXT_PARAMS));

    out.activity = db.prepare('DELETE FROM mind_chat_activity WHERE day_key < ?').run(localDateKey(t - 14 * DAY)).changes;

    const oldDigests = db.prepare('SELECT id FROM mind_digests WHERE created_at < ?').pluck().all(d7);
    for (let i = 0; i < oldDigests.length; i += 500) {
      const chunk = oldDigests.slice(i, i + 500);
      db.prepare(`DELETE FROM item_evidence WHERE item_type = 'mind_digest' AND item_id IN (${marks(chunk.length)})`).run(...chunk);
      db.prepare(`DELETE FROM mind_digests WHERE id IN (${marks(chunk.length)})`).run(...chunk);
    }
    out.digests = oldDigests.length;

    out.elements = db.prepare(`DELETE FROM mind_self_state WHERE status != 'active' AND MAX(created_at, expires_at) < ?`)
      .run(d7).changes;

    out.selfModel = db.prepare(`DELETE FROM mind_self_model WHERE created_at < ?
      AND (status IN ('rejected', 'invalid') OR (status = 'superseded' AND activated_at IS NULL))`).run(t - 90 * DAY).changes;
    out.rationale = db.prepare('UPDATE mind_self_model SET rationale = NULL WHERE rationale IS NOT NULL AND created_at < ?')
      .run(d7).changes;

    out.nudges = db.prepare('DELETE FROM mind_nudges WHERE active = 0 AND created_at < ?').run(t - 180 * DAY).changes;

    out.proactive = db.prepare(`DELETE FROM mind_proactive WHERE status NOT IN ('drafting', 'queued') AND created_at < ?`)
      .run(t - 90 * DAY).changes;
    out.proactiveText = db.prepare(`UPDATE mind_proactive SET reason = NULL, intent = NULL, alt_text = NULL,
        voiced_text = CASE WHEN status = 'sent' THEN voiced_text ELSE NULL END
      WHERE created_at < ? AND status NOT IN ('drafting', 'queued')
        AND (reason IS NOT NULL OR intent IS NOT NULL OR alt_text IS NOT NULL OR (voiced_text IS NOT NULL AND status != 'sent'))`)
      .run(d7).changes;
    out.audience = db.prepare(`UPDATE mind_proactive SET audience_json = NULL
      WHERE audience_json IS NOT NULL AND status IN (${marks(TERMINAL_DRAFT.length)})`).run(...TERMINAL_DRAFT).changes;

    out.episodeLog = db.prepare('DELETE FROM mind_episode_log WHERE COALESCE(updated_at, 0) < ?').run(t - 30 * DAY).changes;
    out.nights = db.prepare('DELETE FROM mind_nights WHERE night_key < ?').run(localDateKey(t - 400 * DAY)).changes;
    return out;
  })();
}

/** One cheap read of every mind table (degraded-state recovery, research R9). Throws on failure. */
export function selfCheck() {
  const db = getDb();
  for (const t of ['mind_state', 'mind_settings', 'mind_runs', 'mind_nights', 'mind_chat_activity', 'mind_digests',
    'mind_episode_cursor', 'mind_episode_log', 'mind_self_state', 'mind_self_model', 'mind_nudges', 'mind_proactive',
    'mind_exclusions']) {
    db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
  }
  return true;
}

// ── identity changes: rekey (merge / record / reassign) and DM-row deletion ──

function rewriteOrigins(json, from, to) {
  const list = parseJson(json, null);
  if (!Array.isArray(list)) return null;
  const merged = new Map();
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const jid = o.originJid === from ? to : o.originJid;
    const prev = merged.get(jid);
    const floor = o.minLearnedAt ?? null;
    if (!prev) merged.set(jid, { ...o, originJid: jid });
    else {
      // Merging two origins keeps the earlier evidence time: an earlier floor is stricter.
      const a = prev.minLearnedAt ?? null;
      prev.minLearnedAt = a === null || floor === null ? null : Math.min(a, floor);
    }
  }
  return JSON.stringify([...merged.values()]);
}

function rekeyChat(db, from, to) {
  const out = { activity: 0, digests: 0, cursor: 0, episodeLog: 0, proactive: 0, elements: 0, origins: 0, exclusions: 0 };
  if (!from || !to || from === to) return out;

  // plan 020 B: his stances' evidence follows the identity, so a later purge or audience check finds it.
  db.prepare('UPDATE self_stance_evidence SET origin_jid = ? WHERE origin_jid = ?').run(to, from);
  db.prepare('UPDATE self_stance_evidence SET subject_jid = ? WHERE subject_jid = ?').run(to, from);

  // mind_chat_activity: a clash on (to, day) sums the counters.
  for (const r of db.prepare('SELECT * FROM mind_chat_activity WHERE chat_jid = ?').all(from)) {
    const clash = db.prepare('SELECT 1 FROM mind_chat_activity WHERE chat_jid = ? AND day_key = ?').get(to, r.day_key);
    if (clash) {
      db.prepare(`UPDATE mind_chat_activity SET ${ACTIVITY_COUNTERS.map(c => `${c} = ${c} + ?`).join(', ')},
          last_human_at = MAX(COALESCE(last_human_at, 0), COALESCE(?, 0)), last_bot_at = MAX(COALESCE(last_bot_at, 0), COALESCE(?, 0))
        WHERE chat_jid = ? AND day_key = ?`)
        .run(...ACTIVITY_COUNTERS.map(c => r[c] || 0), r.last_human_at, r.last_bot_at, to, r.day_key);
      db.prepare('DELETE FROM mind_chat_activity WHERE chat_jid = ? AND day_key = ?').run(from, r.day_key);
    } else {
      db.prepare('UPDATE mind_chat_activity SET chat_jid = ? WHERE chat_jid = ? AND day_key = ?').run(to, from, r.day_key);
    }
    out.activity++;
  }

  out.digests = db.prepare('UPDATE mind_digests SET chat_jid = ? WHERE chat_jid = ?').run(to, from).changes;

  // mind_episode_cursor: keep the larger cursors.
  const fc = db.prepare('SELECT * FROM mind_episode_cursor WHERE chat_jid = ?').get(from);
  if (fc) {
    bumpCursor(db, to, { lastRowid: fc.last_rowid, digestRowid: fc.digest_rowid });
    const tc = db.prepare('SELECT last_night_key FROM mind_episode_cursor WHERE chat_jid = ?').get(to);
    if (fc.last_night_key && (!tc.last_night_key || fc.last_night_key > tc.last_night_key)) {
      db.prepare('UPDATE mind_episode_cursor SET last_night_key = ? WHERE chat_jid = ?').run(fc.last_night_key, to);
    }
    db.prepare('DELETE FROM mind_episode_cursor WHERE chat_jid = ?').run(from);
    out.cursor = 1;
  }

  // mind_episode_log: on a clash a never-rebuild outcome wins.
  for (const r of db.prepare('SELECT * FROM mind_episode_log WHERE chat_jid = ?').all(from)) {
    const clash = db.prepare('SELECT * FROM mind_episode_log WHERE chat_jid = ? AND night_key = ?').get(to, r.night_key);
    if (!clash) {
      db.prepare('UPDATE mind_episode_log SET chat_jid = ? WHERE chat_jid = ? AND night_key = ?').run(to, from, r.night_key);
    } else {
      if (isSticky(r) && !isSticky(clash)) {
        db.prepare(`UPDATE mind_episode_log SET outcome = ?, cause = ?, rebuild_requested = 0, updated_at = ?
          WHERE chat_jid = ? AND night_key = ?`).run(r.outcome, r.cause, nowSec(), to, r.night_key);
      }
      db.prepare('DELETE FROM mind_episode_log WHERE chat_jid = ? AND night_key = ?').run(from, r.night_key);
    }
    out.episodeLog++;
  }

  // mind_proactive: one queued row per chat — a second one for `to` is dropped first.
  if (db.prepare(`SELECT 1 FROM mind_proactive WHERE chat_jid = ? AND status = 'queued'`).get(to)) {
    db.prepare(`UPDATE mind_proactive SET status = 'dropped', drop_reason = 'identity_changed'
      WHERE chat_jid = ? AND status = 'queued'`).run(from);
  }
  out.proactive = db.prepare('UPDATE mind_proactive SET chat_jid = ? WHERE chat_jid = ?').run(to, from).changes
    + db.prepare('UPDATE mind_proactive SET person_jid = ? WHERE person_jid = ?').run(to, from).changes;

  out.elements = db.prepare('UPDATE mind_self_state SET target_chat = ? WHERE target_chat = ?').run(to, from).changes;

  // origins_json inside self-state elements and drafts.
  const needle = JSON.stringify(from);
  for (const table of ['mind_self_state', 'mind_proactive']) {
    for (const r of db.prepare(`SELECT id, origins_json FROM ${table} WHERE instr(origins_json, ?) > 0`).all(needle)) {
      const next = rewriteOrigins(r.origins_json, from, to);
      if (next !== null && next !== r.origins_json) {
        db.prepare(`UPDATE ${table} SET origins_json = ? WHERE id = ?`).run(next, r.id);
        out.origins++;
      }
    }
  }

  // mind_exclusions: move to `to`; on a clash the stronger source wins.
  for (const r of db.prepare('SELECT * FROM mind_exclusions WHERE jid = ?').all(from)) {
    const clash = db.prepare('SELECT * FROM mind_exclusions WHERE kind = ? AND jid = ?').get(r.kind, to);
    if (!clash) {
      db.prepare('UPDATE mind_exclusions SET jid = ? WHERE id = ?').run(to, r.id);
    } else {
      if (SOURCE_RANK[r.source] > SOURCE_RANK[clash.source]) {
        db.prepare('UPDATE mind_exclusions SET source = ?, msg_id = ?, p = ?, cleared_at = ?, note = COALESCE(note, ?) WHERE id = ?')
          .run(r.source, r.msg_id, r.p, r.cleared_at, r.note, clash.id);
      }
      db.prepare('DELETE FROM mind_exclusions WHERE id = ?').run(r.id);
    }
    out.exclusions++;
  }
  return out;
}

function deleteDmRowsImpl(db, forms, { keepDraftIds = [] } = {}) {
  const list = asList(forms);
  const out = { activity: 0, digests: 0, cursor: 0, episodeLog: 0, proactive: 0, elements: 0 };
  if (!list.length) return out;
  const m = marks(list.length);
  db.prepare(`DELETE FROM self_stance_evidence WHERE origin_jid IN (${m}) OR subject_jid IN (${m})`).run(...list, ...list);
  out.activity = db.prepare(`DELETE FROM mind_chat_activity WHERE chat_jid IN (${m})`).run(...list).changes;
  const digestIds = db.prepare(`SELECT id FROM mind_digests WHERE chat_jid IN (${m})`).pluck().all(...list);
  for (let i = 0; i < digestIds.length; i += 500) {
    const chunk = digestIds.slice(i, i + 500);
    db.prepare(`DELETE FROM item_evidence WHERE item_type = 'mind_digest' AND item_id IN (${marks(chunk.length)})`).run(...chunk);
    db.prepare(`DELETE FROM mind_digests WHERE id IN (${marks(chunk.length)})`).run(...chunk);
  }
  out.digests = digestIds.length;
  out.cursor = db.prepare(`DELETE FROM mind_episode_cursor WHERE chat_jid IN (${m})`).run(...list).changes;
  out.episodeLog = db.prepare(`DELETE FROM mind_episode_log WHERE chat_jid IN (${m})`).run(...list).changes;
  const keep = keepDraftIds.map(Number).filter(Number.isFinite);
  out.proactive = db.prepare(`DELETE FROM mind_proactive WHERE (chat_jid IN (${m}) OR person_jid IN (${m}))
    ${keep.length ? `AND id NOT IN (${marks(keep.length)})` : ''}`).run(...list, ...list, ...keep).changes;
  const quoted = list.map(f => JSON.stringify(f));
  out.elements = db.prepare(`UPDATE mind_self_state SET status = 'superseded' WHERE status = 'active'
    AND (target_chat IN (${m}) OR ${quoted.map(() => 'instr(origins_json, ?) > 0').join(' OR ')})`)
    .run(...list, ...quoted).changes;
  return out;
}

/**
 * Delete the mind rows keyed by a person's DM (purge, research R9): activity,
 * digests (+ their evidence), cursor, episode log and proactive rows of those
 * chat forms; self-state elements targeting or originating in it → 'superseded'.
 * Exclusions are kept. Runs on `db` (inside the caller's transaction); errors
 * propagate. → counts
 */
export function deleteDmRows(db, forms) {
  return deleteDmRowsImpl(db || getDb(), forms);
}

function previousOwnerOf(db, jid) {
  const row = db.prepare(`SELECT payload_json FROM dashboard_audit WHERE action = 'identity.reassign' AND target = ?
    ORDER BY id DESC LIMIT 1`).get(jid);
  const from = parseJson(row?.payload_json, null)?.from;
  return typeof from === 'string' && from ? from : null;
}

/**
 * Apply an identity change from identity.onIdentityChange to the mind tables
 * (research R9), in one transaction:
 *   { type:'merge', keepJid, dropJid } — every row keyed by dropJid moves to keepJid
 *     (activity counters summed, larger cursors kept, origins_json rewritten,
 *     exclusions moved with the stronger source winning);
 *   { type:'record', jid, personJid } — the same re-key from the raw form;
 *   { type:'reassign', jid, personJid, prevOwnerJid? } — a recycled number: its
 *     drafting/queued drafts → dropped:'identity_changed' (text nulled), its other
 *     DM-keyed rows deleted, and every exclusion of the number or its previous
 *     owner copied to both people (fail closed). The previous owner comes from
 *     `prevOwnerJid` or the identity.reassign audit row.
 * Errors propagate (hooks.js wraps them, since identity.js swallows listener errors).
 * → counts
 */
export function rekey(change = {}) {
  const db = getDb();
  return db.transaction(() => {
    if (change.type === 'merge') return { type: 'merge', ...rekeyChat(db, change.dropJid, change.keepJid) };
    if (change.type === 'record') return { type: 'record', ...rekeyChat(db, change.jid, change.personJid) };
    if (change.type === 'reassign') {
      const jid = change.jid;
      const person = change.personJid;
      if (!jid) return { type: 'reassign' };
      // Pending drafts stay as an inert dropped record (text nulled); the rest of the DM's rows go.
      const pending = db.prepare(`SELECT id FROM mind_proactive WHERE (chat_jid = ? OR person_jid = ?)
        AND status IN ('drafting', 'queued')`).pluck().all(jid, jid);
      const dropped = pending.length
        ? db.prepare(`UPDATE mind_proactive SET status = 'dropped', drop_reason = 'identity_changed', ${PROACTIVE_TEXT_NULL}
            WHERE id IN (${marks(pending.length)})`).run(...pending).changes
        : 0;
      const deleted = deleteDmRowsImpl(db, [jid], { keepDraftIds: pending });
      const prev = change.prevOwnerJid || previousOwnerOf(db, jid);
      const people = [...new Set([prev, person].filter(Boolean))];
      const sources = [...new Set([jid, prev].filter(Boolean))];
      let copied = 0;
      for (const ex of db.prepare(`SELECT * FROM mind_exclusions WHERE kind = 'person' AND jid IN (${marks(sources.length)})`)
        .all(...sources)) {
        if (ex.source === 'owner_cleared') continue;
        for (const p of people) {
          if (p === ex.jid) continue;
          copied += db.prepare(`INSERT OR IGNORE INTO mind_exclusions (kind, jid, source, msg_id, p, note, created_at, created_by)
            VALUES ('person', ?, ?, ?, ?, ?, ?, 'system:identity')`).run(p, ex.source, ex.msg_id, ex.p, ex.note, nowSec()).changes;
        }
      }
      return { type: 'reassign', dropped, ...deleted, exclusionsCopied: copied };
    }
    throw new TypeError(`rekey: unknown change type "${change.type}"`);
  })();
}
