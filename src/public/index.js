// Public site (spec 013) — the exporter facade. Every N minutes (PUBLIC_SITE_INTERVAL_MINUTES)
// while the `public-site` skill is on:
//
//   life.publicRaw()  (the structural filter, src/life/publicView.js)
//     → build()       (names, ids, places, labels, stats, recap, journal, votes; scrubbed)
//     → validate()    (closed schema + every string re-scrubbed + 512 KB cap)
//     → data/public/public.json, then R2 (when configured and not DRY_RUN; only when the
//       content changed or the last upload is ≥ 30 min old)
//     → the votes Worker's tallies (when configured) into public_votes
//
// Any failure → nothing uploaded (the last good snapshot stays up), one codes-only log line
// and public_state.lastIssue. The rest of the app imports only this module (dashboard
// routes, index.js boot, the skill manifest). Reads life only through the life facade.
// Logging: codes, sizes, counts, hashes — never the document, names or credentials.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config, getPersona } from '../utils/config.js';
import { logger as rootLogger } from '../utils/logger.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { resolvePerson } from '../memory/identity.js';
import { onPersonPurged } from '../memory/relationshipStore.js';
import * as life from '../life/index.js';
import * as store from './store.js';
import { makeScrubber, guardKeys } from './scrub.js';
import { build, publicDecisionId, nearHeavy } from './build.js';
import { validate, validateOffline, offlineDoc } from './schema.js';
import { putObject, r2Config } from './r2.js';
import { pullTallies, votesConfig } from './votes.js';

const log = rootLogger.child({ mod: 'public' });
const OBJECT_KEY = 'public.json';
const HEARTBEAT_SEC = 30 * 60;
const SOON_MS = 5000;

let deps = {
  publicRaw: (opts) => life.publicRaw(opts),
  venueWords: (text) => life.venueKindWords(text),   // 014 §8: venue names → kind words in published prose
  // 016: the scene texts of raw.scenes (edited text wins; superseded / reverted never). Absent → no scenes.
  publicScenes: (ids) => (typeof life.publicScenes === 'function' ? life.publicScenes(ids) : null),
  scenesOn: () => config.arcs?.scenePublic !== false,
  // 019: the texts of raw.phone (Map eventId → text; live, non-heavy-window rows only). Absent → no phone.
  publicPhone: (ids) => (typeof life.publicPhone === 'function' ? life.publicPhone(ids) : null),
  // plan 020: the feed's keys. Absent or a failed read → that key stays out.
  publicLive: () => (typeof life.publicLive === 'function' ? life.publicLive() : undefined),
  publicThoughts: (ids) => (typeof life.publicThoughts === 'function' ? life.publicThoughts(ids) : null),
  publicDreams: (ids) => (typeof life.publicDreams === 'function' ? life.publicDreams(ids) : null),
  publicMind: () => (typeof life.publicMind === 'function' ? life.publicMind() : null),
  knownNames: () => store.knownPeopleNames(),
  groupNames: () => store.groupSubjects(),
  persona: () => getPersona() || {},
  put: (key, body) => putObject(key, body),
  pull: (ids) => pullTallies(ids),
  enabled: () => isSkillEnabled('public-site'),
  now: () => Math.floor(Date.now() / 1000),
  outDir: () => path.join(config.projectRoot, 'data', 'public'),
  dryRun: () => config.dryRun === true,
  soonMs: SOON_MS,                 // null → owner changes wait for the next tick (tests)
};

let timer = null;
let soon = null;
let running = null;
let purgeOff = null;
let last = { doc: null, hash: null, at: null, status: null, errors: [], size: 0, uploadedAt: null, uploadedHash: null, uploadStatus: null, votesMap: new Map() };

export function __setDepsForTest(over) { deps = { ...deps, ...over }; }
export function __resetForTest() {
  stopPublic();
  last = { doc: null, hash: null, at: null, status: null, errors: [], size: 0, uploadedAt: null, uploadedHash: null, uploadStatus: null, votesMap: new Map() };
}

const contentHash = (doc) => crypto.createHash('sha256')
  .update(JSON.stringify({ ...doc, generatedAt: 0, now: { ...doc.now, at: 0 } })).digest('hex');

function issue(code, extra = {}) {
  try { store.setState('lastIssue', { code, at: deps.now(), ...extra }); } catch { /* best effort */ }
  log.warn({ evt: 'issue', code, ...extra }, 'public: export issue');
}

