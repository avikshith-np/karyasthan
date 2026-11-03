// Proactive messages (spec 008, contracts/proactive.md, research R15–R19).
//
//   think.reach_out[] ─► A. eligibility (code, 12 checks) ─► B. intent (mind.draft, audience-filtered)
//                      ─► C. voice (mouth) + gate ─► shadow: store (shadow | would_send)
//                                                   live:   queue ─► D. dispatch (withChatLock, re-check) ─► sendText
//
// Rules this module enforces in code (never in a prompt):
// - A failure in A is a run note (no row). A candidate that passes all twelve checks
//   gets a `drafting` row; B/C failures end it as `dropped:<reason>`. So
//   draftsPerDay is a cost cap over rows that reached B.
// - Every basis digest of chat X may support target Y only if X === Y or
//   canUseIn({originJid: X, originKind, learnedAt: digest.period_start}, aud(Y)) — the
//   006 item rule WITH the join-time floor. check_in is DM-only and its one basis is
//   Y's own digest. A DM-origin basis therefore never reaches a group or another person.
// - Stage B's input is built only from resolveAudience(Y) reads; the think's reason and
//   note are never passed on. The intent is untrusted model text: identifiers, harm
//   terms and outsider names drop it before the mouth sees it.
// - The gate must give a verdict: score == null (gate_disabled included) blocks, and the
//   score must reach max(qualityGate.threshold, mind.proactiveMinScore). recordQuality
//   is never called for proactive text.
// - Shadow NEVER sends: only `dispatchDue` calls sendText, and only for `queued` rows,
//   which exist only in live mode (proactive_mode 'live' AND OWNER_JIDS set).
// - No send to any OWNER_JIDS form, ever (target check at A4/D3 and a last guard on the
//   exact jid right before sendText).
// - Fun A/B: group targets only, no `send`; alt_text is stored and never read by dispatch.
// - Dispatch re-checks everything inside withChatLock with a fresh audience, compares the
//   stage-C audience snapshot, and checks config.dryRun BEFORE calling sendText.
//
// This is the only src/mind/ file that imports sendText (dynamically, below).
// Logging: ids, counts, statuses and reason codes only — never a digest, thread,
// intent, voiced/alt text, gate reason or the think's reason.

import crypto from 'crypto';
import * as store from './store.js';
import { now as clockNow, dayKey, inSleepHours } from './clock.js';
import { isDegraded as hooksIsDegraded } from './hooks.js';
import { DRAFT_CHARTER, cleanChatText, fenceBlock } from './charter.js';
import { validateDraft } from './schema.js';
import { buildNameMatcher } from './selfModel.js';
import { callRole as realCallRole } from '../brain/llm.js';
import { evaluateResponse as realEvaluate } from '../brain/qualityGate.js';
import { postProcess } from '../brain/postProcess.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { looksLikeRelay } from '../brain/relay.js';
import { budgetState } from '../brain/usage.js';
import { resolveRole } from '../brain/roles.js';
import { resolveAudience, allowedOrigins, canUseIn, recall, recallEpisodes, recallRelationships } from '../memory/recall.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid, isSelfJid } from '../memory/identity.js';
import { isFresh, allGroupJids } from '../memory/membership.js';
import { getRecentMessages, getRecentMessagesForPrompt } from '../memory/messageStore.js';
import { getGroup } from '../memory/groupStore.js';
import { getImitationTarget } from '../behavior/imitationState.js';
import { checkWarmup, recordSent } from '../behavior/warmup.js';
import { checkRateLimit, checkHourlyCaps } from '../behavior/rateLimiter.js';
import { isGroupMuted } from '../dashboard/state.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { flattenContent } from '../utils/transcript.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

export const STALE_DRAFTING_SEC = 15 * MIN;
export const LATEST_DIGEST_MAX_AGE_SEC = 48 * HOUR;
export const MAX_CANDIDATES = 2;
export const VOICED_MAX = 1000;
export const SEND_JITTER_MIN = [2, 20];
export const DISPATCH_SCAN_MAX = 10;
const SNAPSHOT_WINDOW = 200;      // newest messages read for the content snapshot
const SNAPSHOT_LINES = 60;        // lines at/before created_at that are hashed
const SNAPSHOT_MEMBERS_MAX = 150; // above this only a hash of the member set is stored
const EVIDENCE_WINDOW = 500;

export const PROACTIVE_HARM = 'This message is unprompted: the bot is starting the conversation, nobody asked. '
  + 'Score 0.0 if it reveals anything private, mentions another chat or people outside this chat, asks for money, '
  + 'OTPs, passwords or personal details, pressures anyone, or would feel intrusive.';

/** The opener instruction the mouth gets in place of the reply instruction (research R17). */
export function openerText(intent) {
  return `You are texting first. Write one short, natural message that does this: ${intent}. `
    + 'If it would feel forced right now, reply [SKIP].';
}

// ── code constant lists (R12 identifier patterns + the harm part of the forbidden list) ──

const IDENT_RES = [
  /\+?\d[\d\s().-]{7,}\d/,
  /@(s\.whatsapp\.net|g\.us|lid)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  /\b(?:https?:\/\/|www\.)\S+/i,
  /\b[a-z0-9-]+\.(?:com|net|org|io|in|co|app|me|ly|gg|xyz|info|dev|ai|tv|to|link)\b/i,
  /@\d{5,}/,
];
const HARM_TERMS = [
  'money', 'pay', 'pays', 'paid', 'paying', 'payments?', 'loans?', 'lend\\w*', 'invest\\w*', 'crypto\\w*', 'coins?',
  'stocks?', 'trading', 'bets?', 'betting', 'links?', 'urls?', 'websites?', 'numbers?', 'phones?', 'contacts?',
  'send\\s+me', 'share\\s+your', 'recommend\\w*', 'buy\\w*', 'sell\\w*', 'discounts?', 'offers?', 'sign\\s*up',
  'subscrib\\w*', 'download\\w*', 'install\\w*', 'address(?:es)?', 'locations?', 'banks?', 'cards?', 'upi',
  'otps?', 'passwords?', 'pins?', 'cvv',
];
const HARM_RE = new RegExp(`\\b(?:${HARM_TERMS.join('|')})\\b`, 'i');
const hasIdentifier = (s) => IDENT_RES.some(re => re.test(s));

// "message/DM/text/ask/tell <name>" aimed at the bot (research R15 check 9). The word(s)
// after the verb are tested against the known-name matcher.
const CONTACT_RE = /\b(?:message|msg|dm|pm|text|txt|ping|ask|tell|remind|inform|contact|call|ring|whatsapp|send|let|notify)\s+(?:to\s+)?(@?\+?[\p{L}\p{N}][\p{L}\p{N}'._-]*)(?:\s+([\p{L}][\p{L}'.-]*))?/giu;

// ── deps (test seam) ─────────────────────────────────────────────────────────

// Neighbours loaded lazily: the life facade, knobs, dontText, selfState, think, the
// prompt builder, the socket-side send and the chat lock (events.js pulls in Baileys).
const lazy = new Map();
function lazyMod(path) {
  if (!lazy.has(path)) lazy.set(path, import(path).catch(() => null));
  return lazy.get(path);
}
let lifeMod = null;
lazyMod('../life/index.js').then((m) => { lifeMod = m; });
let knobsMod = null;
lazyMod('./knobs.js').then((m) => { knobsMod = m; });

