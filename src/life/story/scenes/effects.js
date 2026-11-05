// Scene consequences (spec 016, plan §P2.1/§P2.2, D4/D6). Pure.
//
//   planEffects(s, session, out, ctx) → [{ type, payload }]   appended by worker.commit,
//       each caused by the scene.played (engine actor, same origin). Only for mode 'full'
//       (self/owner origin, fictional cast only) and only while the owner's controls allow
//       (social fate frozen / the Director paused → narration only; a pinned member's
//       effects dropped).
//         1. relationship.changed {castId, delta, reason:'scene'} per member, small/medium
//            steps, |Σ| ≤ 0.05 per metric per scene, closeness/trust ≤ 0.06 per member per
//            local day across scenes; intimacy/passion only for romance-eligible members,
//            passion up only with chemistry ≥ 0.5; closeness/tension dropped when 015's
//            outcome.happened already moved them for this decision.
//         2. arc.started romance onset (D6) through onsetRoll's gates minus the roll.
//         3. scene.followup {castId, from, to, placeId, bias}: an intent to meet again.
//   companionsToUndo(s, { eventOf, childrenOf, now }) → { revert: [ids], kept: [ids], lapse: [followupIds] }
//       (D15, plan §P1.10): the companions (follow-up, romance onset) of a scene that is
//       now out of the log, reverted only when not lived — a follow-up whose decision is
//       not past its point of no return and whose outing hasn't started, an onset arc
//       still 'interested' and active; a lived one is kept. And (R26) an open follow-up
//       whose decision the owner reverted → lapse it, so the pulse never refits it.
//   followupItems(s, g, d) → pulse items for open follow-ups (sim-safe): fit a slot
//       (goals.fitSlot) → decision.opened {followupId} + a code lean (NOT committed: the
//       normal deadline commit decides); lapse at the window end, on a departure, or
//       while the social fate is frozen.
import { check as controlsCheck, pinKeysFor, isPaused, fateOf, sliderFactor } from '../controls.js';
import { romanceEligible, metricsOf, activeRomance, THRESHOLDS } from '../romance.js';
import { isHomeKind, isPrivatePlace } from '../../places.js';
import { dateKey, dayStart, addDays, atLocal } from '../../clock.js';
import { fitSlot } from '../goals.js';
import { rngFor as rngForDefault } from '../../rng.js';
import { isExcludedId } from '../../projector.js';

const DAY = 86400;
const MIN = 60;
export const STEP = Object.freeze({
  closeness: { small: 0.02, medium: 0.04 }, intimacy: { small: 0.02, medium: 0.04 }, passion: { small: 0.02, medium: 0.04 },
  trust: { small: 0.01, medium: 0.02 }, tension: { small: 0.02, medium: 0.05 },
});
export const PER_SCENE_MAX = 0.05;
export const PER_DAY_MAX = 0.06;          // closeness / trust per member per local day across scenes
export const ONSET_CHEMISTRY = 0.75;
export const ONSET_CLERK_CHEMISTRY = 0.85;
export const ONSET_GAP_DAYS = 30;
export const FOLLOWUP_CHEMISTRY = 0.6;
export const FOLLOWUP_DAYS = 7;
export const FOLLOWUPS_PER_DAY = 2;
const FIT_AFTER_WAKE_MIN = 30;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Why a full scene gets no effects now, or null (controls: paused, social frozen). */
export function effectsBlocked(s, session) {
  if (session.mode !== 'full') return session.mode === 'self_only' ? 'real_person' : 'chat_origin';
  if (isPaused(s)) return 'paused';
  if (fateOf('social', s) === 'frozen') return 'frozen';
  return null;
}

function memberAllowed(s, castId) {
  const keys = pinKeysFor({ type: 'relationship.changed', payload: { castId } }, s);
  return controlsCheck({ source: 'engine', category: 'social', action: 'change', pinKeys: keys }, s).ok;
}

