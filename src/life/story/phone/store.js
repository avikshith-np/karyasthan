// Phone store (spec 019) — the ONLY door to story_messages. Synchronous (better-sqlite3),
// static SQL with `?` parameters, rows back camelCase. Writes go through an allow-list;
// an unknown field or a bad enum throws (fail closed). The scan cursor (the last
// world_events id the trigger scan read) and the day's organic roll live in story_state.
//
// Model text is written only after its phone.message commits (worker.commit), so a row
// never holds text for a turn that isn't in the log. Nothing here logs.

import { getDb } from '../../../memory/db.js';
import { sanitizeWebContent } from '../../../brain/webSearch.js';
import { now } from '../../clock.js';
import { getState as storyStateGet, patchState as storyStatePatch } from '../store.js';

const DAY = 86400;

export const STATUSES = Object.freeze(['pending', 'running', 'live', 'skipped', 'superseded', 'reverted']);
export const DIRS = Object.freeze(['out', 'in']);
export const TIERS = Object.freeze(['mouth', 'mind', 'clerk']);
export const TRIGGERS = Object.freeze(['owner', 'reply', 'after_scene', 'birthday', 'news', 'on_my_way', 'romance',
  'evening', 'cast_first', 'desire', 'regenerate', 'backing_out', 'plan_clash']);
export const TONES = Object.freeze(['friendly', 'warm', 'flirty', 'teasing', 'caring', 'excited', 'apologetic', 'casual', 'logistics', 'annoyed', 'naughty']);
export const TEXT_MAX = 300;
export const TOPIC_MAX = 60;
export const RETENTION = Object.freeze({ undoneDays: 30, allDays: 365 });

const stmtCache = new WeakMap();
function q(sql) {
  const db = getDb();
  let cache = stmtCache.get(db);
  if (!cache) { cache = new Map(); stmtCache.set(db, cache); }
  let st = cache.get(sql);
  if (!st) { st = db.prepare(sql); cache.set(sql, st); }
  return st;
}

const nowSec = () => Math.floor(now());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;

function fail(msg) {
  throw new TypeError(`phone store: ${msg}`);
}

/** One stored string: sanitized, '>>>' stripped, spaces collapsed (line breaks = bubbles kept), capped. */
export function cleanStored(v, max) {
  if (typeof v !== 'string') return null;
  const s = sanitizeWebContent(v).replace(/>{3,}/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n+ */g, '\n').trim();
  return s ? s.slice(0, max) : null;
}

function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'fell_back') out.fellBack = v === 1;
    else if (k === 'heavy_window') out.heavyWindow = v === 1;
    else out[camel(k)] = v;
  }
  return out;
}

/** Run fn inside one SQLite transaction (nested → a savepoint). → fn's result */
export function inTransaction(fn) {
  return getDb().transaction(fn)();
}

// ── cursor + day state ───────────────────────────────────────────────────────

