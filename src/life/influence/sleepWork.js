// Time & sleep (spec 012 plan §P1.3/§P1.4), pure over injected readers.
//
// Late chats — pulse.startBlock asks beforeSleep() at the very top of a sleep
// block's start: when a chat is "live" (≥ 3 of his messages AND ≥ 3 incoming
// prompt-visible ones in the last 15 min) his sleep is pushed 30 min — an inert
// `chat.perceived {kind:'live'}` pointer with that chat's origin, then
// `sleep.delayed` caused by it (the projector moves the sleep block, plan.sleepAt
// and the current activity's end). The sleep block comes due again at the new
// start, so the check repeats every push, ≤ sleepMaxMinutes (120) a night. Only
// live (a catch-up replay never pushes), never while the Director is paused, and
// a push the owner undid stays undone for that night (exclusion signature).
//
// Chatting at work — content-free: more than workMsgsPerHour of his own sent
// messages in the last hour during a work block → one `work.behind` a day (self
// origin, counts only, no chat named).
//
// Both fail closed: any reader error → no push / no flag.

import { activityClass, WORK_CLASSES } from '../vitals.js';
import { isUndone } from '../pulse.js';

export const PUSH_MIN = 30;
export const LIVE_WINDOW_SEC = 15 * 60;
export const LIVE_MIN_SELF = 3;
export const LIVE_MIN_INCOMING = 3;
export const WORK_WINDOW_SEC = 3600;
export const WORK_PRESSURE = 6;
const CANDIDATES_MAX = 20;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * May his sleep (the plan's sleep `block`, due at `at`) be pushed now? deps: { on(), now(), tickSec, maxMinutes, paused(),
 * selfChatsSince(since) → [{chatJid, n}], incomingSince(chatJid, since) → n,
 * chatOk(chatJid) → bool (not muted, a chat that may nudge him), lastIncoming(chatJid, since)
 * → { msgId, senderJid } | null, originOf(chatJid) → 'group'|'dm'|null, dateOf(at) }.
 * → null | { chatJid, originKind, exchanges, msgId, senderJid, minutes, until, totalMin, date }
 */
export function sleepPush(s, at, block, deps) {
  try {
    if (!deps?.on?.()) return null;
    if (!finite(at) || Math.abs(at - deps.now()) > 2 * deps.tickSec) return null;   // live only
    const plan = s?.plan;
    if (block?.kind !== 'sleep' || !finite(block.start) || !finite(block.end)) return null;
    const date = typeof plan?.date === 'string' ? plan.date : deps.dateOf(at);
    if (isUndone(s, 'sleep.delayed', null, date)) return null;          // the owner undid tonight's push
    const prior = s?.sleep?.delayedFor;
    const total = finite(prior?.totalMin) ? prior.totalMin : 0;
    const max = Math.max(0, Math.floor(deps.maxMinutes));
    if (total + PUSH_MIN > max) return null;
    if (deps.paused()) return null;
    const since = at - LIVE_WINDOW_SEC;
    let best = null;
    for (const c of (deps.selfChatsSince(since) || []).slice(0, CANDIDATES_MAX)) {
      if (!c?.chatJid || !(c.n >= LIVE_MIN_SELF)) continue;
      const originKind = deps.originOf(c.chatJid);
      if (!originKind || !deps.chatOk(c.chatJid)) continue;
      const incoming = deps.incomingSince(c.chatJid, since);
      if (!(incoming >= LIVE_MIN_INCOMING)) continue;
      const exchanges = Math.min(c.n, incoming);
      if (!best || exchanges > best.exchanges || (exchanges === best.exchanges && c.n + incoming > best.score)) {
        best = { chatJid: c.chatJid, originKind, exchanges, score: c.n + incoming };
      }
    }
    if (!best) return null;
    const last = deps.lastIncoming(best.chatJid, since);
    if (!last?.msgId) return null;
    const until = Math.max(at, block.start) + PUSH_MIN * 60;
    if (until > block.end - 3600) return null;                         // never into his last hour of sleep
    return {
      chatJid: best.chatJid, originKind: best.originKind, exchanges: best.exchanges, msgId: last.msgId,
      senderJid: last.senderJid ?? null, minutes: PUSH_MIN, until, totalMin: total + PUSH_MIN, date,
    };
  } catch {
    return null;
  }
}

/**
 * Is a work.behind due now? deps: { on(), countSelfSince(since) → n, threshold, today }.
 * → null | { sent, date }
 */
export function workBehindDue(view, at, deps) {
  try {
    if (!deps?.on?.() || !view?.activity) return null;
    const cls = activityClass(view.activity, { self: { officePlaceId: view.self?.officePlaceId } });
    if (!WORK_CLASSES.has(cls)) return null;
    const date = deps.today;
    if (view.influence?.workBehindDay === date) return null;
    if (isUndone(view, 'work.behind', null, date)) return null;
    const sent = deps.countSelfSince(at - WORK_WINDOW_SEC);
    if (!(sent > deps.threshold)) return null;
    return { sent: Math.floor(sent), date };
  } catch {
    return null;
  }
}