/** Boot (index.js start): the purge hook always; the timer (each run checks the skill). Never throws. */
export function startPublic({ setIntervalFn = setInterval } = {}) {
  try {
    if (!purgeOff) {
      purgeOff = onPersonPurged((db, person) => {
        const had = !!db.prepare('SELECT 1 FROM public_people WHERE person_jid = ? AND opted_in = 1').get(person);
        store.deletePerson(person, db);
        if (had) { store.setState('mustRefresh', refreshRequest('purge'), db); schedulePrivacyRefresh(); }
      });
    }
  } catch (err) {
    log.warn({ evt: 'issue', code: 'purge_hook', err: err?.name }, 'public: purge hook not registered');
  }
  if (timer) return;
  const ms = Math.max(2, config.publicSite?.intervalMinutes ?? 5) * 60_000;
  timer = setIntervalFn(() => {
    // A pending privacy refresh runs whatever the skill says; a normal export only while it's on.
    if (pendingRefresh()) runPrivacyRefresh().catch(() => {});
    else if (deps.enabled()) exportNow().catch(() => {});
  }, ms);
  timer?.unref?.();
  if (pendingRefresh()) schedulePrivacyRefresh();
}

// ── privacy refresh: an opt-out, purge or unpublish must reach the live site ──
//
// The live site keeps the last uploaded snapshot, so removing something (a person's name, a
// journal night) only takes effect once a new document is up. The request is durable
// (public_state.mustRefresh) and retried every tick until it succeeds:
//   skill on  → export at once; if it can't be built or uploaded → take the site offline
//   skill off → take the site offline (the owner stopped publishing; nothing new goes up)
// With R2 not configured (or DRY_RUN) nothing is live, so the request just clears.
// A request is cleared only if it is still the one that run served (compare-and-clear): one
// that arrives while a refresh is uploading (it overwrites the row) is served next.

let refreshTimer = null;
let refreshing = null;
function pendingRefresh() { return !!safe(() => store.getState('mustRefresh'), null); }

/** A refresh request: its own id, so a newer request is never mistaken for the one being served. */
function refreshRequest(reason) {
  return { at: deps.now(), reason, id: crypto.randomUUID() };
}
const sameRequest = (a, b) => !!a && !!b
  && (a.id != null || b.id != null ? a.id === b.id : a.at === b.at && a.reason === b.reason);

function requestPrivacyRefresh(reason) {
  try { store.setState('mustRefresh', refreshRequest(reason)); } catch { /* the tick retries the next owner change */ }
  schedulePrivacyRefresh();
}

function schedulePrivacyRefresh() {
  if (refreshTimer || deps.soonMs == null) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; runPrivacyRefresh().catch(() => {}); }, Math.min(deps.soonMs, 3000));
  refreshTimer.unref?.();
}

/** → { status: 'none'|'exported'|'offline'|'not_live'|'failed' } */
export async function runPrivacyRefresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let res = { status: 'none' };
    // A request that came in while one was being served is still pending: serve it too
    // (bounded; the tick and the scheduled retry take over after that).
    for (let round = 0; round < 3; round++) {
      const want = safe(() => store.getState('mustRefresh'), null);
      if (!want) return res;
      const out = await refreshOnce(want);
      res = { status: out.status };
      if (out.status === 'failed' || out.cleared) return res;
    }
    if (pendingRefresh()) schedulePrivacyRefresh();
    return res;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

/** Serve one request. → { status, cleared } — cleared only while `want` is still the stored request. */
async function refreshOnce(want) {
  const done = (status) => {
    // Synchronous read-compare-write: nothing (purge transaction included) can land in between.
    const cleared = safe(() => {
      if (!sameRequest(store.getState('mustRefresh'), want)) return false;
      store.setState('mustRefresh', null);
      return true;
    }, false);
    log.info({ evt: 'public.refresh', status, reason: want.reason, cleared }, 'public: privacy refresh');
    return { status, cleared };
  };
  const live = r2Config().ok && !deps.dryRun();
  if (deps.enabled()) {
    // An export already in flight was built before the request (it may still hold what
    // was removed): let it land first, then build a fresh one. 'busy' must never read as
    // a failure here — it would take the site offline for nothing.
    let res = { status: 'busy' };
    for (let i = 0; i < 3 && res.status === 'busy'; i++) {
      if (running) await running.catch(() => {});
      res = await exportNow({ upload: true, force: true });
    }
    if (!live) return done('not_live');
    // Only this call's own upload counts (built after the request), never an earlier one.
    if ((res.status === 'ok' || res.status === 'unchanged') && res.uploaded === true && last.uploadedAt && last.uploadedAt >= want.at) return done('exported');
  } else if (!live) {
    return done('not_live');
  }
  if (running) await running.catch(() => {});   // an older export must not land after the takedown
  const td = await takedown();
  if (td.ok && td.uploaded) return done('offline');
  issue('privacy_refresh_failed', { reason: td.reason ?? 'unknown' });
  return { status: 'failed', cleared: false };
}

