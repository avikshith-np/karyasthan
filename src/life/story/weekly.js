// Weekly arc pass (spec 010, research R15, contracts/model-output.md §1): one
// mind-role call inside 008's sleep (step 4b, via the life facade's
// storyWeeklyPass), at most once per 7 days, never caught up.
//
//   buildWeeklyInput(state, seed, {at, world}) → { input, labelMap }
//   runWeekly({ nightKey, trigger, budgetOk }) → RunResult
//   applyWeekly(value, labelMap, state, append, ctx) → counts
//   proposalDescriptors(proposal, state, ctx) → { events, warnings, refusals }
//       the owner's PREVIEW APPROVE of a pending proposal (the Director's
//       proposal.approve): the same per-kind checks, re-run against the world
//       as it is now, as event descriptors — pure, nothing written
//
// Privacy (FR-009, threat T4): the input is origin-free BY CONSTRUCTION. It is
// built only from the fictional cast and places, his own self/owner/mind beats,
// open arcs, the seed, owner controls and counts of his own self-origin events.
// No claim, adopted plan, chat-origin event, journal text or real name is read.
//
// Authority: the model only proposes. Code validates (schema.validateWeekly:
// sizes, enums, label refs), then runs the owner controls (pause, fate, pins;
// guided → story_proposals for the owner), caps (beats, new cast, places, arc
// openers), the name and region checks, and builds every decision spec, option
// label, cost and deadline itself. The model's `note` never becomes a label or
// any prompt-reaching text (story_runs / story_proposals only). A run that fell
// back to a non-mind model applies beats only.
//
// Gates: storyOn, not paused, 008's budgetOk object with ok === true (a truthy
// object is NOT enough), story_state.last_weekly_at ≥ 7 days old, and the
// `life.arcs.` caller month-to-date < ARCS_MIND_BUDGET_USD. A failed gate is a
// skipped story_runs row (deduped per reason per day; not_due writes none).
// Logs: ids, counts, statuses, reason codes only.

import { config, getPersona } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { now as clockNow, dateKey, dayStart, addDays, atLocal, weekday, ageOn } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { listEvents as listEventsDefault, lastEventId as lastEventIdDefault } from '../eventLog.js';
import { isExcludedId } from '../projector.js';
import { realPeopleNames, castNameCollisions, textNameCollisions, normalizeName } from '../world.js';
import { routineOf } from '../routine.js';
import { planOpened } from '../decisions.js';
import { worldOverlay, CATEGORIES, jobWordsOf } from './reducer.js';
// 014 geo (§A7, R16): venue names (every one ever recorded) and their safe wording.
import { safePlaceName, venueNamesNow } from '../places.js';

// A weekly new_place name that equals or contains a recorded venue name (normalised, whole words).
function venueNameHit(name) {
  const n = ` ${normalizeName(name)} `;
  return venueNamesNow().some((e) => {
    const v = normalizeName(typeof e === 'string' ? e : e?.name);
    return v.length >= 3 && n.includes(` ${v} `);
  });
}
import { check as controlsCheck, fateOf, isPaused, pinOf, pinKeysFor, sliderValue } from './controls.js';
import { seedThemes } from './heavy.js';
import { pressureFactor } from './family.js';
import * as storeDefault from './store.js';
import { validateWeekly } from './schema.js';
import { WEEKLY_CHARTER, fence, cleanItem } from './charter.js';
import { getArcSeed, effectiveSeed, arcsCallerSpend } from './seed.js';

export const WEEKLY_CALLER = 'life.arcs.weekly';
export const WEEK_SEC = 7 * 86400;
export const INPUT_MAX_BYTES = 8192;
export const MAX_TOKENS = 3000;
export const NEW_CAST_WINDOW_DAYS = 90;
export const MAX_PLACES = 48;
export const REGION_MARGIN_KM = 10;
export const BEATS_PER_CAST = 3;

const DAY = 86400;
const HOUR = 3600;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r05 = (v) => (fin(v) ? Math.round(v * 20) / 20 : null);
const r2 = (v) => (fin(v) ? Math.round(v * 100) / 100 : null);
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const OUTING_EXCLUDED_KINDS = new Set(['home', 'office', 'shop', 'grocery', 'place']);
const SELF_ORIGINS = new Set(['self', 'owner']);

// ── deps ─────────────────────────────────────────────────────────────────────

let deps = {};
/** Production wiring (story/index.js attach): merged over the defaults. */
export function configure(d = {}) {
  deps = { ...deps, ...(isObj(d) ? d : {}) };
}
/** Test seam: replaces every dep (null → defaults). */
export function __setDepsForTest(d) {
  deps = isObj(d) ? { ...d } : {};
}

const nowSec = () => Math.floor((deps.now ?? clockNow)());
const store = () => deps.store ?? storeDefault;
const listEvents = (q) => (deps.listEvents ?? listEventsDefault)(q);
const rngFor = (...a) => (deps.rngFor ?? rngForDefault)(...a);
const cfg = () => ({ ...config.arcs, ...(isObj(deps.cfg) ? deps.cfg : {}) });

function tzOf(state, world) {
  return state?.world?.timezone || world?.timezone || config.timezone || 'UTC';
}

