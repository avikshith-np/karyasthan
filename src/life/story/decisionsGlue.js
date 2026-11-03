// Arc decisions and Ask-me cards (spec 010 US5, research R14, contracts/
// story-api.md §2, director-api.md §2).
//
//   openArcDecision(stateOrGetter, spec, ctx)
//       Every story module opens its decisions through here (the facade passes
//       it as their `openDecision`). In order:
//         1. the category: spec.category, else the kind's prefix (romance:…);
//            one of reducer CATEGORIES, or the spec is refused;
//         2. controls.check({source, category, action:'decision', pinKeys}):
//            refused → StoryError('refused', reason) and nothing is opened (the
//            callers catch it: a refused decision is never half-opened);
//            guided → the decision opens as an Ask-me card (mode 'ask');
//         3. big → mode 'ask' with a lead time: decideBy − now must be at least
//            ARCS_BIG_LEAD_HOURS. The opener usually sets decideBy itself; a spec
//            marked `movable` has its event (and decideBy) moved later instead;
//            otherwise it opens as an ordinary decision with
//            bigDowngraded:'lead_time' (the board says why);
//         4. decisions.openDecision with the cleaned spec (ctx passes through:
//            world, at, append, causeId, subjectJid).
//
//   cardsView(state, { includeClosed, now, leanHistory, fateOf })
//       Card[] for the Pending page: open decisions in mode 'ask' (and every open
//       arc decision of a guided category), arc / ask decisions closed in the
//       last 3 days, and heavy veto cards built from heavy.proposed. Questions
//       and labels are code templates and the decisions' own option labels;
//       never model or chat text.
//
// Logging: ids, kinds and reason codes only.

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { now as clockNow } from '../clock.js';
import { openDecision as openDecisionDefault, availableOptions } from '../decisions.js';
import { leanHistory as leanHistoryDefault } from '../eventLog.js';
import { CATEGORIES } from './reducer.js';
import { check as controlsCheck, fateOf as fateOfDefault } from './controls.js';

const HOUR = 3600;
const DAY = 86400;
const CLOSED_WINDOW_SEC = 3 * DAY;
const CARDS_MAX = 60;
const SOURCES = new Set(['engine', 'mind', 'reconciler']);
const LEAN_BY = new Set(['jev', 'engine']);
const OUTCOME_BY = new Set(['owner', 'lean', 'sample', 'early', 'adopted']);
const PIN_KEY_RE = /^(self\.(job|home|relationship)|arc:[1-9]\d{0,14}\.stage|cast:[a-z0-9][a-z0-9-]{0,39})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function storyError(code, reason = null) {
  return Object.assign(new Error(`story: ${code}${reason ? ` (${reason})` : ''}`), { name: 'StoryError', code, reason });
}

let deps = {};
/** Test seam: { openDecision, now, leanHistory, logger } (null → defaults). */
export function __setDepsForTest(d) {
  deps = isObj(d) ? { ...d } : {};
}

const nowSec = () => Math.floor((deps.now ?? clockNow)());
const log = () => deps.logger ?? logger;

function leadSec() {
  const h = Number(config.arcs?.bigLeadHours);
  return (Number.isFinite(h) && h >= 24 ? h : 24) * HOUR;
}

/** The arc category of a spec (explicit, else the kind's prefix), or null. */
export function categoryOfSpec(spec) {
  if (typeof spec?.category === 'string' && CATEGORIES.includes(spec.category)) return spec.category;
  const prefix = typeof spec?.kind === 'string' ? spec.kind.split(':')[0] : null;
  return prefix && CATEGORIES.includes(prefix) ? prefix : null;
}

/**
 * Plan the spec openDecision gets (pure; exported for the tests).
 * → { spec } | { refused: reason, pinKey? }
 */
export function planArcSpec(state, spec, { at, source = 'engine' } = {}) {
  if (!isObj(spec)) return { refused: 'invalid' };
  const category = categoryOfSpec(spec);
  if (!category) return { refused: 'invalid' };
  const pinKeys = Array.isArray(spec.pinKeys) ? spec.pinKeys.filter(k => typeof k === 'string' && PIN_KEY_RE.test(k)) : [];
  const v = controlsCheck({ source: SOURCES.has(source) ? source : 'engine', category, action: 'decision', pinKeys }, state);
  if (!v.ok) return { refused: v.reason ?? 'refused', ...(v.pinKey ? { pinKey: v.pinKey } : {}) };
  const out = { ...spec, category };
  delete out.pinKeys;
  delete out.movable;
  const ask = v.ask === true;
  if (spec.big === true) {
    const lead = leadSec();
    let decideBy = Number.isInteger(spec.decideBy) ? spec.decideBy : null;
    const eventAt = Number.isInteger(spec.subject?.eventAt) ? spec.subject.eventAt : null;
    // No explicit deadline: an hour before the event, when that leaves the lead time.
    if (decideBy === null && eventAt !== null && eventAt - HOUR - at >= lead) decideBy = eventAt - HOUR;
    if (decideBy !== null && decideBy - at >= lead) {
      out.big = true;
      out.decideBy = decideBy;
      out.mode = 'ask';
    } else if (spec.movable === true && eventAt !== null) {
      const shift = at + lead - (decideBy ?? at);
      out.subject = { ...spec.subject, eventAt: eventAt + shift };
      out.decideBy = at + lead;
      out.big = true;
      out.mode = 'ask';
    } else {
      out.big = false;
      out.bigDowngraded = 'lead_time';
      if (decideBy !== null) out.decideBy = decideBy;
      out.mode = ask ? 'ask' : 'auto';
    }
  } else if (ask) {
    out.mode = 'ask';
  }
  return { spec: out, guided: ask };
}