export function stopPublic() {
  if (timer) { clearInterval(timer); timer = null; }
  if (soon) { clearTimeout(soon); soon = null; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

/** An owner change (opt-in, journal) → one export a few seconds later, if the skill is on. */
function exportSoon() {
  if (soon || !deps.enabled() || deps.soonMs == null) return;
  soon = setTimeout(() => { soon = null; exportNow().catch(() => {}); }, deps.soonMs);
  soon.unref?.();
}

/**
 * Build (and, unless upload:false, write + upload) the snapshot.
 * → { status: 'ok'|'unchanged'|'life_off'|'history_too_large'|'names_unavailable'|'build_failed'|'invalid'|'busy', size, errors, uploaded }
 * 'history_too_large': the event log is longer than publicRaw may read (its page
 * guard) — nothing is built or uploaded rather than an incomplete snapshot.
 */
export async function exportNow({ upload = true, force = false } = {}) {
  if (running) return { status: 'busy' };
  running = (async () => {
    const at = deps.now();
    let raw;
    try { raw = deps.publicRaw({ days: config.publicSite?.days ?? 14 }); } catch (err) {
      if (err?.code === 'history_too_large') {
        issue('history_too_large');
        last = { ...last, status: 'history_too_large', at };
        return { status: 'history_too_large' };
      }
      raw = undefined;
    }
    if (!raw) { last = { ...last, status: 'life_off', at }; return { status: 'life_off' }; }
    let scrubber;
    let people;
    try {
      const knownNames = deps.knownNames();
      const groupNames = deps.groupNames();
      if (!Array.isArray(knownNames) || !Array.isArray(groupNames)) throw new Error('names');
      people = store.optedIn();
      const persona = deps.persona();
      const allowNames = [persona.name, persona.displayName, ...(Array.isArray(persona.aliases) ? persona.aliases : []),
        ...(raw.cast || []).map((c) => c.name), ...people.map((p) => p.displayName)].filter((s) => typeof s === 'string');
      scrubber = makeScrubber({ knownNames, groupNames, allowNames, placeNames: (raw.places || []).map((p) => p?.name).filter((s) => typeof s === 'string'), guard: nameGuard(knownNames) });
    } catch {
      issue('names_unavailable');
      last = { ...last, status: 'names_unavailable', at };
      return { status: 'names_unavailable' };
    }
    let doc;
    try {
      doc = build({ raw, persona: deps.persona(), people, journal: store.listJournal(), resolvePerson, scrubber, salt: store.salt(), venueWords: deps.venueWords, scenes: sceneRows(raw), phone: phoneRows(raw), feed: feedRows(raw) });
    } catch (err) {
      issue('build_failed', { err: err?.name });
      last = { ...last, status: 'build_failed', at };
      return { status: 'build_failed' };
    }
    const v = validate(doc, scrubber);
    if (!v.ok) {
      issue('invalid', { errors: v.errors.length, first: v.errors[0] });
      last = { ...last, status: 'invalid', errors: v.errors, at };
      return { status: 'invalid', errors: v.errors, size: v.size };
    }
    const votesMap = new Map((raw.votes || []).map((x) => [publicDecisionId(store.salt(), x.decisionId), { decisionId: x.decisionId, options: new Set(x.options.map((o) => o.id)) }]));
    const hash = contentHash(doc);
    const json = JSON.stringify(doc);
    const changed = hash !== last.hash;
    last = { ...last, doc, hash, at, status: 'ok', errors: [], size: v.size, votesMap };
    if (!upload) return { status: 'ok', size: v.size, uploaded: false };
    writeLocal(json);
    let uploaded = false;
    // Due when this content isn't the last one uploaded (a failed upload is retried at the
    // next tick, not at the heartbeat), or the heartbeat is up.
    const due = force || hash !== last.uploadedHash || !last.uploadedAt || at - last.uploadedAt >= HEARTBEAT_SEC;
    if (due && !deps.dryRun() && r2Config().ok) {
      const res = await deps.put(OBJECT_KEY, json);
      last.uploadStatus = res.ok ? 'ok' : `${res.reason}${res.status ? `:${res.status}` : ''}`;
      if (res.ok) { uploaded = true; last.uploadedAt = at; last.uploadedHash = hash; } else issue('upload_failed', { reason: res.reason, status: res.status ?? null });
    } else if (!r2Config().ok) {
      last.uploadStatus = r2Config().reason;
    } else if (deps.dryRun()) {
      last.uploadStatus = 'dry_run';
    }
    try { store.setState('lastExport', { at, size: v.size, hash: hash.slice(0, 16), uploaded, uploadStatus: last.uploadStatus }); } catch { /* best effort */ }
    log.info({ evt: 'public.export', size: v.size, changed, uploaded, upload: last.uploadStatus, rows: doc.today.rows.length, votes: doc.votes.length, scenes: Array.isArray(doc.scenes) ? doc.scenes.length : null, phone: Array.isArray(doc.phone?.threads) ? doc.phone.threads.reduce((a, t) => a + t.messages.length, 0) : null }, 'public: exported');
    await pullVotes();
    return { status: changed ? 'ok' : 'unchanged', size: v.size, uploaded };
  })();
  try { return await running; } finally { running = null; }
}

/**
 * Plan 020: raw's ids joined with their words, and the two keys read whole. A read that fails leaves that key out; the next export tries again.
 */
export function feedRows(raw) {
  const feed = {};
  try {
    const v = deps.publicLive();
    if (v !== undefined) feed.live = v;
  } catch { /* no key */ }
  if (Array.isArray(raw?.thoughts)) {
    try {
      const words = deps.publicThoughts(raw.thoughts.map((x) => x.id));
      if (words instanceof Map) feed.thoughts = raw.thoughts.map((x) => ({ ...x, text: words.get(x.id) }));
    } catch { /* no key */ }
  }
  if (Array.isArray(raw?.dreams)) {
    try {
      const words = deps.publicDreams(raw.dreams.map((x) => x.eventId));
      if (words instanceof Map) feed.dreams = raw.dreams.map((x) => ({ ...x, text: words.get(x.eventId)?.text, night: words.get(x.eventId)?.night }));
    } catch { /* no key */ }
  }
  try {
    const rows = deps.publicMind();
    if (Array.isArray(rows)) feed.mind = rows;
  } catch { /* no key */ }
  return feed;
}

/**
 * 019: raw.phone joined with its texts. null → the document has no `phone` key: no raw phone
 * view (an engine without 019), no publicPhone, or the text read failed (the next export tries
 * again). A message without a text (reverted, swept, in a heavy window) is not published.
 */
export function phoneRows(raw) {
  if (!Array.isArray(raw?.phone)) return null;
  const rows = raw.phone.filter((x) => x && Number.isSafeInteger(x.eventId)).slice(0, 2000);
  let texts;
  try { texts = deps.publicPhone(rows.map((x) => x.eventId)); } catch { texts = null; }
  if (texts === null || texts === undefined) return null;
  const byId = new Map();
  if (texts instanceof Map) {
    for (const [k, t] of texts) byId.set(Number(k), t);
  } else if (Array.isArray(texts)) {
    for (const t of texts) { const id = t?.eventId; if (Number.isSafeInteger(id)) byId.set(id, t); }
  } else if (typeof texts === 'object') {
    for (const [k, t] of Object.entries(texts)) byId.set(Number(k), t);
  }
  const out = [];
  for (const r of rows) {
    const t = byId.get(r.eventId);
    const text = typeof t === 'string' ? t : typeof t?.text === 'string' ? t.text : null;
    if (text) out.push({ ...r, text });
  }
  return out;
}

/**
 * 016: raw.scenes joined with their text (export-contract.md). null → the document has no
 * `scenes` key: public scenes switched off (arcs.scenePublic), no raw scene view, or the
 * text read failed (an export never waits on scenes; the next one tries again).
 */
export function sceneRows(raw) {
  if (!deps.scenesOn() || !Array.isArray(raw?.scenes)) return null;
  // Newest first before the cap (the builder keeps the newest 30 of these).
  const rows = raw.scenes.filter((x) => x && Number.isSafeInteger(x.sceneEventId))
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0)).slice(0, 60);
  if (!rows.length) return [];
  let texts;
  try { texts = deps.publicScenes(rows.map((x) => x.sceneEventId)); } catch { texts = null; }
  if (texts === null || texts === undefined) return null;
  const byId = new Map();
  if (Array.isArray(texts)) {
    for (const t of texts) { const id = t?.sceneEventId ?? t?.eventId; if (Number.isSafeInteger(id)) byId.set(id, t); }
  } else if (texts instanceof Map) {
    for (const [k, t] of texts) byId.set(Number(k), t);
  } else if (typeof texts === 'object') {
    for (const [k, t] of Object.entries(texts)) byId.set(Number(k), t);
  }
  const out = [];
  for (const r of rows) {
    const t = byId.get(r.sceneEventId);
    if (!t || typeof t.text !== 'string') continue;   // no text (reverted, superseded, swept) → not published
    out.push({ ...r, text: t.text, topics: t.topics ?? [], highlight: t.highlight ?? null, awkward: t.awkward ?? null, impressions: t.impressions ?? null });
  }
  return out;
}

