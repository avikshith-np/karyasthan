import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { askJev, choice } from '../brain/jev.js';
import { BudgetError } from '../brain/usage.js';
import { getDb } from '../memory/db.js';
import { isGroupJid, isDmJid } from '../utils/jidUtils.js';
import { now } from './clock.js';

// Self-claim flagging (spec 009 plan §R14) and the self-mention budget (§R12).
//
// After a reply is sent, the facade calls flagReply() fire-and-forget. A cheap
// code prefilter looks for a first-person cue AND a time/place/plan cue ("I'll be
// there at 8", "going home this weekend"); only a hit costs a Jev call, and Jev
// calls are capped per rolling hour. Jev says none / claim / commitment; a claim
// or commitment with p ≥ 0.6 becomes a `life_claims` row (status 'flagged', the
// chat's origin) for the owner to review on the dashboard.
//
// His replies are downstream of untrusted chat, so the stored excerpt and
// everything sent to Jev goes through sanitizeWebContent + a length cap first.
// This module NEVER writes world_events: in 009 a claim changes nothing about his
// life (adoption/rejection is spec 010's reconciler). The `claim.flagged` pointer
// event, if wanted, is appended by the facade from the returned row id.
//
// The same prefilter feeds the anti-fixation counter: replies that talk about his
// own life are counted per chat over 24 h; over config.life.selfMentionBudget the
// inner-state line drops to tone only (innerState.js reads overSelfMentionBudget).
// Counters are in memory (reset on restart, like the burst cooldowns).
//
// The cue lists are English (plus common chat spellings); place and cast names
// from the world are passed in by the caller — nothing persona-specific here.

export const MAX_CLAIM_CHARS = 300;
export const MAX_TRIGGER_CHARS = 200;
export const FLAG_MIN_P = 0.6;
export const CLAIM_KINDS = Object.freeze(['claim', 'commitment']);
const LIST_LIMIT = 100;
const HOUR = 3600;
const DAY = 86400;
const MAX_CHATS = 500;            // self-mention map bound (oldest chat evicted)
const MAX_MENTIONS_PER_CHAT = 50;
const MAX_EXTRA_NAMES = 64;
const MAX_JID_CHARS = 128;
const MAX_BY_CHARS = 64;

// ── Prefilter ─────────────────────────────────────────────────────────────

// I / I'm / I'll / I've / I'd (and "im", "ive"), my, me, we / we're / we'll, our, us.
// Bare "ill" is left out on purpose (it is usually the word "ill").
const FIRST_PERSON_RE = /\b(?:i|i['’](?:m|ll|ve|d)|im|ive|my|me|mine|myself|we|we['’](?:re|ll|ve)|our|us)\b/i;
const TIME_RE = new RegExp([
  String.raw`\b(?:today|tonight|tomorrow|tmrw|tmr|tmrrw|yesterday|weekend|weekday|morning|evening|afternoon|night|noon|midnight)\b`,
  String.raw`\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b`,
  String.raw`\b(?:next|this|last|coming)\s+(?:week|month|year|time|mon|tue|wed|thu|fri|sat|sun)`,
  String.raw`\b(?:at|by|around|till|until|before|after)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b`,
  String.raw`\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b`,
  String.raw`\bin\s+(?:an?|\d+|few|a\s+few)\s+(?:min|mins|minutes|hour|hours|hrs|days?)\b`,
  String.raw`\b(?:soon|later)\b`,
].join('|'), 'i');
const PLAN_RE = new RegExp([
  String.raw`\b(?:going|gonna|coming|leaving|heading|reaching|reached|moving|moved|travell?ing|flying|driving|visiting|joining|staying|starting|quitting|meeting)\b`,
  String.raw`\b(?:will|shall|wont|won['’]t|can['’]?t\s+make|promise|plan(?:ning|ned)?|booked|bought|got\s+(?:a|my)|be\s+there|count\s+me|on\s+my\s+way|omw)\b`,
  String.raw`\b(?:home|office|work|wfh|hometown|flat|room|gym|trip|vacation|holiday|leave)\b`,
].join('|'), 'i');
// Life facts a chat might try to plant ("I'm married now", "got a new job"): the
// owner should see these even without a time cue.
const LIFE_RE = /\b(?:married|engaged|divorced|single|dating|girlfriend|boyfriend|wife|husband|pregnant|sick|fever|hospital|salary|job|fired|promoted|broke|loan|owe|rent|moved|live|living|birthday)\b/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a name matcher for world place/cast names (strings, ≥ 3 chars), or null. */
function namesMatcher(names) {
  if (!Array.isArray(names) || !names.length) return null;
  const parts = [];
  for (const n of names.slice(0, MAX_EXTRA_NAMES)) {
    if (typeof n !== 'string') continue;
    const t = n.trim().slice(0, 40);
    if (t.length >= 3) parts.push(escapeRe(t));
  }
  return parts.length ? new RegExp(`\\b(?:${parts.join('|')})\\b`, 'i') : null;
}

