import { INTERVIEW_MIN } from '../planWeight.js';
import { config } from '../../utils/config.js';
import { dateKey, dayStart, addDays, atLocal, localParts } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { dayType, routineOf } from '../routine.js';
import { overridesFor } from '../planEdits.js';   // 014 sched
import { openDecision as openDecisionDefault } from '../decisions.js';
import { choice } from '../../brain/jev.js';
import { worldOverlay } from './reducer.js';
import { check as controlsCheck, sliderFactor } from './controls.js';

// Career (spec 010 research R9): the yearly appraisal, the job hunt, interviews,
// offers and the job change. Pure planning over the projection; the pulse's
// `add` appends, `deps.openDecision` (the facade passes
// decisionsGlue.openArcDecision: big/guided → an Ask-me card, lead time) opens
// decisions, `deps.askJev` answers the appraisal. Never a store write
// (refusals go through deps.refuse) and never a throw out of an item.
//
// Inside the daily item (cast.js deps.rolls.career → dailyRoll):
//   appraisal   on a workday of the seed's `career.appraisalMonth` while
//               lastAppraisalYear < year: one `career.appraisal {year, band, pct,
//               salaryFrom, salaryTo, score, probs, fallback?}`. The band score
//               comes from the last 365 days of story.workLog + manager tension;
//               the probabilities from Jev (caller life.arc.appraisal, choice over
//               poor|fair|good|great), else softmax(score) with `fallback`; the
//               band is drawn once (rngFor(date, 'career:appraisal')) and stored.
//               The salary change lies in the seed's [min, max] ∩ [−5, +20] %.
//               No month in the seed → inert (careerStatus says so).
//   hunt        no hunt and no notice: p/day from a poor appraisal (last 90 d),
//               manager tension ≥ 0.6, or ≥ 2 years in role, × careerAmbition →
//               `arc.started {category:'career', kind:'hunt', stage:'searching'}` +
//               `career.hunt {arcId, phase:'started', reason}`. The new job's office
//               is another existing office-kind place, else the current one; a
//               `place.created` office near a seed `officeAreas` anchor
//               (newOfficePlace) only with deps.allowNewOffice, because
//               routine/travel cannot see event-created places yet.
//   interview   while the hunt is `searching` with nothing pending: p/day →
//               a `career:interview` decision (go|skip, never go/late/stay) on a
//               workday 2–7 days ahead, inside work hours, at the hunt's office, so
//               009's costs see the work conflict and travel.
//   upkeep      a stale `offer` stage (the offer expired) → back to `searching`;
//               a hunt searching for 180 days ends (fizzled).
//
// Pulse items (huntItems), every one caused by the decision's own
// `decision.opened` (self) with `commitEventId` in the payload (R14 item 8):
//   interview outcome  at the interview's end, a committed `go` rolls once
//               (rngFor(date, 'career:interview:<id>')) → an offer decision
//               (`career:offer`, big, accept|decline) and `arc.stage → offer`, or
//               `arc.stage → searching` (that stage move is the "done" marker).
//   offer accept       → `career.resigned {decisionId, noticeUntil, toEmployer,
//               toTitle, toOfficePlaceId}` + `arc.stage → notice` (accepting is the
//               resignation; there is no separate resign card).
//   offer decline      → `arc.stage → searching`.
//   job change         at notice.until → `career.job_changed`, `career.hunt
//               {phase:'ended'}`, `arc.ended {outcome:'done'}`; driven from
//               story.career.notice so it never depends on the decision surviving
//               pruning.
// A consequence the controls now refuse: the terminal `decision.expired
// {reason:'frozen'|'pinned'}` closes the committed decision (R6). The job change
// is the exception: it is HELD (not offered, a refusal logged) while `self.job`
// is pinned or career is frozen — the reducer clears `notice` only on
// job_changed, so a terminal expiry would strand it. It happens when the pin or
// freeze lifts.
//
// worldOverlay (reducer) is the only overlay builder: salary and office reads
// go through it. Employer names and titles come from the seed only.

export const BANDS = Object.freeze(['poor', 'fair', 'good', 'great']);
export const BAND_LABELS = Object.freeze({ poor: 'below expectations', fair: 'mixed', good: 'meets expectations', great: 'exceeds expectations' });
export const PCT_LIMITS = Object.freeze([-5, 20]);
export const HUNT_P = Object.freeze({ poor_appraisal: 0.08, manager_tension: 0.02, long_tenure: 0.004 });
/** 015: p/day of starting a hunt while out of work. */
export const HUNT_P_UNEMPLOYED = 0.25;
export const HUNT_POOR_WINDOW_DAYS = 90;
export const HUNT_TENSION = 0.6;
export const HUNT_TENURE_YEARS = 2;
export const HUNT_COOLDOWN_DAYS = 120;
export const HUNT_MAX_DAYS = 180;
export const INTERVIEW_P = 0.12;
export { INTERVIEW_MIN };
export const INTERVIEW_BIAS = 2.5;
export const OFFER_P = 0.35;
export const OFFER_P_MAX = 0.6;
export const OFFER_STALE_DAYS = 1;
export const NOTICE_DEFAULT_DAYS = 30;
export const TAU = 0.5;
export const MAX_PLACES = 48;
export const NEW_OFFICE_MAX_KM = 5;
export const REGION_MARGIN_KM = 10;

