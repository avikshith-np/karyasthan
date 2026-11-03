// Public site (spec 013, plan "Life side"): the structural half of the public
// filter, where the cause chains live. Pure over the projection and the log
// reads the facade hands in; imported by the life facade alone (publicRaw).
// What leaves here is still internal (place/cast ids, a person ref) — the
// public exporter (src/public/) resolves names, snaps places, scrubs every
// string and validates the document before anything is written.
//
// Rules (fail closed):
//   - An event counts only when its origin is self/owner, it has no real-person
//     subject, it isn't redacted, excluded (revert/rewind) or heavy, and no
//     event in its cause chain is heavy.
//   - A span (activity / trip) that fails that test is one 'out' row: the time
//     span, the place as area-only, and the subject JID as an opaque person ref
//     (resolved to an opted-in display name or "a friend" downstream) — never
//     its kind, venue name, label, chat or inviter. Any other failing event is
//     dropped.
//   - Plan blocks ahead: a block with a real-person subject or from an outing
//     amendment is 'out' too.
//   - A heavy stretch (the story's heavy guard or a 009 embargo) is one boolean.
//   - Never reads decision leans, claims, the tray, proposals, refusals, the
//     journal, narration, digests or phone checks (none is in TYPES).
//   - 018 wallet (owner request 2026-10-31, extends 013 which kept money out):
//     money.salary / money.spent / money.adjusted (WALLET_TYPES, a read of their
//     own) under the same rule — an entry is listed only when it passes (self /
//     owner origin, no subject, not redacted / excluded / heavy, no heavy cause);
//     a chat-origin or subject spend is folded into a per-day "out with friends"
//     total (time and amount only — no place, kind or label); a heavy one (a
//     setback) is dropped. Labels are the code words (wallet.labelOf), never the
//     owner's own label; an owner "set the balance" is left out (its move needs a
//     past balance); a home-like place is never an entry's place.
//   - 016 scenes: `scenes` lists the projection's live scenes (story.scenes) with
//     the structural facts the exporter's checks need; their `scene.played` and
//     `activity.started` rows are read by id (getEvent) for origin, subject and
//     the heavy chain. No text here: the exporter reads it via publicScenes.
//   - 019 phone: `phone` lists his in-world texts (`phone.message`, PHONE_TYPES, a read of
//     their own) under the same rule — self / owner origin, no real-person subject, not
//     redacted / excluded / heavy, no heavy cause — and only in a thread with a fictional
//     cast member he has now (state.cast). Ids, times and directions only; the exporter
//     reads the texts via publicPhone and drops anything near a heavy onset.
//   - 020 dreams / thoughts: `dreams` lists remembered dreams (`dream.had`, DREAM_TYPES, a read of their own) and `thoughts` his own
//     thoughts under the same rule, every event a thought rests on included, never a `wordless` one (all a private session
//     or a heavy stretch ever gets). Ids and codes only; the exporter joins the words and drops anything near a heavy onset.

import { dateKey, dayStart, addDays, localParts, zonedToUnix } from './clock.js';
import { WALLET_TYPES, labelOf, moneyOf, nextPayday } from './wallet.js';   // 018

const MAX_CHAIN = 20;
const PUBLIC_ORIGINS = new Set(['self', 'owner']);

// The only types this module reads from the log.
export const TYPES = Object.freeze([
  'activity.started', 'activity.ended', 'travel.started', 'travel.arrived', 'sleep.started', 'woke',
  'world.reanchored', 'meal', 'weather.changed', 'commute.soaked', 'cast.beat', 'cast.updated',
  'cast.created', 'relationship.changed', 'arc.started', 'arc.stage', 'arc.ended', 'birthday', 'family.call',
  'family.occasion', 'career.job_changed', 'goal.done', 'decision.opened', 'decision.committed',
  'decision.reversed',
]);
// 019: his in-world texts, read on their own (never through TYPES).
export const PHONE_TYPES = Object.freeze(['phone.message']);
const PHONE_RAW_MAX = 2000;
// 020 G: dreams he remembers, read on their own the same way.
export const DREAM_TYPES = Object.freeze(['dream.had']);
const DREAM_RAW_MAX = 60;
const THOUGHT_RAW_MAX = 400;
const SPAN_STARTS = new Set(['activity.started', 'travel.started', 'sleep.started']);
const SPAN_ENDS = new Set(['activity.ended', 'travel.arrived', 'woke', 'world.reanchored']);
const BEAT_KINDS_SHOWN = new Set(['hobby', 'status', 'news', 'milestone', 'life', 'work', 'travel', 'mood']);
const METRICS = ['closeness', 'trust', 'tension'];
const STAY = new Set(['stay', 'skip', 'no', 'decline']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []);
const r2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
// P6: no sickness details — a sick block (009, or a heavy accident's sick day) is just rest.
const publicKind = (k) => (typeof k === 'string' && /^sick/.test(k) ? 'rest' : k);
const HEAVY_WINDOW_SEC = 31 * 86400;   // a heavy arc lasts ≤ 30 days

