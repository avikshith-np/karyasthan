// Scene output validation (spec 016, plan §P1.6, D9/D10/D14). Fail closed: any
// violation → { ok:false, reason } and the worker degrades (clerk → one-liner);
// nothing is repaired.
//
//   validateSceneOutput(raw, ctx) → { ok:true, value } | { ok:false, reason }
//   value = { narration (paragraphs joined by a blank line), impressions: {him:[{castId,text}], them:[…]} | null,
//             topics, highlight, awkward, chemistry, focus (castId|null), ending,
//             effects: [{castId, metric, dir, size}] }
//   ctx = { labels: {P1: castId}, mode, outcome, firstMeet: [castId], maxChars, names (allow-list),
//           knownNames (real people), castNames, venueNames: [{name, kind}], negative }
import { parseJsonObject, validateText, MAX_BYTES } from '../schema.js';
import { cleanItem } from '../charter.js';
import { wishProblem } from '../prompt.js';
import { scrubNegativeVenue, scrubVenueNames } from '../../places.js';
import { SCENE_ENDINGS } from '../reducer.js';
import { contentProblem } from '../desire.js';
import { FRIEND, LONG_MINUTES } from './facts.js';

export { LONG_MINUTES };
export const KEYS = Object.freeze(['narration', 'impressions', 'topics', 'highlight', 'awkward', 'chemistry', 'focus', 'ending', 'effects']);
export const METRICS = Object.freeze(['closeness', 'trust', 'tension', 'intimacy', 'passion']);
export const NARRATION_MIN = 120;
export const NARRATION_MAX = 1200;
export const NARRATION_MAX_LONG = 2400;
export const PARAS_MAX = 6;
export const PARAS_MAX_LONG = 9;

/** Narration cap for a session. A long outing (≥ 180 min) gets twice the normal cap, never over 2400. */
export function sceneTextCap(minutes, base = NARRATION_MAX) {
  const b = Number.isInteger(base) && base > 0 ? base : NARRATION_MAX;
  return Number(minutes) >= LONG_MINUTES ? Math.min(b * 2, NARRATION_MAX_LONG) : b;
}

/** Paragraph cap. A long outing may use nine; a short one stays at six. */
export function sceneParasCap(minutes) {
  return Number(minutes) >= LONG_MINUTES ? PARAS_MAX_LONG : PARAS_MAX;
}
export const NEGATIVE_ENDINGS = Object.freeze(['parted_badly', 'left_early']);
// Words always allowed capitalised in a scene (D14): relation, weather, ending/outcome words, the friend token.
const ALWAYS = ['friend', 'flatmate', 'coworker', 'manager', 'mum', 'mom', 'dad', 'parent', 'sibling', 'brother', 'sister',
  'rain', 'sun', 'sunny', 'cloudy', 'storm', 'hot', 'cold', 'well', 'flat', 'badly', 'numbers', 'late', 'early',
  'cafe', 'restaurant', 'bar', 'pub', 'cinema', 'park', 'mall', 'shop', 'place', 'flat', 'his', 'her', 'their'];
