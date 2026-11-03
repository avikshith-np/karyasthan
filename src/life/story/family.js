import { config } from '../../utils/config.js';
import { dateKey, dayStart, addDays, atLocal, localParts, ageOn, zonedToUnix } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { openDecision as openDecisionDefault } from '../decisions.js';
import { check as controlsCheck, sliderValue } from './controls.js';

// Family pressure (spec 010 research R10). Every theme label, occasion and
// option comes from the per-install arc seed's `family` section — this file has
// only the mechanics and no region or culture words (FR-019, SC-011). With no
// `family` section (or no family:* cast member) the family arc is inert and
// familyStatus() says why.
//
// Pulse items (familyItems):
//   call        at story.family.nextCallAt (the first one: a cadence draw after
//               genesis), a family:* member calls: `family.call {castId, themeId,
//               intensity, minutes, pressure, nextCallAt}`. vitals.js adds stress
//               = min(10, intensity × pressure × 10); the reducer stores
//               nextCallAt. pressure = pressureFactor(age, theme, familyPressure)
//               at call time, stored so replay is deterministic.
//   occasion    on its month/day (day null → the 1st): `family.occasion
//               {occasionId, major}`, once per year, within 2 days of the date
//               (a longer outage just misses it).
//   major occ.  7 days before a `major` occasion: `arc.started {category:
//               'family', kind:'occasion'}` + a big `family:<id>` decision
//               (attend|call|skip, never go/late/stay).
//   consequence a committed family arc decision → `arc.ended {outcome:'done'}`
//               (+ a small closeness/tension change for an occasion), caused by
//               the decision's `decision.opened` with commitEventId; an arc whose
//               decision expired or vanished → `arc.ended {outcome:'cancelled'}`.
// Inside the daily item (cast.js deps.rolls.family → dailyRoll):
//   major decisions  the seed's `majorDecisions[]` open as big `family:<id>`
//               decisions (with an `arc.started {kind:'major'}`) when his age ≥
//               fromAge and the theme's fromAge, p/day = 0.01 × pressure, at most
//               one per 90 days and never two at once.
// Controls are checked before anything is offered or appended: family frozen,
// paused (calls, occasions and openers wait; consequences pass), pins on the
// cast member.

export const MAJOR_P = 0.01;
export const MAJOR_GAP_DAYS = 90;
export const OCCASION_LEAD_DAYS = 7;
export const OCCASION_WINDOW_DAYS = 2;
export const ARC_ORPHAN_DAYS = 1;
export const CALL_MINUTES = Object.freeze([5, 40]);
export const CALL_WINDOW = Object.freeze(['18:30', 150]);   // start, minutes of spread
export const CALL_TENSION_AT = 0.5;                          // intensity × pressure above this → tension +0.02
export const CALL_TENSION_DELTA = 0.02;

const DAY = 86400;
const HOUR = 3600;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,47}$/;
const EVENING = ['go', 'late', 'stay'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/>>>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function leadSec(deps = {}) {
  const h = Number(deps.cfg?.bigLeadHours ?? config.arcs?.bigLeadHours);
  return (Number.isFinite(h) && h >= 24 ? h : 24) * HOUR;
}

function familySeed(seed) {
  return isObj(seed?.family) ? seed.family : null;
}

/** family:* cast ids, sorted. */
export function familyMembers(s) {
  const out = [];
  for (const c of s?.cast instanceof Map ? s.cast.values() : []) {
    if (typeof c?.relation === 'string' && c.relation.startsWith('family:') && typeof c.id === 'string') out.push(c.id);
  }
  return out.sort();
}

/** Why the family arc is inert for the Story board ('no_seed_section' | 'no_family_cast'), or null. */
export function familyStatus(s, seed) {
  if (!familySeed(seed)) return { inert: 'no_seed_section' };
  if (!familyMembers(s).length) return { inert: 'no_family_cast' };
  return { inert: null };
}

/**
 * Pressure multiplier (R10): clamp(0.2 + growthPerYear × max(0, age − fromAge),
 * 0, 1) × (0.5 + familyPressure slider). 0..1.5. A missing theme or age → 0.
 */
export function pressureFactor(age, theme, slider = 0.5) {
  if (!finite(age) || !isObj(theme)) return 0;
  const from = finite(theme.fromAge) ? theme.fromAge : 0;
  const g = finite(theme.growthPerYear) ? clamp(theme.growthPerYear, 0, 0.2) : 0;
  const base = clamp(0.2 + g * Math.max(0, age - from), 0, 1);
  const sl = finite(slider) ? clamp(slider, 0, 1) : 0.5;
  return round4(base * (0.5 + sl));
}

function ageAt(s, at) {
  return ageOn(s?.self?.birthdate, at, tzOf(s));
}

function themes(seed) {
  return (Array.isArray(familySeed(seed)?.themes) ? familySeed(seed).themes : [])
    .filter(t => isObj(t) && typeof t.id === 'string' && SLUG_RE.test(t.id));
}

/** Themes his age has reached, in seed order. */
export function eligibleThemes(s, seed, at) {
  const age = ageAt(s, at);
  if (!finite(age)) return [];
  return themes(seed).filter(t => !finite(t.fromAge) || age >= t.fromAge);
}

function cadence(seed) {
  const c = familySeed(seed)?.callCadenceDays;
  if (Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) && c[0] >= 1 && c[1] >= c[0] && c[1] <= 60) {
    return [c[0], c[1]];
  }
  return null;
}