/**
 * The filter for one event: 'ok' | 'out' (a chat/subject span: area only) | 'drop'.
 * `heavyIn(ev)` walks the cause chain.
 */
export function classify(ev, { isOut, heavyIn }) {
  if (!ev || ev.redacted === true || ev.heavy === true) return 'drop';
  if (isOut(ev.id)) return 'drop';
  if (heavyIn(ev)) return 'drop';
  const publicOrigin = PUBLIC_ORIGINS.has(ev.originKind) && !ev.subjectJid;
  if (publicOrigin) return 'ok';
  return SPAN_STARTS.has(ev.type) && ev.type !== 'sleep.started' ? 'out' : 'drop';
}

function makeHeavyIn(getEvent) {
  const memo = new Map();
  return function heavyIn(ev) {
    const seen = [];
    let cur = ev;
    let out = false;
    for (let i = 0; i < MAX_CHAIN && cur; i++) {
      if (memo.has(cur.id)) { out = memo.get(cur.id); break; }
      seen.push(cur.id);
      if (cur.heavy === true) { out = true; break; }
      if (!Number.isSafeInteger(cur.causeId)) break;
      let next = null;
      try { next = getEvent(cur.causeId); } catch { out = true; break; }   // unreadable chain → treat as heavy
      if (!next) break;
      cur = next;
      if (i === MAX_CHAIN - 1) out = true;                                  // too deep → fail closed
    }
    for (const id of seen) memo.set(id, out);
    return out;
  };
}

function spanOf(ev, verdict, state) {
  const p = isObj(ev.payload) ? ev.payload : {};
  if (ev.type === 'sleep.started') return { at: ev.at, end: null, kind: 'sleep', placeId: null, castIds: [] };
  if (verdict === 'out') {
    const placeId = ev.type === 'travel.started' ? str(p.to, 80) : str(p.placeId, 80);
    return { at: ev.at, end: null, kind: 'out', placeId, areaOnly: true, castIds: [], personRef: ev.subjectJid ?? null };
  }
  if (ev.type === 'travel.started') {
    return { at: ev.at, end: null, kind: 'commute', placeId: str(p.to, 80), mode: str(p.mode, 24), castIds: ids(p.withCast) };
  }
  const placeId = str(p.placeId, 80);
  const home = placeId && homeIdsOf(state).has(placeId);
  // eventId: internal (a day row finds its 016 scene by it); the exporter's rows are closed shapes.
  return { at: ev.at, end: null, kind: publicKind(str(p.kind, 32)) ?? 'activity', placeId, home: !!home, castIds: ids(p.withCast), eventId: ev.id };
}

function tickOf(ev) {
  const p = isObj(ev.payload) ? ev.payload : {};
  switch (ev.type) {
    case 'meal': return { at: ev.at, type: 'meal', kind: str(p.kind, 24) };
    case 'commute.soaked': return { at: ev.at, type: 'soaked' };
    case 'cast.beat': {
      const kind = str(p.kind, 24);
      if (!BEAT_KINDS_SHOWN.has(kind)) return null;
      return { at: ev.at, type: 'beat', castId: str(p.castId, 80), text: str(p.text, 160) };
    }
    case 'arc.started': case 'arc.stage': case 'arc.ended':
      return { at: ev.at, type: ev.type, arcId: str(p.arcId, 80), kind: str(p.kind, 32), stage: str(p.stage ?? p.to, 32), castIds: ids(p.castIds) };
    case 'birthday': return { at: ev.at, type: 'birthday', castId: str(p.castId, 80) };
    case 'family.call': return { at: ev.at, type: 'family.call', castIds: ids(p.castIds ?? (p.castId ? [p.castId] : [])) };
    case 'family.occasion': return { at: ev.at, type: 'family.occasion', kind: str(p.kind, 32) };
    case 'career.job_changed': return { at: ev.at, type: 'job_changed' };
    case 'goal.done': return { at: ev.at, type: 'goal.done', kind: str(p.goalKind ?? p.kind, 24) };
    default: return null;
  }
}

