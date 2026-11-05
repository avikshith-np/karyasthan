// Thought vs deed (plan 020 §F1): what he leaned to vs what he did, per local day, read from
// the log. No storage, no model call, nothing written. Pure: the facade hands in the readers.
//
//   "leaning stay (0.72)… went anyway (deadline draw)"
//
// A row names the true cause in code words: the deadline draw, the owner, an early commit (a
// lean past the commit threshold), the lean at the deadline (an Ask-me decision nobody
// answered), a plan adopted from a chat, a plan agreed in texts, his reply to an invitation,
// a goal's fitted outing; or why it expired. A decision shows on every local day it was active
// (opened, leaned, committed, reversed, expired, or its outing), always with its whole history.
//
// Privacy: this is the dashboard's. A plan made in a chat, or a lean a chat caused, is marked and
// worded by code labels only ("a plan from a chat", option ids, trigger codes): never a label
// or a word from a chat, never a JID (no subject on any row).
import { dateKey, dayStart, addDays, zonedToUnix } from './clock.js';
import { EVENT_AT_MIN, EVENT_AT_MAX } from './eventLog.js';
import { foldDecisions, chatMade, commitBy, isChatOrigin, optionOf, endedOnGo, outingWindow, wentFor, DUE_GRACE_SEC } from './decisionLog.js';

export class ThoughtDeedError extends Error {
  constructor(code) { super(`thoughtDeed: ${code}`); this.code = code; }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 14;
const ROWS_MAX = 60;
const LEANS_MAX = 12;
const DECISION_TYPES = ['decision.opened', 'decision.lean', 'decision.committed', 'decision.reversed', 'decision.expired'];
const MOVE_TYPES = ['activity.started', 'travel.started'];

// The true cause of a commit, in code words.
const CAUSE_WORDS = Object.freeze({
  sample: 'deadline draw', lean: 'the lean at the deadline', early: 'an early commit', owner: 'the owner', adopted: 'adopted from a chat',
  text: 'agreed in texts', reply: 'his reply to an invitation', goal: "a goal's outing",
});
const CAUSE_CODES = Object.freeze({
  sample: 'draw', lean: 'lean', early: 'early', owner: 'owner', adopted: 'adopted', text: 'text', scene: 'in person', reply: 'reply', goal: 'goal',
});
const EXPIRY_WORDS = Object.freeze({
  could_not_go: "he couldn't make it", unanswered: 'he never answered', owner_cancelled: 'the owner cancelled it',
  schedule: 'a schedule change', owner_plan: "the owner's new plan", fell_through: 'it fell through', frozen: 'frozen', pinned: 'pinned',
  rewound: 'a rewind', sick: 'he was sick', heavy: 'a heavy stretch', paused: 'the story was paused', withdrawn: 'the chat took it back',
  inviter_cancelled: 'they called it off', text_changed: 'they changed it in texts', career_changed: 'a job change', cast_departed: 'they left his life',
});

const round2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const word = (v, max = 32) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_:.-]*$/i.test(v) ? v.slice(0, max) : null);

function leanOf(ev, fromChat) {
  const p = ev.payload ?? {};
  return {
    eventId: ev.id, at: ev.at, optionId: word(p.optionId, 48), p: round2(p.p), by: word(ev.actor), trigger: word(p.trigger),
    fallback: word(p.fallback), fromChat: isChatOrigin(ev) || p.trigger === 'chat_mention' || fromChat === true,
  };
}

function deedOf(d, { went, at }) {
  const final = d.final;
  const reversals = d.reversals.map(ev => ({
    at: ev.at, from: word(ev.payload?.from, 48), to: word(ev.payload?.to, 48), by: ev.actor === 'owner' ? 'owner' : 'lean',
  }));
  if (d.expired) {
    const reason = word(d.expired.payload?.reason) ?? 'expired';
    return { status: 'expired', at: d.expired.at, optionId: final?.optionId ?? null, cause: reason, causeWords: EXPIRY_WORDS[reason] ?? reason.replace(/_/g, ' '), reversals, went: null };
  }
  if (!final) return { status: 'open', at: null, optionId: null, cause: null, causeWords: null, reversals, went: null };
  const by = commitBy(d.commit);
  const w = outingWindow(d);
  const go = endedOnGo(d);
  const pending = go && w ? at < w.eventAt + DUE_GRACE_SEC && !went : false;
  return {
    status: d.reversals.length ? 'reversed' : 'committed', at: final.ev.at, optionId: word(final.optionId, 48),
    cause: CAUSE_CODES[by] ?? word(by) ?? 'early', causeWords: CAUSE_WORDS[by] ?? (word(by) ?? 'an early commit'),
    p: round2(d.commit.payload?.p), reversals,
    nudged: d.commit.payload?.nudged === true || undefined,
    // A go with no place: the pulse never moves him for it, so "never went" would be untrue.
    went: go && w?.placeId ? (went ? true : pending ? null : false) : (went ? true : null),
  };
}

