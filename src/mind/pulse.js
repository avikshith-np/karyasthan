// The pulse (spec 008, research R2, contracts/proactive.md "Back-off bookkeeping").
// Code only, once per life tick (or fallback timer pass), run by the cadence's serial
// queue. It makes NO model call except the opt-out check (dontText.checkCandidates →
// Jev, only on a prefilter hit). It keeps running while paused (counters and opt-out
// detection are protective) and does nothing with the mind skill off.
//
// pulse(tickInfo) → { flags, dueJobs }
//   1. never-seeded cursors → seed them to MAX (history is never analysed in bulk) and stop;
//   2. scan new messages by cursor (mindReads.scanSince, the batch-learning ELIGIBLE
//      filter, chat key = chatKeyOf) → mind_chat_activity counters per chat and LOCAL
//      day of the message: msgs, human msgs, distinct senders, bot mentions (the row's
//      mentionsBot, from src/utils/mentions.js), open questions (a human question to the
//      bot — any DM question, or a group question that mentions the bot — not yet
//      followed by a bot line in that chat), bot msgs, last human / bot times;
//   3. back-off bookkeeping: a human line after the newest sent|dry_run|send_failed|
//      would_send row of that chat (DM: from that person) sets its replied_at;
//   4. the opt-out prefilter on every human line, DMs and groups → checkCandidates, plus
//      the not-yet-expired disappearing human lines (rows.ephemeral: regex only, never
//      counted, never sent to Jev — such a hit is recorded as detected, fail closed);
//   5. life anchors since mind_state.last_event_id (+ the tick's own events);
//   6. expiries: self-state elements, nudges, queued drafts past their TTL, `drafting`
//      rows older than 15 min (stale_draft); daily retention;
//   7. degraded recovery: knobs reload + store self-check → cancel pending drafts made
//      before the failure → clear degraded;
//   8. dueJobs: what the pulse alone can decide — 'dispatch' when a queued draft is due.
//      Glance / think / sleep due-ness (awake rule, caps, gaps) is cadence.due()'s job;
//      `flags` gives it the inputs (activity, anchors, mentions).
// A `pulse` run row is written only when the tick flagged something (a detection,
// anchors, or a recovery). Logs carry counts and ids only.

import * as store from './store.js';
import * as hooks from './hooks.js';
import * as dontText from './dontText.js';
import { now as clockNow, dayKey } from './clock.js';
import { resolvePerson, bareJid, isSelfJid } from '../memory/identity.js';
import { isBotAddressedInText } from '../utils/mentions.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export const SCAN_LIMIT = 2000;
export const STALE_DRAFTING_SEC = 15 * 60;
// Life events that make a think worth having (research R4).
const CHAT_ORIGIN_KINDS = new Set(['group', 'dm', 'call', 'ig']);
export const ANCHOR_TYPES = new Set(['sick.started', 'sick.ended', 'work.crunch', 'work.late', 'money.salary', 'birthday',
  'decision.committed', 'decision.reversed', 'embargo.ended', 'call.answered']);

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  scanSince: async (rowid, limit) => (await import('../memory/mindReads.js')).scanSince(rowid, limit),
  life: async () => import('../life/index.js'),
  // Neighbours owned by other lanes, loaded lazily so the pulse works before they land.
  knobsReload: async () => {
    const k = await import('./knobs.js');
    if (typeof k.reload !== 'function') throw new Error('knobs.reload missing');
    return k.reload();
  },
  expireNudges: async (t) => {
    let l = null;
    try { l = await import('./levers.js'); } catch { return 0; }   // no levers → no nudges to expire
    return typeof l.expireNudges === 'function' ? l.expireNudges(t) : 0;
  },
  expireSelfState: async (t) => {
    let s = null;
    try { s = await import('./selfState.js'); } catch { s = null; }
    return s && typeof s.expire === 'function' ? s.expire(t) : store.expireElements(t);
  },
  checkCandidates: (list) => dontText.checkCandidates(list),
  prefilter: (text) => dontText.prefilter(text),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: replace any of the deps above. null resets (and forgets the per-process sender sets). */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  if (!d) { senderSets.clear(); lastRetentionDay = null; }
}