/**
 * The purged-name guard: salted keys of every real name ever seen, merged with today's
 * names and stored (public_state.nameGuard), so a name stays refused on the site after
 * its person is purged (purge deletes the people row before any hook can read it).
 * Keys only — never a name. Throws on a DB error (the caller fails closed).
 */
const GUARD_MAX = 20000;
function nameGuard(knownNames) {
  const salt = store.salt();
  const prev = store.getState('nameGuard') || {};
  const now = guardKeys(salt, knownNames);
  const full = new Set([...(Array.isArray(prev.full) ? prev.full : []), ...now.full]);
  const first = new Set([...(Array.isArray(prev.first) ? prev.first : []), ...now.first]);
  if (full.size !== (prev.full?.length ?? 0) || first.size !== (prev.first?.length ?? 0)) {
    store.setState('nameGuard', { full: [...full].slice(-GUARD_MAX), first: [...first].slice(-GUARD_MAX) });
  }
  return { salt, full, first };
}

function writeLocal(json) {
  try {
    const dir = deps.outDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${OBJECT_KEY}.tmp`);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, OBJECT_KEY));
  } catch (err) {
    issue('local_write', { err: err?.code || err?.name });
  }
}

async function pullVotes() {
  if (!votesConfig().ok || !last.votesMap.size) return;
  try {
    const res = await deps.pull([...last.votesMap.keys()]);
    if (!res?.ok) { issue('votes_pull', { reason: res?.reason ?? 'unknown' }); return; }
    const rows = [];
    for (const [pubId, counts] of Object.entries(res.tallies || {})) {
      const m = last.votesMap.get(pubId);
      if (!m) continue;                                     // only ids this exporter published
      for (const [optionId, count] of Object.entries(counts || {})) {
        if (!m.options.has(optionId) || !Number.isSafeInteger(count) || count < 0) continue;
        rows.push({ decisionId: m.decisionId, optionId, count: Math.min(count, 1_000_000) });
      }
    }
    store.putTallies(rows);
    store.pruneTallies([...last.votesMap.values()].map((m) => m.decisionId));
  } catch (err) {
    issue('votes_pull', { reason: err?.name ?? 'error' });
  }
}

/** Kill switch: replace the live snapshot with an "offline" document (the site shows a notice). */
export async function takedown() {
  const doc = offlineDoc(deps.now());
  const v = validateOffline(doc);
  if (!v.ok) return { ok: false, reason: 'invalid' };
  writeLocal(JSON.stringify(doc));
  if (deps.dryRun()) return { ok: true, uploaded: false, reason: 'dry_run' };
  if (!r2Config().ok) return { ok: true, uploaded: false, reason: r2Config().reason };
  const res = await deps.put(OBJECT_KEY, JSON.stringify(doc));
  last = { ...last, hash: null, uploadedHash: res.ok ? null : last.uploadedHash, uploadedAt: res.ok ? deps.now() : last.uploadedAt, uploadStatus: res.ok ? 'offline' : res.reason };
  log.info({ evt: 'public.takedown', uploaded: res.ok }, 'public: offline document uploaded');
  return { ok: res.ok, uploaded: res.ok, reason: res.ok ? null : res.reason };
}

// ── dashboard reads ──────────────────────────────────────────────────────

export function status() {
  let lastExport = null;
  let lastIssue = null;
  try { lastExport = store.getState('lastExport'); lastIssue = store.getState('lastIssue'); } catch { /* none */ }
  return {
    enabled: deps.enabled(),
    intervalMinutes: config.publicSite?.intervalMinutes ?? 5,
    dryRun: deps.dryRun(),
    r2: r2Config().ok ? 'configured' : r2Config().reason,
    votes: votesConfig().ok ? 'configured' : votesConfig().reason,
    publicUrl: publicJsonUrl(),
    last: { at: last.at, status: last.status, size: last.size, errors: last.errors.slice(0, 10), uploadedAt: last.uploadedAt, uploadStatus: last.uploadStatus },
    lastExport,
    lastIssue,
    optedIn: safe(() => store.optedIn().length, 0),
    privacyRefreshPending: pendingRefresh(),
    journal: safe(() => store.listJournal().length, 0),
  };
}

function publicJsonUrl() {
  const u = String(process.env.PUBLIC_JSON_URL || '').trim();
  return /^https:\/\/[^\s]+$/i.test(u) ? u : null;
}

/** The exact document the last export built (or a fresh local build without upload). */
export async function preview() {
  if (!last.doc) await exportNow({ upload: false });
  return last.doc;
}

export function people() { return safe(() => store.listPeople(), []); }
export function personSetting(personJid) { return safe(() => store.getPerson(personJid), null); }

export function setOptIn(personJid, { optedIn, displayName } = {}, by = 'owner') {
  const before = safe(() => store.getPerson(personJid), null);
  const row = store.setPerson(personJid, { optedIn, displayName }, by);
  // Switching someone off, or renaming them while shown, must reach the live site.
  if (before?.optedIn && (!row.optedIn || before.displayName !== row.displayName)) requestPrivacyRefresh('opt_out');
  else exportSoon();
  return row;
}

/** Owner PUBLISH of a journal night's self part (the arcs route hands the text in). Scrubbed now and on every export. */
export function publishJournal(night, text, by = 'owner') {
  if (typeof night !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return { ok: false, reason: 'bad_night' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'no_text' };
  let scrubber;
  let raw = null;
  try { raw = deps.publicRaw({ days: 1 }); } catch (err) {
    if (err?.code === 'history_too_large') return { ok: false, reason: 'history_too_large' };
  }
  // A night during or near a hard stretch is never published (its self part may describe it).
  if (!raw) return { ok: false, reason: 'life_off' };
  if (nearHeavy(raw, night)) return { ok: false, reason: 'hard_stretch' };
  try {
    const p = deps.persona();
    const knownNames = deps.knownNames();
    scrubber = makeScrubber({
      knownNames, groupNames: deps.groupNames(), guard: nameGuard(knownNames),
      placeNames: (raw?.places || []).map((x) => x?.name).filter((x) => typeof x === 'string'),
      allowNames: [p.name, p.displayName, ...(p.aliases || []), ...(raw?.cast || []).map((c) => c.name), ...store.optedIn().map((x) => x.displayName)].filter((s) => typeof s === 'string'),
    });
  } catch {
    return { ok: false, reason: 'names_unavailable' };
  }
  // Real venue names never reach the site: each becomes its kind word (014 §8).
  let t;
  try { t = deps.venueWords(text.replace(/\s+/g, ' ').trim()).slice(0, 1200); } catch { return { ok: false, reason: 'names_unavailable' }; }
  if (typeof t !== 'string' || !t) return { ok: false, reason: 'no_text' };
  const why = scrubber.check(t);
  if (why) return { ok: false, reason: why };
  store.putJournal(night, t, by);
  exportSoon();
  return { ok: true };
}

export function unpublishJournal(night) {
  const ok = safe(() => store.deleteJournal(night), false);
  if (ok) requestPrivacyRefresh('unpublish');
  return { ok };
}

export function journalPublished() { return safe(() => store.listJournal(), []); }

/** Pulled audience tallies for one decision (the Ask-me card shows them; nothing is applied). */
export function votesFor(decisionId) {
  const rows = safe(() => store.talliesFor(decisionId), []);
  const total = rows.reduce((a, r) => a + r.count, 0);
  return { total, options: rows.map((r) => ({ optionId: r.optionId, count: r.count, share: total ? Math.round((r.count / total) * 100) / 100 : 0 })), pulledAt: rows[0]?.pulledAt ?? null };
}

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