/**
 * Code prefilter: true when `text` has a first-person cue AND a time, plan/place,
 * life-fact or world-name cue. `names` — optional place/cast names from the world.
 */
export function prefilter(text, { names = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.slice(0, 2000);
  if (!FIRST_PERSON_RE.test(t)) return false;
  if (TIME_RE.test(t) || PLAN_RE.test(t) || LIFE_RE.test(t)) return true;
  const re = namesMatcher(names);
  return !!re && re.test(t);
}

// ── Seams + counters ──────────────────────────────────────────────────────

let jevFn = askJev;

/** Replace the Jev client (tests). `null` restores the real askJev. */
export function setJev(fn) {
  if (fn !== null && typeof fn !== 'function') throw new Error('setJev expects a function or null');
  jevFn = fn || askJev;
}

const jevCalls = [];               // unix seconds of recent Jev calls (rolling hour)
const selfMentions = new Map();    // chatJid → unix seconds[] (rolling 24 h)

/** Clear the in-memory counters (tests; also on life toggle-off if wanted). */
export function resetClaimCounters() {
  jevCalls.length = 0;
  selfMentions.clear();
}

function pruneJevCalls(at) {
  while (jevCalls.length && jevCalls[0] <= at - HOUR) jevCalls.shift();
}

/** Jev claim checks used in the last hour (the hourly cap's counter). */
export function claimsThisHour(at = now()) {
  pruneJevCalls(at);
  return jevCalls.length;
}

function capPerHour() {
  const n = Number(config.life?.claimsMaxPerHour);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
}

function validJid(jid) {
  return typeof jid === 'string' && jid.length > 0 && jid.length <= MAX_JID_CHARS && /^[\w.:+-]+@[\w.-]+$/.test(jid);
}

/** Count one self-referencing reply in `chatJid` at `at`. */
export function noteSelfMention(chatJid, at = now()) {
  if (!validJid(chatJid)) return 0;
  let list = selfMentions.get(chatJid);
  if (list) selfMentions.delete(chatJid);   // re-insert: Map order = least recently used first
  else list = [];
  list.push(at);
  while (list.length && (list[0] <= at - DAY || list.length > MAX_MENTIONS_PER_CHAT)) list.shift();
  selfMentions.set(chatJid, list);
  while (selfMentions.size > MAX_CHATS) selfMentions.delete(selfMentions.keys().next().value);
  return list.length;
}

/** Self-referencing replies in `chatJid` over the last 24 h. */
export function selfMentionCount(chatJid, at = now()) {
  const list = selfMentions.get(chatJid);
  if (!list) return 0;
  return list.filter(t => t > at - DAY && t <= at).length;
}

/** True when his replies in this chat already talked about his life more than the budget allows. */
export function overSelfMentionBudget(chatJid, at = now()) {
  const n = Number(config.life?.selfMentionBudget);
  const budget = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
  return selfMentionCount(chatJid, at) > budget;
}

// ── Sanitizing ────────────────────────────────────────────────────────────

/** sanitizeWebContent + whitespace collapse + hard cap. Always a string. */
export function sanitizeClaimText(text, max = MAX_CLAIM_CHARS) {
  if (typeof text !== 'string') return '';
  const clean = sanitizeWebContent(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
}

function originKindFor(chatJid) {
  if (isGroupJid(chatJid)) return 'group';
  if (isDmJid(chatJid)) return 'dm';
  return null;
}

// ── Flagger ───────────────────────────────────────────────────────────────

const KIND_QUESTION = choice(
  'In `his_reply` (a chat message he just sent; `they_said` is what he was answering), does he assert a fact about his own life or commit himself to doing something?',
  {
    none: 'Neither: banter, opinion, a question, or talk about other people or the world',
    claim: 'He states a fact about his own life: where he is or was, what he did, owns, feels or is going through',
    commitment: 'He commits himself to a future action: going somewhere, meeting someone, doing something by a time',
  },
);

/**
 * Check one sent reply. Never throws; never touches world_events.
 * Returns { flagged: row } or { skipped: 'invalid'|'prefilter'|'cap'|'budget'|'jev_error'|'none'|'low_p'|'error' }.
 * A prefilter hit also counts toward the chat's self-mention budget.
 *
 * 012 (spec 012 plan §P2.6): `extraQuestion` = { key, question, theySaid, cue(text),
 * accept(answer) → value|null } rides along as one more question of the SAME Jev
 * call (the invitation awaiting his word: `they_said` is the invitation). Asked
 * only when cue(text) hits — the claim prefilter and the hourly cap don't apply to
 * it (the caller limits it per invitation). An accepted answer returns
 * { answer: value } without a life_claims row; otherwise the claim question is
 * judged exactly as without it (and only when its own prefilter + cap passed).
 */
export async function flagReply({ chatJid, text, triggerText = '', msgId = null, names = [], extraQuestion = null } = {}) {
  try {
    const originKind = originKindFor(chatJid);
    if (!validJid(chatJid) || !originKind || typeof text !== 'string') return { skipped: 'invalid' };
    const at = now();
    const extra = extraQuestion && typeof extraQuestion.key === 'string' && extraQuestion.question
      && typeof extraQuestion.accept === 'function' && safeCue(extraQuestion, text) ? extraQuestion : null;
    const hit = prefilter(text, { names });
    if (!hit && !extra) return { skipped: 'prefilter' };
    if (hit) noteSelfMention(chatJid, at);

    pruneJevCalls(at);
    const capped = hit && jevCalls.length >= capPerHour();
    if (capped) logger.info({ chatJid, cap: capPerHour() }, 'life claims: hourly Jev cap reached, skipping');
    const claimOk = hit && !capped;
    if (!claimOk && !extra) return { skipped: 'cap' };
    const reply = sanitizeClaimText(text, MAX_CLAIM_CHARS);
    if (!reply) return { skipped: 'invalid' };
    const trigger = extra && typeof extra.theySaid === 'string' && extra.theySaid
      ? extra.theySaid.slice(0, MAX_TRIGGER_CHARS * 2)
      : sanitizeClaimText(typeof triggerText === 'string' ? triggerText : '', MAX_TRIGGER_CHARS);

    if (claimOk) jevCalls.push(at);
    let res;
    try {
      res = await jevFn({
        state: { his_reply: reply, ...(trigger ? { they_said: trigger } : {}) },
        questions: { ...(claimOk ? { kind: KIND_QUESTION } : {}), ...(extra ? { [extra.key]: extra.question } : {}) },
        caller: 'life.claim',
      });
    } catch (err) {
      if (err instanceof BudgetError) {
        logger.info({ chatJid, reason: err.state?.reason }, 'life claims: Jev over budget, claim flagging skipped');
        return { skipped: 'budget' };
      }
      logger.warn({ err: err?.message, chatJid }, 'life claims: Jev failed, claim flagging skipped');
      return { skipped: 'jev_error' };
    }

    if (extra) {
      let value = null;
      try { value = extra.accept(res?.answers?.[extra.key]) ?? null; } catch { value = null; }
      if (value) return { answer: value };
      if (!claimOk) return { skipped: hit ? 'cap' : 'prefilter' };
    }

    // Jev's answer is untrusted too: only a known kind with a finite probability counts.
    const a = res?.answers?.kind;
    const kind = typeof a?.choice === 'string' ? a.choice : 'none';
    if (!CLAIM_KINDS.includes(kind)) return { skipped: 'none' };
    const rawP = a?.probabilities?.[kind] ?? a?.confidence;
    const p = typeof rawP === 'number' && Number.isFinite(rawP) ? Math.min(1, Math.max(0, rawP)) : 0;
    if (p < FLAG_MIN_P) return { skipped: 'low_p' };

    const row = insertClaim({
      chatJid, originKind, originJid: chatJid,
      replyMsgId: typeof msgId === 'string' ? msgId.slice(0, MAX_JID_CHARS) : null,
      text: reply, kind, p, createdAt: at,
    });
    logger.debug({ chatJid, kind, p, id: row.id }, 'life claims: reply flagged');
    return { flagged: row };
  } catch (err) {
    logger.warn({ err: err?.message, chatJid }, 'life claims: flagging failed');
    return { skipped: 'error' };
  }
}

function safeCue(extra, text) {
  if (typeof extra.cue !== 'function') return true;
  try { return extra.cue(text) === true; } catch { return false; }
}

// ── Store (life_claims) ───────────────────────────────────────────────────

function rowOut(r) {
  return r ? {
    id: r.id, chatJid: r.chat_jid, originKind: r.origin_kind, originJid: r.origin_jid,
    replyMsgId: r.reply_msg_id, text: r.text, kind: r.kind, p: r.p, status: r.status,
    createdAt: r.created_at, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by,
  } : null;
}

function insertClaim({ chatJid, originKind, originJid, replyMsgId, text, kind, p, createdAt }) {
  const info = getDb().prepare(`
    INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'flagged', ?)
  `).run(chatJid, originKind, originJid, replyMsgId, text, kind, p, createdAt);
  return getClaim(Number(info.lastInsertRowid));
}

/** One claim by id, or null. */
export function getClaim(id) {
  if (!Number.isInteger(id) || id < 1) return null;
  return rowOut(getDb().prepare('SELECT * FROM life_claims WHERE id = ?').get(id));
}

/** Claims newest first; `status` optional ('flagged'|'dismissed'|'adopted'|'rejected'), limit ≤ 100. */
export function listClaims({ status = null, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(LIST_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM life_claims WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(String(status), n)
    : db.prepare('SELECT * FROM life_claims ORDER BY created_at DESC, id DESC LIMIT ?').all(n);
  return rows.map(rowOut);
}

/** Number of claims still waiting for review (Life·Now badge). */
export function countFlagged() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM life_claims WHERE status = 'flagged'").get().n;
}

/**
 * An undone adoption (a revert of its claim.adopted, or a rewind over it): the
 * claim goes back to how the reconciler found it — 'flagged', never reviewed —
 * while its review returns to the tray. Only an 'adopted' row; true if one was.
 */
export function reopenAdoptedClaim(id) {
  if (!Number.isInteger(id) || id < 1) return false;
  return getDb().prepare(`
    UPDATE life_claims SET status = 'flagged', reviewed_at = NULL, reviewed_by = NULL
    WHERE id = ? AND status = 'adopted'
  `).run(id).changes === 1;
}

/** Owner dismiss (dashboard). Only a 'flagged' claim can be dismissed; returns true if one was. */
export function dismissClaim(id, { by = 'owner' } = {}) {
  if (!Number.isInteger(id) || id < 1) return false;
  const who = sanitizeClaimText(typeof by === 'string' ? by : 'owner', MAX_BY_CHARS) || 'owner';
  const info = getDb().prepare(`
    UPDATE life_claims SET status = 'dismissed', reviewed_at = ?, reviewed_by = ?
    WHERE id = ? AND status = 'flagged'
  `).run(now(), who, id);
  return info.changes === 1;
}
