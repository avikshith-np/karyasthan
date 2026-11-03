// Chats shape his life (spec 012) — the influence layer's one door. Imported
// ONLY by the life facade (src/life/index.js; 00-guards checks it). P1: mood,
// the sleep push and the work counter; invitations (P2) and advice → the
// owner's tray (P3, advice.js) build on the same perception.
//
// Inert by default: every entry point first asks influenceOn(area) = attached
// && life on && the `chat-influence` skill on && not degraded && the area's
// toggle (config.chatInfluence.<area>). With the skill off nothing here makes a
// model call, appends an event or touches a prompt; the mood overlay gate and
// the reason fragment are closed too.
//
// Flow for one incoming message (live turns only; catch-up turns were perceived
// when they arrived):
//   perceive()      facade preconditions passed (chatMayNudge) → the influence
//                   membership check, the candidate filter and the caps (code) →
//                   ONE typed Jev call (perceive.js) about the newest candidate
//                   line of the burst. Its result is HELD until —
//   gateOutcome()   the availability gate says he read it: now/sneak → applied
//                   (pointer dated at the message, clamped to now); defer → the
//                   codes are kept in a `held` row and applied when the phone's
//                   catch-up turn reads that message (beforeDrainTurn, dated then)
//                   or a later live turn in that chat reads the chat; anything
//                   else → dropped.
//   apply           in one synchronous section: re-read the message (still
//                   prompt-visible, same content hash — a forget/revoke/edit
//                   during the Jev wait wins), then the inert `chat.perceived`
//                   pointer (actor chat, the chat's origin; the sender as subject
//                   in a group), the bounded `mood.chat` caused by it, and the
//                   v12 item row. No message text anywhere.
//
// Fail closed for influence (any error → no influence); the reply path never
// waits on this layer in P1. Logs carry codes and ids only.

import crypto from 'crypto';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { isSkillEnabled, skillWouldHandle } from '../../skills/skillRunner.js';
import { isGroupJid, isDmJid } from '../../utils/jidUtils.js';
import { isBotMentioned, isBotAddressedInText } from '../../utils/mentions.js';
import * as messageStore from '../../memory/messageStore.js';
import * as membership from '../../memory/membership.js';
import * as identity from '../../memory/identity.js';
import { getImitationTarget } from '../../behavior/imitationState.js';
import { isGroupMuted as dashboardIsGroupMuted } from '../../dashboard/state.js';
import { now as clockNow, dateKey, dayStart, resolveTimezone } from '../clock.js';
import { setOverlayGate, isExcludedId } from '../projector.js';
import { setInfluenceFragment, setPersonLabel, subjectVisible, eveningClause } from '../innerState.js';
import { openDecision, answerInvite, cancelInvite } from '../decisions.js';
import { isActive as embargoActive } from '../embargo.js';
import { getClaim } from '../claims.js';
import { listEvents, getEvent } from '../eventLog.js';
import { checkRateLimit, checkHourlyCaps, inBurst } from '../../behavior/rateLimiter.js';
import { checkWarmup } from '../../behavior/warmup.js';
import { getPerson } from '../../memory/peopleStore.js';
import * as invites from './invites.js';
import * as store from './store.js';
import * as hooks from './hooks.js';
import * as mood from './mood.js';
import * as advice from './advice.js';
import { sleepPush, workBehindDue, WORK_PRESSURE, WORK_WINDOW_SEC } from './sleepWork.js';
import { askPerception, createCaps, CALLER, EXCERPT_MAX } from './perceive.js';

export const AREAS = Object.freeze(['mood', 'sleep', 'work', 'invites', 'advice']);
// Areas a perception feeds (P1: mood; P2: invites; P3: advice, which also needs
// the story — the tray is the story's). With none of them live, perceive() makes
// no call at all.
const PERCEPTION_AREAS = Object.freeze(['mood', 'invites', 'advice']);
const MIN_CHARS = 4;
const MIN_LETTERS = 2;
const TALKING_WINDOW_SEC = 600;
const PENDING_MAX = 200;
const VERDICT_WAIT_MS = 60_000;
const SWEEP_SEC = 6 * 3600;
const LIVE_VERDICTS = new Set(['now', 'sneak']);
// Verdicts worth a Jev call: he reads the message now or at his next phone check.
const PERCEIVE_VERDICTS = new Set(['now', 'sneak', 'defer']);
const STAGES_MAX = 200;
const ANSWER_WAIT_MS = 10_000;
const ANSWER_TRIES_MAX = 500;
const WINDOW_GROUP = 50;           // the transcript buildConversationContext shows (systemPrompt)
const WINDOW_DM = 30;
const ORIGIN_CHATS = new Set(['group', 'dm']);

let att = null;               // { getState, append, world, worldOf, revert, isLifeOn, opts, controlsVerdict, resolvePlan }
const caps = createCaps();
const clerkCaps = invites.createClerkCaps();
const pending = new Map();    // `${chatKey}|${turnMsgId}` → entry
// Invitation chains (P2), keyed like `pending` (a held one by its message id):
// { stage: 'invite'|'open'|'none', decisionId, done: Promise }. Bounded.
const stages = new Map();
const answerTries = new Map(); // decisionId → reply classifications asked (≤ invites.ANSWER_ATTEMPTS)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');
const tzNow = () => resolveTimezone(att?.getState?.()?.world?.timezone ?? config.timezone);

function safe(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

// ── Perception outcomes (observability; codes only) ───────────────────────
//
// Every perception ends in exactly one outcome — applied (it changed his day or
// reached the tray), held (deferred until he reads it; counted again when it
// lands or drops, reasons prefixed held_), dropped (accepted by the classifier
// but not applied: the gate verdict, area off, the message changed, a refusal)
// or nothing (no Jev call result to act on: the classifier's reason, a Jev
// error, the budget, a cap). One INFO line each and a per-day count
// (store.outcomesFor → the Life · Now panel). Never text, names or JIDs.
const OUTCOME_CODE_RE = /^[a-z0-9_]{1,32}$/;
const codeOf = (v, dflt = 'other') => (typeof v === 'string' && OUTCOME_CODE_RE.test(v) ? v : dflt);

function noteOutcome(outcome, reason, { kind = null, target = null, originKind = null, n = 1 } = {}) {
  const r = codeOf(reason, 'none');
  try {
    logger.info({ evt: 'chatInfluence.outcome', outcome, reason: r, kind: kind ? codeOf(kind) : null,
      target: target ? codeOf(target) : null, chat: originKind ? codeOf(originKind) : null, ...(n !== 1 ? { n } : {}) },
    'chat influence: perception outcome');
  } catch { /* logging never breaks influence */ }
  const day = safe(() => dateKey(clockNow(), tzNow()), null);
  if (day) for (let i = 0; i < n; i++) safe(() => store.bumpOutcome(day, outcome, r), false);
}

/** Today's (or `dayKey`'s) perception outcome counts. Fails soft (zeros). */
export function outcomesToday(dayKey = null) {
  const day = dayKey ?? safe(() => dateKey(clockNow(), tzNow()), null);
  return safe(() => ({ day, ...store.outcomesFor(day) }), { day, applied: 0, held: 0, dropped: 0, nothing: 0, reasons: {} });
}

// ── On/off ────────────────────────────────────────────────────────────────

/** Is this area live? area 'any' = at least one area on. Fails closed. */
export function influenceOn(area) {
  if (!att) return false;
  try {
    if (!isSkillEnabled('chat-influence')) return false;
    if (att.isLifeOn() !== true) return false;
    const c = config.chatInfluence || {};
    const on = area === 'any' ? AREAS.some(a => c[a] === true) : c[area] === true;
    if (!on) return false;
    return !hooks.isDegraded();
  } catch {
    return false;
  }
}

/** The advice area: its toggle, and the story on (no tray without it). Fails closed. */
function adviceOn() {
  return influenceOn('advice') && safe(() => att.storyOn() === true, false);
}

function perceptionOn() {
  return PERCEPTION_AREAS.some(a => (a === 'advice' ? adviceOn() : influenceOn(a)));
}

// ── Attach ────────────────────────────────────────────────────────────────

/**
 * The facade at boot: { getState, append, world, revert(id, opts), isLifeOn(),
 * opts (startLife's: isGroupMuted, isMember), controlsVerdict(opts) }.
 */
export function attachInfluence(rt = {}) {
  if (!isObj(rt) || typeof rt.getState !== 'function' || typeof rt.append !== 'function') {
    throw new Error('influence: attach needs { getState, append }');
  }
  att = {
    getState: rt.getState,
    append: rt.append,
    world: rt.world ?? null,
    revert: typeof rt.revert === 'function' ? rt.revert : null,
    isLifeOn: typeof rt.isLifeOn === 'function' ? rt.isLifeOn : () => false,
    opts: isObj(rt.opts) ? rt.opts : {},
    controlsVerdict: typeof rt.controlsVerdict === 'function' ? rt.controlsVerdict : () => ({ ok: true }),
    resolvePlan: typeof rt.resolvePlan === 'function' ? rt.resolvePlan : null,
    worldOf: typeof rt.worldOf === 'function' ? rt.worldOf : (st) => rt.world ?? null,
    storyOn: typeof rt.storyOn === 'function' ? rt.storyOn : () => false,
  };
  hooks.configure({ revert: att.revert });
  setOverlayGate(() => influenceOn('mood'));
  setInfluenceFragment(reasonFragment);
  setPersonLabel(personName);
  backOutSince();   // from here on a broken plan is told; one broken before this code first ran never is
}

/** Seams back to their defaults; the DB-only hooks stay registered. */
export function detachInfluence() {
  att = null;
  pending.clear();
  stages.clear();
  hooks.configure({ revert: null });
  setOverlayGate(null);
  setInfluenceFragment(null);
  setPersonLabel(null);
}

/** The DB-only 006 listeners (idempotent; life running or not). */
export function registerHooks() {
  try { return hooks.registerHooks(); } catch { return false; }
}

/** Revert the pointers of withdrawn items (boot, every tick, after a hook). Works detached. */
export function applyPendingWithdrawals() {
  try { return hooks.applyPendingWithdrawals(); } catch { return null; }
}

/** Test seam: forget in-memory caps and pending perceptions. */
export function __resetForTest() {
  caps.reset();
  clerkCaps.reset();
  pending.clear();
  stages.clear();
  answerTries.clear();
}

/** Test seam: resolves once every perception in flight has settled. */
export async function __idle() {
  for (let i = 0; i < 5; i++) {
    const list = [...pending.values()].map(e => e.promise).concat([...stages.values()].map(e => e.done)).filter(Boolean);
    if (!list.length) break;
    await Promise.all(list);
  }
}

// ── Chat keys ─────────────────────────────────────────────────────────────

function originOf(chatJid) {
  if (isGroupJid(chatJid)) return 'group';
  if (isDmJid(chatJid)) return 'dm';
  return null;
}

/** Canonical chat key: the group's bare JID, or the DM person's canonical id. */
export function chatKeyOf(chatJid) {
  const bare = safe(() => identity.bareJid(chatJid), null);
  if (!bare) return null;
  if (bare.endsWith('@g.us')) return bare;
  return safe(() => identity.resolvePerson(bare), null) || bare;
}

function personOf(jid) {
  if (typeof jid !== 'string' || !jid || jid === 'unknown') return null;
  const bare = safe(() => identity.bareJid(jid), null);
  if (!bare || bare.endsWith('@g.us')) return null;
  return safe(() => identity.resolvePerson(bare), null);
}

/** Same chat? (DM forms of one person count as one.) */
export function isLiveChat(chatJid, delayedFor) {
  if (!delayedFor?.chatJid || !chatJid) return false;
  return chatKeyOf(chatJid) === delayedFor.chatJid;
}

// Stricter than the facade's chatMayNudge (plan §P1.1): a known sender, a fresh
// member list that has them (group), or a DM sender in a fresh group. Fails closed.
function memberOk(chatKey, originKind, sender) {
  try {
    if (!sender) return false;
    if (originKind === 'group') return membership.isFresh(chatKey) && membership.isCurrentMember(chatKey, sender);
    return (membership.groupsOf(sender) || []).some(g => membership.isFresh(g.groupJid));
  } catch {
    return false;
  }
}

function mutedGroup(chatJid) {
  return safe(() => (att?.opts?.isGroupMuted ?? dashboardIsGroupMuted)(chatJid), true) === true;
}

// ── Perception ────────────────────────────────────────────────────────────

const letters = (s) => (String(s).match(/\p{L}/gu) || []).length;

function visibleRow(chatKey, msgId) {
  const rows = messageStore.getPromptVisibleInChat(chatKey, [msgId]);
  const row = rows.find(r => r.id === msgId) || null;
  return row && (row.expires_at === null || row.expires_at === undefined) ? row : null;
}

function isCandidate(row, chatRaw, isDm, ctx, talking) {
  if (isDm) return true;
  if (talking) return true;
  let metadata = {};
  try { metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) || {} : (row.metadata || {}); } catch { metadata = {}; }
  const msg = { id: row.id, content: row.content, metadata };
  if (safe(() => isBotMentioned(msg, ctx || {}, { logTag: 'chat influence' }), false)) return true;
  if (row.quoted_id && safe(() => messageStore.isOwnMessage(chatRaw, row.quoted_id), false)) return true;
  return safe(() => isBotAddressedInText(row.content), false);
}