const ATTRIB_RE = /\b(said|says|told|tells|felt|feels|thought|thinks|wanted|wants|liked|likes|loved|loves|hated|hates|seemed|seems|asked|asks)\b/i;
const QUOTE_RE = /["“”«»]|(?:^|\s)'[^']{2,}'(?:\s|$|[.,!?])/;
const PRONOUN_START_RE = /^(she|he|they)\b/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const bad = (reason) => ({ ok: false, reason });

// D9 (R6): the model was never given a business's name, so every venue name in any output
// string is scrubbed to its kind word, whatever the outcome (a scrub, not a reject).
function scrub(text, ctx) {
  const venues = Array.isArray(ctx.venueNames) ? ctx.venueNames : [];
  if (!text) return text;
  return scrubVenueNames(scrubNegativeVenue(text, venues), venues);
}

// One model string: cleaned (sanitized, fence tokens stripped, one line), capped; the
// identifier / URL / invented-name rejects of validateText. → string | null | Error-ish
function textOf(v, cap, ctx, { required = false, min = 1 } = {}) {
  if (v === null || v === undefined || v === '') return required ? { reason: 'missing_text' } : null;
  if (typeof v !== 'string') return { reason: 'bad_text' };
  const r = validateText(scrub(v, ctx), { cap, names: ctx.allowed, maxBytes: 2048, maxInvented: 1 });
  if (!r.ok) return { reason: r.reason };
  if (r.text.length < min) return { reason: 'too_short' };
  return scrub(r.text, ctx);
}

function realNameIn(text, ctx) {
  const chunks = String(text).split(/(?<=[.!?…])\s+|\n+/).flatMap(s => (s.length > 380 ? s.match(/.{1,380}(\s|$)/gs) ?? [s] : [s]));
  for (const c of chunks) {
    if (!c.trim()) continue;
    const p = wishProblem(c, ctx.knownNames ?? [], ctx.castNames ?? []);
    if (p === 'real_person_name' || p === 'jid_in_text') return p;
  }
  return null;
}

// self_only (D10): {FRIEND} present, no quotes, no attribution verb within 4 words after it,
// no pronoun opening the sentence after it.
function selfOnlyProblem(text) {
  if (!text.includes(FRIEND)) return 'friend_missing';
  if (QUOTE_RE.test(text)) return 'quote';
  const parts = text.split(FRIEND);
  for (let i = 1; i < parts.length; i++) {
    const after = parts[i].trim().split(/\s+/).slice(0, 4).join(' ');
    if (ATTRIB_RE.test(after)) return 'attribution';
    const nextSentence = parts[i].split(/(?<=[.!?…])\s+/)[1] ?? '';
    if (PRONOUN_START_RE.test(nextSentence.trim()) && ATTRIB_RE.test(nextSentence.split(/\s+/).slice(0, 5).join(' '))) return 'attribution';
  }
  return null;
}

function labelOf(v, ctx) {
  return typeof v === 'string' && Object.hasOwn(ctx.labels ?? {}, v) ? ctx.labels[v] : null;
}

function impressionsOf(v, ctx) {
  if (v === null || v === undefined) return { value: null };
  if (!isObj(v)) return { reason: 'bad_impressions' };
  const first = new Set(ctx.firstMeet ?? []);
  const out = { him: [], them: [] };
  for (const side of ['him', 'them']) {
    const list = v[side] ?? [];
    if (!Array.isArray(list) || list.length > 4) return { reason: 'bad_impressions' };
    for (const it of list) {
      const castId = labelOf(it?.p, ctx);
      if (!castId) return { reason: 'bad_label' };
      if (!first.has(castId)) return { reason: 'impression_not_first_meet' };
      const t = textOf(it?.text, 160, ctx, { required: true });
      if (isObj(t)) return t;
      out[side].push({ castId, text: t });
    }
  }
  if (ctx.mode === 'self_only' && out.them.length) return { reason: 'their_side' };
  return { value: out.him.length || out.them.length ? out : null };
}

/** Validate and map a scene model output (see the module comment). */
export function validateSceneOutput(raw, ctx = {}) {
  const parsed = parseJsonObject(typeof raw === 'string' ? raw : '', MAX_BYTES.scene);
  if (!parsed.ok) return bad(parsed.error ?? 'not_json');
  const o = parsed.value;
  if (!isObj(o)) return bad('not_json');
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) return bad('unknown_key');
  const maxChars = Number.isInteger(ctx.maxChars) ? ctx.maxChars : NARRATION_MAX;
  const parasMax = Number.isInteger(ctx.parasMax) ? ctx.parasMax : PARAS_MAX;
  const allowed = [...(ctx.names ?? []), ...ALWAYS];
  const c = { ...ctx, allowed };
  const selfOnly = ctx.mode === 'self_only';

  // Narration: paragraphs, each cleaned; the whole text checked once (D14: ≤ 1 invented word per 400 chars).
  if (typeof o.narration !== 'string') return bad('missing_narration');
  o.narration = scrub(o.narration, ctx);   // D9: a venue name is a scrub, not a reject
  // Length is the text as written. cleanItem would otherwise cut a single paragraph down to the cap.
  const rawParas = o.narration.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!rawParas.length || rawParas.length > parasMax) return bad('paragraphs');
  const rawJoined = rawParas.join(' ');
  if (rawJoined.length > maxChars) return bad('too_long');
  if (rawJoined.length < NARRATION_MIN) return bad('too_short');
  const paras = rawParas.map(p => cleanItem(p, maxChars)).filter(Boolean);
  if (!paras.length || paras.length > parasMax) return bad('paragraphs');
  const joined = paras.join(' ');
  if (joined.length > maxChars) return bad('too_long');
  if (joined.length < NARRATION_MIN) return bad('too_short');
  if (realNameIn(joined, ctx)) return bad('real_name');
  const maxInvented = Math.max(1, Math.floor(joined.length / 400));
  const whole = validateText(o.narration.replace(/\s+/g, ' '), { cap: maxChars + 50, names: allowed, maxBytes: MAX_BYTES.scene, maxInvented });
  if (!whole.ok) return bad(whole.reason);
  if (selfOnly) {
    const p = selfOnlyProblem(joined);
    if (p) return bad(p);
  } else if (joined.includes(FRIEND)) return bad('friend_token');

  const imp = impressionsOf(o.impressions, c);
  if (imp.reason) return bad(imp.reason);
  const topics = [];
  if (o.topics !== undefined && o.topics !== null) {
    if (!Array.isArray(o.topics) || o.topics.length > 5) return bad('bad_topics');
    for (const t of o.topics) {
      const v = textOf(t, 40, c, { required: true });
      if (isObj(v)) return bad(v.reason);
      topics.push(v);
    }
  }
  const highlight = textOf(o.highlight, 160, c, { required: true });
  if (isObj(highlight)) return bad(highlight.reason);
  const awkward = textOf(o.awkward, 160, c);
  if (isObj(awkward)) return bad(awkward.reason);
  for (const t of [highlight, awkward, ...topics, ...(imp.value ? [...imp.value.him, ...imp.value.them].map(x => x.text) : [])]) {
    if (t && realNameIn(t, ctx)) return bad('real_name');
    if (t && selfOnly && (QUOTE_RE.test(t) || (t.includes(FRIEND) && selfOnlyProblem(t)))) return bad('attribution');
    if (t && !selfOnly && t.includes(FRIEND)) return bad('friend_token');
  }

  let chemistry = null;
  if (o.chemistry !== undefined && o.chemistry !== null) {
    if (!fin(o.chemistry) || o.chemistry < 0 || o.chemistry > 1) return bad('bad_chemistry');
    chemistry = Math.round(o.chemistry * 100) / 100;
  }
  let focus = null;
  if (o.focus !== undefined && o.focus !== null) {
    focus = labelOf(o.focus, ctx);
    if (!focus) return bad('bad_label');
  }
  const labelCount = Object.keys(ctx.labels ?? {}).length;
  if (!selfOnly && labelCount > 1 && !focus) return bad('focus_required');
  if (!selfOnly && labelCount === 1 && !focus) focus = Object.values(ctx.labels)[0];
  if (!SCENE_ENDINGS.includes(o.ending)) return bad('bad_ending');
  const ending = o.ending;

  const effects = [];
  if (o.effects !== undefined && o.effects !== null) {
    if (!Array.isArray(o.effects) || o.effects.length > 6) return bad('bad_effects');
    for (const e of o.effects) {
      const castId = labelOf(e?.p, ctx);
      if (!castId) return bad('bad_label');
      if (!METRICS.includes(e?.metric) || !['up', 'down'].includes(e?.dir) || !['small', 'medium'].includes(e?.size)) return bad('bad_effects');
      effects.push({ castId, metric: e.metric, dir: e.dir, size: e.size });
    }
  }

  if (selfOnly) {
    if (chemistry !== null || focus || effects.length || ending !== 'nothing') return bad('their_side');
  }
  // Consistency with the fixed outcome (no repair).
  if (ctx.outcome === 'well') {
    if (NEGATIVE_ENDINGS.includes(ending)) return bad('outcome_mismatch');
    if (effects.some(e => (e.metric === 'closeness' || e.metric === 'trust') && e.dir === 'down')) return bad('outcome_mismatch');
  }
  if (ctx.outcome === 'badly') {
    if (!['nothing', 'left_early', 'parted_badly'].includes(ending)) return bad('outcome_mismatch');
    if (effects.some(e => e.metric === 'closeness' && e.dir === 'up')) return bad('outcome_mismatch');
  }

  const negative = ctx.negative === true || NEGATIVE_ENDINGS.includes(ending) || ctx.outcome === 'badly';
  const sc = { ...c, negative };
  const narration = paras.map(p => scrub(p, sc)).join('\n\n');
  if (ctx.register === 'explicit') {
    const blob = [narration, highlight, awkward, ...topics].filter(Boolean).join('\n');
    const gate = contentProblem(blob);
    if (gate === 'minor' || gate === 'nonconsent') return bad(gate);
  }
  return {
    ok: true,
    value: {
      narration,
      impressions: imp.value,
      topics: topics.map(t => scrub(t, sc)),
      highlight: scrub(highlight, sc),
      awkward: awkward ? scrub(awkward, sc) : null,
      chemistry: selfOnly ? null : chemistry,
      focus,
      ending,
      effects,
      negative,
    },
  };
}

