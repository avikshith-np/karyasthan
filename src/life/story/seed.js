// The per-install arc seed (spec 010, research R19, data-model.md §4):
// src/personality/arcs.json (gitignored), generated ONCE by the mind role from
// the persona, identity and a world summary, falling back to the committed
// neutral arcs.example.json. It holds career constants, family pressure themes,
// cast status pools, heavy themes and romance hints. The file is never written
// after generation except by the owner's regenerate (1/hour); owner tweaks are
// `director.seed_set` events overlaid by effectiveSeed(state).
//
// Everything in it is model output, so it is untrusted: a size cap, strict
// per-section validation (a bad section → null + listed in `missing`, the other
// sections still load), enums, caps, sanitized strings, forbidden heavy themes
// refused (heavy.themeAllowed), and real people's names refused in employers and
// labels (world.js textNameCollisions).
//
// Generation gate (research R19, plan review A11): story_state.seed =
// {source:'pending', attemptedAt} is written BEFORE the call (store.beginSeedAttempt),
// and any existing record refuses an automatic call — boots and restarts never
// retry. The call also needs the `life.arcs.` caller month-to-date under
// ARCS_MIND_BUDGET_USD and mindBudgetOk('sleep').ok (008's gate, injected: the
// story layer may not import src/mind/ modules; absent → fail closed). A failed
// gate or call leaves the example in force with source 'example' and a reason.
// Logs carry codes and counts only.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config, getPersona } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getWorld, realPeopleNames, textNameCollisions, normalizeName } from '../world.js';
import { dateKey, zonedToUnix, now as clockNow } from '../clock.js';
import { SEED_PATHS, cleanSeedValue } from './reducer.js';
import { themeAllowed, HEAVY_KINDS, DEFERRED_KINDS } from './heavy.js';
import * as storeDefault from './store.js';
import { parseJsonObject, MAX_BYTES } from './schema.js';
import { SEED_PROMPT, cleanItem } from './charter.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../personality');
export const ARCS_PATH = path.join(DIR, 'arcs.json');
export const EXAMPLE_ARCS_PATH = path.join(DIR, 'arcs.example.json');
export const ARCS_MAX_BYTES = 32 * 1024;
export const SEED_CALLER = 'life.arcs.seed';
export const REGENERATE_GAP_SEC = 3600;
export const SECTIONS = Object.freeze(['career', 'family', 'castStatus', 'heavy', 'romance']);
export const STATUS_RELATIONS = Object.freeze(['flatmate', 'coworker', 'manager', 'family', 'friend', 'any']);
export const MEET_VIA = Object.freeze(['flatmate', 'coworker', 'friend', 'hobby']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const numIn = (v, lo, hi) => (fin(v) && v >= lo && v <= hi ? v : undefined);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PLACE_ID_RE = /^place:[a-z0-9][a-z0-9-]{0,39}$/;

// ── test seams ───────────────────────────────────────────────────────────────

let deps = {};
let seedOverride; // undefined → load from disk; null → no seed; object → that seed

/** Test seam: { now, callRole, mindBudgetOk, getUsageByCaller, store, persona, identityText, knownNames, world } | null */
export function __setDepsForTest(d) {
  deps = d && typeof d === 'object' ? { ...d } : {};
}

/** Test seam (scripts/arcs-tests/_helpers.js bootLife): the seed getArcSeed() returns; null → no seed, undefined → disk. */
export function __setSeedForTest(seed) {
  // Kept as given (the test owns its fixture); validation is tested on its own.
  seedOverride = seed === undefined ? undefined : seed === null ? null : { ...structuredClone(seed), source: 'test' };
}

const nowSec = () => Math.floor((deps.now ?? clockNow)());
const store = () => deps.store ?? storeDefault;

// ── validation ───────────────────────────────────────────────────────────────

function str(v, max) {
  if (typeof v !== 'string') return null;
  const s = cleanItem(v, max);
  return s || null;
}

function slug(v) {
  return typeof v === 'string' && SLUG_RE.test(v) ? v : null;
}

function strList(v, max, cap, path, dropped) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((x, i) => {
    if (out.length >= max) { dropped.push({ path: `${path}[${i}]`, reason: 'too_many' }); return; }
    const s = str(x, cap);
    if (s) out.push(s);
    else dropped.push({ path: `${path}[${i}]`, reason: 'bad_string' });
  });
  return [...new Set(out)];
}

