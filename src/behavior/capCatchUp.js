// Cap catch-up: ONE reply in a group after an hourly cap (checkHourlyCaps,
// rateLimiter.js) blocked a reply he would otherwise have sent — the way a person
// who held back for a while picks the chat up again.
//
// decide() (src/brain/decisionEngine.js) still scores a capped group message; when
// the outcome would have been a text reply it calls noteCappedReply(), which keeps
// one pending entry per group: the last ≤ 3 trigger message ids (mentions kept
// first), whether any was a mention (the per-group cap exemption) and the first /
// last skipped time. A light timer (60 s, unref'd) walks the pending groups oldest
// first and fires a group once checkHourlyCaps allows it again; the passes are
// sequential, so the global slot one fire uses is seen by the next group's check.
//
// The store is in-memory, like the burst cooldowns: a restart forgets pending
// catch-ups, and an entry is dropped after CAP_CATCHUP_MAX_AGE_MINUTES anyway.
//
// A fire is one turn through the per-chat lock (events.js withChatLock) as
// processMessage(sock, lastTrigger, { catchUp: { cap: true, triggerIds, … } }):
// no learning (it ran on arrival), no second roll in decide() (the roll already
// passed once; rate limits and the caps are re-checked), ">>>" on the triggers and
// a "you held back" note in the prompt; the model may still answer [SKIP].
// Before it: mute, warmup (text allowed), the rate limiter/burst cooldown, and with
// the `life` skill on, his availability (free or in a phone check — the same rule
// as the mind's proactive openers); while he isn't available the entry stays
// pending (it is not handed to life's queue, whose drain re-rolls the reply and
// says "you were away"). DRY_RUN is honoured by the send path (actions.js logs).
// Inside the lock it re-reads: the entry must still be there, he must not have
// sent anything in the group since the first skipped trigger (a live turn caught
// up already), and the triggers must still be prompt-visible (not fenced by
// "forget that", not expired, not revoked). The entry is removed before the turn
// runs, so a group gets exactly one attempt whatever the model says.
//
// Groups only (DMs are never capped). The mind's proactive openers call
// checkHourlyCaps directly, never decide(), so they never create catch-ups, and
// catch-up turns (life's or this one) never queue another.

import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { checkHourlyCaps, checkRateLimit, inBurst } from './rateLimiter.js';
import { checkWarmup } from './warmup.js';
import { countSelfMessagesInWindow, getPromptVisibleByIds } from '../memory/messageStore.js';

export const TRIGGERS_MAX = 3;
export const PASS_INTERVAL_MS = 60_000;

const pending = new Map(); // groupJid → { groupJid, firstAt, lastAt, isMention, triggers: [{ id, isMention, at }] }

let deps = {};
let timer = null;
let inPass = false;

const nowSec = () => (typeof deps.now === 'function' ? deps.now() : Math.floor(Date.now() / 1000));
const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

export function capCatchUpEnabled() {
  return config.capCatchUp?.enabled !== false;
}

function maxAgeSec() {
  const n = Number(config.capCatchUp?.maxAgeMinutes);
  return (Number.isFinite(n) && n > 0 ? n : 120) * 60;
}

/**
 * decide() on the capped path: this group message would have got a text reply.
 * Merges it into the group's entry. → true when it is pending.
 */