function textOk(content) {
  return typeof content === 'string' && content.trim().length >= MIN_CHARS && letters(content) >= MIN_LETTERS;
}

/**
 * An incoming message the facade already let nudge him (chatMayNudge). Starts
 * the perception and returns its promise (never rejects; resolves to the
 * accepted codes or null). Nothing changes until gateOutcome().
 * ctx: { botJid, botLid, burstIds, gateVerdict? } (the turn's; gateVerdict, when present, must be
 * now/sneak/defer for a Jev call — anything else counts as nothing:gate_<verdict>).
 */
export function perceive(msg, audience, ctx = {}) {
  try {
    if (!perceptionOn()) return null;
    const pre = prepare(msg, audience, ctx);
    if (!pre) return null;
    const key = `${pre.chatKey}|${pre.turnMsgId}`;
    if (pending.has(key)) return pending.get(key).promise;
    const entry = { key, ...pre, verdict: null, result: undefined, timer: null };
    pending.set(key, entry);
    while (pending.size > PENDING_MAX) {
      const [k, e] = pending.entries().next().value;
      if (e?.timer) clearTimeout(e.timer);
      pending.delete(k);
    }
    entry.promise = askPerception({
      isDm: pre.originKind === 'dm', addressed: pre.addressed, talking: pre.talking,
      earlier: pre.earlier, excerpt: pre.excerpt, timeoutMs: config.chatInfluence?.jevTimeoutMs,
    }).finally(() => caps.done()).then((res) => {
      entry.result = res?.result ?? null;
      entry.codes = { kind: res?.why?.kind ?? null, target: res?.why?.target ?? null, originKind: pre.originKind };
      if (!res?.result) {
        noteOutcome('nothing', res?.skipped === 'none' ? (res?.why?.reason ?? 'none') : (res?.skipped ?? 'none'), entry.codes);
      }
      settle(entry);
      return entry.result;
    }, () => {
      entry.result = null;
      noteOutcome('nothing', 'error', { originKind: pre.originKind });
      settle(entry);
      return null;
    });
    // Excerpts never outlive the call.
    pre.excerpt = null;
    pre.earlier = null;
    return entry.promise;
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.perceive', err: err?.code || err?.name || 'error' }, 'chat influence: perceive refused');
    return null;
  }
}

function prepare(msg, audience, ctx) {
  if (msg?.isFromSelf === true || msg?.fromMe === true || msg?.key?.fromMe === true) return null;
  if (msg?.isForwarded === true) return null;
  if (msg?.messageType && msg.messageType !== 'text') return null;
  const chatRaw = audience?.chatJid ?? msg?.groupJid;
  const originKind = originOf(chatRaw);
  if (!ORIGIN_CHATS.has(originKind)) return null;
  const isDm = originKind === 'dm';
  if (!isDm && isSkillEnabled('imitate') && safe(() => getImitationTarget(chatRaw), null)) return null;
  if (safe(() => skillWouldHandle(msg, { ...(ctx || {}), isGroup: !isDm, isDm }), 'error')) return null;
  const chatKey = chatKeyOf(chatRaw);
  const sender = isDm ? personOf(msg?.senderJid ?? chatRaw) ?? personOf(chatRaw) : personOf(msg?.senderJid);
  if (!chatKey || !sender) return null;
  if (isDm && sender !== chatKey) return null;
  if (!memberOk(chatKey, originKind, sender)) return null;

  const at = clockNow();
  const talking = !isDm && safe(() => messageStore.countSelfMessagesInWindow(chatRaw, at - TALKING_WINDOW_SEC), 0) >= 1;
  // The burst of this flush (debounced): ask about its newest candidate line.
  const ids = [...new Set([...(Array.isArray(ctx?.burstIds) ? ctx.burstIds : []), msg?.id].filter(x => typeof x === 'string' && x))];
  const rows = messageStore.getPromptVisibleInChat(chatRaw, ids)
    .filter(r => (r.expires_at === null || r.expires_at === undefined) && textOk(r.content) && r.message_type === 'text');
  let target = null;
  for (let i = rows.length - 1; i >= 0 && !target; i--) {
    const r = rows[i];
    const rSender = personOf(r.sender_jid) ?? (isDm ? chatKey : null);
    if (!rSender || (isDm ? rSender !== chatKey : !memberOk(chatKey, originKind, rSender))) continue;
    if (isCandidate(r, chatRaw, isDm, ctx, talking)) target = { row: r, sender: rSender };
  }
  if (!target) return null;
  // The gate's verdict, when the caller has it (the live pipeline always does):
  // a turn he won't read (ignore/react) or a failed gate (error) spends no call.
  if (ctx && Object.hasOwn(ctx, 'gateVerdict') && !PERCEIVE_VERDICTS.has(ctx.gateVerdict)) {
    noteOutcome('nothing', `gate_${codeOf(ctx.gateVerdict, 'error')}`, { originKind });
    return null;
  }

  const dayKey = dateKey(at, tzNow());
  const ledger = store.ledgerCalls(CALLER, dayStart(at, tzNow()));
  const c = config.chatInfluence || {};
  const refused = caps.take({
    sender: target.sender, chat: chatKey, at, dayKey, ledger,
    perSender: Number(c.perSenderPerHour) || 0, perChat: Number(c.perChatPerHour) || 0, perDay: Number(c.jevMaxPerDay) || 0,
  });
  if (refused) {
    noteOutcome('nothing', `cap_${refused}`, { originKind });
    return null;
  }
  const recent = safe(() => messageStore.getRecentMessagesForPrompt(chatRaw, 8), []);
  const before = recent.filter(m => m.id !== target.row.id && m.timestamp <= target.row.timestamp && m.message_type === 'text').slice(-3);
  const labels = new Map();
  const earlier = before.map((m) => {
    if (m.is_from_self) return { label: 'HIM', text: m.content };
    const k = m.sender_jid || '?';
    if (!labels.has(k)) labels.set(k, `P${labels.size + 1}`);
    return { label: labels.get(k), text: m.content };
  });
  const addressed = isDm || safe(() => isBotMentioned({ id: target.row.id, content: target.row.content,
    metadata: safe(() => JSON.parse(target.row.metadata_json || '{}'), {}) }, ctx || {}), false)
    || safe(() => isBotAddressedInText(target.row.content), false);
  return {
    chatRaw, chatKey, originKind, turnMsgId: String(msg?.id ?? target.row.id),
    msgId: target.row.id, msgTs: Number(target.row.timestamp) || at, senderJid: target.sender,
    hash: sha(target.row.content), addressed, talking,
    earlier, excerpt: String(target.row.content).slice(0, EXCERPT_MAX * 2),
  };
}

/**
 * The availability gate's verdict for a live turn (processTurn, right after
 * the gate). now/sneak → the perception lands; defer → held until he reads it;
 * anything else → dropped. Also: he is reading this chat now, so perceptions
 * held from earlier messages of it land too.
 */
export function gateOutcome(chatJid, msgId, verdict) {
  try {
    const chatKey = chatKeyOf(chatJid);
    if (!chatKey) return;
    const entry = pending.get(`${chatKey}|${String(msgId)}`);
    if (LIVE_VERDICTS.has(verdict)) applyHeldFor(chatKey, null, clockNow());
    if (!entry) return;
    entry.verdict = typeof verdict === 'string' ? verdict : 'error';
    settle(entry);
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.gate', err: err?.code || err?.name || 'error' }, 'chat influence: gate outcome failed');
  }
}

function settle(entry) {
  if (entry.result === undefined) return;
  const codes = { kind: entry.result?.kind ?? entry.codes?.kind ?? null, target: entry.codes?.target ?? null, originKind: entry.originKind };
  if (entry.verdict === null) {
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        // No gate verdict for this turn within the wait: what he perceived is dropped.
        if (pending.get(entry.key) === entry) pending.delete(entry.key);
        if (entry.result) noteOutcome('dropped', 'no_verdict', codes);
      }, VERDICT_WAIT_MS);
      entry.timer.unref?.();
    }
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(entry.key);
  const res = entry.result;
  if (!res) return;            // counted as `nothing` when the call settled
  try {
    if (LIVE_VERDICTS.has(entry.verdict)) {
      const why = {};
      const out = applyPerception(entry, res, Math.min(clockNow(), Math.max(entry.msgTs, clockNow() - 3600)), null, entry.key, why);
      // An invitation's chain notes its own outcome once it settles (startInvite).
      if (!(out && typeof out.then === 'function')) {
        if (out) noteOutcome('applied', res.kind, codes);
        else noteOutcome('dropped', why.reason ?? 'refused', codes);
      }
    } else if (entry.verdict === 'defer') {
      if (!wanted(res)) {
        noteOutcome('dropped', 'area_off', codes);
        return;
      }
      store.insertItem({
        kind: res.kind === 'affect' ? 'mood' : res.kind === 'advice' ? 'advice' : 'invite', chatJid: entry.chatKey, originKind: entry.originKind,
        msgId: entry.msgId, senderJid: entry.senderJid, contentHash: entry.hash, held: codesOf(res), status: 'held', createdAt: clockNow(),
        ...(res.kind === 'cancel' ? { category: 'cancel' } : {}),
      });
      noteOutcome('held', res.kind, codes);
    } else {
      noteOutcome('dropped', `gate_${codeOf(entry.verdict)}`, codes);
    }
  } catch (err) {
    noteOutcome('dropped', 'error', codes);
    logger.warn({ evt: 'issue', where: 'chatInfluence.apply', err: err?.code || err?.name || 'error' }, 'chat influence: perception not applied');
  }
}

function codesOf(res) {
  const out = { kind: res.kind, intensity: res.intensity, p: res.p };
  if (res.affect) out.affect = res.affect;
  if (res.advice) out.advice = res.advice;
  return out;
}

// Would an area that's on consume this perception? (an affect → mood; an invite
// or a cancel → invites; advice → the tray, with the story on)
function wanted(res) {
  if (res?.kind === 'affect') return mood.AFFECTS.includes(res.affect) && influenceOn('mood');
  if (res?.kind === 'invite' || res?.kind === 'cancel') return influenceOn('invites');
  if (res?.kind === 'advice') return advice.CATEGORIES.includes(res.advice) && adviceOn();
  return false;
}

/**
 * Apply one accepted perception at `at`. → the pointer event (mood, cancel), a
 * promise (an invitation's chain) or null. `heldId`: the held row to activate
 * instead of inserting; `stageKey`: where the turn's note looks the chain up.
 */
function applyPerception(src, res, at, heldId = null, stageKey = null, why = {}) {
  if (!att) { why.reason = 'not_attached'; return null; }
  if (!wanted(res)) { why.reason = 'area_off'; return null; }
  if (res.kind === 'invite') return startInvite(src, res, at, heldId, stageKey ?? `${src.chatKey}|${src.msgId}`);
  if (res.kind === 'cancel') return applyCancel(src, res, at, heldId, why);
  if (res.kind === 'advice') return applyAdvice(src, res, at, heldId, why);
  return applyMood(src, res, at, heldId, why);
}