/** True when `text` names a real person (full name, or a capitalized first name). */
function namesReal(text, knownNames) {
  return !!text && textNameCollisions({ places: [{ name: text }] }, knownNames).length > 0;
}

function placeIdsOf(world) {
  const list = world?.places instanceof Map ? [...world.places.keys()] : (Array.isArray(world?.places) ? world.places.map(p => p?.id) : []);
  return new Set(list.filter(id => typeof id === 'string'));
}

function validateCareer(c, ctx, dropped) {
  if (!isObj(c)) return null;
  const pct = isObj(c.salaryChangePct) ? c.salaryChangePct : {};
  const clamp = (v, lo, hi, d) => (fin(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : d);
  const out = {
    appraisalMonth: intIn(c.appraisalMonth, 1, 12) ?? null,
    salaryChangePct: { min: clamp(pct.min, -5, 0, -2), max: clamp(pct.max, 0, 20, 8) },
    noticeDays: intIn(c.noticeDays, 0, 120) ?? 30,
    employers: [],
    titles: [],
    officeAreas: [],
  };
  if (c.appraisalMonth !== null && c.appraisalMonth !== undefined && out.appraisalMonth === null) {
    dropped.push({ path: 'career.appraisalMonth', reason: 'out_of_range' });
  }
  (Array.isArray(c.employers) ? c.employers : []).forEach((e, i) => {
    const path = `career.employers[${i}]`;
    if (out.employers.length >= 8) { dropped.push({ path, reason: 'too_many' }); return; }
    const name = str(isObj(e) ? e.name : null, 80);
    if (!name) { dropped.push({ path, reason: 'bad_string' }); return; }
    if (namesReal(name, ctx.knownNames)) { dropped.push({ path, reason: 'name_collision' }); return; }
    if (!out.employers.some(x => normalizeName(x.name) === normalizeName(name))) out.employers.push({ name });
  });
  out.titles = strList(c.titles, 8, 60, 'career.titles', dropped).filter((t, i) => {
    if (!namesReal(t, ctx.knownNames)) return true;
    dropped.push({ path: `career.titles[${i}]`, reason: 'name_collision' });
    return false;
  });
  (Array.isArray(c.officeAreas) ? c.officeAreas : []).forEach((a, i) => {
    const path = `career.officeAreas[${i}]`;
    if (out.officeAreas.length >= 4) { dropped.push({ path, reason: 'too_many' }); return; }
    const near = isObj(a) && typeof a.near === 'string' && PLACE_ID_RE.test(a.near) ? a.near : null;
    const maxKm = isObj(a) ? numIn(a.maxKm, 0.5, 15) : undefined;
    if (!near || maxKm === undefined) { dropped.push({ path, reason: 'bad_shape' }); return; }
    if (!ctx.placeIds.has(near)) { dropped.push({ path, reason: 'unknown_place' }); return; }
    out.officeAreas.push({ near, maxKm });
  });
  return out;
}

function validateFamily(f, ctx, dropped) {
  if (!isObj(f)) return null;
  const cad = f.callCadenceDays;
  if (!(Array.isArray(cad) && cad.length === 2 && intIn(cad[0], 1, 30) !== undefined && intIn(cad[1], 1, 60) !== undefined
    && cad[0] <= cad[1])) {
    dropped.push({ path: 'family.callCadenceDays', reason: 'bad_shape' });
    return null;
  }
  const label = (v, path) => {
    const s = str(v, 80);
    if (!s) { dropped.push({ path, reason: 'bad_string' }); return null; }
    if (namesReal(s, ctx.knownNames) || hasIdent(s)) { dropped.push({ path, reason: 'name_collision' }); return null; }
    return s;
  };
  const themes = [];
  (Array.isArray(f.themes) ? f.themes : []).forEach((t, i) => {
    const path = `family.themes[${i}]`;
    if (themes.length >= 6) { dropped.push({ path, reason: 'too_many' }); return; }
    if (!isObj(t)) { dropped.push({ path, reason: 'bad_shape' }); return; }
    const id = slug(t.id);
    const l = label(t.label, `${path}.label`);
    const fromAge = intIn(t.fromAge, 16, 80);
    const intensity = numIn(t.intensity, 0, 1);
    const growthPerYear = numIn(t.growthPerYear, 0, 0.2);
    if (!id || !l || fromAge === undefined || intensity === undefined || growthPerYear === undefined || themes.some(x => x.id === id)) {
      if (l) dropped.push({ path, reason: 'bad_shape' });
      return;
    }
    themes.push({ id, label: l, fromAge, intensity, growthPerYear });
  });
  const occasions = [];
  (Array.isArray(f.occasions) ? f.occasions : []).forEach((o, i) => {
    const path = `family.occasions[${i}]`;
    if (occasions.length >= 8) { dropped.push({ path, reason: 'too_many' }); return; }
    if (!isObj(o)) { dropped.push({ path, reason: 'bad_shape' }); return; }
    const id = slug(o.id);
    const l = label(o.label, `${path}.label`);
    const month = intIn(o.month, 1, 12);
    const day = o.day === null || o.day === undefined ? null : intIn(o.day, 1, 31);
    if (!id || !l || month === undefined || day === undefined || typeof o.major !== 'boolean' || occasions.some(x => x.id === id)) {
      if (l) dropped.push({ path, reason: 'bad_shape' });
      return;
    }
    occasions.push({ id, label: l, month, day, major: o.major });
  });
  const majorDecisions = [];
  (Array.isArray(f.majorDecisions) ? f.majorDecisions : []).forEach((m, i) => {
    const path = `family.majorDecisions[${i}]`;
    if (majorDecisions.length >= 4) { dropped.push({ path, reason: 'too_many' }); return; }
    if (!isObj(m)) { dropped.push({ path, reason: 'bad_shape' }); return; }
    const id = slug(m.id);
    const l = label(m.label, `${path}.label`);
    const fromAge = intIn(m.fromAge, 16, 80);
    const themeId = slug(m.themeId);
    const options = [];
    (Array.isArray(m.options) ? m.options : []).forEach((o, j) => {
      if (options.length >= 4) return;
      const oid = isObj(o) ? slug(o.id) : null;
      const ol = isObj(o) ? str(o.label, 60) : null;
      if (oid && ol && !namesReal(ol, ctx.knownNames) && !options.some(x => x.id === oid)) options.push({ id: oid, label: ol });
      else dropped.push({ path: `${path}.options[${j}]`, reason: 'bad_shape' });
    });
    if (!id || !l || fromAge === undefined || !themeId || !themes.some(t => t.id === themeId) || options.length < 2
      || majorDecisions.some(x => x.id === id)) {
      if (l) dropped.push({ path, reason: 'bad_shape' });
      return;
    }
    majorDecisions.push({ id, label: l, themeId, fromAge, options });
  });
  return { callCadenceDays: [cad[0], cad[1]], themes, occasions, majorDecisions };
}

function validateCastStatus(c, ctx, dropped) {
  if (!isObj(c)) return null;
  const out = {};
  for (const rel of STATUS_RELATIONS) {
    out[rel] = strList(c[rel], 10, 120, `castStatus.${rel}`, dropped).filter((s, i) => {
      if (!namesReal(s, ctx.knownNames) && !hasIdent(s)) return true;
      dropped.push({ path: `castStatus.${rel}[${i}]`, reason: 'name_collision' });
      return false;
    });
  }
  for (const k of Object.keys(c)) if (!STATUS_RELATIONS.includes(k)) dropped.push({ path: `castStatus.${k}`, reason: 'unknown_key' });
  return out;
}

function validateHeavy(h, ctx, dropped, missing) {
  if (!isObj(h)) return null;
  const themes = [];
  (Array.isArray(h.themes) ? h.themes : []).forEach((t, i) => {
    const path = `heavy.themes[${i}]`;
    if (themes.length >= 6) { dropped.push({ path, reason: 'too_many' }); return; }
    const kind = isObj(t) && typeof t.kind === 'string' ? t.kind.trim().toLowerCase() : '';
    if (DEFERRED_KINDS.includes(kind)) {
      dropped.push({ path, reason: 'deferred_kind' });
      if (!missing.includes(`heavy.${kind}`)) missing.push(`heavy.${kind}`);
      return;
    }
    const v = themeAllowed(isObj(t) ? { ...t, durationDays: t.durationDays ?? [2, 7] } : t, ctx.knownNames);
    if (!v.ok || !v.theme.id) { dropped.push({ path, reason: v.ok ? 'bad_shape' : v.reason }); return; }
    if (themes.some(x => x.id === v.theme.id)) { dropped.push({ path, reason: 'duplicate' }); return; }
    themes.push(v.theme);
  });
  return { themes };
}

function validateRomance(r, ctx, dropped) {
  if (!isObj(r)) return null;
  const via = (Array.isArray(r.meetVia) ? r.meetVia : []).filter((v, i) => {
    if (MEET_VIA.includes(v)) return true;
    dropped.push({ path: `romance.meetVia[${i}]`, reason: 'bad_enum' });
    return false;
  });
  return { meetVia: [...new Set(via)].slice(0, 4) };
}

const IDENT_RE = /\d{7,}|@(?:s\.whatsapp\.net|lid|g\.us|c\.us)\b/i;
function hasIdent(s) {
  return typeof s === 'string' && IDENT_RE.test(s);
}

/**
 * Validate a parsed arc seed (data-model §4). Never throws. Each section fails on
 * its own: an unusable section → null and its name in `missing` (also
 * 'heavy.job_loss' for a deferred kind that was dropped). Unknown keys dropped.
 *   opts = { knownNames (real people's names), world (places for officeAreas) }
 * → { ok, seed:{version, career, family, castStatus, heavy, romance}, missing, dropped, error? }
 *   ok:false (seed with every section null) for a non-object or an oversized file.
 */
export function validateArcSeed(raw, { knownNames = [], world = null } = {}) {
  const dropped = [];
  const missing = [];
  const empty = Object.fromEntries([['version', 1], ...SECTIONS.map(s => [s, null])]);
  if (!isObj(raw)) return { ok: false, error: 'not_an_object', seed: empty, missing: [...SECTIONS], dropped };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(raw), 'utf8'); } catch { return { ok: false, error: 'not_serializable', seed: empty, missing: [...SECTIONS], dropped }; }
  if (size > ARCS_MAX_BYTES) return { ok: false, error: 'oversize', seed: empty, missing: [...SECTIONS], dropped };
  for (const k of Object.keys(raw)) if (k !== 'version' && !SECTIONS.includes(k)) dropped.push({ path: k, reason: 'unknown_key' });
  const ctx = { knownNames: Array.isArray(knownNames) ? knownNames : [], placeIds: placeIdsOf(world) };
  const seed = {
    version: 1,
    career: validateCareer(raw.career, ctx, dropped),
    family: validateFamily(raw.family, ctx, dropped),
    castStatus: validateCastStatus(raw.castStatus, ctx, dropped),
    heavy: validateHeavy(raw.heavy, ctx, dropped, missing),
    romance: validateRomance(raw.romance, ctx, dropped),
  };
  for (const s of SECTIONS) if (seed[s] === null) missing.unshift(s);
  if (seed.career && seed.career.appraisalMonth === null && !missing.includes('career.appraisalMonth')) missing.push('career.appraisalMonth');
  return { ok: true, seed, missing: [...new Set(missing)], dropped };
}