// An evening time `days` after the local day of `from`, from rngFor(date, purpose).
function eveningAfter(from, days, tz, rng) {
  const d0 = addDays(from, days, tz);
  const [start, spread] = CALL_WINDOW;
  const [h, m] = start.split(':').map(Number);
  return atLocal(d0, h * 60 + m + Math.floor(rng() * (spread + 1)), tz);
}

/** When the next call is due: the stored nextCallAt, else a deterministic first call after genesis (or the last call). */
export function nextCallAt(s, seed) {
  const cad = cadence(seed);
  if (!cad) return null;
  const f = s?.story?.family ?? {};
  if (finite(f.nextCallAt) && (!finite(f.lastCallAt) || f.nextCallAt > f.lastCallAt)) return f.nextCallAt;
  const base = finite(f.lastCallAt) ? f.lastCallAt : (finite(s?.genesisAt) ? s.genesisAt : null);
  if (!finite(base)) return null;
  const tz = tzOf(s);
  const rng = rngForDefault(dateKey(base, tz), 'family:first');
  return eveningAfter(base, rng.int(cad[0], cad[1]), tz, rng);
}

// ── Items ─────────────────────────────────────────────────────────────────

function verdictFor(s, action, pinKeys = []) {
  return controlsCheck({ source: 'engine', category: 'family', action, pinKeys }, s);
}

function callItem(s, g, seed, deps) {
  const due = nextCallAt(s, seed);
  if (!finite(due) || due > g) return null;
  const at = Math.max(due, finite(s?.at) ? s.at : due);
  const tz = tzOf(s, deps.world);
  const date = dateKey(at, tz);
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const rng = rf(date, 'family:call');
  const members = familyMembers(s).filter((id) => {
    const away = s?.story?.castLife?.[id]?.away;
    return !(finite(away?.until) && away.until > at);
  });
  const free = members.filter(id => verdictFor(s, 'beat', [id]).ok);
  const v = verdictFor(s, 'beat', []);
  if (!v.ok || !free.length) {
    if (!deps.sim && typeof deps.refuse === 'function' && (!v.ok || members.length)) {
      const w = v.ok ? verdictFor(s, 'beat', [members[0]]) : v;
      try { deps.refuse({ at, source: 'engine', category: 'family', action: 'beat', target: v.ok ? members[0] : null, reason: w.reason, pinKey: w.pinKey ?? null }); } catch { /* log only */ }
    }
    return null;
  }
  const castId = free[Math.floor(rng() * free.length)];
  const elig = eligibleThemes(s, seed, at);
  let theme = null;
  if (elig.length) {
    const total = elig.reduce((a, t) => a + Math.max(0.05, finite(t.intensity) ? t.intensity : 0.3), 0);
    let u = rng() * total;
    theme = elig[elig.length - 1];
    for (const t of elig) { if ((u -= Math.max(0.05, finite(t.intensity) ? t.intensity : 0.3)) < 0) { theme = t; break; } }
  }
  const intensity = theme ? round2(clamp((finite(theme.intensity) ? theme.intensity : 0.3) * (0.7 + 0.6 * rng()), 0, 1)) : 0.1;
  const pressure = theme ? pressureFactor(ageAt(s, at), theme, sliderValue('familyPressure', s)) : 0;
  const minutes = rng.int(CALL_MINUTES[0], CALL_MINUTES[1]);
  const cad = cadence(seed);
  const next = eveningAfter(at, rng.int(cad[0], cad[1]), tz, rng);
  return {
    at, prio: 9, label: 'family:call', id: due,
    run: (add) => {
      const ev = add({
        type: 'family.call', at, actor: 'engine',
        payload: { castId, themeId: theme?.id ?? null, intensity, minutes, pressure, nextCallAt: next },
      });
      if (intensity * pressure > CALL_TENSION_AT) {
        add({ type: 'relationship.changed', at, actor: 'engine', causeId: ev.id, payload: { castId, delta: { tension: CALL_TENSION_DELTA }, reason: 'family_call' } });
      }
    },
  };
}

