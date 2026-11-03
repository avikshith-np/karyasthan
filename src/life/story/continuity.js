// The continuity checker (spec 015 §P2.1): code rules over a planned Director
// batch. Pure and synchronous — it reads the before/after projections, the
// batch's own descriptors and (through ctx.listEvents, exclusion-aware in a
// retcon) the log; it never writes, never calls a model and never refuses.
// Every finding is a WARNING (+ at most four code-built suggestions): the owner
// may still apply ("play god"; the story just has to make sense).
//
//   checkContinuity(planned, before, after, ctx) → { warnings, threads, suggestions }
//     planned  { action, events (descriptors, in order), warnings, extra }
//     before   the planning-clock view (advanceTo(state, now))
//     after    the folded state (planned.afterState)
//     ctx      { now, tz, world (overlaid), cfg {newCastPer90d, beatsPerWeek,
//                heavyMinGapDays}, lastHeavyAt(), listEvents(opts), idBase,
//                actionKinds:Set, knownType(type) }
//
//   warnings:    [{ code, severity: info|warn|high, text (code-built, ≤ 160),
//                   refs: {castIds, decisionIds, goalIds, placeIds}, fix?: i, fromChat }]
//   threads:     [{ kind: decision|goal|commitment|meeting|invite|pending, id, label,
//                   at, fate: kept|cancelled|moved|conflict, fromChat }]  (014 conflictsOf row shape)
//   suggestions: [{ action, why (code text), source: 'code', code }]   ≤ 4
//
// Rules C01–C20 (plan §P2.1). A rule about a type another 015/014 part adds
// (career.set, cast.departed, outcome.set, vitals.planned, sick.planned,
// schedule.override_set, …) runs only when ctx.knownType(type) says the log
// knows it, so this module is green before those parts are merged. Vitals are
// the base numbers (012: chat mood never steers story machinery). `fromChat`
// marks every finding that touches chat-derived state: the owner sees it
// (genericised as "a plan from a chat"), the story read never does.

import { dateKey, dayStart, addDays, hhmm as clockHhmm, weekday as weekdayOf, resolveTimezone } from '../clock.js';
import { routineOf, dayType } from '../routine.js';
import { planTrip } from '../travel.js';
import { vitalsAt } from '../projector.js';
import { isActive as embargoIsActive } from '../embargo.js';
import { chatMadeDecision } from '../planEdits.js';
import { heavyGuardActive, ROMANCE_STAGES, ROMANCE_BREAKUP_COOLDOWN_DAYS } from './reducer.js';

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const OVERLAP_SEC = 15 * MIN;
const LONG_COMMUTE_MIN = 75;
const TEXT_MAX = 160;
const SUGGESTIONS_MAX = 4;
const THREADS_MAX = 24;
const WARNINGS_MAX = 32;
const SPAN_DEFAULT_MIN = 120;
const PREVIEW_ID_BASE = 1e12;   // director.js PREVIEW_ID_BASE (not imported: director imports this module)
export const SEVERITIES = Object.freeze(['info', 'warn', 'high']);
const SEV_RANK = { info: 0, warn: 1, high: 2 };
/** Cheap kinds with nothing to check (plan §P2.1). */
export const SKIP_KINDS = Object.freeze(new Set(['bookmark', 'bookmark.remove', 'pause', 'resume', 'slider', 'fate', 'pin',
  'unpin', 'reconciler.mode', 'seed.set']));