/**
 * The raw public view. Inputs come from the facade:
 *   state, world, at, tz
 *   events(from, to, types)  log rows (excluded ones may still be present)
 *   getEvent(id)             one log row (cause-chain walk)
 *   isOut(id)                reverted / rewound
 *   hardStretch              story heavy guard || 009 embargo (the facade decides)
 *   cards                    the story's open Ask-me cards ([] with the story off)
 *   days                     past days of rows (≤ 30)
 */
/**
 * 015 §1.8 (013 seam): every home he has, had or is about to have — the current
 * one, every former home (`self.homeHistory`, a god move), a pending move's
 * target (`story.pending` self.moved) and every `kind:'home'` place — is
 * private on the site, whatever its name.
 */
export function homeIdsOf(state) {
  const out = new Set();
  if (typeof state?.self?.homePlaceId === 'string') out.add(state.self.homePlaceId);
  for (const id of Array.isArray(state?.self?.homeHistory) ? state.self.homeHistory : []) if (typeof id === 'string') out.add(id);
  const pending = isObj(state?.story?.pending) ? state.story.pending : {};
  for (const e of Object.values(pending)) if (e?.type === 'self.moved' && typeof e.payload?.homePlaceId === 'string') out.add(e.payload.homePlaceId);
  for (const p of state?.places instanceof Map ? state.places.values() : []) if (p?.kind === 'home' && typeof p.id === 'string') out.add(p.id);
  return out;
}