/**
 * Open an arc decision (story-api §2). stateOrGetter: the projection or a getter
 * (decisions.openDecision accepts both). ctx: { world, at, append, causeId,
 * subjectJid, source?, onRefused?(row) }. Throws StoryError('refused'|'invalid')
 * when nothing may be opened. → openDecision's { decision, events }
 */
export async function openArcDecision(stateOrGetter, spec, ctx = {}) {
  const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter;
  const at = Number.isInteger(ctx.at) ? ctx.at : nowSec();
  const planned = planArcSpec(state, spec, { at, source: ctx.source });
  if (planned.refused) {
    if (typeof ctx.onRefused === 'function') {
      try {
        ctx.onRefused({ source: SOURCES.has(ctx.source) ? ctx.source : 'engine', category: categoryOfSpec(spec), action: 'decision',
          target: typeof spec?.kind === 'string' ? spec.kind.slice(0, 40) : null, reason: planned.refused, pinKey: planned.pinKey ?? null, at });
      } catch { /* an operational log only */ }
    }
    log().info({ evt: 'arcs.decision', status: 'refused', reason: planned.refused, kind: typeof spec?.kind === 'string' ? spec.kind.slice(0, 32) : null }, 'story: arc decision refused');
    throw storyError(planned.refused === 'invalid' ? 'invalid' : 'refused', planned.refused);
  }
  const open = deps.openDecision ?? openDecisionDefault;
  const { onRefused, source, ...rest } = ctx;
  void onRefused; void source;
  return open(stateOrGetter, planned.spec, { ...rest, at });
}

// ── Cards ─────────────────────────────────────────────────────────────────

function words(kind) {
  const w = typeof kind === 'string' ? kind.replace(/^[a-z]+:/, '').replace(/[_:-]+/g, ' ').trim() : '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : 'A decision';
}

function questionOf(d) {
  const labels = (Array.isArray(d.options) ? d.options : []).map(o => (typeof o?.label === 'string' && o.label ? o.label : o?.id))
    .filter(Boolean).slice(0, 4);
  return `${words(d.kind)}: ${labels.join(' / ')}?`.slice(0, 300);
}

function cleanCost(c) {
  const out = {};
  for (const k of ['energy', 'money', 'social', 'stress', 'travelMin']) out[k] = finite(c?.[k]) ? Math.round(c[k] * 100) / 100 : 0;
  return out;
}

function statusOf(d) {
  if (['open', 'committed', 'expired', 'cancelled', 'missed'].includes(d.status)) return d.status;
  return 'expired';
}

function outcomeOf(d) {
  const c = d.committed;
  if (!isObj(c) || typeof c.optionId !== 'string') return null;
  return { by: OUTCOME_BY.has(c.by) ? c.by : (c.sampled ? 'sample' : 'early'), optionId: c.optionId, at: finite(c.at) ? c.at : null };
}

function leanOf(d) {
  const l = d.lean;
  if (!isObj(l) || typeof l.optionId !== 'string') return null;
  return {
    optionId: l.optionId, p: finite(l.p) ? l.p : null, by: LEAN_BY.has(l.by) ? l.by : 'engine',
    fallback: typeof l.fallback === 'string' && /^[a-z_]{1,24}$/.test(l.fallback) ? l.fallback : null,
  };
}

