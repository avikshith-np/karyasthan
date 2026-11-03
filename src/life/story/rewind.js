// Rewind (spec 010 FR-045, research R11, contracts/director-api.md §3 `rewind`):
// "go back to Tuesday 18:00". Nothing is deleted: one owner `world.rewound`
// excludes the id range after the target, the projection is rebuilt, and a
// short engine batch puts him back on the clock now.
//
//   targetFor(at, state)           the last applied, non-keep event with at ≤ T
//   planRewind(action, state, ctx) preview plan: the batch below, the rebuilt
//                                  state (a local fold of the log with the new
//                                  range — no write), cancelled summary, adopted
//                                  claims that return to the tray, mismatched
//                                  replies, lapsed proposals, stale expiries
//   applyRewind(planned, ctx)      append the batch (the facade's append
//                                  rebuilds on world.rewound), return reviews,
//                                  re-check withdrawals, pulse.rebase()
//
// The batch, in order (research R11, plan review B5):
//   1. director.action (owner) → world.rewound {toEventId, uptoEventId, …}
//      (owner, caused by it; both REWIND_KEEP, folded as bookkeeping);
//   2. world.reanchored {reason:'rewind'} (engine, cause = world.rewound) at the
//      apply clock: no vitals integrate across the gap, the day re-plans from now;
//   3. heavy.lapsed {reason:'rewind'} for every proposal pending in the rebuilt
//      state with onsetAt ≤ now + ARCS_BIG_LEAD_HOURS (no onset without its full
//      veto lead time);
//   4. decision.expired {reason:'rewound'} for every decision open in the rebuilt
//      state whose decideBy is past (else the next evaluate() would commit it),
//      and frozen/pinned for open arc decisions the controls now block; 011: also
//      {rewound} for a committed goal decision (by:'goal') whose point of no
//      return or outing is past while its outing was not over by the target (the
//      fold cancels it and reopens the goal — no back-dated evening, no goal.done);
//      since 2026-11-02 for every committed outing (go / late / attend at a place) whose window has passed the real
//      now (still open: the pulse decides); never for one with a start the rewind keeps (rewound to mid-outing: it resumes);
//   5. embargo.ended {reason:'rewind'}: a marker, only when an embargo was active
//      before and is not after.
// Then (same apply): story_claim_reviews adopted in the range → `returned`
// (reason rewound); any withdrawn/rejected/dismissed review whose adoption is
// live again is re-reverted (a guard: the kept reverts normally cover it).
//
// Rules: the target lies within ARCS_REWIND_DAYS of now, after genesis, is not
// excluded and is not itself a keep type; there must be something after it.

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { sanitizeWebContent } from '../../brain/webSearch.js';
import { createInitialState, project, isExcludedId, loadLatestSnapshot, exclusionSet } from '../projector.js';
import { getEvent, listEvents, eventsAfter, listRewinds, listReverts } from '../eventLog.js';
import { isActive as embargoIsActive } from '../embargo.js';
import { listClaims, reopenAdoptedClaim } from '../claims.js';
import * as store from './store.js';
import { isRewindKept, ROUTINE_TYPES } from './reducer.js';
import { check as controlsCheck, pinKeysFor, categoryOf } from './controls.js';
import { decisionWindow } from '../planEdits.js';