export function buildPublicRaw({ state, world, at, tz, events, getEvent, isOut, hardStretch = false, cards = [], days = 14, thoughtRows = [] }) {
  if (!state) return null;
  const heavyIn = makeHeavyIn(getEvent);
  const ctx = { isOut, heavyIn };
  const today0 = dayStart(at, tz);
  const from = addDays(today0, -Math.max(1, Math.min(30, days)), tz);
  const all = events(from - 36 * 3600, at, TYPES);
  const verdict = new Map();
  const v = (ev) => { if (!verdict.has(ev.id)) verdict.set(ev.id, classify(ev, ctx)); return verdict.get(ev.id); };

  // ── spans + ticks ──
  const spans = [];
  const ticks = [];
  let cur = null;
  for (const ev of all) {
    if (SPAN_STARTS.has(ev.type) || SPAN_ENDS.has(ev.type)) {
      // An excluded event never opened or closed a span on the live projection either.
      if (isOut(ev.id)) continue;
      if (cur) { cur.end = ev.at; spans.push(cur); cur = null; }
      if (SPAN_STARTS.has(ev.type)) {
        const verd = v(ev);
        cur = verd === 'drop' ? null : spanOf(ev, verd, state);
      }
      continue;
    }
    if (ev.at < from || v(ev) !== 'ok') continue;
    const t = tickOf(ev);
    if (t) ticks.push(t);
  }
  if (cur) spans.push(cur);

  const rows = [...spans.filter((s) => (s.end ?? at) > from), ...ticks].sort((a, b) => a.at - b.at);

  // ── now ──
  const act = state.activity;
  let nowSpan = spans.length && spans[spans.length - 1].end === null ? spans[spans.length - 1] : null;
  if (!nowSpan && isObj(act) && act.kind && act.kind !== 'idle') {
    // The span began before the window: classify the event that started it.
    const ev = Number.isSafeInteger(act.eventId) ? safe(() => getEvent(act.eventId)) : null;
    const verd = ev ? v(ev) : 'drop';
    if (verd !== 'drop') nowSpan = spanOf(ev, verd, state);
  }
  // Where he is comes ONLY from the current public span: the map position may still be the
  // venue a chat-caused outing took him to (a later span at home doesn't move it).
  const travel = state.position?.travel;
  const vit = state.vitalsBase ?? state.vitals ?? {};   // never the chat-mood overlay (spec 012)
  const publicSpan = nowSpan && nowSpan.kind !== 'out' ? nowSpan : null;
  const now = {
    span: nowSpan ? { ...nowSpan, until: finite(act?.endAt) && nowSpan.kind !== 'out' ? act.endAt : null } : null,
    placeId: publicSpan && publicSpan.kind !== 'commute' && publicSpan.kind !== 'sleep' ? publicSpan.placeId ?? null : null,
    home: !!publicSpan && publicSpan.home === true,
    travel: publicSpan?.kind === 'commute' && travel
      ? { mode: str(travel.mode, 24), to: publicSpan.placeId ?? null, toHome: homeIdsOf(state).has(publicSpan.placeId) } : null,
    asleep: state.availability?.state === 'asleep' || act?.kind === 'sleep',
    energy: finite(vit.energy) ? Math.round(vit.energy) : null,
    // His vitals: body 0–100, mood −100…100, arousal 0–100, sleep debt in hours (0–20), his money
    // (owner decision 2026-10-30: all vitals); never sickness (P6) or the chat-mood overlay.
    vitals: {
      energy: finite(vit.energy) ? Math.round(vit.energy) : null,
      stress: finite(vit.stress) ? Math.round(vit.stress) : null,
      hunger: finite(vit.hunger) ? Math.round(vit.hunger) : null,
      social: finite(vit.socialBattery) ? Math.round(vit.socialBattery) : null,
      workPressure: finite(vit.workPressure) ? Math.round(vit.workPressure) : null,
      sleepDebtHours: finite(vit.sleepDebt) ? Math.round(vit.sleepDebt * 10) / 10 : null,
      mood: finite(vit.mood?.valence) ? Math.round(vit.mood.valence * 100) : null,
      arousal: finite(vit.mood?.arousal) ? Math.round(vit.mood.arousal * 100) : null,
      money: finite(vit.money) ? Math.round(vit.money) : null,
    },
    valence: r2(vit.mood?.valence),
    arousal: r2(vit.mood?.arousal),
    weather: isObj(state.weather) ? { condition: str(state.weather.condition, 24), tempC: finite(state.weather.tempC) ? Math.round(state.weather.tempC) : null, rain: state.weather.rain === true } : null,
    hardStretch: hardStretch === true,
  };

  // ── next (rest of today's plan) ──
  const plan = state.plan;
  const planEv = Number.isSafeInteger(plan?.eventId) ? safe(() => getEvent(plan.eventId)) : null;
  // A plan made heavy, reverted or redacted shows nothing ahead. A chat-caused amended
  // plan keeps its base blocks; the outing's own blocks (fromAmendment) and any block
  // with a real-person subject are 'out'.
  const planBad = !planEv || planEv.redacted === true || planEv.heavy === true || isOut(planEv.id) || heavyIn(planEv);
  const next = [];
  for (const b of planBad ? [] : Array.isArray(plan?.blocks) ? plan.blocks : []) {
    if (!finite(b.start) || b.start <= at) continue;
    if (b.subjectJid || b.fromAmendment === true) {
      next.push({ at: b.start, end: b.end ?? null, kind: 'out', placeId: str(b.to ?? b.placeId, 80), areaOnly: true, castIds: [], personRef: b.subjectJid ?? null });
    } else {
      const commute = b.kind === 'commute';
      next.push({ at: b.start, end: b.end ?? null, kind: publicKind(str(b.kind, 32)) ?? 'activity', placeId: str(commute ? b.to : b.placeId, 80), ...(commute ? { mode: str(b.mode, 24) } : {}), castIds: ids(b.withCast) });
    }
    if (next.length >= 12) break;
  }
  if (next.length && plan && finite(plan.sleepAt) && plan.sleepAt > at && !next.some((n) => n.kind === 'sleep')) {
    next.push({ at: plan.sleepAt, end: null, kind: 'sleep', placeId: null, castIds: [] });
  }

  // ── places ──
  const homeIds = homeIdsOf(state);
  const places = [];
  for (const p of state.places instanceof Map ? state.places.values() : []) {
    const homeLike = homeIds.has(p.id) || p.kind === 'home' || /\bhome\b/i.test(String(p.name ?? ''));
    places.push({
      id: p.id, name: str(p.name, 80), kind: str(p.kind, 24), lat: finite(p.lat) ? p.lat : null, lon: finite(p.lon) ? p.lon : null, home: homeLike,
      // 016 export contract: a real venue (014 `venue` data) and its area, for a scene's area line.
      venue: isObj(p.venue), area: isObj(p.venue) ? str(p.venue.area, 60) : null,
    });
  }

  // ── scenes (016): live scenes that ended in the window; fail closed on an unreadable row ──
  const scenes = [];
  for (const [aid, sc] of Object.entries(isObj(state.story?.scenes) ? state.story.scenes : {})) {
    if (!isObj(sc) || !Number.isSafeInteger(sc.eventId) || !finite(sc.endedAt) || sc.endedAt < from || sc.endedAt > at) continue;
    const actId = Number(aid);
    if (isOut(sc.eventId) || (Number.isSafeInteger(actId) && isOut(actId))) continue;
    const sev = safe(() => getEvent(sc.eventId));
    const aev = Number.isSafeInteger(actId) ? safe(() => getEvent(actId)) : null;
    if (!sev || !aev || sev.redacted === true || aev.redacted === true) continue;
    const origin = [sev.originKind, aev.originKind].find((k) => !PUBLIC_ORIGINS.has(k)) ?? sev.originKind;
    scenes.push({
      sceneEventId: sc.eventId, activityEventId: actId,
      at: finite(sc.startAt) ? sc.startAt : aev.at, end: sc.endedAt,
      kind: publicKind(str(sc.kind, 32)), placeId: str(sc.placeId, 80),
      castIds: ids(sc.castIds), firstMeet: ids(sc.firstMeet), ending: str(sc.ending, 24), mode: str(sc.mode, 16),
      heavy: sev.heavy === true || aev.heavy === true || heavyIn(sev) || heavyIn(aev),
      subjectJid: sev.subjectJid ?? aev.subjectJid ?? null, originKind: origin ?? null,
    });
    if (scenes.length >= 120) break;
  }

  // ── cast (fictional): fields from the projection, status/beats only from public events ──
  const castEvents = events(Math.floor(finite(state.genesisAt) ? state.genesisAt : from), at, ['cast.created', 'cast.updated', 'cast.beat', 'relationship.changed']);
  const status = new Map();       // castId → latest public status text
  const deltas = new Map();       // castId → [{at, d}]
  for (const ev of castEvents) {
    const p = isObj(ev.payload) ? ev.payload : {};
    const id = str(ev.type === 'cast.created' ? p.id : p.castId, 80);
    if (!id) continue;
    if (ev.type === 'relationship.changed') {
      if (isOut(ev.id) || ev.redacted || !isObj(p.delta)) continue;
      const heavyDelta = ev.heavy === true || heavyIn(ev);
      (deltas.get(id) ?? deltas.set(id, []).get(id)).push({ at: ev.at, d: p.delta, heavy: heavyDelta });
      continue;
    }
    const text = ev.type === 'cast.created' ? str(p.status, 120)
      : ev.type === 'cast.updated' ? str(p.fields?.status, 120)
        : p.kind === 'status' ? str(p.text, 120) : null;
    if (!text) continue;
    if (v(ev) === 'ok') status.set(id, text);
  }
  const cast = [];
  for (const c of state.cast instanceof Map ? state.cast.values() : []) {
    const m = isObj(c.metrics) ? c.metrics : {};
    // Today's values minus every change a heavy event caused: the public numbers never move
    // because of a hard stretch (the gentle line is all that shows).
    const allDeltas = deltas.get(c.id) ?? [];
    const heavySum = Object.fromEntries(METRICS.map((k) => [k, allDeltas.filter((x) => x.heavy && finite(x.d[k])).reduce((a, x) => a + x.d[k], 0)]));
    const metrics = Object.fromEntries(METRICS.map((k) => [k, finite(m[k]) ? r2(Math.min(1, Math.max(0, m[k] - heavySum[k]))) : null]));
    // Series: walk the public deltas back from those values, one point per day.
    const series = [];
    const list = allDeltas.filter((x) => !x.heavy).sort((a, b) => b.at - a.at);
    const val = { ...metrics };
    let i = 0;
    for (let d = 0; d <= 60; d++) {
      const dayEnd = addDays(today0, 1 - d, tz);
      while (i < list.length && list[i].at >= dayEnd) {
        for (const k of METRICS) if (finite(list[i].d[k]) && finite(val[k])) val[k] = Math.min(1, Math.max(0, val[k] - list[i].d[k]));
        i++;
      }
      series.push({ at: Math.min(at, dayEnd), ...Object.fromEntries(METRICS.map((k) => [k, r2(val[k])])) });
      if (i >= list.length && d >= Math.min(60, Math.ceil((at - (list[list.length - 1]?.at ?? at)) / 86400) + 1)) break;
    }
    series.reverse();
    cast.push({
      id: c.id, name: str(c.name, 60), relation: str(c.relation, 40), job: str(c.job, 80),
      status: status.get(c.id) ?? null,
      metrics, series,
    });
  }

  // ── arcs (chapters) ──
  const arcs = [];
  const taintedArcs = new Set();
  for (const ev of events(Math.floor(finite(state.genesisAt) ? state.genesisAt : from), at, ['arc.started', 'arc.stage', 'arc.ended'])) {
    if (isOut(ev.id)) continue;
    const arcId = ev.type === 'arc.started' ? ev.id : ev.payload?.arcId;
    if (ev.heavy === true || heavyIn(ev) || !PUBLIC_ORIGINS.has(ev.originKind)) taintedArcs.add(Number(arcId));
  }
  for (const a of Object.values(state.story?.arcs ?? {})) {
    // A heavy event anywhere in an arc's life (e.g. a breakup ending a romance) → not shown.
    if (!isObj(a) || a.category === 'heavy' || a.heavy === true || taintedArcs.has(Number(a.id))) continue;
    arcs.push({ id: a.id, kind: str(a.kind, 32), category: str(a.category, 24), stage: str(a.stage, 32), status: str(a.status, 16), startedAt: a.startedAt ?? null, endedAt: a.endedAt ?? null, castIds: ids(a.castIds) });
  }

  // ── votes: open Ask-me cards of public decisions ──
  const votes = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    if (c?.type !== 'decision' || c.status !== 'open') continue;
    const d = state.decisions instanceof Map ? state.decisions.get(c.id) : null;
    if (!d || d.status !== 'open' || d.invite || d.adopted || d.category === 'heavy') continue;
    const ev = safe(() => getEvent(d.id));
    if (!ev || classify(ev, ctx) !== 'ok') continue;
    if (!finite(d.decideBy) || d.decideBy <= at) continue;
    votes.push({
      decisionId: d.id, kind: str(d.kind, 32), category: str(d.category, 24), question: str(c.question, 120), eventAt: d.subject?.eventAt ?? null,
      decideBy: d.decideBy, placeId: str(d.subject?.placeId, 80), castIds: ids(d.subject?.castIds),
      options: (Array.isArray(c.options) ? c.options : []).filter((o) => !o.expired).slice(0, 4).map((o) => ({ id: str(o.id, 24), label: str(o.label, 100) })).filter((o) => o.id),
    });
    if (votes.length >= 5) break;
  }

  // ── stats inputs ──
  const sleeps = [];
  for (const s of spans) if (s.kind === 'sleep' && s.end) sleeps.push({ date: dateKey(s.end, tz), minutes: Math.round((s.end - s.at) / 60) });
  const rainyDays = new Set();
  let kept = 0;
  let bailed = 0;
  const publicDecisions = new Set();
  for (const ev of all) {
    if (ev.at < from || v(ev) !== 'ok') continue;
    const p = isObj(ev.payload) ? ev.payload : {};
    if (ev.type === 'weather.changed' && p.rain === true) rainyDays.add(dateKey(ev.at, tz));
    if (ev.type === 'decision.opened') publicDecisions.add(ev.id);
  }
  for (const ev of all) {
    if (ev.at < from || v(ev) !== 'ok') continue;
    const p = isObj(ev.payload) ? ev.payload : {};
    if (!publicDecisions.has(p.decisionId)) continue;
    const opt = ev.type === 'decision.committed' ? p.optionId : ev.type === 'decision.reversed' ? p.to : null;
    if (!opt) continue;
    if (STAY.has(opt)) bailed++; else kept++;
  }

  // ── 019 phone: his texts with the fictional cast in the window ──
  const phone = phoneRaw({ state, from, at, events, isOut, heavyIn });
  // ── 020: dreams he remembers, his own thoughts (ids and codes; the exporter joins the words) ──
  const dreams = dreamsRaw({ from, at, events, isOut, heavyIn });
  const thoughts = thoughtsRaw({ rows: thoughtRows, from, at, getEvent, isOut, heavyIn });

  // ── 018 wallet: this month and the export window ──
  const wallet = walletRaw({ state, world, at, tz, from, getEvent, isOut, heavyIn, events, vit });

  // Heavy onsets of the last 120 days: published journal nights near one are withheld.
  const heavyAt = events(Math.max(Math.floor(finite(state.genesisAt) ? state.genesisAt : at - 120 * 86400), at - 120 * 86400), at, ['heavy.started'])
    .filter((ev) => !isOut(ev.id)).map((ev) => ev.at);

  return {
    at, tz, from, today0, heavyAt, heavyWindowSec: HEAVY_WINDOW_SEC,
    self: { birthdate: str(state.self?.birthdate, 10), homePlaceId: state.self?.homePlaceId ?? null, job: str(world?.self?.job?.title, 60) },
    now, rows, next, places, cast, arcs, votes, scenes, wallet, phone, dreams, thoughts,
    stats: { sleeps, rainyDays: [...rainyDays], plansKept: kept, plansBailed: bailed },
  };
}

