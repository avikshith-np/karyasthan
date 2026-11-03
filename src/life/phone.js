import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../memory/db.js';
import { isGroupMuted as dashboardIsGroupMuted } from '../dashboard/state.js';
import { isGroupJid, isDmJid } from '../utils/jidUtils.js';
import { now } from './clock.js';
import { rngFor } from './rng.js';
import { appendEvent as logAppend } from './eventLog.js';
import { getWorld } from './world.js';
import { availabilityAt, nextCheckAt, checkDurationSec, AVAILABILITY_RANK } from './availability.js';
import {
  expireOlderThan, pendingChats, listPendingByChat, markDrained, markDropped,
} from './queue.js';

// His phone (spec 009 plan §R9–R11, FR-021/023): when he looks at it, what he
// reads, when he's "online", and the drain of the deferred queue. While life is
// on this module owns read receipts and presence; the live path only calls
// noteUnread() (ignore/react outcomes) and markSeenNow() (now/sneak; then
// settleCatchUp() once a reply that covered the chat's queue was sent).
//
// A phone check: `phone.check.started` → presence available → expire stale
// queue rows (read, not answered) → per chat with pending items, oldest first
// and 3–15 s apart: read its unread keys, drop items whose group is muted
// ('muted'), whose sender left ('left') or whose message is gone ('revoked'),
// then ONE catch-up turn through withChatLock(chat, () => processMessage(…))
// with ctx.catchUp → the rest of the unread chats are read → he stays on the
// phone for the check's 1–4 min → `phone.check.ended {nextCheckAt}` → presence
// unavailable (it stays available while he's free). A check while asleep is
// read only (night check / not yet up): it reads, never replies.
//
// Everything with side effects is injected through createPhone(deps): the
// socket getter, processMessage, the per-chat lock, mute/membership checks, the
// message loader, the event appender (the facade's, so the projection follows),
// timers and sleep. Defaults are the real ones; tests pass fakes and run with
// no live timer. Random outcomes (check length, gap, spacing) are rolled from
// rngFor(String(checkStart), …) and the next check time is written into the
// ended event, so a replay agrees. In-memory unread keys reset on restart;
// queue rows keep their own keys, so deferred messages still get read.

export const UNREAD_PER_CHAT = 50;
export const UNREAD_CHATS = 500;
export const SPACING_MS = Object.freeze([3_000, 15_000]);
export const TRIGGERS_MAX = 3;
const RETRY_NO_SOCKET_SEC = 5 * 60;
const FOLLOW_UP_DELAY_SEC = 3 * 60;
const MAX_TIMER_MS = 2 ** 31 - 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY_JID_RE = /^[A-Za-z0-9._:+-]{1,96}@[a-z0-9.-]{1,30}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The minimal Baileys key readMessages needs, or null if `key` isn't one for `chatJid`. */
export function cleanKey(key, chatJid) {
  if (!isObj(key) || typeof key.id !== 'string' || !KEY_ID_RE.test(key.id)) return null;
  if (typeof key.remoteJid !== 'string' || !KEY_JID_RE.test(key.remoteJid)) return null;
  if (chatJid && key.remoteJid !== chatJid) return null;
  if (key.fromMe === true) return null;              // his own messages need no receipt
  const out = { remoteJid: key.remoteJid, id: key.id, fromMe: false };
  if (typeof key.participant === 'string' && KEY_JID_RE.test(key.participant)) out.participant = key.participant;
  return out;
}

// ── Defaults ──────────────────────────────────────────────────────────────

/**
 * Default membership check: a group sender counts as left only when the group
 * has a member list and they aren't on it (no list → unknown → kept). The
 * pipeline should pass 006's membership check once it lands.
 */
export function defaultIsMember(groupJid, personJid) {
  try {
    const db = getDb();
    const known = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_jid = ?').get(groupJid).n;
    if (!known) return true;
    return !!db.prepare('SELECT 1 FROM group_members WHERE group_jid = ? AND person_jid = ?').get(groupJid, personJid);
  } catch {
    return true;
  }
}

/**
 * Default loader: the stored message (events.js storedMsg shape, metadata
 * included — a drained @-mention must still read as one) by id, or null when
 * it's gone (revoked / never stored), belongs to another chat, was fenced by
 * "forget that" (no_learn) or has expired (disappearing message).
 */