// Distinct senders per chat-day: the counter is additive, so remember who was counted
// (in memory; after a restart a sender may be counted once more that day).
const senderSets = new Map();   // `${chat}|${day}` → Set(person)
let lastRetentionDay = null;

const QUESTION_RE = /\?/;

function personOf(senderJid) {
  if (typeof senderJid !== 'string' || !senderJid) return null;
  return resolvePerson(senderJid) || bareJid(senderJid);
}

function storedOpenQuestions(chatJid, day) {
  const row = store.activityFor(day).find(r => r.chatJid === chatJid && r.dayKey === day);
  return row ? Number(row.openQuestions) || 0 : 0;
}

/** Fold one scan batch into per-chat-day deltas + side effects. Pure over `rows` except replied_at writes. */
function foldScan(rows, flags) {
  const agg = new Map();          // `${chat}|${day}` → deltas
  const lastBot = new Map();      // chat → last bot line text (for the opt-out check's context)
  const repliedChecked = new Set();
  const candidates = [];
  const get = (chat, day) => {
    const k = `${chat}|${day}`;
    if (!agg.has(k)) {
      agg.set(k, { chat, day, msgs: 0, humanMsgs: 0, senders: 0, botMentions: 0, openQuestions: 0, botMsgs: 0,
        lastHumanAt: null, lastBotAt: null, reset: false });
    }
    return agg.get(k);
  };
  for (const r of rows) {
    const chat = typeof r.chatJid === 'string' ? r.chatJid : null;
    if (!chat) continue;
    const ts = Math.floor(Number(r.ts)) || 0;
    const day = dayKey(ts);
    const a = get(chat, day);
    const isGroup = r.isGroup === true || chat.endsWith('@g.us');
    a.msgs++;
    if (r.isFromSelf || isSelfJid(r.senderJid)) {
      a.botMsgs++;
      a.lastBotAt = Math.max(a.lastBotAt ?? 0, ts);
      a.reset = true;             // a bot line answers what was open in this chat today
      a.openQuestions = 0;
      if (typeof r.text === 'string') lastBot.set(chat, r.text);
      continue;
    }
    a.humanMsgs++;
    a.lastHumanAt = Math.max(a.lastHumanAt ?? 0, ts);
    const person = personOf(r.senderJid);
    if (person) {
      const sk = `${chat}|${day}`;
      if (!senderSets.has(sk)) senderSets.set(sk, new Set());
      const set = senderSets.get(sk);
      if (!set.has(person)) { set.add(person); a.senders++; }
    }
    const text = typeof r.text === 'string' ? r.text : '';
    const mentioned = r.mentionsBot === true || (isGroup && isBotAddressedInText(text));
    if (mentioned) { a.botMentions++; flags.botMentions++; }
    if (QUESTION_RE.test(text) && (!isGroup || mentioned)) { a.openQuestions++; }

    // Back-off bookkeeping: the first human line per chat in this batch is enough.
    if (!repliedChecked.has(chat)) {
      const sent = store.lastSentTo([chat]);
      if (!sent || sent.repliedAt != null) {
        repliedChecked.add(chat);
      } else {
        const since = sent.sentAt ?? sent.createdAt ?? 0;
        const fromTarget = isGroup || person === chat || (sent.personJid && person === sent.personJid);
        if (ts > since && fromTarget) {
          store.updateDraft(sent.id, { repliedAt: ts });
          flags.repliedMarked++;
          repliedChecked.add(chat);
        }
      }
    }

    if (text && deps.prefilter(text)) {
      flags.optOutHits++;
      candidates.push({ personJid: person, senderJid: r.senderJid, msgId: r.id ?? null, ts, text,
        prevBotLine: lastBot.get(chat) ?? null, chatJid: chat });
    }
  }
  return { agg: [...agg.values()], candidates };
}