function safe(fn) { try { return fn(); } catch { return null; } }

// 019: the phone's raw half — [{ eventId, castId, at, dir }] newest first. A message is listed
// only when it passes the public rule and its thread is a fictional cast member he has now;
// a read failure fails the export (the caller's strict reader throws).
function phoneRaw({ state, from, at, events, isOut, heavyIn }) {
  const castIds = new Set(state.cast instanceof Map ? [...state.cast.keys()] : []);
  const out = [];
  let rows;
  try {
    rows = events(from, at, [...PHONE_TYPES]);
  } catch (err) {
    // An engine without 019 doesn't know the type: no texts. Any other read failure fails the export.
    if (/unknown event type/.test(String(err?.message))) return [];
    throw err;
  }
  for (const ev of rows) {
    if (!ev || ev.type !== 'phone.message' || ev.redacted === true || ev.heavy === true || isOut(ev.id) || heavyIn(ev)) continue;
    if (!PUBLIC_ORIGINS.has(ev.originKind) || ev.subjectJid) continue;
    const p = isObj(ev.payload) ? ev.payload : {};
    const castId = str(p.threadId ?? p.castId, 80);
    if (!castId || !castIds.has(castId) || (p.dir !== 'out' && p.dir !== 'in') || !finite(ev.at)) continue;
    out.push({ eventId: ev.id, castId, at: ev.at, dir: p.dir });
  }
  return out.sort((a, b) => b.at - a.at || b.eventId - a.eventId).slice(0, PHONE_RAW_MAX);
}

