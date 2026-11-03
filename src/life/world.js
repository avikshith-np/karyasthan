import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { getDb } from '../memory/db.js';

// The per-install world seed (spec 009 plan §R7): places with coordinates, the
// fictional cast, his birthdate and job, routine, travel constants, climate and
// money. Gitignored like taste.json (src/personality/world.json), generated once
// from the identity by one LLM call, falling back to the committed neutral
// world.example.json. The file is only read at genesis and for constants
// (travel/routine/climate) — later changes to his life are world events.
//
// Everything in it is LLM output or an owner edit, so it is untrusted: strict
// schema, size caps, ids by regex, and every string through sanitizeWebContent
// + a length cap before it can reach a prompt. Invalid → example, never a crash.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../personality');
export const WORLD_PATH = path.join(DIR, 'world.json');
export const EXAMPLE_PATH = path.join(DIR, 'world.example.json');

export const WORLD_MAX_BYTES = 64 * 1024;
const MAX_PLACES = 48;
const MAX_CAST = 16;
const MAX_HISTORY = 8;
const MAX_LEISURE = 20;
const MAX_MODES = 8;
const MAX_PEAK_WINDOWS = 8;
const MAX_VITAL_KEYS = 40;

const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;
const CAST_ID_RE = /^cast:[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MODE_RE = /^[a-z][a-z-]{1,15}$/;
const RELATION_RE = /^(?:flatmate|coworker|manager|family:[a-z][a-z-]{0,23})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const VITAL_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const fail = (where, msg) => { throw new Error(`world: ${where} ${msg}`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Field validators ──────────────────────────────────────────────────────

function obj(v, where, { required = true } = {}) {
  if (v === undefined || v === null) return required ? fail(where, 'is required') : {};
  if (!isObj(v)) fail(where, 'must be an object');
  return v;
}

// One-line prompt-safe string: markers/@mentions/control chars stripped by
// sanitizeWebContent, whitespace collapsed, ">>>" (the prompt's trigger marker)
// removed, then capped.
function str(v, where, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') return required ? fail(where, 'is required') : '';
  if (typeof v !== 'string') fail(where, 'must be a string');
  const out = sanitizeWebContent(v).replace(/>{3,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  if (required && !out) fail(where, 'is empty after sanitizing');
  return out;
}

function num(v, where, min, max, def) {
  if (v === undefined || v === null) return def !== undefined ? def : fail(where, 'is required');
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, 'must be a number');
  if (v < min || v > max) fail(where, `must be within ${min}..${max}`);
  return v;
}

function int(v, where, min, max, def) {
  const n = num(v, where, min, max, def);
  if (!Number.isInteger(n)) fail(where, 'must be an integer');
  return n;
}

function idOf(v, where, re) {
  if (typeof v !== 'string' || !re.test(v)) fail(where, `must match ${re}`);
  return v;
}

function isoDate(v, where, { required = true } = {}) {
  if (v === undefined || v === null || v === '') return required ? fail(where, 'is required') : null;
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) fail(where, 'must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900) fail(where, 'is not a real date');
  return v;
}

function hhmm(v, where, def) {
  if ((v === undefined || v === null) && def !== undefined) return def;
  if (typeof v !== 'string' || !HHMM_RE.test(v)) fail(where, 'must be HH:MM (24h)');
  return v;
}

function days(v, where, def) {
  if (v === undefined || v === null) return [...def];
  if (!Array.isArray(v)) fail(where, 'must be a list of weekdays (0 = Sunday)');
  const out = v.map((d, i) => int(d, `${where}[${i}]`, 0, 6));
  if (new Set(out).size !== out.length) fail(where, 'has duplicate days');
  return out;
}

function timezoneOf(v) {
  if (v === undefined || v === null || v === '') return config.timezone || 'UTC';
  if (typeof v !== 'string' || v.length > 64) fail('timezone', 'must be an IANA zone name');
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { fail('timezone', `"${v}" is not a known zone`); }
  return v;
}

// ── Sections ──────────────────────────────────────────────────────────────

function validatePlaces(v) {
  if (!Array.isArray(v) || !v.length) fail('places', 'must be a non-empty list');
  if (v.length > MAX_PLACES) fail('places', `has more than ${MAX_PLACES} entries`);
  const seen = new Set();
  return v.map((p, i) => {
    const w = `places[${i}]`;
    obj(p, w);
    const id = idOf(p.id, `${w}.id`, PLACE_ID_RE);
    if (seen.has(id)) fail(`${w}.id`, `duplicates ${id}`);
    seen.add(id);
    const kind = p.kind === undefined ? 'place' : p.kind;
    if (typeof kind !== 'string' || !SLUG_RE.test(kind)) fail(`${w}.kind`, `must match ${SLUG_RE}`);
    return {
      id,
      name: str(p.name, `${w}.name`, 60, { required: true }),
      kind,
      lat: num(p.lat, `${w}.lat`, -90, 90),
      lon: num(p.lon, `${w}.lon`, -180, 180),
    };
  });
}

function placeRef(v, where, placeIds) {
  idOf(v, where, PLACE_ID_RE);
  if (!placeIds.has(v)) fail(where, `refers to unknown place ${v}`);
  return v;
}

function validateSelf(v, placeIds, nowUnix) {
  obj(v, 'self');
  const birthdate = isoDate(v.birthdate, 'self.birthdate');
  const age = ageAt(birthdate, nowUnix, 'UTC');
  if (age < 18 || age > 100) fail('self.birthdate', `gives an age of ${age} (18..100 allowed)`);
  if (v.relationship !== undefined && v.relationship !== 'single') fail('self.relationship', 'must be "single" (he starts single)');
  const job = obj(v.job, 'self.job');
  return {
    birthdate,
    homePlaceId: placeRef(v.homePlaceId, 'self.homePlaceId', placeIds),
    job: {
      title: str(job.title, 'self.job.title', 60, { required: true }),
      employerName: str(job.employerName, 'self.job.employerName', 80),
      officePlaceId: placeRef(job.officePlaceId, 'self.job.officePlaceId', placeIds),
    },
    relationship: 'single',
  };
}

function validateCast(v, placeIds) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('cast', 'must be a list');
  if (v.length > MAX_CAST) fail('cast', `has more than ${MAX_CAST} members`);
  const seen = new Set();
  return v.map((c, i) => {
    const w = `cast[${i}]`;
    obj(c, w);
    const id = idOf(c.id, `${w}.id`, CAST_ID_RE);
    if (seen.has(id)) fail(`${w}.id`, `duplicates ${id}`);
    seen.add(id);
    if (typeof c.relation !== 'string' || !RELATION_RE.test(c.relation)) {
      fail(`${w}.relation`, 'must be flatmate, coworker, manager or family:<role>');
    }
    let home = null;
    if (typeof c.home === 'string') home = placeRef(c.home, `${w}.home`, placeIds);
    else if (c.home !== undefined && c.home !== null) {
      obj(c.home, `${w}.home`);
      home = { lat: num(c.home.lat, `${w}.home.lat`, -90, 90), lon: num(c.home.lon, `${w}.home.lon`, -180, 180) };
    }
    const m = obj(c.metrics, `${w}.metrics`, { required: false });
    const metric = (k, def) => Math.min(1, Math.max(0, num(m[k], `${w}.metrics.${k}`, -1e6, 1e6, def)));
    const history = c.history === undefined || c.history === null ? [] : c.history;
    if (!Array.isArray(history)) fail(`${w}.history`, 'must be a list of strings');
    return {
      id,
      name: str(c.name, `${w}.name`, 60, { required: true }),
      relation: c.relation,
      birthday: isoDate(c.birthday, `${w}.birthday`, { required: false }),
      pronouns: str(c.pronouns, `${w}.pronouns`, 24),
      hometown: str(c.hometown, `${w}.hometown`, 60),
      home,
      job: str(c.job, `${w}.job`, 60),
      employer: str(c.employer, `${w}.employer`, 80),
      personality: str(c.personality, `${w}.personality`, 200),
      speech: str(c.speech, `${w}.speech`, 160),
      availability: str(c.availability, `${w}.availability`, 160),
      status: str(c.status, `${w}.status`, 160),
      metrics: { closeness: metric('closeness', 0.5), trust: metric('trust', 0.5), tension: metric('tension', 0) },
      history: history.slice(0, MAX_HISTORY).map((h, j) => str(h, `${w}.history[${j}]`, 160)).filter(Boolean),
    };
  });
}

// Known R4 keys only (unknown keys are dropped); defaults are generic, not a persona.
function validateRoutine(v, placeIds) {
  const r = obj(v, 'routine', { required: false });
  const officeDays = days(r.officeDays, 'routine.officeDays', [2, 3, 4]);
  const wfhDays = days(r.wfhDays, 'routine.wfhDays', [1, 5]);
  const weekend = days(r.weekend, 'routine.weekend', [0, 6]);
  const all = [...officeDays, ...wfhDays, ...weekend];
  if (new Set(all).size !== all.length) fail('routine', 'officeDays, wfhDays and weekend overlap');
  if (all.length !== 7) fail('routine', 'officeDays, wfhDays and weekend must cover every weekday');

  const lunch = obj(r.lunch, 'routine.lunch', { required: false });
  const meetings = obj(r.meetings, 'routine.meetings', { required: false });
  let count = [1, 3];
  if (meetings.count !== undefined) {
    if (!Array.isArray(meetings.count) || meetings.count.length !== 2) fail('routine.meetings.count', 'must be [min, max]');
    count = meetings.count.map((n, i) => int(n, `routine.meetings.count[${i}]`, 0, 10));
    if (count[0] > count[1]) fail('routine.meetings.count', 'min is above max');
  }
  const typicalTimes = meetings.typicalTimes ?? [];
  if (!Array.isArray(typicalTimes) || typicalTimes.length > 12) fail('routine.meetings.typicalTimes', 'must be a list of ≤ 12 times');

  const leisure = r.leisure ?? [];
  if (!Array.isArray(leisure) || leisure.length > MAX_LEISURE) fail('routine.leisure', `must be a list of ≤ ${MAX_LEISURE}`);

  return {
    officeDays, wfhDays, weekend,
    baseWake: hhmm(r.baseWake, 'routine.baseWake', '07:30'),
    weekendWake: hhmm(r.weekendWake, 'routine.weekendWake', '09:00'),
    baseSleep: hhmm(r.baseSleep, 'routine.baseSleep', '23:30'),
    sleepNeedHours: num(r.sleepNeedHours, 'routine.sleepNeedHours', 4, 12, 8),
    workStart: hhmm(r.workStart, 'routine.workStart', '09:30'),
    workEnd: hhmm(r.workEnd, 'routine.workEnd', '18:00'),
    prepMinutes: int(r.prepMinutes, 'routine.prepMinutes', 0, 120, 20),
    breakfast: hhmm(r.breakfast, 'routine.breakfast', '08:00'),
    lunch: { start: hhmm(lunch.start, 'routine.lunch.start', '13:00'), minutes: int(lunch.minutes, 'routine.lunch.minutes', 10, 120, 45) },
    dinner: hhmm(r.dinner, 'routine.dinner', '20:30'),
    meetings: {
      count,
      typicalTimes: typicalTimes.map((t, i) => hhmm(t, `routine.meetings.typicalTimes[${i}]`)),
      minutes: int(meetings.minutes, 'routine.meetings.minutes', 5, 240, 45),
    },
    leisure: leisure.map((l, i) => {
      const w = `routine.leisure[${i}]`;
      obj(l, w);
      if (typeof l.kind !== 'string' || !SLUG_RE.test(l.kind)) fail(`${w}.kind`, `must match ${SLUG_RE}`);
      return {
        kind: l.kind,
        placeId: placeRef(l.placeId, `${w}.placeId`, placeIds),
        weight: num(l.weight, `${w}.weight`, 0.01, 100, 1),
        minutes: int(l.minutes, `${w}.minutes`, 5, 600, 60),
      };
    }),
  };
}

function modeMap(v, where, min, max, { required = false } = {}) {
  const m = obj(v, where, { required });
  const keys = Object.keys(m);
  if (keys.length > MAX_MODES) fail(where, `has more than ${MAX_MODES} modes`);
  const out = {};
  for (const k of keys) {
    if (!MODE_RE.test(k)) fail(where, `mode "${k}" must match ${MODE_RE}`);
    out[k] = num(m[k], `${where}.${k}`, min, max);
  }
  return out;
}

// travel.js relies on walk (short trips), cab (rain) and defaultMode.
function validateTravel(v) {
  const t = obj(v, 'travel');
  const speedsKmh = modeMap(t.speedsKmh, 'travel.speedsKmh', 0.5, 200, { required: true });
  const defaultMode = t.defaultMode;
  if (typeof defaultMode !== 'string' || !MODE_RE.test(defaultMode)) fail('travel.defaultMode', 'is required');
  for (const mode of ['walk', 'cab', defaultMode]) {
    if (!(mode in speedsKmh)) fail('travel.speedsKmh', `needs a speed for "${mode}"`);
  }
  const overheadMin = modeMap(t.overheadMin, 'travel.overheadMin', 0, 120);
  const costPerKm = modeMap(t.costPerKm, 'travel.costPerKm', 0, 1e6);
  for (const mode of Object.keys(speedsKmh)) {
    overheadMin[mode] ??= 0;
    costPerKm[mode] ??= 0;
  }
  const windows = t.peakWindows ?? [];
  if (!Array.isArray(windows) || windows.length > MAX_PEAK_WINDOWS) fail('travel.peakWindows', `must be a list of ≤ ${MAX_PEAK_WINDOWS}`);
  return {
    roadFactor: num(t.roadFactor, 'travel.roadFactor', 1, 3),
    speedsKmh,
    overheadMin,
    peakWindows: windows.map((p, i) => {
      const w = `travel.peakWindows[${i}]`;
      obj(p, w);
      if (p.from === undefined || p.to === undefined) fail(w, 'needs from and to');
      return { from: hhmm(p.from, `${w}.from`), to: hhmm(p.to, `${w}.to`), factor: num(p.factor, `${w}.factor`, 1, 4) };
    }),
    weekendFactor: num(t.weekendFactor, 'travel.weekendFactor', 0.5, 3, 1),
    walkMaxKm: num(t.walkMaxKm, 'travel.walkMaxKm', 0, 5),
    defaultMode,
    costPerKm,
  };
}

function validateClimate(v) {
  const c = obj(v, 'climate');
  const out = {};
  for (let month = 1; month <= 12; month++) {
    const w = `climate.${month}`;
    const m = obj(c[String(month)], w);
    const pair = (p, name, lo, hi, isInt) => {
      if (!Array.isArray(p) || p.length !== 2) fail(`${w}.${name}`, 'must be [from, to]');
      const vals = p.map((x, i) => (isInt ? int : num)(x, `${w}.${name}[${i}]`, lo, hi));
      if (vals[0] > vals[1]) fail(`${w}.${name}`, 'from is above to');
      return vals;
    };
    out[month] = {
      rainProb: num(m.rainProb, `${w}.rainProb`, 0, 1),
      rainyHours: pair(m.rainyHours, 'rainyHours', 0, 24, true),
      tempRange: pair(m.tempRange, 'tempRange', -40, 60, false),
    };
  }
  return out;
}

function validateMoney(v) {
  const m = obj(v, 'money');
  return {
    payday: int(m.payday, 'money.payday', 1, 31),
    salary: num(m.salary, 'money.salary', 0, 1e9),
    monthlyBaseline: num(m.monthlyBaseline, 'money.monthlyBaseline', 0, 1e9),
    // 018: optional exact amounts for the wallet's recurring spends (else shares of the baseline).
    ...Object.fromEntries(['rent', 'bills', 'groceriesWeekly'].filter(k => m[k] !== undefined && m[k] !== null)
      .map(k => [k, num(m[k], `money.${k}`, 0, 1e9)])),
  };
}

// Optional numeric overrides of the §R3 vitals defaults: numbers, or one level of
// { key: number } objects. Interpretation belongs to vitals.js.
function validateVitals(v) {
  if (v === undefined || v === null) return null;
  obj(v, 'vitals');
  let n = 0;
  const walk = (o, where, depth) => {
    const out = {};
    for (const k of Object.keys(o)) {
      if (!VITAL_KEY_RE.test(k)) fail(where, `key "${k}" must match ${VITAL_KEY_RE}`);
      if (++n > MAX_VITAL_KEYS) fail('vitals', `has more than ${MAX_VITAL_KEYS} keys`);
      const val = o[k];
      if (typeof val === 'number') out[k] = num(val, `${where}.${k}`, -1e6, 1e6);
      else if (depth === 0 && isObj(val)) out[k] = walk(val, `${where}.${k}`, 1);
      else fail(`${where}.${k}`, 'must be a number (or an object of numbers)');
    }
    return out;
  };
  return walk(v, 'vitals', 0);
}

// ── Real-name collisions ──────────────────────────────────────────────────

/**
 * Lowercase, accents folded, letters/digits only, single-spaced. Format
 * characters (zero-width space/joiners, soft hyphen, bidi marks) are dropped
 * first, so one inside a name cannot split it into two harmless tokens.
 */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Cast ids whose name matches a real person's: the same full name, or the same
 * first name (≥ 3 letters) — first names are what people use in chat.
 */
export function castNameCollisions(cast, knownNames) {
  const full = new Set();
  const first = new Set();
  for (const n of knownNames || []) {
    const norm = normalizeName(n);
    if (!norm) continue;
    full.add(norm);
    const f = norm.split(' ')[0];
    if (f.length >= 3) first.add(f);
  }
  return (cast || []).filter((c) => {
    const norm = normalizeName(c.name);
    const f = norm.split(' ')[0];
    return full.has(norm) || (f.length >= 3 && first.has(f));
  }).map((c) => c.id);
}

// Free text that reaches prompts (cast cards, history, place names). A real
// name can slip in here too ("status: dating <name>"), so it is checked as
// well: a known full name anywhere, or a known first name written as a proper
// noun (a capitalized word — lowercase prose like "joy" or "grace" is fine).
const CAST_TEXT_FIELDS = ['personality', 'speech', 'availability', 'status', 'job', 'employer', 'hometown'];

/**
 * Where a real person's name appears in the world's free text: cast fields
 * (personality, status, history, …), place names and his own employer. Returns
 * the paths ('cast[1].status', 'places[3].name', …), [] when clean.
 */
export function textNameCollisions(world, knownNames) {
  const full = new Set();
  const first = new Set();
  for (const n of knownNames || []) {
    const norm = normalizeName(n);
    if (!norm) continue;
    if (norm.includes(' ')) full.add(norm);
    const f = norm.split(' ')[0];
    if (f.length >= 3) first.add(f);
  }
  if (!full.size && !first.size) return [];
  const hits = (text) => {
    if (typeof text !== 'string' || !text.trim()) return false;
    const norm = ` ${normalizeName(text)} `;
    for (const f of full) if (norm.includes(` ${f} `)) return true;
    for (const m of text.replace(/\p{Cf}/gu, '').matchAll(/[\p{L}\p{N}]+/gu)) {
      const w = m[0];
      if (/^\p{Lu}/u.test(w) && first.has(normalizeName(w))) return true;
    }
    return false;
  };
  const out = [];
  (world?.cast || []).forEach((c, i) => {
    for (const k of CAST_TEXT_FIELDS) if (hits(c[k])) out.push(`cast[${i}].${k}`);
    (c.history || []).forEach((h, j) => { if (hits(h)) out.push(`cast[${i}].history[${j}]`); });
  });
  (world?.places || []).forEach((p, i) => { if (hits(p.name)) out.push(`places[${i}].name`); });
  if (hits(world?.self?.job?.employerName)) out.push('self.job.employerName');
  return out;
}

/** push_name / real_name of every known person (the cast must not reuse them). */
export function realPeopleNames(db = getDb()) {
  const rows = db.prepare(
    'SELECT push_name, real_name FROM people WHERE push_name IS NOT NULL OR real_name IS NOT NULL',
  ).all();
  return rows.flatMap((r) => [r.push_name, r.real_name]).filter((s) => typeof s === 'string' && s.trim());
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validate and normalize a parsed world file. Throws on anything malformed;
 * returns a fresh object holding only known keys (strings sanitized and capped).
 * `knownNames` (real people's names) are checked against the cast; `now` (unix
 * seconds) only bounds his age.
 */
export function validateWorld(raw, { knownNames = [], now = Math.floor(Date.now() / 1000) } = {}) {
  if (!isObj(raw)) fail('file', 'must be a JSON object');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(raw), 'utf-8'); } catch { fail('file', 'is not serializable'); }
  if (size > WORLD_MAX_BYTES) fail('file', `is ${size} bytes (max ${WORLD_MAX_BYTES})`);

  const places = validatePlaces(raw.places);
  const placeIds = new Set(places.map((p) => p.id));
  const world = {
    version: int(raw.version, 'version', 1, 1000, 1),
    timezone: timezoneOf(raw.timezone),
    self: validateSelf(raw.self, placeIds, now),
    places,
    cast: validateCast(raw.cast, placeIds),
    routine: validateRoutine(raw.routine, placeIds),
    travel: validateTravel(raw.travel),
    climate: validateClimate(raw.climate),
    money: validateMoney(raw.money),
  };
  const vitals = validateVitals(raw.vitals);
  if (vitals) world.vitals = vitals;

  const clashes = castNameCollisions(world.cast, knownNames);
  if (clashes.length) fail('cast', `uses a real person's name (${clashes.join(', ')})`);
  const mentions = textNameCollisions(world, knownNames);
  if (mentions.length) fail(mentions[0].split('.')[0].replace(/\[\d+\]$/, ''), `mentions a real person's name (${mentions.join(', ')})`);
  return world;
}

/** Short content hash of a normalized world (genesis payload `worldHash`). */
export function worldHash(world) {
  const { source, hash, ...rest } = world;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

// ── Age ───────────────────────────────────────────────────────────────────

/** Whole years between `birthdate` (YYYY-MM-DD) and unix `at`, on the calendar of `timezone`. */
export function ageAt(birthdate, at = Math.floor(Date.now() / 1000), timezone = config.timezone || 'UTC') {
  const [by, bm, bd] = String(birthdate).split('-').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(at * 1000));
  const [y, m, d] = today.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Same month/day, year moved so ageAt() is `age` at `at` (29 Feb → 28 Feb). */
export function alignBirthdate(birthdate, age, at, timezone) {
  const [, bm, bd] = String(birthdate).split('-').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(at * 1000));
  const [y, m, d] = today.split('-').map(Number);
  const hadBirthday = m > bm || (m === bm && d >= bd);
  const year = y - age - (hadBirthday ? 0 : 1);
  const day = bm === 2 && bd === 29 ? 28 : bd;
  return `${year}-${String(bm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Loading ───────────────────────────────────────────────────────────────

const cache = new Map(); // world path → loaded world

function readWorldFile(file, opts) {
  const buf = fs.readFileSync(file);
  if (buf.length > WORLD_MAX_BYTES) fail('file', `is ${buf.length} bytes (max ${WORLD_MAX_BYTES})`);
  return validateWorld(JSON.parse(buf.toString('utf-8')), opts);
}

/**
 * The world: world.json if present and valid, else the committed example.
 * Returns { ...world, source: 'world.json'|'example', hash } (cached per path).
 * Real names come from the `people` table unless `knownNames` is passed; the
 * example (generic labels) skips that check. Throws only if the committed
 * example itself is broken.
 */
export function loadWorld({ path: file = WORLD_PATH, examplePath = EXAMPLE_PATH, knownNames, now, force = false } = {}) {
  if (!force && cache.has(file)) return cache.get(file);
  let world = null;
  let source = 'world.json';
  if (fs.existsSync(file)) {
    try {
      // A failed people lookup also rejects the file: the name check fails closed.
      world = readWorldFile(file, { knownNames: knownNames ?? realPeopleNames(), now });
    } catch (err) {
      logger.warn({ err: err.message, file }, 'world.json unusable, using the example world');
    }
  }
  if (!world) {
    world = readWorldFile(examplePath, { now });
    source = 'example';
  }
  const loaded = { ...world, source };
  loaded.hash = worldHash(loaded);
  cache.set(file, loaded);
  return loaded;
}

/** Cached loadWorld() for the default path. */
export function getWorld() {
  return loadWorld();
}

export function resetWorldCache() {
  cache.clear();
}

// ── Seeding ───────────────────────────────────────────────────────────────

const GEN_PROMPT = `You create the private, fictional everyday world of a character, for a life simulation. Return ONLY one JSON object, no prose, in exactly this shape:
{"version":1,"timezone":"IANA zone of the region",
"self":{"birthdate":"YYYY-MM-DD","homePlaceId":"place:home","job":{"title":"","employerName":"fictional company","officePlaceId":"place:office"},"relationship":"single"},
"places":[{"id":"place:<slug>","name":"short label","kind":"home|office|cafe|gym|shop|park|restaurant|cinema|...","lat":0,"lon":0}],
"cast":[{"id":"cast:<slug>","name":"","birthday":"YYYY-MM-DD","pronouns":"","hometown":"","home":"place:<id>" or {"lat":0,"lon":0},"job":"","employer":"","personality":"","speech":"how they text","availability":"","status":"one line","relation":"flatmate|coworker|manager|family:<role>","metrics":{"closeness":0-1,"trust":0-1,"tension":0-1},"history":["short shared memories"]}],
"routine":{"officeDays":[2,3,4],"wfhDays":[1,5],"weekend":[0,6],"baseWake":"HH:MM","weekendWake":"HH:MM","baseSleep":"HH:MM","sleepNeedHours":8,"workStart":"HH:MM","workEnd":"HH:MM","prepMinutes":20,"breakfast":"HH:MM","lunch":{"start":"HH:MM","minutes":45},"dinner":"HH:MM","meetings":{"count":[1,3],"typicalTimes":["HH:MM"],"minutes":45},"leisure":[{"kind":"<slug>","placeId":"place:<id>","weight":1,"minutes":60}]},
"travel":{"roadFactor":1.2-1.6,"speedsKmh":{"walk":4.5,"cab":0,"<usual mode>":0},"overheadMin":{"walk":0,"cab":0},"peakWindows":[{"from":"HH:MM","to":"HH:MM","factor":1.0-2.5}],"weekendFactor":1.0,"walkMaxKm":1.2,"defaultMode":"<usual mode>","costPerKm":{"walk":0,"cab":0}},
"climate":{"1":{"rainProb":0-1,"rainyHours":[from,to],"tempRange":[min,max]}, ... every month "1" to "12"},
"money":{"payday":1-28,"salary":0,"monthlyBaseline":0}}
Rules:
- Everyone in the cast is fictional: invent ordinary names that fit the region; never a real or famous person. One flatmate, 2-4 coworkers (one is the manager), 2-3 family members. Weekdays use 0 = Sunday.
- He is an adult, 18 or older. He works a hybrid job: office Tuesday to Thursday, from home Monday and Friday, weekends free. He is single.
- Places: 8-12 everyday places (home, office, a cafe, a gym, shops, a park, somewhere to eat out, the family home) with plausible coordinates in the character's stated region, at neighbourhood level only: never a street address or anyone's real residence. Labels stay generic ("Office", "Corner cafe").
- Travel, peak hours, climate (realistic monthly rain and temperature) and money (local currency) should match that region.
- Keep it broad and varied: do not fixate on one hobby, food, job detail or place even if the description mentions it a lot.`;

/**
 * Make sure a world file exists. Present → loadWorld(). Absent → one LLM call
 * (persona + identity), validated, birthdate aligned to the persona's age,
 * written 0644; any failure logs and returns the example world (source
 * 'example'), never throws. `llm`, `persona`, `identityText`, `knownNames`,
 * `now` and the paths are test seams; by default callLlm (role 'mind', caller
 * 'life.world') and getIdentityText are imported lazily so plain loads don't pull in the prompt/LLM stack.
 */
export async function ensureWorldSeed({
  path: file = WORLD_PATH, examplePath = EXAMPLE_PATH, llm, persona, identityText, knownNames,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (fs.existsSync(file)) return loadWorld({ path: file, examplePath, knownNames, now });
  try {
    const p = persona || getPersona();
    const identity = identityText ?? (await import('../personality/systemPrompt.js')).getIdentityText();
    const call = llm || (await import('../brain/llm.js')).callLlm;
    const zone = config.timezone || 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(now * 1000));
    const age = Number.isInteger(p.age) ? p.age : null;
    const birthYear = age !== null ? Number(today.slice(0, 4)) - age : null;
    const user = [
      `Persona: ${JSON.stringify({ name: p.name, age: p.age, region: p.region, language: p.language, vibe: p.vibe })}`,
      `Today is ${today}.${birthYear ? ` His birthdate must make him ${age} today (born ${birthYear - 1} or ${birthYear}).` : ''}`,
      `Character description:\n${String(identity || '').slice(0, 12_000)}`,
    ].join('\n\n');

    // The 'mind' role (spec 007): its chain carries the role fallback, and over
    // budget / routing cleared it returns null → the example world below.
    const raw = await call(GEN_PROMPT, user, { role: 'mind', caller: 'life.world', temperature: 0.5, maxTokens: 8192, timeoutMs: 120_000 });
    if (typeof raw !== 'string' || raw.length > WORLD_MAX_BYTES * 3) throw new Error('LLM returned no usable world');
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('LLM returned no JSON world');
    const world = validateWorld(JSON.parse(json), { knownNames: knownNames ?? realPeopleNames(), now });
    if (age !== null) world.self.birthdate = alignBirthdate(world.self.birthdate, age, now, world.timezone);

    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(world, null, 2)}\n`, { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o644);
    logger.info({ places: world.places.length, cast: world.cast.length }, 'world seed generated from identity');
    return loadWorld({ path: file, examplePath, knownNames, now, force: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'world seed failed, using the example world');
    try { fs.unlinkSync(`${file}.tmp-${process.pid}`); } catch { /* none */ }
    return loadWorld({ path: file, examplePath, knownNames, now, force: true });
  }
}