/**
 * The effects of a validated scene. ctx: { tier, fellBack, at, tz, seed,
 * todayScene: {castId: {closeness, trust}} (abs sums already applied today),
 * outcomeHappened (bool), lastOnsetAt (raw log: newest scene-caused onset or null) }
 */
export function planEffects(s, session, out, ctx = {}) {
  if (effectsBlocked(s, session)) return [];
  const list = [];
  const chem = finite(out.chemistry) ? out.chemistry : 0;
  const after = {};   // castId → metrics after the deltas (romance gates)
  for (const castId of session.castIds) {
    if (!memberAllowed(s, castId)) continue;
    const eligible = romanceEligible(s, castId);
    const sum = {};
    for (const e of out.effects ?? []) {
      if (e.castId !== castId) continue;
      if ((e.metric === 'intimacy' || e.metric === 'passion') && !eligible) continue;
      if (e.metric === 'passion' && e.dir === 'up' && chem < 0.5) continue;
      if (ctx.outcomeHappened && (e.metric === 'closeness' || e.metric === 'tension')) continue;
      const v = STEP[e.metric]?.[e.size] ?? 0;
      sum[e.metric] = (sum[e.metric] ?? 0) + (e.dir === 'up' ? v : -v);
    }
    const delta = {};
    for (const [k, v] of Object.entries(sum)) {
      let d = clamp(v, -PER_SCENE_MAX, PER_SCENE_MAX);
      if (k === 'closeness' || k === 'trust') {
        const used = Math.abs(ctx.todayScene?.[castId]?.[k] ?? 0);
        const room = Math.max(0, PER_DAY_MAX - used);
        d = clamp(d, -room, room);
      }
      if (r3(d) !== 0) delta[k] = r3(d);
    }
    const m = metricsOf(s, castId);
    after[castId] = { ...m, passion: clamp(m.passion + (delta.passion ?? 0), 0, 1) };
    if (Object.keys(delta).length) list.push({ type: 'relationship.changed', payload: { castId, delta, reason: 'scene' } });
  }

  // Romance onset (D6): onsetRoll's gates without the roll.
  const focus = out.focus;
  const okTier = ctx.tier === 'mind' ? ctx.fellBack !== true : chem >= ONSET_CLERK_CHEMISTRY;
  const appetite = sliderFactor('romanceAppetite', s);   // 0.5 … 1.5
  const cool = s?.story?.romance?.cooldownUntil;
  if (focus && okTier && isObj(ctx.seed?.romance) && !activeRomance(s) && !s?.story?.romance?.arcId
    && !(finite(cool) && finite(ctx.at) && ctx.at < cool)
    && romanceEligible(s, focus) && chem >= Math.min(1, ONSET_CHEMISTRY / appetite)
    && ['swapped_numbers', 'plan_to_meet'].includes(out.ending)
    && (after[focus]?.passion ?? 0) >= THRESHOLDS.interested.passion
    && !(finite(ctx.lastOnsetAt) && finite(ctx.at) && ctx.at - ctx.lastOnsetAt < ONSET_GAP_DAYS * DAY)) {
    const ev = { type: 'arc.started', payload: { category: 'romance', kind: 'romance', castIds: [focus], stage: 'interested', reason: 'scene' } };
    const v = controlsCheck({ source: 'engine', category: 'romance', action: 'start', pinKeys: pinKeysFor(ev, s) }, s);
    if (v.ok) list.push(ev);
  }

  // Follow-up intent.
  const f = followupFor(s, session, out, ctx);
  if (f) list.push({ type: 'scene.followup', payload: f });
  return list;
}

function busyWith(s, castId) {
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    if ((d?.status === 'open' || d?.status === 'committed') && d.category === 'social'
      && Array.isArray(d.subject?.castIds) && d.subject.castIds.includes(castId)) {
      if (d.status === 'open') return true;
      const end = d.subject?.endAt ?? d.subject?.eventAt;
      if (finite(end) && finite(s.at) && end > s.at) return true;
    }
  }
  return false;
}

