// Knob overlay (spec 008, research R14, contracts/levers.md) — the ONLY way a mind
// nudge changes behaviour. Nudges never touch `config`, `.env` or skills: they live
// in mind_nudges (written by levers.js through the store) and are mirrored here in an
// in-memory map that the reply path reads through sync getters.
//
//   responseRate()            absolute; the owner's live config.responseRate when no nudge
//   groupRate(groupJid)       multiplier, 1 when none
//   reactTendency()           multiplier, 1 when none
//   replyLength(chatJid)      'shorter'|'normal'|'longer' (group scope first, then global)
//   proactiveAppetite()       multiplier, 1 when none
//
// Getters are sync, never throw and fall back to the OWNER value when the mind skill
// is off, the mind is paused, the knob's band is disabled, no unexpired nudge exists,
// or anything fails. Every nudge value is RE-CLAMPED AT READ TIME against the band
// computed from the *current* base (plan review S2-17), so an absolute responseRate
// nudge can never leave its band after the owner changes RESPONSE_RATE in .env and
// restarts. reload() rebuilds the map from `active = 1 AND expires_at > now`, and
// marks an active responseRate nudge whose band snapshot base differs from the current
// config.responseRate as `overridden` (the owner changed the base).
//
// Bands: DEFAULT_BANDS here, overridden per knob by the owner's mind_settings.bands
// (validated by validateBands; hard limits responseRate ceil ≤ 0.5, multipliers in
// [0.25, 2]). The mind cannot reach bands: only the owner path writes them.
// This module never imports levers.js (levers imports it). It logs ids/codes only.

import * as store from './store.js';
import { now as clockNow } from './clock.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// ── knob metadata + bands ───────────────────────────────────────────────────

export const LENGTHS = Object.freeze(['shorter', 'normal', 'longer']);

/** The five knobs (contracts/levers.md allow-list). scope: 'global' | 'group' | 'any'. */
export const KNOBS = Object.freeze({
  responseRate: Object.freeze({ scope: 'global', type: 'absolute', ttlHours: 24, label: 'Response rate (base score)' }),
  groupResponseRate: Object.freeze({ scope: 'group', type: 'multiplier', ttlHours: 24, neutral: 1,
    label: 'Per-group response multiplier' }),
  reactTendency: Object.freeze({ scope: 'global', type: 'multiplier', ttlHours: 24, neutral: 1,
    label: 'Reaction tendency multiplier' }),
  replyLength: Object.freeze({ scope: 'any', type: 'length', ttlHours: 12, neutral: 'normal', label: 'Reply length' }),
  proactiveAppetite: Object.freeze({ scope: 'global', type: 'multiplier', ttlHours: 48, neutral: 1,
    label: 'Proactive appetite multiplier' }),
});
export const KNOB_NAMES = Object.freeze(Object.keys(KNOBS));

export const DEFAULT_BANDS = Object.freeze({
  responseRate: Object.freeze({ minFactor: 0.6, maxFactor: 1.25, floor: 0.02, ceil: 0.5, maxStep: 0.03 }),
  groupResponseRate: Object.freeze({ min: 0.6, max: 1.3, maxStep: 0.2 }),
  reactTendency: Object.freeze({ min: 0.7, max: 1.5, maxStep: 0.3 }),
  replyLength: Object.freeze({ allowed: Object.freeze(['shorter', 'normal']) }),
  proactiveAppetite: Object.freeze({ min: 0.5, max: 1.2, maxStep: 0.25 }),
});

/**
 * Owner band edits must stay inside these (contracts/dashboard-api.md PUT /api/mind/bands).
 * routes/mind.js validateBands enforces the same numbers (it never imports the mind) —
 * keep the two in step; GET /api/mind/bands shows these as hardLimits. maxStep > 0.
 */