/** The owner's edited text (plan §P2.4): the same text rules; a self_only edit keeps {FRIEND} as the only person. */
export function validateEditedText(text, ctx = {}) {
  if (typeof text !== 'string' || !text.trim()) return bad('empty');
  const maxChars = Number.isInteger(ctx.maxChars) ? ctx.maxChars : NARRATION_MAX;
  const parasMax = Number.isInteger(ctx.parasMax) ? ctx.parasMax : PARAS_MAX;
  const rawParas = text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!rawParas.length || rawParas.length > parasMax) return bad('paragraphs');
  if (rawParas.join(' ').length > maxChars) return bad('too_long');
  const paras = rawParas.map(p => cleanItem(p, maxChars)).filter(Boolean);
  if (!paras.length || paras.length > parasMax) return bad('paragraphs');
  const joined = paras.join(' ');
  if (joined.length > maxChars) return bad('too_long');
  const r = validateText(joined, { cap: maxChars + 50, names: [...(ctx.names ?? []), ...ALWAYS], maxBytes: MAX_BYTES.scene, maxInvented: 1000 });
  if (!r.ok && r.reason !== 'invented_name') return bad(r.reason);
  if (realNameIn(joined, ctx)) return bad('real_name');
  if (ctx.mode === 'self_only') {
    const p = selfOnlyProblem(joined);
    if (p) return bad(p);
  } else if (joined.includes(FRIEND)) return bad('friend_token');
  return { ok: true, text: paras.join('\n\n') };
}
