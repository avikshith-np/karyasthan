import { config } from '../../utils/config.js';
import { dateKey, dayStart, addDays } from '../clock.js';
import { rngFor as rngForDefault } from '../rng.js';
import { textNameCollisions } from '../world.js';
import { lastHeavyAt as lastHeavyAtDefault, getEvent as getEventDefault } from '../eventLog.js';
import { ROMANCE_STAGES, HEAVY_MAX_DAYS, worldOverlay } from './reducer.js';
import { check as controlsCheck, sliderFactor, pinKeysFor, isPaused } from './controls.js';

// Heavy arcs (spec 010 research R17): something hard happens in his life,
// rarely and safely. Pure planning over the projection; the pulse's `add`
// appends. No model calls, no store writes (refusals go through deps.refuse).
//
//   roll        inside the daily item (cast.js deps.rolls.heavy → dailyRoll):
//               p/day = 1/720 × sliderFactor('heavyLikelihood') ×
//               sliderFactor('drama') — ≈ 0.5/year at the defaults, 0 at
//               heavyLikelihood 0, 3/720 = 1/240 per day at the maximum (the
//               formula; research R17's "1/120 at the maximum" does not follow
//               from it). The outcome is stored ONCE in `heavy.proposed` and never
//               re-rolled.
//   gates       category heavy not frozen, not paused, no active heavy arc, no
//               pending proposal, `now − eventLog.lastHeavyAt() ≥
//               ARCS_HEAVY_MIN_GAP_DAYS` (raw log: a vetoed, lapsed, reverted or
//               rewound proposal still counts), a theme that passes
//               themeAllowed(), its kind's precondition and its pins.
//   proposal    `heavy.proposed {themeId, kind, label, onsetAt, roll, p,
//               nominated, castId?, durationDays}` (engine, heavy:false),
//               onsetAt = now + ARCS_BIG_LEAD_HOURS + 0..12 h: the veto card.
//   onset item  at onsetAt (onsetItem): `heavy.started` (engine, heavy:true,
//               caused by the proposal) + the kind's effect events (caused by
//               heavy.started) — or, when it can't start, `heavy.lapsed
//               {proposedId, reason}` (refused | precondition | stale), so the
//               item always appends. Under pause it is still offered, only to
//               lapse (research R6). A vetoed proposal is not pending: no item.
//   end item    at `until` (endItem): `heavy.ended {heavyId, reason:'due'}`.
//
// The heavy guard (reducer.heavyGuardActive) lasts the whole arc; durations are
// capped at 30 days. Chat, jev and the reconciler can never create heavy
// events (eventLog refuses them); the owner's heavy scene goes through
// ownerHeavyPlan() → themeAllowed + precondition + the same 90-day cap.
//
// Documented choices the spec leaves open:
// - Effect `vitals.nudged` events carry reason 'heavy' (data-model lists
//   'quick'|'scene' for Director nudges; nothing reads the reason).
// - money_setback needs a known salary > 0 (its amount is a share of it).
// - The cast target (family_illness, friend_moving_away) and the duration are
//   chosen at the roll and stored in the proposal; the onset re-checks the
//   precondition against that target.

export const HEAVY_KINDS = Object.freeze(['family_illness', 'breakup', 'friend_moving_away', 'pet_loss', 'minor_accident', 'money_setback']);
/** Kind words that are never a heavy theme (FR-024). `job_loss` is deferred in 010, not forbidden — but not rollable either. */
export const FORBIDDEN_KINDS = Object.freeze([
  'self_harm', 'suicide', 'abuse', 'assault', 'death', 'own_death', 'dying', 'murder', 'crime', 'arrest', 'jail', 'prison',
  'violence', 'overdose', 'addiction',
]);
export const DEFERRED_KINDS = Object.freeze(['job_loss']);

/**
 * Labels that are never a heavy theme (FR-024): self-harm, suicide, abuse, his
 * own death (and death in general — fail closed), crime by him. Case-insensitive,
 * word-anchored; a real person's name is checked separately (textNameCollisions).
 */