async function defaultBudgetOk(kind) {
  const think = await lazyMod('./think.js');
  if (think && typeof think.mindBudgetOk === 'function') {
    const r = await think.mindBudgetOk(kind);
    return r === true || (r && typeof r === 'object' && r.ok === true);
  }
  // Until think.js exports mindBudgetOk (T019): the role/global part of R23 for drafts.
  const st = budgetState('mind');
  if (!st.allowed) return false;
  if (st.budgetUsd > 0 && st.spentUsd >= 0.8 * st.budgetUsd) return false;
  if (st.globalBudgetUsd > 0 && st.globalSpentUsd >= 0.7 * st.globalBudgetUsd) return false;
  return true;
}

function defaultFunAvailable() {
  const r = resolveRole('fun', config);
  if (!r || r.disabled || !r.provider || !r.model) return false;
  return budgetState('fun').allowed === true;
}

async function defaultBuildPrompt({ chatJid, isGroup, audience, opener }) {
  const sp = await import('../personality/systemPrompt.js');
  const system = sp.buildSystemParts(chatJid, isGroup, null, { audience, webEnabled: false, track: false });
  // `opener` replaces the reply instruction (systemPrompt renders openerText(intent));
  // a missing intent throws there, so the draft is dropped rather than voiced as a reply.
  const ctx = sp.buildConversationContext(chatJid, null, isGroup, {
    audience, webEnabled: false, track: false, opener,
  });
  const user = typeof ctx === 'string' ? ctx : ctx?.text;
  if (typeof user !== 'string' || !user) throw new Error('buildConversationContext returned no text');
  return { system, user };
}

function defaultSnippet(chatJid) {
  const persona = getPersona() || {};
  return getRecentMessagesForPrompt(chatJid, 8).filter(m => m.message_type !== 'reaction').slice(-8).map((m) => {
    const who = m.is_from_self ? `${persona.name || 'you'} (you)` : (m.sender_name || 'Someone');
    const text = sanitizeWebContent(String(flattenContent(m.content, m.message_type) || '')).replace(/\s+/g, ' ').trim()
      .slice(0, 200);
    return `[${cleanChatText(who, 40)}]: ${text}`;
  }).join('\n');
}

function defaultSendForm(personJid) {
  const forms = new Set(identitiesOf(personJid));
  const last = getRecentMessages(personJid, 1)[0];
  const form = last ? bareJid(last.group_jid) : null;
  return form && forms.has(form) ? form : null;
}

function defaultMessageTexts(chatJid, ids) {
  const want = new Set(ids);
  const out = new Map();
  for (const m of getRecentMessages(chatJid, EVIDENCE_WINDOW)) {
    if (want.has(m.id)) out.set(m.id, String(flattenContent(m.content, m.message_type) || ''));
  }
  return out;
}

function defaultGroupNames() {
  const out = [];
  for (const jid of allGroupJids()) {
    const n = getGroup(jid)?.name;
    if (typeof n === 'string' && n.trim()) out.push(n);
  }
  return out;
}

async function defaultNameSet() {
  const m = await lazyMod('../memory/mindReads.js');
  return m && typeof m.nameSet === 'function' ? m.nameSet() : new Set();
}
async function defaultNamesOf(personJid) {
  const m = await lazyMod('../memory/mindReads.js');
  return m && typeof m.namesOf === 'function' ? m.namesOf(personJid) : new Set();
}

const DEFAULT_DEPS = {
  now: () => clockNow(),
  random: () => Math.random(),
  callRole: (role, system, user, opts) => realCallRole(role, system, user, opts),
  evaluateResponse: (text, snippet, opts) => realEvaluate(text, snippet, opts),
  sendText: async (sock, jid, text) => (await import('../whatsapp/actions.js')).sendText(sock, jid, text),
  withChatLock: async (chatJid, fn) => (await import('../whatsapp/events.js')).withChatLock(chatJid, fn),
  life: () => lifeMod,
  isMindOn: () => isSkillEnabled('mind'),
  isDegraded: () => hooksIsDegraded(),
  budgetOk: (kind) => defaultBudgetOk(kind),
  funAvailable: () => defaultFunAvailable(),
  appetite: () => {
    const k = knobsMod?.knobs?.proactiveAppetite || knobsMod?.proactiveAppetite;
    return typeof k === 'function' ? k() : 1;
  },
  lookback: async (personJid) => {
    const m = await lazyMod('./dontText.js');
    return m && typeof m.lookback === 'function' ? m.lookback(personJid) : { hit: true, error: 'no_dontText' };
  },
  selfStateLine: async (aud, ctx) => {
    const m = await lazyMod('./selfState.js');
    return m && typeof m.renderLine === 'function' ? m.renderLine(aud, { ...ctx, track: false }) : '';
  },
  buildPrompt: (q) => defaultBuildPrompt(q),
  snippet: (chatJid) => defaultSnippet(chatJid),
  resolveAudience: (q) => resolveAudience(q),
  allowedOrigins: (aud) => allowedOrigins(aud),
  canUseIn: (item, aud) => canUseIn(item, aud),
  recall: (aud, opts) => recall(aud, opts),
  recallEpisodes: (aud, opts) => recallEpisodes(aud, opts),
  recallRelationships: (aud, opts) => recallRelationships(aud, opts),
  nameSet: () => defaultNameSet(),
  namesOf: (p) => defaultNamesOf(p),
  groupNames: () => defaultGroupNames(),
  messageTexts: (chatJid, ids) => defaultMessageTexts(chatJid, ids),
  chatMessages: (chatJid, limit) => getRecentMessages(chatJid, limit),
  sendForm: (personJid) => defaultSendForm(personJid),
  isFresh: (jid) => isFresh(jid),
  imitating: (jid) => !!getImitationTarget(jid),
  isGroupMuted: (jid) => isGroupMuted(jid),
  checkWarmup: (t) => checkWarmup(t),
  recordSent: () => recordSent(),
  checkRateLimit: (jid) => checkRateLimit(jid),
  checkHourlyCaps: (jid, o) => checkHourlyCaps(jid, o),
};
let deps = { ...DEFAULT_DEPS };

/**
 * Test seam: override any of { now, random, callRole, evaluateResponse, sendText,
 * withChatLock, life (→ facade|null), isMindOn, isDegraded, budgetOk, funAvailable,
 * appetite, lookback, selfStateLine, buildPrompt, snippet, resolveAudience,
 * allowedOrigins, canUseIn, recall, recallEpisodes, recallRelationships, nameSet,
 * namesOf, groupNames, messageTexts, chatMessages, sendForm, isFresh, imitating,
 * isGroupMuted, checkWarmup, recordSent, checkRateLimit, checkHourlyCaps }. null resets.
 */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  dayStartCache.clear();
}

// ── small helpers ────────────────────────────────────────────────────────────

const nowSec = () => Math.floor(deps.now());
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const intOf = (v, d) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const COUNTED = store.DRAFT_COUNTED;

function issue(where, err) {
  logger.warn({ evt: 'issue', where: `mind.proactive.${where}`, code: String(err?.code || err?.name || 'error').slice(0, 60) },
    'mind proactive step failed (fail closed)');
}

const dayStartCache = new Map();
/** Unix second of the local midnight that starts t's local day (config.timezone, DST-safe). */
export function dayStart(t) {
  const key = dayKey(t);
  const hit = dayStartCache.get(key);
  if (hit != null && hit <= t && t - hit < 26 * HOUR) return hit;
  let lo = t - 30 * HOUR;
  let hi = t;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayKey(mid) === key) hi = mid; else lo = mid;
  }
  if (dayStartCache.size > 64) dayStartCache.clear();
  dayStartCache.set(key, hi);
  return hi;
}

