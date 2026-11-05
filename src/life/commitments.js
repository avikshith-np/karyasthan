// What he said he'd do (plan 020 D3): one read-only view across decisions (with their weights),
// invitations, adopted claims, goals and plans agreed in texts, plus a text that sounds like a plan with
// none behind it. Code only, no storage, nothing appended: a revert or a rewind changes it at once.
// Pure: the story facade's commitmentsFor does the reads.
//
//   commitmentRows(s, input)   [{ key, who, castIds, what, when, source, by, weight, status, fromChat, flag, covered, code, eventIds }]
//   commitmentLines(rows, opt) his commitments, as lines for one writer's sheet
//
// who = a fictional name, or "a friend" for a real person; a plan made in a chat is "a plan from a chat", with no
// label, place or JID on the row. On a fictional person's sheet a chat's plan is at most "maybe busy".
import { foldDecisions, chatMade, commitBy, endedOnGo, optionOf, outingWindow, planStepOn, wentFor, DUE_GRACE_SEC } from './decisionLog.js';
import { planWeight, WEIGHT } from './planWeight.js';
import { dayLabel, hhmm } from './clock.js';

export const STATUSES = Object.freeze(['overdue', 'no_plan', 'open', 'on', 'kept', 'broken', 'lapsed']);
export const SOURCES = Object.freeze(['decision', 'invitation', 'claim', 'goal', 'text', 'scene']);
const DAY = 86400;
const HOUR = 3600;
export const CHAT_WHAT = 'a plan from a chat';
export const FRIEND = 'a friend';
export const CLOSED_SHOWN_SEC = 7 * DAY;
export const PROMISE_SHOWN_SEC = 7 * DAY;
const PLAN_BEFORE_SEC = 6 * HOUR;     // the sweep's text_plan window: a meeting this near a text answers it
const PLAN_AFTER_SEC = 36 * HOUR;
const PLAN_NO_DAY_SEC = 7 * DAY;      // no day named: anything the phone's "his plans" shows answers it (PLANS_AHEAD_HOURS)
const SEEN_BEFORE_SEC = HOUR;
const ROWS_MAX = 60;
const LINES_MAX = 4;
const LINE_MAX = 160;
const BUSY_AHEAD_SEC = 36 * HOUR;
const GOAL_WORDS = Object.freeze({ meet: 'see them', call: 'call them', outing: 'get out', errand: 'run an errand' });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const clean = (t, max = 120) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function namesOf(s, ids) {
  return ids.map(id => clean(s?.cast?.get?.(id)?.name ?? s?.story?.departed?.[id]?.name, 40)).filter(Boolean);
}

function whoOf(s, castIds, { real = false, fromChat = false } = {}) {
  const names = namesOf(s, castIds);
  if (names.length) return names.join(', ');
  return real || fromChat ? FRIEND : null;
}

const shapeOf = (fold) => ({
  committed: fold.commit ? { by: fold.reversals?.at(-1)?.actor === 'owner' ? 'owner' : commitBy(fold.commit) } : undefined,
  adopted: fold.opened?.payload?.adopted === true,
  kind: fold.opened?.payload?.kind,
});

function decisionRow(s, fold, { at, moves, causeOf }) {
  const o = fold.opened?.payload ?? {};
  const sub = o.subject ?? {};
  const eventAt = finite(sub.eventAt) ? sub.eventAt : null;
  const invite = !!o.invite;
  const onGo = !!fold.final && endedOnGo(fold);
  const wasGo = !!fold.commit && (fold.commit.payload?.optionId === 'go' || fold.commit.payload?.optionId === 'late');
  let status = null;
  let code = null;
  let covered = false;
  // Old enough: gone, kept or not, from the outing's own time. Also what keeps a kept outing from reading "never came off" once the moves' read no longer reaches it.
  if (!fold.expired && eventAt !== null && (onGo || (!fold.final && invite)) && at - eventAt > CLOSED_SHOWN_SEC) return null;
  if (fold.expired) {
    if (!wasGo && !invite) return null;
    status = 'lapsed';
    code = typeof fold.expired.payload?.reason === 'string' ? fold.expired.payload.reason : null;
  } else if (onGo) {
    const w = outingWindow(fold);
    if (!w) return null;
    if (at < w.due) status = 'on';
    else if (wentFor(fold, moves, causeOf)) status = 'kept';
    else { status = 'overdue'; covered = !!w.placeId; }   // the sweep's go_happened speaks for one with a place
  } else if (fold.final) {
    // He ended on something else. Only a yes he took back counts as a promise broken.
    if (!wasGo) return null;
    status = 'broken';
  } else if (invite && eventAt !== null) {
    status = at < eventAt + DUE_GRACE_SEC ? 'open' : 'overdue';
  } else return null;
  const closedAt = fold.expired?.at ?? fold.reversals?.at(-1)?.at ?? eventAt;
  if ((status === 'lapsed' || status === 'broken' || status === 'kept') && finite(closedAt) && at - closedAt > CLOSED_SHOWN_SEC) return null;
  const fromChat = chatMade(fold);
  const castIds = Array.isArray(sub.castIds) ? sub.castIds.filter(c => typeof c === 'string') : [];
  const by = fold.commit ? commitBy(fold.commit) : null;
  const goLabel = optionOf(fold, onGo ? fold.final.optionId : 'go')?.label ?? optionOf(fold, 'go')?.label;
  return {
    key: `decision:${fold.id}`,
    who: whoOf(s, fromChat ? [] : castIds, { real: !!fold.opened.subjectJid, fromChat }),
    castIds: fromChat ? [] : castIds,
    what: fromChat ? CHAT_WHAT : clean(goLabel ?? String(o.kind ?? 'a plan').replace(/[_:-]+/g, ' ')),
    when: eventAt,
    source: invite ? 'invitation' : o.adopted === true || posInt(o.claimId) ? 'claim' : posInt(o.goalId) ? 'goal' : by === 'text' ? 'text' : by === 'scene' ? 'scene' : 'decision',
    by,
    weight: invite ? WEIGHT.promise : planWeight(shapeOf(fold)),
    status, fromChat, flag: false, covered, code,
    goalId: posInt(o.goalId),
    eventIds: [fold.id, fold.final?.ev?.id, fold.expired?.id].filter(posInt),
  };
}