export const FORBIDDEN_RE = new RegExp([
  String.raw`suicid\w*`, String.raw`self[\s_-]*harm\w*`, String.raw`self[\s_-]*injur\w*`,
  String.raw`kill(?:s|ed|ing)?\s+(?:him|her|them|my|your|one)?self`, String.raw`end(?:s|ed|ing)?\s+(?:his|her|their|my)\s+(?:own\s+)?life`,
  String.raw`overdos\w*`, String.raw`abus\w*`, String.raw`assault\w*`, String.raw`rap(?:e|ed|es|ing|ist)`, String.raw`molest\w*`,
  String.raw`grooming`, String.raw`traffick\w*`, String.raw`tortur\w*`, String.raw`violen\w*`,
  String.raw`death`, String.raw`dead`, String.raw`die[sd]?`, String.raw`dying`, String.raw`funeral\w*`, String.raw`murder\w*`,
  String.raw`homicid\w*`, String.raw`kill(?:s|ed|ing|er)?`,
  String.raw`crim(?:e|es|inal\w*)`, String.raw`arrest\w*`, String.raw`jail\w*`, String.raw`prison\w*`, String.raw`stole`,
  String.raw`steal\w*`, String.raw`theft`, String.raw`fraud\w*`, String.raw`embezzl\w*`, String.raw`smuggl\w*`,
  String.raw`drunk[\s_-]*driv\w*`, String.raw`dui`, String.raw`hit[\s_-]*and[\s_-]*run`, String.raw`brib\w*`,
].map(p => `(?:^|[^\\p{L}\\p{N}])(?:${p})(?=$|[^\\p{L}\\p{N}])`).join('|'), 'iu');

export const ROLL_BASE_P = 1 / 720;
export const ONSET_JITTER_HOURS = 12;
export const STALE_SEC = 15 * 60;
export const SICK_DAYS = Object.freeze([1, 3]);
export const ILLNESS_STRESS = Object.freeze([10, 15]);
export const PET_VALENCE = -0.3;
export const SETBACK_SHARE = Object.freeze([0.05, 0.25]);
export const FRIEND_MIN_CLOSENESS = 0.4;

const DAY = 86400;
const HOUR = 3600;
const LABEL_MAX = 80;
const THEMES_MAX = 6;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const DATING_INDEX = ROMANCE_STAGES.indexOf('dating');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round4 = (v) => Math.round(v * 10000) / 10000;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/>>>/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const tzOf = (s, world) => s?.world?.timezone || world?.timezone;
const castOf = (s, id) => (s?.cast instanceof Map && typeof id === 'string' ? s.cast.get(id) ?? null : null);
const isFamily = (c) => typeof c?.relation === 'string' && c.relation.startsWith('family:');
const closenessOf = (c) => (finite(c?.metrics?.closeness) ? c.metrics.closeness : 0.5);

function cfg(deps = {}) {
  const c = isObj(deps.cfg) ? deps.cfg : {};
  const gap = Number(c.heavyMinGapDays ?? config.arcs?.heavyMinGapDays);
  const lead = Number(c.bigLeadHours ?? config.arcs?.bigLeadHours);
  return {
    // config can only raise the gap (values < 90 are clamped up there too).
    gapDays: Number.isFinite(gap) ? Math.max(90, Math.floor(gap)) : 90,
    leadHours: Number.isFinite(lead) && lead >= 24 ? lead : 24,
  };
}

// ── Themes ────────────────────────────────────────────────────────────────

/**
 * Is a heavy theme acceptable (FR-024)? Used for seed themes, at roll time,
 * at onset and on owner heavy scenes. `theme` = {id?, kind, label,
 * castRelation?, durationDays?}; `knownNames` = real people's names.
 * → { ok:true, theme } (cleaned copy) | { ok:false, reason, detail }
 *   reason ∈ 'forbidden' (forbidden/deferred/unknown kind, forbidden words) |
 *            'name_collision' (a real person's name in the label) | 'invalid'
 */