const DAY = 86400;
const HOUR = 3600;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '');
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/>>>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function leadSec(deps = {}) {
  const h = Number(deps.cfg?.bigLeadHours ?? config.arcs?.bigLeadHours);
  return (Number.isFinite(h) && h >= 24 ? h : 24) * HOUR;
}

function careerOf(s) {
  return isObj(s?.story?.career) ? s.story.career : {};
}

function verdict(s, refusals, { category = 'career', action, pinKeys = [], target = null }) {
  const v = controlsCheck({ source: 'engine', category, action, pinKeys }, s);
  if (!v.ok && refusals) refusals.push({ source: 'engine', category, action, target, reason: v.reason, pinKey: v.pinKey ?? null });
  return v;
}

function refuseAll(deps, rows, at, sim) {
  if (sim || typeof deps.refuse !== 'function') return;
  for (const r of rows) {
    try { deps.refuse({ ...r, at }); } catch { /* operational log only */ }
  }
}

/** The seed's career section, or null. */
function careerSeed(seed) {
  return isObj(seed?.career) ? seed.career : null;
}

/** Why the career arc is (partly) inert for the Story board, or null. */
export function careerStatus(s, seed) {
  const c = careerSeed(seed);
  if (!c) return { inert: 'no_seed_section' };
  if (!Number.isInteger(c.appraisalMonth) || c.appraisalMonth < 1 || c.appraisalMonth > 12) return { inert: 'no_appraisal_month' };
  return { inert: null };
}

// ── Appraisal ─────────────────────────────────────────────────────────────

/**
 * Is the yearly appraisal due on the local day of `at`? A workday (office|wfh)
 * of the seed's month while lastAppraisalYear < year; downtime-tolerant (the
 * first workday the pass runs on in that month), exactly once per year.
 * → { due, reason?, year, month }
 */
export function appraisalDue(s, at, seed, world = null) {
  const tz = tzOf(s, world);
  if (!finite(at)) return { due: false, reason: 'invalid' };
  const p = localParts(at, tz);
  const month = careerSeed(seed)?.appraisalMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12) return { due: false, reason: 'no_appraisal_month', year: p.year };
  if (p.month !== month) return { due: false, reason: 'not_month', year: p.year, month };
  const last = careerOf(s).lastAppraisalYear;
  if (Number.isInteger(last) && last >= p.year) return { due: false, reason: 'done', year: p.year, month };
  // 015: out of work (an owner fire / quit) — no appraisal.
  if (careerOf(s).employed === false) return { due: false, reason: 'unemployed', year: p.year, month };
  if (world) {
    // 014 sched: an override's day off is no workday for the appraisal.
    const type = dayType(dayStart(at, tz), worldOverlay(s, world), s?.vitals ?? {}, { overrides: overridesFor(s, dateKey(at, tz)) });
    if (type !== 'office' && type !== 'wfh') return { due: false, reason: 'not_workday', year: p.year, month };
  }
  return { due: true, year: p.year, month };
}

/**
 * The appraisal's code score (−2…2) from the last 365 days of story.workLog
 * (late days and crunches = effort, sick days and stress = strain) and the
 * manager's tension, with the inputs Jev gets.
 */
export function appraisalScore(s, at = s?.at) {
  const tz = tzOf(s);
  const from = finite(at) ? dateKey(at - 365 * DAY, tz) : '';
  const days = (Array.isArray(s?.story?.workLog?.days) ? s.story.workLog.days : []).filter(d => isObj(d) && d.date >= from);
  let lateDays = 0; let crunches = 0; let sickDays = 0; let stressSum = 0; let stressN = 0;
  for (const d of days) {
    if (d.late > 0) lateDays++;
    crunches += finite(d.crunch) ? d.crunch : 0;
    sickDays += finite(d.sick) ? d.sick : 0;
    if (finite(d.stress)) { stressSum += d.stress; stressN++; }
  }
  const meanStress = stressN ? round2(stressSum / stressN) : null;
  const tensionWithManager = managerTension(s);
  const c = careerOf(s);
  const yearsInRole = finite(c.startedAt) && finite(at) ? round2(Math.max(0, at - c.startedAt) / (365 * DAY)) : 0;
  const effort = Math.min(1, (lateDays + crunches) / 40);
  const sick = Math.min(1, sickDays / 15);
  const strain = meanStress === null ? 0 : clamp((meanStress - 40) / 40, -1, 1);
  const score = round4(clamp(0.2 + 0.8 * effort - sick - 0.6 * strain - 0.8 * tensionWithManager, -2, 2));
  return { score, lateDays, crunches, sickDays, meanStress, tensionWithManager: round2(tensionWithManager), yearsInRole };
}