function proactiveCfg() {
  const p = config.mind?.proactive || {};
  return {
    dmEveryDays: intOf(p.dmEveryDays, 3),
    groupPerDay: intOf(p.groupPerDay, 1),
    maxPerDay: intOf(p.maxPerDay, 4),
    dmBackoffDays: intOf(p.dmBackoffDays, 7),
    groupBackoffDays: intOf(p.groupBackoffDays, 3),
    draftsPerDay: intOf(p.draftsPerDay, 8),
    ttlHours: Math.max(1, intOf(config.mind?.proactiveTtlHours, 6)),
    minScore: fin(Number(config.mind?.proactiveMinScore)) ? Number(config.mind.proactiveMinScore) : 0.5,
  };
}

function lifeFacade() {
  try {
    const l = deps.life();
    return l && typeof l === 'object' ? l : null;
  } catch {
    return null;
  }
}
function lifeOn(life) {
  try { return !!life && typeof life.isLifeOn === 'function' && life.isLifeOn() === true; } catch { return false; }
}
/** A heavy-event embargo (life on or off: the facade answers null/false when not running). Fails closed on a throw. */
function embargoed(life) {
  if (!life) return false;
  try {
    if (typeof life.embargoActive === 'function' && life.embargoActive()) return true;
    if (typeof life.lifeGuardNote === 'function') {
      const note = life.lifeGuardNote();
      if (note !== null && note !== undefined && note !== '') return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ── owner identity (FR-031) ──────────────────────────────────────────────────

function ownerSet() {
  const forms = new Set();
  const digits = new Set();
  const raw = Array.isArray(config.ownerJids) ? config.ownerJids : [];
  for (const r of raw) {
    const s = String(r || '').trim();
    if (!s) continue;
    const p = resolvePerson(s);
    if (p) for (const f of identitiesOf(p)) forms.add(f);
    const b = bareJid(s);
    if (b && isPersonJid(b)) forms.add(b);
    if (!s.endsWith('@lid')) {
      const d = (s.includes('@') ? s.split('@')[0] : s).split(':')[0].replace(/\D/g, '');
      if (d.length >= 6) digits.add(d);
    }
  }
  // `any` only counts entries that resolve to something isOwnerJid can match: an
  // OWNER_JIDS of typos must not enable live mode with a no-op owner guard (A4/D12).
  return { forms, digits, any: forms.size > 0 || digits.size > 0 };
}

/** True when OWNER_JIDS has at least one entry that resolves to an owner identity form. */
export function ownerJidsResolved() {
  try { return ownerSet().any; } catch { return false; }
}

/** True when `jid` (any form) is one of the owner's identities. */
export function isOwnerJid(jid, own = ownerSet()) {
  const b = bareJid(jid);
  if (!b || !isPersonJid(b)) return false;
  const p = resolvePerson(b);
  const all = new Set([b, ...(p ? identitiesOf(p) : [])]);
  for (const f of all) {
    if (own.forms.has(f)) return true;
    if (f.endsWith('@s.whatsapp.net') && own.digits.has(f.split('@')[0].replace(/\D/g, ''))) return true;
  }
  return false;
}

// ── settings / modes ─────────────────────────────────────────────────────────

function settings() {
  try {
    return store.getSettings();
  } catch (err) {
    issue('settings', err);
    return { paused: true, proactiveMode: 'off', excludeAll: true, firstEnabledAt: null };
  }
}

/** 'off' | 'shadow' | 'live' — live needs OWNER_JIDS (research R15 check 2); otherwise it behaves as shadow. */
export function effectiveMode(s = settings()) {
  if (s.proactiveMode === 'off') return 'off';
  if (s.proactiveMode === 'live' && ownerSet().any) return 'live';
  return 'shadow';
}

/** A1: skill, initialisation, degraded, pause, mode, embargo, exclude_all. → reason | null */
function globalGate(s) {
  if (!deps.isMindOn()) return 'skill_off';
  if (s.firstEnabledAt == null) return 'not_initialised';
  if (deps.isDegraded()) return 'degraded';
  if (s.paused) return 'paused';
  if (effectiveMode(s) === 'off') return 'mode_off';
  if (embargoed(lifeFacade())) return 'embargo';
  if (s.excludeAll) return 'exclude_all';
  return null;
}

// ── A4 target ────────────────────────────────────────────────────────────────

/** → { Y, isGroup, person } | { reason } */
function resolveTarget(chatJid) {
  if (typeof chatJid !== 'string' || !chatJid || isSelfJid(chatJid)) return { reason: 'bad_target' };
  if (isGroupJid(chatJid)) {
    const Y = bareJid(chatJid);
    if (!deps.isFresh(Y)) return { reason: 'bad_target' };
    if (deps.imitating(Y)) return { reason: 'bad_target' };
    return { Y, isGroup: true, person: null };
  }
  if (!isPersonJid(chatJid)) return { reason: 'bad_target' };   // ig:*, calls, anything else
  const person = resolvePerson(chatJid);
  if (!person || isSelfJid(person)) return { reason: 'bad_target' };
  if (isOwnerJid(person)) return { reason: 'owner_target' };
  return { Y: person, isGroup: false, person };
}

// ── basis ────────────────────────────────────────────────────────────────────

function threadOf(d, k) {
  const list = Array.isArray(d?.threads) ? d.threads : [];
  return list.find(th => Number(th?.k) === Number(k)) || null;
}

/**
 * Resolve basis refs [{digestId, thread}|{digestId, today:true}] against the digests.
 * `expect[i]` = { chatJid, periodStart? } the digest must still match (draft: the label
 * map's chat; dispatch: origins_json). → { items:[{d, ref}] } | { reason:'basis_gone' }
 */
function resolveBasis(refs, expect) {
  const items = [];
  for (const [i, ref] of refs.entries()) {
    const d = ref && ref.digestId != null ? store.getDigest(ref.digestId) : null;
    if (!d) return { reason: 'basis_gone' };
    const e = expect[i] || {};
    if (e.chatJid && e.chatJid !== d.chatJid) return { reason: 'basis_gone' };
    if (e.periodStart != null && e.periodStart !== d.periodStart) return { reason: 'basis_gone' };
    if (ref.today === true) { if (!d.todayNote) return { reason: 'basis_gone' }; }
    else if (!threadOf(d, ref.thread)) return { reason: 'basis_gone' };
    items.push({ d, ref });
  }
  return { items };
}

const sameChat = (x, t) => x === t.Y || (!t.isGroup && isPersonJid(x) && resolvePerson(x) === t.Y);

/** A9: every basis digest's chat X: X === Y or the item rule with the join-time floor. check_in: Y's own DM digest. */
function basisAudienceOk(t, kind, items, aud) {
  if (kind === 'check_in') {
    if (t.isGroup || items.length !== 1) return false;
    return sameChat(items[0].d.chatJid, t);
  }
  for (const { d } of items) {
    if (sameChat(d.chatJid, t)) continue;
    const ok = deps.canUseIn({ originJid: d.chatJid, originKind: d.originKind === 'group' ? 'group' : 'dm',
      learnedAt: d.periodStart, subjectJid: null }, aud) === true;
    if (!ok) return false;
  }
  return true;
}

async function knownNameMatcher(cache) {
  if (!cache.names) {
    const persona = getPersona() || {};
    const allow = [persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : [])]
      .filter(Boolean);
    const set = await deps.nameSet();
    cache.names = buildNameMatcher([...(set || [])], allow);
  }
  return cache.names;
}

function contactLike(text, matcher) {
  CONTACT_RE.lastIndex = 0;
  let m;
  while ((m = CONTACT_RE.exec(text)) !== null) {
    const w1 = m[1] || '';
    if (/^@?\+?\d{5,}$/.test(w1)) return true;
    if (!matcher || matcher.size === 0) return true;            // cannot tell names apart → fail closed
    if (matcher.test(w1) || (m[2] && matcher.test(`${w1} ${m[2]}`))) return true;
  }
  return false;
}

/** A10: relay-like evidence lines; a DM target with a group basis must be the thread's author. */
async function relayAuthorCheck(t, items, cache) {
  for (const { d, ref } of items) {
    if (ref.today === true) continue;
    const th = threadOf(d, ref.thread);
    const ids = (Array.isArray(th?.evidence) ? th.evidence : []).filter(x => typeof x === 'string' && x);
    if (!ids.length) return 'relay_like';
    let texts;
    try { texts = await deps.messageTexts(d.chatJid, ids); } catch { return 'relay_like'; }
    if (!cache.groupNames) { try { cache.groupNames = deps.groupNames() || []; } catch { cache.groupNames = []; } }
    const matcher = await knownNameMatcher(cache);
    for (const id of ids) {
      const text = texts?.get ? texts.get(id) : undefined;
      if (typeof text !== 'string') return 'relay_like';        // evidence gone or unreadable → fail closed
      if (looksLikeRelay(text, cache.groupNames) || contactLike(text, matcher)) return 'relay_like';
    }
    if (!t.isGroup && d.originKind === 'group') {
      const authors = Array.isArray(th.authors) ? th.authors : [];
      if (!authors.some(a => a === t.person || resolvePerson(a) === t.person)) return 'not_author';
    }
  }
  return null;
}

// ── A5–A10 (shared by draft, shadow would_send and dispatch) ─────────────────

/**
 * A5 exclusions, A6 back-off, A7 caps, A8 appetite, A9 basis audience, A10 relay/author.
 * → { reason } | { items }
 */
async function eligibility(t, { kind, urgency, refs, expect, aud, excludeId = null, cache = {} }) {
  const now = nowSec();
  const pc = proactiveCfg();

  // A5
  if (t.isGroup) {
    if (store.exclusionsFor([t.Y]).some(r => r.kind === 'group')) return { reason: 'excluded' };
    if (deps.isGroupMuted(t.Y)) return { reason: 'muted' };
  } else {
    const rows = store.exclusionsFor(identitiesOf(t.person)).filter(r => r.kind === 'person');
    if (rows.some(r => r.source === 'owner')) return { reason: 'excluded' };
    if (rows.some(r => r.source === 'detected')) return { reason: 'dont_text' };
    let lb;
    try { lb = await deps.lookback(t.person); } catch { lb = { hit: true }; }
    if (!lb || lb.hit !== false) return { reason: 'dont_text' };
  }

  // A6
  const last = store.lastSentTo([t.Y]);
  if (last && last.repliedAt == null) {
    const days = t.isGroup ? pc.groupBackoffDays : pc.dmBackoffDays;
    const at = last.sentAt ?? last.createdAt;
    if (now - at < days * DAY) return { reason: 'backoff' };
  }

  // A7
  const today = dayStart(now);
  if (t.isGroup) {
    if (pc.groupPerDay <= 0) return { reason: 'cap' };
    if (store.countDrafts({ chatJid: [t.Y], statuses: COUNTED, since: today, excludeId }) >= pc.groupPerDay) return { reason: 'cap' };
  } else {
    if (pc.dmEveryDays <= 0) return { reason: 'cap' };
    if (store.countDrafts({ chatJid: [t.Y], statuses: COUNTED, since: now - pc.dmEveryDays * DAY, excludeId }) >= 1) return { reason: 'cap' };
  }
  if (pc.maxPerDay <= 0 || store.countDrafts({ statuses: COUNTED, since: today, excludeId }) >= pc.maxPerDay) {
    return { reason: 'cap' };
  }

  // A8
  let appetite = 1;
  try { appetite = Number(deps.appetite()); } catch { appetite = 1; }
  const bar = appetite > 0 && Number.isFinite(appetite) ? Math.min(0.9, 0.5 / appetite) : 0.9;
  if (!fin(urgency) || urgency < bar) return { reason: 'appetite' };

  // A9
  const b = resolveBasis(refs, expect);
  if (b.reason) return b;
  if (!basisAudienceOk(t, kind, b.items, aud)) return { reason: 'basis_audience' };

  // A10
  const r = await relayAuthorCheck(t, b.items, cache);
  if (r) return { reason: r };
  return { items: b.items };
}

/** A11: for a DM target P, no OTHER DM digest in this run's input names P. */
async function foreignDmTrigger(t, labelMap) {
  if (t.isGroup) return null;
  const others = [];
  for (const e of Object.values(labelMap || {})) {
    if (!e || e.kind !== 'dm' || e.digestId == null || sameChat(e.chatJid, t)) continue;
    const d = store.getDigest(e.digestId);
    if (d && d.chatJid === e.chatJid) others.push(d);
  }
  if (!others.length) return null;
  let names;
  try { names = await deps.namesOf(t.person); } catch { return 'foreign_dm_trigger'; }
  const persona = getPersona() || {};
  const matcher = buildNameMatcher([...(names || [])],
    [persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].filter(Boolean));
  if (matcher.size === 0) return 'foreign_dm_trigger';           // no way to check → fail closed
  for (const d of others) {
    const text = [d.summary, d.todayNote, ...(Array.isArray(d.threads) ? d.threads.map(th => th?.text) : [])]
      .filter(x => typeof x === 'string').join('\n');
    if (matcher.test(text)) return 'foreign_dm_trigger';
  }
  return null;
}

/** A12: one queued row per chat; no drafting row younger than 15 min. */
function duplicate(t) {
  if (store.countDrafts({ chatJid: [t.Y], statuses: ['queued'] }) > 0) return true;
  return store.countDrafts({ chatJid: [t.Y], statuses: ['drafting'], since: nowSec() - STALE_DRAFTING_SEC }) > 0;
}

// ── candidate shape ──────────────────────────────────────────────────────────

/**
 * A reach_out item from validateThink ({kind, target, targetChat, basis:[{digestId,
 * label?, chatJid?, thread?|today?}], urgency, reason}). Everything is re-derived from
 * the run's label map; nothing the model said about chats or origins is trusted.
 * → { kind, urgency, thinkReason, entry, refs, expect } | { reason }
 */
function parseCandidate(cand, labelMap) {
  if (!cand || typeof cand !== 'object') return { reason: 'bad_shape' };
  if (!store.DRAFT_KINDS.includes(cand.kind)) return { reason: 'bad_shape' };
  if (!fin(cand.urgency) || cand.urgency < 0 || cand.urgency > 1) return { reason: 'bad_shape' };
  const map = labelMap && typeof labelMap === 'object' ? labelMap : {};
  const has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k);
  const entry = has(cand.target) ? map[cand.target] : null;
  if (!entry || (cand.targetChat && cand.targetChat !== entry.chatJid)) return { reason: 'bad_target' };
  const list = Array.isArray(cand.basis) ? cand.basis : [];
  const refs = [];
  const expect = [];
  for (const b of list) {
    if (!b || typeof b !== 'object' || b.digestId == null) return { reason: 'bad_basis' };
    const label = has(b.label) ? b.label : Object.keys(map).find(k => map[k]?.digestId === Number(b.digestId));
    const be = label ? map[label] : null;
    if (!be || be.digestId !== Number(b.digestId) || (b.chatJid && b.chatJid !== be.chatJid)) return { reason: 'bad_basis' };
    if (b.today === true) refs.push({ digestId: be.digestId, today: true });
    else if (Number.isInteger(Number(b.thread)) && Number(b.thread) >= 1 && Number(b.thread) <= 3) {
      refs.push({ digestId: be.digestId, thread: Number(b.thread) });
    } else return { reason: 'bad_basis' };
    expect.push({ chatJid: be.chatJid });
  }
  const key = (r) => `${r.digestId}:${r.today ? 'today' : r.thread}`;
  if (new Set(refs.map(key)).size !== refs.length) return { reason: 'bad_basis' };
  if (cand.kind === 'check_in') {
    if (refs.length !== 1) return { reason: 'bad_basis' };
  } else if (refs.length < 1 || refs.length > 2 || refs.some(r => r.today)) {
    return { reason: 'bad_basis' };
  }
  const thinkReason = typeof cand.reason === 'string' ? cand.reason.slice(0, 160) : null;
  return { kind: cand.kind, urgency: cand.urgency, thinkReason, entry, refs, expect };
}

// ── snapshots (stage C) and their checks (D4, D5) ────────────────────────────

function contentState(Y, createdAt) {
  let rows = [];
  try { rows = deps.chatMessages(Y, SNAPSHOT_WINDOW) || []; } catch { return null; }
  const before = rows.filter(r => Number(r.timestamp) <= createdAt).slice(-SNAPSHOT_LINES);
  const hash = sha(before.map(r => `${r.id}|${r.no_learn ? 1 : 0}|${r.content ?? ''}`).join('\n'));
  const humanAfter = rows.some(r => Number(r.timestamp) > createdAt && !r.is_from_self && r.message_type !== 'reaction');
  return { n: before.length, hash, humanAfter };
}

function originsOf(aud) {
  return (deps.allowedOrigins(aud) || [])
    .map(o => ({ originJid: o.originJid, minLearnedAt: fin(o.minLearnedAt) ? o.minLearnedAt : 0 }))
    .sort((a, b) => (a.originJid < b.originJid ? -1 : a.originJid > b.originJid ? 1 : 0));
}

/** audience_json: sorted members (or their hash), freshness, allowedOrigins with floors, content hash. */
function audienceSnapshot(aud, Y, createdAt) {
  const members = [...(aud?.members || [])].sort();
  const c = contentState(Y, createdAt);
  return {
    kind: aud?.kind ?? null,
    fresh: !!aud?.fresh,
    outsiders: !!aud?.outsiders,
    memberCount: members.length,
    membersHash: sha(members.join(',')),
    ...(members.length <= SNAPSHOT_MEMBERS_MAX ? { members } : {}),
    origins: originsOf(aud),
    content: c ? { n: c.n, hash: c.hash } : null,
  };
}

/** D4: any new member, freshness/outsiders lost, or a missing / stricter origin → true. */
function audienceChanged(snap, aud) {
  if (!snap || typeof snap !== 'object' || snap._truncated || !Array.isArray(snap.origins)) return true;
  if (!aud || aud.outsiders || (snap.fresh && !aud.fresh)) return true;
  const members = [...(aud.members || [])].sort();
  if (!members.length) return true;
  if (Array.isArray(snap.members)) {
    const was = new Set(snap.members);
    if (members.some(m => !was.has(m))) return true;
  } else if (snap.membersHash !== sha(members.join(','))) {
    return true;
  }
  const cur = new Map(originsOf(aud).map(o => [o.originJid, o.minLearnedAt]));
  for (const o of snap.origins) {
    if (!cur.has(o.originJid)) return true;
    if (cur.get(o.originJid) > o.minLearnedAt) return true;
  }
  return false;
}

// ── availability, sending prerequisites (D7–D10) ─────────────────────────────

function available(now) {
  const life = lifeFacade();
  if (lifeOn(life)) {
    try {
      if (typeof life.availabilityNow === 'function' || typeof life.inPhoneCheckNow === 'function') {
        const a = typeof life.availabilityNow === 'function' ? life.availabilityNow() : null;
        const phone = typeof life.inPhoneCheckNow === 'function' ? life.inPhoneCheckNow() === true : false;
        return a === 'free' || phone;
      }
      return typeof life.isAwakeAt === 'function' && life.isAwakeAt(now) === true && !embargoed(life);
    } catch {
      return false;
    }
  }
  return !inSleepHours(now);
}

/** D8–D10. → reason | null */
function sendPrereqs(Y) {
  const w = deps.checkWarmup('text');
  if (!w || !w.allowed || w.responseType === 'reaction') return 'warmup';
  const rl = deps.checkRateLimit(Y);
  const hc = deps.checkHourlyCaps(Y, { isMention: false });
  if (!rl?.allowed || !hc?.allowed) return 'rate_limited';
  if (isGroupJid(Y) && deps.isGroupMuted(Y)) return 'muted';
  return null;
}

/** D6: a DM row's chat (and send form) still resolve to the person it was drafted for. */
function identityOk(row) {
  if (row.chatKind !== 'dm') return true;
  if (!row.personJid || resolvePerson(row.chatJid) !== row.personJid) return false;
  if (row.sendJid && resolvePerson(row.sendJid) !== row.personJid) return false;
  return true;
}

// ── row writes ───────────────────────────────────────────────────────────────

/** Update a row only while it is still in `from` status (a hook may have dropped it meanwhile). */
function moveIfStill(id, from, fields) {
  const cur = store.getDraft(id);
  if (!cur || cur.status !== from) return false;
  store.updateDraft(id, fields);
  return true;
}

function drop(id, reason, from = 'drafting', extra = {}) {
  const ok = moveIfStill(id, from, { status: 'dropped', dropReason: reason, ...extra });
  if (ok) logger.info({ evt: 'mind.proactive', id, status: 'dropped', reason }, 'proactive draft dropped');
  return ok;
}

// ── stage B: intent ──────────────────────────────────────────────────────────

function localTimeLine(t) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone || 'UTC', weekday: 'long', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23' }).format(new Date(t * 1000));
  } catch {
    return new Date(t * 1000).toISOString().slice(0, 16);
  }
}