/** Short content hash of a validated seed. */
export function seedHash(seed) {
  const { source, hash, missing, ...rest } = seed || {};
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

// ── loading ──────────────────────────────────────────────────────────────────

const cache = new Map();

function readSeedFile(file, opts) {
  const buf = fs.readFileSync(file);
  if (buf.length > ARCS_MAX_BYTES) return { ok: false, error: 'oversize' };
  let raw;
  try { raw = JSON.parse(buf.toString('utf-8')); } catch { return { ok: false, error: 'bad_json' }; }
  return validateArcSeed(raw, opts);
}

function worldFor(opts) {
  if (opts.world !== undefined) return opts.world;
  if (deps.world !== undefined) return deps.world;
  try { return getWorld(); } catch { return null; }
}

/**
 * The arc seed: arcs.json if present and valid, else the committed example.
 * → { version, career, family, castStatus, heavy, romance, source:'arcs.json'|'example', missing, hash }
 * (cached per path; `force` reloads). Real names come from the people table unless
 * `knownNames` is passed; a failed people lookup rejects arcs.json (fail closed).
 * The example skips the names check (generic labels). Never throws.
 */
export function loadArcSeed({ path: file = ARCS_PATH, examplePath = EXAMPLE_ARCS_PATH, knownNames, world, force = false } = {}) {
  if (!force && cache.has(file)) return cache.get(file);
  const w = worldFor({ world });
  let res = null;
  let source = 'arcs.json';
  if (fs.existsSync(file)) {
    try {
      const names = knownNames ?? deps.knownNames ?? realPeopleNames();
      res = readSeedFile(file, { knownNames: names, world: w });
      if (!res.ok) { logger.warn({ evt: 'arcs_seed', reason: res.error }, 'arcs.json unusable, using the example seed'); res = null; }
    } catch (err) {
      logger.warn({ evt: 'arcs_seed', reason: 'read_failed', code: err?.code ?? null }, 'arcs.json unusable, using the example seed');
      res = null;
    }
  }
  if (!res) {
    source = 'example';
    try { res = readSeedFile(examplePath, { knownNames: [], world: w }); } catch { res = null; }
    if (!res?.ok) res = validateArcSeed({}, {});
  }
  const loaded = { ...res.seed, source, missing: res.missing };
  loaded.hash = seedHash(loaded);
  cache.set(file, loaded);
  return loaded;
}

export function resetSeedCache() {
  cache.clear();
}

/** The seed in force: the test override, else loadArcSeed() (cached). Never throws. */
export function getArcSeed() {
  if (seedOverride !== undefined) return seedOverride;
  try { return loadArcSeed(); } catch { return { ...validateArcSeed({}, {}).seed, source: 'example', missing: [...SECTIONS] }; }
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) return false;   // an inert (null) section stays inert
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  return true;
}