/** ISO week key 'YYYY-Www' of a unix time in a timezone. */
export function isoWeekKey(at, tz) {
  const [y, m, d] = dateKey(at, tz).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function castList(state) {
  return state?.cast instanceof Map ? [...state.cast.values()].filter(c => CAST_ID_RE.test(c?.id ?? '')).sort((a, b) => a.id.localeCompare(b.id)) : [];
}

function placeList(state, world) {
  if (state?.places instanceof Map && state.places.size) return [...state.places.values()];
  return Array.isArray(world?.places) ? world.places : [];
}

function firstName(c) {
  const n = cleanItem(c?.name, 80).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return n.split(' ')[0] || 'them';
}

function castBlocked(state, id) {
  return !!pinOf(id, state) || fateOf('cast', state) === 'frozen';
}

// His own beats per cast member (self/owner origin, mind writes are self), newest first.
function recentBeats(state, at) {
  const out = new Map();
  let rows = [];
  try {
    rows = listEvents({ types: ['cast.beat'], from: at - 60 * DAY, to: at, limit: 500, order: 'desc' });
  } catch { rows = []; }
  for (const ev of rows) {
    if (!SELF_ORIGINS.has(ev.originKind) || ev.redacted || isExcludedId(state, ev.id)) continue;
    const id = ev.payload?.castId;
    if (typeof id !== 'string') continue;
    const list = out.get(id) ?? [];
    if (list.length >= BEATS_PER_CAST) continue;
    const text = cleanItem(ev.payload?.text, 80);
    list.push(text ? `${ev.payload?.kind ?? 'beat'}: ${text}` : String(ev.payload?.kind ?? 'beat'));
    out.set(id, list);
  }
  return out;
}

// Counts of his own self-origin event types in the last 7 days.
function selfWeek(state, at) {
  const counts = {};
  // Id-ordered pages (newest first) under the time filter: complete even though `at` is not monotone in id.
  let before;
  try { before = (deps.lastEventId ?? lastEventIdDefault)() + 1; } catch { return {}; }
  for (let page = 0; page < 20 && before > 1; page++) {
    let rows = [];
    try { rows = listEvents({ from: at - WEEK_SEC, to: at, before, limit: 500, order: 'desc' }); } catch { break; }
    for (const ev of rows) {
      if (ev.originKind !== 'self' || ev.redacted || isExcludedId(state, ev.id)) continue;
      counts[ev.type] = (counts[ev.type] || 0) + 1;
    }
    if (rows.length < 500) break;
    before = rows[rows.length - 1].id;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30));
}

function newCastLeft(state, at, c) {
  const ats = Array.isArray(state?.story?.newCast?.ats) ? state.story.newCast.ats : [];
  const recent = ats.filter(t => fin(t) && t > at - NEW_CAST_WINDOW_DAYS * DAY).length;
  const size = castList(state).length;
  return recent < Number(c.newCastPer90d ?? 2) && size < Number(c.castMax ?? 24) ? 1 : 0;
}

/**
 * The weekly input (contracts/model-output.md §1) and its label map. Origin-free
 * by construction (see the header). → { input, labelMap, bytes }
 * labelMap = { cast:{K1:{castId, blocked}}, places:{P1:placeId}, arcs:{A1:arcId}, heavy:{H1:themeId} }
 */
export function buildWeeklyInput(state, seed, { at = nowSec(), world = null } = {}) {
  const c = cfg();
  const tz = tzOf(state, world);
  const W = world ? worldOverlay(state, world) : null;
  const career = state?.story?.career ?? {};
  const romance = state?.story?.romance ?? {};
  const labelMap = { cast: {}, places: {}, arcs: {}, heavy: {} };
  const beats = recentBeats(state, at);

  const cast = castList(state).slice(0, 24).map((m, i) => {
    const ref = `K${i + 1}`;
    const blocked = castBlocked(state, m.id);
    labelMap.cast[ref] = { castId: m.id, blocked };
    const life = state?.story?.castLife?.[m.id] ?? {};
    const awayUntil = life?.away?.until;
    return {
      ref, name: cleanItem(m.name, 40), relation: cleanItem(m.relation, 40), pronouns: cleanItem(m.pronouns, 24) || null,
      age: ageOn(m.birthday, at, tz), status: cleanItem(life.status ?? m.status, 160) || null,
      away: fin(awayUntil) && awayUntil > at,
      metrics: { closeness: r05(m.metrics?.closeness), trust: r05(m.metrics?.trust), tension: r05(m.metrics?.tension) },
      recentBeats: beats.get(m.id) ?? [], blocked,
    };
  });

  const places = placeList(state, world).filter(p => PLACE_ID_RE.test(p?.id ?? '')).slice(0, MAX_PLACES).map((p, i) => {
    const ref = `P${i + 1}`;
    labelMap.places[ref] = p.id;
    return { ref, kind: cleanItem(p.kind, 24) || 'place', name: cleanItem(p.name, 60) };
  });

  const arcs = Object.values(state?.story?.arcs ?? {}).filter(a => isObj(a) && a.status === 'active')
    .sort((a, b) => a.id - b.id).slice(0, 12).map((a, i) => {
      const ref = `A${i + 1}`;
      labelMap.arcs[ref] = a.id;
      return { ref, category: a.category, kind: cleanItem(a.kind, 24), stage: cleanItem(a.stage, 24),
        sinceDays: fin(a.startedAt) ? Math.max(0, Math.round((at - a.startedAt) / DAY)) : null };
    });

  const age = ageOn(state?.self?.birthdate, at, tz);
  const famThemes = Array.isArray(seed?.family?.themes) ? seed.family.themes : [];
  const famSlider = sliderValue('familyPressure', state);
  const pressure = famThemes.reduce((m, t) => Math.max(m, pressureFactor(age, t, famSlider)), 0);
  const heavyThemes = seedThemes(seed).slice(0, 6).map((t, i) => {
    const ref = `H${i + 1}`;
    labelMap.heavy[ref] = t.id;
    return { ref, kind: t.kind };
  });

  const yearsInRole = fin(career.startedAt) ? Math.round(((at - career.startedAt) / (365 * DAY)) * 10) / 10 : null;
  const cooldownDaysLeft = fin(romance.cooldownUntil) ? Math.max(0, Math.ceil((romance.cooldownUntil - at) / DAY)) : 0;
  const input = {
    you: {
      age,
      relationship: cleanItem(state?.self?.relationship, 24) || 'single',
      job: { title: cleanItem(jobWordsOf(state, W), 60) || null, yearsInRole },
      romance: { stage: cleanItem(romance.stage, 24) || 'single', cooldownDaysLeft },
    },
    week: isoWeekKey(at, tz),
    cast,
    places,
    arcs,
    family: { themes: famThemes.slice(0, 6).map((t, i) => `T${i + 1}: ${cleanItem(t.label, 80)}`), pressure: r2(pressure) ?? 0 },
    heavyThemes,
    sliders: { drama: r2(sliderValue('drama', state)), socialAppetite: r2(sliderValue('socialAppetite', state)),
      romanceAppetite: r2(sliderValue('romanceAppetite', state)) },
    fate: Object.fromEntries(CATEGORIES.map(k => [k, fateOf(k, state)])),
    caps: {
      beatsLeft: Math.max(0, Math.min(8, Number(c.beatsPerWeek ?? 8))),
      newCastLeft: newCastLeft(state, at, c),
      newPlaceLeft: placeList(state, world).length < MAX_PLACES ? 1 : 0,
      arcOpenersLeft: 3,
    },
    selfWeek: selfWeek(state, at),
  };
  // ≤ 8 KB: drop beats first, then the tail of the cast list.
  let bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  for (const m of input.cast) {
    if (bytes <= INPUT_MAX_BYTES) break;
    m.recentBeats = [];
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  }
  while (bytes > INPUT_MAX_BYTES && input.cast.length) {
    const gone = input.cast.pop();
    delete labelMap.cast[gone.ref];
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  }
  return { input, labelMap, bytes };
}