/** The trigger scan's cursor (the last world_events id read), or null before the first scan. */
export function getCursor() {
  const v = storyStateGet('phone_cursor');
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export function setCursor(id) {
  if (!Number.isSafeInteger(id) || id < 0) fail('cursor must be a non-negative integer');
  storyStatePatch({ phone_cursor: id });
}

/** Was the phone on at the last job (an off → on re-seeds the cursor)? true | false | null. */
export function getPhoneOn() {
  const v = storyStateGet('phone_on');
  return typeof v === 'boolean' ? v : null;
}

export function setPhoneOn(on) {
  storyStatePatch({ phone_on: on === true });
}

/** The local date whose out-of-the-blue texts were last rolled ('YYYY-MM-DD' | null). */
export function getRolledDate() {
  const v = storyStateGet('phone_rolled');
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export function setRolledDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('bad date');
  storyStatePatch({ phone_rolled: date });
}

// ── what the plan step decided (020 E1) ──
// A small ring of codes, for the sweep: a text that read like a meeting either has a plan, or a logged
// reason it hasn't. `since`: turns older than this were never recorded, so the ring can't speak for them.
export const PLAN_RING_MAX = 150;

export function notePlanOutcome({ eventId, outcome, code, at = nowSec() }) {
  if (!posInt(eventId)) return;
  const cur = storyStateGet('phone_plan_outcomes');
  const entries = Array.isArray(cur?.entries) ? cur.entries.filter(e => e?.id !== eventId) : [];
  entries.push({ id: eventId, o: String(outcome).slice(0, 12), c: String(code ?? '').slice(0, 24), at });
  const kept = entries.slice(-PLAN_RING_MAX);
  // Once the ring has dropped something, it can only speak from its oldest entry on.
  const since = entries.length > kept.length ? kept[0].at : (Number.isSafeInteger(cur?.since) ? cur.since : at);
  storyStatePatch({ phone_plan_outcomes: { since, entries: kept } });
}

/** { since, entries: [{id, o, c, at}] } | null (nothing recorded yet, or a value that doesn't read). */
export function planOutcomes() {
  const v = storyStateGet('phone_plan_outcomes');
  if (!isObj(v) || !Number.isSafeInteger(v.since) || !Array.isArray(v.entries)) return null;
  return { since: v.since, entries: v.entries.filter(e => posInt(e?.id) && typeof e.c === 'string' && typeof e.o === 'string') };
}

export function __dropPlanOutcomeForTest(eventId) {
  const cur = storyStateGet('phone_plan_outcomes');
  storyStatePatch({ phone_plan_outcomes: { ...cur, entries: (cur?.entries ?? []).filter(e => e?.id !== eventId) } });
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * A pending turn; INSERT OR IGNORE (one row per trigger event, member and exchange makes
 * a crash / restart idempotent). → the new row id, or null when it already existed.
 */
export function insertPending({ castId, dir, trigger, triggerEventId = null, exchange = 0, dueAt, replacesId = null,
  createdAt = nowSec(), status = 'pending', skipReason = null } = {}) {
  if (typeof castId !== 'string' || !CAST_ID_RE.test(castId)) fail('bad castId');
  if (!DIRS.includes(dir)) fail('bad dir');
  if (!TRIGGERS.includes(trigger)) fail('bad trigger');
  if (triggerEventId !== null && !posInt(triggerEventId)) fail('bad trigger event');
  if (!Number.isInteger(exchange) || exchange < 0 || exchange > 50) fail('bad exchange');
  if (!posInt(dueAt)) fail('bad dueAt');
  if (status !== 'pending' && status !== 'skipped') fail('a new row is pending or skipped');
  const info = q(`INSERT OR IGNORE INTO story_messages
    (cast_id, dir, status, skip_reason, trigger, trigger_event_id, exchange, due_at, replaces_id, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(castId, dir, status, status === 'skipped' ? String(skipReason ?? 'skipped').slice(0, 48) : null, trigger,
      triggerEventId, exchange, dueAt, posInt(replacesId), createdAt, status === 'skipped' ? createdAt : null);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function getMessage(id) {
  return posInt(id) ? decode(q('SELECT * FROM story_messages WHERE id = ?').get(id)) : null;
}

export function getByEvent(eventId) {
  return posInt(eventId) ? decode(q('SELECT * FROM story_messages WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(eventId)) : null;
}

/** Rows of these phone.message ids (the public reader). */
export function byEventIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(posInt))].slice(0, 2000);
  const out = [];
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    out.push(...q(`SELECT * FROM story_messages WHERE event_id IN (${part.map(() => '?').join(',')})`).all(...part).map(decode));
  }
  return out;
}

/** Any row for this trigger / member / exchange (a trigger is played once). */
export function hasTrigger(trigger, triggerEventId, castId, exchange = 0) {
  return !!q('SELECT 1 FROM story_messages WHERE trigger = ? AND trigger_event_id IS ? AND cast_id = ? AND exchange = ? LIMIT 1')
    .get(trigger, triggerEventId ?? null, castId, exchange);
}

/** Due pending turns, oldest due first. */
export function listDue(at, limit = 5) {
  return q("SELECT * FROM story_messages WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?")
    .all(at, Math.max(1, Math.min(50, limit))).map(decode);
}

/** The earliest pending turn's due time, or null. */
export function nextDueAt() {
  const r = q("SELECT MIN(due_at) AS due FROM story_messages WHERE status = 'pending'").get();
  return Number.isSafeInteger(r?.due) ? r.due : null;
}

/** Pending turns of one member (a newer exchange supersedes nothing; the worker checks). */
export function pendingFor(castId) {
  return q("SELECT * FROM story_messages WHERE status = 'pending' AND cast_id = ? ORDER BY due_at ASC").all(castId).map(decode);
}

const UPDATABLE = {
  status: (v) => (STATUSES.includes(v) ? v : fail('bad status')),
  skipReason: (v) => (v === null ? null : String(v).slice(0, 48)),
  dueAt: (v) => (posInt(v) ?? fail('bad dueAt')),
  tries: (v) => (Number.isInteger(v) && v >= 0 && v < 100 ? v : fail('bad tries')),
  eventId: (v) => (v === null ? null : (posInt(v) ?? fail('bad eventId'))),
  at: (v) => (posInt(v) ?? fail('bad at')),
  text: (v) => (v === null ? null : cleanStored(v, TEXT_MAX)),
  editedText: (v) => (v === null ? null : cleanStored(v, TEXT_MAX)),
  editedAt: (v) => (v === null ? null : (posInt(v) ?? fail('bad editedAt'))),
  tone: (v) => (v === null ? null : (TONES.includes(v) ? v : fail('bad tone'))),
  topic: (v) => (v === null ? null : cleanStored(v, TOPIC_MAX)),
  tier: (v) => (v === null ? null : (TIERS.includes(v) ? v : fail('bad tier'))),
  model: (v) => (v === null ? null : String(v).slice(0, 80)),
  fellBack: (v) => (v ? 1 : 0),
  caller: (v) => (v === null ? null : String(v).slice(0, 48)),
  heavyWindow: (v) => (v ? 1 : 0),
  finishedAt: (v) => (v === null ? null : (posInt(v) ?? fail('bad finishedAt'))),
};
const COLUMN = { skipReason: 'skip_reason', dueAt: 'due_at', eventId: 'event_id', editedText: 'edited_text',
  editedAt: 'edited_at', fellBack: 'fell_back', heavyWindow: 'heavy_window', finishedAt: 'finished_at' };

/** Patch one row (allow-listed fields). opts.fromStatus: only from these statuses. → changed? */
export function update(id, patch = {}, { fromStatus = null } = {}) {
  if (!posInt(id)) fail('bad id');
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(UPDATABLE, k)) fail(`field ${k} is not updatable`);
    sets.push(`${COLUMN[k] ?? k} = ?`);
    vals.push(UPDATABLE[k](v));
  }
  if (!sets.length) return false;
  const from = fromStatus === null ? null : (Array.isArray(fromStatus) ? fromStatus : [fromStatus]);
  if (from && !from.every(x => STATUSES.includes(x))) fail('bad fromStatus');
  const where = from ? ` AND status IN (${from.map(() => '?').join(',')})` : '';
  return q(`UPDATE story_messages SET ${sets.join(', ')} WHERE id = ?${where}`).run(...vals, id, ...(from ?? [])).changes > 0;
}

/** Rows left 'running' by a crash: back to pending (the next job retries once more). */
export function resetRunning() {
  return q("UPDATE story_messages SET status = 'pending', tries = tries + 1 WHERE status = 'running'").run().changes;
}

/** Live rows of one member, newest first (paging: before = an `at`, beforeId = a row id at that `at`). */
export function threadOf(castId, { before = null, beforeId = null, limit = 50, live = false } = {}) {
  const lim = Math.max(1, Math.min(200, limit));
  const statuses = live ? "('live')" : "('live','reverted')";   // a rewritten (superseded) turn is not shown
  if (posInt(before)) {
    return q(`SELECT * FROM story_messages WHERE cast_id = ? AND status IN ${statuses} AND at IS NOT NULL
      AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`)
      .all(castId, before, before, posInt(beforeId) ?? 0, lim).map(decode);
  }
  return q(`SELECT * FROM story_messages WHERE cast_id = ? AND status IN ${statuses} AND at IS NOT NULL
    ORDER BY at DESC, id DESC LIMIT ?`).all(castId, lim).map(decode);
}

/** One summary row per member with a live text: { castId, count, lastAt }. */
export function threadSummaries() {
  return q(`SELECT cast_id AS castId, COUNT(*) AS count, MAX(at) AS lastAt FROM story_messages
    WHERE status = 'live' AND at IS NOT NULL GROUP BY cast_id ORDER BY lastAt DESC LIMIT 100`).all();
}

/** The newest live row of a member, or null. */
export function lastLive(castId) {
  return decode(q("SELECT * FROM story_messages WHERE cast_id = ? AND status = 'live' ORDER BY at DESC, id DESC LIMIT 1").get(castId));
}

/** Live rows since `since` (all members), newest first. */
export function listLive({ since = 0, limit = 50 } = {}) {
  return q("SELECT * FROM story_messages WHERE status = 'live' AND at >= ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(since, Math.max(1, Math.min(500, limit))).map(decode);
}

/** Today's turns written (live or since reverted) per member + organic starts. */
export function countsSince(since) {
  const rows = q(`SELECT cast_id AS castId, trigger, COUNT(*) AS n FROM story_messages
    WHERE at >= ? AND status IN ('live','reverted','superseded') GROUP BY cast_id, trigger`).all(since);
  const perCast = {};
  let organic = 0;
  for (const r of rows) {
    perCast[r.castId] = (perCast[r.castId] ?? 0) + r.n;
    if (!['owner', 'reply', 'regenerate', 'plan_clash'].includes(r.trigger)) organic += r.n;
  }
  return { perCast, organic };
}

/** Starts queued today but not yet written (so a roll doesn't overshoot the organic cap). */
export function pendingOrganic() {
  return q(`SELECT COUNT(*) AS n FROM story_messages WHERE status IN ('pending','running')
    AND trigger NOT IN ('owner','reply','regenerate')`).get().n;
}

/** The phone.message left the log → this live row is reverted and its text gone (a superseded one has none). */
export function markReverted(eventId) {
  if (!posInt(eventId)) return 0;
  return q(`UPDATE story_messages SET status = 'reverted', text = NULL, edited_text = NULL, topic = NULL
    WHERE event_id = ? AND status = 'live'`).run(eventId).changes;
}

/** The sweep: every live row whose event `gone(id)` says left the log. → count */
export function sweep(gone) {
  let n = 0;
  const rows = q("SELECT id, event_id FROM story_messages WHERE status = 'live' AND event_id IS NOT NULL").all();
  for (const r of rows) if (gone(r.event_id)) n += markReverted(r.event_id);
  return n;
}

/** Pending turns whose trigger event left the log are dropped (a reverted ask, a reverted text). */
export function dropPendingFor(gone) {
  let n = 0;
  const rows = q("SELECT id, trigger_event_id FROM story_messages WHERE status = 'pending' AND trigger_event_id IS NOT NULL").all();
  for (const r of rows) {
    if (gone(r.trigger_event_id)) {
      n += q("UPDATE story_messages SET status = 'skipped', skip_reason = 'trigger_gone', finished_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowSec(), r.id).changes;
    }
  }
  return n;
}

export function setEditedText(id, text, at = nowSec()) {
  if (!posInt(id)) fail('bad id');
  const v = text === null || text === '' ? null : cleanStored(text, TEXT_MAX);
  return q("UPDATE story_messages SET edited_text = ?, edited_at = ? WHERE id = ? AND status = 'live'").run(v, v ? at : null, id).changes > 0;
}

/** Retention: undone / skipped rows after 30 days, everything after a year. */
export function prune(at = nowSec()) {
  q(`DELETE FROM story_messages WHERE status IN ('skipped','reverted','superseded') AND created_at < ?`).run(at - RETENTION.undoneDays * DAY);
  q('DELETE FROM story_messages WHERE created_at < ?').run(at - RETENTION.allDays * DAY);
}

/** Pending turns waiting (status). */
export function countPending() {
  return q("SELECT COUNT(*) AS n FROM story_messages WHERE status = 'pending'").get().n;
}