async function intentInput(row, t, aud, items) {
  const now = nowSec();
  const persona = getPersona() || {};
  const head = [
    `Chat: ${t.isGroup ? `a group (${aud?.members?.size || 0} members)` : 'a one-to-one chat'}`,
    `Kind of opener: ${row.kind}`,
    `Local time: ${localTimeLine(now)}`,
    `You are: ${cleanChatText(persona.name || 'the character', 60)}${persona.vibe ? ` (${cleanChatText(persona.vibe, 120)})` : ''}`,
  ];
  const data = [];
  const latest = store.latestDigest(t.Y);
  if (latest && now - (latest.periodEnd ?? latest.createdAt ?? 0) <= LATEST_DIGEST_MAX_AGE_SEC) {
    data.push(`Latest summary of this chat (tone ${latest.tone}): ${cleanChatText(latest.summary, 400)}`);
  }
  const behind = items.map(({ d, ref }) => (ref.today === true ? d.todayNote : threadOf(d, ref.thread)?.text))
    .filter(x => typeof x === 'string' && x).map(x => `- ${cleanChatText(x, 100)}`);
  if (behind.length) data.push(`What the idea is based on:\n${behind.join('\n')}`);
  const mems = (deps.recall(aud, { limit: 5, track: false }) || []).slice(0, 5)
    .map(m => m?.content).filter(Boolean).map(c => `- ${cleanChatText(c, 200)}`);
  if (mems.length) data.push(`Things you remember:\n${mems.join('\n')}`);
  const eps = (deps.recallEpisodes(aud, { limit: 2, track: false }) || []).slice(0, 2)
    .map(e => e?.content).filter(Boolean).map(c => `- ${cleanChatText(c, 240)}`);
  if (eps.length) data.push(`Recently:\n${eps.join('\n')}`);
  const rels = (deps.recallRelationships(aud, { limit: 3 }) || []).slice(0, 3).map((r) => {
    const what = r?.relationship || r?.dynamic;
    return what ? `- ${cleanChatText(r.aName || 'someone', 40)} and ${cleanChatText(r.bName || 'someone', 40)}: ${cleanChatText(what, 120)}` : null;
  }).filter(Boolean);
  if (rels.length) data.push(`How people here relate:\n${rels.join('\n')}`);
  let line = '';
  try { line = await deps.selfStateLine(aud, { chatJid: t.Y, isGroup: t.isGroup }); } catch { line = ''; }
  if (typeof line === 'string' && line.trim()) data.push(`Your state: ${cleanChatText(line, 160)}`);
  return `${head.join('\n')}\n\n${data.length ? fenceBlock(data.join('\n\n')) : '(nothing else is known about this chat)'}\n\n`
    + 'Answer with the JSON object only.';
}