function decisionCard(d, state, at, ctx) {
  const avail = new Set((() => { try { return availableOptions(d, at).map(o => o.id); } catch { return []; } })());
  let history = [];
  try {
    history = (ctx.leanHistory(d.id, 50) || []).map(h => ({ at: h.at, optionId: h.optionId, p: h.p }));
  } catch { history = []; }
  const category = typeof d.category === 'string' ? d.category : null;
  let guided = false;
  try { guided = !!category && ctx.fateOf(category, state) === 'guided'; } catch { guided = false; }
  return {
    id: d.id, type: 'decision', category, kind: d.kind, big: d.big === true, guided,
    ...(d.bigDowngraded === 'lead_time' ? { bigDowngraded: 'lead_time' } : {}),
    question: questionOf(d),
    options: (Array.isArray(d.options) ? d.options : []).map(o => ({
      id: o.id, label: typeof o.label === 'string' ? o.label : o.id, cost: cleanCost(o.cost),
      expiresAt: finite(o.expiresAt) ? o.expiresAt : null,
      expired: d.status === 'open' ? !avail.has(o.id) : false,
    })),
    lean: leanOf(d),
    leanHistory: history,
    opensAt: d.opensAt ?? null, decideBy: d.decideBy ?? null, ponrAt: d.ponrAt ?? null, now: at,
    status: statusOf(d),
    outcome: outcomeOf(d),
  };
}

function heavyCard(id, prop, at, ctx) {
  const status = ['pending', 'vetoed', 'started', 'lapsed'].includes(prop.status) ? prop.status : 'lapsed';
  let themeLabel = null;
  try { themeLabel = ctx.themeLabel?.(prop.themeId) ?? null; } catch { themeLabel = null; }
  const kindWords = typeof prop.kind === 'string' ? prop.kind.replace(/_/g, ' ') : 'something hard';
  const label = typeof themeLabel === 'string' && themeLabel ? themeLabel.slice(0, 80) : kindWords;
  return {
    id: `heavy:${id}`, type: 'heavy_veto', category: 'heavy', kind: prop.kind ?? null, big: true, guided: false,
    question: `Something hard is coming: ${label}. Let it happen?`.slice(0, 300),
    options: [
      { id: 'veto', label: 'Veto it', cost: cleanCost(null), expiresAt: prop.onsetAt ?? null, expired: !(at < prop.onsetAt) || status !== 'pending' },
    ],
    lean: null, leanHistory: [],
    opensAt: prop.at ?? null, decideBy: prop.onsetAt ?? null, ponrAt: prop.onsetAt ?? null, now: at,
    status: status === 'pending' ? 'open' : status === 'vetoed' ? 'cancelled' : status === 'started' ? 'committed' : 'expired',
    outcome: status === 'vetoed' ? { by: 'owner', optionId: 'veto', at: null } : null,
    heavy: { themeLabel: label, kind: prop.kind ?? null, onsetAt: prop.onsetAt ?? null, status },
  };
}

/**
 * The Ask-me cards of a projection (director-api §2). opts: { includeClosed =
 * true, now, leanHistory(id, n), fateOf(category, state), themeLabel(themeId) }.
 * Newest decisions first; never throws.
 */
export function cardsView(state, opts = {}) {
  const at = finite(opts.now) ? Math.floor(opts.now) : nowSec();
  const includeClosed = opts.includeClosed !== false;
  const ctx = {
    leanHistory: typeof opts.leanHistory === 'function' ? opts.leanHistory : (deps.leanHistory ?? leanHistoryDefault),
    fateOf: typeof opts.fateOf === 'function' ? opts.fateOf : fateOfDefault,
    themeLabel: typeof opts.themeLabel === 'function' ? opts.themeLabel : null,
  };
  const out = [];
  try {
    const decisions = state?.decisions instanceof Map ? [...state.decisions.values()] : [];
    for (const d of decisions) {
      if (!isObj(d) || d.adopted === true) continue;
      const arc = typeof d.category === 'string' && CATEGORIES.includes(d.category);
      const open = d.status === 'open';
      let guided = false;
      try { guided = arc && ctx.fateOf(d.category, state) === 'guided'; } catch { guided = false; }
      if (open && !(d.mode === 'ask' || guided)) continue;
      if (!open) {
        if (!includeClosed || !(arc || d.mode === 'ask')) continue;
        if (!(finite(d.closedAt) && d.closedAt >= at - CLOSED_WINDOW_SEC)) continue;
      }
      out.push(decisionCard(d, state, at, ctx));
    }
    const props = isObj(state?.story?.heavy?.proposals) ? state.story.heavy.proposals : {};
    for (const [key, prop] of Object.entries(props)) {
      if (!isObj(prop)) continue;
      const id = Number(key);
      if (!Number.isSafeInteger(id)) continue;
      const pending = prop.status === 'pending';
      if (!pending && !(includeClosed && finite(prop.onsetAt) && prop.onsetAt >= at - CLOSED_WINDOW_SEC)) continue;
      out.push(heavyCard(id, prop, at, ctx));
    }
  } catch (err) {
    log().warn({ evt: 'issue', where: 'arcs.cards', err: err?.name || 'Error' }, 'story: cards view failed');
  }
  const rank = (c) => (c.status === 'open' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || (b.opensAt ?? 0) - (a.opensAt ?? 0));
  return out.slice(0, CARDS_MAX);
}