// Advice → one pending tray row, in one synchronous section. No world event: it
// changes nothing in his life until the owner acts on the Director. → the row or null.
function applyAdvice(src, res, _at, heldId = null, why = {}) {
  const row = visibleRow(src.chatKey, src.msgId);
  if (!row || sha(row.content) !== src.hash) { why.reason = 'changed'; return null; } // forgotten, revoked or edited meanwhile
  const category = res.advice;
  const t = Math.floor(clockNow());
  const refused = advice.refusal({ category, senderJid: src.senderJid }, {
    controls: (o) => att.controlsVerdict(o),
    pendingCount: (c) => store.advicePendingCount(c, t),
    pendingBySender: (c, who) => store.advicePendingBySender(c, who, t),
    perCategory: config.chatInfluence?.advicePerCategory,
  });
  if (refused) {
    why.reason = `advice_${codeOf(refused)}`;
    logger.debug({ evt: 'chatInfluence.advice', skipped: refused, category }, 'chat influence: advice not proposed');
    return null;
  }
  const expiresAt = advice.expiresAt(t, config.chatInfluence?.adviceDays);
  let item;
  if (heldId) item = store.promoteHeldAdvice(heldId, { category, expiresAt }) ? store.getItem(heldId) : null;
  else {
    item = store.insertItem({
      kind: 'advice', chatJid: src.chatKey, originKind: src.originKind, msgId: src.msgId, senderJid: src.senderJid,
      contentHash: src.hash, category, status: 'pending', createdAt: t, expiresAt,
    });
  }
  if (item) logger.info({ evt: 'chatInfluence.advice', itemId: item.id, category }, 'chat influence: advice on the tray');
  else why.reason = 'not_stored';
  return item;
}

// A mood blip, in one synchronous section.
function applyMood(src, res, at, heldId = null, why = {}) {
  const row = visibleRow(src.chatKey, src.msgId);
  if (!row || sha(row.content) !== src.hash) { why.reason = 'changed'; return null; } // forgotten, revoked or edited meanwhile
  const s = att.getState();
  const dampKey = src.originKind === 'group' ? src.senderJid : src.chatKey;
  const damp = mood.dampFor(mood.earlierFromSame(s?.chatMood, dampKey, at));
  const delta = mood.deltaFor(res.affect, res.intensity, { scale: Number(config.chatInfluence?.moodScale), damp });
  if (mood.isZero(delta)) { why.reason = 'zero'; return null; }
  const subject = src.originKind === 'group' ? { subjectJid: src.senderJid } : {};
  const when = Math.floor(at);
  const ptr = att.append({
    type: 'chat.perceived', at: when, actor: 'chat', originKind: src.originKind, originJid: src.chatKey, ...subject,
    payload: { kind: 'affect', affect: res.affect, intensity: res.intensity, p: res.p, msgId: String(src.msgId).slice(0, 128) },
  });
  att.append({
    type: 'mood.chat', at: when, actor: 'engine', causeId: ptr.id, ...subject,
    payload: { affect: res.affect, intensity: res.intensity, delta, damp },
  });
  if (heldId) store.activateHeld(heldId, ptr.id);
  else {
    store.insertItem({
      kind: 'mood', chatJid: src.chatKey, originKind: src.originKind, msgId: src.msgId, senderJid: src.senderJid,
      contentHash: src.hash, pointerEventId: ptr.id, status: 'active', createdAt: clockNow(),
    });
  }
  logger.info({ evt: 'chatInfluence.mood', eventId: ptr.id, affect: res.affect, intensity: res.intensity, damp }, 'chat influence: mood blip');
  return ptr;
}

// → the invitation chains started (promises), for a caller that wants to wait on them.
function applyHeldFor(chatKey, msgIds, at) {
  const chains = [];
  for (const row of store.heldFor(chatKey, msgIds)) {
    const res = row.held;
    const codes = { kind: res?.kind ?? null, originKind: row.originKind };
    try {
      const why = {};
      const done = res && wanted(res)
        ? applyPerception({ chatKey: row.chatJid, originKind: row.originKind, msgId: row.msgId, senderJid: row.senderJid,
          hash: row.contentHash, msgTs: at }, res, at, row.id, null, why)
        : null;
      if (!done) {
        store.deleteItem(row.id);
        noteOutcome('dropped', `held_${why.reason ?? (res ? 'area_off' : 'bad_codes')}`, codes);
      } else if (typeof done.then === 'function') chains.push(done);
      else noteOutcome('applied', `held_${codeOf(res.kind)}`, codes);
    } catch {
      safe(() => store.deleteItem(row.id), 0);
      noteOutcome('dropped', 'held_error', codes);
    }
  }
  return chains;
}

/**
 * phone.drainChat, under the lock, before a catch-up turn (msgIds: the queued
 * rows it answers; empty → nothing to do): the chat's held perceptions land
 * now. → null, or a promise (bounded by inviteWaitMs) that settles once the
 * invitations among them opened their decisions, so the catch-up turn's note
 * can come from state.
 */
export function beforeDrainTurn(chatJid, msgIds, at) {
  try {
    const chatKey = chatKeyOf(chatJid);
    if (!chatKey || !Array.isArray(msgIds) || !msgIds.length) return null;
    // He reads the whole chat at the check: every held perception of it lands,
    // not only those keyed by a queued message (a debounced burst queues its
    // last line, while perception may have kept an earlier one).
    const chains = applyHeldFor(chatKey, null, Number.isFinite(at) ? at : clockNow());
    if (!chains.length) return null;
    return raceMs(Promise.all(chains), waitBudgetMs());
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.drain', err: err?.code || err?.name || 'error' }, 'chat influence: held perceptions not applied');
    return null;
  }
}

// ── Invitations (P2) ──────────────────────────────────────────────────────
//
//   startInvite     an accepted `invite` perception he read: the stage entry
//                   ('invite' — the turn can already say "someone invited you"),
//                   then the chain: invitation caps → ONE clerk extraction (the
//                   message re-read, fenced) → the story facade's code resolution
//                   (reconciler steps 4–10, a generic venue when no known place is
//                   named) → in one synchronous section (still visible, same text)
//                   the inert pointer + the item row → openDecision (first lean
//                   from code, an answer grace, `invite` flag: no early commit) →
//                   stage 'open'. Any refusal → stage 'none' (he just replies).
//   inviteNote      the per-turn line (processTurn waits ≤ inviteWaitMs).
//   awaitingAnswer  his reply in that chat answers it (009's claim call asks).
//   follow-ups      a "maybe" that committed (or a reversal) → one turn at the
//                   next phone check, through the catch-up path.

const raceMs = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(undefined), Math.max(0, ms));
  t.unref?.();
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
});

function waitBudgetMs() {
  const n = Number(config.chatInfluence?.inviteWaitMs);
  return Number.isFinite(n) ? Math.max(0, Math.min(2000, n)) : 2000;
}

function setStage(key, entry) {
  if (stages.has(key)) stages.delete(key);
  stages.set(key, entry);
  while (stages.size > STAGES_MAX) stages.delete(stages.keys().next().value);
}

const worldNow = (st) => safe(() => att.worldOf(st), null) ?? att?.world ?? null;
const hasOrigin = (d, chatKey) => Array.isArray(d?.origins) && d.origins.some(o => o?.jid === chatKey);

function openInvites(s) {
  let n = 0;
  for (const d of s?.decisions?.values?.() || []) if (d.invite === true && d.status === 'open') n++;
  return n;
}

// Invitation caps (per day, per chat per day, open at once). → the cap's name or null.
function inviteCapped(chatKey, s, at) {
  const perDay = Number(config.chatInfluence?.invitesMaxPerDay);
  if (!(perDay > 0)) return 'day';
  const counts = store.inviteCountsSince(dayStart(at, tzNow()));
  if (counts.total >= perDay) return 'day';
  if ((counts.byChat[chatKey] ?? 0) >= invites.MAX_PER_CHAT_DAY) return 'chat';
  if (openInvites(s) >= invites.MAX_OPEN) return 'open';
  return null;
}

function earlierOf(row) {
  const recent = safe(() => messageStore.getRecentMessagesForPrompt(row.group_jid, 8), []);
  const before = recent.filter(m => m.id !== row.id && m.timestamp <= row.timestamp && m.message_type === 'text').slice(-3);
  const labels = new Map();
  return before.map((m) => {
    if (m.is_from_self) return { label: 'HIM', text: m.content };
    const k = m.sender_jid || '?';
    if (!labels.has(k)) labels.set(k, `P${labels.size + 1}`);
    return { label: labels.get(k), text: m.content };
  });
}

function startInvite(src, res, at, heldId, stageKey) {
  const entry = { stage: 'invite', decisionId: null, done: null };
  const codes = { kind: res?.kind ?? 'invite', target: src?.codes?.target ?? null, originKind: src.originKind };
  const pre = heldId ? 'held_' : '';
  entry.done = runInvite(src, res, at, heldId).then((out) => {
    entry.stage = out?.decisionId ? 'open' : 'none';
    entry.decisionId = out?.decisionId ?? null;
    if (out?.decisionId) noteOutcome('applied', `${pre}invite_open`, codes);
    else noteOutcome('dropped', `${pre}invite_${codeOf(out?.reason, 'other')}`.slice(0, 32), codes);
    if (!out?.decisionId) {
      // A held row is dropped only when nothing landed (a landed one is withdrawn, so the hooks still see it).
      if (heldId && !out?.landed) safe(() => store.deleteItem(heldId), 0);
      logger.debug({ evt: 'chatInfluence.invite', skipped: out?.reason ?? 'none' }, 'chat influence: invitation not opened');
    }
    return entry;
  }, () => {
    entry.stage = 'none';
    noteOutcome('dropped', `${pre}invite_error`, codes);
    if (heldId) safe(() => store.deleteItem(heldId), 0);
    return entry;
  });
  setStage(stageKey, entry);
  return entry.done;
}