const HOUR = 3600;
const DAY = 86400;
const PAGE = 2000;
const REASON_MAX = 200;
const EXCERPT_MAX = 120;
const MISMATCH_MAX = 50;
const SNAPSHOT_SCAN = 32;
const DIFF_MAX = 100;
const JID_IN_TEXT_RE = /[0-9A-Za-z._:+-]{3,}@(?:s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)|@\d{5,}/i;
export const REWIND_SLICES = Object.freeze(['story.arcs', 'story.romance', 'story.career', 'story.heavy', 'story.castLife',
  'self', 'vitals', 'decisions', 'embargo', 'plan.date']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function err(code, reason = null) {
  return Object.assign(new Error(`story: ${code}${reason ? ` (${reason})` : ''}`), { name: 'StoryError', code, reason });
}

function cfg() {
  const a = config.arcs || {};
  return {
    rewindDays: Number.isFinite(a.rewindDays) ? a.rewindDays : 14,
    bigLeadHours: Number.isFinite(a.bigLeadHours) ? a.bigLeadHours : 24,
  };
}

function cleanReason(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw err('invalid', 'bad_reason');
  if (v.length > REASON_MAX) throw err('invalid', 'too_long');
  if (JID_IN_TEXT_RE.test(v)) throw err('invalid', 'jid_in_text');
  return sanitizeWebContent(v).replace(/>{3,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

// ── Target ────────────────────────────────────────────────────────────────

/**
 * The event a picked time maps to: the last event with at ≤ T that the
 * projection applies (not excluded) and that is not a keep type. null if none.
 */
export function targetFor(at, state) {
  const t = Math.floor(Number(at));
  if (!Number.isSafeInteger(t)) return null;
  let before = null;
  for (let page = 0; page < 50; page++) {
    const list = listEvents({ to: t, order: 'desc', limit: 500, ...(before ? { before } : {}) });
    if (!list.length) return null;
    // listEvents orders by (at, id) without a cursor and by id with one: keep the at ≤ T rule either way.
    const sorted = [...list].sort((a, b) => b.at - a.at || b.id - a.id);
    for (const ev of sorted) {
      if (ev.at > t || ev.redacted) continue;
      if (isExcludedId(state, ev.id) || isRewindKept(ev)) continue;
      return ev.id;
    }
    before = Math.min(...list.map(e => e.id));
  }
  return null;
}

function resolveTarget(action, state, now) {
  let id = null;
  let bookmarkId = null;
  if (action.toEventId !== undefined && action.toEventId !== null) id = posInt(action.toEventId);
  else if (action.bookmarkId !== undefined && action.bookmarkId !== null) {
    bookmarkId = posInt(action.bookmarkId);
    const bm = (state.story?.bookmarks ?? []).find(b => b.id === bookmarkId);
    if (!bm) throw err('not_found', 'bookmark');
    id = bm.eventId;
  } else if (action.at !== undefined && action.at !== null) {
    if (!finite(action.at)) throw err('invalid', 'bad_at');
    id = targetFor(action.at, state);
  }
  if (!id) throw err('not_found', 'target');
  const ev = getEvent(id);
  if (!ev) throw err('not_found', 'target');
  const c = cfg();
  if (ev.at < now - c.rewindDays * DAY) throw err('refused', 'beyond_window');
  if (!finite(state.genesisAt) || ev.at <= state.genesisAt) throw err('refused', 'before_genesis');
  if (isExcludedId(state, id)) throw err('refused', 'target_excluded');
  if (isRewindKept(ev)) throw err('refused', 'target_kept');
  if (id >= state.lastEventId) throw err('refused', 'nothing');
  return { target: ev, bookmarkId };
}

// ── Rebuilt state (a local fold; no write) ────────────────────────────────

/**
 * The projection after excluding (toEventId, uptoEventId] — exactly what the
 * facade's rebuild() gives once the owner `director.action` (uptoEventId+1)
 * and `world.rewound` (uptoEventId+2) are appended. Starts from the newest
 * snapshot that is valid for every revert and rewind in the log, else from an
 * empty state. → the folded state (not a view)
 */
export function rebuiltState(toEventId, uptoEventId, { world, now, reason = '' } = {}) {
  const excluded = exclusionSet();
  const rewinds = listRewinds().filter(r => !excluded.has(r.rewindId));
  const reverts = listReverts();
  const range = { from: toEventId + 1, to: uptoEventId + 1 };
  let state = null;
  let before = toEventId + 1;
  for (let guard = 0; guard < SNAPSHOT_SCAN && !state; guard++) {
    const snap = loadLatestSnapshot({ beforeEventId: before });
    if (!snap) break;
    const stale = reverts.some(r => r.targetId <= snap.uptoEventId && r.revertId > snap.uptoEventId)
      || rewinds.some(r => r.rewindId > snap.uptoEventId && r.from <= snap.uptoEventId);
    if (stale) { before = snap.uptoEventId; continue; }
    state = snap.state;
  }
  state = state ?? createInitialState(world);
  for (const id of excluded) state.excluded.add(id);
  if (!Array.isArray(state.excludedRanges)) state.excludedRanges = [];
  for (const r of [...rewinds, range]) {
    if (!state.excludedRanges.some(x => x.from === r.from && x.to === r.to)) state.excludedRanges.push({ from: r.from, to: r.to, eventId: r.rewindId ?? null });
  }
  for (;;) {
    const page = eventsAfter(state.lastEventId, PAGE).filter(e => e.id <= uptoEventId);
    if (!page.length) break;
    for (const ev of page) state = project(state, ev, world);
    if (page.length < PAGE || state.lastEventId >= uptoEventId) break;
  }
  // The two owner events of the apply, folded as bookkeeping (both kept).
  const actionEv = { id: uptoEventId + 1, at: now, type: 'director.action', actor: 'owner', causeId: null, payload: { kind: 'rewind' }, originKind: 'owner', originJid: 'owner', subjectJid: null, heavy: false, redacted: false };
  const rewound = { id: uptoEventId + 2, at: now, type: 'world.rewound', actor: 'owner', causeId: uptoEventId + 1, payload: { toEventId, uptoEventId, reason }, originKind: 'owner', originJid: 'owner', subjectJid: null, heavy: false, redacted: false };
  state = project(state, actionEv, world);
  state = project(state, rewound, world);
  return state;
}

// ── Summaries ─────────────────────────────────────────────────────────────

/** What the rewind cancels: events in (from−1, to] the projection applies now and that are not kept. */
export function cancelledSummary(fromId, toId, state) {
  const byType = {};
  let total = 0;
  let routine = 0;
  let after = fromId - 1;
  for (let guard = 0; guard < 200; guard++) {
    const page = eventsAfter(after, PAGE).filter(e => e.id <= toId);
    if (!page.length) break;
    for (const ev of page) {
      if (isExcludedId(state, ev.id) || isRewindKept(ev)) continue;
      byType[ev.type] = (byType[ev.type] ?? 0) + 1;
      total += 1;
      if (ROUTINE_TYPES.has(ev.type)) routine += 1;
    }
    after = page[page.length - 1].id;
    if (page.length < PAGE || after >= toId) break;
  }
  return { byType, total, routine };
}

/**
 * His replies after the target that were flagged as claims (operator view:
 * chat, an excerpt), and the count of his other group replies since.
 */
export function mismatchedReplies(fromAt, { countSelfReplies = null, chatName = null } = {}) {
  let claims = [];
  try {
    claims = listClaims({ limit: 200 }).filter(c => finite(c.createdAt) && c.createdAt >= fromAt).slice(0, MISMATCH_MAX);
  } catch { claims = []; }
  const items = claims.map(c => ({
    claimId: c.id, chatJid: c.chatJid, at: c.createdAt,
    chatName: (() => { try { return typeof chatName === 'function' ? (chatName(c.chatJid) ?? null) : null; } catch { return null; } })(),
    excerpt: typeof c.text === 'string' ? c.text.slice(0, EXCERPT_MAX) : '',
  }));
  let other = null;
  try {
    const n = typeof countSelfReplies === 'function' ? countSelfReplies(fromAt) : null;
    other = finite(n) ? Math.max(0, n - items.length) : null;
  } catch { other = null; }
  return { claims: items, otherReplies: other };
}

// ── Plan ──────────────────────────────────────────────────────────────────

const toPlain = (v) => {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [k, toPlain(x)]));
  if (v instanceof Set) return [...v];
  if (Array.isArray(v)) return v.map(toPlain);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
};

function slice(state, path) {
  if (path === 'decisions') {
    const out = {};
    for (const d of state?.decisions instanceof Map ? state.decisions.values() : []) {
      if (d.status === 'open' || d.status === 'committed') out[d.id] = { kind: d.kind, status: d.status, committed: d.committed?.optionId ?? null };
    }
    return out;
  }
  let cur = toPlain(state);
  for (const k of path.split('.')) cur = isObj(cur) ? cur[k] : undefined;
  return cur === undefined ? null : cur;
}

function diffInto(out, path, a, b, depth) {
  if (out.length >= DIFF_MAX || JSON.stringify(a) === JSON.stringify(b)) return;
  if (depth < 3 && isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffInto(out, `${path}.${k}`, a[k], b[k], depth + 1);
    return;
  }
  out.push({ path, from: a ?? null, to: b ?? null });
}

function foldSteps(state, steps, rewoundId, world) {
  let s = state;
  let id = rewoundId;
  for (const d of steps) {
    id += 1;
    const ev = { id, at: d.at, type: d.type, actor: d.actor, causeId: rewoundId, payload: structuredClone(d.payload), originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false };
    try { s = project(s, ev, world); } catch { /* preview only */ }
  }
  return s;
}

/**
 * Plan a rewind. action: { toEventId | at | bookmarkId, reason? }. ctx: { now,
 * tz, baseWorld, countSelfReplies, chatName } (director's ctx). → the director
 * plan shape { events, warnings, refusals, slices, before, after, diff, extra, post, afterState }
 */
const windowEnd = (d) => (finite(d.subject?.endAt) ? d.subject.endAt : decisionWindow(d).to);

// A start of this outing the rewind keeps: rewound to the middle of it he's still there (the plan's block resumes it), or he's been.
// Its evening wasn't rewound away. Same place and window as the pulse's could_not_go read, so the two can't disagree.
function startedByTarget(d, target, rebuilt) {
  const place = d.subject?.placeId;
  const eventAt = d.subject?.eventAt;
  if (typeof place !== 'string' || !finite(eventAt)) return false;
  const end = finite(d.subject?.endAt) ? d.subject.endAt : target.at;
  return listEvents({ types: ['activity.started'], from: eventAt - 2 * HOUR, to: Math.min(end, target.at), order: 'asc', limit: 200 })
    .some(e => e.id > d.id && e.id <= target.id && e.payload?.placeId === place && !e.redacted && !isExcludedId(rebuilt, e.id));
}

export function planRewind(action, state, ctx = {}) {
  const now = Math.floor(ctx.now);
  const world = ctx.baseWorld ?? undefined;
  const { target, bookmarkId } = resolveTarget(action, state, now);
  const reason = cleanReason(action.reason);
  const upto = state.lastEventId;
  const c = cfg();
  const cancelled = cancelledSummary(target.id + 1, upto, state);
  const rebuilt = rebuiltState(target.id, upto, { world, now, reason });

  const events = [];
  const add = (d) => { const ref = `$${events.length + 1}`; events.push({ ref, ...d }); return ref; };
  const parent = add({ type: 'director.action', actor: 'owner', at: now, payload: { kind: 'rewind', previewAt: now, count: 0 } });
  const lapsedIds = [];
  const props = rebuilt.story?.heavy?.proposals ?? {};
  for (const [k, p] of Object.entries(props)) {
    if (isObj(p) && p.status === 'pending' && finite(p.onsetAt) && p.onsetAt <= now + c.bigLeadHours * HOUR) lapsedIds.push(Number(k));
  }
  lapsedIds.sort((a, b) => a - b);
  const rewound = add({
    type: 'world.rewound', actor: 'owner', at: now, causeRef: parent,
    payload: {
      toEventId: target.id, uptoEventId: upto, ...(bookmarkId ? { bookmarkId } : {}), reason,
      cancelled: { byType: cancelled.byType }, lapsed: lapsedIds,
    },
  });
  const steps = [];
  const step = (type, payload) => { steps.push({ type, actor: 'engine', at: now, payload }); add({ type, actor: 'engine', at: now, causeRef: rewound, payload }); };
  step('world.reanchored', { fromAt: rebuilt.at ?? null, gapHours: finite(rebuilt.at) ? Math.max(0, Math.round((now - rebuilt.at) / HOUR)) : 0, reason: 'rewind' });
  for (const id of lapsedIds) step('heavy.lapsed', { proposedId: id, reason: 'rewind' });
  const expired = [];
  const open = [...(rebuilt.decisions instanceof Map ? rebuilt.decisions.values() : [])].filter(d => d?.status === 'open').sort((a, b) => a.id - b.id);
  for (const d of open) {
    let why = null;
    if (finite(d.decideBy) && d.decideBy <= now) why = 'rewound';
    else if (typeof d.category === 'string' && d.category && d.adopted !== true) {
      const cat = categoryOf(d.category) ?? d.category;
      const pinKeys = pinKeysFor({ type: 'decision.opened', payload: { category: d.category, kind: d.kind, subject: d.subject, arcId: d.arcId } }, rebuilt);
      const v = controlsCheck({ source: 'engine', category: cat, action: 'change', pinKeys }, rebuilt);
      if (!v.ok && (v.reason === 'frozen' || v.reason === 'pinned')) why = v.reason;
    }
    if (why) { step('decision.expired', { decisionId: d.id, reason: why }); expired.push(d.id); }
  }
  // 011: a goal decision kept committed (the target lies after its commit) whose
  // point of no return or outing is already past, while its outing was not over
  // by the target — the evening it rewrote is in the range, so it did not happen:
  // expire it so the goal reopens instead of counting as done.
  // 2026-11-02 (property tests, seed 20261102): the same for every committed outing — an owner's,
  // a goal's, an adopted one: kept committed by a target after its commit, its evening rewound
  // away, it would otherwise stay "go" forever with nothing moving him (the sweep's go_happened).
  const goalKept = [...(rebuilt.decisions instanceof Map ? rebuilt.decisions.values() : [])]
    .filter(d => d?.status === 'committed' && (d.committed?.by === 'goal'
      || (['go', 'late', 'attend'].includes(d.committed?.optionId) && typeof d.subject?.placeId === 'string')))
    .sort((a, b) => a.id - b.id);
  const goalsReopened = [];
  let outingsRewound = 0;
  for (const d of goalKept) {
    const passed = (finite(d.ponrAt) && d.ponrAt <= now) || (finite(d.subject?.eventAt) && d.subject.eventAt <= now);
    // Only a decision whose window reaches into the rewound range counts (batch 3 review 35): its end by the
    // window (subject.endAt, else the decision's own window), not subject.endAt alone — an occasion with no
    // endAt lived days ago was cancelled by any rewind.
    const end = windowEnd(d);
    const overByTarget = finite(end) && finite(target.at) && end <= target.at;
    // 'attend' (a family occasion) is never moved by the pulse, so it never has a start to find: never
    // expire it for having none. A goal's decision keeps its own rule.
    if (d.committed?.optionId === 'attend' && d.committed?.by !== 'goal') continue;
    // An outing whose window is still open isn't gone: nothing here, it stays committed and the pulse decides (he goes late, or
    // could_not_go once). A goal's goes back to open now, as it always has.
    const stillOpen = d.committed?.by !== 'goal' && !(windowEnd(d) <= now);
    if (passed && !overByTarget && !stillOpen && !startedByTarget(d, target, rebuilt)) {
      step('decision.expired', { decisionId: d.id, reason: 'rewound' });
      if (Number.isSafeInteger(d.goalId) && d.committed?.by === 'goal') goalsReopened.push(d.goalId); else outingsRewound++;
    }
  }
  const before = embargoIsActive(state.embargo, now);
  const afterEmb = embargoIsActive(rebuilt.embargo, now);
  if (before && !afterEmb) {
    step('embargo.ended', { reason: 'rewind', startedEventId: state.embargo?.eventId ?? null, heavyEventId: state.embargo?.heavyEventId ?? null });
  }
  events[0].payload.count = events.length - 1;

  const returned = store.reviewsAdoptedBetween(target.id + 1, upto).map(r => r.id);
  const mismatched = mismatchedReplies(target.at, { countSelfReplies: ctx.countSelfReplies, chatName: ctx.chatName });
  const afterState = foldSteps(rebuilt, steps, upto + 2, world);

  const warnings = [`cancels ${cancelled.total - cancelled.routine} events`];
  if (cancelled.routine) warnings.push(`also cancels ${cancelled.routine} routine phone checks, and any appended after this preview`);
  if (returned.length) warnings.push(`cancels ${returned.length} adopted claims (they return to the tray)`);
  if (lapsedIds.length) warnings.push(`${lapsedIds.length} pending heavy proposals lapse`);
  if (expired.length) warnings.push(`${expired.length} open decisions expire as stale`);
  if (goalsReopened.length) warnings.push(`${goalsReopened.length} goals reopen (the outing they planned is rewound away)`);
  if (outingsRewound) warnings.push(`${outingsRewound} plans are rewound away (their outing is past, so they expire)`);
  if (mismatched.claims.length) warnings.push(`${mismatched.claims.length} of his replies since then may no longer match`);

  const diff = [];
  for (const p of REWIND_SLICES) diffInto(diff, p, slice(state, p), slice(afterState, p), 0);
  return {
    events, warnings, refusals: [], slices: [...REWIND_SLICES],
    before: Object.fromEntries(REWIND_SLICES.map(p => [p, slice(state, p)])),
    after: Object.fromEntries(REWIND_SLICES.map(p => [p, slice(afterState, p)])),
    diff,
    extra: {
      toEventId: target.id, targetAt: target.at, cancelled: { byType: cancelled.byType, total: cancelled.total },
      routineCount: cancelled.routine, returned, lapsed: lapsedIds, expired, embargoEnds: before && !afterEmb, mismatched,
    },
    post: { range: { from: target.id + 1 } },
    rebuiltState: rebuilt,
    afterState,
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────

/**
 * Append the planned batch (one appendDescriptors call: the facade's append
 * rebuilds on world.rewound, so the steps fold onto the rebuilt state), then
 * return the reviews adopted in the range to the tray (their life_claims rows
 * back to 'flagged'), re-revert any live
 * adoption of a withdrawn/rejected/dismissed review, and rebase the pulse.
 * ctx: { append, getState, pulse, fingerprint, by, appendDescriptors }.
 * → { actionEventId, eventIds, returned, rereverted }
 */
export async function applyRewind(planned, ctx = {}) {
  const { byRef, eventIds } = ctx.appendDescriptors(planned.events, ctx.append, { fingerprint: ctx.fingerprint });
  const actionEv = byRef.get(planned.events[0].ref);
  const rewoundEv = [...byRef.values()].find(e => e.type === 'world.rewound');
  const from = planned.post?.range?.from;
  const to = rewoundEv ? rewoundEv.id - 1 : null;
  let returned = 0;
  if (from && to && to >= from) {
    for (const r of store.reviewsAdoptedBetween(from, to)) {
      if (store.updateReview(r.id, { status: 'returned', reason: 'rewound', decidedBy: String(ctx.by || 'owner').slice(0, 100) }, { fromStatus: 'adopted' })) {
        returned += 1;
        try { reopenAdoptedClaim(r.claimId); } catch { /* the review is the record */ }
      }
    }
  }
  const rereverted = recheckWithdrawals(ctx);
  try { ctx.pulse?.rebase?.(); } catch { /* the next tick re-reads */ }
  logger.info({ evt: 'arcs.rewind', toEventId: planned.extra?.toEventId, events: eventIds.length, returned, rereverted }, 'story: rewind applied');
  return { actionEventId: actionEv?.id ?? null, eventIds, returned, rereverted };
}

/**
 * Post-rebuild guard (research R11): a withdrawn, rejected or dismissed review
 * must have no live adoption; one that does gets its claim.adopted reverted
 * again. → how many were reverted
 */
export function recheckWithdrawals(ctx = {}) {
  const state = ctx.getState?.();
  if (!state?.story?.adopted || typeof ctx.append !== 'function') return 0;
  let n = 0;
  let before = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = store.listReviews({ status: ['withdrawn', 'rejected', 'dismissed'], before, limit: 200 });
    for (const r of page) {
      const live = state.story.adopted[r.claimId];
      if (!isObj(live) || live.status !== 'adopted' || !posInt(live.eventId) || isExcludedId(ctx.getState(), live.eventId)) continue;
      ctx.append({ type: 'event.reverted', actor: 'owner', at: Math.floor(ctx.now ?? state.at), payload: { targetId: live.eventId, reason: 'withdrawn', by: 'system:withdrawn' } });
      n += 1;
    }
    if (page.length < 200) break;
    before = page[page.length - 1].id;
  }
  return n;
}