function managerTension(s) {
  let t = 0;
  for (const c of s?.cast instanceof Map ? s.cast.values() : []) {
    if (c?.relation === 'manager' && finite(c.metrics?.tension)) t = Math.max(t, c.metrics.tension);
  }
  return clamp(t, 0, 1);
}

/** softmax over the bands with U_k = score × (k − 1.5) (the code fallback). */
export function fallbackProbs(score) {
  const us = BANDS.map((_, k) => (finite(score) ? score : 0) * (k - 1.5) / TAU);
  const m = Math.max(...us);
  const ex = us.map(u => Math.exp(u - m));
  const z = ex.reduce((a, b) => a + b, 0);
  return Object.fromEntries(BANDS.map((b, k) => [b, round4(ex[k] / z)]));
}

/** Only known bands with finite, non-negative probabilities, renormalised; null when none. */
export function cleanBandProbs(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const b of BANDS) if (finite(v[b]) && v[b] >= 0) out[b] = v[b];
  const z = Object.values(out).reduce((a, b) => a + b, 0);
  if (!(z > 0)) return null;
  for (const b of Object.keys(out)) out[b] = round4(out[b] / z);
  return out;
}

/** A band from probabilities: drawn with `rng` (r() → [0,1)) or the argmax without it. */
export function bandFromProbs(probs, rng = null) {
  const p = cleanBandProbs(probs);
  if (!p) return 'fair';
  if (typeof rng !== 'function') return BANDS.reduce((best, b) => ((p[b] ?? -1) > (p[best] ?? -1) ? b : best), 'fair');
  let u = rng();
  for (const b of BANDS) { if ((u -= (p[b] ?? 0)) < 0) return b; }
  return BANDS.filter(b => (p[b] ?? 0) > 0).pop() ?? 'fair';
}

/** Salary change % for a band inside the seed's [min, max] ∩ [−5, 20]. */
export function bandPct(band, seed, rng) {
  const sc = careerSeed(seed)?.salaryChangePct;
  const min = clamp(finite(sc?.min) ? sc.min : 0, PCT_LIMITS[0], 0);
  const max = clamp(finite(sc?.max) ? sc.max : 0, 0, PCT_LIMITS[1]);
  const ranges = { poor: [min, 0], fair: [0, 0.3 * max], good: [0.3 * max, 0.7 * max], great: [0.7 * max, max] };
  const [lo, hi] = ranges[band] ?? [0, 0];
  const u = typeof rng === 'function' ? rng() : 0.5;
  return round2(clamp(lo + (hi - lo) * u, min, max));
}

/**
 * The appraisal event for `at` (call only when appraisalDue). Jev answers the
 * band probabilities; any failure (no client, budget, error, junk) → the code
 * fallback with `fallback` set (a spent ARCS_JEV_MAX_PER_DAY → 'budget'). Never
 * throws. deps: { askJev, rngFor, world, sim }.
 */
export async function appraise(s, at, seed, deps = {}) {
  const tz = tzOf(s, deps.world);
  const date = dateKey(at, tz);
  const year = localParts(at, tz).year;
  const sc = appraisalScore(s, at);
  let probs = null;
  let fallback = null;
  if (deps.sim === true) fallback = 'sim';
  else if (typeof deps.askJev !== 'function') fallback = 'no_jev';
  else {
    try {
      const criteria = Object.fromEntries(BANDS.map(b => [b, BAND_LABELS[b]]));
      const res = await deps.askJev({
        state: sc,
        questions: { band: choice('Which appraisal outcome is most likely?', criteria) },
        caller: 'life.arc.appraisal',
      });
      probs = cleanBandProbs(res?.answers?.band?.probabilities);
      if (!probs) fallback = 'jev_invalid';
    } catch (err) {
      fallback = err?.name === 'BudgetError' ? 'jev_budget' : err?.code === 'jev_cap' ? 'budget' : 'jev_error';
    }
  }
  if (!probs) probs = fallbackProbs(sc.score);
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const rng = rf(date, 'career:appraisal');
  const band = bandFromProbs(probs, rng);
  const pct = bandPct(band, seed, rng);
  const w = deps.world ? worldOverlay(s, deps.world) : null;
  const from = finite(w?.money?.salary) ? w.money.salary : (finite(careerOf(s).salary) ? careerOf(s).salary : null);
  return {
    type: 'career.appraisal', at, actor: 'engine',
    payload: {
      year, band, pct,
      ...(from !== null ? { salaryFrom: from, salaryTo: Math.round(from * (1 + pct / 100)) } : {}),
      score: sc.score, probs, ...(fallback ? { fallback } : {}),
    },
  };
}