function occasions(seed) {
  return (Array.isArray(familySeed(seed)?.occasions) ? familySeed(seed).occasions : [])
    .filter(o => isObj(o) && typeof o.id === 'string' && SLUG_RE.test(o.id) && Number.isInteger(o.month) && o.month >= 1 && o.month <= 12);
}

/** The occasion's date in `year` at 10:00 local (day null → the 1st; past the month's end → its last day). */
export function occasionAt(o, year, tz) {
  const dim = new Date(Date.UTC(year, o.month, 0)).getUTCDate();
  const day = Number.isInteger(o.day) && o.day >= 1 ? Math.min(o.day, dim) : 1;
  return zonedToUnix(year, o.month, day, 10, 0, tz);
}

function familyArcs(s) {
  return Object.values(s?.story?.arcs ?? {}).filter(a => isObj(a) && a.category === 'family');
}

function occasionArc(s, occasionId, year) {
  return familyArcs(s).find(a => a.kind === 'occasion' && a.state?.occasionId === occasionId && a.state?.year === year) ?? null;
}

function occasionItems(s, g, seed, deps) {
  const out = [];
  const tz = tzOf(s, deps.world);
  const genesis = finite(s?.genesisAt) ? s.genesisAt : null;
  const sAt = finite(s?.at) ? s.at : g;
  const year = localParts(g, tz).year;
  const done = s?.story?.family?.occasionsDone ?? {};
  const members = familyMembers(s);
  for (const o of occasions(seed)) {
    const at0 = occasionAt(o, year, tz);
    if (genesis === null || at0 < genesis) continue;
    // The day itself.
    if (done[o.id] !== year && at0 <= g && sAt <= at0 + OCCASION_WINDOW_DAYS * DAY && verdictFor(s, 'beat').ok) {
      const at = Math.max(at0, sAt);
      out.push({
        at, prio: 9, label: 'family:occasion', id: `${o.id}:${year}`,
        run: (add) => { add({ type: 'family.occasion', at, actor: 'engine', payload: { occasionId: o.id, major: o.major === true } }); },
      });
    }
    // A major occasion's decision, a week ahead.
    if (o.major === true && done[o.id] !== year && members.length && !occasionArc(s, o.id, year)) {
      const openAt = at0 - OCCASION_LEAD_DAYS * DAY;
      if (openAt <= g && sAt <= at0 - 2 * DAY && genesis <= openAt && verdictFor(s, 'decision', members.slice(0, 4)).ok) {
        const at = Math.max(openAt, sAt);
        const spec = occasionSpec(s, o, at0, members, deps);
        out.push({
          at, prio: 9, label: 'family:occasion_decision', id: `${o.id}:${year}`,
          run: async (add) => {
            const arc = add({
              type: 'arc.started', at, actor: 'engine',
              payload: { category: 'family', kind: 'occasion', castIds: members.slice(0, 4), stage: 'open', state: { occasionId: o.id, year } },
            });
            if (deps.sim) return;
            try { await openWith(deps, { ...spec, arcId: arc.id }, { at, add, causeId: arc.id, state: s }); } catch { /* the orphaned arc is closed by its consequence item */ }
          },
        });
      }
    }
  }
  return out;
}

function homePlace(s, members) {
  for (const id of members) {
    const h = s?.cast?.get?.(id)?.home;
    if (typeof h === 'string' && s?.places instanceof Map && s.places.has(h) && h !== s?.self?.homePlaceId) return h;
  }
  return null;
}

/** The big decision spec for a major occasion (attend|call|skip; labels are code templates around the seed label). */
export function occasionSpec(s, o, eventAt, members, deps = {}) {
  const label = clean(o.label, 60) || 'the occasion';
  return {
    kind: `family:${o.id}`.slice(0, 32),
    category: 'family',
    big: true,
    mode: 'ask',
    decideBy: Math.round(eventAt - DAY),
    subject: { eventAt, placeId: homePlace(s, members), castIds: members.slice(0, 4), minutes: 240 },
    options: [
      { id: 'attend', label: clean(`Be there: ${label}`, 80), go: true, kind: 'visit', minutes: 240 },
      { id: 'call', label: 'Call instead', kind: 'rest', minutes: 30 },
      { id: 'skip', label: 'Skip it', kind: 'rest', minutes: 0, stress: 4 },
    ],
  };
}

