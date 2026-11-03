// Model output validation for the story layer (spec 010, contracts/model-output.md).
//
// The only shapes accepted from a model. Order, for every call:
//   1. raw size check (before parsing);
//   2. parseJsonObject: the first balanced {...} (fences and prose around it
//      ignored), JSON.parse, a plain object, nesting depth ≤ 6;
//   3. top-level shape — a failure makes the whole output invalid, nothing applies;
//   4. each element on its own — a failing element is dropped and reported
//      {path, reason}; unknown keys are dropped at every level;
//   5. references must be labels from the input's label map (K…/P…/H…); the
//      model never chooses an id;
//   6. every accepted string is sanitized (sanitizeWebContent, fence tokens
//      removed, ">>>" removed, one line) and capped AFTER sanitizing.
// Nothing here touches the DB, the network or the logger. Plain-text outputs
// (journal, narration) go through validateText with the URL / JID / @digits /
// invented-name rejects (contracts/model-output.md §3–§4, journal.md §3).

import { cleanItem } from './charter.js';

export { validateArcSeed } from './seed.js';

export const EXTRACT_TYPES = Object.freeze(['plan', 'commitment', 'activity', 'money', 'health', 'vitals', 'relationship',
  'job', 'heavy', 'move', 'new_person', 'new_place', 'other']);
export const IN_SCOPE_TYPES = Object.freeze(['plan', 'commitment', 'activity']);
export const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
export const RELATIVE_WHEN = Object.freeze(['today', 'tonight', 'tomorrow', 'this_weekend', 'yesterday', 'last_night', 'now',
  ...WEEKDAYS.map(d => `next_${d}`)]);
export const DAY_PARTS = Object.freeze(['morning', 'afternoon', 'evening', 'night', 'weekend']);
export const BEAT_KINDS = Object.freeze(['status', 'hobby', 'news', 'trip', 'milestone']);
export const NEW_CAST_RELATIONS = Object.freeze(['friend', 'acquaintance', 'neighbour', 'coworker']);
export const ARC_DECISION_KINDS = Object.freeze(['romance_interest', 'social_plan', 'cast_meetup', 'family_visit', 'career_hunt']);

/** Raw-text size limits in bytes (model-output.md). */
export const MAX_BYTES = Object.freeze({ extract: 1536, weekly: 6144, journal: 1536, narration: 1536, seed: 49152, prompt: 6144, scene: 8192 });
export const MAX_DEPTH = 6;

export const LIMITS = Object.freeze({
  extract: { kind: 24, place: 60, person: 40, people: 4, summary: 120, minMinutes: 15, maxMinutes: 360 },
  weekly: { beats: 8, beatText: 120, name: 40, pronouns: 24, personality: 200, speech: 160, status: 160, placeName: 60,
    minKm: 0.2, maxKm: 5, arcDecisions: 3, note: 80, minAge: 18, maxAge: 90 },
  text: { self: 600, chat: 240, narration: 400 },
});

const WAKE_DRAFT_REASONS = Object.freeze(['cant_sleep', 'woken_up', 'early_start']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SLUG_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const LABEL_RE = /^[A-Z]\d{1,3}$/;
// A JID / phone-number-shaped identifier (FR-013): never inside proposed fiction.
const IDENT_RE = /\d{7,}|@(?:s\.whatsapp\.net|lid|g\.us|c\.us)\b|\b[\w.-]+@[\w-]+\.[a-z]{2,}\b/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|in|co|me|app|ly)\b/i;
const AT_DIGITS_RE = /@\s?\d{3,}/;

// ── parse ────────────────────────────────────────────────────────────────────

function depthOf(v, d = 0) {
  if (d > MAX_DEPTH + 1) return d;   // 014 sched: room for the prompt's one extra level
  if (Array.isArray(v)) return v.reduce((m, x) => Math.max(m, depthOf(x, d + 1)), d + 1);
  if (isObj(v)) return Object.values(v).reduce((m, x) => Math.max(m, depthOf(x, d + 1)), d + 1);
  return d;
}

/**
 * The first balanced JSON object in `text` (code fences and prose around it
 * ignored; braces inside string literals respected). Text over `maxBytes` is
 * rejected unparsed. → { ok:true, value } | { ok:false, error:
 * 'empty'|'oversize'|'no_object'|'bad_json'|'too_deep' }
 */
export function parseJsonObject(text, maxBytes = 8192, maxDepth = MAX_DEPTH) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, error: 'oversize' };
  const start = text.indexOf('{');
  if (start < 0) return { ok: false, error: 'no_object' };
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { ok: false, error: 'no_object' };
  let value;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'bad_json' }; }
  if (!isObj(value)) return { ok: false, error: 'no_object' };
  if (depthOf(value) > maxDepth) return { ok: false, error: 'too_deep' };
  return { ok: true, value };
}

// ── field helpers ────────────────────────────────────────────────────────────

/** A model string → cleaned one line, capped; null when not a usable string. */
export function cleanStr(v, max, { min = 1 } = {}) {
  if (typeof v !== 'string') return null;
  const s = cleanItem(v, max);
  return s.length >= min ? s : null;
}

/** True when a string carries a JID, phone number or e-mail-shaped identifier. */
export function hasIdentifier(s) {
  return typeof s === 'string' && IDENT_RE.test(s);
}

function dropUnknown(obj, allowed, base, dropped) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) dropped.push({ path: base ? `${base}.${k}` : k, reason: 'unknown_key' });
  }
}

/** A real calendar date YYYY-MM-DD (1900..2200), else null. */
export function realDate(v) {
  const m = typeof v === 'string' ? DATE_RE.exec(v.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2200) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 'HH:MM' (24 h, also accepts 'H:MM') → 'HH:MM', else null. */
export function hhmm(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^(\d):/, '0$1:');
  return HHMM_RE.test(t) ? t : null;
}

/** A lowercase slug ≤ max ('eat out' → 'eat_out'), else null. */
export function slugOf(v, max = 24) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[\s.]+/g, '_').replace(/[^a-z0-9_-]/g, '').slice(0, max);
  return /^[a-z][a-z0-9_-]*$/.test(s) ? s : null;
}

function labelRef(v, map) {
  if (typeof v !== 'string') return null;
  const k = v.trim().toUpperCase();
  return LABEL_RE.test(k) && isObj(map) && has(map, k) ? k : null;
}

// ── §2 claim extraction ──────────────────────────────────────────────────────

function whenOf(v, dropped) {
  if (!isObj(v)) return null;
  dropUnknown(v, ['date', 'relative', 'time', 'part'], 'when', dropped);
  const out = { date: null, relative: null, time: null, part: null };
  if (v.date !== null && v.date !== undefined) {
    out.date = realDate(v.date);
    if (!out.date) return null;
  }
  if (v.relative !== null && v.relative !== undefined) {
    const r = typeof v.relative === 'string' ? v.relative.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    if (!RELATIVE_WHEN.includes(r)) return null;
    out.relative = r;
  }
  if (v.time !== null && v.time !== undefined) {
    out.time = hhmm(v.time);
    if (!out.time) return null;
  }
  if (v.part !== null && v.part !== undefined) {
    const p = typeof v.part === 'string' ? v.part.trim().toLowerCase() : '';
    if (!DAY_PARTS.includes(p)) return null;
    out.part = p;
  }
  return out;
}