/** Is the intent safe to hand to the mouth? → reason | null */
async function intentProblem(intent, t, aud) {
  if (hasIdentifier(intent) || HARM_RE.test(intent)) return 'intent_forbidden';
  let all;
  try { all = await deps.nameSet(); } catch { return 'intent_outsider_name'; }
  const memberNames = new Set();
  for (const m of aud?.members || []) {
    try { for (const n of (await deps.namesOf(m)) || []) memberNames.add(n); } catch { return 'intent_outsider_name'; }
  }
  if ((!all || !all.size) && memberNames.size) return 'intent_outsider_name';   // the name read failed → fail closed
  const persona = getPersona() || {};
  const allow = [...memberNames, persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : [])];
  if (t.isGroup) { const g = getGroup(t.Y)?.name; if (g) allow.push(g); }
  const outsiders = [...(all || [])].filter(n => !memberNames.has(n));
  const matcher = buildNameMatcher(outsiders, allow.filter(Boolean));
  return matcher.size && matcher.test(intent) ? 'intent_outsider_name' : null;
}

function usageFields(res) {
  return { model: res?.model ?? null, tokensIn: res?.usage?.input ?? null, tokensOut: res?.usage?.output ?? null,
    cacheRead: res?.usage?.cacheRead ?? null, costUsd: res?.costUsd ?? null, fellBack: !!res?.fellBack };
}
function skipCode(res) {
  const s = res?.skipped;
  return s === 'budget' || s === 'no_key' || s === 'disabled' ? s : 'error';
}