// ── Hunt helpers ──────────────────────────────────────────────────────────

/** The active hunt arc, or null. */
export function huntArc(s) {
  const id = careerOf(s).huntArcId;
  const arc = id ? s?.story?.arcs?.[id] : null;
  return isObj(arc) && arc.status === 'active' && arc.category === 'career' ? arc : null;
}

const stageKey = (arc) => `arc:${arc.id}.stage`;

function decisionsOf(s, arcId) {
  const out = [];
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) if (d?.arcId === arcId) out.push(d);
  return out.sort((a, b) => a.id - b.id);
}

function interviewEnd(d) {
  return finite(d?.subject?.eventAt) ? d.subject.eventAt + INTERVIEW_MIN * 60 : null;
}

/** Decisions of the hunt still in flight (open, or committed with an unprocessed consequence). */
export function pendingInHunt(s, arc) {
  return decisionsOf(s, arc.id).filter((d) => {
    if (d.status === 'open') return true;
    if (d.status !== 'committed') return false;
    if (d.kind === 'career:interview') return d.committed?.optionId === 'go' && arc.stage === 'searching' && finite(arc.stageAt) && arc.stageAt < interviewEnd(d);
    if (d.kind === 'career:offer') return arc.stage === 'offer';
    return false;
  });
}

/** Seed employers other than the current one (names only). */
function otherEmployers(s, seed) {
  const cur = norm(careerOf(s).employerName);
  const list = Array.isArray(careerSeed(seed)?.employers) ? careerSeed(seed).employers : [];
  return list.map(e => clean(typeof e === 'string' ? e : e?.name, 80)).filter(n => n && norm(n) !== cur);
}

/**
 * The offer's terms, recomputed deterministically from (arcId, opensAt) so the
 * card label and the accept consequence agree: an employer from the seed (not
 * the current one) and a seed title (the next one up when the current title is
 * in the list, with p = 0.6). null when the seed names no other employer.
 */
export function offerTerms(s, seed, { arcId, opensAt }) {
  const employers = otherEmployers(s, seed);
  if (!employers.length || !finite(opensAt)) return null;
  const rng = rngForDefault(dateKey(opensAt, tzOf(s)), `career:offer:${arcId}:${opensAt}`);
  const employerName = employers[Math.floor(rng() * employers.length)];
  const titles = (Array.isArray(careerSeed(seed)?.titles) ? careerSeed(seed).titles : []).map(t => clean(t, 60)).filter(Boolean);
  const cur = careerOf(s).title;
  let title = clean(cur, 60) || titles[0] || null;
  if (titles.length) {
    const i = titles.findIndex(t => norm(t) === norm(cur));
    const r = rng();
    if (i >= 0 && i + 1 < titles.length && r < 0.6) title = titles[i + 1];
    else if (i < 0) title = titles[Math.floor(r * titles.length)];
  }
  return { employerName, title };
}

// The place a hunt interviews at and a new job moves to: another office-kind
// place (lowest id), else null (the caller may create one, else the current office).
export function huntOfficePlaceId(s) {
  const cur = careerOf(s).officePlaceId ?? s?.self?.officePlaceId ?? null;
  const ids = s?.places instanceof Map ? [...s.places.values()].filter(p => p?.kind === 'office' && p.id !== cur).map(p => p.id).sort() : [];
  return ids[0] ?? null;
}

// Region box = genesis places' bounding box + 10 km (research R20; no region names).
function regionBox(world) {
  const pts = (Array.isArray(world?.places) ? world.places : world?.places instanceof Map ? [...world.places.values()] : [])
    .filter(p => finite(p?.lat) && finite(p?.lon));
  if (!pts.length) return null;
  const lats = pts.map(p => p.lat);
  const lons = pts.map(p => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = REGION_MARGIN_KM / 111;
  const dLon = REGION_MARGIN_KM / (111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180)));
  return { minLat: Math.min(...lats) - dLat, maxLat: Math.max(...lats) + dLat, minLon: Math.min(...lons) - dLon, maxLon: Math.max(...lons) + dLon };
}

/**
 * A `place.created` descriptor for a new office near a seed `officeAreas` anchor
 * (offset ≤ min(maxKm, 5) km, a code bearing, inside the region box, ≤ 48
 * places), or null. Name and kind are code words.
 */
