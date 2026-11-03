// What the log says about his decisions and where his body went (plan 020, E1 + F1).
// Pure: callers hand in events they already read. Shared by the nightly sweep
// (sweep.js) and the thought-vs-deed view (thoughtDeed.js), imported by those two only.
//
// Read from the log, not from state.decisions: the projection prunes closed decisions,
// and both readers want a decision's whole history. Every list here must already hold
// live events only (the caller filters out reverted, rewound and redacted rows).
//
//   foldDecisions(events)        decision.* events → Map(id → { opened, leans, commit, reversals, expired, final })
//   chatMade(fold)               was this plan made in a chat? (no labels, no options for those)
//   outingWindow(fold)           { eventAt, endAt, placeId, due } of the option he ended on
//   wentFor(fold, moves, causeOf) the first activity / trip that carried it out, or null
import { planBlockDecision } from './eventLog.js';
import { chatMadeDecision } from './planEdits.js';

const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const DEFAULT_OUTING_SEC = 2 * 3600;
const BEFORE_EVENT_SEC = 3 * 3600;      // a fit may get him there well before the outing's time
const AFTER_END_SEC = 3600;
export const DUE_GRACE_SEC = 30 * 60;   // past its time by this much with nothing logged

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

export function isChatOrigin(ev) {
  return CHAT_ORIGINS.has(ev?.originKind);
}

function decisionIdOf(ev) {
  return ev.type === 'decision.opened' ? ev.id : posInt(ev.payload?.decisionId);
}

/** Who made the commit, as the projector words it (an owner event is the owner's, whatever it says). */
export function commitBy(ev) {
  if (ev?.actor === 'owner') return 'owner';
  const by = ev?.payload?.by;
  if (typeof by === 'string' && by) return by;
  return ev?.payload?.sampled === true ? 'sample' : 'early';
}

/**
 * decision.* events → Map(id → fold), folded in id order as the projector does:
 * a commit needs an open decision, a reversal a committed one, and only an owner
 * event moves an owner pick. `final` = the option he ended on and the event that
 * set it; a decision with no decision.opened in the list is left out.
 */
export function foldDecisions(events) {
  const out = new Map();
  const ordered = [...events].sort((a, b) => a.id - b.id);
  for (const ev of ordered) {
    if (typeof ev?.type !== 'string' || !ev.type.startsWith('decision.')) continue;
    if (ev.type === 'decision.mode_set') continue;
    const id = decisionIdOf(ev);
    if (!id) continue;
    if (ev.type === 'decision.opened') {
      out.set(id, { id, opened: ev, leans: [], commit: null, reversals: [], expired: null, final: null });
      continue;
    }
    const d = out.get(id);
    if (!d) continue;
    if (ev.type === 'decision.lean') d.leans.push(ev);
    else if (ev.type === 'decision.committed') {
      if (d.commit || d.expired) continue;
      d.commit = ev;
      d.final = { optionId: ev.payload?.optionId ?? null, ev };
    } else if (ev.type === 'decision.reversed') {
      if (!d.commit || d.expired) continue;
      if (commitBy(d.commit) === 'owner' && ev.actor !== 'owner') continue;
      d.reversals.push(ev);
      d.final = { optionId: ev.payload?.to ?? null, ev };
    } else if (ev.type === 'decision.expired' && !d.expired) {
      d.expired = ev;
    }
  }
  return out;
}

/** The one chat-made classifier (planEdits), over a log fold. */
export function chatMade(fold) {
  const o = fold?.opened;
  const p = o?.payload ?? {};
  const shape = {
    adopted: p.adopted === true,
    claimId: posInt(p.claimId),
    subjectJid: o?.redacted === true ? null : o?.subjectJid ?? null,
    invite: p.invite ? true : undefined,
    committed: fold?.commit ? { by: commitBy(fold.commit) } : undefined,
    chatOpened: isChatOrigin(o),
  };
  return chatMadeDecision(shape);
}

export function optionOf(fold, optionId) {
  const opts = fold?.opened?.payload?.options;
  return Array.isArray(opts) ? opts.find(o => o?.id === optionId) ?? null : null;
}

/** Did he end on an option that moves him (a go, or joining late)? */
export function endedOnGo(fold) {
  const o = optionOf(fold, fold?.final?.optionId);
  return o?.go === true || o?.go === 'late' || fold?.final?.optionId === 'go' || fold?.final?.optionId === 'late';
}

/** When the option he ended on was to happen. null when the decision names no time. */
export function outingWindow(fold) {
  const p = fold?.opened?.payload ?? {};
  const sub = p.subject ?? {};
  const eventAt = finite(sub.eventAt) ? sub.eventAt : null;
  if (eventAt === null) return null;
  const o = optionOf(fold, fold?.final?.optionId);
  const minutes = finite(o?.minutes) ? o.minutes : finite(sub.minutes) ? sub.minutes : null;
  const endAt = finite(sub.endAt) ? sub.endAt : eventAt + (minutes ? minutes * 60 : DEFAULT_OUTING_SEC);
  const late = fold?.final?.optionId === 'late' || o?.go === 'late';
  const startBy = late ? Math.round(eventAt + (endAt - eventAt) / 2) : eventAt;
  return { eventAt, endAt, placeId: typeof sub.placeId === 'string' ? sub.placeId : null, due: startBy + DUE_GRACE_SEC };
}

/**
 * The activity.started / travel.started that carried out this go, or null. `moves` =
 * live starts in `at` order; causeOf(ev) → the event's cause. First by its own link (the
 * event's decisionId, or the block of the plan that started it), then by place and time —
 * anything that put him at that place around then counts, so this never cries wolf over
 * an outing he went to under a re-made plan.
 */
export function wentFor(fold, moves, causeOf = () => null) {
  const w = outingWindow(fold);
  if (!w || !Array.isArray(moves)) return null;
  const from = w.eventAt - BEFORE_EVENT_SEC;
  const to = w.endAt + AFTER_END_SEC;
  for (const ev of moves) {
    if (ev.at < from || ev.at > to) continue;
    if (posInt(ev.payload?.decisionId) === fold.id) return ev;
    const cause = posInt(ev.causeId) ? causeOf(ev.causeId) : null;
    if (cause?.type === 'plan.made' && planBlockDecision(cause.payload, ev) === fold.id) return ev;
    if (!w.placeId) continue;
    if (ev.type === 'activity.started' && ev.payload?.placeId === w.placeId) return ev;
    if (ev.type === 'travel.started' && ev.payload?.to === w.placeId) return ev;
  }
  return null;
}

// The plan step could not answer: no model, a cap, its own failure. Anything else is a decision.
export const PLAN_STEP_FAILED = new Set(['model_failed', 'invalid', 'append', 'error', 'ledger', 'cap', 'budget', 'plan_cap', 'not_running']);
const RING_COVER_SEC = 30 * 60;

/** What the plan step's ring says about a text: 'explained' | 'never_looked' | { failed: code } | null (it can't tell). */
export function planStepOn(turn, turns, ring) {
  if (!ring || turn.at < ring.since) return null;
  const byId = new Map(ring.entries.map(e => [e.id, e]));
  // A newer turn in the thread takes over: the step reads the two together, on the newest.
  const later = turns.filter(e => e.id > turn.id && e.payload?.castId === turn.payload?.castId && e.at - turn.at <= RING_COVER_SEC);
  const entry = byId.get(turn.id) ?? later.map(e => byId.get(e.id)).find(Boolean) ?? null;
  if (!entry) return 'never_looked';
  return PLAN_STEP_FAILED.has(entry.c) ? { failed: entry.c } : 'explained';
}