function goalRows(s, { at, fittedGoals }) {
  const out = [];
  for (const g of Object.values(s?.goals ?? {})) {
    if (!g || !posInt(g.id) || g.status === 'cancelled') continue;
    const castIds = typeof g.castId === 'string' ? [g.castId] : [];
    const what = clean(g.label) || GOAL_WORDS[g.goalKind] || 'a goal';
    const base = { key: `goal:${g.id}`, who: whoOf(s, castIds), castIds, what, source: 'goal', by: 'owner', weight: WEIGHT.promise, fromChat: false, flag: false, covered: false, code: null, eventIds: [g.id] };
    if (g.status === 'open') out.push({ ...base, when: g.to, status: at < g.to + DUE_GRACE_SEC ? 'open' : 'overdue' });
    else if (g.status === 'fitted') {
      if (fittedGoals.has(g.id)) continue;     // its decision's row says the rest
      const slot = g.fitted?.slotStart;
      out.push({ ...base, when: finite(slot) ? slot : g.to, status: 'on' });
    } else if (finite(g.closedAt) && at - g.closedAt <= CLOSED_SHOWN_SEC && (g.status === 'done' || g.status === 'expired')) {
      out.push({ ...base, when: g.closedAt, status: g.status === 'done' ? 'kept' : 'lapsed' });
    }
  }
  return out;
}

function recordedRows(s, recorded, { at, activities }) {
  const out = [];
  for (const ev of recorded) {
    const p = ev.payload ?? {};
    if (!finite(p.dueAt)) continue;
    const fromChat = ['group', 'dm', 'call', 'ig'].includes(ev.originKind) || !!ev.subjectJid;
    const castIds = fromChat || !Array.isArray(p.castIds) ? [] : p.castIds.filter(c => typeof c === 'string');
    // Nothing to check it against (no place, nobody): it can't be kept, only flagged softly.
    const ids = Array.isArray(p.castIds) ? p.castIds : [];
    const met = (p.placeId || ids.length) && activities.some(a => a.at >= p.dueAt - 3 * HOUR && a.at <= p.dueAt + 3 * HOUR
      && (p.placeId ? a.payload?.placeId === p.placeId : ids.some(id => (a.payload?.withCast ?? []).includes(id))));
    const status = at < p.dueAt + DUE_GRACE_SEC ? 'on' : met ? 'kept' : 'overdue';
    if (status !== 'on' && at - p.dueAt > CLOSED_SHOWN_SEC) continue;
    out.push({
      key: `claim:${ev.id}`, who: whoOf(s, castIds, { real: !!ev.subjectJid, fromChat }), castIds,
      what: fromChat ? CHAT_WHAT : clean(p.label) || 'something he said he would do', when: p.dueAt,
      source: 'claim', by: 'adopted', weight: WEIGHT.promise, status, fromChat, flag: false, covered: false, code: null, eventIds: [ev.id],
      ...(!p.placeId && !ids.length ? { soft: true } : {}),
    });
  }
  return out;
}