export function newOfficePlace(s, seed, world, rng, at) {
  const areas = Array.isArray(careerSeed(seed)?.officeAreas) ? careerSeed(seed).officeAreas : [];
  const places = s?.places instanceof Map ? s.places : new Map();
  if (!areas.length || places.size >= MAX_PLACES) return null;
  const box = regionBox(world);
  const area = areas[Math.floor(rng() * areas.length)];
  const anchor = typeof area?.near === 'string' ? places.get(area.near) : null;
  if (!box || !anchor || !finite(anchor.lat) || !finite(anchor.lon)) return null;
  const maxKm = Math.min(NEW_OFFICE_MAX_KM, finite(area.maxKm) && area.maxKm > 0 ? area.maxKm : NEW_OFFICE_MAX_KM);
  const km = 0.5 + rng() * Math.max(0, maxKm - 0.5);
  const bearing = rng() * 2 * Math.PI;
  const lat = round4(anchor.lat + (km * Math.cos(bearing)) / 111);
  const lon = round4(anchor.lon + (km * Math.sin(bearing)) / (111 * Math.max(0.1, Math.cos(anchor.lat * Math.PI / 180))));
  if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) return null;
  let n = 2;
  while (places.has(`place:office-${n}`) && n < 100) n++;
  const id = `place:office-${n}`;
  if (!PLACE_ID_RE.test(id) || places.has(id)) return null;
  return { type: 'place.created', at, actor: 'engine', payload: { id, name: `Office ${n}`, kind: 'office', lat, lon } };
}

/** Why a hunt would start today, strongest first, with its base p; null when none. */
export function huntTrigger(s, at, { band = null } = {}) {
  const c = careerOf(s);
  // 015: out of work he looks for work, first of all.
  if (c.employed === false) return { reason: 'unemployed', p: HUNT_P_UNEMPLOYED };
  const recentPoor = band === 'poor'
    || (c.lastAppraisal?.band === 'poor' && finite(c.lastAppraisal.at) && at - c.lastAppraisal.at <= HUNT_POOR_WINDOW_DAYS * DAY);
  if (recentPoor) return { reason: 'poor_appraisal', p: HUNT_P.poor_appraisal };
  if (managerTension(s) >= HUNT_TENSION) return { reason: 'manager_tension', p: HUNT_P.manager_tension };
  if (finite(c.startedAt) && at - c.startedAt >= HUNT_TENURE_YEARS * 365 * DAY) return { reason: 'long_tenure', p: HUNT_P.long_tenure };
  return null;
}

function lastHuntEndedAt(s) {
  let t = null;
  for (const a of Object.values(s?.story?.arcs ?? {})) {
    if (a?.category === 'career' && a.kind === 'hunt' && a.status !== 'active' && finite(a.endedAt)) t = Math.max(t ?? 0, a.endedAt);
  }
  return t;
}

/** A workday 2–7 days ahead and a time inside work hours, or null. */
function interviewSlot(s, at, world, rng) {
  if (!world) return null;
  const tz = tzOf(s, world);
  const W = worldOverlay(s, world);
  const r = routineOf(W);
  const start0 = rng.int ? rng.int(2, 4) : 2;
  for (let k = start0; k <= 7; k++) {
    const d0 = addDays(at, k, tz);
    const type = dayType(d0, W, {}, { overrides: overridesFor(s, dateKey(d0, tz)) });   // 014 sched: never on a day off
    if (type !== 'office' && type !== 'wfh') continue;
    const lo = r.workStart + 60;
    const hi = Math.max(lo, r.workEnd - 120);
    const slots = Math.floor((hi - lo) / 30) + 1;
    const mins = lo + 30 * Math.floor(rng() * slots);
    return { eventAt: atLocal(d0, mins, tz), workConflict: true };
  }
  return null;
}

/** The interview decision spec (career:interview, go|skip), or null without a slot. */
export function interviewSpec(s, at, arc, world, rng) {
  const slot = interviewSlot(s, at, world, rng);
  if (!slot) return null;
  const placeId = huntOfficePlaceId(s);
  // He is job hunting: going is what he set out to do (the costs still weigh in).
  const bias = round2(clamp(INTERVIEW_BIAS + (sliderFactor('careerAmbition', s) - 1) * 2, -3, 3));
  return {
    kind: 'career:interview',
    category: 'career',
    arcId: arc.id,
    subject: { eventAt: slot.eventAt, placeId, castIds: [], minutes: INTERVIEW_MIN },
    options: [
      { id: 'go', label: 'Go to the interview', go: true, kind: 'meeting', minutes: INTERVIEW_MIN, stress: slot.workConflict ? 6 : 2, bias },
      { id: 'skip', label: 'Skip it', kind: 'rest', minutes: 0 },
    ],
  };
}