// 020 G: a dream's raw half: codes only, under the same rule. The exporter reads the words via publicDreams.
function dreamsRaw({ from, at, events, isOut, heavyIn }) {
  let rows;
  try {
    rows = events(from, at, [...DREAM_TYPES]);
  } catch (err) {
    if (/unknown event type/.test(String(err?.message))) return [];
    throw err;
  }
  const out = [];
  for (const ev of rows) {
    if (!ev || ev.type !== 'dream.had' || ev.redacted === true || ev.heavy === true || isOut(ev.id) || heavyIn(ev)) continue;
    if (!PUBLIC_ORIGINS.has(ev.originKind) || ev.subjectJid) continue;
    const p = isObj(ev.payload) ? ev.payload : {};
    out.push({
      eventId: ev.id, at: ev.at, recall: p.recall, tone: p.tone,
      castIds: Array.isArray(p.castIds) ? p.castIds.filter(x => typeof x === 'string').slice(0, 4) : [],
      placeIds: Array.isArray(p.placeIds) ? p.placeIds.filter(x => typeof x === 'string').slice(0, 4) : [],
    });
  }
  return out.sort((a, b) => b.at - a.at || b.eventId - a.eventId).slice(0, DREAM_RAW_MAX);
}

// 020 F2: which thoughts may be shown: his own, every event it rests on his own too and not heavy, never a `wordless` one (a private
// session's and a heavy stretch's are all of that family). rows: { id, at, family, originKind, originJid, evidence } with no words.
function thoughtsRaw({ rows, from, at, getEvent, isOut, heavyIn }) {
  const out = [];
  for (const t of Array.isArray(rows) ? rows : []) {
    if (!t || !finite(t.at) || t.at < from || t.at > at || t.family === 'wordless') continue;
    if (t.originKind !== 'self' || t.originJid) continue;
    const ok = (Array.isArray(t.evidence) ? t.evidence : []).every((id) => {
      const ev = safe(() => getEvent(id));
      return ev && !ev.redacted && ev.heavy !== true && !isOut(id) && !heavyIn(ev) && PUBLIC_ORIGINS.has(ev.originKind) && !ev.subjectJid;
    });
    if (ok) out.push({ id: t.id, at: t.at });
  }
  return out.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, THOUGHT_RAW_MAX);
}