// ── arc decision specs (code-built; the model's note never reaches them) ───

const OPENERS = Object.freeze({
  romance_interest: { kind: 'romance:interest', category: 'romance', needsCast: true },
  social_plan: { kind: 'social:plan', category: 'social', needsCast: false },
  cast_meetup: { kind: 'social:meetup', category: 'social', needsCast: true },
  family_visit: { kind: 'family:visit', category: 'family', needsCast: true },
  career_hunt: { kind: 'career:hunt', category: 'career', needsCast: false },
});

function outingSlot(state, world, at, rng, { weekendOnly = false } = {}) {
  const tz = tzOf(state, world);
  const r = routineOf(world ? worldOverlay(state, world) : world);
  const weekend = Array.isArray(r?.weekend) ? r.weekend : [0, 6];
  for (let k = 2 + Math.floor(rng() * 3); k <= 9; k++) {
    const d0 = dayStart(addDays(at, k, tz), tz);
    const isWeekend = weekend.includes(weekday(d0, tz));
    if (weekendOnly && !isWeekend) continue;
    return atLocal(d0, isWeekend ? (weekendOnly ? '13:00' : '16:00') : '19:30', tz);
  }
  return null;
}

function outingPlace(state, world, rng) {
  const home = state?.self?.homePlaceId;
  const list = placeList(state, world).filter(p => PLACE_ID_RE.test(p?.id ?? '') && p.id !== home
    && !OUTING_EXCLUDED_KINDS.has(String(p.kind ?? '').toLowerCase())).sort((a, b) => a.id.localeCompare(b.id));
  return list.length ? list[Math.floor(rng() * list.length) % list.length] : null;
}

/**
 * The decision spec for one weekly opener, built in code (options, labels,
 * places, times). → { spec, category } | { reason }
 */
export function openerSpec(opener, state, { at, world, weekKey } = {}) {
  const o = OPENERS[opener?.kind];
  if (!o) return { reason: 'invalid' };
  const castId = typeof opener.castId === 'string' ? opener.castId : null;
  const member = castId && state?.cast instanceof Map ? state.cast.get(castId) : null;
  if (o.needsCast && !member) return { reason: 'invalid' };
  if (castId && !member) return { reason: 'invalid' };
  const isFamily = typeof member?.relation === 'string' && member.relation.startsWith('family:');
  if (opener.kind === 'family_visit' && !isFamily) return { reason: 'invalid' };
  if (opener.kind === 'romance_interest' && isFamily) return { reason: 'invalid' };
  const rng = rngFor(String(weekKey ?? dateKey(at, tzOf(state, world))), `weekly:${opener.kind}:${castId ?? '-'}`);
  const name = member ? firstName(member) : null;

  if (opener.kind === 'career_hunt') {
    const eventAt = at + 3 * DAY;
    return {
      category: o.category,
      spec: {
        kind: o.kind, category: o.category, decideBy: eventAt,
        subject: { eventAt, placeId: null, castIds: [], minutes: 30 },
        options: [
          { id: 'look', label: 'Start looking around for a new job', kind: 'rest', minutes: 0 },
          { id: 'stay', label: 'Stay put for now', kind: 'rest', minutes: 0 },
        ],
      },
    };
  }

  let place = null;
  if (opener.kind === 'family_visit') {
    const home = state?.self?.homePlaceId;
    const own = typeof member.home === 'string' && PLACE_ID_RE.test(member.home) && member.home !== home ? member.home : null;
    const candidates = placeList(state, world).filter(p => p?.id && p.id !== home && String(p.kind ?? '') === 'home');
    place = (own && placeList(state, world).find(p => p.id === own)) || candidates.sort((a, b) => a.id.localeCompare(b.id))[0] || null;
  } else {
    place = outingPlace(state, world, rng);
  }
  if (!place) return { reason: 'invalid' };
  const eventAt = outingSlot(state, world, at, rng, { weekendOnly: opener.kind === 'family_visit' });
  if (!eventAt) return { reason: 'invalid' };
  const where = cleanItem(safePlaceName(state, place.id, place.name), 40) || 'somewhere';   // 014 geo (§A7)
  const goLabel = {
    romance_interest: `Coffee with ${name} at ${where}`,
    social_plan: name ? `Go out to ${where} with ${name}` : `Go out to ${where}`,
    cast_meetup: `Meet ${name} at ${where}`,
    family_visit: `Visit ${name} at ${where}`,
  }[opener.kind];
  return {
    category: o.category,
    spec: {
      kind: o.kind, category: o.category,
      subject: { eventAt, placeId: place.id, castIds: castId ? [castId] : [], minutes: opener.kind === 'family_visit' ? 180 : 120 },
      options: [
        { id: 'go', label: cleanItem(goLabel, 80), go: true, kind: 'social', fun: 6 },
        { id: 'late', label: 'Join later', go: 'late', kind: 'social', minutes: 60, fun: 3 },
        { id: 'stay', label: 'Stay in', kind: 'rest' },
      ],
    },
  };
}