function followupFor(s, session, out, ctx) {
  const castId = out.focus;
  if (!castId || !s?.cast?.has?.(castId)) return null;
  // Something concrete was decided with them: that plan replaces the vague intent.
  if ((out.plans ?? []).some(p => (p.who ?? []).includes(castId))) return null;
  const chem = finite(out.chemistry) ? out.chemistry : 0;
  if (!(out.ending === 'plan_to_meet' || (out.ending === 'swapped_numbers' && chem >= FOLLOWUP_CHEMISTRY))) return null;
  if (!memberAllowed(s, castId)) return null;
  const at = ctx.at;
  const away = s.story?.castLife?.[castId]?.away;
  if (finite(away?.until) && finite(at) && away.until > at) return null;
  if (busyWith(s, castId)) return null;
  const fs = Object.values(isObj(s.story?.followups) ? s.story.followups : {});
  if (fs.some(x => x.castId === castId && (x.status === 'open' || x.status === 'fitted'))) return null;
  if (fs.some(x => x.castId === castId && finite(x.at) && at - x.at < FOLLOWUP_DAYS * DAY)) return null;
  if (fs.filter(x => finite(x.at) && dateKey(x.at, ctx.tz) === dateKey(at, ctx.tz)).length >= FOLLOWUPS_PER_DAY) return null;
  const tomorrow = addDays(dayStart(at, ctx.tz), 1, ctx.tz);
  const from = atLocal(tomorrow, '17:00', ctx.tz);
  const to = from + FOLLOWUP_DAYS * DAY;
  const pid = session.placeId && !isHomeKind(s, session.placeId) && !isPrivatePlace(s, session.placeId) ? session.placeId : null;
  return { castId, from, to, placeId: pid, kind: 'meet', bias: Math.round(clamp(0.5 + chem, 0, 2) * 100) / 100 };
}

// ── companions (D15, R17, R26) ───────────────────────────────────────────────

/** Is this follow-up lived (its decision past the point of no return, or its outing started)? */
export function followupLived(s, f, now) {
  const d = Number.isSafeInteger(f?.decisionId) && s?.decisions instanceof Map ? s.decisions.get(f.decisionId) : null;
  return !!d && ((finite(d.ponrAt) && d.ponrAt <= now) || (finite(d.subject?.eventAt) && d.subject.eventAt <= now));
}

/** See the module comment. eventOf(id) / childrenOf(id): log reads (a throw → nothing done for that one). */
export function companionsToUndo(s, { eventOf = () => null, childrenOf = () => [], now = s?.at } = {}) {
  const out = { revert: [], kept: [], lapse: [] };
  if (!isObj(s?.story)) return out;
  const t = finite(now) ? now : s.at;
  const gone = (id) => Number.isSafeInteger(id) && isExcludedId(s, id);
  for (const f of Object.values(isObj(s.story.followups) ? s.story.followups : {})) {
    if (!isObj(f) || !['open', 'fitted', 'done'].includes(f.status)) continue;
    if (gone(f.sceneEventId)) {
      (followupLived(s, f, t) ? out.kept : out.revert).push(f.id);
      continue;
    }
    // R26: the owner reverted its decision (the revert set, not a rewind range) → lapse, never refit.
    if (f.status !== 'open' || !(s.excluded instanceof Set)) continue;
    let kids = [];
    try { kids = childrenOf(f.id); } catch { kids = []; }
    if (kids.some(e => e?.type === 'decision.opened' && e.payload?.followupId === f.id && s.excluded.has(e.id))) out.lapse.push(f.id);
  }
  // A plan the scene made (2026-11-05): goes with the scene unless he has already set off for it.
  for (const d of s.decisions instanceof Map ? s.decisions.values() : []) {
    if (!Number.isSafeInteger(d?.sceneEventId) || !gone(d.sceneEventId) || isExcludedId(s, d.id)) continue;
    ((finite(d.ponrAt) && d.ponrAt <= t) || (finite(d.subject?.eventAt) && d.subject.eventAt <= t) ? out.kept : out.revert).push(d.id);
  }
  for (const a of Object.values(isObj(s.story.arcs) ? s.story.arcs : {})) {
    if (!isObj(a) || a.category !== 'romance') continue;
    let ev = null;
    try { ev = eventOf(a.id); } catch { ev = null; }
    const sid = ev?.type === 'arc.started' ? ev.payload?.sceneEventId : null;
    if (!gone(sid)) continue;
    (a.stage === 'interested' && a.status === 'active' ? out.revert : out.kept).push(a.id);
  }
  return out;
}