/**
 * The offer decision spec (career:offer, big, accept|decline; accepting is the
 * resignation), opened at `at`. decideBy = at + ARCS_BIG_LEAD_HOURS + 24 h
 * (≥ the card lead time, with room for travel and prep). null without terms.
 */
export function offerSpec(s, at, seed, arcId, deps = {}) {
  const terms = offerTerms(s, seed, { arcId, opensAt: at });
  if (!terms) return null;
  const decideBy = Math.round(at + leadSec(deps) + 24 * HOUR);
  const c = careerOf(s);
  let lean = (sliderFactor('careerAmbition', s) - 1) * 2;
  if (c.lastAppraisal?.band === 'poor') lean += 0.5;
  if (managerTension(s) >= HUNT_TENSION) lean += 0.5;
  const what = [terms.title, terms.employerName].filter(Boolean).join(' at ');
  return {
    kind: 'career:offer',
    category: 'career',
    arcId,
    big: true,
    mode: 'ask',
    decideBy,
    subject: { eventAt: decideBy, placeId: null, castIds: [], minutes: 30 },
    options: [
      { id: 'accept', label: clean(`Accept: ${what}`, 80), kind: 'rest', minutes: 0, bias: round2(clamp(lean, -3, 3)) },
      { id: 'decline', label: 'Decline the offer', kind: 'rest', minutes: 0 },
    ],
  };
}

async function openWith(deps, spec, { world, at, add, causeId, state }) {
  const open = typeof deps.openDecision === 'function' ? deps.openDecision : openDecisionDefault;
  const getState = typeof deps.getState === 'function' ? deps.getState : () => state;
  return open(getState, spec, { world, at, append: add, causeId: causeId ?? null });
}

// ── Daily roll (inside the daily item) ────────────────────────────────────

/**
 * Adapter for cast.js's daily item (`deps.rolls.career`). In order: the
 * appraisal, hunt upkeep, a hunt start, an interview. Controls are checked
 * before each append. deps: { askJev, openDecision, getState, rngFor, refuse,
 * cfg }. → a flat outcome map for story.daily_done.rolls.career.
 */
export async function dailyRoll({ state, add, at, date, world, seed, sim = false } = {}, deps = {}) {
  const s = state;
  const out = {};
  if (!careerSeed(seed) || !s?.story || !finite(at)) return { outcome: 'inert' };
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const day = date ?? dateKey(at, tzOf(s, world));
  const refusals = [];

  // 1. Appraisal.
  let band = null;
  const due = appraisalDue(s, at, seed, world);
  if (due.due) {
    if (verdict(s, refusals, { action: 'beat', pinKeys: ['self.job'], target: 'self.job' }).ok) {
      const ev = await appraise(s, at, seed, { askJev: deps.askJev, rngFor: rf, world, sim });
      add(ev);
      band = ev.payload.band;
      out.appraisal = band;
      if (ev.payload.fallback) out.appraisalFallback = ev.payload.fallback;
    } else out.appraisal = 'refused';
  } else out.appraisal = due.reason;

  const arc = huntArc(s);
  const c = careerOf(s);
  if (arc) {
    // 2. Upkeep: an offer that expired un-picked → searching; a long fruitless hunt ends.
    const pending = pendingInHunt(s, arc);
    if (arc.stage === 'offer' && !pending.length && at - (arc.stageAt ?? at) >= OFFER_STALE_DAYS * DAY) {
      if (verdict(s, refusals, { action: 'change', pinKeys: [stageKey(arc)], target: stageKey(arc) }).ok) {
        add({ type: 'arc.stage', at, actor: 'engine', payload: { arcId: arc.id, from: 'offer', to: 'searching', reason: 'timeout' } });
        out.hunt = 'offer_lapsed';
      }
    } else if (arc.stage === 'searching' && !pending.length && at - arc.startedAt >= HUNT_MAX_DAYS * DAY) {
      if (verdict(s, refusals, { action: 'change', pinKeys: [stageKey(arc)], target: stageKey(arc) }).ok) {
        add({ type: 'career.hunt', at, actor: 'engine', payload: { arcId: arc.id, phase: 'ended', reason: 'gave_up' } });
        add({ type: 'arc.ended', at, actor: 'engine', payload: { arcId: arc.id, outcome: 'fizzled' } });
        out.hunt = 'ended';
      }
    } else if (arc.stage === 'searching' && !pending.length) {
      // 3. An interview comes up.
      const rng = rf(day, 'career:interview');
      const p = round4(INTERVIEW_P * sliderFactor('careerAmbition', s));
      const r = rng();
      out.interviewP = p;
      if (r < p) {
        const v = verdict(s, refusals, { action: 'decision', pinKeys: [stageKey(arc)], target: stageKey(arc) });
        const spec = v.ok ? interviewSpec(s, at, arc, world, rng) : null;
        if (!v.ok) out.interview = v.reason;
        else if (!spec) out.interview = 'no_slot';
        else if (sim) out.interview = 'sim';
        else {
          try { await openWith(deps, spec, { world, at, add, state: s }); out.interview = 'opened'; } catch { out.interview = 'error'; }
        }
      } else out.interview = 'no';
    } else out.hunt = arc.stage;
  } else if (!c.notice) {
    // 4. A hunt starts.
    const trig = huntTrigger(s, at, { band });
    const ended = lastHuntEndedAt(s);
    if (!trig) out.hunt = 'no_trigger';
    else if (finite(ended) && at - ended < HUNT_COOLDOWN_DAYS * DAY) out.hunt = 'cooldown';
    else if (!otherEmployers(s, seed).length) out.hunt = 'no_employers';
    else {
      const rng = rf(day, 'career:hunt');
      const p = round4(trig.p * sliderFactor('careerAmbition', s));
      const r = rng();
      out.huntP = p;
      if (!(r < p)) out.hunt = 'no';
      else if (!verdict(s, refusals, { action: 'start', pinKeys: ['self.job'], target: 'self.job' }).ok) out.hunt = 'refused';
      else {
        const started = add({
          type: 'arc.started', at, actor: 'engine',
          payload: { category: 'career', kind: 'hunt', castIds: [], stage: 'searching', state: { reason: trig.reason } },
        });
        add({ type: 'career.hunt', at, actor: 'engine', causeId: started.id, payload: { arcId: started.id, phase: 'started', reason: trig.reason } });
        // Off by default: routine/travel resolve places against world.places only,
        // and worldOverlay does not merge event-created places, so a job at a
        // place.created office would leave him no commute (see newOfficePlace).
        if (deps.allowNewOffice === true && !huntOfficePlaceId(s)) {
          const place = newOfficePlace(s, seed, world, rf(day, 'career:office'), at);
          if (place) add({ ...place, causeId: started.id });
        }
        out.hunt = 'started';
      }
    }
  } else out.hunt = 'notice';

  refuseAll(deps, refusals, at, sim);
  return out;
}

