// The weekly review's store (plan 020 E4). Code only, no model call: each week a sample of what the
// writers wrote (scenes, phone texts, thoughts, dreams) goes into a queue the owner marks PASS / FAIL.
//
//   - A row is a pointer. The words are read from the source each time, so an output that was
//     reverted, swept or superseded simply leaves the queue, and its text goes with it.
//   - Real people never: a real person's scene is a code template about him (mode self_only), and
//     anything that came from a chat (origin not self / owner) isn't sampled.
//   - Private: anything the log doesn't call tame, and a writer output whose heat is unknown (fails
//     closed). The queue never carries that text: it comes one at a time, on a tap (textOf), and
//     never in an export.
//   - A mark is once: the same mark again is a no-op, a different one is refused (undo it first).
import crypto from 'crypto';
import { getDb } from './db.js';
import { config } from '../utils/config.js';
import { now as clockNow, resolveTimezone, dateKey, dayStart, addDays, weekday } from '../life/clock.js';

export const SURFACES = Object.freeze(['scene', 'phone', 'thought', 'dream']);
export const SAMPLE_PER_SURFACE = 25;     // the plan's 20–30
export const NOTE_CODES = Object.freeze(['voice', 'repetitive', 'continuity', 'time', 'invented', 'ai_tell', 'too_long', 'flat', 'register', 'other']);
export const TEXT_MAX = 20_000;           // what one card carries, whatever the source holds
const BACKFILL_WEEKS = 2;                 // finished weeks caught up after downtime
const STATS_WEEKS = 12;
const OPEN_MAX_SEC = 12 * 7 * 86400;      // how long an unmarked card waits
const SHOWN_HEAT = new Set(['tame']);
const JID_RE = /@(s\.whatsapp\.net|g\.us|lid)\b/i;

const tz = () => resolveTimezone(config.timezone);
const db = () => getDb();

/** Monday 00:00 of `at`'s week in the bot's time zone → { week: 'YYYY-Www', from, to }. */
export function weekOf(at = clockNow()) {
  const z = tz();
  const from = addDays(dayStart(at, z), -((weekday(at, z) + 6) % 7), z);
  const [y, m, d] = dateKey(from, z).split('-').map(Number);
  const thu = new Date(Date.UTC(y, m - 1, d + 3));
  const yearStart = Date.UTC(thu.getUTCFullYear(), 0, 1);
  const n = Math.ceil(((thu.getTime() - yearStart) / 86400000 + 1) / 7);
  return { week: `${thu.getUTCFullYear()}-W${String(n).padStart(2, '0')}`, from, to: addDays(from, 7, z) };
}

// ── the surfaces ──
// `pick`: what may be sampled in a time range. `live`: the same rules for one row, right now, so
// anything that stopped qualifying since it was sampled is gone from the queue.
const SCENE_OK = `status IN ('done','fallback') AND text IS NOT NULL AND subject_jid IS NULL
  AND COALESCE(mode, '') <> 'self_only' AND COALESCE(origin_kind, 'self') IN ('self','owner')`;
// No tier: the owner's own words. No caller: the code line standing in for a model turn, which holds the owner's words too.
const PHONE_OK = `status = 'live' AND text IS NOT NULL AND tier IS NOT NULL AND caller IS NOT NULL`;
const THOUGHT_OK = `text IS NOT NULL AND origin_kind IN ('self','owner')`;
const DREAM_OK = `status = 'live' AND text IS NOT NULL AND needs_words = 0`;

const SOURCE = {
  scene: {
    pick: `SELECT id, ended_at AS at, NULL AS phrase FROM story_scenes WHERE ${SCENE_OK} AND ended_at >= ? AND ended_at < ?`,
    live: `SELECT id, text, ended_at AS at, tier, caller, event_id AS eventId, sheet_json AS sheet FROM story_scenes WHERE id = ? AND ${SCENE_OK}`,
    open: `SELECT id, event_id FROM story_scenes WHERE ${SCENE_OK}`,
  },
  phone: {
    pick: `SELECT id, at, NULL AS phrase FROM story_messages WHERE ${PHONE_OK} AND at >= ? AND at < ?`,
    live: `SELECT id, text, at, tier, caller, tone, event_id AS eventId, cast_id AS castId, dir FROM story_messages WHERE id = ? AND ${PHONE_OK}`,
    open: `SELECT id, event_id FROM story_messages WHERE ${PHONE_OK}`,
  },
  thought: {
    pick: `SELECT id, at, phrase_key AS phrase FROM story_thoughts WHERE ${THOUGHT_OK} AND at >= ? AND at < ?`,
    // A real thought (F3) is a model's words, the stream's are code's; the card says which.
    live: `SELECT id, text, at, family, CASE WHEN dedupe_key LIKE 'real:%' THEN 'mouth' ELSE 'code' END AS tier FROM story_thoughts WHERE id = ? AND ${THOUGHT_OK}`,
    open: `SELECT id, NULL AS event_id FROM story_thoughts WHERE ${THOUGHT_OK}`,
  },
  dream: {
    pick: `SELECT id, at, phrase_key AS phrase FROM story_dreams WHERE ${DREAM_OK} AND at >= ? AND at < ?`,
    live: `SELECT id, text, at, tier, tone, recall, event_id AS eventId FROM story_dreams WHERE id = ? AND ${DREAM_OK}`,
    open: `SELECT id, event_id FROM story_dreams WHERE ${DREAM_OK}`,
  },
};

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Choose `need` rows, spread over the week's days: a stable shuffle (same week, same order), one
 * per day in turn, and a phrase already taken only once every other phrase has had its turn.
 */
