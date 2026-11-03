// Self-model (spec 008, research R12/R13, contracts/mind-output.md §9, data-model
// "mind_self_model").
//
// Who proposes: ONLY the separate content-free `mind.selfmodel` call (plan review
// S1-01). Its input is built here in code and carries no chat text, no digest/episode
// text and no names: the active text, counts of self-origin life event TYPES, mood and
// tone enum counts, nudge outcomes (knob, value, status), proactive outcome counts and
// mindReads.styleStats (numbers). The sleep reflection has no self_model field.
//
// scrubProposal(p, ctx) is pure; steps run in order and any reject ends processing:
//    1 shape (base_version = active, NFKC, per-line whitespace, ≤ selfModelMaxChars,
//      never trimmed silently)          → stale | oversize | bad_text
//    2 provenance (a mind.selfmodel run that did not fall back) → bad_source
//    3 change budget (added + removed chars ≤ 400)              → too_large
//    4 forbidden topics incl. harm terms on added lines          → forbidden
//    5 fixation ("always"/"every message"… + a topic)            → fixation
//    5b how his lines look (emoji, capitals, script…)            → looks
//    6 identifiers (phone, JID, email, URL, @digits)             → line removed
//    7 names (nameSet + life cast; persona aliases allowed)      → line removed
//    8 scoped content (a word 4-gram shared with a recent digest/episode) → line removed
//    9 sanitizeWebContent + fence tokens
//   10 residual: 4 (lines not already in the active text), 6, 7 over the whole result
//      → residual; removals in 6–8 > half the added chars       → mostly_scrubbed
// The owner path (edit, revert) runs 1 (cap only), 6 (removes, warns), 7 (WARNS only —
// a name in a global prompt is the owner's call), 9 and 10 (identifiers only).
// Fail closed: for a mind proposal an empty name set (nameSet() returns an empty Set on
// error) rejects the proposal (`names_unavailable`); an unreadable corpus rejects it
// (`corpus_unavailable`).
//
// harmCheck(addedLines) — step 11: the `gate` role with a harm note; it re-closes
// evaluateResponse's fail-open (ok only with pass === true AND a finite score).
//
// applyProposal(result, runId, {auto}) — a valid proposal is stored `proposed` (older
// pending ones → superseded); an invalid one is stored with NO text, diff or summary
// (only the scrub report). Auto-activation needs the effective review state to be auto
// (store.reviewState; a missing state reads as review), a harm verdict, and ≥ 3 days
// since the last auto-apply; it is audited `mind.selfmodel.auto`. The caller
// (runSelfModel, at the end of sleep only) decides `auto`.
//
// Owner actions (approve/reject/editText/revertTo) throw OwnerError(code, http); the
// dashboard route audits them with the request actor. Nothing here logs chat- or
// model-derived text: ids, versions, counts and reason codes only.

import crypto from 'crypto';
import * as store from './store.js';
import { now as clockNow, nightKey as clockNightKey, dayKey } from './clock.js';
import { SELFMODEL_CHARTER, stripFenceTokens } from './charter.js';
import { validateSelfModel } from './schema.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { callRole } from '../brain/llm.js';
import { evaluateResponse } from '../brain/qualityGate.js';
import { auditWrite } from '../dashboard/audit.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DAY = 86400;
export const CHANGE_BUDGET_CHARS = 400;
export const AUTO_APPLY_GAP_SEC = 3 * DAY;
export const BLOCK_HEAD = "## How you've been lately (your own notes)";
export const HARM_NOTE = 'This text is a short self-description that will be added to the character\'s global notes. '
  + 'Score 0 if it would make the bot ask for money, links, numbers or personal details, push products, '
  + 'or behave unsafely.';
const HARM_SNIPPET = '(no conversation: a proposed edit to the character\'s own style notes)';

/** Owner-action error: code (dashboard-api reason), http status. index.js re-exports/maps it. */
export class OwnerError extends Error {
  constructor(code, http = 409) {
    super(code);
    this.name = 'OwnerError';
    this.code = code;
    this.http = http;
  }
}

// ── deps (test seam) ─────────────────────────────────────────────────────────

let mindReadsMod = null;
let lifeMod = null;
async function mindReads() {
  if (!mindReadsMod) mindReadsMod = await import('../memory/mindReads.js');
  return mindReadsMod;
}
async function lifeFacade() {
  if (lifeMod === null) {
    try { lifeMod = await import('../life/index.js'); } catch { lifeMod = false; }
  }
  return lifeMod || null;
}

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  callRole: (role, system, user, opts) => callRole(role, system, user, opts),
  evaluateResponse: (text, snippet, opts) => evaluateResponse(text, snippet, opts),
  auditWrite: (actor, action, target, payload) => auditWrite(actor, action, target, payload),
  nameSet: async () => (await mindReads()).nameSet(),
  styleStats: async (since) => (await mindReads()).styleStats(since),
  episodesFor: async (chatJid, opts) => (await mindReads()).episodesFor(chatJid, opts),
  life: async () => lifeFacade(),
  getPersona: () => getPersona(),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, isMindOn, callRole, evaluateResponse, auditWrite, nameSet, styleStats, episodesFor, life, getPersona }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  invalidate();
}