const CHAT_KINDS = new Set(['group', 'dm', 'call', 'ig']);
const WORK_BLOCKS = new Set(['work', 'meeting']);
const WORK_RELATIONS = new Set(['coworker', 'manager']);
// family:<role> → parent | child | sibling (unknown roles are skipped).
const ROLE_WORDS = Object.freeze({
  parent: 'parent', mother: 'parent', father: 'parent', mom: 'parent', mum: 'parent', dad: 'parent',
  child: 'child', son: 'child', daughter: 'child',
  sibling: 'sibling', brother: 'sibling', sister: 'sibling',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);

/** Was a decision made in a chat (planEdits.chatMadeDecision; a lean a chat nudged doesn't count)? */
export function decisionFromChat(d) {
  return chatMadeDecision(d);
}

/** The severity order: info < warn < high. */
export function severityAtLeast(sev, floor) {
  return (SEV_RANK[sev] ?? -1) >= (SEV_RANK[floor] ?? 0);
}

/** Codes of the warnings at or above `floor` (default warn), unique, ≤ 16 — the apply audit's `continuity`. */
export function codesAtLeast(cont, floor = 'warn') {
  const out = [];
  for (const w of Array.isArray(cont?.warnings) ? cont.warnings : []) {
    if (severityAtLeast(w?.severity, floor) && typeof w.code === 'string' && !out.includes(w.code)) out.push(w.code);
  }
  return out.slice(0, 16);
}

// ── small readers ─────────────────────────────────────────────────────────

function tzOf(ctx, state) {
  return resolveTimezone(ctx?.tz ?? state?.world?.timezone);
}

function decisionsOf(s) {
  return s?.decisions instanceof Map ? [...s.decisions.values()].filter(isObj) : [];
}

// pulse.js decisionWindow: the late option's expiry is the outing's end.
function windowOf(d) {
  const eventAt = d?.subject?.eventAt;
  if (!finite(eventAt)) return null;
  const late = (Array.isArray(d.options) ? d.options : []).find(o => o?.id === 'late')?.expiresAt;
  return { start: eventAt, end: finite(late) && late > eventAt ? late : eventAt + SPAN_DEFAULT_MIN * MIN };
}

// Is decision d's outing over at `now` (its end, else its time + the go minutes)?
function outingOver(d, now) {
  const eventAt = finite(d?.subject?.eventAt) ? d.subject.eventAt : null;
  const minutes = (Array.isArray(d?.options) ? d.options : []).find(o => o?.id === 'go')?.minutes ?? 90;
  const endAt = finite(d?.subject?.endAt) ? d.subject.endAt : (eventAt ? eventAt + minutes * MIN : null);
  return finite(endAt) && finite(now) && endAt <= now;
}

function occupies(d) {
  return d?.status === 'committed' && (d.committed?.optionId === 'go' || d.committed?.optionId === 'late');
}

function castName(s, id) {
  const c = s?.cast instanceof Map ? s.cast.get(id) : null;
  const n = typeof c?.name === 'string' ? c.name : (s?.story?.departed?.[id]?.name ?? null);
  return typeof n === 'string' && n ? n.split(/\s+/)[0].slice(0, 40) : 'someone';
}

function placeName(s, id) {
  const p = s?.places instanceof Map ? s.places.get(id) : null;
  return typeof p?.name === 'string' && p.name ? p.name.slice(0, 60) : 'another place';
}

function decisionLabel(d) {
  if (decisionFromChat(d)) return 'a plan from a chat';
  const go = (Array.isArray(d?.options) ? d.options : []).find(o => o?.id === 'go')?.label;
  return clip(typeof go === 'string' && go ? go : String(d?.kind ?? 'a plan').replace(/[_:-]+/g, ' ')).slice(0, 80);
}

function hm(at, tz) {
  return finite(at) ? clockHhmm(at, tz) : '?';
}

function when(at, now, tz) {
  if (!finite(at)) return '?';
  const d = dateKey(at, tz);
  if (d === dateKey(now, tz)) return `today ${hm(at, tz)}`;
  if (d === dateKey(addDays(dayStart(now, tz), 1, tz), tz)) return `tomorrow ${hm(at, tz)}`;
  return `${d} ${hm(at, tz)}`;
}

// The world planTrip can resolve every projected place in (decisions.travelWorld).
function travelWorld(state, world) {
  if (!(state?.places instanceof Map) || !state.places.size) return world;
  const places = new Map((Array.isArray(world?.places) ? world.places : (world?.places instanceof Map ? [...world.places.values()] : []))
    .filter(p => p?.id).map(p => [p.id, p]));
  for (const [id, p] of state.places) places.set(id, p);
  return { ...world, places };
}

function tripMinutes(from, to, at, state, world) {
  if (!from || !to || from === to) return 0;
  try {
    return planTrip(from, to, at, state?.weather ?? null, travelWorld(state, world)).minutes;
  } catch {
    return null;
  }
}

function baseVitals(state, now, world) {
  try { return vitalsAt(state, now, world, { chatMood: false }) || {}; } catch { return state?.vitals ?? {}; }
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// ── the batch: spans, touched cast, folded ids ────────────────────────────

/**
 * What the batch puts on his calendar: [{ start, end, placeId, castIds, decisionId?,
 * ref, kind, fromChat }]. Ids of descriptors folded in this batch are
 * idBase + index + 1 (foldDescriptors' numbering).
 */
function spansOf(events, after, ctx) {
  const out = [];
  const base = finite(ctx.idBase) ? ctx.idBase : PREVIEW_ID_BASE;
  const chatRefs = chatRefsOf(events, ctx);
  events.forEach((e, i) => {
    const p = isObj(e.payload) ? e.payload : {};
    const chat = chatRefs.has(e.ref);
    if (e.type === 'decision.opened' && isObj(p.subject) && finite(p.subject.eventAt)) {
      const id = base + i + 1;
      const d = after?.decisions instanceof Map ? after.decisions.get(id) : null;
      const end = finite(p.subject.endAt) ? p.subject.endAt : (d ? windowOf(d)?.end : p.subject.eventAt + SPAN_DEFAULT_MIN * MIN);
      out.push({ start: p.subject.eventAt, end, placeId: p.subject.placeId ?? null, castIds: Array.isArray(p.subject.castIds) ? p.subject.castIds : [],
        decisionId: id, ref: e.ref, kind: 'decision', fromChat: chat || p.adopted === true || posInt(p.claimId) !== null });
    } else if (e.type === 'commitment.recorded' && finite(p.dueAt)) {
      out.push({ start: p.dueAt, end: p.dueAt + 30 * MIN, placeId: p.placeId ?? null, castIds: Array.isArray(p.castIds) ? p.castIds : [],
        ref: e.ref, kind: 'commitment', fromChat: true });
    } else if (e.type === 'schedule.override_set' && ctx.knownType('schedule.override_set')) {
      // 014 plan edits: every range he is somewhere / with someone (backgrounds only remove work).
      for (const r of Array.isArray(p.ranges) ? p.ranges : []) {
        if (!finite(r?.from) || !finite(r?.to) || r.activity === 'sleep' || r.activity === 'work_home' || r.activity === 'work_office') continue;
        out.push({ start: r.from, end: r.to, placeId: r.placeId ?? null, castIds: Array.isArray(r.castIds) ? r.castIds : [],
          ref: e.ref, kind: 'override', fromChat: false });
      }
    }
  });
  return out;
}

/**
 * Refs of the batch's descriptors that carry a chat origin, as appendEvent would
 * derive it: a subject JID, a non-owner event caused by a chat-origin log event
 * (a tray adoption's claim pointer), or caused by such a descriptor.
 */
export function chatRefsOf(events, ctx = {}) {
  const out = new Set();
  const chatEvent = (id) => {
    try {
      const ev = typeof ctx.getEvent === 'function' ? ctx.getEvent(id) : null;
      return !!ev && (CHAT_KINDS.has(ev.originKind) || typeof ev.subjectJid === 'string');
    } catch {
      return true;   // unknown → treat as chat (fail closed for the story read)
    }
  };
  for (const e of Array.isArray(events) ? events : []) {
    if (typeof e?.subjectJid === 'string') { out.add(e.ref); continue; }
    if (e?.actor === 'owner') continue;
    if (e?.causeRef && out.has(e.causeRef)) out.add(e.ref);
    else if (!e?.causeRef && posInt(e?.causeId) !== null && chatEvent(e.causeId)) out.add(e.ref);
  }
  return out;
}

function touchedCast(events) {
  const ids = new Set();
  for (const e of events) {
    const p = isObj(e.payload) ? e.payload : {};
    if (e.type === 'cast.created' && typeof p.id === 'string') ids.add(p.id);
    if (e.type === 'cast.updated' && typeof p.castId === 'string' && isObj(p.fields) && (p.fields.birthday !== undefined)) ids.add(p.castId);
  }
  return ids;
}

function typesIn(events) {
  return new Set(events.map(e => e.type));
}

// ── the checker ───────────────────────────────────────────────────────────

/** Normalise one warning (from a rule or from a planner's b.continuity). */
export function cleanWarning(w) {
  if (!isObj(w) || typeof w.code !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(w.code)) return null;
  const refs = isObj(w.refs) ? w.refs : {};
  const ids = (v, re) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v])).filter(x => re.test(String(x))).slice(0, 8);
  const out = {
    code: w.code,
    severity: SEVERITIES.includes(w.severity) ? w.severity : 'warn',
    text: clip(typeof w.text === 'string' && w.text ? w.text : w.code.replace(/_/g, ' ')),
    refs: {
      castIds: ids(refs.castIds ?? refs.castId, /^cast:[a-z0-9-]{1,40}$/),
      decisionIds: ids(refs.decisionIds ?? refs.decisionId, /^\d{1,15}$/).map(Number),
      goalIds: ids(refs.goalIds ?? refs.goalId, /^\d{1,15}$/).map(Number),
      placeIds: ids(refs.placeIds ?? refs.placeId, /^place:[a-z0-9-]{1,40}$/),
      ...(typeof refs.pinKey === 'string' && refs.pinKey.length <= 60 ? { pinKey: refs.pinKey } : {}),
      ...(typeof refs.category === 'string' && /^[a-z]{1,20}$/.test(refs.category) ? { category: refs.category } : {}),
    },
    fromChat: w.fromChat === true,
  };
  if (Number.isInteger(w.fix) && w.fix >= 0) out.fix = w.fix;
  // A schedule edit's cancels: the conflict keys KEEP IT INSTEAD re-previews with 'keep'.
  const keep = (Array.isArray(w.keep) ? w.keep : []).filter(k => typeof k === 'string' && KEEP_KEY_RE.test(k)).slice(0, 8);
  if (keep.length) out.keep = keep;
  return out;
}
const KEEP_KEY_RE = /^(?:decision|goal|invite):\d{1,15}$/;