export const HARD_LIMITS = Object.freeze({
  responseRate: Object.freeze({ floor: 0, ceil: 0.5, minFactor: 0.01, maxFactor: 2, maxStep: 0.1 }),
  multiplier: Object.freeze({ min: 0.25, max: 2, maxStep: 1 }),
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const round4 = (v) => Math.round(v * 10000) / 10000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an owner bands object (partial allowed: a missing knob keeps its default).
 * → { ok, bands (complete, normalised), errors: [{knob, field?, reason}] }. Unknown
 * knobs or fields, non-finite numbers, min > max and values outside HARD_LIMITS are
 * errors; `ok` is false when there is any error (the owner route should 400).
 */
export function validateBands(input) {
  const errors = [];
  const out = {};
  const src = isObj(input) ? input : {};
  if (input != null && !isObj(input)) errors.push({ knob: null, reason: 'not_an_object' });
  for (const k of Object.keys(src)) if (!KNOBS[k]) errors.push({ knob: String(k).slice(0, 40), reason: 'unknown_knob' });
  for (const knob of KNOB_NAMES) {
    const def = DEFAULT_BANDS[knob];
    const given = src[knob];
    if (given === undefined || given === null) { out[knob] = { ...def, ...(def.allowed ? { allowed: [...def.allowed] } : {}) }; continue; }
    if (!isObj(given)) { errors.push({ knob, reason: 'not_an_object' }); out[knob] = { ...def }; continue; }
    const fields = knob === 'responseRate' ? ['minFactor', 'maxFactor', 'floor', 'ceil', 'maxStep', 'disabled']
      : knob === 'replyLength' ? ['allowed', 'disabled'] : ['min', 'max', 'maxStep', 'disabled'];
    for (const f of Object.keys(given)) if (!fields.includes(f)) errors.push({ knob, field: String(f).slice(0, 40), reason: 'unknown_field' });
    const b = {};
    if (given.disabled !== undefined) {
      if (typeof given.disabled !== 'boolean') errors.push({ knob, field: 'disabled', reason: 'not_boolean' });
      else if (given.disabled) b.disabled = true;
    }
    if (knob === 'replyLength') {
      const allowed = given.allowed === undefined ? [...def.allowed] : given.allowed;
      if (!Array.isArray(allowed) || !allowed.length || allowed.some(a => !LENGTHS.includes(a))) {
        errors.push({ knob, field: 'allowed', reason: 'bad_value' });
        b.allowed = [...def.allowed];
      } else {
        b.allowed = LENGTHS.filter(l => allowed.includes(l));
      }
      out[knob] = b;
      continue;
    }
    const lim = knob === 'responseRate' ? HARD_LIMITS.responseRate : HARD_LIMITS.multiplier;
    for (const f of fields.filter(x => x !== 'disabled')) {
      const v = given[f] === undefined ? def[f] : given[f];
      if (!fin(v)) { errors.push({ knob, field: f, reason: 'not_a_number' }); b[f] = def[f]; continue; }
      let lo = 0;
      let hi = Infinity;
      if (f === 'maxStep') { lo = 0; hi = lim.maxStep; }
      else if (knob === 'responseRate') { lo = f === 'floor' || f === 'ceil' ? lim.floor : lim.minFactor; hi = f === 'floor' || f === 'ceil' ? lim.ceil : lim.maxFactor; }
      else { lo = lim.min; hi = lim.max; }
      if (v < lo || v > hi || (f === 'maxStep' && v <= 0)) { errors.push({ knob, field: f, reason: 'out_of_limits' }); b[f] = def[f]; continue; }
      b[f] = v;
    }
    if (knob === 'responseRate') {
      if (b.minFactor > b.maxFactor) errors.push({ knob, field: 'minFactor', reason: 'min_gt_max' });
      if (b.floor > b.ceil) errors.push({ knob, field: 'floor', reason: 'min_gt_max' });
    } else if (b.min > b.max) {
      errors.push({ knob, field: 'min', reason: 'min_gt_max' });
    }
    out[knob] = b;
  }
  return { ok: errors.length === 0, bands: out, errors };
}

/**
 * The owner's stored bands merged over the defaults, field by field. A stored band that
 * fails validation for a knob falls back to that knob's default (fail closed to the
 * documented bands, never to "no limit").
 */
export function effectiveBands(stored) {
  if (stored == null) return validateBands(null).bands;
  const out = {};
  for (const knob of KNOB_NAMES) {
    const one = validateBands({ [knob]: isObj(stored) ? stored[knob] : undefined });
    out[knob] = one.ok ? one.bands[knob] : validateBands(null).bands[knob];
  }
  return out;
}

/**
 * The concrete band of a knob for a base (responseRate: the owner's current
 * config.responseRate). → { min, max, maxStep, base? } for numbers, { allowed } for
 * replyLength, plus disabled when set. A responseRate band whose computed min > max
 * (a tiny base) collapses to [base, base].
 */
export function bandFor(knob, bands, base) {
  const b = (bands && bands[knob]) || DEFAULT_BANDS[knob];
  if (!b) return null;
  const disabled = b.disabled === true;
  if (knob === 'replyLength') return { allowed: [...(b.allowed || DEFAULT_BANDS.replyLength.allowed)], disabled };
  if (knob === 'responseRate') {
    const bs = fin(base) ? base : 0;
    let min = round4(Math.max(b.floor, b.minFactor * bs));
    let max = round4(Math.min(b.ceil, b.maxFactor * bs));
    if (min > max) { min = round4(bs); max = round4(bs); }
    return { min, max, maxStep: b.maxStep, base: bs, minFactor: b.minFactor, maxFactor: b.maxFactor, floor: b.floor,
      ceil: b.ceil, disabled };
  }
  return { min: b.min, max: b.max, maxStep: b.maxStep, disabled };
}

/** Clamp a value into a band (numbers: [min, max]; replyLength: the nearest allowed length, ties → 'normal'). */
export function clampToBand(knob, value, band) {
  if (!band) return null;
  if (knob === 'replyLength') {
    if (!LENGTHS.includes(value)) return null;
    if (band.allowed.includes(value)) return value;
    const at = LENGTHS.indexOf(value);
    let best = null;
    for (const a of band.allowed) {
      const d = Math.abs(LENGTHS.indexOf(a) - at);
      const bd = best === null ? Infinity : Math.abs(LENGTHS.indexOf(best) - at);
      if (d < bd || (d === bd && a === 'normal')) best = a;
    }
    return best;
  }
  if (!fin(value)) return null;
  return round4(Math.min(band.max, Math.max(band.min, value)));
}

// ── deps (test seam) ────────────────────────────────────────────────────────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  isPaused: () => store.getSettings().paused === true,
  base: () => Number(config.responseRate),
  logger,
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: { now, isMindOn, isPaused, base, logger }. null resets (and clears the overlay). */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
  if (!d) { overlay = new Map(); bandsCache = null; pausedCache = { at: -Infinity, value: true }; }
  else pausedCache = { at: -Infinity, value: true };
}

// ── overlay state ───────────────────────────────────────────────────────────

let overlay = new Map();    // "knob|scope" → { id, knob, scope, value, expiresAt }
let bandsCache = null;      // effective bands, refreshed by reload()
let pausedCache = { at: -Infinity, value: true };
const PAUSED_TTL_SEC = 5;

const keyOf = (knob, scope) => `${knob}|${scope}`;
const nowSec = () => Math.floor(deps.now());
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const bareGroup = (j) => (isGroupJid(j) ? j.trim() : null);

function currentBands() {
  return bandsCache || DEFAULT_BANDS;
}

function pausedNow() {
  const t = nowSec();
  if (t - pausedCache.at < PAUSED_TTL_SEC && t >= pausedCache.at) return pausedCache.value;
  let v = true;   // fail closed: an unreadable pause flag means owner values
  try { v = deps.isPaused() === true; } catch { v = true; }
  pausedCache = { at: t, value: v };
  return v;
}

/** True when nudges may apply: the mind skill is on and the mind is not paused. Never throws. */
export function overlayActive() {
  try { return deps.isMindOn() === true && !pausedNow(); } catch { return false; }
}

function ownerBase() {
  const b = Number(deps.base());
  return Number.isFinite(b) ? b : 0;
}

function numEq(a, b) {
  return fin(a) && fin(b) && Math.abs(a - b) < 1e-9;
}

/**
 * Reload the overlay from mind_nudges (active = 1 AND expires_at > now) and the owner's
 * bands. An active responseRate nudge whose snapshot base differs from the current
 * config.responseRate is ended `overridden` (ended_by 'override'). Throws on a DB error
 * after clearing the overlay (owner values), so a caller such as the pulse's degraded
 * recovery can tell it failed. → { active, overridden: [id] }
 */
export function reload() {
  try {
    const t = nowSec();
    bandsCache = effectiveBands(store.getSettings().bands);
    pausedCache = { at: -Infinity, value: true };
    const base = ownerBase();
    const next = new Map();
    const overridden = [];
    for (const r of store.activeNudges()) {
      if (!KNOBS[r.knob]) continue;
      if (!fin(r.expiresAt) || r.expiresAt <= t) continue;   // the pulse marks it expired
      if (r.knob === 'responseRate') {
        const snap = isObj(r.band) ? Number(r.band.base) : NaN;
        if (!numEq(snap, base)) {
          if (store.endNudge(r.id, 'overridden', 'override')) overridden.push(r.id);
          continue;
        }
      }
      next.set(keyOf(r.knob, r.scope), { id: r.id, knob: r.knob, scope: r.scope, value: r.value, expiresAt: r.expiresAt });
    }
    overlay = next;
    if (overridden.length) {
      try { deps.logger.info({ evt: 'mind.knobs', overridden: overridden.length }, 'mind: stale-base nudges overridden'); } catch { /* */ }
    }
    return { active: overlay.size, overridden };
  } catch (err) {
    overlay = new Map();
    try { deps.logger.warn({ evt: 'issue', where: 'mind.knobs.reload', code: String(err?.code || err?.name || 'error').slice(0, 60) },
      'mind: knob reload failed; owner values in effect'); } catch { /* */ }
    throw err;
  }
}

/** The raw overlay entry for (knob, scope) if unexpired, regardless of on/paused. */
function entry(knob, scope) {
  const e = overlay.get(keyOf(knob, scope));
  if (!e) return null;
  if (!fin(e.expiresAt) || e.expiresAt <= nowSec()) return null;
  return e;
}

/**
 * The value a knob has for (knob, scope) with every unexpired nudge applied and
 * re-clamped, ignoring the on/paused switches (the lever executor's "current" value).
 * replyLength at a group scope falls back to the global nudge. Never throws.
 */
export function effective(knob, scope = 'global') {
  try {
    const bands = currentBands();
    const base = ownerBase();
    const def = KNOBS[knob];
    if (!def) return null;
    const band = bandFor(knob, bands, base);
    const owner = knob === 'responseRate' ? base : def.neutral;
    if (band.disabled) return owner;
    let e = entry(knob, scope);
    if (!e && knob === 'replyLength' && scope !== 'global') e = entry(knob, 'global');
    if (!e) return owner;
    const v = clampToBand(knob, e.value, band);
    return v === null ? owner : v;
  } catch {
    return knob === 'responseRate' ? ownerBase() : (KNOBS[knob]?.neutral ?? null);
  }
}

// ── getters (the reply path) ────────────────────────────────────────────────

/** The base response probability: the owner's config.responseRate unless an active nudge applies. */
export function responseRate() {
  try {
    if (!overlayActive()) return ownerBase();
    return effective('responseRate', 'global');
  } catch { return ownerBase(); }
}

/** Per-group multiplier on the score (1 when none). */
export function groupRate(groupJid) {
  try {
    const g = bareGroup(groupJid);
    if (!g || !overlayActive()) return 1;
    return effective('groupResponseRate', g);
  } catch { return 1; }
}

/** Multiplier on the reaction share and the probability-miss fallback (1 when none). */
export function reactTendency() {
  try { return overlayActive() ? effective('reactTendency', 'global') : 1; } catch { return 1; }
}

/** Multiplier on proactive acceptance (glance reach-out, candidate urgency; 1 when none). */
export function proactiveAppetite() {
  try { return overlayActive() ? effective('proactiveAppetite', 'global') : 1; } catch { return 1; }
}

/** 'shorter'|'normal'|'longer' for this chat: a group-scope nudge first, then the global one. */
export function replyLength(chatJid) {
  try {
    if (!overlayActive()) return 'normal';
    const g = bareGroup(chatJid);
    const v = effective('replyLength', g || 'global');
    return LENGTHS.includes(v) ? v : 'normal';
  } catch { return 'normal'; }
}

/** The getters as one namespace (the facade re-exports it as `knobs`). */
export const knobs = Object.freeze({ responseRate, groupRate, reactTendency, replyLength, proactiveAppetite });

/** Dashboard view: the effective bands, the base, and every overlay entry with its re-clamped value. */
export function snapshot() {
  const base = ownerBase();
  return {
    base,
    active: overlayActive(),
    bands: currentBands(),
    entries: [...overlay.values()].map(e => ({ ...e, effective: effective(e.knob, e.scope) })),
  };
}

/** The effective bands the executor clamps against (owner bands over the defaults). */
export function getBands() {
  return currentBands();
}