async function openWith(deps, spec, { at, add, causeId, state }) {
  const open = typeof deps.openDecision === 'function' ? deps.openDecision : openDecisionDefault;
  const getState = typeof deps.getState === 'function' ? deps.getState : () => state;
  return open(getState, spec, { world: deps.world, at, append: add, causeId: causeId ?? null });
}

const OCCASION_DELTAS = Object.freeze({ attend: { closeness: 0.03 }, call: { closeness: 0.01 }, skip: { tension: 0.03 } });

/**
 * The pulse item that closes one active family arc, or null: its committed
 * decision → `arc.ended {outcome:'done'}` (+ occasion closeness/tension deltas)
 * caused by the decision's decision.opened (commitEventId in the payload); a
 * refused consequence → the terminal decision.expired {frozen|pinned}; an arc
 * whose decision expired, was cancelled, vanished or never opened (after a day)
 * → `arc.ended {outcome:'cancelled'}`.
 */
export function consequence(s, arc, g, deps = {}) {
  if (!isObj(arc) || arc.category !== 'family' || arc.status !== 'active' || !finite(g)) return null;
  const sAt = finite(s?.at) ? s.at : g;
  const ids = Array.isArray(arc.decisionIds) ? arc.decisionIds : [];
  const d = ids.length && s?.decisions instanceof Map ? s.decisions.get(ids[ids.length - 1]) ?? null : null;
  const pinKeys = (arc.castIds ?? []).filter(id => typeof id === 'string');
  if (d && d.status === 'open') return null;
  if (d && d.status === 'committed') {
    const at = Math.max(finite(d.committed?.at) ? d.committed.at : sAt, sAt);
    if (at > g) return null;
    const v = controlsCheck({ source: 'engine', category: 'family', action: 'change', pinKeys }, s);
    if (!v.ok) {
      const reason = v.reason === 'pinned' ? 'pinned' : 'frozen';
      return {
        at, prio: 9, label: 'family:refused', id: d.id,
        run: (add) => { add({ type: 'decision.expired', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, reason } }); },
      };
    }
    const commitEventId = d.committed?.eventId ?? null;
    const delta = arc.kind === 'occasion' ? OCCASION_DELTAS[d.committed?.optionId] : null;
    return {
      at, prio: 9, label: 'family:done', id: d.id,
      run: (add) => {
        if (delta) {
          for (const castId of pinKeys) {
            if (!s?.cast?.has?.(castId)) continue;
            add({ type: 'relationship.changed', at, actor: 'engine', causeId: d.id, payload: { castId, delta, reason: 'decision', ...(commitEventId ? { commitEventId } : {}) } });
          }
        }
        add({ type: 'arc.ended', at, actor: 'engine', causeId: d.id, payload: { arcId: arc.id, outcome: 'done', ...(commitEventId ? { commitEventId } : {}) } });
      },
    };
  }
  // No live decision: expired / cancelled / pruned, or it never opened.
  if (!d && !ids.length && g - arc.startedAt < ARC_ORPHAN_DAYS * DAY) return null;
  if (!controlsCheck({ source: 'engine', category: 'family', action: 'change', pinKeys: [] }, s).ok) return null;
  const at = Math.max(arc.startedAt + (ids.length ? 0 : ARC_ORPHAN_DAYS * DAY), sAt);
  if (at > g) return null;
  return {
    at, prio: 9, label: 'family:cancelled', id: arc.id,
    run: (add) => { add({ type: 'arc.ended', at, actor: 'engine', causeId: arc.id, payload: { arcId: arc.id, outcome: 'cancelled' } }); },
  };
}

/**
 * Every family pulse item due by `g` (story-api §2 familyItems): the call,
 * occasions, major-occasion openers and arc consequences. [] when inert or
 * paused (consequences still pass while paused). deps: { world, openDecision,
 * getState, rngFor, refuse, sim, cfg }.
 */
export function familyItems(s, g, seed, deps = {}) {
  const out = [];
  if (!finite(g) || !s?.story) return out;
  for (const arc of familyArcs(s)) {
    const it = consequence(s, arc, g, deps);
    if (it) out.push(it);
  }
  if (!familySeed(seed) || !familyMembers(s).length || s?.story?.controls?.paused === true) return out;
  const call = callItem(s, g, seed, deps);
  if (call) out.push(call);
  out.push(...occasionItems(s, g, seed, deps));
  return out;
}