/**
 * The code rules over one planned batch. → { warnings, threads, suggestions }
 * (empty lists for SKIP_KINDS). Never throws: a rule that fails is skipped.
 */
export function checkContinuity(planned, before, after, ctx = {}) {
  const out = { warnings: [], threads: [], suggestions: [] };
  const kind = planned?.action?.kind;
  if (!kind || SKIP_KINDS.has(kind)) return out;
  const events = Array.isArray(planned.events) ? planned.events : [];
  const c = {
    ...ctx,
    now: Math.floor(finite(ctx.now) ? ctx.now : (after?.at ?? 0)),
    knownType: typeof ctx.knownType === 'function' ? ctx.knownType : () => false,
    listEvents: typeof ctx.listEvents === 'function' ? ctx.listEvents : () => [],
    actionKinds: ctx.actionKinds instanceof Set ? ctx.actionKinds : new Set(),
    cfg: isObj(ctx.cfg) ? ctx.cfg : {},
  };
  c.tz = tzOf(c, after ?? before);
  const env = { planned, events, before: before ?? after, after: after ?? before, c, spans: spansOf(events, after, c), types: typesIn(events), out };
  for (const rule of RULES) {
    try { rule(env); } catch { /* a rule never breaks a preview */ }
  }
  // One warning per code and chat flag (the first; a higher severity wins), ≤ 32; threads ≤ 24.
  // A chat-made finding never merges into an own one: the story read drops it whole.
  const byCode = new Map();
  for (const w of out.warnings.map(cleanWarning).filter(Boolean)) {
    const key = `${w.code}|${w.fromChat}`;
    const prev = byCode.get(key);
    if (!prev || SEV_RANK[w.severity] > SEV_RANK[prev.severity]) byCode.set(key, w);
  }
  out.warnings = [...byCode.values()].slice(0, WARNINGS_MAX);
  const seen = new Set();
  out.threads = out.threads.filter(t => { const k = `${t.kind}:${t.id}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, THREADS_MAX);
  out.suggestions = out.suggestions.slice(0, SUGGESTIONS_MAX);
  return out;
}

function warn(env, code, severity, text, refs = {}, { fromChat = false, suggestion = null, keep = null } = {}) {
  const w = { code, severity, text, refs, fromChat, ...(keep ? { keep } : {}) };
  if (suggestion && env.out.suggestions.length < SUGGESTIONS_MAX
    && !env.out.suggestions.some(s => JSON.stringify(s.action) === JSON.stringify(suggestion.action))) {
    w.fix = env.out.suggestions.length;
    env.out.suggestions.push({ action: suggestion.action, why: clip(suggestion.why).slice(0, 120), source: 'code', code });
  }
  env.out.warnings.push(w);
}

function thread(env, t) {
  // One thread per plan: the decision diff and 014's conflicts row name the same one.
  if (t.id !== undefined && t.id !== null && env.out.threads.some(x => x.kind === t.kind && x.id === t.id)) return;
  env.out.threads.push({
    kind: t.kind, id: t.id ?? null, label: clip(t.label).slice(0, 80) || t.kind, at: finite(t.at) ? t.at : null,
    fate: ['kept', 'cancelled', 'moved', 'conflict'].includes(t.fate) ? t.fate : 'conflict', fromChat: t.fromChat === true,
  });
}

const can = (env, kind) => env.c.actionKinds.has(kind);

// Fixed items already on his calendar (after the batch) a span may clash with.
function fixedItems(env, span) {
  const { after, c } = env;
  const items = [];
  for (const d of decisionsOf(after)) {
    if (!occupies(d) || d.id === span.decisionId) continue;
    const w = windowOf(d);
    if (!w) continue;
    items.push({ start: w.start, end: w.end, placeId: d.subject?.placeId ?? null, label: decisionLabel(d), kind: 'decision', id: d.id, fromChat: decisionFromChat(d) });
  }
  for (const x of Array.isArray(after?.story?.commitments) ? after.story.commitments : []) {
    if (!finite(x?.dueAt) || x.dueAt < c.now) continue;
    items.push({ start: x.dueAt, end: x.dueAt + 30 * MIN, placeId: x.placeId ?? null, label: 'something he promised in a chat', kind: 'commitment', id: x.eventId ?? null, fromChat: true });
  }
  for (const g of Object.values(isObj(after?.goals) ? after.goals : {})) {
    if (g?.status !== 'fitted' || !finite(g.fitted?.slotStart)) continue;
    if (posInt(g.fitted?.decisionId) && after.decisions?.get?.(g.fitted.decisionId) && occupies(after.decisions.get(g.fitted.decisionId))) continue;
    items.push({ start: g.fitted.slotStart, end: finite(g.fitted.slotEnd) ? g.fitted.slotEnd : g.fitted.slotStart + (g.minutes ?? 60) * MIN,
      placeId: g.fitted.placeId ?? g.placeId ?? null, label: `goal #${g.id}`, kind: 'goal', id: g.id, fromChat: false });
  }
  for (const o of env.spans) {
    if (o === span || (o.ref === span.ref && o.start === span.start)) continue;
    items.push({ start: o.start, end: o.end, placeId: o.placeId, label: 'another part of this change', kind: 'batch', id: null, fromChat: o.fromChat });
  }
  return items;
}

// C01 two_places · C02 travel_infeasible · C03 sleeping
function ruleCalendar(env) {
  const { c, after } = env;
  for (const span of env.spans) {
    if (!finite(span.start) || !finite(span.end)) continue;
    const fixed = fixedItems(env, span);
    for (const f of fixed) {
      if (overlap(span.start, span.end, f.start, f.end) <= OVERLAP_SEC) continue;
      if (!span.placeId || !f.placeId || span.placeId === f.placeId) continue;
      warn(env, 'two_places', 'warn', `he would be at two places at once: ${f.label} ${when(f.start, c.now, c.tz)}`,
        { decisionIds: f.kind === 'decision' ? [f.id] : [], goalIds: f.kind === 'goal' ? [f.id] : [], placeIds: [span.placeId, f.placeId] },
        { fromChat: f.fromChat || span.fromChat });
      if (f.kind === 'decision' || f.kind === 'goal' || f.kind === 'commitment') {
        thread(env, { kind: f.kind, id: f.id, label: f.label, at: f.start, fate: 'conflict', fromChat: f.fromChat });
      }
    }
    // C02: from the previous fixed item (or where he is now) in time.
    if (span.placeId) {
      const prev = fixed.filter(f => f.placeId && f.end <= span.start + OVERLAP_SEC && f.end > span.start - 6 * HOUR)
        .sort((a, b) => b.end - a.end)[0];
      const fromPlace = prev?.placeId ?? (span.start - c.now < 3 * HOUR ? (after?.position?.placeId ?? after?.self?.homePlaceId ?? null) : null);
      const leaveAt = prev ? prev.end : c.now;
      const min = tripMinutes(fromPlace, span.placeId, leaveAt, after, c.world);
      if (finite(min) && fromPlace && leaveAt + min * MIN > span.start + 5 * MIN) {
        warn(env, 'travel_infeasible', 'warn', `he can't get to ${placeName(after, span.placeId)} by ${hm(span.start, c.tz)} (${min} min away)`,
          { placeIds: [fromPlace, span.placeId] }, { fromChat: span.fromChat || prev?.fromChat === true });
      }
    }
    // C03: tonight's planned sleep, or the routine's sleep on a later date.
    const sleepWin = sleepWindowFor(span.start, after, c);
    if (sleepWin && overlap(span.start, span.end, sleepWin.start, sleepWin.end) > OVERLAP_SEC && !wokenFor(span, sleepWin, after)) {
      // Wake him: asleep now with an owner outing tonight → "he can't sleep: wake him at HH:MM",
      // in time to get there (the pulse then fits the outing into the night's plan).
      let suggestion = null;
      const d = span.decisionId ? after?.decisions?.get?.(span.decisionId) : null;
      if (can(env, 'wake') && after?.activity?.kind === 'sleep' && span.start > c.now && span.start < sleepWin.end
          && d?.committed?.by === 'owner' && d.committed.optionId === 'go') {
        const home = after?.self?.homePlaceId ?? null;
        const min = tripMinutes(home, span.placeId, span.start - HOUR, after, c.world);
        // Never after its point of no return (prep + trip may be longer than the estimate).
        const ponr = finite(d.ponrAt) ? d.ponrAt : span.start;
        const t = Math.min(ponr, Math.max(c.now, span.start - ((finite(min) ? min : 15) + WAKE_LEAD_MIN) * MIN));
        const t5 = Math.max(c.now, Math.floor(t / (5 * MIN)) * 5 * MIN);
        const hhmm = hm(t5, c.tz);
        suggestion = { action: { kind: 'wake', reason: 'cant_sleep', at: hhmm }, why: `he can't sleep: wake him at ${hhmm}` };
      }
      warn(env, 'sleeping', suggestion ? 'warn' : 'info', `runs into his sleep (${hm(sleepWin.start, c.tz)}–${hm(sleepWin.end, c.tz)})`, {}, { fromChat: span.fromChat, suggestion });
    }
  }
}

const WAKE_LEAD_MIN = 15;   // the suggested wake: this long before he must leave

// Wake him: an owner wake request (in the batch or already set) that has him up
// for this span — asked at or before the span, inside the same night, and not
// answered before that night (an answered one has already re-planned the night).
// Its "until" doesn't matter: the night's plan keeps him up for an owner outing.
function wokenFor(span, win, state) {
  const list = Array.isArray(state?.wakeSets) ? state.wakeSets : [];
  return list.some(w => finite(w?.at) && w.at <= span.start && w.at >= win.start - 6 * HOUR && w.at < win.end
    && !(finite(w.wokeAt) && w.wokeAt < win.start));
}

function sleepWindowFor(at, state, c) {
  const plan = state?.plan;
  if (isObj(plan) && finite(plan.sleepAt) && finite(plan.nextWakeAt) && at < plan.nextWakeAt + 12 * HOUR && at >= (plan.wakeAt ?? 0)) {
    return { start: plan.sleepAt, end: plan.nextWakeAt };
  }
  const r = routineOf(c.world);
  const d0 = dayStart(at, c.tz);
  if (!finite(r.baseSleep) || !finite(r.baseWake)) return null;
  return { start: d0 + r.baseSleep * MIN, end: addDays(d0, 1, c.tz) + r.baseWake * MIN };
}

// C04 cast_departed / cast_away · C05 cast_at_work
function ruleCast(env) {
  const { c, after } = env;
  const r = routineOf(c.world);
  for (const span of env.spans) {
    for (const id of span.castIds) {
      if (isObj(after?.story?.departed?.[id])) {
        warn(env, 'cast_departed', 'high', `${castName(after, id)} has left his life (written out)`, { castIds: [id] },
          { fromChat: span.fromChat, suggestion: can(env, 'cast.return') ? { action: { kind: 'cast.return', castId: id }, why: `bring ${castName(after, id)} back first` } : null });
        continue;
      }
      const away = after?.story?.castLife?.[id]?.away;
      if (isObj(away) && (!finite(away.until) || away.until > span.start)) {
        warn(env, 'cast_away', 'warn', `${castName(after, id)} is away${finite(away.until) ? ` until ${when(away.until, c.now, c.tz)}` : ''}`, { castIds: [id] }, { fromChat: span.fromChat });
      }
      const rel = after?.cast?.get?.(id)?.relation;
      const wd = weekdayOf(span.start, c.tz);
      if (WORK_RELATIONS.has(rel) && !r.weekend.includes(wd)) {
        const d0 = dayStart(span.start, c.tz);
        if (overlap(span.start, span.end, d0 + r.workStart * MIN, d0 + r.workEnd * MIN) > OVERLAP_SEC) {
          warn(env, 'cast_at_work', 'info', `${castName(after, id)} is usually at work then`, { castIds: [id] }, { fromChat: span.fromChat });
        }
      }
    }
  }
}

// C06 he_at_work (+ 014's day-off edit as the suggestion when it exists)
function ruleWork(env) {
  const { c, after } = env;
  if (after?.world?.self?.employed === false || c.world?.self?.employed === false) return;
  const r = routineOf(c.world);
  const today = dateKey(c.now, c.tz);
  for (const span of env.spans) {
    if (span.kind === 'override') continue;
    const date = dateKey(span.start, c.tz);
    let hit = null;
    if (date === today && isObj(after?.plan) && after.plan.date === date) {
      hit = (after.plan.blocks || []).find(b => WORK_BLOCKS.has(b?.kind) && overlap(span.start, span.end, b.start, b.end) > OVERLAP_SEC) ? 'plan' : null;
    } else {
      let type = null;
      try { type = dayType(date, c.world, {}); } catch { type = null; }
      const d0 = dayStart(span.start, c.tz);
      if ((type === 'office' || type === 'wfh') && overlap(span.start, span.end, d0 + r.workStart * MIN, d0 + r.workEnd * MIN) > OVERLAP_SEC) hit = type;
    }
    if (!hit || dayOffOn(after, date, c)) continue;
    // 014's plan edit as the fix: an afternoon outing → the afternoon off (noon, or
    // now, to his bedtime); a morning one → that stretch off.
    const noon = dayStart(span.start, c.tz) + 12 * HOUR;
    const afternoon = span.start >= noon;
    const suggestion = !can(env, 'schedule') ? null : afternoon
      ? { action: { kind: 'schedule', date, background: { activity: 'off', from: Math.max(c.now, Math.min(noon, span.start - HOUR)), to: 'endOfDay' } }, why: 'take the afternoon off' }
      : { action: { kind: 'schedule', date, background: { activity: 'off', from: Math.max(c.now, span.start - HOUR), to: span.end } }, why: 'take that time off work' };
    warn(env, 'he_at_work', 'warn', `he is working then (${hm(span.start, c.tz)}, ${date === today ? 'today' : date})`, {}, { fromChat: span.fromChat, suggestion });
  }
}

// 014: an active schedule override that takes the day (or part of it) off.
function dayOffOn(state, date, c) {
  if (!c.knownType('schedule.override_set') || !isObj(state?.scheduleOverrides)) return false;
  return Object.values(state.scheduleOverrides).some(o => o?.status === 'active' && o.date === date && o.background?.activity === 'off');
}

// C07 fired_commute · C08 career pacing · C17 work_cast_after_job (career.set from the powers part)
function ruleCareer(env) {
  const { c, before, after, events } = env;
  if (!c.knownType('career.set')) return;
  const sets = events.filter(e => e.type === 'career.set' && isObj(e.payload));
  if (!sets.length) return;
  const career = before?.story?.career ?? {};
  for (const e of sets) {
    const p = e.payload;
    const leaving = p.employed === false || p.reason === 'fire' || p.reason === 'quit';
    if (leaving) {
      warn(env, 'job_loss_big', 'warn', 'losing his job is a big change: a mood or a hard stretch may follow', {},
        { suggestion: can(env, 'mood') ? { action: { kind: 'mood', preset: 'low', wakeDay: 1 }, why: 'he wakes up low the next morning' } : null });
      if (career.notice) warn(env, 'notice_active', 'info', 'he was already serving notice', {});
      if (posInt(career.huntArcId)) warn(env, 'hunt_active', 'info', 'he was already looking for a new job', {});
      const office = before?.self?.officePlaceId ?? career.officePlaceId ?? null;
      const later = decisionsOf(after).filter(d => (d.status === 'open' || d.status === 'committed')
        && ((office && d.subject?.placeId === office) || /^career:/.test(String(d.kind ?? '')) || d.category === 'career'));
      for (const d of later) thread(env, { kind: 'decision', id: d.id, label: decisionLabel(d), at: d.subject?.eventAt, fate: 'conflict', fromChat: decisionFromChat(d) });
      if (later.length) warn(env, 'fired_commute', 'warn', `${later.length} plan(s) still tied to his old job`, { decisionIds: later.map(d => d.id) });
      const coworkers = [...(after?.cast instanceof Map ? after.cast.values() : [])].filter(m => WORK_RELATIONS.has(m?.relation));
      if (coworkers.length) warn(env, 'work_cast_after_job', 'info', `${coworkers.length} coworker(s) stay in his life (a beat could say how)`, { castIds: coworkers.map(m => m.id) });
    }
    if (finite(p.salary) && finite(career.salary) && career.salary > 0 && Math.abs(p.salary - career.salary) / career.salary > 0.3) {
      warn(env, 'salary_jump', 'info', `salary changes by ${Math.round((p.salary - career.salary) / career.salary * 100)} %`, {});
    }
    if (p.reason === 'job' || p.reason === 'hire') {
      let recent = 0;
      try { recent = c.listEvents({ types: ['career.set', 'career.job_changed'], from: c.now - 30 * DAY, limit: 20 }).length; } catch { recent = 0; }
      recent += sets.filter(x => x !== e && (x.payload.reason === 'job' || x.payload.reason === 'hire')).length;
      if (recent > 0) warn(env, 'job_churn', 'info', 'another job change within 30 days', {});
    }
  }
}

// C09 romance_with_ex · romance_cooldown · stage_jump · romance_tension
function ruleRomance(env) {
  const { c, before, after, events, spans } = env;
  const exes = new Set();
  for (const a of Object.values(before?.story?.arcs ?? {})) {
    if (a?.category === 'romance' && a.status === 'ended' && a.outcome === 'broken_up' && finite(a.endedAt)
      && a.endedAt > c.now - ROMANCE_BREAKUP_COOLDOWN_DAYS * DAY) for (const id of a.castIds ?? []) exes.add(id);
  }
  const castTouched = new Set(spans.flatMap(s => s.castIds));
  for (const e of events) {
    const p = isObj(e.payload) ? e.payload : {};
    if (e.type === 'arc.started' && p.category === 'romance') {
      for (const id of p.castIds ?? []) castTouched.add(id);
      if (finite(before?.story?.romance?.cooldownUntil) && before.story.romance.cooldownUntil > c.now) {
        warn(env, 'romance_cooldown', 'info', `a new romance soon after the last one ended (cooldown until ${when(before.story.romance.cooldownUntil, c.now, c.tz)})`, {});
      }
      for (const id of p.castIds ?? []) romanceTension(env, id);
    }
    if (e.type === 'arc.stage' && typeof p.from === 'string' && typeof p.to === 'string') {
      if (Math.abs(ROMANCE_STAGES.indexOf(p.to) - ROMANCE_STAGES.indexOf(p.from)) > 1) {
        warn(env, 'stage_jump', 'info', `the romance jumps from ${p.from} to ${p.to}`, {});
      }
      const arc = before?.story?.arcs?.[p.arcId];
      for (const id of arc?.castIds ?? []) romanceTension(env, id);
    }
  }
  for (const id of castTouched) {
    if (exes.has(id)) warn(env, 'romance_with_ex', 'warn', `${castName(after, id)} broke up with him less than ${ROMANCE_BREAKUP_COOLDOWN_DAYS} days ago`, { castIds: [id] });
  }
}

function romanceTension(env, id) {
  const t = env.before?.cast?.get?.(id)?.metrics?.tension;
  if (finite(t) && t >= 0.6) warn(env, 'romance_tension', 'info', `things are tense with ${castName(env.after, id)} (${Math.round(t * 100) / 100})`, { castIds: [id] });
}

// C10 money_negative · money_jump (the projection's minimum is added at preview)
function ruleMoney(env) {
  const { c, before, after, events } = env;
  const b = baseVitals(before, c.now, c.world).money;
  const a = baseVitals(after, c.now, c.world).money;
  if (!finite(a) || !finite(b) || Math.abs(a - b) < 0.005) return;
  const base = Number(c.world?.money?.monthlyBaseline);
  if (a < 0 && a < b) {
    // Back above zero with a week of his usual spending on top, so his normal
    // spending over the next hours doesn't dip it below zero again.
    const buffer = finite(base) && base > 0 ? Math.ceil(base / 4 / 100) * 100 : 1000;
    warn(env, 'money_negative', 'warn', `his balance goes below zero (${Math.round(a)})`, {},
      { suggestion: can(env, 'money') ? { action: { kind: 'money', mode: 'income', amount: Math.ceil(-a) + buffer }, why: 'bring the balance back above zero, with a week of spending' } : null });
  }
  if (finite(base) && base > 0 && Math.abs(a - b) > 6 * base && events.length) {
    warn(env, 'money_jump', 'info', `a change of ${Math.round(a - b)} (more than six months of spending)`, {});
  }
}

// C11 family_age · C12 family_duplicate (members this batch creates or re-dates)
function roleOf(relation) {
  const m = /^family:([a-z]{2,20})$/.exec(String(relation ?? ''));
  return m ? (ROLE_WORDS[m[1]] ?? null) : null;
}

function yearsBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a ?? ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b ?? ''));
  if (!pa || !pb) return null;
  return (Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / (365.25 * DAY * 1000);
}