async function openArcDecision(state, spec, ctx) {
  if (typeof deps.openArcDecision === 'function') return deps.openArcDecision(state, spec, ctx);
  try {
    const glue = await import('./decisionsGlue.js');
    if (typeof glue.openArcDecision === 'function') return glue.openArcDecision(state, spec, ctx);
  } catch { /* decisionsGlue lands in wave 1b */ }
  const { openDecision } = await import('../decisions.js');
  return openDecision(state, spec, ctx);
}

// ── apply ────────────────────────────────────────────────────────────────────

function slugFrom(name) {
  const s = normalizeName(name).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return s && /^[a-z0-9]/.test(s) ? s : 'new';
}

function uniqueId(prefix, base, taken) {
  let id = `${prefix}:${base}`;
  for (let n = 2; taken.has(id); n++) id = `${prefix}:${base}-${n}`.slice(0, prefix.length + 41);
  return id;
}

// Cast ids already used (current and departed members: an id is never reused).
function takenCastIds(state) {
  const ids = new Set(castList(state).map(m => m.id));
  for (const id of Object.keys(isObj(state?.story?.departed) ? state.story.departed : {})) ids.add(id);
  return ids;
}

// ── pure per-kind checks (applyWeekly and the owner's approval share them) ──

/** A new member from the weekly fields → { payload } | { reason: cap | name_collision }. */
function newCastPlan(n, state, at, c, knownNames) {
  if (!newCastLeft(state, at, c)) return { reason: 'cap' };
  const existing = castList(state);
  if (castNameCollisions([{ id: 'x', name: n.name }], [...knownNames, ...existing.map(m => m.name)]).length
    || textNameCollisions({ cast: [{ personality: n.personality, speech: n.speech, status: n.status }] }, knownNames).length) {
    return { reason: 'name_collision' };
  }
  const id = uniqueId('cast', slugFrom(n.name), takenCastIds(state));
  return {
    payload: {
      id, name: n.name, relation: n.relation, ...(n.pronouns ? { pronouns: n.pronouns } : {}), birthday: n.birthday,
      ...(n.personality ? { personality: n.personality } : {}), ...(n.speech ? { speech: n.speech } : {}),
      ...(n.status ? { status: n.status } : {}), ...(n.homeNear ? { home: n.homeNear } : {}), ...(n.via ? { metVia: n.via } : {}),
      // Starts distant; the relationship.changed below brings closeness to 0.3 (deltas are capped at 0.2).
      metrics: { closeness: 0.1, trust: 0.4, tension: 0 },
    },
  };
}

/** A new place's name → null | { reason:'name_collision', why? } (a real person, or a recorded venue's name). */
function placeNameProblem(name, knownNames) {
  if (textNameCollisions({ places: [{ name }] }, knownNames).length) return { reason: 'name_collision' };
  // 014 geo (R16): never a name that matches, or contains, a real venue ever
  // recorded (the refusal table's reasons are closed: name_collision + why).
  if (venueNameHit(name)) return { reason: 'name_collision', why: 'venue_name' };
  return null;
}

function inBox(box, lat, lon) {
  return !!box && fin(lat) && fin(lon) && lat >= box.latMin && lat <= box.latMax && lon >= box.lonMin && lon <= box.lonMax;
}

/** Bounding box of the genesis places expanded by `marginKm` (research R20). */
export function regionBox(world, marginKm = REGION_MARGIN_KM) {
  const pts = (Array.isArray(world?.places) ? world.places : []).filter(p => fin(p?.lat) && fin(p?.lon));
  if (!pts.length) return null;
  const lat0 = Math.min(...pts.map(p => p.lat));
  const lat1 = Math.max(...pts.map(p => p.lat));
  const lon0 = Math.min(...pts.map(p => p.lon));
  const lon1 = Math.max(...pts.map(p => p.lon));
  const dLat = marginKm / 111.32;
  const mid = ((lat0 + lat1) / 2) * Math.PI / 180;
  const dLon = marginKm / (111.32 * Math.max(0.1, Math.cos(mid)));
  return { latMin: lat0 - dLat, latMax: lat1 + dLat, lonMin: lon0 - dLon, lonMax: lon1 + dLon };
}

function refuse(ctx, { category, action, target, reason, pinKey = null, kind, payload }) {
  const st = store();
  try { st.recordRefusal({ source: 'mind', category, action, target, reason, pinKey, at: ctx.at }); } catch { /* best effort */ }
  try {
    st.createProposal({ runId: ctx.runId, weekKey: ctx.weekKey, category, kind, payload, status: 'refused',
      reason, createdAt: ctx.at });
  } catch { /* best effort */ }
  ctx.out.refused++;
}