/**
 * The seed with the owner's `director.seed_set` overrides (state.story.seedOverlay)
 * applied, allow-listed and re-validated (reducer SEED_PATHS). A null section stays
 * null (e.g. no family section → the family arc stays inert even with an override).
 * → a fresh object; never throws.
 */
export function effectiveSeed(state, base = getArcSeed()) {
  const seed = base ? structuredClone(base) : { ...validateArcSeed({}, {}).seed };
  const overlay = isObj(state?.story?.seedOverlay) ? state.story.seedOverlay : {};
  for (const [p, v] of Object.entries(overlay)) {
    if (!Object.prototype.hasOwnProperty.call(SEED_PATHS, p)) continue;
    const clean = cleanSeedValue(p, v);
    if (clean === undefined || clean === null) continue;
    setPath(seed, p, clean);
  }
  if (isObj(seed.career?.salaryChangePct) && seed.career.salaryChangePct.min > seed.career.salaryChangePct.max) {
    seed.career.salaryChangePct.min = Math.min(0, seed.career.salaryChangePct.max);
  }
  return seed;
}

// ── generation ───────────────────────────────────────────────────────────────

/** Month start (unix s) in the world timezone, for the caller cap. */
export function monthStart(at, tz = config.timezone || 'UTC') {
  const [y, m] = dateKey(at, tz).split('-').map(Number);
  return zonedToUnix(y, m, 1, 0, 0, tz);
}