function ruleFamily(env) {
  const { after, events } = env;
  const touched = touchedCast(events);
  if (!touched.size) return;
  const self = after?.self?.birthdate ?? null;
  for (const id of touched) {
    const m = after?.cast?.get?.(id);
    const role = roleOf(m?.relation);
    if (!role || !m?.birthday || !self) continue;
    const olderBy = yearsBetween(m.birthday, self);   // > 0: the member is older than him
    if (olderBy === null) continue;
    if ((role === 'parent' && olderBy < 15) || (role === 'child' && -olderBy < 15) || (role === 'sibling' && Math.abs(olderBy) > 25)) {
      warn(env, 'family_age', 'warn', `${castName(after, id)}'s age doesn't fit a ${role} (${Math.round(Math.abs(olderBy))} years apart)`, { castIds: [id] });
    }
  }
  const parents = [...(after?.cast instanceof Map ? after.cast.values() : [])].filter(m => roleOf(m?.relation) === 'parent');
  if (parents.length > 2 && parents.some(p => touched.has(p.id))) {
    warn(env, 'family_duplicate', 'warn', `he would have ${parents.length} parents`, { castIds: parents.map(p => p.id) });
  }
}

// C13 overrides_open (+ 014 conflictsOf rows) · C20 chat_said
function ruleThreads(env) {
  const { c, before, after, planned } = env;
  for (const d of decisionsOf(before)) {
    if (d.status !== 'open' && d.status !== 'committed') continue;
    if (outingOver(d, c.now)) continue;   // a committed outing stays 'committed' after it happened
    const a = after?.decisions?.get?.(d.id);
    let fate = null;
    if (!a || (a.status !== 'open' && a.status !== 'committed')) fate = 'cancelled';
    else if (d.status === 'committed' && a.committed?.optionId !== d.committed?.optionId) fate = 'moved';
    else if (d.status === 'open' && a.status === 'committed') fate = 'kept';
    if (!fate) continue;
    thread(env, { kind: d.invite === true ? 'invite' : 'decision', id: d.id, label: decisionLabel(d), at: d.subject?.eventAt, fate, fromChat: decisionFromChat(d) });
  }
  const gb = isObj(before?.goals) ? before.goals : {};
  const ga = isObj(after?.goals) ? after.goals : {};
  for (const [id, g] of Object.entries(gb)) {
    if (g?.status !== 'open' && g?.status !== 'fitted') continue;
    const n = ga[id];
    if (!n || (n.status !== 'open' && n.status !== 'fitted')) thread(env, { kind: 'goal', id: Number(id), label: `goal #${id}`, at: g.to, fate: 'cancelled' });
    else if (g.status === 'fitted' && n.status === 'open') thread(env, { kind: 'goal', id: Number(id), label: `goal #${id}`, at: g.fitted?.slotStart, fate: 'moved' });
  }
  const cb = Array.isArray(before?.story?.commitments) ? before.story.commitments : [];
  const ca = new Set((Array.isArray(after?.story?.commitments) ? after.story.commitments : []).map(x => x.eventId));
  for (const x of cb) if (finite(x?.dueAt) && x.dueAt >= c.now && !ca.has(x.eventId)) thread(env, { kind: 'commitment', id: x.eventId, label: 'something he promised in a chat', at: x.dueAt, fate: 'cancelled', fromChat: true });
  const pb = isObj(before?.story?.pending) ? before.story.pending : {};
  const pa = isObj(after?.story?.pending) ? after.story.pending : {};
  for (const id of Object.keys(pb)) if (!pa[id]) thread(env, { kind: 'pending', id: Number(id), label: `scheduled change #${id}`, at: pb[id]?.due?.at ?? null, fate: 'cancelled' });
  // 014 plan edits list their own conflicts (planEdits.conflictsOf rows).
  const cancels = [];
  const keeps = [];
  const overlaps = [];
  for (const r of Array.isArray(planned?.extra?.conflicts) ? planned.extra.conflicts : []) {
    if (!isObj(r)) continue;
    const fate = r.outcome === 'dropped' ? 'cancelled' : r.outcome;
    const d = posInt(r.id) ? before?.decisions?.get?.(r.id) : null;
    const label = d ? decisionLabel(d) : (typeof r.label === 'string' ? r.label : r.type);
    const at = d?.subject?.eventAt ?? (finite(r.at) ? r.at : null);
    const fromChat = (d ? decisionFromChat(d) : false) || r.type === 'commitment' || r.type === 'invite';
    thread(env, { kind: ['decision', 'goal', 'commitment', 'meeting', 'invite'].includes(r.type) ? r.type : 'decision', id: r.id ?? null,
      label, at, fate, fromChat });
    if (!posInt(r.id) || !['decision', 'goal', 'invite'].includes(r.type)) continue;
    const row = { key: `${r.type}:${r.id}`, label, at, fromChat, reopen: r.resolution === 'reopen', keptWins: r.keptWins === true, tells: r.tells === true };
    if (r.outcome === 'cancelled') cancels.push(row);
    else if (r.outcome === 'kept' && r.trimmed === true) keeps.push(row);
    else if (r.outcome === 'kept' && r.clash === true) overlaps.push(row);   // an owner outing over a plan kept (director outingClashes)
  }
  // A schedule edit that cancels a plan says so loudly (HIGH: the I KNOW tick) and
  // carries the keys for KEEP IT INSTEAD; one kept by trimming the range says that.
  const named = (list) => list.slice(0, 3).map(x => `${x.label} at ${hm(x.at, c.tz)}${x.reopen ? ' (its goal looks for another slot)' : ''}`).join(', ');
  for (const chat of [false, true]) {
    const cx = cancels.filter(x => x.fromChat === chat);
    if (cx.length) {
      warn(env, 'cancels_plan', 'high', `this cancels ${named(cx)}${cx.length > 3 ? ` and ${cx.length - 3} more` : ''}`,
        { decisionIds: cx.filter(x => x.key.startsWith('decision:')).map(x => Number(x.key.split(':')[1])) },
        { fromChat: chat, keep: cx.map(x => x.key) });
    }
    const kx = keeps.filter(x => x.fromChat === chat);
    if (kx.length) {
      warn(env, 'keeps_plan', 'warn', `keeps ${named(kx)}: the range is trimmed around it`,
        { decisionIds: kx.filter(x => x.key.startsWith('decision:')).map(x => Number(x.key.split(':')[1])) }, { fromChat: chat });
    }
    const ox = overlaps.filter(x => x.fromChat === chat);
    if (ox.length) {
      // 020: plans settle by weight on the day; say which one loses, and whether a real person hears of it.
      const text = ox.some(x => x.keptWins)
        ? `${named(ox)} stays planned too, but he can only make one: that plan was set first and holds its time, so this new outing falls through`
        : `${named(ox)} stays planned too, but he can only make one: this new outing wins on the day and that plan falls through${ox.some(x => x.tells) ? ', and he tells them in that chat' : ''}`;
      warn(env, 'overlaps_plan', 'warn', text,
        { decisionIds: ox.filter(x => x.key.startsWith('decision:')).map(x => Number(x.key.split(':')[1])) }, { fromChat: chat });
    }
  }
  const moving = env.out.threads.filter(t => t.fate !== 'kept');
  const chat = moving.filter(t => t.fromChat);
  const own = moving.filter(t => !t.fromChat);
  if (own.length) {
    warn(env, 'overrides_open', 'info', `changes ${own.length} open plan(s): ${own.slice(0, 3).map(t => t.label).join(', ')}`,
      { decisionIds: own.filter(t => t.kind === 'decision').map(t => t.id), goalIds: own.filter(t => t.kind === 'goal').map(t => t.id) });
  }
  if (chat.length) {
    warn(env, 'overrides_open_chat', 'warn', `changes ${chat.length} plan(s) he made in a chat`, {}, { fromChat: true });
    warn(env, 'chat_said', 'info', `conflicts with a plan he made in a chat (${chat.length})`, {}, { fromChat: true });
  }
}