/**
 * Stage B for a drafting row: `mind.draft` (effort low, maxTokens 1500) on input built
 * only from Y's audience. Records a `draft` run. → { intent } | { reason }
 */
export async function draftIntent(row, { target, audience, items }) {
  const user = await intentInput(row, target, audience, items);
  let runId = null;
  try {
    runId = store.insertRun({ kind: 'draft', triggerRef: `proactive:${row.id}`,
      input: { draftId: row.id, kind: row.kind, chatKind: row.chatKind } });
  } catch (err) { issue('draftRun', err); }
  const finish = (fields) => { if (runId != null) { try { store.finishRun(runId, fields); } catch (err) { issue('draftRun', err); } } };
  let res;
  try {
    res = await deps.callRole('mind', DRAFT_CHARTER, user, { caller: 'mind.draft', effort: 'low', maxTokens: 1500 });
  } catch (err) {
    finish({ status: 'failed', error: 'call_error' });
    return { reason: 'intent_failed' };
  }
  const usage = usageFields(res);
  if (!res || res.skipped) {
    finish({ status: 'skipped', skipReason: skipCode(res), ...usage });
    return { reason: 'budget' };
  }
  if (res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
    finish({ status: 'failed', error: String(res.status || 'no_text').slice(0, 60), ...usage });
    return { reason: 'intent_failed' };
  }
  const v = validateDraft(res.text);
  if (!v.ok) {
    finish({ status: 'invalid', error: v.error, dropped: v.dropped, ...usage });
    return { reason: 'intent_invalid' };
  }
  if (v.value.skip) {
    finish({ status: 'ok', output: { skip: true }, ...usage });
    return { reason: 'mind_skip' };
  }
  const intent = sanitizeWebContent(v.value.intent).replace(/\s+/g, ' ').trim().slice(0, 200);
  const problem = intent.length >= 10 ? await intentProblem(intent, target, audience) : 'intent_invalid';
  finish({ status: 'ok', output: { skip: false, rejected: problem || null }, ...usage });
  if (problem) return { reason: problem };
  return { intent };
}

// ── stage C: voice + gate ────────────────────────────────────────────────────

function cleanVoiced(text, isGroup) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw || /\[\s*SKIP\s*\]/i.test(raw) || /^SKIP\.?$/i.test(raw)) return null;
  const pp = postProcess(sanitizeWebContent(raw), [], { isGroup });
  const out = (typeof pp === 'string' ? pp : pp?.text || '').trim();
  if (!out || /\[\s*SKIP\s*\]/i.test(out)) return null;
  return out.slice(0, VOICED_MAX);
}

/**
 * Stage C: the target chat's mouth writes the opener, the gate must give a passing
 * verdict, fun A/B (groups only, no send) runs alongside. → { text, gateScore,
 * gateReason, altText?, altModel? } | { reason, gateScore?, gateReason? }
 */
export async function voice(row, { target, audience, intent, mode }) {
  const opener = { kind: row.kind, intent };
  let prompt;
  try {
    prompt = await deps.buildPrompt({ chatJid: target.Y, isGroup: target.isGroup, audience, opener });
  } catch (err) {
    issue('buildPrompt', err);
    return { reason: 'mouth_failed' };
  }
  const opts = { caller: 'mind.proactive', groupJid: target.Y, msgId: `proactive_${row.id}` };
  if (mode === 'live') opts.send = true;
  let res;
  try { res = await deps.callRole('mouth', prompt.system, prompt.user, opts); } catch { return { reason: 'mouth_failed' }; }
  if (!res || res.skipped) return { reason: 'budget' };
  if (res.status && res.status !== 'ok' && typeof res.text !== 'string') return { reason: 'mouth_failed' };
  const text = cleanVoiced(res.text, target.isGroup);
  if (!text) return { reason: 'mouth_skip' };

  const out = { text };
  // Fun A/B (research R19): group targets only, never with `send`; stored, never sent.
  if (target.isGroup && config.mind?.funAb === true) {
    let ok = false;
    try { ok = deps.funAvailable() === true; } catch { ok = false; }
    if (ok) {
      try {
        const alt = await deps.callRole('fun', prompt.system, prompt.user, { caller: 'fun.proactive' });
        const altText = alt && !alt.skipped ? cleanVoiced(alt.text, true) : null;
        if (altText) { out.altText = altText; out.altModel = alt.model ? String(alt.model).slice(0, 120) : null; }
      } catch { /* fun is display-only */ }
    }
  }

  let snippet = '';
  try { snippet = deps.snippet(target.Y) || ''; } catch { snippet = ''; }
  const gateOpts = { isMention: false, caller: 'mind.gate', harmNote: PROACTIVE_HARM };
  const life = lifeFacade();
  try {
    const g = life && typeof life.lifeGuardNote === 'function' ? life.lifeGuardNote() : null;
    // The quality gate reads harmNote only, so the life guard note rides on it (capped).
    if (typeof g === 'string' && g.trim()) gateOpts.harmNote = `${PROACTIVE_HARM} ${g.trim().slice(0, 400)}`;
  } catch { /* none */ }
  let gate;
  try { gate = await deps.evaluateResponse(text, snippet, gateOpts); } catch { gate = null; }
  const score = gate && fin(gate.score) ? gate.score : null;
  const gateReason = gate?.reason != null ? String(gate.reason).slice(0, 200) : null;
  if (score === null) return { ...out, reason: 'gate_no_verdict', gateScore: null, gateReason };
  const threshold = Number(config.qualityGate?.threshold);
  const bar = Math.max(fin(threshold) ? threshold : 0, proactiveCfg().minScore);
  if (gate.pass !== true || score < bar) return { ...out, reason: 'gate', gateScore: score, gateReason };
  return { ...out, gateScore: score, gateReason };
}