export function themeAllowed(theme, knownNames = []) {
  if (!isObj(theme)) return { ok: false, reason: 'invalid', detail: 'shape' };
  const kind = typeof theme.kind === 'string' ? theme.kind.trim().toLowerCase() : '';
  if (FORBIDDEN_KINDS.includes(kind) || DEFERRED_KINDS.includes(kind)) return { ok: false, reason: 'forbidden', detail: 'kind' };
  if (!HEAVY_KINDS.includes(kind)) return { ok: false, reason: 'forbidden', detail: 'unknown_kind' };
  const label = clean(theme.label, LABEL_MAX + 40);
  if (!label || label.length > LABEL_MAX) return { ok: false, reason: 'invalid', detail: 'label' };
  const id = theme.id === undefined || theme.id === null ? null : (typeof theme.id === 'string' && SLUG_RE.test(theme.id) ? theme.id : undefined);
  if (id === undefined) return { ok: false, reason: 'invalid', detail: 'id' };
  if (FORBIDDEN_RE.test(label) || (id && FORBIDDEN_RE.test(id.replace(/[-_]/g, ' ')))) return { ok: false, reason: 'forbidden', detail: 'label' };
  if (textNameCollisions({ places: [{ name: label }] }, knownNames).length) return { ok: false, reason: 'name_collision', detail: 'label' };
  const out = { kind, label };
  if (id) out.id = id;
  if (theme.castRelation !== undefined && theme.castRelation !== null) {
    if (!['family', 'friend', 'partner'].includes(theme.castRelation)) return { ok: false, reason: 'invalid', detail: 'castRelation' };
    out.castRelation = theme.castRelation;
  }
  if (theme.durationDays !== undefined && theme.durationDays !== null) {
    const d = theme.durationDays;
    const okRange = Array.isArray(d) && d.length === 2 && Number.isInteger(d[0]) && Number.isInteger(d[1])
      && d[0] >= 1 && d[0] <= 14 && d[1] >= 1 && d[1] <= HEAVY_MAX_DAYS && d[0] <= d[1];
    if (!okRange) return { ok: false, reason: 'invalid', detail: 'durationDays' };
    out.durationDays = [d[0], d[1]];
  }
  return { ok: true, theme: out };
}

/** The seed's acceptable heavy themes (cleaned), in seed order. Never throws. */
export function seedThemes(seed, knownNames = []) {
  const list = Array.isArray(seed?.heavy?.themes) ? seed.heavy.themes.slice(0, THEMES_MAX) : [];
  const out = [];
  for (const t of list) {
    const v = themeAllowed(t, knownNames);
    if (v.ok && v.theme.id) out.push(v.theme);
  }
  return out;
}

// ── Kind rules (research R17 table) ───────────────────────────────────────

function activeRomanceArc(s) {
  const arcId = s?.story?.romance?.arcId;
  const arc = arcId ? s?.story?.arcs?.[arcId] : null;
  if (!isObj(arc) || arc.status !== 'active' || arc.category !== 'romance') return null;
  return ROMANCE_STAGES.indexOf(arc.stage) >= DATING_INDEX ? arc : null;
}

function familyTargets(s, theme) {
  const ids = s?.cast instanceof Map ? [...s.cast.keys()].sort() : [];
  if (theme?.castRelation === 'friend') return ids.filter(id => !isFamily(s.cast.get(id)));
  if (theme?.castRelation === 'partner') {
    const p = s?.story?.romance?.partnerId;
    return p && s.cast.has(p) ? [p] : [];
  }
  return ids.filter(id => isFamily(s.cast.get(id)));
}

function friendTargets(s, at) {
  const ids = s?.cast instanceof Map ? [...s.cast.keys()].sort() : [];
  return ids.filter((id) => {
    const c = s.cast.get(id);
    if (isFamily(c) || closenessOf(c) < FRIEND_MIN_CLOSENESS) return false;
    const away = s?.story?.castLife?.[id]?.away;
    return !(finite(away?.until) && away.until > at);
  });
}

function salaryOf(s, world) {
  const w = world ? worldOverlay(s, world) : null;
  const v = w?.money?.salary ?? s?.story?.career?.salary;
  return finite(v) && v > 0 ? v : null;
}

/**
 * Per kind: `category` (a second fate that blocks it, besides `heavy`),
 * `targets(s, theme, at)` (cast candidates, or null when the kind has no cast
 * target), `precondition(s, {theme, castId, at, world})` → boolean, and
 * `effects(s, {startedId, at, castId, until, theme, world, rng})` → event
 * descriptors (engine, caused by heavy.started). Pin keys come from
 * controls.pinKeysFor({type:'heavy.started', payload:{kind, castId}}).
 */