export function choose(rows, need, { week, surface }) {
  const ranked = rows.map((r) => ({ ...r, rank: hash(`${week}:${surface}:${r.id}`) })).sort((a, b) => (a.rank < b.rank ? -1 : 1));
  const seen = new Set();
  const first = [];
  const repeats = [];
  for (const r of ranked) {
    if (r.phrase && seen.has(r.phrase)) { repeats.push(r); continue; }
    if (r.phrase) seen.add(r.phrase);
    first.push(r);
  }
  const day = (r) => dateKey(r.at, tz());
  const days = new Map();
  for (const r of first) { if (!days.has(day(r))) days.set(day(r), []); days.get(day(r)).push(r); }
  const out = [];
  while (out.length < need && days.size) {
    for (const [k, list] of days) {
      if (out.length >= need) break;
      out.push(list.shift());
      if (!list.length) days.delete(k);
    }
  }
  return [...out, ...repeats].slice(0, need);
}

/** Fill a week's queue up to the sample size per surface. Safe to repeat. → how many were added. */
export function sampleWeek({ week, from, to }, { at = clockNow(), closed = false } = {}) {
  const d = db();
  let added = 0;
  d.transaction(() => {
    for (const surface of SURFACES) {
      const have = d.prepare('SELECT COUNT(*) AS n FROM review_items WHERE week = ? AND surface = ?').get(week, surface).n;
      const need = SAMPLE_PER_SURFACE - have;
      if (need <= 0) continue;
      const taken = new Set(d.prepare('SELECT source_id AS id FROM review_items WHERE surface = ?').all(surface).map((r) => r.id));
      const rows = d.prepare(SOURCE[surface].pick).all(from, to).filter((r) => !taken.has(r.id));
      for (const r of choose(rows, need, { week, surface })) {
        added += d.prepare(`INSERT OR IGNORE INTO review_items (week, surface, source_id, rank, sampled_at) VALUES (?, ?, ?, ?, ?)`)
          .run(week, surface, r.id, r.rank, at).changes;
      }
    }
    d.prepare(`INSERT INTO review_weeks (week, closed, sampled_at) VALUES (?, ?, ?)
      ON CONFLICT(week) DO UPDATE SET closed = MAX(closed, excluded.closed), sampled_at = excluded.sampled_at`).run(week, closed ? 1 : 0, at);
  })();
  return added;
}

/** A card nobody marked for twelve weeks is dropped, so a neglected queue can't grow for ever. A mark is never dropped. */
export function expireOpen(at = clockNow()) {
  return db().prepare('DELETE FROM review_items WHERE verdict IS NULL AND sampled_at < ?').run(at - OPEN_MAX_SEC).changes;
}

/** The finished weeks that haven't had their sample (the timer's job). → how many were added. */
export function ensureWeeks(at = clockNow()) {
  expireOpen(at);
  const z = tz();
  let added = 0;
  let cursor = weekOf(at).from;
  for (let i = 0; i < BACKFILL_WEEKS; i++) {
    cursor = addDays(cursor, -7, z);
    const w = weekOf(cursor);
    const row = db().prepare('SELECT closed FROM review_weeks WHERE week = ?').get(w.week);
    if (!row || !row.closed) added += sampleWeek(w, { at, closed: true });
  }
  return added;
}

/** This week so far, for an owner who doesn't want to wait for Monday. */
export const sampleCurrentWeek = (at = clockNow()) => {
  const w = weekOf(at);
  return { week: w.week, added: sampleWeek(w, { at, closed: false }) };
};