export function noteCappedReply(msg, { isMention = false } = {}) {
  const groupJid = msg?.groupJid;
  if (!capCatchUpEnabled() || !isGroupJid(groupJid) || msg.isFromSelf || typeof msg.id !== 'string' || !msg.id) return false;
  const at = nowSec();
  const entry = pending.get(groupJid) || { groupJid, firstAt: at, lastAt: at, isMention: false, triggers: [] };
  if (!entry.triggers.some(t => t.id === msg.id)) entry.triggers.push({ id: msg.id, isMention: !!isMention, at });
  // Keep ≤ 3: mentions first (newest), then the newest of the rest; shown oldest first.
  const order = (t) => entry.triggers.indexOf(t);
  const mentions = entry.triggers.filter(t => t.isMention).reverse();
  const rest = entry.triggers.filter(t => !t.isMention).reverse();
  entry.triggers = [...mentions, ...rest].slice(0, TRIGGERS_MAX).sort((a, b) => order(a) - order(b));
  entry.isMention = entry.isMention || !!isMention;
  entry.lastAt = at;
  pending.set(groupJid, entry);
  logger.debug({ group: groupJid, msgId: msg.id, triggers: entry.triggers.length, isMention: entry.isMention }, 'cap catch-up pending');
  return true;
}

/** Pending entries, oldest first (copies; for tests and diagnostics). */
export function listPendingCatchUps() {
  return [...pending.values()]
    .sort((a, b) => a.firstAt - b.firstAt)
    .map(e => ({ ...e, triggers: e.triggers.map(t => ({ ...t })) }));
}

function drop(groupJid, reason) {
  if (!pending.delete(groupJid)) return;
  logger.info({ evt: 'cap_catchup', group: groupJid, outcome: 'dropped', reason }, `Cap catch-up dropped — ${reason}`);
}

// With the `life` skill on, he answers only when he'd actually be on his phone.
// Any error → not available (the entry waits, and expires if it has to).
function lifeAvailable() {
  const life = deps.life;
  if (!life || typeof life.isLifeOn !== 'function') return true;
  try {
    if (life.isLifeOn() !== true) return true;
    const a = typeof life.availabilityNow === 'function' ? life.availabilityNow() : null;
    const phone = typeof life.inPhoneCheckNow === 'function' ? life.inPhoneCheckNow() === true : false;
    return a === 'free' || phone;
  } catch {
    return false;
  }
}

/** Why this entry can't fire right now, or null. Sets `drop` on reasons that end it. */
function blockedBy(entry, at) {
  const g = entry.groupJid;
  if (at - entry.firstAt > maxAgeSec()) return { drop: true, reason: 'too old' };
  if (typeof deps.isGroupMuted === 'function' && deps.isGroupMuted(g)) return { drop: true, reason: 'group muted' };
  if (countSelfMessagesInWindow(g, entry.firstAt) > 0) return { drop: true, reason: 'already replied since' };
  if (!checkHourlyCaps(g, { isMention: entry.isMention }).allowed) return { reason: 'capped' };
  if (!checkRateLimit(g).allowed) return { reason: 'cooldown' };
  if (inBurst(g)) return { reason: 'burst' };   // no cooldown from merely checking
  const warm = checkWarmup('text');
  if (!warm?.allowed || warm.responseType === 'reaction') return { reason: 'warmup' };
  if (!lifeAvailable()) return { reason: 'not on his phone' };
  return null;
}