// The last lean before the deed: what he told himself going in.
function lastLeanBefore(d, leans) {
  const stop = d.expired?.id ?? d.final?.ev?.id ?? Infinity;
  const before = leans.filter(l => l.eventId < stop);
  return before.length ? before[before.length - 1] : null;
}

function leanWords(l) {
  if (!l) return 'no lean';
  return `leaning ${l.optionId ?? '?'}${l.p !== null ? ` (${l.p.toFixed(2)})` : ''}`;
}

function deedWords(deed, against, placed = true) {
  if (deed.status === 'open') return 'still open';
  if (deed.status === 'expired') return `expired: ${deed.causeWords}`;
  const opt = deed.optionId ?? '?';
  const back = deed.reversals.length ? `, changed his mind ${deed.reversals.length === 1 ? 'once' : `${deed.reversals.length} times`}` : '';
  const verb = deed.went === true ? 'went'
    : deed.went === false ? `chose ${opt} but never went`
      : (opt === 'go' || opt === 'late') ? (placed ? `chose ${opt}, still ahead` : `chose ${opt}`)
        : opt === 'stay' ? 'stayed' : `chose ${opt}`;
  return `${verb}${against && deed.went !== false ? ' anyway' : ''}${back} (${deed.causeWords}${deed.nudged ? ', nudged by a chat' : ''})`;
}

/**
 * The view of one local day. deps: { running, date, at, tz, read(from, to, types) → live events, getEvent }.
 * → { running, date, today, rows: [{ id, kind, label, at, eventAt, fromChat, leans, leanCount, leansShown, lastLean, deed, against, chatNudged, spansDays, text }], … }
 */
export function buildThoughtDeed({ running = true, date = null, at, tz, read, getEvent = () => null }) {
  const today = dateKey(at, tz);
  const day = date ?? today;
  const m = DATE_RE.exec(String(day));
  if (!m) throw new ThoughtDeedError('bad_date');
  const start = zonedToUnix(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, tz);
  if (!Number.isFinite(start) || dateKey(start, tz) !== day) throw new ThoughtDeedError('bad_date');
  if (!running) return { running: false, date: day, today, rows: [] };
  const end = addDays(start, 1, tz);
  const upTo = Math.min(at, addDays(start, LOOKAHEAD_DAYS, tz));
  const from = addDays(start, -LOOKBACK_DAYS, tz);
  // A well-formed date the log can't be asked about (far from now) is a bad date, not a crash.
  if (from - 86400 < EVENT_AT_MIN || upTo > EVENT_AT_MAX || end > EVENT_AT_MAX) throw new ThoughtDeedError('bad_date');
  const folds = foldDecisions(read(from, upTo, DECISION_TYPES));
  const moves = read(start - 86400, upTo, MOVE_TYPES);
  const causes = new Map();
  const causeOf = (id) => { if (!causes.has(id)) causes.set(id, getEvent(id) ?? null); return causes.get(id); };
  const inDay = (t) => typeof t === 'number' && t >= start && t < end;
  const rows = [];
  for (const d of folds.values()) {
    const sub = d.opened.payload?.subject ?? {};
    const times = [d.opened.at, ...d.leans.map(e => e.at), d.commit?.at, ...d.reversals.map(e => e.at), d.expired?.at];
    const touched = times.some(inDay) || inDay(sub.eventAt);
    if (!touched) continue;
    const fromChat = chatMade(d);
    const leans = d.leans.map(ev => leanOf(ev, false));
    const last = lastLeanBefore(d, leans);
    const went = d.final && endedOnGo(d) && !d.expired ? wentFor(d, moves, causeOf) : null;
    const deed = deedOf(d, { went, at });
    const finalOpt = deed.optionId;
    const against = last && finalOpt ? last.optionId !== finalOpt : null;
    const labelOpt = optionOf(d, 'go') ?? d.opened.payload?.options?.[0];
    const label = fromChat ? 'a plan from a chat' : (typeof labelOpt?.label === 'string' ? labelOpt.label.slice(0, 80) : word(d.opened.payload?.kind) ?? 'a plan');
    const shown = leans.slice(-LEANS_MAX);
    const dayOf = (t) => (typeof t === 'number' ? dateKey(t, tz) : null);
    const spans = new Set(times.filter(t => typeof t === 'number').map(dayOf));
    rows.push({
      id: d.id, kind: word(d.opened.payload?.kind) ?? 'plan', label, at: d.opened.at,
      eventAt: typeof sub.eventAt === 'number' ? sub.eventAt : null, fromChat,
      leans: shown, leanCount: leans.length, lastLean: last, deed, against: against === true,
      chatNudged: leans.some(l => l.fromChat) || deed.nudged === true,
      spansDays: spans.size > 1,
      text: `${leanWords(last)}… ${deedWords(deed, against === true, !!outingWindow(d)?.placeId)}`,
    });
  }
  rows.sort((a, b) => (a.deed.at ?? a.at) - (b.deed.at ?? b.at) || a.id - b.id);
  return { running: true, date: day, today, rows: rows.slice(-ROWS_MAX), total: rows.length, ...(dayStart(at, tz) === start ? { isToday: true } : {}) };
}