// ── reading ──
// The source's own status catches up at the next tick; a revert or a redaction counts right away.
// A call over many items reads the reverts once and passes them in, so its cost doesn't grow as open items × reverts.
const revertedEvents = () => new Set(db().prepare(`SELECT json_extract(payload_json, '$.targetId') AS id FROM world_events WHERE type = 'event.reverted'`).all().map((r) => r.id));

function eventGone(eventId, reverted = null) {
  if (!Number.isSafeInteger(eventId)) return false;
  const row = db().prepare('SELECT redacted FROM world_events WHERE id = ?').get(eventId);
  if (row?.redacted) return true;
  if (reverted) return reverted.has(eventId);
  return !!db().prepare(`SELECT 1 FROM world_events WHERE type = 'event.reverted' AND json_extract(payload_json, '$.targetId') = ? LIMIT 1`).get(eventId);
}

function liveRow(item, reverted = null) {
  const row = db().prepare(SOURCE[item.surface].live).get(item.source_id);
  return row && !eventGone(row.eventId, reverted) ? row : null;
}

/** Every unmarked item whose output is still live: one query per surface, whatever the queue's size. */
function liveOpen(reverted) {
  const out = [];
  for (const surface of SURFACES) {
    const rows = db().prepare(`SELECT i.id, i.week, i.rank, i.surface, s.event_id AS eventId FROM review_items i
      JOIN (${SOURCE[surface].open}) s ON s.id = i.source_id
      LEFT JOIN world_events e ON e.id = s.event_id
      WHERE i.verdict IS NULL AND i.surface = ? AND COALESCE(e.redacted, 0) = 0`).all(surface);
    for (const r of rows) if (!reverted.has(r.eventId)) out.push(r);
  }
  return out;
}

function eventPayload(eventId) {
  if (!Number.isSafeInteger(eventId)) return null;
  const row = db().prepare('SELECT payload_json AS p, redacted FROM world_events WHERE id = ?').get(eventId);
  if (!row || row.redacted) return null;
  try { return JSON.parse(row.p); } catch { return null; }
}

/** Fails closed: only what the log calls tame (or a code-built line) shows without a tap. */
export function isPrivate(surface, row, payload) {
  if (surface === 'thought' || surface === 'dream') return false;
  if (/desire/i.test(String(row.caller ?? '')) || row.tone === 'naughty') return true;
  const heat = payload?.heat;
  if (heat == null) return row.tier !== 'code';
  return !SHOWN_HEAT.has(heat);
}

const clip = (text) => {
  const s = String(text ?? '');
  return s.length > TEXT_MAX ? { text: s.slice(0, TEXT_MAX), truncated: true, length: s.length } : { text: s, truncated: false, length: s.length };
};

function card(item, row, castName) {
  const payload = eventPayload(row.eventId);
  const priv = isPrivate(item.surface, row, payload);
  const castIds = Array.isArray(payload?.castIds) ? payload.castIds : row.castId ? [row.castId] : [];
  const { text, truncated, length } = clip(row.text);
  return {
    id: item.id, sourceId: item.source_id, week: item.week, surface: item.surface, at: row.at, tier: row.tier ?? null, private: priv,
    who: [...new Set(castIds.map((id) => castName(id)))], dir: row.dir ?? null, kind: row.family ?? row.recall ?? null,
    length, truncated, text: priv ? null : text,
  };
}

/** The next cards: oldest week first, in the sample's stable order, leaving out what the page holds. */
export function queue({ limit = 12, exclude = [], castName = (id) => id } = {}) {
  const held = new Set(exclude);
  const reverted = revertedEvents();
  const open = liveOpen(reverted);
  const next = open.filter((r) => !held.has(r.id))
    .sort((a, b) => (a.week === b.week ? (a.rank < b.rank ? -1 : 1) : (a.week < b.week ? -1 : 1)));
  const cards = [];
  for (const { id } of next) {
    if (cards.length >= limit) break;
    const item = db().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
    const row = item && liveRow(item, reverted);
    if (row) cards.push(card(item, row, castName));
  }
  return { cards, left: open.length };
}

/** One output's words, on a tap. */
export function textOf(id) {
  const item = db().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
  if (!item) return { error: 'not_found' };
  const row = liveRow(item);
  if (!row) return { error: 'gone' };
  return clip(row.text);
}