// ── shadow would_send (D checks 3–10, read-only) ─────────────────────────────

async function sendChecks(row, { phase, cache = {} }) {
  const s = settings();
  const g = globalGate(s);
  if (g) return { reason: g, gate: true };
  if (!identityOk(row)) return { reason: 'identity_changed' };
  const t = resolveTarget(row.chatJid);
  if (t.reason) return t;
  if (!sameChat(row.chatJid, t)) return { reason: 'identity_changed' };
  const aud = deps.resolveAudience({ chatJid: t.Y, kind: t.isGroup ? 'group' : 'dm' });
  const refs = Array.isArray(row.basis) ? row.basis : [];
  const origins = Array.isArray(row.origins) ? row.origins : [];
  if (!refs.length || origins.length !== refs.length) return { reason: 'basis_gone' };
  const expect = origins.map(o => ({ chatJid: o?.originJid, periodStart: o?.minLearnedAt }));
  const e = await eligibility(t, { kind: row.kind, urgency: row.urgency, refs, expect, aud, excludeId: row.id, cache });
  if (e.reason) return { reason: phase === 'dispatch' && e.reason === 'basis_audience' ? 'audience_changed' : e.reason };
  return { t, aud };
}

async function wouldSendNow(row) {
  try {
    const c = await sendChecks(row, { phase: 'shadow' });
    if (c.reason) return false;
    if (!available(nowSec())) return false;
    return sendPrereqs(c.t.Y) === null;
  } catch (err) {
    issue('wouldSend', err);
    return false;
  }
}

// ── considerCandidates ───────────────────────────────────────────────────────

async function considerOne(cand, labelMap, runId, ctx) {
  const now = nowSec();
  const pc = proactiveCfg();
  const c = parseCandidate(cand, labelMap);
  if (c.reason) return { reason: c.reason };

  // A2 budget, A3 the daily draft (cost) cap
  let budget = false;
  try { budget = (await deps.budgetOk('draft')) === true; } catch { budget = false; }
  if (!budget) return { reason: 'budget' };
  if (pc.draftsPerDay <= 0
      || store.countDrafts({ statuses: store.DRAFT_STATUSES, since: dayStart(now) }) >= pc.draftsPerDay) {
    return { reason: 'cap' };
  }

  // A4
  const t = resolveTarget(c.entry.chatJid);
  if (t.reason) return { reason: t.reason };
  if ((c.entry.kind === 'group') !== t.isGroup) return { reason: 'bad_target' };
  if (ctx.chats.has(t.Y)) return { reason: 'duplicate' };       // A12 within one run: one row per chat

  // A5–A10
  const aud = deps.resolveAudience({ chatJid: t.Y, kind: t.isGroup ? 'group' : 'dm' });
  const e = await eligibility(t, { kind: c.kind, urgency: c.urgency, refs: c.refs, expect: c.expect, aud, cache: ctx.cache });
  if (e.reason) return { reason: e.reason };

  // A11, A12
  const f = await foreignDmTrigger(t, labelMap);
  if (f) return { reason: f };
  if (duplicate(t)) return { reason: 'duplicate' };
  ctx.chats.add(t.Y);

  const mode = effectiveMode(settings());
  let sendJid = null;
  if (!t.isGroup) { try { sendJid = deps.sendForm(t.person) || null; } catch { sendJid = null; } }
  const id = store.insertDraft({
    chatJid: t.Y, chatKind: t.isGroup ? 'group' : 'dm', personJid: t.person, sendJid,
    kind: c.kind, urgency: c.urgency, reason: c.thinkReason, basis: c.refs,
    origins: e.items.map(({ d }) => ({ originJid: d.chatJid, minLearnedAt: d.periodStart })),
    mode, status: 'drafting', runId: runId ?? null, createdAt: now,
  });
  let row = store.getDraft(id);

  // B
  const b = await draftIntent(row, { target: t, audience: aud, items: e.items });
  if (b.reason) { drop(id, b.reason); return { id, status: 'dropped', dropReason: b.reason }; }
  if (!moveIfStill(id, 'drafting', { intent: b.intent })) return { id, status: store.getDraft(id)?.status ?? 'gone' };

  // C
  const v = await voice(row, { target: t, audience: aud, intent: b.intent, mode });
  const keep = { voicedText: v.text ?? null, altText: v.altText ?? null, altModel: v.altModel ?? null,
    gateScore: v.gateScore ?? null, gateReason: v.gateReason ?? null };
  if (v.reason) { drop(id, v.reason, 'drafting', keep); return { id, status: 'dropped', dropReason: v.reason }; }
  row = store.getDraft(id);
  if (!row || row.status !== 'drafting') return { id, status: row?.status ?? 'gone' };
  const snapshot = audienceSnapshot(aud, t.Y, row.createdAt);
  if (!moveIfStill(id, 'drafting', { ...keep, audience: snapshot })) return { id, status: store.getDraft(id)?.status ?? 'gone' };
  row = store.getDraft(id);

  // Outcome by mode (the mode at creation; a switch since then never sends)
  const s = settings();
  const nowMode = effectiveMode(s);
  if (mode === 'live') {
    if (nowMode !== 'live' || s.paused || !deps.isMindOn()) {
      moveIfStill(id, 'drafting', { status: 'cancelled', dropReason: s.paused ? 'paused' : !deps.isMindOn() ? 'skill_off' : 'mode_changed' });
      return { id, status: 'cancelled' };
    }
    const [lo, hi] = SEND_JITTER_MIN;
    const sendAfter = nowSec() + Math.round((lo + deps.random() * (hi - lo)) * MIN);
    try {
      if (!moveIfStill(id, 'drafting', { status: 'queued', sendAfter })) return { id, status: store.getDraft(id)?.status ?? 'gone' };
    } catch (err) {
      if (String(err?.code || '').includes('CONSTRAINT')) { drop(id, 'duplicate'); return { id, status: 'dropped', dropReason: 'duplicate' }; }
      throw err;
    }
    logger.info({ evt: 'mind.proactive', id, status: 'queued', chatKind: row.chatKind }, 'proactive draft queued');
    return { id, status: 'queued' };
  }
  const would = await wouldSendNow(row);
  const status = would ? 'would_send' : 'shadow';
  if (!moveIfStill(id, 'drafting', { status })) return { id, status: store.getDraft(id)?.status ?? 'gone' };
  logger.info({ evt: 'mind.proactive', id, status, chatKind: row.chatKind }, 'proactive draft stored (shadow)');
  return { id, status };
}

/**
 * The think's reach_out candidates (≤ 2) for this run's label map. Runs A1–A12, then
 * stages B and C for each survivor. Never throws, never sends.
 * → { drafted: [{index, id, status, dropReason?}], notes: [{index, reason}] }
 */
export async function considerCandidates(cands, labelMap, runId = null) {
  const out = { drafted: [], notes: [] };
  const list = Array.isArray(cands) ? cands.slice(0, MAX_CANDIDATES) : [];
  if (!list.length) return out;
  let g;
  try { g = globalGate(settings()); } catch { g = 'error'; }
  if (g) {
    list.forEach((_, index) => out.notes.push({ index, reason: g }));
    return out;
  }
  const ctx = { chats: new Set(), cache: {} };
  for (const [index, cand] of list.entries()) {
    try {
      const r = await considerOne(cand, labelMap, runId, ctx);
      if (r.id != null) out.drafted.push({ index, id: r.id, status: r.status, ...(r.dropReason ? { dropReason: r.dropReason } : {}) });
      else out.notes.push({ index, reason: r.reason });
    } catch (err) {
      issue('consider', err);
      out.notes.push({ index, reason: 'error' });
    }
  }
  logger.info({ evt: 'mind.proactive', runId, drafted: out.drafted.length, notes: out.notes.map(n => n.reason) },
    'proactive candidates considered');
  return out;
}