function propose(ctx, { category, kind, payload }) {
  try {
    store().createProposal({ runId: ctx.runId, weekKey: ctx.weekKey, category, kind, payload, status: 'pending', createdAt: ctx.at });
    ctx.out.proposals++;
  } catch { ctx.out.dropped++; }
}

/** One gate verdict → 'ok' | 'propose' | 'refused' (refusal recorded). */
function gate(ctx, { category, action, pinKeys, target, kind, payload, refusalAction = action }) {
  const v = controlsCheck({ source: 'mind', category, action, pinKeys }, ctx.state);
  if (v.ok) return 'ok';
  if (v.reason === 'guided') { propose(ctx, { category, kind, payload }); return 'propose'; }
  refuse(ctx, { category, action: refusalAction, target, reason: ['paused', 'frozen', 'pinned', 'invalid'].includes(v.reason) ? v.reason : 'invalid',
    pinKey: v.pinKey ?? null, kind, payload });
  return 'refused';
}

/**
 * Apply a validated weekly output. ctx = { at, runId, weekKey, world, knownNames,
 * fellBack, worldOf }. Every event is actor 'mind' with no cause (origin self).
 * → { beats, newCast, newPlace, decisions, proposals, refused, dropped, nominated }
 */
export async function applyWeekly(value, labelMap, state, append, ctx0 = {}) {
  const c = cfg();
  const at = ctx0.at ?? nowSec();
  const ctx = { ...ctx0, at, state, out: { beats: 0, newCast: 0, newPlace: 0, decisions: 0, proposals: 0, refused: 0, dropped: 0, nominated: null } };
  const knownNames = Array.isArray(ctx0.knownNames) ? ctx0.knownNames : [];
  const world = ctx0.world ?? null;
  const out = ctx.out;
  const v = isObj(value) ? value : {};

  // Beats for blocked members (validator) → refusals.
  for (const r of Array.isArray(v.refused) ? v.refused : []) {
    const pinned = r.castId && pinOf(r.castId, state);
    refuse(ctx, { category: 'cast', action: r.path?.startsWith('arc_') ? 'decision' : 'beat', target: r.castId,
      reason: pinned ? 'pinned' : 'frozen', pinKey: pinned ? r.castId : null, kind: r.path?.startsWith('arc_') ? 'arc_decision' : 'beat',
      payload: { castId: r.castId, kind: r.kind } });
  }

  // 1. beats (≤ beatsPerWeek, ≤ 1 per member — the validator already deduped).
  const beatCap = Math.max(0, Math.min(8, Number(c.beatsPerWeek ?? 8)));
  for (const b of Array.isArray(v.beats) ? v.beats : []) {
    if (out.beats >= beatCap) { out.dropped++; continue; }
    if (!(state?.cast instanceof Map) || !state.cast.has(b.castId)) { out.dropped++; continue; }
    const payload = { castId: b.castId, kind: b.kind, text: b.text };
    if (textNameCollisions({ cast: [{ status: b.text }] }, knownNames).length) {
      refuse(ctx, { category: 'cast', action: 'beat', target: b.castId, reason: 'name_collision', kind: 'beat', payload: { castId: b.castId, kind: b.kind } });
      continue;
    }
    const g = gate(ctx, { category: 'cast', action: 'beat', pinKeys: [b.castId], target: b.castId, kind: 'beat', payload });
    if (g !== 'ok') continue;
    const ev = append({ type: 'cast.beat', at, actor: 'mind', payload });
    if (b.kind === 'status') {
      append({ type: 'cast.updated', at, actor: 'mind', causeId: ev.id, payload: { castId: b.castId, fields: { status: b.text }, reason: 'weekly' } });
    }
    out.beats++;
  }

  if (ctx0.fellBack) {
    // 008's fell-back rule: a non-mind model wrote this — beats only.
    out.dropped += (v.newCast ? 1 : 0) + (v.newPlace ? 1 : 0) + (v.arcDecisions?.length ?? 0) + (v.heavyNomination ? 1 : 0);
    return out;
  }

  // 2. new cast (≤ 1 per pass, ≤ newCastPer90d per 90 days, total < castMax).
  if (isObj(v.newCast)) {
    const n = v.newCast;
    const payloadBase = { name: n.name, relation: n.relation };
    const planned = newCastPlan(n, state, at, c, knownNames);
    if (planned.reason === 'cap') {
      refuse(ctx, { category: 'cast', action: 'new_cast', target: null, reason: 'cap', kind: 'new_cast', payload: payloadBase });
    } else if (planned.reason) {
      refuse(ctx, { category: 'cast', action: 'new_cast', target: null, reason: 'name_collision', kind: 'new_cast', payload: { relation: n.relation } });
    } else {
      const { payload } = planned;
      const id = payload.id;
      const g = gate(ctx, { category: 'cast', action: 'start', pinKeys: pinKeysFor({ type: 'cast.created', payload }, state),
        target: id, kind: 'new_cast', payload, refusalAction: 'new_cast' });
      if (g === 'ok') {
        const ev = append({ type: 'cast.created', at, actor: 'mind', payload });
        append({ type: 'relationship.changed', at, actor: 'mind', causeId: ev.id, payload: { castId: id, delta: { closeness: 0.2 }, reason: 'arc' } });
        out.newCast++;
      }
    }
  }

  // 3. new place (≤ 1 per pass, < 48 places, inside the region box).
  if (isObj(v.newPlace)) {
    const p = v.newPlace;
    const places = placeList(state, world);
    const near = places.find(x => x.id === p.near);
    const box = regionBox(world ?? { places });
    const nameProblem = placeNameProblem(p.name, knownNames);
    if (places.length >= MAX_PLACES) refuse(ctx, { category: 'social', action: 'start', target: null, reason: 'cap', kind: 'new_place', payload: { kind: p.kind } });
    else if (nameProblem) {
      refuse(ctx, { category: 'social', action: 'start', target: null, reason: nameProblem.reason, kind: 'new_place',
        payload: { kind: p.kind, ...(nameProblem.why ? { why: nameProblem.why } : {}) } });
    } else if (!near || !fin(near.lat) || !fin(near.lon) || !box) {
      refuse(ctx, { category: 'social', action: 'start', target: null, reason: 'invalid', kind: 'new_place', payload: { kind: p.kind } });
    } else {
      const rng = rngFor(String(ctx.weekKey ?? ''), `weekly:place:${p.near}`);
      const bearing = rng() * 2 * Math.PI;
      const lat = near.lat + (p.offsetKm / 111.32) * Math.cos(bearing);
      const lon = near.lon + (p.offsetKm / (111.32 * Math.max(0.1, Math.cos(near.lat * Math.PI / 180)))) * Math.sin(bearing);
      if (!inBox(box, lat, lon)) {
        refuse(ctx, { category: 'social', action: 'start', target: null, reason: 'region', kind: 'new_place', payload: { kind: p.kind } });
      } else {
        const taken = new Set(places.map(x => x.id));
        const id = uniqueId('place', slugFrom(p.name), taken);
        const payload = { id, name: p.name, kind: p.kind, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
        if (gate(ctx, { category: 'social', action: 'start', pinKeys: [], target: id, kind: 'new_place', payload }) === 'ok') {
          append({ type: 'place.created', at, actor: 'mind', payload });
          out.newPlace++;
        }
      }
    }
  }

  // 4. arc decisions (≤ 3; code-built specs; the note stays in story_runs/proposals).
  for (const a of (Array.isArray(v.arcDecisions) ? v.arcDecisions : []).slice(0, 3)) {
    const built = openerSpec(a, state, { at, world, weekKey: ctx.weekKey });
    const proposal = { kind: a.kind, castId: a.castId ?? null, note: a.note || '' };
    const category = OPENERS[a.kind]?.category ?? 'social';
    if (!built.spec) {
      refuse(ctx, { category, action: 'decision', target: a.castId ?? null, reason: 'invalid', kind: 'arc_decision', payload: proposal });
      continue;
    }
    const pinKeys = pinKeysFor({ type: 'decision.opened', payload: built.spec }, state);
    const g = gate(ctx, { category, action: 'decision', pinKeys, target: a.castId ?? null, kind: 'arc_decision', payload: proposal });
    if (g !== 'ok') continue;
    try {
      const W = ctx0.worldOf ? ctx0.worldOf(state) : (world ? worldOverlay(state, world) : world);
      await openArcDecision(ctx0.getState ?? state, built.spec, { at, world: W, append });
      out.decisions++;
    } catch {
      out.dropped++;
    }
  }

  // 5. heavy nomination: raises the next roll's weight for that theme; starts nothing.
  if (isObj(v.heavyNomination)) {
    if (fateOf('heavy', state) === 'frozen' || isPaused(state)) {
      refuse(ctx, { category: 'heavy', action: 'heavy', target: null, reason: isPaused(state) ? 'paused' : 'frozen', kind: 'heavy_nomination',
        payload: { themeId: v.heavyNomination.themeId } });
    } else if (fateOf('heavy', state) === 'guided') {
      propose(ctx, { category: 'heavy', kind: 'heavy_nomination', payload: { themeId: v.heavyNomination.themeId } });
    } else {
      out.nominated = v.heavyNomination.themeId;
    }
  }
  return out;
}

// ── owner approval (the Director's proposal.approve) ─────────────────────────

const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);