function toMsg(row) {
  let metadata = {};
  try {
    const m = JSON.parse(row.metadata_json || '{}');
    if (m && typeof m === 'object' && !Array.isArray(m)) metadata = m;
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

function heldBackNote(minutes) {
  const span = minutes < 60 ? `~${minutes} min` : `~${Math.round(minutes / 30) / 2} h`;
  return `You held back from this chat for ${span} rather than jump in, and you're picking it up now — no need to explain or apologise for the gap.`;
}

/** One group's fire. → 'fired' | 'dropped' */
async function fire(entry, sock) {
  const g = entry.groupJid;
  const ran = await deps.withChatLock(g, (lockCtx) => {
    // Re-read under the lock: a live turn that held the chat may have replied.
    const cur = pending.get(g);
    if (!cur) return 'gone';
    if (countSelfMessagesInWindow(g, cur.firstAt) > 0) { drop(g, 'already replied since'); return 'dropped'; }
    if (typeof deps.isGroupMuted === 'function' && deps.isGroupMuted(g)) { drop(g, 'group muted'); return 'dropped'; }
    const rows = getPromptVisibleByIds(g, cur.triggers.map(t => t.id));
    if (!rows.length) { drop(g, 'triggers no longer visible'); return 'dropped'; }
    pending.delete(g);
    const at = nowSec();
    const minutes = Math.max(1, Math.round((at - cur.firstAt) / 60));
    const ids = new Set(rows.map(r => r.id));
    const ctx = {
      isGroup: true,
      isDm: false,
      chatJid: g,
      rawMsg: null,
      botJid: sock?.user?.id,
      botLid: sock?.user?.lid,
      // itemIds [] → life's settleCatchUp has nothing to settle; no awayMin/newCount →
      // life's "you were away" note stays empty (the note below says it instead).
      catchUp: { cap: true, since: cur.firstAt, triggerIds: cur.triggers.map(t => t.id).filter(id => ids.has(id)), itemIds: [] },
      promptNotes: [heldBackNote(minutes)],
    };
    if (lockCtx?.turnSignal) ctx.turnSignal = lockCtx.turnSignal;
    logger.info({ evt: 'cap_catchup', group: g, outcome: 'fired', triggers: ctx.catchUp.triggerIds.length, heldMin: minutes },
      'Cap catch-up — the cap freed, catching up once');
    return Promise.resolve(deps.processMessage(sock, toMsg(rows[rows.length - 1]), ctx)).then(() => 'fired');
  });
  return ran === 'fired' ? 'fired' : 'dropped';
}

/**
 * One pass over the pending groups, oldest first, one fire at a time (each re-checks
 * the caps after the previous fire's send). → { fired, dropped, kept }.
 */
export async function runCapCatchUpPass() {
  const out = { fired: 0, dropped: 0, kept: 0 };
  if (inPass) return out;
  inPass = true;
  try {
    if (!capCatchUpEnabled()) {
      for (const g of [...pending.keys()]) { drop(g, 'disabled'); out.dropped++; }
      return out;
    }
    const sock = typeof deps.getSock === 'function' ? deps.getSock() : null;
    for (const entry of listPendingCatchUps()) {
      const g = entry.groupJid;
      let why;
      try {
        why = blockedBy(entry, nowSec());
      } catch (err) {
        logger.warn({ err: err?.message, group: g }, 'cap catch-up check failed — kept pending');
        out.kept++;
        continue;
      }
      if (why?.drop) { drop(g, why.reason); out.dropped++; continue; }
      // No socket, or one mid-reconnect without its identity (mentions need botJid): wait.
      if (why || !sock?.user?.id || typeof deps.processMessage !== 'function' || typeof deps.withChatLock !== 'function') {
        out.kept++;
        continue;
      }
      try {
        const res = await fire(entry, sock);
        out[res]++;
      } catch (err) {
        pending.delete(g);
        logger.warn({ err: err?.message, group: g }, 'cap catch-up turn failed — dropped');
        out.dropped++;
      }
    }
    return out;
  } finally {
    inPass = false;
  }
}

/**
 * Arm the timer. deps: { getSock, processMessage(sock, msg, ctx), withChatLock(chatJid, fn),
 * isGroupMuted(jid), life (the facade: isLifeOn, availabilityNow, inPhoneCheckNow),
 * now() (unix s, tests), intervalMs }. Calling it again replaces deps and the timer.
 */
export function startCapCatchUp(d = {}) {
  deps = { ...d };
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runCapCatchUpPass().catch(err => logger.warn({ err: err?.message }, 'cap catch-up pass failed'));
  }, d.intervalMs ?? PASS_INTERVAL_MS);
  timer.unref?.();
}

export function stopCapCatchUp() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests: forget every pending entry and the injected deps. */
export function resetCapCatchUpForTest() {
  stopCapCatchUp();
  pending.clear();
  deps = {};
  inPass = false;
}