export const KIND_RULES = Object.freeze({
  breakup: Object.freeze({
    category: 'romance',
    targets: () => null,
    precondition: (s) => !!activeRomanceArc(s),
    effects(s, { startedId, at }) {
      const arc = activeRomanceArc(s);
      if (!arc) return [];
      const out = [];
      const ds = s?.decisions instanceof Map ? [...s.decisions.values()] : [];
      for (const d of ds.sort((a, b) => a.id - b.id)) {
        if (d?.status === 'open' && d.arcId === arc.id) {
          out.push({ type: 'decision.expired', at, actor: 'engine', causeId: startedId, payload: { decisionId: d.id, reason: 'cancelled' } });
        }
      }
      out.push({ type: 'arc.ended', at, actor: 'engine', causeId: startedId, payload: { arcId: arc.id, outcome: 'broken_up' } });
      return out;
    },
  }),
  family_illness: Object.freeze({
    category: null,
    targets: (s, theme) => familyTargets(s, theme),
    precondition: (s, { theme, castId }) => !!castOf(s, castId) && familyTargets(s, theme).includes(castId),
    effects(s, { startedId, at, castId, theme, rng }) {
      return [
        { type: 'cast.beat', at, actor: 'engine', causeId: startedId, payload: { castId, kind: 'news', text: clean(theme?.label, 120) } },
        {
          type: 'vitals.nudged', at, actor: 'engine', causeId: startedId,
          payload: { delta: { stress: rng.int(ILLNESS_STRESS[0], ILLNESS_STRESS[1]) }, reason: 'heavy' },
        },
      ];
    },
  }),
  friend_moving_away: Object.freeze({
    category: null,
    targets: (s, theme, at) => friendTargets(s, at),
    precondition: (s, { castId, at }) => friendTargets(s, at).includes(castId),
    effects(s, { startedId, at, castId, until, theme }) {
      return [{ type: 'cast.beat', at, actor: 'engine', causeId: startedId, payload: { castId, kind: 'away', until, text: clean(theme?.label, 120) } }];
    },
  }),
  pet_loss: Object.freeze({
    category: null,
    targets: () => null,
    // No pet is modelled: the theme itself (from the seed or the owner) is the precondition.
    precondition: (s, { theme }) => !!theme && theme.kind === 'pet_loss',
    effects(s, { startedId, at }) {
      return [{ type: 'vitals.nudged', at, actor: 'engine', causeId: startedId, payload: { delta: { valence: PET_VALENCE }, reason: 'heavy' } }];
    },
  }),
  minor_accident: Object.freeze({
    category: 'health',
    targets: () => null,
    precondition: () => true,
    effects(s, { startedId, at, world, rng }) {
      const tz = tzOf(s, world);
      const days = rng.int(SICK_DAYS[0], SICK_DAYS[1]);
      const until = addDays(dayStart(at, tz), days, tz) + 4 * HOUR; // as pulse.js wakeUp's sick.started
      return [{ type: 'sick.started', at, actor: 'engine', causeId: startedId, payload: { until, days, reason: 'accident' } }];
    },
  }),
  money_setback: Object.freeze({
    category: null,
    targets: () => null,
    precondition: (s, { world }) => salaryOf(s, world) !== null,
    effects(s, { startedId, at, world, rng }) {
      const salary = salaryOf(s, world);
      if (!salary) return [];
      const amount = Math.round(salary * rng.float(SETBACK_SHARE[0], SETBACK_SHARE[1]));
      return [{ type: 'money.spent', at, actor: 'engine', causeId: startedId, payload: { amount, for: 'setback' } }];
    },
  }),
});

/** Pin keys a heavy change of this kind touches (controls.pinKeysFor over heavy.started). */
export function heavyPinKeys(s, kind, castId = null) {
  return pinKeysFor({ type: 'heavy.started', payload: { kind, ...(castId ? { castId } : {}) } }, s);
}

// Controls for one kind (heavy + the kind's own category), pins included.
function heavyControls(s, kind, castId, { source = 'engine', action = 'start' } = {}) {
  const pinKeys = heavyPinKeys(s, kind, castId);
  const v = controlsCheck({ source, category: 'heavy', action, pinKeys }, s);
  if (!v.ok) return v;
  const cat = KIND_RULES[kind]?.category;
  if (cat) {
    const w = controlsCheck({ source, category: cat, action: source === 'owner' ? 'start' : 'change', pinKeys }, s);
    if (!w.ok) return w;
  }
  return { ok: true };
}

/** Today's roll probability (research R17 formula); 0 when heavyLikelihood is 0. */
export function rollP(s) {
  return ROLL_BASE_P * sliderFactor('heavyLikelihood', s) * sliderFactor('drama', s);
}

function pendingProposal(s) {
  const props = s?.story?.heavy?.proposals;
  if (!isObj(props)) return null;
  for (const [id, p] of Object.entries(props)) if (isObj(p) && p.status === 'pending') return Number(id);
  return null;
}