/**
 * One pulse pass. tickInfo: the life tick's info ({ at, events, crossings, … }) or {}.
 * → { flags, dueJobs }. Never throws (a failure is logged with a code and returned as
 * flags.error).
 */
export async function pulse(tickInfo = {}) {
  const t = Math.floor(deps.now());
  const flags = {
    at: t, scanned: 0, newMessages: 0, humanMessages: 0, chats: [], botMentions: 0, repliedMarked: 0,
    optOutHits: 0, detected: 0, anchors: [], expired: {}, retention: false, recovered: false,
    degraded: hooks.isDegraded(), seeded: false, error: null,
  };
  const dueJobs = [];
  if (!deps.isMindOn()) { flags.skipped = 'disabled'; return { flags, dueJobs }; }
  // Plan 020 B: a revert or a rewind takes back what it evidenced in his interests and opinions, also while paused.
  try { await (await import('./stance.js')).sweep(); } catch (err) { deps.logger?.warn?.({ evt: 'issue', code: err?.code ?? 'error' }, 'mind: stance sweep failed'); }
  try {
    // 1. Seed once: the first pass never reads history in bulk.
    const st = store.getState();
    if (st.updatedAt == null) {
      store.seedCursorsToMax();
      flags.seeded = true;
      return { flags, dueJobs };
    }

    // 2–4. Scan.
    const rows = (await deps.scanSince(st.lastRowid, SCAN_LIMIT)) || [];
    flags.scanned = rows.length;
    // mindReads reports the highest rowid it read (rows of key-less chats are left out
    // of the array) so the cursor moves past them; never backwards.
    let maxRowid = st.lastRowid;
    if (Number.isFinite(Number(rows.lastRowid))) maxRowid = Math.max(maxRowid, Number(rows.lastRowid));
    for (const r of rows) if (Number(r.rowid) > maxRowid) maxRowid = Number(r.rowid);
    const { agg, candidates } = foldScan(rows, flags);
    // Disappearing lines not yet expired: the opt-out regex only (never counted or learned;
    // dontText fails closed on them without asking a model).
    for (const r of Array.isArray(rows.ephemeral) ? rows.ephemeral : []) {
      const text = typeof r?.text === 'string' ? r.text : '';
      if (!text || !deps.prefilter(text)) continue;
      flags.optOutHits++;
      candidates.push({ personJid: personOf(r.senderJid), senderJid: r.senderJid, msgId: r.id ?? null,
        ts: Math.floor(Number(r.ts)) || 0, text, prevBotLine: null, chatJid: r.chatJid ?? null, ephemeral: true });
    }
    const chats = new Set();
    for (const a of agg) {
      chats.add(a.chat);
      flags.newMessages += a.msgs;
      flags.humanMessages += a.humanMsgs;
      const open = a.reset ? a.openQuestions - storedOpenQuestions(a.chat, a.day) : a.openQuestions;
      store.bumpActivity(a.chat, a.day, {
        msgs: a.msgs, humanMsgs: a.humanMsgs, senders: a.senders, botMentions: a.botMentions,
        openQuestions: open, botMsgs: a.botMsgs, lastHumanAt: a.lastHumanAt, lastBotAt: a.lastBotAt,
      });
    }
    flags.chats = [...chats];
    store.patchState({ lastRowid: maxRowid, lastTickAt: t });

    if (candidates.length) {
      const res = (await deps.checkCandidates(candidates)) || [];
      flags.detected = res.filter(x => x?.action === 'detected').length;
    }

    // 5. Anchors (life event cursor + this tick's events).
    flags.anchors = await collectAnchors(st.lastEventId, tickInfo);

    // 6. Expiries + retention.
    flags.expired.elements = Number(await deps.expireSelfState(t)) || 0;
    try { flags.expired.nudges = Number(await deps.expireNudges(t)) || 0; } catch { flags.expired.nudges = 0; }
    const ttl = Math.max(1, Number(config.mind?.proactiveTtlHours) || 6) * 3600;
    flags.expired.queued = store.updateDraftsWhere({ statuses: ['queued'], createdBefore: t - ttl }, { status: 'expired' });
    flags.expired.staleDrafting = store.dropStaleDrafting(t - STALE_DRAFTING_SEC);
    const today = dayKey(t);
    if (lastRetentionDay !== today) {
      store.retention(t);
      lastRetentionDay = today;
      flags.retention = true;
    }

    // 7. Degraded recovery.
    if (hooks.isDegraded()) {
      const info = hooks.degradedInfo();
      try {
        await deps.knobsReload();
        store.selfCheck();
        store.updateDraftsWhere({ statuses: store.DRAFT_PENDING, createdBefore: (info?.at ?? t) + 1 },
          { status: 'dropped', dropReason: 'content_changed', intent: null, voicedText: null, altText: null });
        hooks.clearDegraded();
        flags.recovered = true;
      } catch (err) {
        logger.warn({ evt: 'issue', where: 'mind.pulse.recover', code: String(err?.code || err?.name || 'error').slice(0, 60) },
          'mind: still degraded');
      }
    }
    flags.degraded = hooks.isDegraded();

    // 8. What the pulse can tell is due.
    if (!flags.degraded && store.dueQueued(t).length) dueJobs.push('dispatch');

    if (flags.detected || flags.anchors.length || flags.recovered) {
      const id = store.insertRun({ kind: 'pulse', trigger: 'tick', startedAt: t,
        input: { scanned: flags.scanned, chats: flags.chats.length, optOutHits: flags.optOutHits } });
      store.finishRun(id, { status: 'ok', finishedAt: t,
        output: { detected: flags.detected, anchors: flags.anchors.map(a => a.type), recovered: flags.recovered } });
    }
  } catch (err) {
    flags.error = String(err?.code || err?.name || 'error').slice(0, 60);
    logger.warn({ evt: 'issue', where: 'mind.pulse', code: flags.error }, 'mind: pulse failed');
  }
  return { flags, dueJobs };
}