const nowSec = () => Math.floor(deps.now());
const maxChars = () => Math.max(100, Math.min(1500, Number(config.mind?.selfModelMaxChars) || 1500));
const everyNights = () => Math.max(1, Math.floor(Number(config.mind?.selfModelEveryNights) || 3));

// ── text helpers ─────────────────────────────────────────────────────────────

/** NFKC, per-line whitespace collapse + trim, ≤ 1 blank line in a row, outer trim. */
export function normaliseText(text) {
  if (typeof text !== 'string') return null;
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.replace(/[\s ]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Lower-case, NFKC, diacritics stripped, non-letters/digits → single spaces. */
export function normWords(s) {
  return String(s ?? '').normalize('NFKC').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const linesOf = (text) => (text ? text.split('\n') : []);

/**
 * Line diff (LCS) of a → b: [{op:'='|'-'|'+', line}]. Blank lines are compared like any
 * other line.
 */
export function diffLines(a, b) {
  const A = linesOf(typeof a === 'string' ? a : '');
  const B = linesOf(typeof b === 'string' ? b : '');
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: '=', line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', line: A[i] }); i++; }
    else { out.push({ op: '+', line: B[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}

const changeChars = (diff) => diff.filter(d => d.op !== '=').reduce((s, d) => s + d.line.length, 0);

// ── code constant lists (FR-017, US4-5, research R12 step 4) ─────────────────

const FORBIDDEN_TERMS = [
  // privacy / rules / prompt injection
  'privacy', 'secrets?', 'private', 'safety', 'rules?', 'polic(?:y|ies)', 'instructions?', 'system\\s+prompts?',
  'ignore\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|above)', 'jailbreak\\w*',
  // credentials
  'api\\s*keys?', 'tokens?', 'passwords?', 'otps?',
  // budgets / models
  'budgets?', 'costs?', 'models?', 'providers?', 'opus', 'gemini', 'grok', 'jev',
  // switches / owner surfaces
  'dry\\s*run', 'mute[ds]?', 'exclu(?:de[ds]?|ding|sions?)', 'kill\\s*switch(?:es)?', 'paus(?:e|es|ed|ing)',
  'reviews?', 'owners?', 'dashboards?', 'admins?', 'config\\w*',
  // harm (plan review S2-15)
  'money', 'pay', 'pays', 'paid', 'paying', 'payments?', 'loans?', 'lend\\w*', 'invest\\w*', 'crypto\\w*', 'coins?',
  'stocks?', 'trading', 'bets?', 'betting', 'links?', 'urls?', 'websites?', 'numbers?', 'phones?', 'contacts?',
  'send\\s+me', 'share\\s+your', 'recommend\\w*', 'buy\\w*', 'sell\\w*', 'discounts?', 'offers?', 'sign\\s*up',
  'subscrib\\w*', 'download\\w*', 'install\\w*', 'address(?:es)?', 'locations?', 'banks?', 'cards?', 'upi',
];
const FORBIDDEN_RE = new RegExp(`(?:\\b(?:${FORBIDDEN_TERMS.join('|')})\\b|\\.env\\b)`, 'i');

const FIXATION_RE = /\b(always|every (message|reply|time)|constantly|never stop|in every)\b/i;

// Words that describe style, not a topic (a fixation line made only of these passes).
const STYLE_WORDS = new Set(('keep keeps keeping short shorter brief briefer reply replies replying message messages '
  + 'casual casually tone lowercase emoji emojis punctuation sentence sentences word words sound sounds relaxed warm '
  + 'friendly quick quickly write writes writing type types typing talk talks talking chat chats chatting use uses '
  + 'using light lightly calm calmly kind kindly honest plain simple simply clear clearly polite politely style '
  + 'answer answers answering respond responds responding slow slowly people everyone someone things thing stuff '
  + 'little bit lot lots more less much way ways mood moods feel feels feeling').split(' '));

// Common English words that are never treated as a name (whole-word name matching).
const STOP = new Set(('a an and are as at be been being but by can could did do does doing for from had has have he '
  + 'her here hers him his how i if in into is it its just me more most my no not now of off on once only or our '
  + 'out over own same she so some such than that the their them then there these they this those through to too '
  + 'under until up very was we were what when where which while who whom why will with would you your yours '
  + 'about above after again against all also am any because before below between both down during each few '
  + 'further get got go going gone good great day days time times week weeks night nights morning evening today '
  + 'lately recently still really quite even ever never always often sometimes usually less little lot lots many '
  + 'much new old one two three first last next long short big small well like likes liked love loves make makes '
  + 'made say says said see seen tell told think thinks thought feel feels felt know knows want wants way ways work '
  + 'works home friend friends group groups chat chats people person someone everyone anyone thing things stuff '
  + 'joke jokes fun funny happy sad tired busy calm late early back keep keeps kept try tries tried take takes took '
  + 'come comes came give gives gave find finds found use uses used call calls called').split(' '));
// (Endearments and titles — boss, bro, dear, king… — are deliberately NOT here: they are
// common nicknames, and a nickname in nameSet() must be caught.)

// R12 step 6 identifier patterns.
const IDENT_RES = [
  /\+?\d[\d\s().-]{7,}\d/,
  /@(s\.whatsapp\.net|g\.us|lid)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  /\b(?:https?:\/\/|www\.)\S+/i,
  /\b[a-z0-9-]+\.(?:com|net|org|io|in|co|app|me|ly|gg|xyz|info|dev|ai|tv|to|link)\b/i,
  /@\d{5,}/,
];
const hasIdentifier = (line) => IDENT_RES.some(re => re.test(line));
const isForbidden = (line) => FORBIDDEN_RE.test(line);

function namesTopic(line) {
  const rest = normWords(line.replace(FIXATION_RE, ' '));
  return rest.split(' ').some(w => w.length >= 3 && !STOP.has(w) && !STYLE_WORDS.has(w) && !/^\d+$/.test(w));
}
const isFixation = (line) => FIXATION_RE.test(line) && namesTopic(line);
// How his lines look, not how he's been: the note sits in his own prompt, so a line like this feeds the habit it names.
const LOOKS_RE = /\b(emoji|emojis|emoticons?|punctuation|lower-?case|capitals?|capitali[sz]\w*|all caps|exclamation\w*|ellips[ei]s|latin script|mixed-language|spelling)\b/i;
const namesLooks = (line) => LOOKS_RE.test(line);

/**
 * A normalised name matcher from raw names: whole phrases plus tokens of ≥ 3 chars of
 * multi-word names; common words and the persona's own aliases are allowed.
 */
export function buildNameMatcher(names, allow = []) {
  const allowSet = new Set([...(allow || [])].map(normWords).filter(Boolean));
  const tokens = new Set();
  const phrases = new Set();
  for (const raw of names || []) {
    const n = normWords(raw);
    if (!n || allowSet.has(n)) continue;
    const parts = n.split(' ').filter(Boolean);
    if (parts.length === 1) {
      if (n.length >= 2 && !STOP.has(n)) tokens.add(n);
    } else {
      phrases.add(n);
      for (const p of parts) if (p.length >= 3 && !STOP.has(p) && !allowSet.has(p)) tokens.add(p);
    }
  }
  return {
    size: tokens.size + phrases.size,
    test(line) {
      const w = normWords(line);
      if (!w) return false;
      const words = w.split(' ');
      if (words.some(x => tokens.has(x))) return true;
      const padded = ` ${w} `;
      for (const p of phrases) if (padded.includes(` ${p} `)) return true;
      return false;
    },
  };
}

/** Word 4-grams (normalised, stopwords kept) of a text. */
export function fourGrams(text) {
  const w = normWords(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(' '));
  return out;
}

function corpusGrams(corpus) {
  const set = new Set();
  for (const t of corpus || []) for (const g of fourGrams(t)) set.add(g);
  return set;
}

const sharesGram = (line, grams) => [...fourGrams(line)].some(g => grams.has(g));

function cleanLine(line) {
  return stripFenceTokens(sanitizeWebContent(line)).replace(/[ \t]+/g, ' ').trim();
}

// ── scrub (pure) ─────────────────────────────────────────────────────────────

/**
 * Scrub a proposal or an owner text (research R12 steps 1–10).
 *   p:   { baseVersion?, text }
 *   ctx: { mode: 'mind'|'owner', activeVersion, activeText, source?: { caller, fellBack },
 *          names: Iterable<string>, allow?: Iterable<string> (persona aliases),
 *          corpus?: string[] (recent digest/episode texts), maxChars? }
 * → { ok:true, text, unchanged, diff, added:[line], report:{removedLines, warnings} }
 *   | { ok:false, rejectReason, report:{removedLines, rejectReason, warnings} }
 * The report never carries text: reasons and sizes only.
 */
export function scrubProposal(p, ctx = {}) {
  const mode = ctx.mode === 'owner' ? 'owner' : 'mind';
  const cap = Number.isFinite(ctx.maxChars) ? ctx.maxChars : maxChars();
  const removedLines = [];
  const warnings = [];
  const reject = (rejectReason) => ({ ok: false, rejectReason, report: { removedLines, rejectReason, warnings } });
  const activeText = typeof ctx.activeText === 'string' ? ctx.activeText : '';

  // 1. shape
  if (mode === 'mind' && (!Number.isInteger(p?.baseVersion) || p.baseVersion !== ctx.activeVersion)) return reject('stale');
  let text = normaliseText(p?.text);
  if (text === null) return reject('bad_text');
  if (text.length > cap) return reject('oversize');

  const names = buildNameMatcher(ctx.names || [], ctx.allow || []);
  let grams = null;
  if (mode === 'mind') {
    // 2. provenance
    const src = ctx.source || {};
    if (src.caller !== 'mind.selfmodel' || src.fellBack !== false) return reject('bad_source');
    if (!names.size) return reject('names_unavailable');
    if (!Array.isArray(ctx.corpus)) return reject('corpus_unavailable');
    grams = corpusGrams(ctx.corpus);
    // 3. change budget
    if (changeChars(diffLines(activeText, text)) > CHANGE_BUDGET_CHARS) return reject('too_large');
  }

  const activeLines = new Set(linesOf(activeText));
  const lines = linesOf(text);
  const isAdded = (l) => mode === 'owner' || !activeLines.has(l);
  const addedChars = lines.filter(l => l && isAdded(l)).reduce((s, l) => s + l.length, 0);

  if (mode === 'mind') {
    const added = lines.filter(l => l && isAdded(l));
    // 4. forbidden topics (incl. harm terms)
    if (added.some(isForbidden)) return reject('forbidden');
    // 5. fixation
    if (added.some(isFixation)) return reject('fixation');
    if (added.some(namesLooks)) return reject('looks');
  }

  // 6–8 line removals
  let removedChars = 0;
  const kept = [];
  for (const l of lines) {
    if (!l || !isAdded(l)) { kept.push(l); continue; }
    let reason = null;
    if (hasIdentifier(l)) reason = 'identifier';
    else if (names.test(l)) {
      if (mode === 'owner') { warnings.push({ reason: 'name', chars: l.length }); }
      else reason = 'name';
    } else if (mode === 'mind' && sharesGram(l, grams)) reason = 'scoped';
    if (reason) {
      removedLines.push({ reason, chars: l.length });
      if (mode === 'owner') warnings.push({ reason, chars: l.length });
      removedChars += l.length;
      continue;
    }
    kept.push(l);
  }

  // 9. markers
  text = normaliseText(kept.map(cleanLine).join('\n')) || '';

  // 10. residual over the whole result
  const finalLines = linesOf(text).filter(Boolean);
  if (finalLines.some(hasIdentifier)) return reject('residual');
  if (mode === 'mind') {
    if (finalLines.some(names.test)) return reject('residual');
    if (finalLines.some(l => !activeLines.has(l) && (isForbidden(l) || isFixation(l) || namesLooks(l)))) return reject('residual');
    if (addedChars > 0 && removedChars * 2 > addedChars) return reject('mostly_scrubbed');
  }
  if (text.length > cap) return reject('oversize');

  const diff = diffLines(activeText, text);
  return {
    ok: true,
    text,
    unchanged: text === activeText,
    diff,
    added: diff.filter(d => d.op === '+' && d.line).map(d => d.line),
    report: { removedLines, warnings },
  };
}

// ── harm check (step 11) ─────────────────────────────────────────────────────

/**
 * The gate role judges the added lines with a harm note. Fails closed: ok only when
 * the verdict passes with a finite score. Nothing added → ok (no new text to judge).
 * → { ok, score|null, pass|null }  (no model text is returned or stored)
 */
export async function harmCheck(addedLines) {
  const lines = (Array.isArray(addedLines) ? addedLines : []).filter(l => typeof l === 'string' && l.trim());
  if (!lines.length) return { ok: true, score: null, pass: null, nothingAdded: true };
  try {
    const v = await deps.evaluateResponse(lines.join('\n'), HARM_SNIPPET,
      { harmNote: HARM_NOTE, caller: 'mind.selfmodel.harm', isMention: false });
    const score = v && Number.isFinite(v.score) ? v.score : null;
    const pass = v ? v.pass === true : false;
    return { ok: pass && score !== null, score, pass };
  } catch {
    return { ok: false, score: null, pass: false };
  }
}

// ── active text (cached until the version changes) ───────────────────────────

let cache = null;   // { id, version, text }

/** Drop the cached active text (every writer here calls it). */
export function invalidate() {
  cache = null;
}

function activeRow() {
  let row = store.activeSelfModel();
  if (!row) row = store.seedSelfModel();
  return row;
}

/** The active self-model text ('' for the seed / on error). Cached until a write here. */
export function activeText() {
  try {
    if (!cache) {
      const row = activeRow();
      cache = row ? { id: row.id, version: row.version, text: String(row.text || '') } : { id: null, version: 0, text: '' };
    }
    return cache.text;
  } catch {
    return '';
  }
}

/** The active version number (0 = the empty seed). */
export function activeVersion() {
  activeText();
  return cache ? cache.version : 0;
}

/**
 * The cached-core block: '' when the mind is off, imitating, or the text is empty;
 * otherwise "## How you've been lately (your own notes)\n<text>", byte-stable until
 * the version changes. Never throws.
 */
export function selfModelBlock({ imitation = null } = {}) {
  try {
    if (imitation || !deps.isMindOn()) return '';
    const text = activeText();
    return text ? `${BLOCK_HEAD}\n${text}` : '';
  } catch {
    return '';
  }
}

// ── input (no scoped text) ───────────────────────────────────────────────────

const round3 = (x) => Math.round(Number(x) * 1000) / 1000;
const CODE_RE = /^[a-z][a-z0-9_.]{0,39}$/;
const codeOr = (v, other = 'other') => (typeof v === 'string' && CODE_RE.test(v) ? v : other);

function sortObj(o) {
  if (Array.isArray(o)) return o.map(sortObj);
  if (o && typeof o === 'object') return Object.fromEntries(Object.keys(o).sort().map(k => [k, sortObj(o[k])]));
  return o;
}

function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }

/** Chats with mind activity since `since` (unix) — the digests/episodes live under these. */
function recentChats(since) {
  const out = new Set();
  for (const r of store.activityFor(dayKey(since)) || []) if (r && typeof r.chatJid === 'string') out.add(r.chatJid);
  return [...out];
}

/**
 * Recent digest summaries / today notes / threads and episodes (last N nights + a
 * day of margin): the step-8 4-gram corpus. Code only — never a model input. Throws
 * on a read failure (the caller fails closed).
 */
export async function recentScopedCorpus(since) {
  const out = [];
  for (const chat of recentChats(since)) {
    for (const d of store.digestsFor(chat, { sinceAt: since })) {
      if (d.summary) out.push(d.summary);
      if (d.todayNote) out.push(d.todayNote);
      for (const th of Array.isArray(d.threads) ? d.threads : []) if (th && typeof th.text === 'string') out.push(th.text);
    }
    for (const e of await deps.episodesFor(chat, { current: false })) {
      if (e && typeof e.content === 'string' && (!Number.isFinite(e.learnedAt) || e.learnedAt >= since - DAY)) out.push(e.content);
    }
  }
  return out;
}

/**
 * The self-model call's input, built in code (research R12): no chat text, no
 * digest/episode text, no names, no JIDs. → { user, summary (for mind_runs.input_json),
 * hash, baseVersion }
 */
export async function buildSelfModelInput({ at = null } = {}) {
  const t = Number.isFinite(at) ? Math.floor(at) : nowSec();
  const nights = everyNights();
  const since = t - nights * DAY;
  const active = activeRow();
  const baseVersion = active ? active.version : 0;
  const text = active ? String(active.text || '') : '';

  // Self-origin life events: type counts only (payloads can carry text).
  const lifeEvents = {};
  try {
    const life = await deps.life();
    if (life && typeof life.listEvents === 'function') {
      for (const e of life.listEvents({ after: 0, order: 'desc', limit: 500 }) || []) {
        if (!e || e.originKind !== 'self' || e.subjectJid || e.redacted) continue;
        if (Number.isFinite(e.at) && e.at < since) continue;
        bump(lifeEvents, codeOr(e.type));
      }
    }
  } catch { /* no life → no events */ }

  // Mood / base mood word counts (enums only).
  const moods = {};
  const els = typeof store.elementHistory === 'function'
    ? store.elementHistory({ sinceAt: since, kinds: ['mood', 'base_mood'] })
    : store.activeElements(t).filter(e => e.kind === 'mood' || e.kind === 'base_mood');
  for (const e of els || []) if (e && typeof e.word === 'string' && CODE_RE.test(e.word)) bump(moods, e.word);

  // Tone counts from recent digests (enum only; no summary text).
  const tones = {};
  for (const chat of recentChats(since)) {
    for (const d of store.digestsFor(chat, { sinceAt: since })) if (typeof d.tone === 'string') bump(tones, codeOr(d.tone));
  }

  // Nudge outcomes: knob, value, status (no reasons, no chat).
  const nudges = store.listNudges({ limit: 200 })
    .filter(n => Number.isFinite(n.createdAt) && n.createdAt >= since)
    .map(n => ({ knob: codeOr(n.knob), scope: n.scope === 'global' ? 'global' : 'group',
      value: typeof n.value === 'number' ? round3(n.value) : codeOr(n.value, null), status: codeOr(n.status) }))
    .slice(0, 30);

  // Proactive outcomes: counts by status / drop reason code / replied.
  const proactive = { byStatus: {}, dropped: {}, replied: 0, unanswered: 0 };
  for (const d of store.listDrafts({ limit: 100 })) {
    if (!Number.isFinite(d.createdAt) || d.createdAt < since) continue;
    bump(proactive.byStatus, codeOr(d.status));
    if (d.status === 'dropped') bump(proactive.dropped, codeOr(d.dropReason));
    if (['sent', 'dry_run'].includes(d.status)) { if (d.repliedAt) proactive.replied++; else proactive.unanswered++; }
  }

  // Rhythm only. How his lines look (emoji, capitals, script) stays out: the note sits in his own prompt, so naming a habit feeds it.
  const { msgs, medianLen, questionRate } = (await deps.styleStats(since)) ?? {};
  const style = { msgs, medianLen, questionRate };

  const stats = sortObj({ nights, lifeEvents, moods, tones, nudges, proactive, style });
  const hash = crypto.createHash('sha256').update(JSON.stringify({ baseVersion, text, stats })).digest('hex').slice(0, 32);
  const persona = deps.getPersona() || {};
  const name = String(persona.name || '').slice(0, 40);
  const vibe = String(persona.vibe || '').slice(0, 200);
  const user = [
    `Character: ${name || 'the character'}${vibe ? `. Vibe: ${vibe}` : ''}.`,
    `Current self-description (version ${baseVersion}):`,
    '---',
    stripFenceTokens(text) || '(empty)',
    '---',
    `Content-free statistics of the last ${nights} nights (JSON):`,
    JSON.stringify(stats),
    `Propose a small edit with "base_version": ${baseVersion}, or skip.`,
  ].join('\n');
  const summary = { hash, baseVersion, nights, chars: text.length, lifeEventTypes: Object.keys(lifeEvents).length,
    moods: Object.values(moods).reduce((a, b) => a + b, 0), tones: Object.values(tones).reduce((a, b) => a + b, 0),
    nudges: nudges.length, styleMsgs: Number(style?.msgs) || 0 };
  return { user, summary, hash, baseVersion };
}

// ── apply ────────────────────────────────────────────────────────────────────

// A fresh read of the active version (never the cache) for stale-base checks.
function freshVersion() {
  const r = activeRow();
  return r ? r.version : 0;
}

function supersedePending(exceptId = null) {
  for (const r of store.listSelfModel({ status: 'proposed', limit: 200 })) {
    if (r.id !== exceptId) store.setSelfModelStatus(r.id, 'superseded', {});
  }
}

function lastAutoApplyAt() {
  const v = store.getSettings().lastAutoApplyAt;
  return Number.isFinite(v) ? v : null;
}

function cleanSummary(s, names) {
  if (typeof s !== 'string') return null;
  const c = cleanLine(s).slice(0, 200);
  if (!c || hasIdentifier(c) || (names && names.test(c))) return null;
  return c;
}

/**
 * Store a scrubbed proposal. result = scrubProposal(...) output plus { baseVersion,
 * changesSummary?, fellBack?, names? (matcher, to drop a summary naming someone) }.
 * opts.auto: the caller's "end of sleep" auto-apply intent; it is ANDed with the
 * effective review state, the harm check and the 3-day gap here.
 * → { status: 'refused'|'invalid'|'unchanged'|'proposed'|'active', id?, version?, reason? }
 */
export async function applyProposal(result, runId = null, { auto = false } = {}) {
  const t = nowSec();
  if (!result || result.fellBack !== false) return { status: 'refused', reason: 'bad_source' };
  if (!result.ok) {
    const id = store.insertSelfModel({ source: 'mind', status: 'invalid', text: '', baseVersion: result.baseVersion ?? null,
      scrub: { ...result.report, rejectReason: result.rejectReason }, runId, createdAt: t });
    invalidate();
    return { status: 'invalid', id, version: store.getSelfModel(id)?.version ?? null, reason: result.rejectReason };
  }
  if (result.unchanged) return { status: 'unchanged' };
  // The base must still be the active version (an owner edit may have landed meanwhile).
  if (result.baseVersion !== freshVersion()) {
    const id = store.insertSelfModel({ source: 'mind', status: 'invalid', text: '', baseVersion: result.baseVersion ?? null,
      scrub: { ...result.report, rejectReason: 'stale' }, runId, createdAt: t });
    return { status: 'invalid', id, reason: 'stale' };
  }
  supersedePending();
  const scrub = { ...result.report };
  const id = store.insertSelfModel({ source: 'mind', status: 'proposed', text: result.text, baseVersion: result.baseVersion,
    diff: result.diff, changesSummary: cleanSummary(result.changesSummary, result.names), scrub, runId, createdAt: t });
  const version = store.getSelfModel(id)?.version ?? null;

  const review = store.reviewState(t);
  if (!auto || !review.autoActive) return { status: 'proposed', id, version, reason: auto ? 'review' : null };
  const last = lastAutoApplyAt();
  if (last !== null && t - last < AUTO_APPLY_GAP_SEC) return { status: 'proposed', id, version, reason: 'auto_gap' };
  const harm = await harmCheck(result.added);
  scrub.harm = { score: harm.score, pass: harm.pass };
  if (!harm.ok) {
    store.setSelfModelStatus(id, 'proposed', { scrub });
    return { status: 'proposed', id, version, reason: 'harm' };
  }
  store.setSelfModelStatus(id, 'active', { scrub, decidedAt: t, decidedBy: 'auto', activatedAt: t });
  store.setLastAutoApply(t);
  invalidate();
  deps.auditWrite('mind', 'mind.selfmodel.auto', String(version), { length: result.text.length, baseVersion: result.baseVersion });
  return { status: 'active', id, version };
}

// ── the nightly call ─────────────────────────────────────────────────────────

const SKIP_MAP = { budget: 'budget', global_cap: 'global_cap', no_key: 'no_key', unpriced: 'unpriced', disabled: 'disabled',
  shadow_only: 'disabled' };

function nightDiff(a, b) {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(pa) && Number.isFinite(pb) ? Math.round((pb - pa) / (DAY * 1000)) : Infinity;
}

/** The latest selfmodel run that reached the model and did not fall back (ok|invalid). */
function lastCompletedRun() {
  for (const r of store.listRuns({ kind: 'selfmodel', limit: 50 })) {
    if ((r.status === 'ok' || r.status === 'invalid') && !r.fellBack) return r;
  }
  return null;
}

/**
 * The self-model step at the end of sleep (research R5 step 4, R12). Runs at most
 * every config.mind.selfModelEveryNights nights and only when its input changed.
 * opts: { trigger = 'night', budgetOk = true, force = false }.
 * → { status: 'disabled'|'not_due'|'unchanged'|'skipped'|'failed'|'fell_back'|'invalid'|'skip'
 *              |'refused'|'proposed'|'active', runId?, proposalId?, version?, reason? }
 * A fell-back run stores nothing (plan review S2-05). Never throws.
 */
export async function runSelfModel(nightKey = null, { trigger = 'night', budgetOk = true, force = false } = {}) {
  let runId = null;
  try {
    const t = nowSec();
    const nk = typeof nightKey === 'string' && nightKey ? nightKey : clockNightKey(t);
    if (!deps.isMindOn()) return { status: 'disabled' };
    if (budgetOk === false || (typeof budgetOk === 'function' && !budgetOk())) return { status: 'skipped', reason: 'budget' };
    const last = lastCompletedRun();
    if (!force && last && last.nightKey && nightDiff(last.nightKey, nk) < everyNights()) return { status: 'not_due' };

    const input = await buildSelfModelInput({ at: t });
    if (!force && last) {
      const prev = store.getRun(last.id);
      if (prev?.input?.hash === input.hash) return { status: 'unchanged' };
    }

    runId = store.insertRun({ kind: 'selfmodel', trigger: trigger === 'owner' ? 'owner' : 'night', nightKey: nk,
      input: input.summary });
    const res = await deps.callRole('mind', SELFMODEL_CHARTER, input.user,
      { caller: 'mind.selfmodel', effort: 'low', maxTokens: 3000 });
    const usage = { model: res?.model ?? null, tokensIn: res?.usage?.input ?? null, tokensOut: res?.usage?.output ?? null,
      cacheRead: res?.usage?.cacheRead ?? null, costUsd: Number.isFinite(res?.costUsd) ? res.costUsd : null,
      fellBack: !!res?.fellBack };
    if (res?.skipped) {
      const reason = SKIP_MAP[res.skipped] || 'error';
      store.finishRun(runId, { status: 'skipped', skipReason: reason, ...usage });
      return { status: 'skipped', runId, reason };
    }
    if (!res || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
      store.finishRun(runId, { status: 'failed', error: codeOr(String(res?.status || 'no_text'), 'error'), ...usage });
      return { status: 'failed', runId };
    }
    if (res.fellBack) {
      store.finishRun(runId, { status: 'partial', error: 'fell_back', ...usage });
      logger.info({ runId, evt: 'mind.selfmodel', status: 'fell_back' }, 'mind: self-model run fell back, nothing stored');
      return { status: 'fell_back', runId };
    }
    const v = validateSelfModel(res.text);
    if (!v.ok) {
      store.finishRun(runId, { status: 'invalid', error: v.error, dropped: v.dropped, ...usage });
      return { status: 'invalid', runId, reason: v.error };
    }
    if (v.value.skip) {
      store.finishRun(runId, { status: 'ok', output: { skip: true }, dropped: v.dropped, ...usage });
      return { status: 'skip', runId };
    }
    if (v.value.oversize) {
      const applied = await applyProposal({ ok: false, rejectReason: 'oversize', report: { removedLines: [], warnings: [] },
        baseVersion: v.value.baseVersion, fellBack: false }, runId);
      store.finishRun(runId, { status: 'ok', output: { proposal: applied.status, proposalId: applied.id ?? null,
        rejectReason: 'oversize' }, dropped: v.dropped, ...usage });
      return { status: applied.status, runId, proposalId: applied.id, reason: 'oversize' };
    }

    // Scrub context (fail closed on unreadable names/corpus).
    let names = [];
    let corpus = null;
    try {
      names = [...(await deps.nameSet())];
      names.push(...castNames((await deps.life())?.getState?.()));
    } catch { names = []; }
    try { corpus = await recentScopedCorpus(t - (everyNights() + 1) * DAY); } catch { corpus = null; }
    const persona = deps.getPersona() || {};
    const allow = [persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : [])]
      .filter(x => typeof x === 'string');
    const active = activeRow();
    const scrub = scrubProposal({ baseVersion: v.value.baseVersion, text: v.value.text }, {
      mode: 'mind', activeVersion: active ? active.version : 0, activeText: active ? String(active.text || '') : '',
      source: { caller: 'mind.selfmodel', fellBack: false }, names, allow, corpus,
    });
    const applied = await applyProposal({ ...scrub, baseVersion: v.value.baseVersion, changesSummary: v.value.changesSummary,
      fellBack: false, names: buildNameMatcher(names, allow) }, runId, { auto: true });
    store.finishRun(runId, { status: 'ok', dropped: v.dropped, ...usage, output: { proposal: applied.status,
      proposalId: applied.id ?? null, version: applied.version ?? null, rejectReason: scrub.ok ? null : scrub.rejectReason,
      removed: (scrub.report?.removedLines || []).length, reason: applied.reason ?? null } });
    return { status: applied.status, runId, proposalId: applied.id, version: applied.version, reason: applied.reason ?? null };
  } catch (err) {
    if (runId !== null) {
      try { store.finishRun(runId, { status: 'failed', error: String(err?.code || err?.name || 'error').slice(0, 60) }); } catch { /* ignore */ }
    }
    logger.warn({ evt: 'issue', runId, code: String(err?.code || err?.name || 'error').slice(0, 60) }, 'mind: self-model run failed');
    return { status: 'failed', runId };
  }
}

/** Names of life's cast (any shape: array or map of objects/strings). Code-only. */
function castNames(state) {
  const out = [];
  const cast = state && typeof state === 'object' ? state.cast : null;
  if (!cast) return out;
  const list = Array.isArray(cast) ? cast : typeof cast === 'object' ? Object.values(cast) : [];
  for (const c of list) {
    if (typeof c === 'string') out.push(c);
    else if (c && typeof c === 'object') {
      for (const k of ['name', 'nickname', 'displayName', 'fullName']) if (typeof c[k] === 'string') out.push(c[k]);
      if (Array.isArray(c.aliases)) out.push(...c.aliases.filter(a => typeof a === 'string'));
    }
  }
  return out;
}

// ── owner actions (routes/mind.js audits them) ───────────────────────────────

async function ownerScrub(text) {
  let names = [];
  try {
    names = [...(await deps.nameSet())];
    names.push(...castNames((await deps.life())?.getState?.()));
  } catch { names = []; }
  const persona = deps.getPersona() || {};
  const allow = [persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : [])]
    .filter(x => typeof x === 'string');
  const active = activeRow();
  return scrubProposal({ text }, { mode: 'owner', activeVersion: active ? active.version : 0,
    activeText: active ? String(active.text || '') : '', names, allow });
}

function checkActor(by) {
  if (typeof by !== 'string' || !/^owner:[^\r\n]{1,100}$/.test(by)) throw new OwnerError('bad_actor', 400);
}

/** proposed → active now (the old active → superseded; other pending → superseded). */
export function approve(id, by) {
  checkActor(by);
  const row = store.getSelfModel(Number(id));
  if (!row) throw new OwnerError('not_found', 404);
  if (row.status !== 'proposed') throw new OwnerError('not_pending', 409);
  if (row.baseVersion !== freshVersion()) {
    store.setSelfModelStatus(row.id, 'superseded', {});
    throw new OwnerError('not_pending', 409);
  }
  const t = nowSec();
  store.setSelfModelStatus(row.id, 'active', { decidedAt: t, decidedBy: by, activatedAt: t });
  supersedePending(row.id);
  invalidate();
  return { ok: true, id: row.id, version: row.version };
}

/** proposed → rejected (the reason text is not stored). */
/**
 * Owner reject. opts.reason (the owner's own note, ≤ 200 chars) is kept with the
 * version as scrub.ownerReason (mind_self_model has no owner-note column; the scrub
 * report already records why a version was refused). Never logged or audited.
 */
export function reject(id, by, opts = {}) {
  checkActor(by);
  const row = store.getSelfModel(Number(id));
  if (!row) throw new OwnerError('not_found', 404);
  if (row.status !== 'proposed') throw new OwnerError('not_pending', 409);
  const reason = typeof opts?.reason === 'string' ? opts.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
  const fields = { decidedAt: nowSec(), decidedBy: by };
  if (reason) {
    const base = row.scrub && typeof row.scrub === 'object' && !Array.isArray(row.scrub) ? row.scrub : {};
    const merged = { ...base, ownerReason: reason };
    // scrub_json holds ≤ 4096 chars; an oversize merge would be stored as a bare
    // _truncated marker, so the owner's note wins over the report in that case.
    fields.scrub = JSON.stringify(merged).length <= 4096 ? merged : { ownerReason: reason, _truncated: true };
  }
  store.setSelfModelStatus(row.id, 'rejected', fields);
  return { ok: true, id: row.id, version: row.version };
}

function insertOwnerVersion(scrub, by, extra = {}) {
  const t = nowSec();
  const base = freshVersion();
  const id = store.insertSelfModel({ source: 'owner', status: 'active', text: scrub.text, baseVersion: base,
    diff: scrub.diff, scrub: scrub.report, decidedAt: t, decidedBy: by, activatedAt: t, createdAt: t, ...extra });
  supersedePending(id);
  invalidate();
  const row = store.getSelfModel(id);
  return { ok: true, id, version: row?.version ?? null, warnings: scrub.report.warnings || [],
    removed: (scrub.report.removedLines || []).length };
}

/** Owner edit → a new active version (identifiers removed with a warning; names warn; ≤ 1500). */
export async function editText(text, by) {
  checkActor(by);
  if (typeof text !== 'string') throw new OwnerError('bad_request', 400);
  const scrub = await ownerScrub(text);
  if (!scrub.ok) throw new OwnerError(scrub.rejectReason === 'oversize' || scrub.rejectReason === 'bad_text' ? 'bad_request' : scrub.rejectReason,
    scrub.rejectReason === 'oversize' || scrub.rejectReason === 'bad_text' ? 400 : 409);
  return insertOwnerVersion(scrub, by);
}

/**
 * Revert to ANY version (FR-016): a new active copy, source 'owner', after the
 * owner-edit scrub path. An invalid row (no text kept) or a copy that still fails →
 * OwnerError('not_revertible', 409).
 */
export async function revertTo(id, by) {
  checkActor(by);
  const row = store.getSelfModel(Number(id));
  if (!row) throw new OwnerError('not_found', 404);
  if (row.status === 'invalid') throw new OwnerError('not_revertible', 409);
  const scrub = await ownerScrub(String(row.text || ''));
  if (!scrub.ok) throw new OwnerError('not_revertible', 409);
  return insertOwnerVersion(scrub, by);
}

/** Dashboard read: { active, pending, versions } (texts are the dashboard's to escape). */
export function overview() {
  const active = activeRow();
  const versions = store.listSelfModel({ limit: 100 });
  return {
    active: active ? { id: active.id, version: active.version, text: active.text, activatedAt: active.activatedAt,
      source: active.source } : null,
    pending: versions.filter(v => v.status === 'proposed'),
    versions: versions.map(v => ({ id: v.id, version: v.version, status: v.status, source: v.source, createdAt: v.createdAt,
      decidedBy: v.decidedBy, changesSummary: v.changesSummary,
      ...(v.status === 'rejected' && typeof v.scrub?.ownerReason === 'string' ? { ownerReason: v.scrub.ownerReason } : {}) })),
  };
}