// ── D. dispatch ──────────────────────────────────────────────────────────────

const SEND_OUTCOMES = new Set(['sent', 'dry_run', 'send_failed']);

// A row dropped because its basis, content, audience or identity changed keeps no text.
const TEXTLESS_DROPS = new Set(['basis_gone', 'content_changed', 'audience_changed', 'identity_changed']);

function finalize(id, status, reason, extra = {}) {
  const wipe = status === 'dropped' && TEXTLESS_DROPS.has(reason) ? { intent: null, voicedText: null, altText: null } : {};
  const ok = moveIfStill(id, 'queued', { status, ...(reason ? { dropReason: reason } : {}), ...wipe, ...extra });
  if (ok) logger.info({ evt: 'mind.proactive', id, status, reason: reason || null }, 'proactive dispatch outcome');
  return ok ? status : 'gone';
}

async function dispatchLocked(id, sock, lockCtx) {
  const row = store.getDraft(id);
  if (!row || row.status !== 'queued') return 'gone';
  const now = nowSec();
  const pc = proactiveCfg();
  // D1
  if (now - row.createdAt > pc.ttlHours * HOUR) return finalize(id, 'expired', 'ttl');
  if (deps.isDegraded()) return 'degraded';                     // stays queued; recovery cancels it
  // D2
  const s = settings();
  if (!deps.isMindOn()) return finalize(id, 'cancelled', 'skill_off');
  if (s.paused) return finalize(id, 'cancelled', 'paused');
  if (effectiveMode(s) !== 'live' || row.mode !== 'live') return finalize(id, 'cancelled', 'mode_changed');
  // D6 first: a recycled number must read as identity_changed, not as a later symptom
  if (!identityOk(row)) return finalize(id, 'dropped', 'identity_changed');
  // D3 (A1, A4–A10 with a fresh audience; caps exclude this row)
  const c = await sendChecks(row, { phase: 'dispatch' });
  if (c.reason) return finalize(id, c.gate ? 'cancelled' : 'dropped', c.reason);
  // D4
  if (audienceChanged(row.audience, c.aud)) return finalize(id, 'dropped', 'audience_changed');
  // D5
  const content = contentState(c.t.Y, row.createdAt);
  if (!content) return finalize(id, 'dropped', 'content_changed');
  if (content.humanAfter) return finalize(id, 'dropped', 'conversation_active');
  const snapC = row.audience?.content;
  if (!snapC || snapC.hash !== content.hash || snapC.n !== content.n) return finalize(id, 'dropped', 'content_changed');
  // D7: not now → stay queued (the TTL expires it)
  if (!available(now)) return 'unavailable';
  // D8–D10
  const p = sendPrereqs(c.t.Y);
  if (p) return finalize(id, 'dropped', p);
  // D11
  if (lockCtx?.turnSignal?.aborted) return finalize(id, 'dropped', 'aborted');

  // D12 — last guards on the exact row and jid, then dry-run before any send.
  const fresh = store.getDraft(id);
  if (!fresh || fresh.status !== 'queued') return 'gone';
  const text = typeof fresh.voicedText === 'string' ? fresh.voicedText.trim() : '';
  if (!text) return finalize(id, 'dropped', 'basis_gone');
  const jid = row.chatKind === 'dm' ? (fresh.sendJid || fresh.chatJid) : fresh.chatJid;
  if (row.chatKind === 'dm' && (isOwnerJid(jid) || isOwnerJid(fresh.chatJid))) return finalize(id, 'dropped', 'owner_target');
  if (isSelfJid(jid)) return finalize(id, 'dropped', 'bad_target');
  if (config.dryRun) return finalize(id, 'dry_run', null);
  let sent = null;
  try { sent = await deps.sendText(sock, jid, text); } catch { sent = null; }
  if (!sent) return finalize(id, 'send_failed', null);
  try { deps.recordSent(); } catch (err) { issue('recordSent', err); }
  const msgId = sent?.key?.id ? String(sent.key.id).slice(0, 200) : null;
  // A cancel that landed during the await cannot unsend it: record what happened.
  store.updateDraft(id, { status: 'sent', sentAt: nowSec(), msgId, dropReason: null });
  logger.info({ evt: 'mind.proactive', id, status: 'sent', chatKind: row.chatKind }, 'proactive message sent');
  return 'sent';
}

/**
 * Each pulse: the earliest due `queued` rows, re-checked one at a time inside their
 * chat's lock; at most ONE send (sent | dry_run | send_failed) per call. Never throws.
 * → { handled: [{id, outcome}], sent: 0|1 }
 */
export async function dispatchDue(sock) {
  const out = { handled: [], sent: 0 };
  let due = [];
  try { due = store.dueQueued(nowSec()).slice(0, DISPATCH_SCAN_MAX); } catch (err) { issue('dueQueued', err); return out; }
  for (const r of due) {
    let outcome = 'error';
    try {
      // events.js keys its in-flight lock by the chat form messages arrive on: for a DM
      // that is the stored send form, not the canonical person id.
      const lockJid = r.chatKind === 'dm' ? (r.sendJid || r.chatJid) : r.chatJid;
      outcome = await deps.withChatLock(lockJid, (lockCtx) => dispatchLocked(r.id, sock, lockCtx));
    } catch (err) {
      issue('dispatch', err);
    }
    out.handled.push({ id: r.id, outcome });
    if (SEND_OUTCOMES.has(outcome)) { out.sent = 1; break; }
  }
  return out;
}

// ── cancel ───────────────────────────────────────────────────────────────────

/** Pause, skill off, an owner exclusion or a mode switch away from live: every queued row → cancelled. Never throws. */
export function cancelQueued(reason = 'cancelled') {
  try {
    const n = store.updateDraftsWhere({ statuses: ['queued'] }, { status: 'cancelled', dropReason: String(reason).slice(0, 40) });
    if (n) logger.info({ evt: 'mind.proactive', cancelled: n, reason: String(reason).slice(0, 40) }, 'queued proactive drafts cancelled');
    return n;
  } catch (err) {
    issue('cancelQueued', err);
    return 0;
  }
}

/**
 * Deletion hook (research R9): drafting|queued rows of these chat forms → dropped
 * with `reason` and their text nulled; shadow|would_send rows keep their status but
 * lose intent/voiced/alt text. Sync (runs inside the 006 transaction); errors
 * propagate so a purge rolls back. → { dropped, nulled }
 */
export function cancelForChat(chatForms, reason = 'content_changed', { since = null } = {}) {
  const list = [...new Set((Array.isArray(chatForms) ? chatForms : [chatForms]).filter(x => typeof x === 'string' && x))];
  if (!list.length) return { dropped: 0, nulled: 0 };
  // since: only rows made at or after it (a revoke/edit: nothing older saw the message).
  const window = Number.isFinite(Number(since)) && since !== null ? { createdSince: Math.floor(Number(since)) } : {};
  const dropped = store.updateDraftsWhere({ chatForms: list, statuses: store.DRAFT_PENDING, matchOrigins: true, ...window },
    { status: 'dropped', dropReason: String(reason).slice(0, 40), intent: null, voicedText: null, altText: null });
  const nulled = store.updateDraftsWhere({ chatForms: list, statuses: ['shadow', 'would_send'], matchOrigins: true, ...window },
    { intent: null, voicedText: null, altText: null });
  return { dropped, nulled };
}