/**
 * Validate the clerk's claim extraction (raw text). Any missing or invalid field
 * → { ok:false, error } (the review goes to the tray as invalid_extraction).
 * → { ok:true, value:{type, kind, when, minutes, place, people, summary, confidence}, dropped }
 */
export function validateExtraction(raw) {
  const dropped = [];
  const parsed = parseJsonObject(raw, MAX_BYTES.extract);
  if (!parsed.ok) return { ok: false, error: parsed.error, dropped };
  const o = parsed.value;
  const L = LIMITS.extract;
  dropUnknown(o, ['type', 'kind', 'when', 'minutes', 'place', 'people', 'summary', 'confidence'], '', dropped);

  const type = typeof o.type === 'string' ? o.type.trim().toLowerCase() : null;
  if (!EXTRACT_TYPES.includes(type)) return { ok: false, error: 'bad_type', dropped };

  let kind = null;
  if (o.kind !== null && o.kind !== undefined) {
    kind = slugOf(o.kind, L.kind);
    if (!kind) return { ok: false, error: 'bad_kind', dropped };
  }

  const when = whenOf(o.when ?? null, dropped);
  if (!when) return { ok: false, error: 'bad_when', dropped };
  if (IN_SCOPE_TYPES.includes(type) && !when.date && !when.relative && !when.time && !when.part) {
    return { ok: false, error: 'no_when', dropped };
  }

  let minutes = null;
  if (o.minutes !== null && o.minutes !== undefined) {
    if (!fin(o.minutes)) return { ok: false, error: 'bad_minutes', dropped };
    minutes = Math.min(L.maxMinutes, Math.max(L.minMinutes, Math.round(o.minutes)));
  }

  let place = null;
  if (o.place !== null && o.place !== undefined) {
    if (typeof o.place !== 'string') return { ok: false, error: 'bad_place', dropped };
    place = cleanStr(o.place, L.place);
  }

  let people = [];
  if (o.people !== null && o.people !== undefined) {
    if (!Array.isArray(o.people)) return { ok: false, error: 'bad_people', dropped };
    for (const [i, p] of o.people.entries()) {
      if (i >= L.people) { dropped.push({ path: `people[${i}]`, reason: 'too_many' }); continue; }
      const s = cleanStr(p, L.person);
      if (s) people.push(s);
      else dropped.push({ path: `people[${i}]`, reason: 'bad_string' });
    }
    people = [...new Set(people)];
  }

  const summary = o.summary === null || o.summary === undefined ? '' : (cleanStr(o.summary, L.summary, { min: 0 }) ?? '');
  if (!fin(o.confidence) || o.confidence < 0 || o.confidence > 1) return { ok: false, error: 'bad_confidence', dropped };

  return { ok: true, value: { type, kind, when, minutes, place, people, summary, confidence: Math.round(o.confidence * 1000) / 1000 }, dropped };
}

// ── §1 weekly arc pass ───────────────────────────────────────────────────────

