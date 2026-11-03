import { CATEGORIES, FATE_MODES, SLIDERS, RECONCILER_MODES, isPinKey } from './reducer.js';

// Owner controls over the story (spec 010 research R6): fate modes, sliders,
// pins and pause, folded from director.* events into state.story.controls.
// Pure over the projection: nothing here writes, logs or reads the clock — a
// refusal row (store.recordRefusal) is the caller's job, and under sim:true
// (preview tomorrow) the caller just keeps the verdicts in memory.
//
//   check({source, category, action, pinKeys}, state) → {ok, reason?, pinKey?, ask?}
//
// Sources: 'engine' | 'mind' | 'reconciler' | 'owner'.
// Actions: 'start' (a new arc, a heavy onset) | 'beat' (offscreen beat, drift,
//          status line) | 'decision' (opening an arc decision) | 'adopt' (a claim
//          → world) | 'change' (the consequence of an already-open/committed
//          decision, a stage step it caused).
//
// Order for engine/mind/reconciler:
//   1. paused  — refuses start/beat/decision/adopt; 'change' still passes
//                (FR-043: already-open decisions continue);
//   2. frozen  — refuses every action in that category (a committed decision's
//                consequence becomes the terminal decision.expired{frozen});
//   3. pinned  — the first pinned key in pinKeys refuses (FR-005);
//   4. guided  — the mind is parked ({ok:false, reason:'guided'}: the weekly
//                proposal waits for the owner); an engine decision passes as a
//                card ({ok:true, reason:'guided', ask:true}); everything else
//                passes.
// The owner (Director) is refused only by pins and, for 'start', by frozen.

const SOURCES = new Set(['engine', 'mind', 'reconciler', 'owner']);
const ACTIONS = new Set(['start', 'beat', 'decision', 'adopt', 'change']);
const PAUSE_REFUSES = new Set(['start', 'beat', 'decision', 'adopt']);
// Kept in step with heavy.js HEAVY_KINDS (research R17); job_loss is deferred.
const HEAVY_KIND_SET = new Set(['family_illness', 'breakup', 'friend_moving_away', 'pet_loss', 'minor_accident', 'money_setback']);
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function controlsOf(state) {
  const c = state?.story?.controls;
  return isObj(c) ? c : {};
}

/** Fate mode of a category: 'natural' (default) | 'guided' | 'frozen'; null for an unknown category. */
export function fateOf(category, state) {
  if (!CATEGORIES.includes(category)) return null;
  const m = controlsOf(state).fate?.[category];
  return FATE_MODES.includes(m) ? m : 'natural';
}

/** A slider's value 0..1 (default 0.5); null for an unknown name. */
export function sliderValue(name, state) {
  if (!SLIDERS.includes(name)) return null;
  const v = controlsOf(state).sliders?.[name];
  return finite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

/**
 * Multiplier a roll applies to its base probability (research R6): 0.5 + slider
 * (×0.5 … ×1.5), except heavyLikelihood: 2 × slider (0 disables; the hard heavy
 * cap stays in heavy.js). 1 for an unknown name.
 */
export function sliderFactor(name, state) {
  const v = sliderValue(name, state);
  if (v === null) return 1;
  return name === 'heavyLikelihood' ? 2 * v : 0.5 + v;
}

/** True while the owner has paused the story. */
export function isPaused(state) {
  return controlsOf(state).paused === true;
}

/** The pin record {eventId, at} for a key, or null. */
export function pinOf(key, state) {
  const pins = controlsOf(state).pins;
  return isObj(pins) && isObj(pins[key]) ? pins[key] : null;
}

/** The reconciler mode in force: the owner's (director.reconciler_mode) or `fallback` (config.arcs.reconcilerMode). */
export function reconcilerModeOf(state, fallback = 'auto') {
  const m = controlsOf(state).reconcilerMode;
  if (RECONCILER_MODES.includes(m)) return m;
  return RECONCILER_MODES.includes(fallback) ? fallback : 'auto';
}

/**
 * Category of a decision/arc kind (FR-003): a bare category, a `<category>:…`
 * prefix (`romance:step`, `career:offer`), or a heavy kind → 'heavy'. null when
 * none fits (callers fail closed).
 */
export function categoryOf(kind) {
  if (typeof kind !== 'string') return null;
  const k = kind.trim().toLowerCase();
  if (CATEGORIES.includes(k)) return k;
  const prefix = k.split(':')[0];
  if (k.includes(':') && CATEGORIES.includes(prefix)) return prefix;
  return HEAVY_KIND_SET.has(k) ? 'heavy' : null;
}

function castKeys(...lists) {
  const out = [];
  for (const v of lists) {
    for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'string' && CAST_ID_RE.test(id)) out.push(id);
  }
  return out;
}