// C14 realism pacing · C15 heavy_guard · C16 departs_partner · C18/C19 (powers types)
function rulePacing(env) {
  const { c, before, after, events, types } = env;
  const cfg = c.cfg;
  if (types.has('cast.created')) {
    const ats = (after?.story?.newCast?.ats ?? []).filter(t => finite(t) && t > c.now - 90 * DAY);
    if (finite(cfg.newCastPer90d) && ats.length > cfg.newCastPer90d) {
      warn(env, 'new_cast_pace', 'info', `${ats.length} new people in 90 days (the engine's pace is ${cfg.newCastPer90d})`, {});
    }
  }
  if (types.has('cast.beat')) {
    let n = 0;
    try { n = c.listEvents({ types: ['cast.beat'], from: c.now - 7 * DAY, limit: 200 }).length; } catch { n = 0; }
    n += events.filter(e => e.type === 'cast.beat').length;
    if (finite(cfg.beatsPerWeek) && n > cfg.beatsPerWeek) warn(env, 'beats_week', 'info', `${n} cast beats this week (the engine's pace is ${cfg.beatsPerWeek})`, {});
  }
  if (types.has('heavy.started')) {
    let last = null;
    try { last = c.lastHeavyAt?.() ?? null; } catch { last = null; }
    const gap = finite(cfg.heavyMinGapDays) ? cfg.heavyMinGapDays : 90;
    if (finite(last) && last > c.now - gap * DAY) {
      warn(env, 'heavy_gap', 'high', `the last hard stretch began ${Math.round((c.now - last) / DAY)} days ago (the engine waits ${gap})`, {});
    }
    const active = before?.story?.heavy?.active;
    if (isObj(active) && finite(active.until) && active.until > c.now) {
      warn(env, 'ends_active_heavy', 'warn', 'a hard stretch is already under way', {},
        { suggestion: types.has('heavy.ended') ? null : { action: { kind: 'heavy.end', heavyId: active.id }, why: 'end the current hard stretch first' } });
    }
  }
  if (c.knownType('self.moved') && types.has('self.moved')) {
    const at = posInt(before?.self?.homeEventId) ? (() => { try { return c.getEvent?.(before.self.homeEventId)?.at ?? null; } catch { return null; } })() : null;
    if (finite(at) && at > c.now - 30 * DAY) warn(env, 'move_churn', 'info', 'he moved less than 30 days ago', {});
  }
  if (before?.story?.controls?.paused === true && events.some(e => e.type !== 'director.action')) {
    warn(env, 'paused_story', 'info', 'the story is paused: the engine adds nothing around this until you resume', {});
  }
  if (heavyGuardActive(before, c.now) || embargoIsActive(before?.embargo, c.now)) {
    warn(env, 'heavy_guard', 'info', 'he is in a hard stretch: the chat guard notes still apply', {});
  }
  if (c.knownType('cast.departed')) {
    const partner = before?.story?.romance?.partnerId;
    for (const e of events) {
      if (e.type === 'cast.departed' && partner && e.payload?.castId === partner) {
        warn(env, 'departs_partner', 'high', `${castName(before, partner)} is his partner: the romance ends too`, { castIds: [partner] });
      }
    }
  }
  if (c.knownType('outcome.set')) {
    for (const e of events) {
      if (e.type !== 'outcome.set') continue;
      const d = before?.decisions?.get?.(e.payload?.decisionId);
      if (d && (d.status === 'open' || (d.status === 'committed' && d.committed?.optionId === 'stay'))) {
        warn(env, 'outcome_needs_go', 'info', 'the outcome only happens if he goes', { decisionIds: [d.id] });
      }
    }
  }
  // 016: a tone hint only matters if he goes.
  if (c.knownType('scene.tone_set')) {
    for (const e of events) {
      if (e.type !== 'scene.tone_set') continue;
      const d = before?.decisions?.get?.(e.payload?.decisionId);
      if (d && (d.status === 'open' || (d.status === 'committed' && d.committed?.optionId === 'stay'))) {
        warn(env, 'tone_needs_go', 'info', 'the hint only matters if he goes', { decisionIds: [d.id] });
      }
    }
  }
  if (c.knownType('vitals.planned')) {
    for (const e of events) {
      if (e.type !== 'vitals.planned' || !isObj(e.payload?.delta)) continue;
      const dueAt = finite(e.payload.at) ? e.payload.at : null;
      const energy = Number(e.payload.delta.energy) || 0;
      const sick = !!(after?.sick || baseVitals(after, c.now, c.world).sick === true);
      if (energy > 0 && (sick || heavyGuardActive(after, dueAt ?? c.now))) warn(env, 'mood_vs_state', 'info', 'an energised day while he is sick or in a hard stretch', {});
      if (energy < 0 && typeof e.payload.wakeDate === 'string') {
        const early = decisionsOf(after).find(d => occupies(d) && finite(d.subject?.eventAt) && dateKey(d.subject.eventAt, c.tz) === e.payload.wakeDate
          && Number(clockHhmm(d.subject.eventAt, c.tz).slice(0, 2)) < 12);
        if (early) warn(env, 'mood_vs_state', 'info', `an exhausted morning with ${decisionLabel(early)} early that day`, { decisionIds: [early.id] }, { fromChat: decisionFromChat(early) });
      }
    }
  }
}