async function runInvite(src, res, at, heldId) {
  if (!att || !att.resolvePlan) return { reason: 'not_attached' };
  const t0 = clockNow();
  const s0 = att.getState();
  if (embargoActive(s0?.embargo, t0)) return { reason: 'embargo' };
  const capped = inviteCapped(src.chatKey, s0, t0);
  if (capped) return { reason: `cap_${capped}` };
  const row = visibleRow(src.chatKey, src.msgId);
  if (!row || sha(row.content) !== src.hash) return { reason: 'gone' };
  const tz = tzNow();
  const refused = clerkCaps.take({
    dayKey: dateKey(t0, tz), ledger: store.ledgerCalls(invites.CALLER, dayStart(t0, tz)),
    perDay: Number(config.chatInfluence?.clerkMaxPerDay) || 0,
  });
  if (refused) return { reason: `clerk_${refused}` };
  let out;
  try {
    out = await invites.extractInvite({
      createdAt: Number(row.timestamp) || t0, tz, earlier: earlierOf(row), excerpt: String(row.content).slice(0, EXCERPT_MAX * 2),
    });
  } finally {
    clerkCaps.done();
  }
  if (!out?.text) return { reason: out?.skipped ?? 'clerk' };
  if (!att || !influenceOn('invites')) return { reason: 'off' };
  const st = att.getState();
  const world = worldNow(st);
  const now1 = clockNow();
  const r = await att.resolvePlan(out.text, {
    chatJid: src.chatKey, originKind: src.originKind, originJid: src.chatKey, createdAt: Number(row.timestamp) || now1,
  }, st, { at: now1, venue: (k) => invites.venueFor(k, st, world, now1)?.name ?? null });
  if (!r?.ok) return { reason: r?.reason ?? 'unresolved' };
  const res1 = r.resolution;
  if (!(res1.span?.start > now1 - 3600) || res1.span.start > now1 + invites.WINDOW_SEC) return { reason: 'out_of_window' };
  if (res1.subjectJid && personOf(res1.subjectJid) !== src.senderJid) return { reason: 'multi_person' };
  const verdict = att.controlsVerdict({ source: 'engine', category: 'social', action: 'decision', pinKeys: res1.castIds || [] });
  if (verdict?.ok !== true) return { reason: verdict?.reason ?? 'controls' };
  if (!att || !influenceOn('invites')) return { reason: 'off' };

  // One synchronous section: still visible with the same text → pointer, row.
  const row2 = visibleRow(src.chatKey, src.msgId);
  if (!row2 || sha(row2.content) !== src.hash) return { reason: 'gone' };
  const s2 = att.getState();
  if (inviteCapped(src.chatKey, s2, clockNow())) return { reason: 'cap' };
  const when = Math.floor(Math.min(clockNow(), Math.max(at, 0)));
  const subject = src.originKind === 'group' ? { subjectJid: src.senderJid } : {};
  const ptr = att.append({
    type: 'chat.perceived', at: when, actor: 'chat', originKind: src.originKind, originJid: src.chatKey, ...subject,
    payload: { kind: 'invite', intensity: res.intensity, p: res.p, msgId: String(src.msgId).slice(0, 128) },
  });
  let itemId = heldId;
  if (heldId) store.activateHeld(heldId, ptr.id);
  else {
    itemId = store.insertItem({
      kind: 'invite', chatJid: src.chatKey, originKind: src.originKind, msgId: src.msgId, senderJid: src.senderJid,
      contentHash: src.hash, pointerEventId: ptr.id, status: 'active', createdAt: clockNow(),
    })?.id ?? null;
  }
  const spec = invites.inviteSpec({ kind: r.kind, resolution: res1, pointerId: ptr.id, mode: verdict.ask === true ? 'ask' : 'auto', state: s2, world });
  let opened;
  try {
    opened = await openDecision(() => att.getState(), spec, {
      at: clockNow(), world: worldNow(att.getState()), append: att.append, causeId: ptr.id, subjectJid: src.senderJid,
      noJev: true, noJevReason: 'invite_open',
    });
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'chatInfluence.invite', err: err?.code || err?.name || 'error' }, 'chat influence: invitation not opened');
    // The pointer is in the log: withdraw its row (the hooks' world half reverts it).
    if (Number.isSafeInteger(itemId) && store.markWithdrawn([itemId], 'open_failed')) applyPendingWithdrawals();
    return { reason: 'open_failed', landed: true };
  }
  const decisionId = opened?.decision?.id ?? null;
  if (Number.isSafeInteger(itemId) && decisionId) store.setItemDecision(itemId, decisionId);
  // A forget/revoke/edit that landed while the decision opened: withdraw it now.
  const row3 = visibleRow(src.chatKey, src.msgId);
  if (!row3 || sha(row3.content) !== src.hash) {
    if (Number.isSafeInteger(itemId) && store.markWithdrawn([itemId], 'evidence')) applyPendingWithdrawals();
    return { reason: 'gone', landed: true };
  }
  logger.info({ evt: 'chatInfluence.invite', eventId: ptr.id, decisionId, mode: spec.mode }, 'chat influence: invitation opened');
  return { decisionId };
}

// The inviter called it off: their invitations from this chat get the cancel.
function applyCancel(src, res, at, heldId = null, why = {}) {
  if (!att) { why.reason = 'not_attached'; return null; }
  const s = att.getState();
  const targets = [...(s?.decisions?.values?.() || [])].filter(d => d.invite === true
    && (d.status === 'open' || d.status === 'committed') && d.subjectJid === src.senderJid && hasOrigin(d, src.chatKey));
  if (!targets.length) { why.reason = 'no_invitation'; return null; }
  const row = visibleRow(src.chatKey, src.msgId);
  if (!row || sha(row.content) !== src.hash) { why.reason = 'changed'; return null; }
  const subject = src.originKind === 'group' ? { subjectJid: src.senderJid } : {};
  const ptr = att.append({
    type: 'chat.perceived', at: Math.floor(at), actor: 'chat', originKind: src.originKind, originJid: src.chatKey, ...subject,
    payload: { kind: 'cancel', intensity: res.intensity, p: res.p, msgId: String(src.msgId).slice(0, 128) },
  });
  if (heldId) store.activateHeld(heldId, ptr.id, { decisionId: targets[0].id });
  else {
    store.insertItem({
      kind: 'invite', category: 'cancel', chatJid: src.chatKey, originKind: src.originKind, msgId: src.msgId, senderJid: src.senderJid,
      contentHash: src.hash, pointerEventId: ptr.id, decisionId: targets[0].id, status: 'active', createdAt: clockNow(),
    });
  }
  for (const d of targets) {
    // The chat moved on: no "can't make it" / "I'm coming" follow-up to the
    // person who called it off — dropped before the cancel's own lean can commit
    // (an early commit makes a follow-up due at once).
    const item = safe(() => store.itemByDecision(d.id), null);
    if (item) safe(() => store.setFollowup(item.id, 'dropped', [null, 'due']), false);
    // ... nor later, whatever closes this plan: every target's own mark (the row can't say it: 012's
    // drops write 'dropped' too, and the cancel's own row names only the first target).
    safe(() => store.setStateValue(inviterCancelledKey(d.id), String(ptr.id)), null);
    // Staying in already: nothing to call off.
    if (d.status === 'committed' && d.committed?.optionId === 'stay') continue;
    cancelInvite(() => att.getState(), d.id, {
      at: clockNow(), world: worldNow(att.getState()), append: att.append, pointerId: ptr.id,
      originKind: src.originKind, originJid: src.chatKey,
    }).catch(err => logger.debug({ evt: 'chatInfluence.cancel', err: err?.code || err?.name || 'error' }, 'chat influence: cancel failed'));
  }
  logger.info({ evt: 'chatInfluence.cancel', eventId: ptr.id, decisions: targets.length }, 'chat influence: inviter cancelled');
  return ptr;
}

// The real person's short name (people.push_name), for the outing line in an
// audience that may see them (innerState checks the subject rule first).
function personName(jid) {
  const p = safe(() => getPerson(jid), null);
  const n = typeof p?.push_name === 'string' ? p.push_name : '';
  return n ? invites.inviterName(n).slice(0, 20) : null;
}

function noteFor(d, s, audience, senderName) {
  const tz = resolveTimezone(s?.world?.timezone ?? config.timezone);
  const evening = safe(() => eveningClause(s, clockNow(), audience, { until: d.subject?.eventAt ? d.subject.eventAt + 4 * 3600 : null }), '');
  const lean = d.lean?.optionId === 'stay' ? 'stay' : (d.lean?.optionId === 'go' || d.lean?.optionId === 'late') && (d.lean.p ?? 0) >= 0.5 ? 'go' : null;
  return invites.openNote({ name: invites.inviterName(senderName), d, tz, evening, leaning: lean });
}

// The detailed line, named after the invitation's own sender (not the turn's
// last one: a burst can have several senders). Its message gone or edited → null.
function noteOf(d, s, chatKey, audience) {
  const item = safe(() => store.itemByDecision(d.id), null);
  const row = item ? visibleRow(chatKey, item.msgId) : null;
  if (!row || (item.contentHash && sha(row.content) !== item.contentHash)) return null;
  return noteFor(d, s, audience, row.sender_name);
}

function openUnanswered(s, decisionId, chatKey) {
  const d = s?.decisions?.get?.(decisionId);
  return d && d.invite === true && d.status === 'open' && !d.inviteAnswer && hasOrigin(d, chatKey) ? d : null;
}

// Still open to his word: unanswered, or a "maybe" a later yes / no may settle.
function answerable(s, decisionId, chatKey) {
  const d = s?.decisions?.get?.(decisionId);
  return d && d.invite === true && d.status === 'open' && (!d.inviteAnswer || d.inviteAnswer === 'maybe') && hasOrigin(d, chatKey) ? d : null;
}

/**
 * The per-turn invitation line for this message (processTurn, before the reply
 * is generated). A live turn waits for the chain ≤ inviteWaitMs counted from
 * `startedAt` (the turn's start): decision open → the detailed line; only "it's
 * an invite" known → the generic line; nothing → ''. A catch-up turn reads this
 * chat's open, unanswered invitations from state (no wait). Imitating, under embargo or
 * off → ''. Only for this chat (the decision's origin is this chat).
 * opts: { startedAt (ms), catchUp, imitating }. The line names the invitation's own sender.
 */
export async function inviteNote(chatJid, msgId, audience, { startedAt = Date.now(), catchUp = null, imitating = false } = {}) {
  try {
    if (!influenceOn('invites') || imitating || catchUp?.followUp || catchUp?.cap) return '';
    const chatKey = chatKeyOf(chatJid);
    if (!chatKey) return '';
    if (embargoActive(att.getState()?.embargo, clockNow())) return '';
    const key = `${chatKey}|${String(msgId)}`;
    if (!catchUp || catchUp.live === true) {
      const deadline = startedAt + waitBudgetMs();
      const p = pending.get(key);
      if (p?.promise) await raceMs(p.promise, deadline - Date.now());
      const st = stages.get(key);
      if (st?.stage === 'invite' && st.done) await raceMs(st.done, deadline - Date.now());
      const s = att?.getState();
      if (st?.stage === 'open' && st.decisionId) {
        const d = openUnanswered(s, st.decisionId, chatKey);
        const note = d ? noteOf(d, s, chatKey, audience) : null;
        if (note) return note;
      }
      if (st?.stage === 'invite') return invites.GENERIC_NOTE;
      if (!catchUp) return '';
    }
    // A catch-up: he reads the chat, so this chat's open invitations he hasn't
    // answered (newest first; opened from state — a held one landed just before
    // the turn, whichever line of the burst it came from).
    const s = att?.getState();
    const open = [...(s?.decisions?.values?.() || [])].filter(d => openUnanswered(s, d.id, chatKey)).sort((a, b) => b.id - a.id);
    for (const d of open) {
      const note = noteOf(d, s, chatKey, audience);
      if (note) return note;
    }
    return '';
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.note', err: err?.code || err?.name || 'error' }, 'chat influence: no invitation note');
    return '';
  }
}

/**
 * His reply in `chatJid` was really sent (not imitating, not a follow-up, not a
 * dry run — the caller checks): the open invitation from this chat still
 * waiting for his word, with the answer question for 009's claim call. Waits
 * (≤ 10 s) for the chain of the message he replied to. ≤ 3 classifications per
 * invitation, and only a reply with a yes/no/maybe cue (`text`) spends one.
 * `they_said` is the invitation, read now (gone → null).
 * → { decisionId, extraQuestion } | null
 */