// ── Daily roll: major decisions ───────────────────────────────────────────

function majorDecisions(seed) {
  return (Array.isArray(familySeed(seed)?.majorDecisions) ? familySeed(seed).majorDecisions : []).filter((m) => {
    if (!isObj(m) || typeof m.id !== 'string' || !SLUG_RE.test(m.id) || !Array.isArray(m.options)) return false;
    const opts = m.options.filter(o => isObj(o) && typeof o.id === 'string' && OPTION_RE.test(o.id));
    if (opts.length < 2 || opts.length > 4) return false;
    const ids = opts.map(o => o.id);
    // An exact go/late/stay set would make pulse.js rewrite his day as an outing.
    return !(ids.length === 3 && EVENING.every(x => ids.includes(x)));
  });
}

/** The big decision spec for a seed major decision (options and labels are the seed's). */
export function majorSpec(s, m, at, deps = {}) {
  const decideBy = Math.round(at + leadSec(deps) + 48 * HOUR);
  const members = familyMembers(s).slice(0, 4);
  return {
    kind: `family:${m.id}`.slice(0, 32),
    category: 'family',
    big: true,
    mode: 'ask',
    decideBy,
    subject: { eventAt: decideBy, placeId: null, castIds: members, minutes: 30 },
    options: m.options.slice(0, 4).map(o => ({ id: o.id, label: clean(o.label, 60) || o.id, kind: 'rest', minutes: 0 })),
  };
}

/**
 * Adapter for cast.js's daily item (`deps.rolls.family`): maybe open one seed
 * major decision. deps: { openDecision, getState, rngFor, refuse, cfg }.
 * → the outcome for story.daily_done.rolls.family.
 */
export async function dailyRoll({ state, add, at, date, world, seed, sim = false } = {}, deps = {}) {
  const s = state;
  if (!familySeed(seed) || !s?.story || !finite(at)) return { outcome: 'inert' };
  const list = majorDecisions(seed);
  if (!list.length) return { outcome: 'none' };
  const fam = familyArcs(s);
  if (fam.some(a => a.kind === 'major' && a.status === 'active')) return { outcome: 'open' };
  const lastMajor = Math.max(
    finite(s.story.family?.lastMajorAt) ? s.story.family.lastMajorAt : 0,
    ...fam.filter(a => a.kind === 'major' && finite(a.startedAt)).map(a => a.startedAt),
  );
  if (lastMajor > 0 && at - lastMajor < MAJOR_GAP_DAYS * DAY) return { outcome: 'gap' };
  const age = ageAt(s, at);
  const byId = new Map(themes(seed).map(t => [t.id, t]));
  const elig = list.filter((m) => {
    const t = byId.get(m.themeId);
    return t && finite(age) && age >= (finite(m.fromAge) ? m.fromAge : 0) && age >= (finite(t.fromAge) ? t.fromAge : 0);
  });
  if (!elig.length) return { outcome: 'not_eligible' };
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const rng = rf(date ?? dateKey(at, tzOf(s, world)), 'family:major');
  const m = elig[Math.floor(rng() * elig.length)];
  const p = round4(MAJOR_P * pressureFactor(age, byId.get(m.themeId), sliderValue('familyPressure', s)));
  const r = rng();
  if (!(r < p)) return { outcome: 'no', p, roll: round4(r) };
  const v = controlsCheck({ source: 'engine', category: 'family', action: 'decision', pinKeys: familyMembers(s).slice(0, 4) }, s);
  if (!v.ok) {
    if (!sim && typeof deps.refuse === 'function') {
      try { deps.refuse({ at, source: 'engine', category: 'family', action: 'decision', target: null, reason: v.reason, pinKey: v.pinKey ?? null }); } catch { /* log only */ }
    }
    return { outcome: v.reason, p };
  }
  const arc = add({
    type: 'arc.started', at, actor: 'engine',
    payload: { category: 'family', kind: 'major', castIds: familyMembers(s).slice(0, 4), stage: 'open', state: { majorId: m.id } },
  });
  if (sim) return { outcome: 'sim', p };
  try {
    await openWith({ ...deps, world }, { ...majorSpec(s, m, at, deps), arcId: arc.id }, { at, add, causeId: arc.id, state: s });
    return { outcome: 'opened', p, roll: round4(r) };
  } catch {
    return { outcome: 'error', p };
  }
}