function promiseRows(s, promises, { at, folds, activities, ring, turns }) {
  const newest = new Map();
  for (const p of promises) {
    if (!posInt(p?.eventId) || typeof p.castId !== 'string' || at - Math.max(p.at, finite(p.dayAt) ? p.dayAt : 0) > PROMISE_SHOWN_SEC) continue;
    const cur = newest.get(p.castId);
    if (!cur || p.eventId > cur.eventId) newest.set(p.castId, p);
  }
  const out = [];
  for (const p of newest.values()) {
    const until = finite(p.dayAt) ? Math.max(p.at + PLAN_AFTER_SEC, p.dayAt) : p.at + PLAN_NO_DAY_SEC;
    const planned = [...folds.values()].some((d) => {
      if (!(d.opened?.payload?.subject?.castIds ?? []).includes(p.castId) || !d.final || d.expired || !endedOnGo(d)) return false;
      const t = d.opened.payload.subject.eventAt;
      return finite(t) && t >= p.at - PLAN_BEFORE_SEC && t <= until;
    });
    if (planned) continue;
    if (activities.some(a => (a.payload?.withCast ?? []).includes(p.castId) && a.at >= p.at - SEEN_BEFORE_SEC)) continue;
    const said = planStepOn({ id: p.eventId, at: p.at, payload: { castId: p.castId } }, turns, ring);
    const code = said === 'explained' ? ring?.entries?.find(e => e.id === p.eventId)?.c ?? 'refused' : said === null ? 'unknown' : said === 'never_looked' ? said : said.failed;
    out.push({
      key: `text:${p.eventId}`, who: whoOf(s, [p.castId]), castIds: [p.castId], what: `said "${clean(p.cue, 24)}" in texts, nothing set`,
      when: finite(p.dayAt) ? p.dayAt : null, source: 'text', by: null, weight: WEIGHT.promise,
      status: finite(p.dayAt) && at > p.dayAt ? 'overdue' : 'no_plan', fromChat: false, flag: true, covered: false, code, eventIds: [p.eventId],
    });
  }
  return out;
}

/**
 * input: { at, decisions (decision.* events, live), recorded (commitment.recorded events, live), moves (activity.started +
 * travel.started, live, in `at` order), causeOf(id), promises [{eventId, castId, at, cue, dayAt}], ring ({since, entries} | null) }.
 * Most pressing first: what's overdue, a text with nothing behind it, what's open, what's on (soonest first), then what closed lately.
 */
export function commitmentRows(s, { at, decisions = [], recorded = [], moves = [], causeOf = () => null, promises = [], ring = null } = {}) {
  const folds = foldDecisions(decisions);
  const activities = moves.filter(e => e.type === 'activity.started');
  const rows = [];
  const fittedGoals = new Set();
  for (const fold of folds.values()) {
    if (!fold.opened) continue;
    const row = decisionRow(s, fold, { at, moves, causeOf });
    if (row) {
      rows.push(row);
      if (row.goalId) fittedGoals.add(row.goalId);
    }
  }
  rows.push(...goalRows(s, { at, fittedGoals }));
  rows.push(...recordedRows(s, recorded, { at, activities }));
  const turns = promises.map(p => ({ id: p.eventId, at: p.at, payload: { castId: p.castId } }));
  rows.push(...promiseRows(s, promises, { at, folds, activities, ring, turns }));
  const rank = (r) => STATUSES.indexOf(r.status);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.status === 'on' || a.status === 'open' ? (a.when ?? Infinity) - (b.when ?? Infinity) : (b.when ?? 0) - (a.when ?? 0)))
    .slice(0, ROWS_MAX).map(({ goalId, ...r }) => r);
}

const whenWords = (t, tz) => (finite(t) ? `${dayLabel(t, tz)} ${hhmm(t, tz)}` : null);

/**
 * Lines for one writer's sheet, what "his plans" doesn't already say: promises with this person that have no plan behind them,
 * ones that never came off, and (his side only: they wouldn't know) what he means to do or backed out of. A chat's plan is only ever "maybe busy", on the phone's
 * sheets. opt: { castId, side: 'his'|'cast'|'scene', at, tz }. ≤ 4 lines.
 */
export function commitmentLines(rows, { castId, side = 'his', at, tz } = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (out.length >= LINES_MAX) break;
    if (r.fromChat) {
      if (side !== 'scene' && r.status === 'open' && finite(r.when) && r.when > at && r.when <= at + BUSY_AHEAD_SEC) out.push(`${whenWords(r.when, tz)}: maybe busy (other plans)`);
      continue;
    }
    if (!r.castIds.includes(castId)) continue;
    const when = whenWords(r.when, tz);
    if (r.flag) {
      out.push(`he and ${r.who} sounded like they'd meet${finite(r.when) ? ` (${dayLabel(r.when, tz)})` : ''}, but nothing is set`);
    } else if (r.status === 'overdue') {
      out.push(`"${r.what}"${when ? ` (${when})` : ''} never came off`);
    } else if (side === 'his' && r.status === 'open') {
      out.push(`he means to: ${r.what}${when ? `, by ${when}` : ''}`);
    } else if (side === 'his' && r.status === 'broken') {
      out.push(`he backed out of "${r.what}"${when ? ` (${when})` : ''}`);
    }
  }
  return out.map(l => clean(l, LINE_MAX));
}