/**
 * Month-to-date spend of the callers under `prefixes` (USD; default the
 * `life.arcs.` callers — the Director prompt adds 'director.prompt' for its own
 * gate, spec 011). The default reader is the ledger's STRICT one, so a read
 * error (or a non-array) → Infinity (fail closed), never "nothing spent".
 */
export async function arcsCallerSpend(at, { tz, getUsageByCaller, prefixes = ['life.arcs.'] } = {}) {
  try {
    const fn = getUsageByCaller ?? deps.getUsageByCaller ?? (await import('../../brain/usage.js')).getUsageByCallerStrict;
    let usd = 0;
    for (const prefix of prefixes) {
      const rows = fn(prefix, monthStart(at, tz));
      if (!Array.isArray(rows)) return Infinity;
      usd += rows.reduce((s, r) => s + (Number(r?.costUsd) || 0), 0);
    }
    return usd;
  } catch {
    return Infinity;
  }
}

/** The pre-call gates shared by the automatic and the owner path. → { ok, reason } */
async function generationGate(at, opts) {
  const cap = Number(config.arcs?.mindBudgetUsd ?? 1);
  const spent = await arcsCallerSpend(at, { tz: opts.tz, getUsageByCaller: opts.getUsageByCaller });
  if (!(spent < cap)) return { ok: false, reason: 'caller_cap' };
  const gate = opts.mindBudgetOk ?? deps.mindBudgetOk;
  if (typeof gate !== 'function') return { ok: false, reason: 'budget' };   // no 008 gate wired → never call
  let b;
  try { b = await gate('sleep'); } catch { b = null; }
  if (b?.ok !== true) return { ok: false, reason: b?.reason === 'unpriced' ? 'unpriced' : 'budget' };
  return { ok: true };
}