// ── Pulse items: consequences and the job change ──────────────────────────

function expireItem(d, at, reason) {
  return {
    at, prio: 8, label: 'career:refused', id: d.id,
    run: (add) => { add({ type: 'decision.expired', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, reason } }); },
  };
}

/**
 * The pulse item for one committed career decision due by `g`, or null
 * (story-api §1 "consequences of committed arc decisions"). Every event is
 * caused by the decision's own `decision.opened` (d.id, self) and carries
 * commitEventId. deps: { world, seed, openDecision, getState, rngFor, sim, cfg }.
 */
export function consequence(s, d, g, deps = {}) {
  if (!isObj(d) || d.status !== 'committed' || d.category !== 'career' || !finite(g)) return null;
  const arc = s?.story?.arcs?.[d.arcId];
  if (!isObj(arc) || arc.status !== 'active') return null;
  const commitEventId = d.committed?.eventId ?? null;
  const opt = d.committed?.optionId;
  const sAt = finite(s?.at) ? s.at : 0;

  if (d.kind === 'career:interview') {
    if (opt !== 'go') return null;
    const end = interviewEnd(d);
    if (!finite(end) || end > g || arc.stage !== 'searching' || !(finite(arc.stageAt) && arc.stageAt < end)) return null;
    const at = Math.max(end, sAt);
    const v = controlsCheck({ source: 'engine', category: 'career', action: 'change', pinKeys: [stageKey(arc)] }, s);
    if (!v.ok) return expireItem(d, at, v.reason === 'pinned' ? 'pinned' : 'frozen');
    const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
    const rng = rf(dateKey(at, tzOf(s, deps.world)), `career:interview:${d.id}`);
    const p = Math.min(OFFER_P_MAX, OFFER_P * sliderFactor('careerAmbition', s));
    const canOpen = controlsCheck({ source: 'engine', category: 'career', action: 'decision', pinKeys: [stageKey(arc), 'self.job'] }, s).ok;
    const hit = rng() < p;
    const spec = hit && canOpen && !deps.sim ? offerSpec(s, at, deps.seed, arc.id, deps) : null;
    return {
      at, prio: 8, label: 'career:interview', id: d.id,
      run: async (add) => {
        let opened = false;
        if (spec) {
          try { await openWith(deps, spec, { world: deps.world, at, add, causeId: d.id, state: s }); opened = true; } catch { opened = false; }
        }
        add({
          type: 'arc.stage', at, actor: 'engine', causeId: d.id,
          payload: { arcId: arc.id, from: 'searching', to: opened ? 'offer' : 'searching', reason: 'decision', ...(commitEventId ? { commitEventId } : {}) },
        });
      },
    };
  }

  if (d.kind === 'career:offer') {
    if (arc.stage !== 'offer' || !finite(d.committed?.at)) return null;
    const at = Math.max(d.committed.at, sAt);
    if (at > g) return null;
    if (opt === 'accept') {
      const v = controlsCheck({ source: 'engine', category: 'career', action: 'change', pinKeys: ['self.job', stageKey(arc)] }, s);
      if (!v.ok) return expireItem(d, at, v.reason === 'pinned' ? 'pinned' : 'frozen');
      const terms = offerTerms(s, deps.seed, { arcId: arc.id, opensAt: d.opensAt });
      const c = careerOf(s);
      const nd = careerSeed(deps.seed)?.noticeDays;
      const noticeDays = Number.isInteger(nd) && nd >= 0 && nd <= 120 ? nd : NOTICE_DEFAULT_DAYS;
      const toOffice = huntOfficePlaceId(s) ?? c.officePlaceId ?? null;
      return {
        at, prio: 8, label: 'career:resign', id: d.id,
        run: (add) => {
          add({
            type: 'career.resigned', at, actor: 'engine', causeId: d.id,
            payload: {
              decisionId: d.id, noticeUntil: at + noticeDays * DAY,
              toEmployer: terms?.employerName ?? c.employerName ?? null, toTitle: terms?.title ?? c.title ?? null,
              toOfficePlaceId: toOffice, ...(commitEventId ? { commitEventId } : {}),
            },
          });
          add({
            type: 'arc.stage', at, actor: 'engine', causeId: d.id,
            payload: { arcId: arc.id, from: 'offer', to: 'notice', reason: 'decision', ...(commitEventId ? { commitEventId } : {}) },
          });
        },
      };
    }
    // decline (or anything else): back to searching.
    const v = controlsCheck({ source: 'engine', category: 'career', action: 'change', pinKeys: [stageKey(arc)] }, s);
    if (!v.ok) return expireItem(d, at, v.reason === 'pinned' ? 'pinned' : 'frozen');
    return {
      at, prio: 8, label: 'career:decline', id: d.id,
      run: (add) => {
        add({
          type: 'arc.stage', at, actor: 'engine', causeId: d.id,
          payload: { arcId: arc.id, from: 'offer', to: 'searching', reason: 'decision', ...(commitEventId ? { commitEventId } : {}) },
        });
      },
    };
  }
  return null;
}