function ageOnDate(birthday, todayKey) {
  const [by, bm, bd] = birthday.split('-').map(Number);
  const [y, m, d] = todayKey.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

function listOf(o, key, max, dropped) {
  if (!has(o, key) || o[key] === null || o[key] === undefined) return [];
  if (!Array.isArray(o[key])) { dropped.push({ path: key, reason: 'not_a_list' }); return []; }
  for (let i = max; i < o[key].length; i++) dropped.push({ path: `${key}[${i}]`, reason: 'too_many' });
  return o[key].slice(0, max);
}

function idFree(s, path, dropped) {
  if (s && hasIdentifier(s)) { dropped.push({ path, reason: 'identifier' }); return false; }
  return true;
}

/**
 * Validate the weekly arc pass (raw text) against the run's label map:
 *   labelMap = { cast: { K1: { castId, blocked } }, places: { P1: placeId },
 *                heavy: { H1: themeId }, arcs: { A1: arcId } }
 *   opts = { today: 'YYYY-MM-DD' (world tz, for the new member's age) }
 * → { ok:true, value:{ beats, refused, newCast, newPlace, arcDecisions, heavyNomination }, dropped }
 *   | { ok:false, error, dropped }
 * value.refused lists beats for blocked members ({path, castId, kind, reason:'blocked'}).
 */
export function validateWeekly(raw, labelMap = {}, { today = null } = {}) {
  const dropped = [];
  const parsed = parseJsonObject(raw, MAX_BYTES.weekly);
  if (!parsed.ok) return { ok: false, error: parsed.error, dropped };
  const o = parsed.value;
  const W = LIMITS.weekly;
  const castMap = isObj(labelMap.cast) ? labelMap.cast : {};
  const placeMap = isObj(labelMap.places) ? labelMap.places : {};
  const heavyMap = isObj(labelMap.heavy) ? labelMap.heavy : {};
  dropUnknown(o, ['beats', 'new_cast', 'new_place', 'arc_decisions', 'heavy_nomination', 'v'], '', dropped);

  // beats
  const beats = [];
  const refused = [];
  const seenCast = new Set();
  for (const [i, b] of listOf(o, 'beats', W.beats, dropped).entries()) {
    const path = `beats[${i}]`;
    if (!isObj(b)) { dropped.push({ path, reason: 'bad_shape' }); continue; }
    dropUnknown(b, ['cast', 'kind', 'text'], path, dropped);
    const ref = labelRef(b.cast, castMap);
    if (!ref) { dropped.push({ path, reason: 'unknown_ref' }); continue; }
    const kind = typeof b.kind === 'string' ? b.kind.trim().toLowerCase() : '';
    if (!BEAT_KINDS.includes(kind)) { dropped.push({ path, reason: 'bad_enum' }); continue; }
    const text = cleanStr(b.text, W.beatText);
    if (!text) { dropped.push({ path, reason: 'bad_string' }); continue; }
    if (!idFree(text, path, dropped)) continue;
    if (seenCast.has(ref)) { dropped.push({ path, reason: 'duplicate_cast' }); continue; }
    seenCast.add(ref);
    const entry = castMap[ref];
    const castId = entry?.castId;
    if (typeof castId !== 'string') { dropped.push({ path, reason: 'unknown_ref' }); continue; }
    if (entry.blocked) { refused.push({ path, castId, kind, reason: 'blocked' }); continue; }
    beats.push({ castId, kind, text });
  }

  // new cast
  let newCast = null;
  if (has(o, 'new_cast') && o.new_cast !== null && o.new_cast !== undefined) {
    const c = o.new_cast;
    const path = 'new_cast';
    if (!isObj(c)) dropped.push({ path, reason: 'bad_shape' });
    else {
      dropUnknown(c, ['name', 'relation', 'pronouns', 'birthday', 'personality', 'speech', 'status', 'via', 'homeNear'], path, dropped);
      const name = cleanStr(c.name, W.name, { min: 2 });
      const relation = typeof c.relation === 'string' ? c.relation.trim().toLowerCase() : '';
      const birthday = realDate(c.birthday);
      const age = birthday && today && realDate(today) ? ageOnDate(birthday, today) : null;
      const texts = {
        pronouns: c.pronouns == null ? null : cleanStr(c.pronouns, W.pronouns),
        personality: c.personality == null ? null : cleanStr(c.personality, W.personality),
        speech: c.speech == null ? null : cleanStr(c.speech, W.speech),
        status: c.status == null ? null : cleanStr(c.status, W.status),
      };
      if (!name || !/\p{L}/u.test(name)) dropped.push({ path: `${path}.name`, reason: 'bad_string' });
      else if (!NEW_CAST_RELATIONS.includes(relation)) dropped.push({ path: `${path}.relation`, reason: 'bad_enum' });
      else if (!birthday) dropped.push({ path: `${path}.birthday`, reason: 'bad_date' });
      else if (age === null || age < W.minAge || age > W.maxAge) dropped.push({ path: `${path}.birthday`, reason: 'out_of_range' });
      else if (![name, ...Object.values(texts)].every((s, j) => idFree(s, j ? `${path}.text` : `${path}.name`, dropped))) { /* dropped */ }
      else {
        let via = null;
        if (c.via !== null && c.via !== undefined) {
          const ref = labelRef(c.via, castMap);
          if (ref && typeof castMap[ref]?.castId === 'string') via = castMap[ref].castId;
          else dropped.push({ path: `${path}.via`, reason: 'unknown_ref' });
        }
        let homeNear = null;
        if (c.homeNear !== null && c.homeNear !== undefined) {
          const ref = labelRef(c.homeNear, placeMap);
          if (ref) homeNear = placeMap[ref];
          else dropped.push({ path: `${path}.homeNear`, reason: 'unknown_ref' });
        }
        newCast = { name, relation, birthday, ...Object.fromEntries(Object.entries(texts).filter(([, v]) => v)), via, homeNear };
      }
    }
  }

  // new place
  let newPlace = null;
  if (has(o, 'new_place') && o.new_place !== null && o.new_place !== undefined) {
    const p = o.new_place;
    const path = 'new_place';
    if (!isObj(p)) dropped.push({ path, reason: 'bad_shape' });
    else {
      dropUnknown(p, ['name', 'kind', 'near', 'offsetKm'], path, dropped);
      const name = cleanStr(p.name, W.placeName, { min: 2 });
      const kind = slugOf(p.kind, 24);
      const ref = labelRef(p.near, placeMap);
      if (!name || !idFree(name, `${path}.name`, dropped)) { if (!name) dropped.push({ path: `${path}.name`, reason: 'bad_string' }); }
      else if (!kind) dropped.push({ path: `${path}.kind`, reason: 'bad_enum' });
      else if (!ref) dropped.push({ path: `${path}.near`, reason: 'unknown_ref' });
      else if (!fin(p.offsetKm) || p.offsetKm < W.minKm || p.offsetKm > W.maxKm) dropped.push({ path: `${path}.offsetKm`, reason: 'out_of_range' });
      else newPlace = { name, kind, near: placeMap[ref], offsetKm: Math.round(p.offsetKm * 100) / 100 };
    }
  }

  // arc decisions (the note is kept for story_runs / story_proposals only)
  const arcDecisions = [];
  for (const [i, a] of listOf(o, 'arc_decisions', W.arcDecisions, dropped).entries()) {
    const path = `arc_decisions[${i}]`;
    if (!isObj(a)) { dropped.push({ path, reason: 'bad_shape' }); continue; }
    dropUnknown(a, ['kind', 'cast', 'note'], path, dropped);
    const kind = typeof a.kind === 'string' ? a.kind.trim().toLowerCase() : '';
    if (!ARC_DECISION_KINDS.includes(kind)) { dropped.push({ path, reason: 'bad_enum' }); continue; }
    let castId = null;
    if (a.cast !== null && a.cast !== undefined) {
      const ref = labelRef(a.cast, castMap);
      if (!ref || typeof castMap[ref]?.castId !== 'string') { dropped.push({ path, reason: 'unknown_ref' }); continue; }
      if (castMap[ref].blocked) { refused.push({ path, castId: castMap[ref].castId, kind, reason: 'blocked' }); continue; }
      castId = castMap[ref].castId;
    }
    const note = a.note == null ? '' : (cleanStr(a.note, W.note, { min: 0 }) ?? '');
    arcDecisions.push({ kind, castId, note: hasIdentifier(note) ? '' : note });
  }

  // heavy nomination
  let heavyNomination = null;
  if (has(o, 'heavy_nomination') && o.heavy_nomination !== null && o.heavy_nomination !== undefined) {
    const h = o.heavy_nomination;
    if (!isObj(h)) dropped.push({ path: 'heavy_nomination', reason: 'bad_shape' });
    else {
      dropUnknown(h, ['theme'], 'heavy_nomination', dropped);
      const ref = labelRef(h.theme, heavyMap);
      if (ref) heavyNomination = { themeId: heavyMap[ref] };
      else dropped.push({ path: 'heavy_nomination.theme', reason: 'unknown_ref' });
    }
  }

  return { ok: true, value: { beats, refused, newCast, newPlace, arcDecisions, heavyNomination }, dropped };
}

// ── §3/§4 plain-text outputs ─────────────────────────────────────────────────

// Capitalized words that are not names (sentence starters, days, months, pronouns…).
const STOP_WORDS = new Set(`i i'm i've i'd i'll me my we our us you your he she they them his her their it its
a an the and but or so then also just still even yet not no yes ok okay oh well now today tonight tomorrow yesterday
this that these those there here what when where why how who which while after before since until because though
although if as at by for from in into of on to with without about again all some any every each most more less much
many few lot lots one two three first last next later earlier soon maybe perhaps probably really actually finally
anyway somehow sometimes always never often morning afternoon evening night day days week weekend month year
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
october november december work home office lunch dinner breakfast coffee tea gym movie walk park cafe café call
felt feel feeling good great nice bad long short tired busy quiet slow fine glad happy sad hard easy
dear diary note notes back went got had did was were been being have has do does done made make making going go`
  .split(/\s+/).filter(Boolean));

export function capitalizedWords(text) {
  const out = [];
  const sentences = String(text).split(/(?<=[.!?…])\s+|\n+/);
  for (const sent of sentences) {
    const words = sent.match(/[\p{L}][\p{L}'’-]*/gu) || [];
    words.forEach((w, i) => {
      if (!/^\p{Lu}/u.test(w)) return;
      const lw = w.toLowerCase().replace(/['’]s$/, '');
      if (STOP_WORDS.has(lw)) return;
      // A sentence-initial word is only suspicious when it is not an ordinary word
      // in lower case elsewhere in the text.
      if (i === 0 && new RegExp(`(^|[^\\p{L}])${lw}([^\\p{L}]|$)`, 'u').test(text.replace(w, ''))) return;
      out.push(lw);
    });
  }
  return out;
}

/**
 * A plain-text model output (journal part, narration): raw ≤ maxBytes, cleaned to
 * one paragraph and capped at `cap`. Rejects (fail closed): empty, a URL, a JID or
 * @digits (after sanitizing, in the RAW text too), and more than one capitalized
 * word that is neither a stop word nor one of `names` (journal.md §3).
 * → { ok:true, text } | { ok:false, reason: 'empty'|'oversize'|'url'|'identifier'|'invented_name' }
 */
export function validateText(raw, { cap, names = [], maxBytes = MAX_BYTES.journal, maxInvented = 1 } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { ok: false, reason: 'oversize' };
  if (IDENT_RE.test(raw) || AT_DIGITS_RE.test(raw)) return { ok: false, reason: 'identifier' };
  if (URL_RE.test(raw)) return { ok: false, reason: 'url' };
  const text = cleanItem(raw.replace(/^["'`\s]+|["'`\s]+$/g, ''), cap);
  if (!text) return { ok: false, reason: 'empty' };
  if (IDENT_RE.test(text) || AT_DIGITS_RE.test(text)) return { ok: false, reason: 'identifier' };
  if (URL_RE.test(text)) return { ok: false, reason: 'url' };
  const allowed = new Set();
  for (const n of names) {
    for (const w of String(n ?? '').toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || []) allowed.add(w.replace(/['’]s$/, ''));
  }
  const invented = [...new Set(capitalizedWords(text).filter(w => !allowed.has(w)))];
  // 016 (D14): a scene allows one invented capitalised word per 400 chars; journal/narration keep 1.
  const limit = Number.isInteger(maxInvented) && maxInvented >= 1 ? maxInvented : 1;
  if (invented.length > limit) return { ok: false, reason: 'invented_name' };
  return { ok: true, text };
}

/** Journal part (model-output.md §3): `part` 'self' (≤ 600) or 'chat' (≤ 240). */
export function validateJournalPart(raw, { part = 'self', names = [] } = {}) {
  return validateText(raw, { cap: part === 'chat' ? LIMITS.text.chat : LIMITS.text.self, names, maxBytes: MAX_BYTES.journal });
}

/** Narration (model-output.md §4): ≤ 400 chars, same rejects. */
export function validateNarration(raw, { names = [] } = {}) {
  return validateText(raw, { cap: LIMITS.text.narration, names, maxBytes: MAX_BYTES.narration });
}

export { SLUG_RE as KIND_SLUG_RE };

// ── Director prompt (spec 011 §P1.4, review R3/R10/R12/R22) ─────────────────
//
// validatePromptOutput(raw, catalogue, vocab) turns the mind's answer into
// DRAFTS: ordinary Director actions the owner previews and applies through the
// unchanged path. Every action is rebuilt as a fresh object from a per-kind
// allow-list (unknown keys dropped, prototype keys refused at every depth); ids
// must come from the code-built catalogue; model strings with an identifier or a
// URL drop the draft; heavy levers only tighten. `vocab` holds the Director's
// closed lists (passed in by prompt.js, so this module imports no planner).
// → { drafts:[{index, action, why}], dropped:[{index, kind, reason}], cantDo } | { invalid }

export const PROMPT_MAX_ACTIONS = 6;
export const PROMPT_CANTDO_MAX = 4;
export const PROMPT_TEXT_MAX = 120;
export const PROMPT_DROP_REASONS = Object.freeze(['too_many', 'not_allowed', 'bad_action', 'bad_key', 'unknown_cast',
  'unknown_place', 'unknown_ref', 'bad_time', 'identifier_in_text', 'bad_field', 'route_shape', 'real_person',
  // 015: a model never names his employer (a code placeholder instead).
  'bad_employerName',
  // 014 geo: a venue query that fails the wish checks / venue charset / blocklist (prompt.js fillVenueDrafts).
  'bad_venue',
  // A bookmark the wish never asked for (prompt.js: no bookmark / remember this / mark this / save this moment).
  'unrequested']);

// Side drafts (prompt.js holdSideDrafts): a bookmark, or an action the model marked
// `"accompanies": <position of another action>` — it only makes sense with the rest.
export const PROMPT_SIDE_KINDS = Object.freeze(['bookmark']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROMPT_CAPS = { label: 80, text: 160, beat: 120, name: 60, castName: 40, reason: 200, bookmark: 60, pronouns: 24,
  personality: 200, speech: 160, status: 160, availability: 160, job: 60, employer: 80, hometown: 80 };

// 014: a draft that names a real venue keeps only the query, here (never on the action):
// action → [{range, query}] (a schedule's ranges) | [{field:'place', query}] (an outing's place).
const promptVenues = new WeakMap();

class Drop extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const drop = (reason) => { throw new Drop(reason); };

function hasForbiddenKey(v, depth = 0) {
  if (depth > MAX_DEPTH + 2) return true;
  if (Array.isArray(v)) return v.some(x => hasForbiddenKey(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) if (FORBIDDEN_KEYS.has(k) || hasForbiddenKey(v[k], depth + 1)) return true;
  }
  return false;
}

/** A model string for an event field: typed, capped, no identifier / URL; cleaned. */
function modelText(v, cap, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) drop('bad_field');
    return undefined;
  }
  if (typeof v !== 'string' || v.length > cap) drop('bad_field');
  if (hasIdentifier(v) || URL_RE.test(v) || AT_DIGITS_RE.test(v)) drop('identifier_in_text');
  const s = cleanItem(v, cap);
  if (!s) {
    if (required) drop('bad_field');
    return undefined;
  }
  if (hasIdentifier(s) || URL_RE.test(s)) drop('identifier_in_text');
  return s;
}

const oneOf = (v, list) => (typeof v === 'string' && list.includes(v) ? v : drop('bad_field'));
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : drop('bad_field'));

function castOf(id, cat) {
  return typeof id === 'string' && cat.castIds.has(id) ? id : drop('unknown_cast');
}
function placeOf(id, cat) {
  return typeof id === 'string' && cat.placeIds.has(id) ? id : drop('unknown_place');
}
function castList(v, cat) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 4) drop('bad_field');
  return [...new Set(v.map(id => castOf(id, cat)))];
}

/** Calendar date `n` days after `today` (YYYY-MM-DD; pure date arithmetic, no time zone). */
export function addDaysToDate(today, n) {
  const m = DATE_RE.exec(String(today ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The model writes {day, time} | {inMinutes}; the draft carries {date, time} (anchored
// to the prompt's date, so it cannot slide a day) | {inMinutes}. The planner resolves it.
function promptWhenOf(v, cat, maxDays) {
  if (!isObj(v)) drop('bad_time');
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'inMinutes') {
    if (!Number.isInteger(v.inMinutes) || v.inMinutes < 0 || v.inMinutes > 1440) drop('bad_time');
    return { inMinutes: v.inMinutes };
  }
  if (keys.length !== 2 || !has(v, 'day') || !has(v, 'time')) drop('bad_time');
  if (!Number.isInteger(v.day) || v.day < 0 || v.day > maxDays) drop('bad_time');
  const time = typeof v.time === 'string' && HHMM_RE.test(v.time) ? v.time : drop('bad_time');
  const date = addDaysToDate(cat.today, v.day) ?? drop('bad_time');
  return { date, time };
}

function newCastOf(v, vocab, cat, { scene = false } = {}) {
  if (!isObj(v)) drop('bad_field');
  const out = { name: modelText(v.name, PROMPT_CAPS.castName), relation: oneOf(v.relation, vocab.newCastRelations) };
  for (const k of ['pronouns', 'personality', 'speech', 'status']) {
    const t = modelText(v[k], PROMPT_CAPS[k], { required: false });
    if (t !== undefined) out[k] = t;
  }
  if (scene && v.birthday !== undefined && v.birthday !== null) out.birthday = realDate(v.birthday) ?? drop('bad_field');
  if (scene && v.metVia !== undefined && v.metVia !== null) out.metVia = castOf(v.metVia, cat);
  return out;
}

function newPlaceOf(v, cat) {
  if (!isObj(v)) drop('bad_field');
  const kind = slugOf(v.placeKind ?? v.kind) ?? drop('bad_field');
  const km = v.offsetKm;
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0 || km > 5) drop('bad_field');
  return { name: modelText(v.name, PROMPT_CAPS.name), kind, near: placeOf(v.near, cat), offsetKm: Math.round(km * 100) / 100 };
}

function sceneOf(a, vocab, cat) {
  const shape = a.shape;
  if (typeof shape !== 'string' || !vocab.promptSceneShapes.includes(shape)) drop('not_allowed');
  const out = { kind: 'scene', shape };
  switch (shape) {
    case 'outing': case 'visit': {
      const named = (k) => a[k] !== undefined && a[k] !== null;
      if (shape === 'outing') {
        // One of: a known place, an invented generic one, or a real venue the
        // owner named (its query goes to the draft's venues slot, never on the
        // action: geo's post-step looks it up and the owner picks a candidate).
        if (['placeId', 'newPlace', 'venue'].filter(named).length > 1) drop('bad_field');
        if (named('venue')) promptVenues.set(out, [{ field: 'place', query: venueQueryOf(a.venue) }]);
        else if (named('newPlace')) out.newPlace = newPlaceOf(a.newPlace, cat);
        else out.placeId = placeOf(a.placeId, cat);
      } else if (named('venue')) drop('bad_field');   // a visit is at his home
      const castIds = castList(a.castIds, cat);
      if (castIds.length) out.castIds = castIds;
      if (a.newCast !== undefined && a.newCast !== null) out.newCast = newCastOf(a.newCast, vocab, cat);
      if (shape === 'visit' && !castIds.length && !out.newCast) drop('bad_field');
      out.when = promptWhenOf(a.when, cat, vocab.whenDaysMax);
      out.minutes = intIn(a.minutes, 15, 360);
      if (shape === 'outing') {
        const label = modelText(a.label, PROMPT_CAPS.label, { required: false });
        if (label !== undefined) out.label = label;
      }
      return out;
    }
    case 'cast.beat': {
      out.castId = castOf(a.castId, cat);
      out.beatKind = oneOf(a.beatKind, vocab.beatKinds);
      out.text = modelText(a.text, PROMPT_CAPS.beat);
      if (a.untilDays !== undefined && a.untilDays !== null) out.untilDays = intIn(a.untilDays, 1, 31);
      return out;
    }
    case 'cast.history': {
      out.castId = castOf(a.castId, cat);
      out.text = modelText(a.text, PROMPT_CAPS.text);
      if (a.daysAgo !== undefined && a.daysAgo !== null) out.daysAgo = intIn(a.daysAgo, 0, 36500);
      return out;
    }
    case 'new_cast': return { ...out, ...newCastOf(a, vocab, cat, { scene: true }) };
    case 'new_place': {
      const np = newPlaceOf(a, cat);
      return { ...out, name: np.name, placeKind: np.kind, near: np.near, offsetKm: np.offsetKm };
    }
    case 'arc.start': {
      out.category = typeof a.category === 'string' && has(vocab.arcKinds, a.category) ? a.category : drop('bad_field');
      out.arcKind = oneOf(a.arcKind, vocab.arcKinds[out.category]);
      out.castIds = castList(a.castIds, cat);
      return out;
    }
    case 'arc.stage': {
      out.arcId = Number.isSafeInteger(a.arcId) && cat.arcIds.has(a.arcId) ? a.arcId : drop('unknown_ref');
      out.to = oneOf(a.to, vocab.romanceStages);
      return out;
    }
    default: return drop('not_allowed');
  }
}

function promptActionOf(a, vocab, cat) {
  if (!isObj(a) || typeof a.kind !== 'string') drop('bad_action');
  if (hasForbiddenKey(a)) drop('bad_key');
  const kind = a.kind;
  if (!vocab.promptKinds.includes(kind)) drop('not_allowed');
  switch (kind) {
    case 'quick': return { kind, button: oneOf(a.button, vocab.quickButtons) };
    case 'fate': {
      const category = oneOf(a.category, vocab.categories);
      const mode = oneOf(a.mode, vocab.fateModes);
      // Heavy stretches only ever get tighter from words (R10).
      if (category === 'heavy' && mode !== 'frozen') drop('not_allowed');
      return { kind, category, mode };
    }
    case 'slider': {
      const name = oneOf(a.name, vocab.sliders);
      if (typeof a.value !== 'number' || !Number.isFinite(a.value) || a.value < 0 || a.value > 1) drop('bad_field');
      const value = Math.round(a.value * 100) / 100;
      const current = fin(cat.sliders?.[name]) ? cat.sliders[name] : 0.5;
      if (vocab.tightenOnlySliders.includes(name) && value > current) drop('not_allowed');
      return { kind, name, value };
    }
    case 'pin': case 'unpin': {
      const ok = typeof a.pinKey === 'string' && (kind === 'pin' ? cat.pinKeys.has(a.pinKey) : cat.pins.has(a.pinKey));
      return { kind, pinKey: ok ? a.pinKey : drop('unknown_ref') };
    }
    case 'pause': case 'resume': {
      const reason = modelText(a.reason, PROMPT_CAPS.reason, { required: false });
      return reason === undefined ? { kind } : { kind, reason };
    }
    case 'bookmark': return { kind, name: modelText(a.name, PROMPT_CAPS.bookmark) };
    case 'scene': return sceneOf(a, vocab, cat);
    case 'cast.edit': {
      const castId = castOf(a.castId, cat);
      if (!isObj(a.fields) || has(a.fields, 'name')) drop('bad_field');
      const fields = {};
      for (const k of ['status', 'availability', 'job', 'employer', 'personality', 'speech', 'pronouns']) {
        const t = modelText(a.fields[k], PROMPT_CAPS[k], { required: false });
        if (t !== undefined) fields[k] = t;
      }
      if (a.fields.birthday !== undefined && a.fields.birthday !== null) fields.birthday = realDate(a.fields.birthday) ?? drop('bad_field');
      if (!Object.keys(fields).length) drop('bad_field');
      return { kind, castId, fields };
    }
    case 'cast.metrics': {
      const out = { kind, castId: castOf(a.castId, cat) };
      for (const k of ['closeness', 'trust', 'tension']) {
        if (a[k] === undefined || a[k] === null) continue;
        if (!fin(a[k]) || a[k] < 0 || a[k] > 1) drop('bad_field');
        out[k] = Math.round(a[k] * 100) / 100;
      }
      if (Object.keys(out).length === 2) drop('bad_field');
      return out;
    }
    case 'cast.history': {
      const out = { kind, castId: castOf(a.castId, cat), text: modelText(a.text, PROMPT_CAPS.text) };
      if (a.daysAgo !== undefined && a.daysAgo !== null) out.daysAgo = intIn(a.daysAgo, 0, 36500);
      return out;
    }
    case 'place.edit': {
      const out = { kind, placeId: placeOf(a.placeId, cat) };
      const name = modelText(a.name, PROMPT_CAPS.name, { required: false });
      if (name !== undefined) out.name = name;
      if (a.placeKind !== undefined && a.placeKind !== null) out.placeKind = slugOf(a.placeKind) ?? drop('bad_field');
      if (!out.name && !out.placeKind) drop('bad_field');
      return out;
    }
    // 011 Phase 2: owner weather windows and soft goals.
    case 'weather': {
      const out = { kind, weatherKind: oneOf(a.weatherKind, vocab.weatherKinds) };
      if (a.intensity !== undefined && a.intensity !== null) {
        if (!fin(a.intensity) || a.intensity < 0 || a.intensity > 1) drop('bad_field');
        out.intensity = Math.round(a.intensity * 100) / 100;
      }
      out.from = promptWhenOf(a.from, cat, vocab.weatherDaysMax);
      out.to = promptWhenOf(a.to, cat, vocab.weatherDaysMax);
      return out;
    }
    case 'weather.end':
      return { kind, windowId: Number.isSafeInteger(a.windowId) && cat.windowIds?.has(a.windowId) ? a.windowId : drop('unknown_ref') };
    case 'goal': {
      const out = { kind, goalKind: oneOf(a.goalKind, vocab.goalKinds) };
      if (a.castId !== undefined && a.castId !== null) out.castId = castOf(a.castId, cat);
      if (a.placeId !== undefined && a.placeId !== null) out.placeId = placeOf(a.placeId, cat);
      if (out.goalKind === 'meet' && !out.castId) drop('bad_field');
      const from = Number.isInteger(a.fromDay) && a.fromDay >= 0 && a.fromDay <= vocab.goalDaysMax ? a.fromDay : drop('bad_time');
      const to = Number.isInteger(a.toDay) && a.toDay >= from && a.toDay <= vocab.goalDaysMax ? a.toDay : drop('bad_time');
      out.fromDate = addDaysToDate(cat.today, from) ?? drop('bad_time');
      out.toDate = addDaysToDate(cat.today, to) ?? drop('bad_time');
      if (a.minutes !== undefined && a.minutes !== null) out.minutes = intIn(a.minutes, 15, 240);
      const label = modelText(a.label, PROMPT_CAPS.label, { required: false });
      if (label !== undefined) out.label = label;
      return out;
    }
    case 'goal.cancel':
      return { kind, goalId: Number.isSafeInteger(a.goalId) && cat.goalIds?.has(a.goalId) ? a.goalId : drop('unknown_ref') };
    // 014 sched (A6a): schedule edits; a range naming a real venue keeps only the query (needs_venue).
    case 'schedule': return scheduleDraftOf(a, vocab, cat);
    case 'schedule.clear':
      return { kind, overrideId: Number.isSafeInteger(a.overrideId) && cat.overrideIds?.has(a.overrideId) ? a.overrideId : drop('unknown_ref') };
    // 015 Director as god (plan §P1.9): ids only from the catalogue; never an employer name.
    case 'decision.pick': case 'outcome': case 'career': case 'money': case 'home': case 'mood': case 'health': case 'scene.tone':
    case 'arc.end': case 'cast.depart': case 'cast.return':
      return godActionOf(kind, a, vocab, cat);
    // Wake him: a reason and "HH:MM" times only (the planner checks he is asleep then).
    case 'wake': {
      const out = { kind, reason: oneOf(a.reason, WAKE_DRAFT_REASONS) };
      for (const k of ['at', 'until']) {
        if (a[k] === undefined || a[k] === null) continue;
        out[k] = typeof a[k] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(a[k]) ? a[k] : drop('bad_time');
      }
      if (out.until && out.reason === 'early_start') drop('bad_field');
      return out;
    }
    // 019: he texts a member of his cast — the owner's gist (free text), an optional tone and "HH:MM".
    case 'text': {
      const out = { kind, castId: castOf(a.castId, cat), gist: modelText(a.gist, PROMPT_CAPS.text) };
      if (a.tone !== undefined && a.tone !== null && a.tone !== '') out.tone = oneOf(a.tone, vocab.textTones ?? []);
      if (a.at !== undefined && a.at !== null) out.at = typeof a.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.at) ? a.at : drop('bad_time');
      if (a.from !== undefined && a.from !== null) out.from = oneOf(a.from, ['him', 'them']);
      if (a.chat !== undefined && a.chat !== null) out.chat = oneOf(a.chat, ['short', 'long']);
      if (a.words !== undefined && a.words !== null && a.words !== '') out.words = modelText(a.words, PROMPT_CAPS.text);
      return out;
    }
    case 'seed.set': {
      const path = typeof a.path === 'string' && vocab.seedPaths.includes(a.path) ? a.path : drop('bad_field');
      const v = a.value;
      const okValue = v === null || fin(v) || (Array.isArray(v) && v.length === 2 && v.every(fin));
      if (!okValue) drop('bad_field');
      return { kind, path, value: Array.isArray(v) ? [...v] : v };
    }
    default: return drop('not_allowed');
  }
}

// ── 014 sched: schedule drafts (plan §A6a) ────────────────────────────────
// The model writes {day, background?, ranges?} with "HH:MM" | "now" | "endOfDay"
// times; the draft carries the prompt's date (it cannot slide a day). A range
// that names a real venue ("venueQuery": {name, area}) and no place is kept
// without a place: the draft is `needs_venue` and lists the query (geo's
// post-step looks it up; the owner picks a candidate before any preview).
const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHED_BACKGROUNDS = ['off', 'work_home', 'work_office'];
const SCHED_ACTIVITIES = ['home', 'out', 'sleep', 'errand', 'gym', 'work_office', 'work_home'];
const VENUE_TEXT_MAX = { name: 60, area: 40 };

function schedTimeOf(v, { endOfDay = false, now = false } = {}) {
  if (now && v === 'now') return 'now';
  if (endOfDay && v === 'endOfDay') return 'endOfDay';
  return typeof v === 'string' && SCHEDULE_TIME_RE.test(v) ? v : drop('bad_time');
}

function venueQueryOf(v) {
  if (!isObj(v)) drop('bad_field');
  const name = modelText(v.name, VENUE_TEXT_MAX.name);
  const area = modelText(v.area, VENUE_TEXT_MAX.area, { required: false });
  return area === undefined ? { name } : { name, area };
}

function scheduleDraftOf(a, vocab, cat) {
  const out = { kind: 'schedule' };
  const day = Number.isInteger(a.day) && a.day >= 0 && a.day <= (vocab.scheduleDaysMax ?? 7) ? a.day : drop('bad_time');
  out.date = addDaysToDate(cat.today, day) ?? drop('bad_time');
  const op = a.op === undefined || a.op === null ? 'set' : (['set', 'remove', 'move'].includes(a.op) ? a.op : drop('bad_field'));
  if (op !== 'set') out.op = op;
  const venues = [];
  if (a.background !== undefined && a.background !== null) {
    const bg = a.background;
    if (!isObj(bg)) drop('bad_field');
    const b = { activity: oneOf(bg.activity, SCHED_BACKGROUNDS) };
    if (bg.wholeDay === true) b.wholeDay = true;
    else {
      b.from = schedTimeOf(bg.from, { now: day === 0 });
      b.to = bg.to === undefined || bg.to === null ? 'endOfDay' : schedTimeOf(bg.to, { endOfDay: true });
    }
    out.background = b;
  }
  if (a.ranges !== undefined && a.ranges !== null) {
    if (!Array.isArray(a.ranges) || a.ranges.length > 3) drop('bad_field');
    out.ranges = a.ranges.map((r, i) => {
      if (!isObj(r)) drop('bad_field');
      const x = { activity: oneOf(r.activity, SCHED_ACTIVITIES), from: schedTimeOf(r.from, { now: day === 0 }), to: schedTimeOf(r.to, { endOfDay: true }) };
      if (r.placeId !== undefined && r.placeId !== null) x.placeId = placeOf(r.placeId, cat);
      else if (r.venueQuery !== undefined && r.venueQuery !== null) {
        if (x.activity !== 'out') drop('bad_field');
        venues.push({ range: i, query: venueQueryOf(r.venueQuery) });
      }
      const castIds = castList(r.castIds, cat);
      if (castIds.length) x.castIds = castIds;
      const label = modelText(r.label, PROMPT_CAPS.label, { required: false });
      if (label !== undefined) x.label = label;
      return x;
    });
  }
  if (op !== 'set') {
    out.blockKind = slugOf(a.blockKind) ?? drop('bad_field');
    if (op === 'move') out.moveTo = schedTimeOf(a.moveTo);
  } else if (!out.background && !out.ranges?.length) drop('bad_field');
  if (venues.length) promptVenues.set(out, venues);
  return out;
}

// 015: the opened powers a model may draft (per-kind allow-list; unknown keys dropped).
function godActionOf(kind, a, vocab, cat) {
  const decisionOf = (id) => (Number.isSafeInteger(id) && cat.decisionIds?.has(id) ? id : drop('unknown_ref'));
  const whenOpt = (out) => {
    if (a.when !== undefined && a.when !== null) out.when = promptWhenOf(a.when, cat, vocab.whenDaysMax);
    return out;
  };
  switch (kind) {
    case 'decision.pick': {
      const decisionId = decisionOf(a.decisionId);
      const opts = cat.decisionOptions?.get?.(decisionId) ?? [];
      return { kind, decisionId, optionId: typeof a.optionId === 'string' && opts.includes(a.optionId) ? a.optionId : drop('bad_field') };
    }
    case 'outcome':
      return whenOpt({ kind, decisionId: decisionOf(a.decisionId), outcome: oneOf(a.outcome, vocab.outcomes) });
    case 'scene.tone':   // 016: the hint + its outcome word (R23)
      return { kind, decisionId: decisionOf(a.decisionId), tone: modelText(a.tone, 120), outcome: oneOf(a.outcome, ['well', 'fine', 'flat', 'badly']) };
    case 'career': {
      if (a.employerName !== undefined && a.employerName !== null) drop('bad_employerName');
      const change = oneOf(a.change, vocab.careerChanges);
      const out = { kind, change };
      const title = modelText(a.title, 60, { required: change === 'hire' || change === 'job' });
      if (title !== undefined) out.title = title;
      if (a.salary !== undefined && a.salary !== null) {
        if (!fin(a.salary) || a.salary < 0 || a.salary > 1e9) drop('bad_field');
        out.salary = Math.round(a.salary);
      }
      // Never a real business as his office: a venue's id is left out (plan §P1.2).
      if (a.officePlaceId !== undefined && a.officePlaceId !== null) {
        const office = placeOf(a.officePlaceId, cat);
        if (!cat.venuePlaceIds?.has?.(office)) out.officePlaceId = office;
      }
      if (a.pattern !== undefined && a.pattern !== null) {
        if (!isObj(a.pattern)) drop('bad_field');
        const days = (v) => (Array.isArray(v) && v.length <= 7 && v.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ? [...new Set(v)] : drop('bad_field'));
        out.pattern = { officeDays: days(a.pattern.officeDays ?? []), wfhDays: days(a.pattern.wfhDays ?? []) };
      }
      return whenOpt(out);
    }
    case 'money': {
      const mode = oneOf(a.mode, vocab.moneyModes);
      if (!fin(a.amount) || Math.abs(a.amount) > 1e9 || (mode !== 'set' && a.amount < 0)) drop('bad_field');
      const out = { kind, mode, amount: Math.round(a.amount) };
      const label = modelText(a.label, PROMPT_CAPS.label, { required: false });
      if (label !== undefined) out.label = label;
      return out;
    }
    case 'home': {
      const out = { kind, near: placeOf(a.near, cat) };
      if (a.flatmate !== undefined && a.flatmate !== null) out.flatmate = oneOf(a.flatmate, vocab.homeFlatmate);
      return whenOpt(out);
    }
    case 'mood': {
      const out = { kind };
      if (a.preset !== undefined && a.preset !== null) out.preset = oneOf(a.preset, vocab.moodPresets);
      else drop('bad_field');
      if (a.wakeDay !== undefined && a.wakeDay !== null) out.wakeDay = intIn(a.wakeDay, 0, 13);
      else if (a.when !== undefined && a.when !== null) out.when = promptWhenOf(a.when, cat, vocab.whenDaysMax);
      else drop('bad_time');
      const label = modelText(a.label, PROMPT_CAPS.label, { required: false });
      if (label !== undefined) out.label = label;
      return out;
    }
    case 'health': {
      const out = { kind, change: oneOf(a.change, vocab.healthChanges) };
      if (a.days !== undefined && a.days !== null) out.days = intIn(a.days, 1, 14);
      return whenOpt(out);
    }
    case 'arc.end':
      return { kind, arcId: Number.isSafeInteger(a.arcId) && cat.arcIds?.has(a.arcId) ? a.arcId : drop('unknown_ref'), outcome: oneOf(a.outcome, vocab.arcEndOutcomes) };
    case 'cast.depart':
      return { kind, castId: castOf(a.castId, cat), how: oneOf(a.how, vocab.departHow) };
    case 'cast.return':
      return { kind, castId: typeof a.castId === 'string' && cat.departedIds?.has(a.castId) ? a.castId : drop('unknown_cast') };
    default: return drop('not_allowed');
  }
}

/**
 * The prompt's model output → drafts. `catalogue`: { today, castIds:Set, placeIds:Set,
 * arcIds:Set, pinKeys:Set, pins:Set, sliders:{}, windowIds:Set, goalIds:Set }. `vocab`:
 * the Director's closed lists { actionKinds, promptKinds, promptSceneShapes, quickButtons,
 * categories, fateModes, sliders, tightenOnlySliders, seedPaths, romanceStages, arcKinds,
 * beatKinds, newCastRelations, whenDaysMax, weatherKinds, weatherDaysMax, goalKinds,
 * goalDaysMax }.
 */
export function validatePromptOutput(raw, catalogue, vocab) {
  // 014 sched: one level more, for a schedule range's venueQuery {name, area}.
  const p = parseJsonObject(raw, MAX_BYTES.prompt, MAX_DEPTH + 1);
  if (!p.ok) return { invalid: p.error };
  const v = p.value;
  if (Object.keys(v).some(k => FORBIDDEN_KEYS.has(k))) return { invalid: 'bad_key' };
  if (!Array.isArray(v.actions)) return { invalid: 'bad_actions' };
  const drafts = [];
  const dropped = [];
  const n = Math.min(v.actions.length, PROMPT_MAX_ACTIONS);
  v.actions.forEach((item, index) => {
    const a = isObj(item) && isObj(item.action) ? item.action : item;
    const kind = isObj(a) && typeof a.kind === 'string' && vocab.actionKinds.includes(a.kind) ? a.kind : null;
    // A side draft: a bookmark, or one marked as accompanying another action of this answer.
    const acc = isObj(item) && Number.isSafeInteger(item.accompanies) && item.accompanies >= 0 && item.accompanies < n && item.accompanies !== index;
    const side = PROMPT_SIDE_KINDS.includes(kind) || acc ? { side: true } : {};
    if (index >= PROMPT_MAX_ACTIONS) { dropped.push({ index, kind, reason: 'too_many', ...side }); return; }
    try {
      if (hasForbiddenKey(item)) drop('bad_key');
      const action = promptActionOf(a, vocab, catalogue);
      const why = isObj(item) && typeof item.why === 'string' ? cleanStr(item.why, PROMPT_TEXT_MAX) : null;
      const venues = promptVenues.get(action);   // 014: a venue to look up first (a schedule range, an outing)
      drafts.push({ index, action, why, ...side, ...(venues ? { status: 'needs_venue', venues } : {}) });
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      dropped.push({ index, kind, reason: PROMPT_DROP_REASONS.includes(e.reason) ? e.reason : 'bad_field', ...side });
    }
  });
  const cantDo = (Array.isArray(v.cantDo) ? v.cantDo : [])
    .map(x => cleanStr(x, PROMPT_TEXT_MAX)).filter(Boolean).slice(0, PROMPT_CANTDO_MAX);
  return { drafts, dropped, cantDo };
}

// ── 015 §P2.4 continuity story read ─────────────────────────────────────────
//
// validateContinuityOutput(raw, catalogue, vocab, {allowed}) → { warnings, suggestions,
// dropped } | { invalid }. Warnings: ≤ 6, closed severity / about, text capped and
// cleaned, an identifier or a URL drops it (real names are dropped by the caller,
// which has the names list). Suggestions: ≤ 4, each a 011 draft action through the
// SAME per-kind validator as the Director prompt (validatePromptOutput), then only
// the non-destructive allow-list `allowed(action)` passes ('not_allowed' otherwise).

export const CONTINUITY_MAX_BYTES = 6144;
export const CONTINUITY_WARNINGS_MAX = 6;
export const CONTINUITY_SUGGESTIONS_MAX = 4;
export const CONTINUITY_SEVERITIES = Object.freeze(['info', 'warn', 'high']);
export const CONTINUITY_ABOUT = Object.freeze(['time', 'people', 'job', 'relationship', 'money', 'family', 'tone', 'other']);
const CONTINUITY_TEXT_MAX = 160;
const CONTINUITY_PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

export function validateContinuityOutput(raw, catalogue, vocab, { allowed = () => false } = {}) {
  if (typeof raw !== 'string' || raw.length > CONTINUITY_MAX_BYTES) return { invalid: 'too_long' };
  const p = parseJsonObject(raw, CONTINUITY_MAX_BYTES);
  if (!p.ok) return { invalid: p.error };
  const v = p.value;
  if (Object.keys(v).some(k => FORBIDDEN_KEYS.has(k)) || hasForbiddenKey(v)) return { invalid: 'bad_key' };
  if (v.warnings !== undefined && !Array.isArray(v.warnings)) return { invalid: 'bad_warnings' };
  if (v.suggestions !== undefined && !Array.isArray(v.suggestions)) return { invalid: 'bad_suggestions' };
  const dropped = [];
  const warnings = [];
  (v.warnings ?? []).forEach((w, index) => {
    if (index >= CONTINUITY_WARNINGS_MAX) { dropped.push({ part: 'warning', index, reason: 'too_many' }); return; }
    if (!isObj(w) || !CONTINUITY_SEVERITIES.includes(w.severity) || typeof w.text !== 'string' || w.text.length > CONTINUITY_TEXT_MAX * 2) {
      dropped.push({ part: 'warning', index, reason: 'bad_field' });
      return;
    }
    if (hasIdentifier(w.text) || URL_RE.test(w.text) || AT_DIGITS_RE.test(w.text) || CONTINUITY_PHONE_RE.test(w.text)) { dropped.push({ part: 'warning', index, reason: 'identifier_in_text' }); return; }
    const text = cleanStr(w.text, CONTINUITY_TEXT_MAX);
    if (!text) { dropped.push({ part: 'warning', index, reason: 'bad_field' }); return; }
    warnings.push({ severity: w.severity, about: CONTINUITY_ABOUT.includes(w.about) ? w.about : 'other', text });
  });
  const items = (v.suggestions ?? []).slice(0, CONTINUITY_SUGGESTIONS_MAX);
  (v.suggestions ?? []).slice(CONTINUITY_SUGGESTIONS_MAX).forEach((x, i) => dropped.push({ part: 'suggestion', index: CONTINUITY_SUGGESTIONS_MAX + i, reason: 'too_many' }));
  const r = validatePromptOutput(JSON.stringify({ actions: items.map(x => (isObj(x) ? { action: x.action, why: x.why } : x)) }), catalogue, vocab);
  if (r.invalid) return { invalid: r.invalid };
  for (const d of r.dropped) dropped.push({ part: 'suggestion', index: d.index, kind: d.kind, reason: d.reason });
  const suggestions = [];
  for (const d of r.drafts) {
    if (!allowed(d.action)) { dropped.push({ part: 'suggestion', index: d.index, kind: d.action.kind, reason: 'not_allowed' }); continue; }
    suggestions.push(d);
  }
  return { warnings, suggestions, dropped };
}