export function defaultLoadMessage(item) {
  const row = getDb().prepare(`
    SELECT id, group_jid, sender_jid, sender_name, content, message_type, quoted_id, quoted_content,
           quoted_participant, is_from_self, timestamp, metadata_json
    FROM messages
    WHERE id = ? AND group_jid = ?
      AND COALESCE(no_learn, 0) = 0 AND (expires_at IS NULL OR expires_at > unixepoch())
  `).get(item.msgId, item.chatJid);
  if (!row) return null;
  let metadata = {};
  try {
    const m = JSON.parse(row.metadata_json || '{}');
    if (isObj(m)) metadata = m;
  } catch { /* unreadable → no metadata */ }
  if (!Array.isArray(metadata.mentionedJids)) metadata.mentionedJids = [];
  return {
    id: row.id,
    groupJid: row.group_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    content: row.content,
    messageType: row.message_type,
    quotedId: row.quoted_id,
    quotedContent: row.quoted_content,
    quotedParticipant: row.quoted_participant,
    isFromSelf: row.is_from_self === 1,
    timestamp: row.timestamp,
    metadata,
  };
}

function defaultSetTimer(fn, ms) {
  const t = setTimeout(fn, Math.min(MAX_TIMER_MS, Math.max(0, ms)));
  t.unref?.();
  return t;
}

// ── Catch-up context ──────────────────────────────────────────────────────

/**
 * ctx.catchUp for one chat's drained items (oldest first): { awayMin, newCount,
 * reason (availability when the oldest was deferred), since, triggerIds (≤ 3
 * msg ids: mentions/DMs first, then the newest), itemIds }. `extraUnread` adds
 * messages he read but hadn't queued (ignored chatter) to the count.
 */
export function buildCatchUp(items, at, { extraUnread = 0 } = {}) {
  const since = Math.min(...items.map(i => i.enqueuedAt));
  const important = items.filter(i => i.isMention || i.isDm).reverse();
  const rest = items.filter(i => !(i.isMention || i.isDm)).reverse();
  return {
    awayMin: Math.max(1, Math.round((at - since) / 60)),
    newCount: items.length + Math.max(0, extraUnread),
    reason: items[0]?.availability ?? null,
    since,
    triggerIds: [...important, ...rest].slice(0, TRIGGERS_MAX).map(i => i.msgId),
    itemIds: items.map(i => i.id),
  };
}

// ── Phone ─────────────────────────────────────────────────────────────────

/**
 * Create his phone. deps (all optional; real defaults):
 *   getSock()                     → the Baileys socket or null (null skips the check, retried in 5 min)
 *   processMessage(sock, msg, ctx) the pipeline; ctx = { isGroup, isDm, chatJid, catchUp, rawMsg: null }
 *   withChatLock(chatJid, fn)     the per-chat lock from events.js (fallback: a local per-chat chain)
 *   isGroupMuted(jid)             dashboard mute state      isMember(groupJid, personJid)
 *   loadMessage(item)             queue item → stored msg | null (revoked)
 *   appendEvent(spec)             the facade's appender (keeps the projection in step); default eventLog
 *   getState()                    the current projection (or view) for availability
 *   world                         world constants (default getWorld())
 *   setTimer(fn, ms) / clearTimer(handle)   default unref'd setTimeout
 *   sleep(ms)                     spacing / staying on the phone (default a cancellable timer)
 *   maxAgeHours                   queue expiry (default config.life.queueMaxAgeHours)
 *   beforeDrainTurn(chatJid, msgIds, at)  012: under the lock, before a catch-up turn (may return a
 *                                 bounded promise: the turn waits for it)
 *   followUps                     012: { due(at) → [f], prepare(f, deps) → {msg, chatJid, isGroup, note,
 *                                 startedAt} | null, finish(f, {chatJid, startedAt}), isDueEvent(ev) }
 */