// ── follow-up pulse items (pure; sim-safe) ───────────────────────────────────

function item(key, at, label, id, run) {
  return { key, at, prio: 9, label, id, run };
}

/** Open follow-ups → lapse or a fitted decision (plan §P2.2). d: itemDeps ({ world, rngFor }). */
export function followupItems(s, g, d = {}) {
  const fs = isObj(s?.story?.followups) ? s.story.followups : null;
  if (!fs) return [];
  const world = d.world;
  const rf = typeof d.rngFor === 'function' ? d.rngFor : rngForDefault;
  const tz = s?.world?.timezone || world?.timezone;
  const sAt = finite(s?.at) ? s.at : g;
  const out = [];
  for (const f of Object.values(fs).sort((a, b) => a.id - b.id)) {
    if (!isObj(f) || f.status !== 'open') continue;
    const lapse = (reason, at) => item(`followup:lapse:${f.id}`, at, 'scene:followup_lapse', f.id, (add) => {
      add({ type: 'scene.followup_lapsed', at, actor: 'engine', causeId: f.id, payload: { followupId: f.id, castId: f.castId, reason } });
    });
    if (g >= f.to) { const at = Math.max(f.to, sAt); if (at <= g) out.push(lapse('window', at)); continue; }
    if (!(s.cast instanceof Map) || !s.cast.has(f.castId)) { if (sAt <= g) out.push(lapse('departed', sAt)); continue; }
    if (fateOf('social', s) === 'frozen') { if (sAt <= g) out.push(lapse('frozen', sAt)); continue; }
    const plan = s.plan;
    if (s.activity?.kind === 'sleep' || !plan || !finite(plan.wakeAt)) continue;
    const at = Math.max(plan.wakeAt + FIT_AFTER_WAKE_MIN * MIN, f.from, sAt);
    if (at > g || at >= f.to || plan.date !== dateKey(at, tz)) continue;
    let fit;
    try { fit = fitSlot(s, at, world, { id: f.id, castId: f.castId, placeId: f.placeId, from: f.from, to: f.to }, { rngFor: rf }); } catch { fit = null; }
    if (!fit?.ok || !fit.payload) continue;   // no room now: tried again at a later tick / day
    const payload = {
      ...fit.payload,
      options: fit.payload.options.map(o => (o.id === 'go' && finite(f.bias) && f.bias > 0 ? { ...o, bias: f.bias } : o)),
    };
    out.push(item(`followup:fit:${f.id}`, at, 'scene:followup_fit', f.id, (add) => {
      const opened = add({ type: 'decision.opened', at, actor: 'engine', causeId: f.id, payload });
      const p = Math.round(clamp(0.5 + (f.bias - 0.5) * 0.4, 0.3, 0.9) * 100) / 100;
      add({
        type: 'decision.lean', at, actor: 'engine', causeId: opened.id,
        payload: { decisionId: opened.id, optionId: 'go', p, probs: { go: p, late: Math.round((1 - p) * 40) / 100, stay: Math.round((1 - p) * 60) / 100 }, trigger: 'new_info', fallback: 'scene_followup' },
      });
    }));
  }
  return out;
}