function pickTarget(s, rule, theme, at, rng) {
  const t = rule.targets(s, theme, at);
  if (t === null) return { castId: null };
  const free = t.filter(id => CAST_ID_RE.test(id));
  if (!free.length) return null;
  return { castId: free[Math.floor(rng() * free.length)] };
}

// ── Roll (inside the daily item) ──────────────────────────────────────────

/**
 * The day's heavy roll. Pure: rng = rngFor(date, 'heavy') (fresh per date),
 * `lastHeavyAt` = eventLog.lastHeavyAt() (raw log, unix seconds or null).
 * opts: { at, world, knownNames, nominated (themeId the weekly pass nominated:
 * weight ×2), cfg }.
 * → { outcome, p?, roll?, refusal?, descriptor? } — outcome ∈ 'inert' |
 *   'paused' | 'frozen' | 'pinned' | 'active' | 'pending' | 'gap' | 'off' |
 *   'no' | 'no_candidate' | 'proposed'. `descriptor` is the heavy.proposed
 *   event to append (only for 'proposed'); `refusal` a story_refusals row for a
 *   control refusal.
 */
export function roll(s, rng, seed, lastHeavyAt, opts = {}) {
  const at = finite(opts.at) ? opts.at : s?.at;
  const knownNames = Array.isArray(opts.knownNames) ? opts.knownNames : [];
  const themes = seedThemes(seed, knownNames);
  if (!themes.length || !finite(at)) return { outcome: 'inert' };
  const c = cfg(opts);
  const v = controlsCheck({ source: 'engine', category: 'heavy', action: 'start', pinKeys: [] }, s);
  if (!v.ok) {
    return { outcome: v.reason === 'paused' ? 'paused' : 'frozen', refusal: { source: 'engine', category: 'heavy', action: 'heavy', target: null, reason: v.reason } };
  }
  const st = s?.story?.heavy;
  if (isObj(st?.active) && finite(st.active.until) && st.active.until > at) return { outcome: 'active' };
  if (pendingProposal(s) !== null) return { outcome: 'pending' };
  if (finite(lastHeavyAt) && at - lastHeavyAt < c.gapDays * DAY) return { outcome: 'gap' };
  const p = round4(rollP(s));
  if (!(p > 0)) return { outcome: 'off', p: 0 };
  const r = typeof rng === 'function' ? rng() : 1;
  if (!(r < p)) return { outcome: 'no', p, roll: round4(r) };

  // The roll hit. Seed themes that fail themeAllowed now (forbidden words, a real
  // name that appeared since the seed was written) are refused and logged (FR-024).
  const forbidden = forbiddenSeedThemes(seed, knownNames);
  const withForbidden = (out) => (forbidden.length ? { ...out, refusals: [...(out.refusal ? [out.refusal] : []), ...forbidden] } : out);
  // Pick a theme that can happen now (precondition + pins + its fate).
  const candidates = [];
  let pinned = null;
  for (const theme of themes) {
    const rule = KIND_RULES[theme.kind];
    const target = pickTarget(s, rule, theme, at, rng);
    if (!target) continue;
    const ctx = { theme, castId: target.castId, at, world: opts.world };
    if (!rule.precondition(s, ctx)) continue;
    const ctl = heavyControls(s, theme.kind, target.castId);
    if (!ctl.ok) { pinned = pinned ?? ctl; continue; }
    candidates.push({ theme, castId: target.castId, weight: theme.id && theme.id === opts.nominated ? 2 : 1 });
  }
  if (!candidates.length) {
    return withForbidden({
      outcome: 'no_candidate', p, roll: round4(r),
      ...(pinned ? { refusal: { source: 'engine', category: 'heavy', action: 'heavy', target: null, reason: pinned.reason, pinKey: pinned.pinKey ?? null } } : {}),
    });
  }
  const total = candidates.reduce((a, x) => a + x.weight, 0);
  let u = rng() * total;
  let pick = candidates[candidates.length - 1];
  for (const x of candidates) { if ((u -= x.weight) < 0) { pick = x; break; } }
  const dd = pick.theme.durationDays ?? [3, 14];
  const durationDays = Math.min(HEAVY_MAX_DAYS, rng.int ? rng.int(dd[0], dd[1]) : dd[0]);
  const jitter = Math.floor(rng() * (ONSET_JITTER_HOURS * HOUR + 1));
  const onsetAt = Math.round(at + c.leadHours * HOUR + jitter);
  return withForbidden({
    outcome: 'proposed', p, roll: round4(r),
    descriptor: {
      type: 'heavy.proposed', at, actor: 'engine',
      payload: {
        themeId: pick.theme.id, kind: pick.theme.kind, label: pick.theme.label, onsetAt, roll: round4(r), p,
        nominated: pick.weight > 1, durationDays, ...(pick.castId ? { castId: pick.castId } : {}),
      },
    },
  });
}