export async function awaitingAnswer(chatJid, { triggerMsgId = null, at = clockNow(), text = null } = {}) {
  try {
    if (!influenceOn('invites')) return null;
    // A reply with no yes / no / maybe cue is not asked about, and spends none of the tries.
    if (typeof text === 'string' && !invites.answerCue(text)) return null;
    const chatKey = chatKeyOf(chatJid);
    if (!chatKey) return null;
    let direct = null;
    if (triggerMsgId) {
      const key = `${chatKey}|${String(triggerMsgId)}`;
      const p = pending.get(key);
      if (p?.promise) await raceMs(p.promise, ANSWER_WAIT_MS);
      let st = stages.get(key);
      if (st?.stage === 'invite' && st.done) await raceMs(st.done, ANSWER_WAIT_MS);
      st = stages.get(key);
      if (st?.stage === 'open' && Number.isSafeInteger(st.decisionId)) direct = st.decisionId;
    }
    if (!att || !influenceOn('invites')) return null;
    const s = att.getState();
    // The invitation of the message he replied to comes first, also when its
    // decision opened only after the reply went out (a slow clerk); the others
    // of this chat only if they were open when he replied.
    const first = direct !== null ? answerable(s, direct, chatKey) : null;
    const open = [...(s?.decisions?.values?.() || [])]
      .filter(d => d.id !== first?.id && answerable(s, d.id, chatKey) && (d.opensAt ?? 0) <= at)
      .sort((a, b) => b.id - a.id);
    if (first) open.unshift(first);
    for (const d of open) {
      if ((answerTries.get(d.id) ?? 0) >= invites.ANSWER_ATTEMPTS) continue;
      const item = store.itemByDecision(d.id);
      const row = item ? visibleRow(chatKey, item.msgId) : null;
      if (!row || (item.contentHash && sha(row.content) !== item.contentHash)) continue;
      answerTries.set(d.id, (answerTries.get(d.id) ?? 0) + 1);
      while (answerTries.size > ANSWER_TRIES_MAX) answerTries.delete(answerTries.keys().next().value);
      return {
        decisionId: d.id,
        extraQuestion: {
          key: 'answer', question: invites.ANSWER_QUESTION, theySaid: invites.theySaidOf(row.content),
          cue: invites.answerCue, accept: invites.acceptAnswer,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** His reply answered the invitation: commit/hold it (decisions.answerInvite). Never throws. */
export async function onAnswer(inv, ans) {
  try {
    if (!att || !influenceOn('invites') || !Number.isSafeInteger(inv?.decisionId) || !ans?.answer) return null;
    const out = await answerInvite(() => att.getState(), inv.decisionId, ans.answer, {
      at: clockNow(), world: worldNow(att.getState()), append: att.append, p: ans.p,
      controls: () => att.controlsVerdict({ source: 'engine', category: 'social', action: 'decision' }),
    });
    if (out) logger.info({ evt: 'chatInfluence.answer', decisionId: inv.decisionId, answer: ans.answer }, 'chat influence: invitation answered');
    return out;
  } catch (err) {
    logger.warn({ evt: 'issue', where: 'chatInfluence.answer', err: err?.code || err?.name || 'error' }, 'chat influence: answer not recorded');
    return null;
  }
}

// ── Follow-ups (phone.js runs them under the chat lock) ───────────────────

function followUpWindowOk(d, outcome, at) {
  const eventAt = d.subject?.eventAt;
  const endAt = d.options?.find(o => o.id === 'late')?.expiresAt ?? (Number.isFinite(eventAt) ? eventAt + 7200 : null);
  if (!Number.isFinite(eventAt)) return false;
  return outcome === 'late' ? Number.isFinite(endAt) && at < endAt : at < eventAt;
}

// 020 §A4: he backed out of a plan made with a real person in a chat — he said yes to an invitation,
// or told them about a plan (an adopted claim naming them), and it fell through: rethought, couldn't
// go, or the owner called it off. He sends one message there, from the plan's code facts only. Off
// with chatInfluence.tellBackOut. Not when he himself said no / maybe, nor once the time has passed.
// The owner may also answer an invitation he never answered (a pick or a cancel): the inviter hears
// once, the same way. Told, then the plan comes back (a revert, a rewind): one correction, once.
const BACK_OUT_REASONS = new Set(['could_not_go', 'owner_cancelled', 'owner_plan', 'fell_through', 'schedule', 'career_changed']);
const OWNER_CLOSE_REASONS = new Set(['owner_cancelled', 'owner_plan', 'fell_through', 'schedule']);
const DECLINE_OPTIONS = new Set(['stay', 'skip']);
// Before any tell: an undo in this time reaches nobody (a quick undo was "can't make it", then "actually
// I can", a minute apart). The phone's scheduled check lands right after it (phone.js FOLLOW_UP_DELAY_SEC).
export const TELL_GRACE_SEC = 3 * 60;
// However many plans break at once (a sick day, a day off), he doesn't flood anyone: one tell per chat
// per phone check, this many a day overall. Over it nothing is spent: a later check may still tell.
export const TELL_MAX_PER_DAY = 5;
let tellMax = TELL_MAX_PER_DAY;
/** Test seam: a long scenario tells more than a day's cap (the cap has its own test). null restores it. */
export function __setTellMaxForTest(n) { tellMax = n ?? TELL_MAX_PER_DAY; }
// His own line says it already: only that cancels a back-out, never an unrelated line ("sorry which movie?",
// "can't believe it"). A can't / won't right before coming / making / going, or doing it; or sorry with one of those.
const CANT_NEAR = /\b(?:can['’]?t|cannot|won['’]?t|will not|can not)\s+(?:\w+\s+){0,3}?(?:come|coming|make|go|going|do\s+it|manage\s+it)\b/i;
const CANT_SAID = /\b(?:not\s+coming|not\s+going\s+to\s+make|unable\s+to\s+(?:come|make|go))\b/i;
const SORRY_PLAN = /\bsorry\b.*\b(?:come|coming|make|go|going|it)\b|\b(?:come|coming|make|go|going|it)\b.*\bsorry\b/i;
export function saysHeCant(text) {
  const t = String(text ?? '').slice(0, 2000);
  return CANT_NEAR.test(t) || CANT_SAID.test(t) || SORRY_PLAN.test(t);
}
const backOutOn = () => config.chatInfluence?.tellBackOut !== false;
const goingOption = (d) => d?.committed?.optionId === 'go' || d?.committed?.optionId === 'late';
const isClosed = (d) => d?.status === 'missed' || d?.status === 'cancelled';

const backOutKey = (id) => `backout:${id}`;           // spent: told, or given up on (never twice)
const backOutSentKey = (id) => `backout_sent:${id}`;  // a turn really sent it
const backOutFixKey = (id) => `backout_fix:${id}`;    // the one correction was spent
const backOutRetryKey = (id) => `backout_retry:${id}`;      // the quality gate blocked the tell: its one retry was used
const backOutFixRetryKey = (id) => `backout_fix_retry:${id}`;
const backOutLineKey = (msgId) => `backout_line:${msgId}`;  // this line of his is a tell (about that decision)
const inviterCancelledKey = (id) => `inviter_cancelled:${id}`; // the inviter called it off: the cancel's pointer
const tellDayKey = (day) => `backout_day:${day}`;           // tells sent that day
const stateSet = (key) => safe(() => store.getStateValue(key), null) != null;
const backOutDone = (id) => stateSet(backOutKey(id));
const backOutSent = (id) => stateSet(backOutSentKey(id));
const BACK_OUT_SINCE = 'backout:since';

// Deploy safety: plans that broke before this code first ran were never promised a message.
function backOutSince() {
  const v = Number(safe(() => store.getStateValue(BACK_OUT_SINCE), null));
  if (Number.isFinite(v) && v > 0) return v;
  const at = clockNow();
  safe(() => store.setStateValue(BACK_OUT_SINCE, String(at)), null);
  return at;
}

// Deploy safety, the other half: a plan he committed to before this code first ran. No preview warned
// the owner that it could message anyone, and the new engine rules may close it on the first ticks.
function committedBeforeSince(d) {
  if (!d?.committed) return false;
  const since = backOutSince();
  const opened = safe(() => getEvent(d.id), null);
  if (Number.isFinite(opened?.at) && opened.at >= since) return false;
  const s = att?.getState?.();
  const rows = safe(() => listEvents({ types: ['decision.committed'], after: d.id - 1, limit: 500, order: 'asc' }), []) || [];
  const first = rows.find(e => e.payload?.decisionId === d.id && !e.redacted && !safe(() => isExcludedId(s, e.id), false));
  return (first?.at ?? d.committed.at ?? Infinity) < since;
}

// The inviter called this plan off themselves: nobody tells them he can't make it. Only while that cancel
// stands: a forgotten, revoked or edited one is reverted (its pointer leaves the projection) and its mark goes.
function inviterCancelled(d) {
  const key = inviterCancelledKey(d?.id);
  let v;
  try { v = store.getStateValue(key); } catch { return true; }
  if (v === null || v === undefined) return false;
  const ptr = Number(v);
  const s = att?.getState?.();
  const ev = safe(() => getEvent(ptr), null);
  if (!ev || ev.redacted === true || safe(() => isExcludedId(s, ptr), false)) {
    safe(() => store.setStateValue(key, null), null);
    return false;
  }
  return true;
}

// The person's "don't text me first" (the mind's exclusions; wired by the app). No wiring: none known.
// A failed read holds the tell (nothing spent).
function optedOut(person) {
  const fn = att?.opts?.personOptedOut;
  if (typeof fn !== 'function') return false;
  return fn(person) === true;
}

function tellsToday(at) {
  const day = dateKey(at, tzNow());
  return { day, n: Number(safe(() => store.getStateValue(tellDayKey(day)), 0)) || 0 };
}

// Why a closed decision closed (the projection keeps no reason): its last decision.expired still in the log.
function closeReasonOf(d) {
  const s = att?.getState?.();
  const rows = safe(() => listEvents({ types: ['decision.expired'], after: d.id - 1, limit: 2000, order: 'asc' }), []) || [];
  let reason = null;
  for (const e of rows) if (e.payload?.decisionId === d.id && !s?.excluded?.has?.(e.id) && !e.redacted) reason = e.payload?.reason ?? null;
  return reason;
}

/** He gave his word: yes / late to an invitation, a confirmation he sent, or a plan he told a real person about. */
function gaveHisWord(d) {
  if (d?.invite === true) {
    return d.inviteAnswer === 'yes' || d.inviteAnswer === 'late'
      || (d.followUp?.sent === true && (d.followUp.outcome === 'going' || d.followUp.outcome === 'late'));
  }
  return d?.adopted === true && typeof d.subjectJid === 'string';
}
function brokePlan(d) {
  if (isClosed(d)) return true;
  return d?.status === 'committed' && (d.reversals ?? 0) >= 1 && DECLINE_OPTIONS.has(d.committed?.optionId);
}
/** Does this plan, as it stands, owe that person a "can't make it"? */
function isBackOut(d) {
  if (!d || !backOutOn()) return false;
  const word = gaveHisWord(d);
  if (!word && (d.invite !== true || d.inviteAnswer)) return false;
  const closed = isClosed(d);
  if (word && !brokePlan(d)) return false;
  const reason = closed ? closeReasonOf(d) : null;
  if (closed && !BACK_OUT_REASONS.has(reason)) return false;
  if (word) return true;
  // The owner answered for him: an invitation he hadn't answered, picked stay or called off.
  if (d.invite !== true || d.inviteAnswer) return false;
  if (closed) return OWNER_CLOSE_REASONS.has(reason);
  return d.status === 'committed' && d.committed?.by === 'owner' && DECLINE_OPTIONS.has(d.committed?.optionId);
}
const breakAt = (d) => (d.status === 'committed' ? d.committed?.at : d.closedAt) ?? 0;

// The newest real text line from this person in that chat: never a reaction, media with no text, or a disappearing line.
function lastLineOf(chatKey, person) {
  const lines = safe(() => messageStore.getRecentMessagesForPrompt(chatKey, 30), []) || [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i];
    if (m.is_from_self || m.message_type !== 'text' || !m.content || m.expires_at !== null && m.expires_at !== undefined) continue;
    if (personOf(m.sender_jid) === person) return m;
  }
  return null;
}

const noted = new Set();   // one log line per decision + reason, for a state that stays as it is
function noteOnce(id, reason) {
  const k = `${id}:${reason}`;
  if (noted.has(k)) return;
  if (noted.size > 500) noted.clear();
  noted.add(k);
  logger.info({ evt: 'chatInfluence.followUp', decisionId: id, outcome: 'none', reason }, 'chat influence: back-out has nobody to tell');
}

// The line a message about this plan answers: the invitation itself, or the newest line of the person
// an adopted claim names (never whoever spoke last). → { itemId, chatKey, chatJid, msgId } | null
function lineFor(d) {
  if (d.invite === true) {
    const item = store.itemByDecision(d.id);
    if (!item || item.status !== 'active') return null;
    let row = visibleRow(item.chatJid, item.msgId);
    if (!row) return null;
    // A busy group: the invitation scrolled out of the transcript; their newest line stands in for it.
    const window = safe(() => messageStore.getRecentMessagesForPrompt(item.chatJid, isGroupJid(item.chatJid) ? WINDOW_GROUP : WINDOW_DM), []) || [];
    if (!window.some(m => m.id === row.id)) row = lastLineOf(item.chatJid, personOf(row.sender_jid)) ?? row;
    return { itemId: item.id, chatKey: item.chatJid, chatJid: row.group_jid, msgId: row.id };
  }
  const claim = safe(() => getClaim(d.claimId), null);
  const chatKey = claim?.chatJid ? chatKeyOf(claim.chatJid) : null;
  const person = personOf(d.subjectJid);
  if (!chatKey || !person) return null;
  if (isGroupJid(chatKey)) {
    if (!membership.isFresh(chatKey)) return null;
    if (!membership.isCurrentMember(chatKey, person)) {
      noteOnce(d.id, 'left');
      return null;
    }
  } else if (chatKey !== person) {
    noteOnce(d.id, 'not_in_chat');
    return null;
  }
  const row = lastLineOf(chatKey, person);
  if (!row) {
    noteOnce(d.id, 'no_line');
    return null;
  }
  return { itemId: null, chatKey, chatJid: row.group_jid, msgId: row.id };
}

function backOutEntry(d, at) {
  if (!followUpWindowOk(d, 'not_going', at) || !isBackOut(d) || backOutDone(d.id) || breakAt(d) < backOutSince()) return null;
  if (at - breakAt(d) < TELL_GRACE_SEC || committedBeforeSince(d) || inviterCancelled(d)) return null;
  const line = lineFor(d);
  return line ? { decisionId: d.id, ...line, outcome: 'not_going', commitAt: breakAt(d), optionId: null, backOut: true } : null;
}

// He told them he can't, and the plan is back on (a revert, a rewind, the owner's pick).
function correctionEntry(d, at) {
  if (!backOutOn() || d?.status !== 'committed' || !goingOption(d) || !backOutSent(d.id) || stateSet(backOutFixKey(d.id))) return null;
  const outcome = invites.outcomeOf(d.committed.optionId);
  if (!outcome || !followUpWindowOk(d, outcome, at)) return null;
  const told = Number(safe(() => store.getStateValue(backOutSentKey(d.id)), 0)) || 0;
  if (at - told < TELL_GRACE_SEC || inviterCancelled(d)) return null;
  const line = lineFor(d);
  return line ? { decisionId: d.id, ...line, outcome, commitAt: d.committed.at, optionId: d.committed.optionId, correction: true } : null;
}

/**
 * Read-only, for the Director's warnings: would changing this plan (to `to`: an option id; null = call
 * it off) send a real message? True only when the path that sends it would run.
 */
export function willTellBackOut(d, { to = null, at = clockNow() } = {}) {
  try {
    if (!att || !d || !influenceOn('invites') || !backOutOn()) return false;
    if (d.invite !== true && !(d.adopted === true && typeof d.subjectJid === 'string')) return false;
    if (inviterCancelled(d)) return false;
    const decline = to === null || DECLINE_OPTIONS.has(to);
    if (d.invite === true) {
      const unanswered = !d.inviteAnswer;
      if (!unanswered && !gaveHisWord(d)) {
        // 012's own follow-ups: a maybe he commits, a "no" he reverses.
        if (to === null || d.followUp) return false;
      }
      if (!decline && !unanswered && gaveHisWord(d) && d.followUp) return false;
    } else if (!decline) {
      return false;
    }
    if (decline && backOutDone(d.id)) return false;
    if (!followUpWindowOk(d, decline ? 'not_going' : invites.outcomeOf(to), at)) return false;
    const line = lineFor(d);
    if (!line) return false;
    const group = isGroupJid(line.chatJid);
    if (group && safe(() => mutedGroup(line.chatJid), true) === true) return false;
    if (group && isSkillEnabled('imitate') && safe(() => getImitationTarget(line.chatJid), null)) return false;
    if (optedOut(personOf(d.invite === true ? safe(() => visibleRow(line.chatKey, line.msgId), null)?.sender_jid : d.subjectJid))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Is this applied event one that makes a follow-up due? (phone.onEvent schedules a check soon.) */
export function isFollowUpEvent(ev) {
  if (!att || !ev) return false;
  if (!influenceOn('invites')) return false;
  const decisions = att.getState()?.decisions;
  // A plan back on after he said he can't (the fold may not have run yet: the check itself decides).
  if (ev.type === 'event.reverted' || ev.type === 'world.rewound') {
    if (!backOutOn()) return false;
    for (const d of decisions?.values?.() || []) if (backOutSent(d.id) && !stateSet(backOutFixKey(d.id))) return true;
    return false;
  }
  const d = decisions?.get?.(Number(ev.payload?.decisionId));
  if (ev.type === 'decision.expired') {
    if (!BACK_OUT_REASONS.has(ev.payload?.reason)) return false;
    return isBackOut(d);
  }
  if (ev.type !== 'decision.committed' && ev.type !== 'decision.reversed') return false;
  if (!d) return false;
  if (correctionEntry(d, clockNow())) return true;
  if (isBackOut(d)) return true;
  if (d.adopted === true || d.invite !== true || d.followUp) return false;
  // tellBackOut off: a reversed promise says nothing either.
  if (ev.type === 'decision.reversed') return !(DECLINE_OPTIONS.has(d.committed?.optionId) && gaveHisWord(d));
  if (!d.inviteAnswer && ev.actor === 'owner') return true;   // the owner answered for him
  return d.inviteAnswer === 'maybe' && ev.payload?.by !== 'reply';
}

/**
 * Follow-ups due at `at` (derived from the projection, so a restart loses
 * nothing): a "maybe" that committed, an answered invitation that reversed, an
 * unanswered one the owner picked, not followed up yet, its row not attempted,
 * before the point it still matters; a back-out or its correction (020).
 * → [{ decisionId, itemId, chatKey, chatJid (as stored: the lock's key), msgId, outcome, commitAt, optionId, backOut?, correction?, ownerAnswer? }]
 */
export function dueFollowUps(at = clockNow()) {
  try {
    if (!att || !influenceOn('invites')) return [];
    const s = att.getState();
    const out = [];
    const tellChats = new Set();   // one tell per chat per check: a mass break never bursts
    for (const d of s?.decisions?.values?.() || []) {
      if (!Number.isFinite(d.subject?.eventAt) || d.subject.eventAt <= at - 2 * 86400) continue;
      const told = backOutEntry(d, at) ?? correctionEntry(d, at);
      if (told) {
        if (!tellChats.has(told.chatKey)) out.push(told);
        tellChats.add(told.chatKey);
        continue;
      }
      if (d.invite !== true || d.status !== 'committed' || d.followUp) continue;
      const ownerAnswer = !d.inviteAnswer && d.committed?.by === 'owner' && goingOption(d);
      if (!d.inviteAnswer && !ownerAnswer) continue;
      if (ownerAnswer && committedBeforeSince(d)) continue;
      if (!ownerAnswer && !(d.inviteAnswer === 'maybe' || (d.reversals ?? 0) >= 1)) continue;
      // A decline after his word is a back-out (above, or off with the switch): never this path.
      if (gaveHisWord(d) && DECLINE_OPTIONS.has(d.committed?.optionId)) continue;
      const outcome = invites.outcomeOf(d.committed?.optionId);
      if (!outcome || !followUpWindowOk(d, outcome, at)) continue;
      const item = store.itemByDecision(d.id);
      if (!item || item.status !== 'active' || (item.followupStatus && item.followupStatus !== 'due')) continue;
      const row = visibleRow(item.chatJid, item.msgId);
      if (!row) continue;
      if (ownerAnswer) {
        if (tellChats.has(item.chatJid)) continue;
        tellChats.add(item.chatJid);
      }
      out.push({ decisionId: d.id, itemId: item.id, chatKey: item.chatJid, chatJid: row.group_jid, msgId: item.msgId, outcome,
        commitAt: d.committed.at, optionId: d.committed.optionId, ...(ownerAnswer ? { ownerAnswer: true } : {}) });
    }
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

function dropFollowUp(f, reason, status = 'dropped') {
  // A back-out given up on stays given up on; a plan that changed may still break later, and its row stays as it was.
  const keepOpen = (f.backOut || f.correction) && reason === 'changed';
  if (!keepOpen) safe(() => store.setFollowup(f.itemId, status, [null, 'due']), false);
  if (f.backOut && !keepOpen) safe(() => store.setStateValue(backOutKey(f.decisionId), `dropped:${reason}`), null);
  if (f.correction && !keepOpen) safe(() => store.setStateValue(backOutFixKey(f.decisionId), `dropped:${reason}`), null);
  logger.info({ evt: 'chatInfluence.followUp', decisionId: f.decisionId, outcome: status, reason }, 'chat influence: follow-up dropped');
  return null;
}

// Would the turn go ahead now? A cap, a cooldown or warmup clear later, so they spend nothing: the next
// phone check tries again, until the plan's time. (A [SKIP] from the model, or the quality gate, does spend it.)
let turnGateForTest = null;
/** Test seam: the rate limiter counts on the real clock, a long fake-clock scenario overtakes it. */
export function __setTurnGateForTest(fn) { turnGateForTest = typeof fn === 'function' ? fn : null; }
function turnMayGo(chatJid, isGroup) {
  if (turnGateForTest) return turnGateForTest(chatJid, isGroup);
  if (safe(() => checkWarmup('text').allowed, false) !== true) return false;
  if (!isGroup) return true;
  return checkRateLimit(chatJid).allowed && checkHourlyCaps(chatJid, { isMention: false }).allowed && !inBurst(chatJid);
}

/**
 * Under the chat lock, right before the follow-up turn: re-check everything
 * (chat not muted, the person still a member, the line still prompt-visible
 * and in the transcript window, he hasn't said it already, the plan still as
 * it was, controls allow it (a back-out or a correction is no story decision:
 * they don't apply), the group not imitating) and count the one attempt
 * (due → attempted). → { msg, chatJid, isGroup, note, startedAt, kind } | null (dropped).
 */
export function prepareFollowUp(f, { isGroupMuted = null, isMember = null, loadMessage = null } = {}) {
  try {
    if (!att || !influenceOn('invites')) return null;
    const at = clockNow();
    const s = att.getState();
    const d = s?.decisions?.get?.(f.decisionId);
    const telling = f.backOut === true || f.correction === true;
    if (f.backOut) {
      if (!isBackOut(d) || backOutDone(d.id) || inviterCancelled(d)) return dropFollowUp(f, 'changed');
    } else if (f.correction) {
      if (!backOutOn() || d?.status !== 'committed' || d.committed?.optionId !== f.optionId || !backOutSent(d.id) || stateSet(backOutFixKey(d.id)) || inviterCancelled(d)) return dropFollowUp(f, 'changed');
    } else if (!d || d.status !== 'committed' || d.followUp || d.committed?.optionId !== f.optionId) return dropFollowUp(f, 'changed');
    if (!followUpWindowOk(d, f.outcome, at)) return dropFollowUp(f, 'too_late');
    const row = visibleRow(f.chatKey, f.msgId);
    if (!row) return f.itemId ? dropFollowUp(f, 'gone') : null;
    const chatJid = row.group_jid;
    const isGroup = isGroupJid(chatJid);
    if (isGroup && safe(() => (isGroupMuted ?? mutedGroup)(chatJid), true) === true) return dropFollowUp(f, 'muted');
    // The person it is about: an adopted claim's subject, else who wrote the line (the inviter).
    const who = d.invite === true ? row.sender_jid : d.subjectJid;
    // A gap in the membership data (a reconnect's resync, a failed sync) spends nothing: the next check
    // tries again. Only fresh data saying they aren't a member does.
    if (isGroup) {
      if (!membership.isFresh(f.chatKey)) return null;
      if (!(membership.isCurrentMember(f.chatKey, personOf(who)) && safe(() => (isMember ?? (() => true))(chatJid, who), false))) return dropFollowUp(f, 'left');
    }
    // A DM inviter must still share a fresh group with him (perception's rule); else an outsider.
    if (!isGroup) {
      const shared = safe(() => membership.groupsOf(f.chatKey), null);
      if (shared === null) return null;
      if (!shared.length) return dropFollowUp(f, 'left');
      if (!shared.some(g => membership.isFresh(g.groupJid))) return null;
    }
    if (telling || f.ownerAnswer) {
      let out;
      try { out = optedOut(personOf(who)); } catch { return null; }
      if (out) return dropFollowUp(f, 'opt_out');
    }
    if (isGroup && isSkillEnabled('imitate') && safe(() => getImitationTarget(chatJid), null)) return dropFollowUp(f, 'imitating');
    const window = safe(() => messageStore.getRecentMessagesForPrompt(chatJid, isGroup ? WINDOW_GROUP : WINDOW_DM), []);
    if (!window.some(m => m.id === row.id)) return dropFollowUp(f, 'out_of_window');
    if (f.backOut) {
      // He already said it himself, since it broke. An unrelated line of his cancels nothing.
      // (His own tell about another plan in this chat is not about this one.)
      if (window.some(m => m.is_from_self && Number(m.timestamp) > Number(f.commitAt) && saysHeCant(m.content) && !stateSet(backOutLineKey(m.id)))) return dropFollowUp(f, 'he_spoke');
    } else if (f.ownerAnswer) {
      if (window.some(m => m.is_from_self && Number(m.timestamp) > Number(f.commitAt) && safe(() => invites.definiteCue(m.content), false))) return dropFollowUp(f, 'he_spoke');
    } else if (!f.correction) {
      const last = safe(() => messageStore.getLastSelfMessage(chatJid), null);
      if (last && Number(last.timestamp) > Number(f.commitAt)) return dropFollowUp(f, 'he_spoke');
    }
    // After his "maybe" he already said yes / no there (a reply the classifier
    // didn't settle it with): a follow-up could contradict him.
    if (!telling && d.inviteAnswer === 'maybe' && finite(d.inviteAnsweredAt) && window.some(m => m.is_from_self
      && Number(m.timestamp) > d.inviteAnsweredAt && safe(() => invites.definiteCue(m.content), false))) {
      return dropFollowUp(f, 'he_spoke');
    }
    if (!telling && !f.ownerAnswer) {
      const v = att.controlsVerdict({ source: 'engine', category: 'social', action: 'decision' });
      if (v?.ok !== true) return dropFollowUp(f, v?.reason ?? 'controls');
    }
    const msg = loadMessage ? safe(() => loadMessage({ msgId: row.id, chatJid }), null) : null;
    if (!msg) return f.itemId ? dropFollowUp(f, 'gone') : null;
    // Back-outs and the owner's answers: nothing is spent while the turn could not go ahead (the next check tries again).
    if ((telling || f.ownerAnswer) && !turnMayGo(chatJid, isGroup)) return null;
    if ((telling || f.ownerAnswer) && tellsToday(at).n >= tellMax) {
      noteOnce(d.id, 'tell_cap');
      return null;
    }
    if (f.itemId && !store.setFollowup(f.itemId, 'attempted', [null, 'due']) && !telling) return null;
    if (f.backOut) store.setStateValue(backOutKey(d.id), String(at));   // once per broken plan, whatever the turn does from here
    if (f.correction) store.setStateValue(backOutFixKey(d.id), String(at));
    const tz = resolveTimezone(s?.world?.timezone ?? config.timezone);
    const name = d.invite === true ? null : personName(personOf(d.subjectJid));
    return { msg, chatJid, isGroup, note: invites.followUpNote({ d, outcome: f.outcome, tz, name, correction: f.correction === true }), startedAt: at,
      kind: f.correction ? 'correction' : f.backOut ? 'back_out' : null, stillApplies: () => stillApplies(f) };
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.followUp', err: err?.code || err?.name || 'error' }, 'chat influence: follow-up refused');
    return null;
  }
}

/** Is what this turn says still true? Read again right before the send (generation and the delay take a while). */
function stillApplies(f) {
  const d = att?.getState?.()?.decisions?.get?.(f.decisionId);
  if (!d) return false;
  if (f.backOut) return isBackOut(d) && !inviterCancelled(d);
  return d.status === 'committed' && d.committed?.optionId === f.optionId && (!f.correction || !inviterCancelled(d));
}

/**
 * After the follow-up turn (whatever it did): sent → recorded; else skipped. The attempt is spent, with
 * two exceptions for a tell: the plan came back while the turn ran (it may still break later), and the
 * quality gate blocked it (`blocked: 'gate'`: one retry at a later check; then it ends, with no reaction).
 */
export function finishFollowUp(f, { chatJid, startedAt, blocked = null } = {}) {
  try {
    const last = safe(() => messageStore.getLastSelfMessage(chatJid), null);
    const sentNow = !!last && Number(last.timestamp) >= Number(startedAt) && last.is_from_self === 1;
    if (f.itemId) store.setFollowup(f.itemId, sentNow ? 'sent' : 'skipped', ['attempted']);
    if (f.backOut && sentNow) store.setStateValue(backOutSentKey(f.decisionId), String(clockNow()));
    if ((f.backOut || f.correction) && sentNow) store.setStateValue(backOutLineKey(last.id), String(f.decisionId));
    if ((f.backOut || f.correction || f.ownerAnswer) && sentNow) {
      const { day, n } = tellsToday(clockNow());
      store.setStateValue(tellDayKey(day), String(n + 1));
      store.deleteStateBefore('backout_day:', tellDayKey(day));
    }
    if ((f.backOut || f.correction) && !sentNow) {
      const mark = f.backOut ? backOutKey(f.decisionId) : backOutFixKey(f.decisionId);
      const retry = f.backOut ? backOutRetryKey(f.decisionId) : backOutFixRetryKey(f.decisionId);
      const changed = !stillApplies(f);
      const again = blocked === 'gate' && !stateSet(retry);
      if (again) store.setStateValue(retry, String(clockNow()));
      if (changed || again) {
        store.setStateValue(mark, null);
        logger.info({ evt: 'chatInfluence.followUp', decisionId: f.decisionId, outcome: 'unspent', reason: changed ? 'changed' : 'gate_retry' }, 'chat influence: tell not sent, not spent');
        return false;
      }
    }
    if (!att) return sentNow;
    const d = att.getState()?.decisions?.get?.(f.decisionId);
    if (d && d.invite === true && !d.followUp && !f.correction) {
      att.append({
        type: 'invite.followed_up', at: clockNow(), actor: 'engine', causeId: d.committed?.eventId ?? d.id,
        ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}),
        payload: { decisionId: d.id, outcome: f.outcome, sent: sentNow },
      });
    }
    logger.info({ evt: 'chatInfluence.followUp', decisionId: f.decisionId, sent: sentNow }, 'chat influence: follow-up done');
    return sentNow;
  } catch (err) {
    logger.debug({ evt: 'chatInfluence.followUp', err: err?.code || err?.name || 'error' }, 'chat influence: follow-up not recorded');
    return false;
  }
}

/** Dashboard (operator view): recent invitations — ids, codes, labels built in code; never the message. */
export function invitesView(limit = 30) {
  const s = att ? safe(() => att.getState(), null) : null;
  const tz = tzNow();
  return store.listInvites(limit).map((item) => {
    const d = s?.decisions?.get?.(item.decisionId) ?? null;
    return {
      decisionId: item.decisionId, itemId: item.id, chatJid: item.chatJid, originKind: item.originKind, status: item.status,
      label: d ? cleanLabelOf(d) : null, eventAt: d?.subject?.eventAt ?? null, eventDate: d?.subject?.eventAt ? dateKey(d.subject.eventAt, tz) : null,
      decisionStatus: d?.status ?? null, answer: d?.inviteAnswer ?? null,
      lean: d?.lean ? { optionId: d.lean.optionId, p: Math.round((d.lean.p ?? 0) * 100) / 100 } : null,
      committed: d?.committed?.optionId ?? null, mode: d?.mode ?? null, followUp: d?.followUp ?? null,
      followupStatus: item.followupStatus, createdAt: item.createdAt,
    };
  });
}

function cleanLabelOf(d) {
  const o = (d.options || []).find(x => x.id === 'go');
  return typeof o?.label === 'string' ? o.label.slice(0, 80) : null;
}

/** The Day page's influence lane: every chat-influence event in [from, to): { at, type, eventId, chatJid, kind, state, affect? }. Codes only. */
export function laneEvents(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.redacted === true) continue;
    const p = e.payload || {};
    if (e.type === 'chat.perceived') {
      out.push({ at: e.at, type: e.type, eventId: e.id, chatJid: e.originJid ?? null, kind: p.kind ?? null, state: null,
        ...(p.kind === 'affect' && mood.AFFECTS.includes(p.affect) ? { affect: p.affect } : {}) });
    }
    else if (e.type === 'sleep.delayed') out.push({ at: e.at, type: e.type, eventId: e.id, chatJid: e.originJid ?? null, kind: 'sleep', state: `${p.totalMin ?? 0}` });
    else if (e.type === 'work.behind') out.push({ at: e.at, type: e.type, eventId: e.id, chatJid: null, kind: 'work', state: null });
    else if (e.type === 'invite.answered') out.push({ at: e.at, type: e.type, eventId: e.id, chatJid: e.originJid ?? null, kind: 'invite', state: p.answer ?? null });
    else if (e.type === 'invite.followed_up') out.push({ at: e.at, type: e.type, eventId: e.id, chatJid: e.originJid ?? null, kind: 'invite', state: p.sent ? 'sent' : 'skipped' });
  }
  return out;
}

// ── Sleep push (pulse.startBlock) ─────────────────────────────────────────

function chatMayInfluence(chatRaw) {
  const kind = originOf(chatRaw);
  if (!kind) return false;
  if (kind === 'group') return !mutedGroup(chatRaw) && safe(() => membership.isFresh(chatKeyOf(chatRaw)), false);
  const p = chatKeyOf(chatRaw);
  return !!p && memberOk(p, 'dm', p);
}

/** pulse.startBlock's seam: true when it pushed his sleep (two events appended). */
export function beforeSleep(s, at, block, add) {
  if (!influenceOn('sleep')) return false;
  const tickSec = (Number(config.life?.tickMinutes) > 0 ? Number(config.life.tickMinutes) : 15) * 60;
  const push = sleepPush(s, at, block, {
    on: () => true,
    now: clockNow,
    tickSec,
    maxMinutes: Number(config.chatInfluence?.sleepMaxMinutes) || 0,
    paused: () => att?.controlsVerdict?.({ source: 'engine', category: 'social', action: 'beat' })?.ok !== true,
    selfChatsSince: (since) => messageStore.selfChatsSince(since),
    incomingSince: (chat, since) => messageStore.countIncomingInWindow(chat, since),
    chatOk: (chat) => chatMayInfluence(chat),
    lastIncoming: (chat, since) => {
      const r = messageStore.lastIncomingSince(chat, since);
      return r ? { msgId: r.id, senderJid: r.senderJid } : null;
    },
    originOf,
    dateOf: (t) => dateKey(t, resolveTimezone(s?.world?.timezone)),
  });
  if (!push) return false;
  const chatKey = chatKeyOf(push.chatJid);
  const sender = push.originKind === 'group' ? personOf(push.senderJid) : null;
  const row = chatKey ? visibleRow(chatKey, push.msgId) : null;
  if (!chatKey || !row || (push.originKind === 'group' && !sender)) return false;
  const append = typeof add === 'function' ? add : att.append;
  const subject = sender ? { subjectJid: sender } : {};
  const ptr = append({
    type: 'chat.perceived', at, actor: 'chat', originKind: push.originKind, originJid: chatKey, ...subject,
    payload: { kind: 'live', exchanges: push.exchanges, msgId: String(push.msgId).slice(0, 128) },
  });
  append({
    type: 'sleep.delayed', at, actor: 'engine', causeId: ptr.id, ...subject,
    payload: { minutes: push.minutes, until: push.until, totalMin: push.totalMin, date: push.date },
  });
  safe(() => store.insertItem({
    kind: 'live', chatJid: chatKey, originKind: push.originKind, msgId: push.msgId, senderJid: sender ?? chatKey,
    contentHash: sha(row.content), pointerEventId: ptr.id, status: 'active', createdAt: clockNow(),
  }), null);
  logger.info({ evt: 'chatInfluence.sleep', eventId: ptr.id, totalMin: push.totalMin }, 'chat influence: sleep pushed');
  return true;
}

// ── Tick ──────────────────────────────────────────────────────────────────

/** The facade's afterTick: work counter, evidence sweep, held expiry, withdrawals. Never throws. */
export async function afterTick(view, info = {}) {
  if (!att) return;
  const at = clockNow();
  try { chatLoadCheck(view, at); } catch (err) {
    logger.debug({ evt: 'chatInfluence.load', err: err?.code || err?.name || 'error' }, 'chat influence: chat load failed');
  }
  try { workCheck(view, at); } catch (err) {
    logger.debug({ evt: 'chatInfluence.work', err: err?.code || err?.name || 'error' }, 'chat influence: work check failed');
  }
  try { sweepEvidence(at); } catch { /* retried next tick */ }
  try {
    const hours = Number(config.life?.queueMaxAgeHours) > 0 ? Number(config.life.queueMaxAgeHours) : 18;
    const n = store.expireHeld(at - hours * 3600);
    if (n > 0) noteOutcome('dropped', 'held_expired', { n });
  } catch { /* best effort */ }
  try { store.expireAdvice(at); } catch { /* retried next tick */ }
  try { sweepAdvice(); } catch { /* retried next tick */ }
  applyPendingWithdrawals();
  void info;
}

// Chat load (2026-10-31): every ≥ 30 min, the counts of what he said and read in
// the chats he was talking in → one counts-only, self-origin `chat.load` (the
// vitals drain his social battery from it). Live only; the cursor seeds at the
// first tick (history is never counted) and after downtime at most 2 h counts.
export const CHAT_LOAD_WINDOW_SEC = 1800;
const CHAT_LOAD_MAX_SEC = 2 * 3600;
const CHAT_LOAD_ACTIVE_SEC = 15 * 60;
const CHAT_LOAD_CURSOR = 'chatLoad:cursor';

function chatLoadCheck(view, at) {
  if (!influenceOn('mood') || !view) return;
  if (Math.abs((view.viewAt ?? at) - at) > 3600) return;           // live only
  const cursor = Number(store.getStateValue(CHAT_LOAD_CURSOR));
  if (!Number.isFinite(cursor) || cursor <= 0 || cursor > at) { store.setStateValue(CHAT_LOAD_CURSOR, String(at)); return; }
  if (at - cursor < CHAT_LOAD_WINDOW_SEC) return;
  const from = Math.max(cursor, at - CHAT_LOAD_MAX_SEC);
  const load = messageStore.chatLoadBetween(from, at, from - CHAT_LOAD_ACTIVE_SEC);
  store.setStateValue(CHAT_LOAD_CURSOR, String(at));
  if (!(load.sent > 0)) return;
  const ev = att.append({
    type: 'chat.load', at, actor: 'engine', originKind: 'self', originJid: 'self',
    payload: { sent: load.sent, received: load.received, chats: load.chats, windowMin: Math.round((at - from) / 60) },
  });
  logger.info({ evt: 'chatInfluence.load', eventId: ev.id, sent: load.sent, received: load.received }, 'chat influence: chat load');
}

function workCheck(view, at) {
  if (!influenceOn('work') || !view) return;
  if (Math.abs((view.viewAt ?? at) - at) > 3600) return;           // live only
  const due = workBehindDue(view, at, {
    on: () => true,
    countSelfSince: (since) => messageStore.countSelfMessagesSince(since),
    threshold: Number(config.chatInfluence?.workMsgsPerHour) || 25,
    today: dateKey(at, resolveTimezone(view.world?.timezone)),
  });
  if (!due) return;
  const ev = att.append({
    type: 'work.behind', at, actor: 'engine', originKind: 'self', originJid: 'self',
    payload: { sent: due.sent, windowMin: WORK_WINDOW_SEC / 60, workPressure: WORK_PRESSURE, date: due.date },
  });
  logger.info({ evt: 'chatInfluence.work', eventId: ev.id, sent: due.sent }, 'chat influence: behind at work');
}

// An item whose evidence is no longer prompt-visible (forgotten, expired,
// revoked) or whose text changed since it was perceived → withdrawn (a missed or
// failed hook, or a deletion that raced the perception).
function sweepEvidence(at) {
  const gone = [];
  for (const item of store.activeSince(at - SWEEP_SEC)) {
    const row = safe(() => visibleRow(item.chatJid, item.msgId), undefined);
    if (row === undefined) continue;
    if (!row || (item.contentHash && sha(row.content) !== item.contentHash)) gone.push(item.id);
  }
  if (gone.length && store.markWithdrawn(gone, 'evidence')) applyPendingWithdrawals();
}

// Pending advice whose message is gone or changed leaves the tray (a missed hook;
// advice lives up to 14 days, longer than the sweep window above).
function sweepAdvice() {
  const gone = [];
  for (const item of store.pendingAdvice()) {
    const row = safe(() => visibleRow(item.chatJid, item.msgId), undefined);
    if (row === undefined) continue;
    if (!row || (item.contentHash && sha(row.content) !== item.contentHash)) gone.push(item.id);
  }
  if (gone.length) store.markWithdrawn(gone, 'evidence');
}

// ── Prompt fragment (innerState seam) ─────────────────────────────────────

function sameChat(jid, audience) {
  if (!jid || !audience) return false;
  if (audience.chatJid === jid) return true;
  return Array.isArray(audience.sameChat) && audience.sameChat.includes(jid);
}

function evidenceVisible(pointerId) {
  if (!Number.isSafeInteger(pointerId)) return false;
  const item = store.itemsByPointers([pointerId])[0];
  if (!item || item.status !== 'active') return false;
  const row = visibleRow(item.chatJid, item.msgId);
  return !!row && (!item.contentHash || sha(row.content) === item.contentHash);
}

// The reason behind a feeling, only in the chat it came from (strictly tighter
// than 006's canUseIn: a group blip never explains itself in a member's DM).
// Other chats feel the shifted mood value only. Dashboard: everything.
function reasonFragment(state, audience, { at } = {}) {
  try {
    const t = finite(at) ? at : clockNow();
    const dash = audience?.kind === 'dashboard';
    const df = state?.sleep?.delayedFor;
    if (df && finite(df.until) && t < df.until && influenceOn('sleep') && (dash || sameChat(df.chatJid, audience))) {
      return mood.LATE_PHRASE;
    }
    if (!influenceOn('mood') || !Array.isArray(state?.chatMood)) return '';
    let best = null;
    for (const e of state.chatMood) {
      if (!dash && !sameChat(e?.originJid, audience)) continue;
      if (!dash && !subjectVisible(e.subjectJid, audience)) continue;
      const left = Math.abs(finite(e.dv) ? e.dv : 0) * mood.decay(e.at, t);
      if (left < mood.LIVE_MIN_VALENCE || !mood.REASON_PHRASES[e.affect]) continue;
      if (!best || left > best.left) best = { e, left };
    }
    if (!best || !evidenceVisible(best.e.pointerId)) return '';
    return mood.REASON_PHRASES[best.e.affect];
  } catch {
    return '';
  }
}

// ── Dashboard reads (operator view; codes, ids and counts only) ───────────

/** Life · Now's "chats on his day" panel. */
export function nowView() {
  const at = clockNow();
  const tz = tzNow();
  const c = config.chatInfluence || {};
  const s = att ? safe(() => att.getState(), null) : null;
  const ledger = store.ledgerCalls(CALLER, dayStart(at, tz));
  const blips = [];
  for (const e of Array.isArray(s?.chatMood) ? s.chatMood : []) {
    const k = mood.decay(e.at, at);
    if (!k || Math.abs(e.dv * k) < 0.005) continue;
    blips.push({
      eventId: e.eventId, pointerId: e.pointerId, chatJid: e.originJid, affect: e.affect,
      ageMin: Math.max(0, Math.round((at - e.at) / 60)), valence: Math.round(e.dv * k * 1000) / 1000,
    });
  }
  const overlay = s?.chatMood?.length ? mood.overlayAt(s.chatMood, at) : null;
  const df = s?.sleep?.delayedFor;
  return {
    skill: safe(() => isSkillEnabled('chat-influence'), false),
    lifeOn: !!att && safe(() => att.isLifeOn() === true, false),
    degraded: safe(() => hooks.isDegraded(), true),
    on: Object.fromEntries(AREAS.map(a => [a, influenceOn(a)])),
    areas: Object.fromEntries(AREAS.map(a => [a, c[a] === true])),
    caps: {
      jevToday: Math.max(caps.usedToday(dateKey(at, tz)), ledger ?? 0), jevMaxPerDay: Number(c.jevMaxPerDay) || 0,
      ledgerOk: ledger !== null,
    },
    overlay: overlay ? {
      valence: Math.round(overlay.valence * 1000) / 1000, stress: Math.round(overlay.stress * 10) / 10,
      social: Math.round(overlay.social * 10) / 10,
    } : null,
    blips: blips.sort((a, b) => a.ageMin - b.ageMin).slice(0, 20),
    sleep: df ? { chatJid: df.chatJid, until: df.until, totalMin: df.totalMin, eventId: df.eventId } : null,
    workBehindToday: s?.influence?.workBehindDay === dateKey(at, tz),
    counts: safe(() => store.countsSince(dayStart(at, tz)), []),
    perceptions: outcomesToday(dateKey(at, tz)),
  };
}

// ── Advice tray (P3; operator view) ───────────────────────────────────────

const ADVICE_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired', 'withdrawn']);

/**
 * Story · From chats / Director · Suggestions from chats: advice rows with the
 * live excerpt (read now from the messages table: forgotten, expired, revoked
 * or edited → null) and the code-built summary ("advice from <chat> about
 * <category>"; nameOf(chatJid) → the chat's name, the route's lookup). status:
 * one of ADVICE_STATUSES or null (all). Pending rows past their expiry are
 * listed as expired. Works with life stopped.
 */
export function adviceView({ status = null, limit = 50, nameOf = null } = {}) {
  if (status !== null && !ADVICE_STATUSES.has(status)) return [];
  const at = clockNow();
  const rows = safe(() => store.listAdvice({ status: status === 'expired' ? null : status, limit: status === 'expired' ? 500 : limit }), []);
  const out = [];
  for (const r of rows) {
    const expired = r.status === 'pending' && finite(r.expiresAt) && r.expiresAt <= at;
    const st = expired ? 'expired' : r.status;
    if (status && st !== status) continue;
    let excerpt = null;
    if (st !== 'withdrawn') {
      const row = safe(() => visibleRow(r.chatJid, r.msgId), null);
      if (row && (!r.contentHash || sha(row.content) === r.contentHash)) excerpt = advice.excerptOf(row.content);
    }
    const name = typeof nameOf === 'function' ? safe(() => nameOf(r.chatJid), null) : null;
    out.push({
      id: r.id, chatJid: r.chatJid, chatName: name, originKind: r.originKind, category: r.category, status: st,
      summary: advice.summaryOf(name, r.category), excerpt,
      createdAt: r.createdAt, expiresAt: r.expiresAt, decidedAt: r.decidedAt, withdrawReason: r.withdrawReason,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The owner's verdict on one pending advice row: 'approve' → approved, and the
 * Director preset for its category (nothing is written to his world — the owner
 * builds and applies a scene, or not); 'reject' → rejected. Needs the story on.
 * → { ok:true, id, status, category, preset? } | { ok:false, reason: 'off'|'not_found'|'not_pending' }
 */
export function adviceDecide(id, verdict, { by = 'owner' } = {}) {
  if (!Number.isSafeInteger(id) || (verdict !== 'approve' && verdict !== 'reject')) return { ok: false, reason: 'not_found' };
  if (!att || !safe(() => att.storyOn() === true, false)) return { ok: false, reason: 'off' };
  const item = store.getItem(id);
  if (!item || item.kind !== 'advice') return { ok: false, reason: 'not_found' };
  const status = verdict === 'approve' ? 'approved' : 'rejected';
  if (!store.decideAdvice(id, status, { by: String(by || 'owner'), at: clockNow() })) return { ok: false, reason: 'not_pending' };
  logger.info({ evt: 'chatInfluence.advice', itemId: id, outcome: status, category: item.category }, 'chat influence: advice decided');
  return { ok: true, id, status, category: item.category, ...(status === 'approved' ? { preset: advice.presetOf(item.category) } : {}) };
}