// The owner approving IS the "ask" a guided category waits for, so 'guided' passes;
// a category frozen since (nothing new happens there) and a pin still refuse.
function approvalProblem({ category, action, pinKeys = [] }, state) {
  if (fateOf(category, state) === 'frozen') return { reason: 'frozen' };
  const v = controlsCheck({ source: 'owner', category, action, pinKeys }, state);
  return v.ok ? null : { reason: v.reason ?? 'invalid', ...(v.pinKey ? { pinKey: v.pinKey } : {}) };
}

/**
 * PREVIEW APPROVE of a pending weekly proposal (story_proposals row) → the
 * Director's descriptors: { events:[{ref, type, payload, causeRef?}], warnings,
 * refusals:[{reason, target, pinKey?}] }. Pure (reads the projection and the log,
 * writes nothing). The planner dates every event at ctx.now, makes it a 'mind'
 * event and causes the first ones by the owner's director.action. Every check
 * applyWeekly ran is re-run against the world as it is NOW: the member still
 * here, a fresh id, the caps, the names, the region, the controls. Kinds: beat,
 * new_cast, new_place, arc_decision (its decision spec rebuilt in code, the
 * model's note never used); a heavy_nomination has no event form → refused
 * 'unsupported' (reject it, or let it expire).
 * ctx: { now, world (overlaid), baseWorld?, knownNames, seed }
 */