/** → { ok, already? } | { error: 'not_found' | 'gone' | 'bad_verdict' | 'bad_note' | 'already_marked', verdict? } */
export function mark(id, { verdict, note = null, at = clockNow() } = {}) {
  if (verdict !== 'pass' && verdict !== 'fail') return { error: 'bad_verdict' };
  if (note != null && !NOTE_CODES.includes(note)) return { error: 'bad_note' };
  const item = db().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
  if (!item) return { error: 'not_found' };
  if (item.verdict === verdict) return { ok: true, already: true, surface: item.surface };
  if (item.verdict) return { error: 'already_marked', verdict: item.verdict };
  if (!liveRow(item)) return { error: 'gone' };
  db().prepare('UPDATE review_items SET verdict = ?, note_code = ?, marked_at = ? WHERE id = ? AND verdict IS NULL').run(verdict, note, at, id);
  return { ok: true, surface: item.surface };
}

/** Back in the queue. → { ok, was } | { error }. Undoing what isn't marked is a no-op. */
export function unmark(id) {
  const item = db().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
  if (!item) return { error: 'not_found' };
  db().prepare('UPDATE review_items SET verdict = NULL, note_code = NULL, marked_at = NULL WHERE id = ?').run(id);
  return { ok: true, was: item.verdict ?? null, surface: item.surface };
}

const rate = (pass, fail) => (pass + fail ? Math.round((pass / (pass + fail)) * 1000) / 1000 : null);

/** Counts and pass rates by week and surface; a mark stays counted after its output was undone. */
export function stats() {
  const weeks = db().prepare('SELECT DISTINCT week FROM review_items ORDER BY week DESC LIMIT ?').all(STATS_WEEKS).map((r) => r.week);
  const liveItems = liveOpen(revertedEvents());
  const liveBy = new Map();
  for (const r of liveItems) liveBy.set(`${r.week}|${r.surface}`, (liveBy.get(`${r.week}|${r.surface}`) ?? 0) + 1);
  const rows = [];
  for (const week of weeks) {
    for (const surface of SURFACES) {
      const items = db().prepare('SELECT * FROM review_items WHERE week = ? AND surface = ?').all(week, surface);
      if (!items.length) continue;
      const pass = items.filter((i) => i.verdict === 'pass').length;
      const fail = items.filter((i) => i.verdict === 'fail').length;
      const open = items.filter((i) => !i.verdict);
      const left = liveBy.get(`${week}|${surface}`) ?? 0;
      rows.push({ week, surface, sampled: items.length, pass, fail, left, gone: open.length - left, passRate: rate(pass, fail) });
    }
  }
  const totals = SURFACES.map((surface) => {
    const r = rows.filter((x) => x.surface === surface);
    const pass = r.reduce((n, x) => n + x.pass, 0);
    const fail = r.reduce((n, x) => n + x.fail, 0);
    return { surface, pass, fail, passRate: rate(pass, fail) };
  });
  const notes = db().prepare(`SELECT surface, note_code AS note, COUNT(*) AS n FROM review_items
    WHERE verdict = 'fail' AND note_code IS NOT NULL AND week IN (${weeks.map(() => '?').join(',') || "''"}) GROUP BY surface, note_code ORDER BY n DESC`).all(...weeks);
  return { rows, totals, notes, left: liveItems.length, failures: db().prepare("SELECT COUNT(*) AS n FROM review_items WHERE verdict = 'fail'").get().n };
}

/**
 * Failures as stubs for the incident suite (plan 020 E2): the output, its fact sheet where it has
 * one, what was wrong. Private text never leaves, nor does text with a JID in it (it shouldn't
 * exist; if it does, the stub says so instead). These hold his world's names: they belong in
 * data/, and a fixture made from one is renamed before it's committed.
 */
export function failureStubs() {
  const items = db().prepare("SELECT * FROM review_items WHERE verdict = 'fail' ORDER BY week, surface, id").all();
  const reverted = revertedEvents();
  const stubs = items.map((item) => {
    const base = { id: `review-${item.week}-${item.surface}-${item.source_id}`, surface: item.surface, sourceId: item.source_id, week: item.week, markedAt: item.marked_at, note: item.note_code ?? null, expect: 'fail' };
    const row = liveRow(item, reverted);
    if (!row) return { ...base, gone: true, text: null };
    const payload = eventPayload(row.eventId);
    const full = { ...base, at: row.at, eventId: row.eventId ?? null, tier: row.tier ?? null };
    if (isPrivate(item.surface, row, payload)) return { ...full, private: true, text: null };
    const sheet = typeof row.sheet === 'string' ? row.sheet : '';
    if (JID_RE.test(String(row.text)) || JID_RE.test(sheet)) return { ...full, withheld: 'jid', text: null };
    let parsed = null;
    try { parsed = sheet ? JSON.parse(sheet) : null; } catch { parsed = null; }
    return { ...full, text: clip(row.text).text, ...(parsed ? { sheet: parsed } : {}) };
  });
  return { v: 1, kind: 'incident-stubs', source: 'weekly-review', stubs };
}