// 018: the wallet's raw half. entries = listed money events (code-word labels), folded =
// chat / subject spends as { at, amount }. Read from the earlier of the window's start and
// this month's first day. A read failure fails the export (the caller's strict reader throws).
function walletRaw({ state, world, at, tz, from, getEvent, isOut, heavyIn, events, vit }) {
  const p = localParts(at, tz);
  const month = `${p.year}-${String(p.month).padStart(2, '0')}`;
  const monthStart = zonedToUnix(p.year, p.month, 1, 0, 0, tz);
  const homeIds = homeIdsOf(state);
  const places = state.places instanceof Map ? state.places : new Map();
  const entries = [];
  const folded = [];
  for (const ev of events(Math.min(from, monthStart), at, [...WALLET_TYPES])) {
    if (!ev || ev.redacted === true || ev.heavy === true || isOut(ev.id) || heavyIn(ev)) continue;
    const pl = isObj(ev.payload) ? ev.payload : {};
    if (ev.type === 'money.spent' && pl.for === 'setback') continue;
    if (!PUBLIC_ORIGINS.has(ev.originKind) || ev.subjectJid) {
      if (ev.type === 'money.spent' && finite(pl.amount) && pl.amount > 0) folded.push({ at: ev.at, amount: r2(pl.amount) });
      continue;
    }
    if (ev.type === 'money.adjusted' && pl.mode === 'set') continue;
    const m = moneyOf(ev);
    if (!m) continue;
    let travelMode = null;
    if (pl.for === 'travel' && Number.isSafeInteger(ev.causeId)) travelMode = safe(() => getEvent(ev.causeId))?.payload?.mode ?? null;
    const placeId = str(pl.placeId, 80);
    const place = placeId ? places.get(placeId) : null;
    const homeLike = !placeId || homeIds.has(placeId) || place?.kind === 'home' || /\bhome\b/i.test(String(place?.name ?? ''));
    entries.push({
      eventId: ev.id, at: ev.at, dir: m.dir, amount: m.amount, category: m.category,
      label: labelOf(ev, { travelMode, office: place?.kind === 'office' || placeId === state.self?.officePlaceId }),
      placeId: homeLike ? null : placeId,
    });
  }
  const pay = world?.money?.payday;
  const salary = finite(world?.money?.salary) && world.money.salary > 0 && Number.isInteger(pay)
    ? { amount: Math.round(world.money.salary), payday: pay, lastAt: finite(state.money?.lastSalaryAt) ? state.money.lastSalaryAt : null, nextAt: nextPayday(state, world, at, tz) }
    : null;
  return { month, monthStart, since: finite(state.genesisAt) ? state.genesisAt : null, balance: finite(vit.money) ? Math.round(vit.money) : null, salary, entries, folded };
}