function worldSummary(world) {
  const places = (Array.isArray(world?.places) ? world.places : world?.places instanceof Map ? [...world.places.values()] : [])
    .slice(0, 48).map(p => `${p.id} (${cleanItem(p.kind, 24)}: ${cleanItem(p.name, 60)})`);
  const cast = (Array.isArray(world?.cast) ? world.cast : world?.cast instanceof Map ? [...world.cast.values()] : [])
    .slice(0, 24).map(c => cleanItem(c.relation, 40));
  const r = world?.routine ?? {};
  return [
    `Time zone: ${cleanItem(world?.timezone || config.timezone || 'UTC', 64)}`,
    `Job title: ${cleanItem(world?.self?.job?.title, 60) || 'unknown'}`,
    `Routine: office days ${JSON.stringify(r.officeDays ?? [])}, home days ${JSON.stringify(r.wfhDays ?? [])}, work ${cleanItem(r.workStart, 5)}-${cleanItem(r.workEnd, 5)}`,
    `Cast relations: ${cast.join(', ') || 'none'}`,
    `Places: ${places.join('; ')}`,
    `Heavy kinds (closed list): ${HEAVY_KINDS.join(', ')}`,
    `Status relations: ${STATUS_RELATIONS.join(', ')}`,
  ].join('\n');
}

async function runGeneration(at, opts) {
  const st = opts.store ?? store();
  const file = opts.path ?? ARCS_PATH;
  const world = worldFor(opts);
  const call = opts.callRole ?? deps.callRole ?? (await import('../../brain/llm.js')).callRole;
  const persona = opts.persona ?? deps.persona ?? getPersona();
  const identity = opts.identityText ?? deps.identityText ?? (await import('../../personality/systemPrompt.js')).getIdentityText();
  const knownNames = opts.knownNames ?? deps.knownNames ?? realPeopleNames();
  const user = [
    `Persona: ${JSON.stringify({ name: persona?.name, age: persona?.age, region: persona?.region, language: persona?.language, vibe: persona?.vibe })}`,
    `Character description:\n${String(identity || '').slice(0, 12_000)}`,
    `World summary:\n${worldSummary(world)}`,
  ].join('\n\n');
  const runId = st.startRun({ kind: 'seed', caller: SEED_CALLER, input: { trigger: opts.trigger ?? 'auto' }, startedAt: at });
  let res;
  try {
    res = await call('mind', SEED_PROMPT, user, { caller: SEED_CALLER, maxTokens: 6000, temperature: 0.5, timeoutMs: 120_000 });
  } catch {
    res = { text: null, status: 'error' };
  }
  const meta = { model: res?.model ?? null, fellBack: !!res?.fellBack, costUsd: Number.isFinite(res?.costUsd) ? res.costUsd : null };
  if (res?.skipped) {
    st.bumpRun(runId, { status: 'skipped', skipReason: ['budget', 'disabled', 'no_key'].includes(res.skipped) ? res.skipped : 'budget', ...meta });
    return { ok: false, reason: res.skipped === 'no_key' ? 'no_key' : 'budget', runId };
  }
  const parsed = parseJsonObject(res?.text, MAX_BYTES.seed);
  if (!parsed.ok) {
    st.bumpRun(runId, { status: res?.text ? 'invalid' : 'failed', ...meta, dropped: [{ path: '', reason: parsed.error }] });
    return { ok: false, reason: res?.text ? 'invalid' : 'failed', runId };
  }
  const v = validateArcSeed(parsed.value, { knownNames, world });
  if (!v.ok) {
    st.bumpRun(runId, { status: 'invalid', ...meta, dropped: [{ path: '', reason: v.error }] });
    return { ok: false, reason: 'invalid', runId };
  }
  const seed = v.seed;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf-8', mode: 0o644 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o644);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    st.bumpRun(runId, { status: 'failed', ...meta });
    return { ok: false, reason: 'write_failed', runId };
  }
  st.bumpRun(runId, { status: v.missing.length ? 'partial' : 'ok', ...meta, output: { sections: SECTIONS.filter(s => seed[s]), missing: v.missing },
    dropped: v.dropped.slice(0, 40) });
  return { ok: true, runId, seed, missing: v.missing, hash: seedHash(seed) };
}