/** Refusal rows for seed heavy themes that fail themeAllowed (forbidden, a real name, invalid). */
export function forbiddenSeedThemes(seed, knownNames = []) {
  const list = Array.isArray(seed?.heavy?.themes) ? seed.heavy.themes.slice(0, THEMES_MAX) : [];
  const out = [];
  for (const t of list) {
    const v = themeAllowed(t, knownNames);
    if (v.ok && v.theme.id) continue;
    const id = typeof t?.id === 'string' && SLUG_RE.test(t.id) ? t.id : null;
    out.push({ source: 'engine', category: 'heavy', action: 'heavy', target: id ? `theme:${id}` : null, reason: v.ok ? 'invalid' : v.reason });
  }
  return out;
}

/**
 * Adapter for cast.js's daily item (`deps.rolls.heavy`): runs roll() for the
 * pass's date and appends the proposal. deps: { lastHeavyAt() (default
 * eventLog.lastHeavyAt), rngFor, knownNames, nominated, refuse(row), cfg }.
 * → the outcome summary for story.daily_done.rolls.heavy.
 */
export async function dailyRoll({ state, add, at, date, world, seed, sim = false } = {}, deps = {}) {
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const day = date ?? dateKey(at, tzOf(state, world));
  let last;
  // A failed gap read fails closed: no roll today.
  try { last = typeof deps.lastHeavyAt === 'function' ? deps.lastHeavyAt() : lastHeavyAtDefault(); } catch { return { outcome: 'gap' }; }
  if (last !== null && !finite(last)) return { outcome: 'gap' };
  const knownNames = typeof deps.knownNames === 'function' ? deps.knownNames() : deps.knownNames;
  const r = roll(state, rf(day, 'heavy'), seed, last, { at, world, knownNames, nominated: deps.nominated ?? null, cfg: deps.cfg });
  if (!sim && typeof deps.refuse === 'function') {
    for (const row of r.refusals ?? (r.refusal ? [r.refusal] : [])) {
      try { deps.refuse({ ...row, at }); } catch { /* operational log only */ }
    }
  }
  if (r.descriptor) add(r.descriptor);
  return { outcome: r.outcome, ...(finite(r.p) ? { p: r.p } : {}), ...(finite(r.roll) ? { roll: r.roll } : {}) };
}

// ── Onset and end items ───────────────────────────────────────────────────

function proposalPayload(id, deps) {
  const get = typeof deps.getEvent === 'function' ? deps.getEvent : getEventDefault;
  try {
    const ev = get(id);
    return ev && ev.type === 'heavy.proposed' && isObj(ev.payload) && ev.redacted !== true ? ev.payload : null;
  } catch { return null; }
}

/**
 * The verdict for a due proposal (decided when the item is built, never in run()).
 * → { start:false, reason } | { start:true, theme, castId, until }
 */
export function onsetVerdict(s, proposedId, prop, deps = {}) {
  const at = Math.max(prop.onsetAt, finite(s?.at) ? s.at : prop.onsetAt);
  if (finite(s?.at) && prop.onsetAt < s.at - STALE_SEC) return { start: false, reason: 'stale' };
  if (isPaused(s)) return { start: false, reason: 'refused' };
  const raw = proposalPayload(proposedId, deps) ?? {};
  const seedTheme = seedThemes(deps.seed, deps.knownNames ?? []).find(t => t.id === prop.themeId) ?? null;
  const themeIn = seedTheme ?? { id: prop.themeId ?? undefined, kind: prop.kind, label: raw.label ?? prop.kind.replace(/_/g, ' ') };
  const ok = themeAllowed({ ...themeIn, kind: prop.kind, durationDays: undefined }, deps.knownNames ?? []);
  if (!ok.ok) return { start: false, reason: 'refused', why: ok.reason };
  const theme = { ...ok.theme, ...(seedTheme?.durationDays ? { durationDays: seedTheme.durationDays } : {}) };
  const rule = KIND_RULES[prop.kind];
  if (!rule) return { start: false, reason: 'precondition' };
  const castId = typeof raw.castId === 'string' && CAST_ID_RE.test(raw.castId) ? raw.castId : null;
  if (rule.targets(s, theme, at) !== null && !castId) return { start: false, reason: 'precondition' };
  if (isObj(s?.story?.heavy?.active) && finite(s.story.heavy.active.until) && s.story.heavy.active.until > at) {
    return { start: false, reason: 'precondition' };
  }
  if (!rule.precondition(s, { theme, castId, at, world: deps.world })) return { start: false, reason: 'precondition' };
  const ctl = heavyControls(s, prop.kind, castId);
  if (!ctl.ok) return { start: false, reason: 'refused', control: ctl };
  const dd = Number.isInteger(raw.durationDays) ? raw.durationDays : (theme.durationDays?.[0] ?? 7);
  const days = Math.min(HEAVY_MAX_DAYS, Math.max(1, dd));
  return { start: true, theme, castId, until: at + days * DAY, at };
}