export function proposalDescriptors(proposal, state, ctx = {}) {
  const at = Number.isInteger(ctx.now) ? ctx.now : nowSec();
  const knownNames = Array.isArray(ctx.knownNames) ? ctx.knownNames : [];
  const world = ctx.world ?? null;
  const p = isObj(proposal?.payload) ? proposal.payload : {};
  const events = [];
  const refusals = [];
  const no = (reason, target = null, extra = {}) => { refusals.push({ reason, target, ...extra }); return { events, warnings: [], refusals }; };
  const blocked = (q, target) => { const x = approvalProblem(q, state); return x ? no(x.reason, target, x.pinKey ? { pinKey: x.pinKey } : {}) : null; };

  switch (proposal?.kind) {
    case 'beat': {
      const castId = typeof p.castId === 'string' && CAST_ID_RE.test(p.castId) ? p.castId : null;
      const text = str(p.text, 160);
      if (!castId || !text || typeof p.kind !== 'string') return no('invalid', castId);
      if (!(state?.cast instanceof Map) || !state.cast.has(castId)) return no('not_found', castId);
      if (textNameCollisions({ cast: [{ status: text }] }, knownNames).length) return no('name_collision', castId);
      const stop = blocked({ category: 'cast', action: 'beat', pinKeys: [castId] }, castId);
      if (stop) return stop;
      events.push({ ref: 'b', type: 'cast.beat', payload: { castId, kind: p.kind, text } });
      if (p.kind === 'status') {
        events.push({ ref: 'u', type: 'cast.updated', causeRef: 'b', payload: { castId, fields: { status: text }, reason: 'weekly' } });
      }
      break;
    }
    case 'new_cast': {
      const name = str(p.name, 60);
      if (!name || !str(p.relation, 40)) return no('invalid');
      const has = (k, test) => (test(p[k]) ? p[k] : null);
      const n = {
        name, relation: p.relation, pronouns: has('pronouns', v => !!str(v, 24)), birthday: has('birthday', v => typeof v === 'string'),
        personality: has('personality', v => !!str(v, 200)), speech: has('speech', v => !!str(v, 160)), status: has('status', v => !!str(v, 160)),
        // A home or a "met via" that is gone by now is left out, not refused.
        homeNear: has('home', v => typeof v === 'string' && placeList(state, world).some(x => x?.id === v)),
        via: has('metVia', v => typeof v === 'string' && state?.cast instanceof Map && state.cast.has(v)),
      };
      const planned = newCastPlan(n, state, at, cfg(), knownNames);
      if (planned.reason) return no(planned.reason);
      const payload = planned.payload;
      const stop = blocked({ category: 'cast', action: 'start', pinKeys: pinKeysFor({ type: 'cast.created', payload }, state) }, payload.id);
      if (stop) return stop;
      events.push({ ref: 'c', type: 'cast.created', payload });
      events.push({ ref: 'r', type: 'relationship.changed', causeRef: 'c', payload: { castId: payload.id, delta: { closeness: 0.2 }, reason: 'arc' } });
      break;
    }
    case 'new_place': {
      const name = str(p.name, 60);
      if (!name || !str(p.kind, 24) || !fin(p.lat) || !fin(p.lon)) return no('invalid');
      const places = placeList(state, world);
      if (places.length >= MAX_PLACES) return no('cap');
      const nameProblem = placeNameProblem(name, knownNames);
      if (nameProblem) return no(nameProblem.reason);
      const base = ctx.baseWorld ?? world;
      if (!inBox(regionBox(Array.isArray(base?.places) && base.places.length ? base : { places }), p.lat, p.lon)) return no('region');
      const id = uniqueId('place', slugFrom(name), new Set(places.map(x => x.id)));
      const stop = blocked({ category: 'social', action: 'start' }, id);
      if (stop) return stop;
      events.push({ ref: 'p', type: 'place.created', payload: { id, name, kind: p.kind, lat: p.lat, lon: p.lon } });
      break;
    }
    case 'arc_decision': {
      const opener = { kind: p.kind, castId: typeof p.castId === 'string' ? p.castId : null };
      const category = OPENERS[opener.kind]?.category ?? null;
      if (!category) return no('invalid');
      const built = openerSpec(opener, state, { at, world, weekKey: proposal.weekKey });
      if (!built.spec) return no('invalid', opener.castId);
      const stop = blocked({ category, action: 'decision', pinKeys: pinKeysFor({ type: 'decision.opened', payload: built.spec }, state) }, opener.castId);
      if (stop) return stop;
      // A guided category's decision opens as an Ask-me card (the owner picks), like openArcDecision's.
      const spec = { ...built.spec, mode: fateOf(category, state) === 'guided' ? 'ask' : 'auto' };
      let payload;
      try {
        payload = planOpened(state, spec, { at, world }).payload;
      } catch {
        return no('invalid', opener.castId);
      }
      events.push({ ref: 'd', type: 'decision.opened', payload });
      break;
    }
    case 'heavy_nomination':
      return no('unsupported', null);
    default:
      return no('invalid');
  }
  return { events, warnings: [], refusals };
}

// ── run ──────────────────────────────────────────────────────────────────────

function recordSkip(reason, at) {
  const st = store();
  try {
    const last = st.lastRun({ kind: 'weekly', status: 'skipped' });
    if (last && last.skipReason === reason && fin(last.startedAt) && at - last.startedAt < 20 * HOUR && at >= last.startedAt) return last.id;
    return st.recordRun({ kind: 'weekly', caller: WEEKLY_CALLER, status: 'skipped', skipReason: reason, startedAt: at, finishedAt: at });
  } catch {
    return null;
  }
}

function skipped(reason, at, { record = true } = {}) {
  const runId = record ? recordSkip(reason, at) : null;
  logger.info({ evt: 'arcs_weekly', status: 'skipped', reason, runId }, 'arcs weekly: skipped');
  return { status: 'skipped', reason, runId };
}

/** Is the weekly pass due (story_state.last_weekly_at ≥ 7 days old)? */
export function weeklyDue(at = nowSec()) {
  const last = store().getState('last_weekly_at');
  return !(fin(last) && at - last < WEEK_SEC && at >= last);
}