/**
 * Make sure an arc seed exists (research R19). arcs.json present → load it, no call.
 * Absent → at most ONE automatic generation per install: the attempt marker is
 * written before anything else, any earlier attempt refuses (no retry on boot or
 * restart), then the caller cap and mindBudgetOk('sleep') gate the one mind call
 * (caller life.arcs.seed). Every failure leaves the example in force with
 * story_state.seed.source 'example' and a reason. Never throws.
 *   opts: { callRole, mindBudgetOk, getUsageByCaller, persona, identityText,
 *           knownNames, world, path, examplePath, store, tz }
 * → { status:'loaded'|'generated'|'example'|'skipped', reason?, seed }
 */
export async function ensureArcSeed(opts = {}) {
  const file = opts.path ?? ARCS_PATH;
  const examplePath = opts.examplePath ?? EXAMPLE_ARCS_PATH;
  const st = opts.store ?? store();
  const at = nowSec();
  try {
    if (fs.existsSync(file)) {
      return { status: 'loaded', seed: loadArcSeed({ path: file, examplePath, knownNames: opts.knownNames, world: opts.world }) };
    }
    if (!st.beginSeedAttempt({ at })) {
      return { status: 'skipped', reason: 'attempted', seed: loadArcSeed({ path: file, examplePath, world: opts.world, force: true }) };
    }
    const gate = await generationGate(at, opts);
    if (!gate.ok) {
      st.patchState({ seed: { source: 'example', attemptedAt: at, reason: gate.reason } });
      logger.info({ evt: 'arcs_seed', status: 'example', reason: gate.reason }, 'arcs seed: generation gated, using the example');
      return { status: 'example', reason: gate.reason, seed: loadArcSeed({ path: file, examplePath, world: opts.world, force: true }) };
    }
    const r = await runGeneration(at, { ...opts, path: file, trigger: 'auto' });
    if (!r.ok) {
      st.patchState({ seed: { source: 'example', attemptedAt: at, reason: r.reason } });
      logger.warn({ evt: 'arcs_seed', status: 'example', reason: r.reason, runId: r.runId }, 'arcs seed failed, using the example');
      return { status: 'example', reason: r.reason, seed: loadArcSeed({ path: file, examplePath, world: opts.world, force: true }) };
    }
    st.patchState({ seed: { source: 'generated', attemptedAt: at, generatedAt: nowSec(), hash: r.hash, missing: r.missing.slice(0, 20) } });
    logger.info({ evt: 'arcs_seed', status: 'generated', missing: r.missing.length, runId: r.runId }, 'arcs seed generated');
    return { status: 'generated', seed: loadArcSeed({ path: file, examplePath, knownNames: opts.knownNames, world: opts.world, force: true }) };
  } catch (err) {
    logger.warn({ evt: 'arcs_seed', status: 'example', reason: 'error', code: err?.code ?? null }, 'arcs seed failed, using the example');
    try { st.patchState({ seed: { source: 'example', attemptedAt: at, reason: 'error' } }); } catch { /* best effort */ }
    return { status: 'example', reason: 'error', seed: loadArcSeed({ path: file, examplePath, world: opts.world, force: true }) };
  }
}

/**
 * Owner regenerate (POST /api/arcs/seed/regenerate): no attempt marker check, but
 * 1/hour (from story_runs kind 'seed') and the same caller cap + mindBudgetOk gate.
 * Replaces arcs.json on success. → { status:'generated'|'refused'|'failed', reason?, runId? }
 */
export async function regenerateArcSeed(opts = {}) {
  const st = opts.store ?? store();
  const at = nowSec();
  const last = st.lastRun({ kind: 'seed' });
  if (last && Number.isFinite(last.startedAt) && at - last.startedAt < REGENERATE_GAP_SEC) return { status: 'refused', reason: 'rate' };
  const gate = await generationGate(at, opts);
  if (!gate.ok) return { status: 'refused', reason: gate.reason };
  const r = await runGeneration(at, { ...opts, trigger: 'owner' });
  if (!r.ok) {
    logger.warn({ evt: 'arcs_seed', status: 'failed', reason: r.reason, runId: r.runId }, 'arcs seed regenerate failed');
    return { status: 'failed', reason: r.reason, runId: r.runId };
  }
  const prev = st.getState('seed') || {};
  st.patchState({ seed: { ...prev, source: 'generated', generatedAt: nowSec(), hash: r.hash, missing: r.missing.slice(0, 20), reason: undefined } });
  resetSeedCache();
  logger.info({ evt: 'arcs_seed', status: 'generated', trigger: 'owner', runId: r.runId }, 'arcs seed regenerated');
  return { status: 'generated', runId: r.runId };
}
