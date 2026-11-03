// Origin-preserving reads of the 006 tables for the mind (spec 008, contracts/mind-api.md
// "New src/memory/ helpers"). src/mind/ never runs SQL against messages / memories /
// nicknames / people itself: it reads here (006 tables) and through src/mind/store.js
// (mind tables). Nothing here writes.
//
// - Message reads use the same ELIGIBLE filter as batch learning
//   (learningPipeline.js runBatchAnalysis): reactions, "forget that" / purge-fenced
//   (no_learn) and disappearing (expires_at) rows are never read. test 13 checks the
//   two strings are identical. One exception, for the "don't text me first" check only
//   (a missed opt-out is worse than a missed opener): scanSince also hands back the
//   human lines of disappearing chats that have not expired yet (`rows.ephemeral`, for
//   the code regex only — the pulse never sends them to a model and never counts or
//   learns them), and dontTextLookback reads unexpired disappearing lines too.
// - Chat keys come from chatKeyOf (group → bare JID, DM → canonical person); a DM's
//   rows are matched over every identity form of the person, as runBatchAnalysis does.
// - episodesFor / episodeExists read one chat's own episodes (origin = that chat). They
//   are for the mind's own compress / rebuild bookkeeping, never a prompt surface:
//   prompts read episodes only through recall.js recallEpisodes(audience).
// - nameSet / namesOf / styleStats are code-only (scrubs and checks); they never feed
//   a prompt.
// All SQL is parameterised. Every function fails closed: an error is logged without
// content and returns an empty result.

import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { flattenContent } from '../utils/transcript.js';
import { isGroupJid } from '../utils/jidUtils.js';
import { isBotAddressedInText } from '../utils/mentions.js';
import { getSelfIdDigits } from '../utils/selfIdentity.js';
import { nameTokens } from '../utils/nameTokens.js';
import { chatKeyOf } from './learningPipeline.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid, isSelfJid } from './identity.js';

/** The batch-learning filter, verbatim (learningPipeline.js). Unqualified columns: plain `FROM messages` only. */
export const ELIGIBLE = `message_type != 'reaction' AND COALESCE(no_learn, 0) = 0 AND expires_at IS NULL`;
/** Opt-out detection only: the human disappearing lines that have not expired yet. */
const EPHEMERAL_ONLY = `message_type != 'reaction' AND COALESCE(no_learn, 0) = 0
  AND expires_at IS NOT NULL AND expires_at > unixepoch() AND COALESCE(is_from_self, 0) = 0`;

const SCAN_TEXT_MAX = 500;     // pulse prefilter text (code regex only)
const LINE_TEXT_MAX = 300;     // clerk digest input lines (research R6)
const LOOKBACK_MAX = 500;      // rows are capped at 500 chars each; the regex runs on all of them