/**
 * One weekly pass (008 sleep step 4b via the life facade). Gates (header) →
 * one mind call → validateWeekly → applyWeekly. Never throws.
 *   opts: { nightKey, trigger, budgetOk } (budgetOk = mindBudgetOk('sleep')'s OBJECT)
 * → { status:'ok'|'partial'|'skipped'|'invalid'|'failed', reason?, runId, applied? }
 */
export async function runWeekly({ nightKey = null, trigger = null, budgetOk = null } = {}) {
  const at = nowSec();
  try {
    const isOn = deps.isOn ?? (() => false);
    if (!isOn()) return skipped('disabled', at, { record: false });
    const state = deps.getState?.();
    if (!state || state.genesisAt == null) return skipped('disabled', at, { record: false });
    if (isPaused(state)) return skipped('paused', at);
    if (!weeklyDue(at)) return skipped('not_due', at, { record: false });
    if (budgetOk?.ok !== true) return skipped(budgetOk?.reason === 'unpriced' ? 'unpriced' : 'budget', at);
    const c = cfg();
    const spent = await arcsCallerSpend(at, { tz: tzOf(state, deps.world), getUsageByCaller: deps.getUsageByCaller });
    if (!(spent < Number(c.mindBudgetUsd ?? 1))) return skipped('caller_cap', at);

    const world = deps.world ?? null;
    const seed = effectiveSeed(state, deps.seed ?? getArcSeed());
    const { input, labelMap } = buildWeeklyInput(state, seed, { at, world });
    const weekKey = input.week;
    const st = store();
    // The attempt counts for the week whatever happens next (no catch-up, no burst).
    st.patchState({ last_weekly_at: at });
    const runId = st.startRun({ kind: 'weekly', caller: WEEKLY_CALLER, input: { week: weekKey, nightKey, trigger, labels: labelMap }, startedAt: at });

    const persona = deps.persona ?? getPersona();
    const who = `You are writing for ${cleanItem(persona?.name, 40) || 'the character'} (${cleanItem(persona?.voiceDescriptor, 120) || 'an ordinary person'}).`;
    const user = `${who}\nWeek ${weekKey}.\n${fence(JSON.stringify(input), { kind: 'state', cap: INPUT_MAX_BYTES })}`;
    const call = deps.callRole ?? (await import('../../brain/llm.js')).callRole;
    const effort = typeof c.weeklyEffort === 'string' && c.weeklyEffort ? c.weeklyEffort : undefined;
    let res;
    try {
      res = await call('mind', WEEKLY_CHARTER, user, { caller: WEEKLY_CALLER, maxTokens: MAX_TOKENS, ...(effort ? { effort } : {}) });
    } catch {
      res = { text: null, status: 'error' };
    }
    const meta = { model: res?.model ?? null, fellBack: !!res?.fellBack, costUsd: fin(res?.costUsd) ? res.costUsd : null };
    if (res?.skipped) {
      const reason = ['budget', 'disabled', 'no_key'].includes(res.skipped) ? res.skipped : 'budget';
      st.bumpRun(runId, { status: 'skipped', skipReason: reason, ...meta });
      logger.info({ evt: 'arcs_weekly', status: 'skipped', reason, runId }, 'arcs weekly: skipped');
      return { status: 'skipped', reason, runId };
    }
    if (typeof res?.text !== 'string' || !res.text.trim()) {
      st.bumpRun(runId, { status: 'failed', ...meta });
      logger.warn({ evt: 'arcs_weekly', status: 'failed', runId }, 'arcs weekly: no output');
      return { status: 'failed', reason: 'no_text', runId };
    }
    const tz = tzOf(state, world);
    const v = validateWeekly(res.text, labelMap, { today: dateKey(at, tz) });
    if (!v.ok) {
      st.bumpRun(runId, { status: 'invalid', ...meta, dropped: [{ path: '', reason: v.error }, ...v.dropped].slice(0, 60) });
      logger.warn({ evt: 'arcs_weekly', status: 'invalid', reason: v.error, runId }, 'arcs weekly: invalid output');
      return { status: 'invalid', reason: v.error, runId };
    }
    const knownNames = deps.knownNames ?? realPeopleNames();
    const append = deps.append;
    if (typeof append !== 'function') {
      st.bumpRun(runId, { status: 'failed', ...meta, output: v.value });
      return { status: 'failed', reason: 'not_attached', runId };
    }
    const applied = await applyWeekly(v.value, labelMap, deps.getState?.() ?? state, append, {
      at, runId, weekKey, world, knownNames, fellBack: meta.fellBack, worldOf: deps.worldOf, getState: deps.getState,
    });
    st.patchState({ last_weekly_run: { runId, weekKey, at, nominated: applied.nominated ?? null, fellBack: meta.fellBack } });
    const status = v.dropped.length || applied.dropped || applied.refused ? 'partial' : 'ok';
    st.bumpRun(runId, { status, ...meta, output: v.value, dropped: v.dropped.slice(0, 60) });
    logger.info({ evt: 'arcs_weekly', status, runId, beats: applied.beats, newCast: applied.newCast, newPlace: applied.newPlace,
      decisions: applied.decisions, proposals: applied.proposals, refused: applied.refused, dropped: applied.dropped + v.dropped.length,
      fellBack: meta.fellBack }, 'arcs weekly: done');
    return { status, runId, applied };
  } catch (err) {
    logger.warn({ evt: 'arcs_weekly', status: 'failed', code: err?.code ?? null }, 'arcs weekly: failed');
    return { status: 'failed', reason: 'error' };
  }
}

/** The theme the last weekly pass nominated for the heavy roll (story_state), or null. */
export function nominatedTheme() {
  try {
    const r = store().getState('last_weekly_run');
    return typeof r?.nominated === 'string' ? r.nominated : null;
  } catch {
    return null;
  }
}