export function createPhone(deps = {}) {
  const getSock = deps.getSock ?? (() => null);
  const processMessage = deps.processMessage ?? null;
  const isGroupMuted = deps.isGroupMuted ?? dashboardIsGroupMuted;
  const isMember = deps.isMember ?? defaultIsMember;
  const loadMessage = deps.loadMessage ?? defaultLoadMessage;
  const append = deps.appendEvent ?? logAppend;
  const getState = deps.getState ?? (() => null);
  const worldOf = () => deps.world ?? safe(() => getWorld(), null);
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const maxAgeHours = () => deps.maxAgeHours ?? config.life?.queueMaxAgeHours ?? 18;
  // 012 seam: fn(chatJid, msgIds, at) before a catch-up turn (held chat influence).
  const beforeDrainTurn = typeof deps.beforeDrainTurn === 'function' ? deps.beforeDrainTurn : null;
  // 012 seam: invitation follow-ups (one turn each, through the same lock, after the drain).
  const followUps = isObj(deps.followUps) && typeof deps.followUps.due === 'function' ? deps.followUps : null;

  const waits = new Set();
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => {
    const w = { resolve };
    w.handle = setTimer(() => { waits.delete(w); resolve(); }, ms);
    waits.add(w);
  }));

  // Fallback lock when the pipeline's isn't passed: serializes this module's own turns per chat.
  const chains = new Map();
  const withChatLock = deps.withChatLock ?? ((chatJid, fn) => {
    const prev = chains.get(chatJid) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    const tail = run.catch(() => {});
    chains.set(chatJid, tail);
    tail.then(() => { if (chains.get(chatJid) === tail) chains.delete(chatJid); });
    return run;
  });

  const unread = new Map();     // chatJid → Map<msgId, key>
  let presence = null;          // last presence sent: 'available' | 'unavailable' | null
  let presenceSock = null;      // the socket it was sent on (a reconnect resets it)
  let timer = null;
  let next = null;              // { at, reason, readOnly, state, causeId }
  let inCheck = false;
  let running = false;
  let abort = false;
  let lastRank = null;

  const stateNow = () => safe(() => getState(), null);

  function safe(fn, dflt) {
    try { return fn(); } catch { return dflt; }
  }

  // ── Presence + receipts ────────────────────────────────────────────────

  async function setPresence(sock, type) {
    if (!sock) return false;
    // A reconnect hands us a new socket: WhatsApp has no presence for it yet.
    if (sock !== presenceSock) { presenceSock = sock; presence = null; }
    if (presence === type) return false;
    try {
      await sock.sendPresenceUpdate(type);
      presence = type;
      return true;
    } catch (err) {
      logger.debug({ err: err?.message, type }, 'life phone: presence update failed');
      return false;
    }
  }

  async function readKeys(sock, keys) {
    const list = [];
    const seen = new Set();
    for (const k of keys) {
      if (!k || seen.has(`${k.remoteJid}|${k.id}`)) continue;
      seen.add(`${k.remoteJid}|${k.id}`);
      list.push(k);
    }
    if (!list.length || !sock) return 0;
    try {
      await sock.readMessages(list);
      return list.length;
    } catch (err) {
      logger.debug({ err: err?.message, n: list.length }, 'life phone: read receipts failed');
      return 0;
    }
  }

  function takeUnread(chatJid) {
    const m = unread.get(chatJid);
    unread.delete(chatJid);
    return m ? [...m.values()] : [];
  }

  /** Remember a message he hasn't read (ignore/react outcomes); read at the next check. */
  function noteUnread(chatJid, rawKey) {
    const key = cleanKey(rawKey, chatJid);
    if (!key) return false;
    let m = unread.get(chatJid);
    if (m) unread.delete(chatJid);             // re-insert: oldest chat first for eviction
    else m = new Map();
    m.set(key.id, key);
    while (m.size > UNREAD_PER_CHAT) m.delete(m.keys().next().value);
    unread.set(chatJid, m);
    while (unread.size > UNREAD_CHATS) unread.delete(unread.keys().next().value);
    return true;
  }

  /**
   * He's looking at this chat right now (now/sneak): read this message and
   * everything unread in the chat at once. Queued rows for the chat are read
   * too (he opened the chat) but NOT marked drained here: the live turn only
   * sees the new message. → { read, catchUp } — catchUp (buildCatchUp shape, or
   * null) is for the caller to pass as ctx.catchUp to this turn, then
   * settleCatchUp(catchUp) once the reply was sent. Unsettled rows stay pending
   * and the next phone check gives them their one catch-up reply.
   */
  async function markSeenNow(sock, chatJid, rawKey) {
    const keys = takeUnread(chatJid);
    const key = cleanKey(rawKey, chatJid);
    if (key) keys.push(key);
    let pending = [];
    try { pending = listPendingByChat(chatJid); } catch { pending = []; }
    for (const it of pending) if (it.msgKey) keys.push(cleanKey(it.msgKey, chatJid));
    const read = await readKeys(sock ?? safe(getSock, null), keys);
    const others = pending.filter(i => !(key && i.msgId === key.id));
    // live: this turn's own message is not among the queued triggers — the
    // transcript must still mark it (systemPrompt reserves it a '>>>' slot).
    return { read, catchUp: others.length ? { ...buildCatchUp(others, now()), chatJid, live: true } : null };
  }

  /** The live turn that carried `catchUp` replied: its queue rows are answered. → rows marked. */
  function settleCatchUp(catchUp) {
    const ids = Array.isArray(catchUp?.itemIds) ? catchUp.itemIds.filter(Number.isSafeInteger) : [];
    if (!ids.length) return 0;
    return safe(() => markDrained(ids, { at: now() }), 0);
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  function schedule(plan) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    next = plan;
    if (!plan || !running) return plan;
    timer = setTimer(() => {
      timer = null;
      runCheck({ reason: plan.reason, readOnly: plan.readOnly, causeId: plan.causeId ?? null })
        .catch(err => logger.warn({ err: err?.message }, 'life phone: check failed'));
    }, Math.max(0, (plan.at - now()) * 1000));
    return plan;
  }

  function planFrom(state, at, extra = {}) {
    return { ...nextCheckAt(state, at, worldOf()), ...extra };
  }

  /**
   * Arm the scheduler. The first check: the projection's pending nextCheckAt
   * if it is still ahead and sooner, else the cadence from now (a restart with
   * an overdue check looks at the phone per his current availability). Presence
   * follows: available while free, else unavailable.
   */
  /**
   * A check the projection shows open while this process runs none belongs to
   * a process that died mid-check (crash, pm2 restart): close it with
   * `phone.check.ended {reason:'recovered'}`, or he'd read as on the phone
   * until availability's bound passes. The facade calls it at boot; start()
   * too. → the appended event or null.
   */
  function recover() {
    const s0 = stateNow();
    if (inCheck || !Number.isSafeInteger(s0?.phone?.checkStartedAt)) return null;
    const at = Math.max(now(), s0.phone.checkStartedAt);
    const plan0 = planFrom(s0, at);
    return safe(() => append({
      type: 'phone.check.ended', at, actor: 'engine',
      payload: { nextCheckAt: plan0.at, nextReason: plan0.reason, reason: 'recovered', readOnly: false, drained: 0, expired: 0 },
    }), null);
  }

  async function start() {
    running = true;
    abort = false;
    const at = now();
    recover();
    const state = stateNow();
    const fresh = planFrom(state, at);
    const pend = state?.phone?.nextCheckAt;
    const plan = Number.isSafeInteger(pend) && pend > at && pend < fresh.at
      ? { at: pend, reason: 'scheduled', readOnly: false, state: fresh.state }
      : fresh;
    const avail = availabilityAt(state, at, worldOf());
    lastRank = AVAILABILITY_RANK[avail.state] ?? null;
    await setPresence(safe(getSock, null), avail.state === 'free' ? 'available' : 'unavailable');
    return schedule(plan);
  }

  /**
   * A (re)connected socket: WhatsApp holds no presence for it, so send the one
   * his availability calls for now (available while free or on the phone).
   */
  async function resyncPresence() {
    const sock = safe(getSock, null);
    if (!sock || !running) return false;
    const avail = availabilityAt(stateNow(), now(), worldOf());
    return setPresence(sock, inCheck || avail.state === 'free' ? 'available' : 'unavailable');
  }

  /** Disarm: no more timers; a running check stops draining and ends early. */
  function stop() {
    running = false;
    abort = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    for (const w of waits) { clearTimer(w.handle); w.resolve(); }
    waits.clear();
  }

  /**
   * The facade forwards every applied event. sleep.started → unavailable;
   * woke → a check 0–5 min after waking (caused by the woke); availability
   * changes reschedule: a more restrictive state takes the new cadence (a
   * meeting pushes the check to its end), a freer one the sooner of the two.
   */
  async function onEvent(event) {
    if (!event || !running) return null;
    const type = event.type;
    const sock = safe(getSock, null);
    const state = stateNow();
    const at = Number.isSafeInteger(event.at) ? Math.max(event.at, now()) : now();
    if (type === 'sleep.started') {
      lastRank = AVAILABILITY_RANK.asleep;
      if (!inCheck) await setPresence(sock, 'unavailable');
      return inCheck ? next : schedule(planFrom(state, at));
    }
    if (type === 'woke') {
      lastRank = AVAILABILITY_RANK.free;
      if (inCheck) return next;
      const r = rngFor(String(event.at), 'phone.wake');
      return schedule({ at: at + r.int(0, 5) * 60 + r.int(0, 59), reason: 'wake', readOnly: false, state: 'free',
        causeId: Number.isSafeInteger(event.id) ? event.id : null });
    }
    // 012: an invitation he was unsure about just committed (or he changed his mind):
    // look at the phone within a few minutes, so the follow-up lands before it matters.
    if ((type === 'decision.committed' || type === 'decision.reversed' || type === 'decision.expired' || type === 'event.reverted' || type === 'world.rewound') && followUps?.isDueEvent
        && safe(() => followUps.isDueEvent(event), false) === true) {
      if (inCheck) return next;
      const soon = at + FOLLOW_UP_DELAY_SEC;
      return !next || soon < next.at ? schedule({ at: soon, reason: 'follow_up', readOnly: false, state: next?.state ?? null }) : next;
    }
    if (!['activity.started', 'activity.ended', 'availability.changed', 'travel.started', 'travel.arrived',
      'world.reanchored', 'sick.started', 'sick.ended'].includes(type)) return next;
    const avail = availabilityAt(state, at, worldOf());
    const rank = AVAILABILITY_RANK[avail.state] ?? 0;
    const tighter = lastRank !== null && rank > lastRank;
    lastRank = rank;
    if (!inCheck && avail.state !== 'free') await setPresence(sock, 'unavailable');
    if (inCheck) return next;
    const cand = planFrom(state, at);
    return schedule(!next || tighter || cand.at < next.at ? cand : next);
  }

  // ── The check ──────────────────────────────────────────────────────────

  // One chat of the drain. Returns { turns, firstTurn } — `firstTurn` stays
  // true until a catch-up turn has run, so the 3–15 s spacing only falls
  // between turns.
  async function drainChat(sock, row, at, r, firstTurn) {
    const chatJid = row.chatJid;
    const maxId = row.maxId;
    const items = listPendingByChat(chatJid).filter(i => i.id <= maxId);
    if (!items.length) return { turns: 0, firstTurn };
    const extra = takeUnread(chatJid);
    const extraUnread = extra.filter(k => !items.some(i => i.msgId === k.id)).length;
    const keys = [...extra, ...items.map(i => cleanKey(i.msgKey, chatJid))];

    const isGroup = isGroupJid(chatJid);
    if (isGroup && safe(() => isGroupMuted(chatJid), false)) {
      await readKeys(sock, keys);                 // muted groups are still read (observed, as today)
      markDropped({ chatJid, maxId }, 'muted', { at });
      return { turns: 0, firstTurn };
    }
    const keep = [];
    const left = [];
    const revoked = [];
    for (const it of items) {
      if (isGroup && it.senderJid && !safe(() => isMember(chatJid, it.senderJid), true)) { left.push(it.id); continue; }
      const msg = safe(() => loadMessage(it), null);
      if (!msg) { revoked.push(it.id); continue; }
      keep.push({ it, msg });
    }
    if (left.length) markDropped(left, 'left', { at });
    if (revoked.length) markDropped(revoked, 'revoked', { at });
    if (!keep.length || typeof processMessage !== 'function') {
      await readKeys(sock, keys);
      if (keep.length) logger.warn({ chatJid }, 'life phone: no processMessage, items left pending');
      return { turns: 0, firstTurn };
    }

    if (!firstTurn) await sleep(r.int(...SPACING_MS));
    if (abort) {
      await readKeys(sock, keys);
      return { turns: 0, firstTurn };
    }
    await readKeys(sock, keys);                   // he opens the chat: blue ticks, then the reply
    let survivors = keep;
    try {
      const ran = await withChatLock(chatJid, (lockCtx) => {
        // Re-read under the lock (synchronously — the lock's turnSignal is only
        // handed over while this callback runs): a live turn that held the lock
        // while we slept may already have answered these rows (markSeenNow →
        // settleCatchUp). Only what is still pending gets this catch-up turn.
        let stillPending;
        try {
          const ids = new Set(listPendingByChat(chatJid).filter(i => i.id <= maxId).map(i => i.id));
          stillPending = keep.filter(k => ids.has(k.it.id));
        } catch {
          stillPending = keep;
        }
        survivors = stillPending;
        if (!stillPending.length) return false;
        // 012: what he perceived in these messages while away lands now that he reads them
        // (an invitation among them may hand back a bounded wait for its decision to open).
        let held = null;
        if (beforeDrainTurn) {
          try { held = beforeDrainTurn(chatJid, stillPending.map(k => k.it.msgId), now()); } catch { held = null; /* fails closed: no influence */ }
        }
        const catchUp = buildCatchUp(stillPending.map(k => k.it), now(), { extraUnread });
        const last = stillPending[stillPending.length - 1].msg;
        const ctx = { isGroup, isDm: !isGroup && isDmJid(chatJid), chatJid, catchUp, rawMsg: null };
        if (lockCtx?.turnSignal) ctx.turnSignal = lockCtx.turnSignal;
        const turn = () => Promise.resolve(processMessage(sock, last, ctx)).then(() => {
          // Still under the lock: a live turn queued behind this one must see them answered.
          markDrained(stillPending.map(k => k.it.id), { at: now() });
          return true;
        });
        return held && typeof held.then === 'function' ? Promise.resolve(held).catch(() => {}).then(turn) : turn();
      });
      if (ran === false) {
        logger.info({ chatJid }, 'life phone: queue already answered by a live turn — no catch-up turn');
        return { turns: 0, firstTurn };
      }
      return { turns: 1, firstTurn: false };
    } catch (err) {
      logger.warn({ err: err?.message, chatJid }, 'life phone: catch-up turn failed, items dropped');
      markDropped(survivors.map(k => k.it.id), 'error', { at: now() });
      return { turns: 0, firstTurn: false };
    }
  }

  // 012: invitation follow-ups due now — each ONE turn through the chat lock with
  // the catch-up path (gate/mute/warmup/caps/DRY_RUN as any turn). The attempt is
  // counted under the lock before the turn (prepare), and settled after it
  // whatever the turn did (finish): a skip, a cap or a [SKIP] still spends it.
  async function runFollowUps(sock) {
    if (!followUps || typeof processMessage !== 'function') return 0;
    let n = 0;
    for (const f of safe(() => followUps.due(now()), []) || []) {
      if (abort) break;
      let prep = null;
      let ctx = null;
      try {
        await withChatLock(f.chatJid ?? f.chatKey, (lockCtx) => {
          prep = safe(() => followUps.prepare(f, { isGroupMuted, isMember, loadMessage }), null);
          if (!prep) return false;
          ctx = {
            isGroup: prep.isGroup, isDm: !prep.isGroup && isDmJid(prep.chatJid), chatJid: prep.chatJid, rawMsg: null,
            catchUp: { followUp: true, ...(prep.kind ? { followUpKind: prep.kind } : {}), triggerIds: [prep.msg.id], itemIds: [] },
            followUp: { decisionId: f.decisionId, outcome: f.outcome, ...(typeof prep.stillApplies === 'function' ? { stillApplies: prep.stillApplies } : {}) },
            promptNotes: prep.note ? [prep.note] : [],
          };
          if (lockCtx?.turnSignal) ctx.turnSignal = lockCtx.turnSignal;
          return Promise.resolve(processMessage(sock, prep.msg, ctx));
        });
        if (prep) n += 1;
      } catch (err) {
        logger.warn({ err: err?.message, decisionId: f.decisionId }, 'life phone: follow-up turn failed');
      } finally {
        if (prep) safe(() => followUps.finish(f, { chatJid: prep.chatJid, startedAt: prep.startedAt, blocked: ctx?.followUp?.blocked ?? null }), null);
      }
    }
    return n;
  }

  /**
   * Look at the phone now. opts: { reason, readOnly, by ('engine'|'owner'),
   * causeId, force }. Read only when asked or while he's asleep — unless
   * `force` (the facade's last drain when life is switched off: nobody is left
   * unanswered, even at night). `linger: false` skips staying on the phone
   * for the rest of the check (the engine-less leftover drain). Concurrent calls
   * while a check runs are refused ({ skipped: 'in_check' }); a missing socket
   * skips and retries in 5 min. → { drained, read, expired, readOnly, startedEventId, next }.
   */
  async function runCheck({ reason = 'scheduled', readOnly = false, by = 'engine', causeId = null, force = false, linger = true } = {}) {
    if (inCheck) return { skipped: 'in_check' };
    const sock = safe(getSock, null);
    if (!sock) {
      logger.info({ reason }, 'life phone: no socket, check skipped');
      if (running) schedule({ at: now() + RETRY_NO_SOCKET_SEC, reason: 'retry', readOnly: false });
      return { skipped: 'no_socket' };
    }
    inCheck = true;
    abort = false;
    const actor = by && by !== 'engine' ? 'owner' : 'engine';   // the dashboard passes the owner's username
    const at = now();
    const r = rngFor(String(at), 'phone.check');
    const until = at + checkDurationSec(r);
    const state0 = stateNow();
    const avail = availabilityAt(state0, at, worldOf());
    const ro = readOnly === true || (avail.state === 'asleep' && force !== true);
    let started = null;
    let drained = 0;
    let read = 0;
    let expired = [];
    try {
      started = safe(() => append({
        type: 'phone.check.started', at, actor,
        causeId: actor === 'engine' && Number.isSafeInteger(causeId) ? causeId : null,
        payload: { until, reason: String(reason).slice(0, 32), readOnly: ro },
      }), null);
      await setPresence(sock, 'available');

      expired = safe(() => expireOlderThan(maxAgeHours(), { at }), []);
      if (expired.length) read += await readKeys(sock, expired.map(i => cleanKey(i.msgKey, i.chatJid)));

      if (!ro) {
        let firstTurn = true;
        for (const row of safe(() => pendingChats(), [])) {
          if (abort) break;
          const res = await drainChat(sock, row, at, r, firstTurn);
          drained += res.turns;
          firstTurn = res.firstTurn;
        }
        if (followUps && !abort) await runFollowUps(sock);
      } else {
        // Read only: queued chats are read (blue ticks), answered at a later check.
        for (const row of safe(() => pendingChats(), [])) {
          const items = safe(() => listPendingByChat(row.chatJid), []);
          read += await readKeys(sock, items.map(i => cleanKey(i.msgKey, row.chatJid)));
        }
      }
      for (const chatJid of [...unread.keys()]) read += await readKeys(sock, takeUnread(chatJid));

      const remain = until - now();
      if (linger !== false && remain > 0 && !abort) await sleep(remain * 1000);
    } catch (err) {
      logger.warn({ err: err?.message }, 'life phone: check aborted');
    } finally {
      const endAt = Math.max(now(), at);
      const state1 = stateNow();
      const plan = planFrom(state1, endAt);
      safe(() => append({
        type: 'phone.check.ended', at: endAt, actor,
        causeId: started?.id ?? null,
        payload: { nextCheckAt: plan.at, nextReason: plan.reason, readOnly: ro, drained, expired: expired.length },
      }), null);
      const after = availabilityAt(state1, endAt, worldOf());
      if (after.state !== 'free') await setPresence(sock, 'unavailable');
      lastRank = AVAILABILITY_RANK[after.state] ?? lastRank;
      inCheck = false;
      schedule(plan);
    }
    return { drained, read, expired: expired.length, readOnly: ro, startedEventId: started?.id ?? null, next };
  }

  /** Owner "check phone now" (dashboard): a full check with owner-actor events. */
  async function checkNow({ by = 'owner' } = {}) {
    const res = await runCheck({ reason: 'owner', by });
    return { drained: res.drained ?? 0, ...res };
  }

  /** Expire stale queue rows between checks (the pulse); their keys are read at the next check. */
  function expireStale(at = now()) {
    const rows = safe(() => expireOlderThan(maxAgeHours(), { at }), []);
    for (const it of rows) if (it.msgKey) noteUnread(it.chatJid, it.msgKey);
    return rows;
  }

  return {
    start,
    stop,
    recover,
    resyncPresence,
    onEvent,
    runCheck,
    checkNow,
    expireStale,
    noteUnread,
    markSeenNow,
    settleCatchUp,
    unreadCount: (chatJid) => (chatJid ? unread.get(chatJid)?.size ?? 0 : [...unread.values()].reduce((s, m) => s + m.size, 0)),
    isInCheck: () => inCheck,
    getNext: () => (next ? { ...next } : null),
    getPresence: () => presence,
  };
}