/**
 * Onset items for every pending proposal due by `g` (research R17). Each
 * appends `heavy.started` + effects, or `heavy.lapsed {reason}`. deps: { world,
 * seed, knownNames, getEvent, rngFor, refuse, sim }. id = the proposal id.
 */
export function onsetItems(s, g, deps = {}) {
  const props = s?.story?.heavy?.proposals;
  if (!isObj(props) || !finite(g)) return [];
  const out = [];
  for (const [key, prop] of Object.entries(props)) {
    const id = Number(key);
    if (!isObj(prop) || prop.status !== 'pending' || !finite(prop.onsetAt) || prop.onsetAt > g) continue;
    const it = onsetItem(s, id, deps);
    if (it) out.push(it);
  }
  return out;
}

/** One pending proposal's onset item (see onsetItems), or null when not pending. */
export function onsetItem(s, proposedId, deps = {}) {
  const prop = s?.story?.heavy?.proposals?.[proposedId];
  if (!isObj(prop) || prop.status !== 'pending' || !finite(prop.onsetAt)) return null;
  const v = onsetVerdict(s, proposedId, prop, deps);
  const at = Math.max(prop.onsetAt, finite(s?.at) ? s.at : prop.onsetAt);
  if (!v.start) {
    return {
      at, prio: 8, label: 'heavy:lapse', id: proposedId,
      run: (add) => {
        if (v.control && !deps.sim && typeof deps.refuse === 'function') {
          try {
            deps.refuse({ at, source: 'engine', category: 'heavy', action: 'heavy', target: `heavy:${proposedId}`, reason: v.control.reason, pinKey: v.control.pinKey ?? null });
          } catch { /* operational log only */ }
        }
        add({ type: 'heavy.lapsed', at, actor: 'engine', causeId: proposedId, payload: { proposedId, reason: v.reason } });
      },
    };
  }
  const rf = typeof deps.rngFor === 'function' ? deps.rngFor : rngForDefault;
  const rule = KIND_RULES[prop.kind];
  return {
    at, prio: 8, label: 'heavy:onset', id: proposedId,
    run: (add) => {
      const started = add({
        type: 'heavy.started', at, actor: 'engine', causeId: proposedId, heavy: true,
        payload: { proposedId, themeId: v.theme.id ?? prop.themeId ?? null, kind: prop.kind, until: v.until, ...(v.castId ? { castId: v.castId } : {}) },
      });
      const rng = rf(dateKey(at, tzOf(s, deps.world)), `heavy:effect:${proposedId}`);
      for (const ev of rule.effects(s, { startedId: started.id, at, castId: v.castId, until: v.until, theme: v.theme, world: deps.world, rng })) add(ev);
    },
  };
}

/** The end item of the active heavy arc once `until` is due by `g` (always offered), or null. */
export function endItem(s, g) {
  const a = s?.story?.heavy?.active;
  if (!isObj(a) || !finite(a.until) || !finite(g) || a.until > g || !Number.isSafeInteger(a.id)) return null;
  const at = Math.max(a.until, finite(s?.at) ? s.at : a.until);
  return {
    at, prio: 8, label: 'heavy:end', id: a.id,
    run: (add) => { add({ type: 'heavy.ended', at, actor: 'engine', causeId: a.id, payload: { heavyId: a.id, reason: 'due' } }); },
  };
}

/** Every heavy pulse item due by `g`: onsets (or lapses) and the end. */
export function heavyItems(s, g, deps = {}) {
  const out = onsetItems(s, g, deps);
  const end = endItem(s, g);
  if (end) out.push(end);
  return out;
}