async function collectAnchors(lastEventId, tickInfo) {
  const byId = new Map();
  let maxId = Number(lastEventId) || 0;
  const add = (e) => {
    if (!e || typeof e !== 'object') return;
    const id = Number(e.id);
    if (Number.isFinite(id) && id > maxId) maxId = id;
    if (e.type === 'decision.committed' && e.payload?.by === 'adopted') return;   // 010 §3.8b: an adoption is his own reply, already seen as chat
    // 012: his answer to an invitation, and any decision event from a chat, never wake the mind.
    if (e.type === 'decision.committed' && e.payload?.by === 'reply') return;
    if (typeof e.type === 'string' && e.type.startsWith('decision.') && CHAT_ORIGIN_KINDS.has(e.originKind)) return;
    // 015: a Director act (an owner pick, reversal or god change) is never an anchor; its engine consequences may be.
    if (e.actor === 'owner') return;
    if (ANCHOR_TYPES.has(e.type) && Number.isFinite(id) && !byId.has(id)) byId.set(id, { id, type: e.type, at: e.at ?? null });
  };
  try {
    const life = await deps.life();
    if (life && typeof life.listEvents === 'function') {
      for (const e of life.listEvents({ after: lastEventId || 0, order: 'asc', limit: 200 }) || []) add(e);
    }
  } catch { /* no life events table / life absent: tick events only */ }
  for (const e of Array.isArray(tickInfo?.events) ? tickInfo.events : []) {
    const id = Number(e?.id);
    if (Number.isFinite(id) && id <= (Number(lastEventId) || 0)) continue;   // already seen
    add(e);
  }
  if (maxId > (Number(lastEventId) || 0)) store.patchState({ lastEventId: maxId });
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