/**
 * The job change at the end of the notice period (always caused by the offer's
 * decision.opened), or null. HELD while `self.job` is pinned or career frozen:
 * not offered, one refusal logged through deps.refuse (deduped per hour by the store).
 */
export function noticeItem(s, g, deps = {}) {
  const c = careerOf(s);
  const n = c.notice;
  if (!isObj(n) || !finite(n.until) || !finite(g) || n.until > g) return null;
  const v = controlsCheck({ source: 'engine', category: 'career', action: 'change', pinKeys: ['self.job'] }, s);
  const at = Math.max(n.until, finite(s?.at) ? s.at : n.until);
  if (!v.ok) {
    refuseAll(deps, [{ source: 'engine', category: 'career', action: 'change', target: 'self.job', reason: v.reason, pinKey: v.pinKey ?? null }], at, deps.sim === true);
    return null;
  }
  const causeId = Number.isSafeInteger(n.decisionId) ? n.decisionId : null;
  const huntId = c.huntArcId;
  return {
    at, prio: 8, label: 'career:job_changed', id: n.eventId ?? n.until,
    run: (add) => {
      add({
        type: 'career.job_changed', at, actor: 'engine', causeId,
        payload: {
          title: n.toTitle ?? c.title ?? null, employerName: n.toEmployer ?? c.employerName ?? null,
          officePlaceId: n.toOfficePlaceId ?? c.officePlaceId ?? null, ...(causeId ? { decisionId: causeId } : {}),
        },
      });
      if (huntId) {
        add({ type: 'career.hunt', at, actor: 'engine', causeId, payload: { arcId: huntId, phase: 'ended', reason: 'job_changed' } });
        add({ type: 'arc.ended', at, actor: 'engine', causeId, payload: { arcId: huntId, outcome: 'done' } });
      }
    },
  };
}

/**
 * Every career pulse item due by `g`: consequences of committed career
 * decisions (interview outcomes, offer accept/decline) and the job change.
 */
export function huntItems(s, g, deps = {}) {
  const out = [];
  for (const d of s?.decisions instanceof Map ? s.decisions.values() : []) {
    const it = consequence(s, d, g, deps);
    if (it) out.push(it);
  }
  const job = noticeItem(s, g, deps);
  if (job) out.push(job);
  return out;
}