const RULES = [ruleCalendar, ruleCast, ruleWork, ruleCareer, ruleRomance, ruleMoney, ruleFamily, ruleThreads, rulePacing];

// ── Suggestions from a planner's own warnings (P1's relaxed refusals) ─────

/**
 * Code suggestions for warnings a planner (P1's `relax`) put on the batch:
 * `overrides_pin` → unpin, `overrides_frozen` → fate natural — never for the
 * heavy category (the freeze keeps binding the engine).
 */
export function plannerSuggestions(warnings, actionKinds) {
  const out = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    if (!isObj(w) || !isObj(w.refs)) continue;
    if (w.code === 'overrides_pin' && typeof w.refs.pinKey === 'string' && actionKinds.has('unpin') && w.refs.category !== 'heavy') {
      out.push({ action: { kind: 'unpin', pinKey: w.refs.pinKey }, why: 'lift the pin so the engine may change it too', source: 'code', code: w.code });
    }
    if (w.code === 'overrides_frozen' && typeof w.refs.category === 'string' && w.refs.category !== 'heavy' && actionKinds.has('fate')) {
      out.push({ action: { kind: 'fate', category: w.refs.category, mode: 'natural' }, why: 'let the engine continue this part of his life', source: 'code', code: w.code });
    }
  }
  return out;
}