const marks = (n) => Array(n).fill('?').join(',');
const int = (v, d, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

function issue(where, err) {
  logger.warn({ evt: 'issue', where: `mindReads.${where}`, err: err?.message }, 'mind read failed (fail closed)');
}

/** The stored chat forms of a chat key: group → [jid], DM → every identity form. */
function formsOf(chatJid) {
  if (!chatJid || typeof chatJid !== 'string') return [];
  if (isGroupJid(chatJid)) return [bareJid(chatJid)];
  if (!isPersonJid(chatJid) || isSelfJid(chatJid)) return [];
  const p = resolvePerson(chatJid) || bareJid(chatJid);
  return [...new Set(identitiesOf(p).concat(p ? [p] : []))];
}

function personForms(personJid) {
  if (!personJid || typeof personJid !== 'string' || isSelfJid(personJid)) return [];
  const p = resolvePerson(personJid) || (isPersonJid(personJid) ? bareJid(personJid) : null);
  return p ? [...new Set(identitiesOf(p).concat([p]))] : [];
}

const rawText = (r) => String(flattenContent(r.content, r.message_type) || '').replace(/\s+/g, ' ').trim();
const lineText = (r) => sanitizeWebContent(rawText(r)).replace(/\s+/g, ' ').trim().slice(0, LINE_TEXT_MAX);

function parseMeta(json) {
  try { const v = JSON.parse(json || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** @-mention of one of the bot's own ids (digits set on connect / WA_PHONE_NUMBER), or a persona alias in the text. */
function mentionsBot(row, selfDigits) {
  const jids = parseMeta(row.metadata_json).mentionedJids;
  if (Array.isArray(jids) && selfDigits.size) {
    for (const j of jids) {
      const d = String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      if (d && selfDigits.has(d)) return true;
    }
  }
  try { return isBotAddressedInText(row.content); } catch { return false; }
}

const isBotRow = (r) => !!r.is_from_self || isSelfJid(r.sender_jid);

// ── Message scan (pulse, research R2) ────────────────────────────────────────

/**
 * Eligible messages with rowid > `rowid`, oldest first, at most `limit` (≤ 5000).
 * `text` is flattened and capped at 500 chars for the code prefilter only (not
 * sanitized: it never reaches a prompt from here). Rows whose chat has no key (the
 * bot's own chat, broadcast/status) are left out, but the returned array carries
 * `lastRowid`: the highest rowid read, so the cursor can move past them, and
 * `ephemeral`: the unexpired disappearing human lines of the same window
 * ({ rowid, id, chatJid, isGroup, senderJid, ts, text }), for the opt-out regex only.
 * @returns {Array<{ rowid, id, chatJid, isGroup, senderJid, isFromSelf, ts, text, mentionsBot }> & { lastRowid: number, ephemeral: Array }}
 */
export function scanSince(rowid, limit = 2000) {
  const after = int(rowid, 0, 0, Number.MAX_SAFE_INTEGER);
  const out = [];
  out.lastRowid = after;
  out.ephemeral = [];
  const lim = int(limit, 2000, 1, 5000);
  try {
    const rows = getDb().prepare(`SELECT rowid AS rid, id, group_jid, sender_jid, content, message_type, is_from_self,
        timestamp, metadata_json FROM messages WHERE rowid > ? AND ${ELIGIBLE} ORDER BY rowid LIMIT ?`)
      .all(after, lim);
    const selfDigits = getSelfIdDigits();
    // Opt-out only (see the header): unexpired disappearing human lines in the same rowid
    // window, for the code regex. Never counted, never learned, never sent to a model.
    // A full page caps the window at its last rowid (the cursor stops there); a short
    // page read every eligible row, so the window is open and the cursor may move past
    // the disappearing lines read here.
    const top = rows.length >= lim ? rows[rows.length - 1].rid : null;
    const eph = getDb().prepare(`SELECT rowid AS rid, id, group_jid, sender_jid, content, message_type, timestamp
        FROM messages WHERE rowid > ? ${top === null ? '' : 'AND rowid <= ?'} AND ${EPHEMERAL_ONLY} ORDER BY rowid LIMIT ?`)
      .all(...(top === null ? [after] : [after, top]), lim);
    // A full disappearing page caps the eligible rows too, so neither kind is skipped.
    const cap = eph.length >= lim ? eph[eph.length - 1].rid : Infinity;
    for (const r of eph) {
      out.lastRowid = Math.max(out.lastRowid, r.rid);
      if (isSelfJid(r.sender_jid)) continue;
      const chatJid = chatKeyOf(r.group_jid);
      const text = rawText(r).slice(0, SCAN_TEXT_MAX);
      if (!chatJid || !text) continue;
      out.ephemeral.push({ rowid: r.rid, id: r.id, chatJid, isGroup: isGroupJid(chatJid),
        senderJid: resolvePerson(r.sender_jid) || bareJid(r.sender_jid) || r.sender_jid, ts: r.timestamp, text });
    }
    for (const r of rows) {
      if (r.rid > cap) break;
      out.lastRowid = Math.max(out.lastRowid, r.rid);
      const chatJid = chatKeyOf(r.group_jid);
      if (!chatJid) continue;
      out.push({
        rowid: r.rid, id: r.id, chatJid, isGroup: isGroupJid(chatJid),
        senderJid: isBotRow(r) ? r.sender_jid : (resolvePerson(r.sender_jid) || bareJid(r.sender_jid) || r.sender_jid),
        isFromSelf: isBotRow(r), ts: r.timestamp, text: rawText(r).slice(0, SCAN_TEXT_MAX),
        mentionsBot: !isBotRow(r) && mentionsBot(r, selfDigits),
      });
    }
  } catch (err) {
    issue('scanSince', err);
    const empty = [];
    empty.ephemeral = [];
    empty.lastRowid = after;   // never advance the cursor past rows that were not read
    return empty;
  }
  return out;
}

// ── Digest input (research R6) ───────────────────────────────────────────────

const LINE_COLS = 'rowid AS rid, id, sender_jid, content, message_type, is_from_self, timestamp';

/**
 * One chat's eligible lines after `afterRowid` (newest `limit` kept, returned oldest
 * first) plus up to `contextLines` eligible lines before the first of them, the same
 * two queries as runBatchAnalysis. Text is flattened, sanitized, whitespace-collapsed
 * and capped at 300; lines with no text are dropped. `maxRowid` is the highest rowid
 * among the eligible rows read for `lines` (empty-text ones included), for the
 * digest cursor; null when there were none.
 * @returns {{ lines: Array<{rowid,id,senderJid,isFromSelf,ts,text}>, context: Array<…>, maxRowid: number|null }}
 */
export function eligibleLines(chatJid, { afterRowid = 0, limit = 120, contextLines = 10 } = {}) {
  const empty = { lines: [], context: [], maxRowid: null };
  try {
    const forms = formsOf(chatJid);
    if (!forms.length) return empty;
    const inChat = `group_jid IN (${marks(forms.length)})`;
    const db = getDb();
    const fresh = db.prepare(`SELECT ${LINE_COLS} FROM messages WHERE ${inChat} AND rowid > ? AND ${ELIGIBLE}
      ORDER BY rowid DESC LIMIT ?`).all(...forms, int(afterRowid, 0, 0, Number.MAX_SAFE_INTEGER), int(limit, 120, 1, 500))
      .reverse();
    if (!fresh.length) return empty;
    const ctx = int(contextLines, 10, 0, 50);
    const context = ctx ? db.prepare(`SELECT ${LINE_COLS} FROM messages WHERE ${inChat} AND rowid < ? AND ${ELIGIBLE}
      ORDER BY rowid DESC LIMIT ?`).all(...forms, fresh[0].rid, ctx).reverse() : [];
    const shape = (r) => {
      const text = lineText(r);
      if (!text) return null;
      const bot = isBotRow(r);
      return { rowid: r.rid, id: r.id, senderJid: bot ? r.sender_jid : (resolvePerson(r.sender_jid) || bareJid(r.sender_jid)),
        isFromSelf: bot, ts: r.timestamp, text };
    };
    return {
      lines: fresh.map(shape).filter(Boolean),
      context: context.map(shape).filter(Boolean),
      maxRowid: fresh[fresh.length - 1].rid,
    };
  } catch (err) {
    issue('eligibleLines', err);
    return empty;
  }
}

// ── Episodes of one chat (mind-internal) ─────────────────────────────────────

/**
 * This chat's own episodes (origin_jid = the chat key), oldest first. `attributes`
 * narrows to those period keys ('day:…' / 'week:…'); `current` (default) keeps only
 * non-superseded, unexpired rows. evidence = the message ids in item_evidence.
 * @returns {Array<{ id, attribute, content, learnedAt, evidence: string[] }>}
 */
export function episodesFor(chatJid, { attributes = null, current = true } = {}) {
  try {
    const key = chatKeyOf(chatJid);
    if (!key) return [];
    const where = [`category = 'episode'`, 'origin_jid = ?', `origin_kind IN ('group', 'dm')`];
    const params = [key];
    if (current) where.push('superseded_by IS NULL', '(expires_at IS NULL OR expires_at > unixepoch())');
    if (Array.isArray(attributes)) {
      const attrs = [...new Set(attributes.map(a => String(a ?? '').trim().toLowerCase().slice(0, 40)).filter(Boolean))];
      if (!attrs.length) return [];
      where.push(`attribute IN (${marks(attrs.length)})`);
      params.push(...attrs);
    }
    const db = getDb();
    const rows = db.prepare(`SELECT id, attribute, content, learned_at FROM memories WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(learned_at, created_at), id LIMIT 500`).all(...params);
    const ev = db.prepare(`SELECT msg_id FROM item_evidence WHERE item_type = 'memory' AND item_id = ? ORDER BY ts, msg_id`).pluck();
    return rows.map(r => ({ id: r.id, attribute: r.attribute, content: sanitizeWebContent(String(r.content || '')),
      learnedAt: r.learned_at, evidence: ev.all(r.id) }));
  } catch (err) {
    issue('episodesFor', err);
    return [];
  }
}

/**
 * Was an episode with this period key ever written for this chat (current or
 * superseded)? Errors → true, so a failed check never writes a duplicate.
 */
export function episodeExists(chatJid, attribute) {
  try {
    const key = chatKeyOf(chatJid);
    const attr = String(attribute ?? '').trim().toLowerCase().slice(0, 40);
    if (!key || !attr) return false;
    return !!getDb().prepare(`SELECT 1 FROM memories WHERE category = 'episode' AND origin_jid = ? AND attribute = ? LIMIT 1`)
      .get(key, attr);
  } catch (err) {
    issue('episodeExists', err);
    return true;
  }
}

// ── "Don't text me first" lookback (research R16) ────────────────────────────

// Broad FTS prefilter tokens (prefix match); dontText.js runs the real regex over
// what comes back and may pass its own `tokens`. The default query is
// (a VERB token AND a negation token) OR "alone", mirroring dontText's PREFILTER_RE
// (its VERB list includes call/calling and "reach out"), so chatty "text"/"msg"
// lines without a negation do not crowd an older opt-out out of the row cap.
// unicode61 splits "don't"/"don’t" into "don" + "t", so "don"* covers both spellings.
const LOOKBACK_TOKENS = ['text', 'messag', 'msg', 'dm', 'ping', 'call', 'reach', 'contact'];
const LOOKBACK_NEG_TOKENS = ['don', 'not', 'never', 'stop', 'pls', 'please'];
const LOOKBACK_ALONE = 'alone';

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/**
 * The person's own eligible messages (any chat) newer than max(sinceTs, the latest
 * cleared_at of their exclusion rows) that match the FTS prefilter, newest first,
 * at most 500. `text` is flattened, ≤ 500 chars, for the code regex only.
 * opts.tokens: replacement prefilter tokens (letters/digits only; prefix match, OR-ed).
 * @returns {Array<{ id, ts, text }>|null} [] when there is nothing to read (unknown
 *   person, no tokens); null when the read FAILED, so the caller fails closed (R16).
 */
export function dontTextLookback(personJid, sinceTs, { tokens = LOOKBACK_TOKENS } = {}) {
  try {
    const forms = personForms(personJid);
    if (!forms.length) return [];
    const clean = (list) => [...new Set(list
      .map(t => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))].slice(0, 16);
    const custom = tokens !== LOOKBACK_TOKENS;
    const toks = clean(Array.isArray(tokens) ? tokens : LOOKBACK_TOKENS);
    if (!toks.length) return [];
    const db = getDb();
    let floor = Number.isFinite(Number(sinceTs)) ? Math.floor(Number(sinceTs)) : 0;
    if (hasTable(db, 'mind_exclusions')) {
      const cleared = db.prepare(`SELECT MAX(cleared_at) FROM mind_exclusions WHERE kind = 'person'
        AND jid IN (${marks(forms.length)}) AND cleared_at IS NOT NULL`).pluck().get(...forms);
      if (Number.isFinite(cleared)) floor = Math.max(floor, cleared);
    }
    const any = (list) => list.map(t => `"${t}"*`).join(' OR ');
    const match = custom ? any(toks)
      : `((${any(toks)}) AND (${any(clean(LOOKBACK_NEG_TOKENS))})) OR "${LOOKBACK_ALONE}"*`;
    const rows = db.prepare(`SELECT m.id, m.timestamp, m.content, m.message_type FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.sender_jid IN (${marks(forms.length)}) AND COALESCE(m.is_from_self, 0) = 0
        AND m.timestamp > ? AND m.message_type != 'reaction' AND COALESCE(m.no_learn, 0) = 0
        AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
      ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`).all(match, ...forms, floor, LOOKBACK_MAX);
    return rows.map(r => ({ id: r.id, ts: r.timestamp, text: rawText(r).slice(0, SCAN_TEXT_MAX) })).filter(r => r.text);
  } catch (err) {
    issue('dontTextLookback', err);
    return null;   // a failed read is NOT "no opt-out": dontText.lookback fails closed on it
  }
}

// ── Names (scrubs and checks; code-only) ─────────────────────────────────────

function addName(set, raw, { parts = false } = {}) {
  const n = String(raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (n.length < 2 || n.length > 80) return;
  set.add(n);
  if (parts) for (const w of n.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3) set.add(w);
}

/**
 * Every name the bot knows for anyone: people push/real names, every nickname,
 * group names, Instagram member usernames/display names. Lower-cased and trimmed;
 * person names also add their words of ≥ 3 letters. The bot's own rows are left
 * out. For code-only checks (self-model scrub, outsider names, foreign-DM trigger).
 * Errors → an empty set (the caller must treat that as "cannot check" and fail closed).
 * @returns {Set<string>}
 */
export function nameSet() {
  const out = new Set();
  try {
    const db = getDb();
    for (const r of db.prepare('SELECT jid, push_name, real_name FROM people').all()) {
      if (isSelfJid(r.jid)) continue;
      addName(out, r.push_name, { parts: true });
      addName(out, r.real_name, { parts: true });
    }
    for (const r of db.prepare('SELECT person_jid, nickname FROM nicknames').all()) {
      if (!isSelfJid(r.person_jid)) addName(out, r.nickname, { parts: true });
    }
    for (const n of db.prepare('SELECT name FROM groups WHERE name IS NOT NULL').pluck().all()) addName(out, n);
    if (hasTable(db, 'ig_members')) {
      for (const r of db.prepare('SELECT username, display_name FROM ig_members WHERE COALESCE(is_self, 0) = 0').all()) {
        addName(out, r.username);
        addName(out, r.display_name, { parts: true });
      }
    }
  } catch (err) {
    issue('nameSet', err);
    return new Set();
  }
  return out;
}

/** The same sources for one person (all identity forms; IG members linked to them). */
export function namesOf(personJid) {
  const out = new Set();
  try {
    const forms = personForms(personJid);
    if (!forms.length) return out;
    const m = marks(forms.length);
    const db = getDb();
    for (const r of db.prepare(`SELECT push_name, real_name FROM people WHERE jid IN (${m})`).all(...forms)) {
      addName(out, r.push_name, { parts: true });
      addName(out, r.real_name, { parts: true });
    }
    for (const n of db.prepare(`SELECT nickname FROM nicknames WHERE person_jid IN (${m})`).pluck().all(...forms)) {
      addName(out, n, { parts: true });
    }
    if (hasTable(db, 'ig_members')) {
      for (const r of db.prepare(`SELECT username, display_name FROM ig_members WHERE person_jid IN (${m})
          AND COALESCE(is_self, 0) = 0`).all(...forms)) {
        addName(out, r.username);
        addName(out, r.display_name, { parts: true });
      }
    }
  } catch (err) {
    issue('namesOf', err);
    return new Set();
  }
  return out;
}

// ── The bot's own style (counts only) ────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const OTHER_LETTER_RE = /(?![\p{Script=Latin}])\p{L}/u;
const CAPS_WORD_RE = /(?<!\p{L})\p{Lu}{3,}(?!\p{L})/u;
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Statistics over the bot's own eligible text messages since `sinceTs` (newest
 * 2000): message count, median length (chars), and shares (0..1) of messages with
 * an emoji / a question mark; `langMix` = shares by letter script (Latin only,
 * other scripts only, both); `markers` = shares with '!', an ellipsis, an all-caps
 * word, or a lower-case first letter. Numbers only — no text, no names.
 */
export function styleStats(sinceTs) {
  const zero = { msgs: 0, medianLen: 0, emojiRate: 0, questionRate: 0,
    langMix: { latin: 0, other: 0, mixed: 0 }, markers: { exclaim: 0, ellipsis: 0, caps: 0, lowerStart: 0 } };
  try {
    const since = Number.isFinite(Number(sinceTs)) ? Math.floor(Number(sinceTs)) : 0;
    const rows = getDb().prepare(`SELECT content, message_type FROM messages WHERE is_from_self = 1 AND timestamp >= ?
      AND message_type = 'text' AND content IS NOT NULL AND ${ELIGIBLE} ORDER BY timestamp DESC, rowid DESC LIMIT 2000`)
      .all(since);
    const texts = rows.map(rawText).filter(Boolean);
    if (!texts.length) return zero;
    const n = texts.length;
    const share = (fn) => r3(texts.filter(fn).length / n);
    const lens = texts.map(t => [...t].length).sort((a, b) => a - b);
    const medianLen = n % 2 ? lens[(n - 1) / 2] : Math.round((lens[n / 2 - 1] + lens[n / 2]) / 2);
    const latin = (t) => LATIN_RE.test(t);
    const other = (t) => OTHER_LETTER_RE.test(t);
    return {
      msgs: n, medianLen,
      emojiRate: share(t => EMOJI_RE.test(t)),
      questionRate: share(t => /[?？]/.test(t)),
      langMix: { latin: share(t => latin(t) && !other(t)), other: share(t => other(t) && !latin(t)),
        mixed: share(t => latin(t) && other(t)) },
      markers: { exclaim: share(t => t.includes('!')), ellipsis: share(t => /\.\.\.|…/.test(t)),
        caps: share(t => CAPS_WORD_RE.test(t)), lowerStart: share(t => /^\p{Ll}/u.test(t)) },
    };
  } catch (err) {
    issue('styleStats', err);
    return zero;
  }
}

/**
 * Plan 020 B: every word of every real person's name and nickname, normalized (a cast name that collides with one gets no line: dropping a line is cheap, a real name in one isn't). Throws on a read failure:
 * the caller fails closed.
 */
export function realFirstNames() {
  const out = new Set();
  const add = (n) => { for (const t of nameTokens(n)) out.add(t); };
  for (const r of getDb().prepare('SELECT push_name, real_name FROM people WHERE push_name IS NOT NULL OR real_name IS NOT NULL').all()) {
    add(r.push_name);
    add(r.real_name);
  }
  for (const r of getDb().prepare('SELECT nickname FROM nicknames').all()) add(r.nickname);
  return out;
}

export { nameTokens };