function arcKeys(arcId, state) {
  const id = posInt(arcId);
  if (!id) return [];
  const arc = state?.story?.arcs?.[id];
  const keys = [`arc:${id}.stage`];
  if (isObj(arc)) {
    keys.push(...castKeys(arc.castIds));
    if (arc.category === 'romance') keys.push('self.relationship');
  }
  return keys;
}

/**
 * Pin keys a change touches (research R6). `change` is an event descriptor
 * {type, payload} (what the caller is about to append); `state` resolves arcs.
 * Pin keys: 'self.job', 'self.home' (reserved), 'self.relationship',
 * 'arc:<id>.stage', and a cast id ('cast:<slug>') for anything about that
 * member — identity fields, status, beats, history, metrics, arcs they're in.
 */
export function pinKeysFor(change, state) {
  if (!isObj(change)) return [];
  const type = typeof change.type === 'string' ? change.type : '';
  const p = isObj(change.payload) ? change.payload : {};
  const keys = [];
  switch (type) {
    case 'career.resigned':
    case 'career.job_changed':
      keys.push('self.job');
      break;
    case 'cast.updated':
    case 'cast.beat':
    case 'cast.history_added':
    case 'relationship.changed':
    case 'family.call':
      keys.push(...castKeys(p.castId));
      break;
    case 'cast.created':
      keys.push(...castKeys(p.id, p.metVia));
      break;
    case 'arc.started':
      keys.push(...castKeys(p.castIds));
      if (p.category === 'romance') keys.push('self.relationship');
      break;
    case 'arc.stage':
    case 'arc.ended':
      keys.push(...arcKeys(p.arcId, state));
      break;
    case 'heavy.proposed':
    case 'heavy.started': {
      keys.push(...castKeys(p.castId));
      if (p.kind === 'breakup') {
        keys.push('self.relationship');
        const romanceArc = state?.story?.romance?.arcId;
        if (romanceArc) keys.push(`arc:${romanceArc}.stage`);
      }
      break;
    }
    case 'decision.opened': {
      const cat = categoryOf(p.category) ?? categoryOf(p.kind);
      keys.push(...castKeys(p.subject?.castIds));
      if (p.arcId) keys.push(...arcKeys(p.arcId, state));
      if (cat === 'romance') keys.push('self.relationship');
      if (typeof p.kind === 'string' && /^career:(offer|resign)/.test(p.kind)) keys.push('self.job');
      break;
    }
    default:
      break;
  }
  return [...new Set(keys)].filter(isPinKey);
}

/**
 * The one gate (research R6). `opts.state` may stand in for the second argument.
 * Unknown source/action/category → {ok:false, reason:'invalid'} (fail closed).
 */
export function check(opts = {}, state = opts?.state) {
  const { source, category, action } = isObj(opts) ? opts : {};
  if (!SOURCES.has(source) || !ACTIONS.has(action) || !CATEGORIES.includes(category)) return { ok: false, reason: 'invalid' };
  const pinKeys = Array.isArray(opts.pinKeys) ? opts.pinKeys.filter(isPinKey) : [];
  const fate = fateOf(category, state);
  const pinned = pinKeys.find(k => pinOf(k, state));

  if (source === 'owner') {
    if (action === 'start' && fate === 'frozen') return { ok: false, reason: 'frozen' };
    if (pinned) return { ok: false, reason: 'pinned', pinKey: pinned };
    return { ok: true };
  }

  if (isPaused(state) && PAUSE_REFUSES.has(action)) return { ok: false, reason: 'paused' };
  if (fate === 'frozen') return { ok: false, reason: 'frozen' };
  if (pinned) return { ok: false, reason: 'pinned', pinKey: pinned };
  if (fate === 'guided') {
    if (source === 'mind') return { ok: false, reason: 'guided' };
    if (source === 'engine' && action === 'decision') return { ok: true, reason: 'guided', ask: true };
  }
  return { ok: true };
}