/**
 * REVERT THIS CHANGE of an outing he already lived (property tests, 2026-11-02): its trips go with it,
 * but a later trip of another plan still sets off from there, so the log would read "left the café"
 * without his ever going. A warning in the preview, never a refusal (016: undoing a lived outing is
 * always allowed). outings: [{ placeId, at }] (lived, of this change); trips: [{ id, from, at }]
 * (live travel.started not caused by this change); returns: [{ placeId, at }] (live arrivals / starts
 * there not of this change: a trip after his own return is no reason, batch 3 review 39).
 * → [cleanWarning] (≤ 1 per place)
 */
export function laterTripsFrom({ outings = [], trips = [], returns = [], placeWord = (id) => 'there' } = {}) {
  const back = Array.isArray(returns) ? returns.filter(x => x && typeof x.placeId === 'string' && Number.isFinite(x.at)) : [];
  const out = [];
  const seen = new Set();
  for (const o of outings) {
    if (!o || typeof o.placeId !== 'string' || seen.has(o.placeId) || !Number.isFinite(o.at)) continue;
    const later = (Array.isArray(trips) ? trips : []).filter(t => t && t.from === o.placeId && Number.isFinite(t.at) && t.at > o.at
      && !back.some(x => x.placeId === o.placeId && x.at > o.at && x.at <= t.at));
    if (!later.length) continue;
    seen.add(o.placeId);
    let word = 'there';
    try { word = placeWord(o.placeId) || 'there'; } catch { word = 'there'; }
    const w = cleanWarning({
      code: 'later_trips_from', severity: 'warn', refs: { placeIds: [o.placeId] },
      text: `Later trips start from ${word}: undo this and the log has him leaving ${word} without having gone (${later.length} trip${later.length === 1 ? '' : 's'}).`,
    });
    if (w) out.push(w);
  }
  return out;
}

export const __test = { spansOf, windowOf, roleOf, yearsBetween, sleepWindowFor };