// ── Owner heavy scene (Director) ──────────────────────────────────────────

/**
 * Validate an owner heavy scene (director-api §3 `heavy`): themeAllowed on the
 * kind and label, the kind's precondition, the controls (owner: pins, frozen
 * start), no active arc, and the same raw-log 90-day cap.
 * input: { themeId? | kind + label, durationDays 1..30, castId? }
 * deps: { at, seed, world, lastHeavyAt (number|null), knownNames, cfg }
 * → { ok:false, code, reason? } — code: 'forbidden_theme' (400) | 'invalid' (400) |
 *   'heavy_precondition' | 'heavy_cap' | 'heavy_active' | 'frozen' | 'pinned' (409)
 * → { ok:true, payload (heavy.started payload; the caller appends it as owner,
 *   heavy:true), effects(startedId, rng) → descriptors (engine, caused by it) }
 */
export function ownerHeavyPlan(input, s, deps = {}) {
  if (!isObj(input)) return { ok: false, code: 'invalid' };
  const at = finite(deps.at) ? deps.at : s?.at;
  if (!finite(at)) return { ok: false, code: 'invalid' };
  const knownNames = deps.knownNames ?? [];
  let base = null;
  if (input.themeId !== undefined && input.themeId !== null) {
    base = seedThemes(deps.seed, knownNames).find(t => t.id === input.themeId) ?? null;
    if (!base) {
      // A seed theme that exists but fails themeAllowed is forbidden, not unknown.
      const raw = (Array.isArray(deps.seed?.heavy?.themes) ? deps.seed.heavy.themes : []).find(t => t?.id === input.themeId);
      return { ok: false, code: raw ? 'forbidden_theme' : 'invalid' };
    }
  } else {
    const v = themeAllowed({ kind: input.kind, label: input.label }, knownNames);
    if (!v.ok) return { ok: false, code: v.reason === 'invalid' ? 'invalid' : 'forbidden_theme', reason: v.reason };
    base = v.theme;
  }
  const days = input.durationDays;
  if (!Number.isInteger(days) || days < 1 || days > HEAVY_MAX_DAYS) return { ok: false, code: 'invalid' };
  const rule = KIND_RULES[base.kind];
  const targets = rule.targets(s, base, at);
  let castId = null;
  if (targets !== null) {
    castId = typeof input.castId === 'string' && CAST_ID_RE.test(input.castId) ? input.castId : (targets[0] ?? null);
    if (!castId) return { ok: false, code: 'heavy_precondition' };
  }
  if (!rule.precondition(s, { theme: base, castId, at, world: deps.world })) return { ok: false, code: 'heavy_precondition' };
  const a = s?.story?.heavy?.active;
  // 015 (plan §1.4): for a hand-built owner preview (deps.relax) the pacing and
  // the owner's own guardrails become warnings; without relax (every engine,
  // weekly, test and model-draft caller) the result is exactly 010's.
  const relax = deps.relax === true;
  const warnings = [];
  let endsActive = null;
  if (isObj(a) && finite(a.until) && a.until > at) {
    if (!relax) return { ok: false, code: 'heavy_active' };
    warnings.push('ends_active_heavy');
    endsActive = a.id ?? null;
  }
  const c = cfg(deps);
  if (finite(deps.lastHeavyAt) && at - deps.lastHeavyAt < c.gapDays * DAY) {
    if (!relax) return { ok: false, code: 'heavy_cap' };
    warnings.push('heavy_gap');
  }
  const ctl = heavyControls(s, base.kind, castId, { source: 'owner', action: 'start' });
  if (!ctl.ok) {
    if (!relax) return { ok: false, code: ctl.reason === 'pinned' ? 'pinned' : 'frozen', pinKey: ctl.pinKey ?? null };
    warnings.push(ctl.reason === 'pinned' ? 'overrides_pin' : 'overrides_frozen');
  }
  const until = at + days * DAY;
  const theme = base;
  return {
    ok: true,
    ...(relax ? { warnings, endsActive } : {}),
    payload: { themeId: theme.id ?? null, kind: theme.kind, label: theme.label, until, ...(castId ? { castId } : {}) },
    effects: (startedId, rng = rngForDefault(dateKey(at, tzOf(s, deps.world)), `heavy:effect:owner:${startedId}`)) =>
      rule.effects(s, { startedId, at, castId, until, theme, world: deps.world, rng }),
  };
}
