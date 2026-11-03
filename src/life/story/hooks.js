// Story deletion hooks (spec 010 research R22, contracts/journal.md §5,
// contracts/reconciler.md §5). DB-only: they touch the v11 tables (through
// store.js, the only door to them) and 009's life_claims, never the projection,
// so they work with life stopped, detached, or never booted.
//
//   registerHooks()        once per process, idempotent; called by the life
//                          facade's startLife() BEFORE its enabled check, so a
//                          forget/revoke/purge reaches the story tables even when
//                          life never runs. Registers:
//     - 006 onItemsDeleted → handleItemsDeleted (forget | revoke | edit in chat X):
//         * claims from X — his reply ids among msgIds, or flagged in X within
//           [min msgTs − 10 min, max msgTs + 10 min] (a forget has no msgTs:
//           forgetRecent fences the last 10 min, so the window is now − 20 min …
//           now + 10 min) — are withdrawn: their reviews go `withdrawn` with
//           extraction/resolution NULLed (a claim with no review yet gets one, born
//           withdrawn, so the reconciler can never adopt it later). The world half
//           (the claim.adopted revert) is the reconciler's applyPendingWithdrawals
//           at the next tick or boot;
//         * journal parts of X for the nights around those times, and every part
//           whose sources cite one of those claims (whatever its night: a DM plan
//           adopted Monday for Saturday sits in Saturday's part) → fenced (text
//           NULL, never rebuilt);
//         * narrations that used X, or cite one of the claims' events → deleted.
//       A failure is caught: the handler's writes run in their own savepoint (so
//       none survive), story_state.degraded is set, `arcs.hook.fail` is audited, and
//       the user's forget/revoke stands (006 also wraps us in a savepoint).
//       cause 'purge' is skipped here: onRedacted() handles it.
//     - 006 onPersonPurged → onRedacted(forms): a detached safety net. It runs
//       before 009's redaction inside purgePerson's transaction; the life facade's
//       redactPerson calls onRedacted again after logRedactPerson, when the
//       person's events are already redacted. onRedacted is idempotent.
//
//   onRedacted(jids)       purge of person P (every identity form), inside
//                          purgePerson's transaction. Deletes: reviews of P's DM
//                          claims; group reviews that resolved P (resolution
//                          subjectJid ∈ forms, a claim.adopted now redacted, or an
//                          extracted person name equal — case-folded — to one of
//                          P's names) together with their life_claims rows; journal
//                          parts and narrations with origin in P's forms, citing an
//                          event now redacted or a deleted claim. Errors PROPAGATE
//                          (the purge rolls back, as 009's redactPerson).
//
// Logging: ids, counts and causes only — never claim, journal or narration text.

import * as store from './store.js';
import { getDb } from '../../memory/db.js';
// Namespace imports, used lazily at call time (relationshipStore → life/index.js →
// story → here is a cycle; 008's mind/hooks.js resolves it the same way).
import * as relationshipStore from '../../memory/relationshipStore.js';
import * as mindReads from '../../memory/mindReads.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../utils/config.js';
import { now as clockNow, dateKey, resolveTimezone } from '../clock.js';
import { getEvent } from '../eventLog.js';

const MIN = 60;
const DAY = 86400;
const CLAIM_WINDOW_SEC = 10 * MIN;
const FORGET_SPAN_SEC = 10 * MIN;       // forgetRecent fences lines from the last 10 minutes
const NIGHT_MARGIN_DAYS = 1;            // fence one night either side (fail closed)
const MAX_NIGHTS = 14;
const REVIEW_PAGE = 200;
const ID_CHUNK = 200;
const CHAT_CAUSES = new Set(['forget', 'revoke', 'edit']);
const ORIGIN_KINDS = new Set(['group', 'dm']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const uniq = (arr) => [...new Set(arr)];
const fold = (s) => (typeof s === 'string' ? s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : '');

// ── Deps (test seam) ──────────────────────────────────────────────────────

const DEFAULT_DEPS = {
  now: () => clockNow(),
  db: () => getDb(),
  timezone: () => resolveTimezone(config.timezone),
  auditWrite: (...args) => import('../../dashboard/audit.js').then(m => m.auditWrite(...args)).catch(() => {}),
  relationshipStore: () => relationshipStore,
  namesOf: (jid) => (typeof mindReads.namesOf === 'function' ? mindReads.namesOf(jid) : new Set()),
  getEvent: (id) => getEvent(id),
  logger,
};
let deps = { ...DEFAULT_DEPS };
let degraded = null;
let registered = false;
let unsubscribe = [];

/** Test seam: replace deps (null restores the defaults and forgets the registration). */
export function __setDepsForTest(over) {
  if (over === null) {
    for (const off of unsubscribe) { try { off?.(); } catch { /* best effort */ } }
    unsubscribe = [];
    registered = false;
    degraded = null;
    deps = { ...DEFAULT_DEPS };
    return;
  }
  deps = { ...deps, ...(isObj(over) ? over : {}) };
}

/** The in-memory degraded marker ({at, where, cause}) or null. */
export function degradedInfo() {
  return degraded;
}

/** True after a hook failure until clearDegraded(). */
export function isDegraded() {
  return degraded !== null;
}

/** Clear the degraded marker (the facade after a successful self-check). */
export function clearDegraded() {
  degraded = null;
  try { store.patchState({ degraded: null }); } catch { /* best effort */ }
}

// ── Registration ──────────────────────────────────────────────────────────

/** Production seam (the story facade at attach): merge deps such as { timezone, now }. */
export function configure(over = {}) {
  if (isObj(over)) deps = { ...deps, ...over };
}

/**
 * Register the 006 listeners once per process (idempotent, synchronous). Never
 * throws: a failure is logged and the next call retries. → true when registered
 */
export function registerHooks() {
  if (registered) return true;
  registered = true;
  try {
    const rs = deps.relationshipStore();
    if (typeof rs.onItemsDeleted === 'function') unsubscribe.push(rs.onItemsDeleted(handleItemsDeleted));
    if (typeof rs.onPersonPurged === 'function') unsubscribe.push(rs.onPersonPurged((db, person, forms) => onRedacted(forms?.length ? forms : [person])));
    return true;
  } catch (err) {
    registered = false;
    deps.logger.warn({ evt: 'issue', where: 'arcs.hooks', err: err?.code || err?.name || 'error' }, 'story: hook registration failed');
    return false;
  }
}

/** True once registerHooks() succeeded. */
export function hooksRegistered() {
  return registered;
}

// ── forget / revoke / edit ────────────────────────────────────────────────

function chatFormsOf(evt) {
  const forms = Array.isArray(evt?.chatForms) ? evt.chatForms.filter(j => typeof j === 'string' && j) : [];
  if (typeof evt?.chatJid === 'string' && evt.chatJid) forms.push(evt.chatJid);
  return uniq(forms).slice(0, 16);
}

function timeWindow(evt, at) {
  const ts = [];
  if (finite(evt?.msgTs)) ts.push(Math.floor(evt.msgTs));
  if (Array.isArray(evt?.msgTsList)) for (const t of evt.msgTsList) if (finite(t)) ts.push(Math.floor(t));
  if (!ts.length) return { lo: at - FORGET_SPAN_SEC - CLAIM_WINDOW_SEC, hi: at + CLAIM_WINDOW_SEC, ts: [at - FORGET_SPAN_SEC, at] };
  return { lo: Math.min(...ts) - CLAIM_WINDOW_SEC, hi: Math.max(...ts) + CLAIM_WINDOW_SEC, ts };
}

/** Night keys (YYYY-MM-DD, world tz) whose 04:00→04:00 day covers [lo, hi], one either side. */
export function nightsAround(lo, hi, tz) {
  const keys = [];
  const start = Math.floor(lo) - 4 * 3600 - NIGHT_MARGIN_DAYS * DAY;
  const end = Math.floor(hi) - 4 * 3600 + NIGHT_MARGIN_DAYS * DAY;
  const add = (t) => { const k = dateKey(t, tz); if (!keys.includes(k)) keys.push(k); };
  for (let t = start; t < end && keys.length < MAX_NIGHTS; t += DAY) add(t);
  if (keys.length < MAX_NIGHTS) add(end);
  return keys;
}

// life_claims rows of this chat touched by the deletion (009 table; read with the
// listener's own connection, inside the 006 transaction).
function claimsTouched(db, forms, msgIds, lo, hi) {
  const ids = JSON.stringify(uniq((Array.isArray(msgIds) ? msgIds : []).filter(x => typeof x === 'string' || Number.isFinite(x)).map(String)));
  const f = JSON.stringify(forms);
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'life_claims'").get();
  if (!has) return [];
  return db.prepare(`SELECT id, chat_jid, origin_kind, origin_jid, created_at FROM life_claims
    WHERE reply_msg_id IN (SELECT value FROM json_each(?))
      OR ((chat_jid IN (SELECT value FROM json_each(?)) OR origin_jid IN (SELECT value FROM json_each(?)))
        AND created_at BETWEEN ? AND ?)
    ORDER BY id`).all(ids, f, f, lo, hi);
}

function claimEventIds(reviews) {
  const out = [];
  for (const r of reviews) {
    if (Number.isSafeInteger(r?.claimEventId)) out.push(r.claimEventId);
    if (Number.isSafeInteger(r?.adoptedEventId)) out.push(r.adoptedEventId);
  }
  return uniq(out);
}

function chunks(list, n = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * The DB half of a forget/revoke/edit in one chat (no try/catch: the caller
 * wraps it). → counts
 */
export function withdrawForChat(db, evt) {
  const at = Math.floor(deps.now());
  const forms = chatFormsOf(evt);
  const out = { claims: 0, withdrawn: 0, partsFenced: 0, narrations: 0 };
  if (!forms.length) return out;
  const { lo, hi } = timeWindow(evt, at);
  const claims = claimsTouched(db, forms, evt?.msgIds, lo, hi);
  out.claims = claims.length;
  const claimIds = claims.map(c => c.id);
  // A claim with no review yet gets one, born withdrawn: the reconciler's boot
  // sweep (claimsWithoutReview) must never adopt a forgotten claim later.
  for (const c of claims) {
    if (store.getReviewByClaim(c.id)) continue;
    if (!ORIGIN_KINDS.has(c.origin_kind)) continue;
    store.createReview({ claimId: c.id, chatJid: c.chat_jid, originKind: c.origin_kind, originJid: c.origin_jid, createdAt: c.created_at });
  }
  const before = claimIds.length ? store.withdrawReviews(claimIds, { by: 'system:' + (evt?.cause || 'forget'), at }) : [];
  out.withdrawn = before.length;
  const reviews = claimIds.map(id => store.getReviewByClaim(id)).filter(Boolean);

  if (claimIds.length) out.partsFenced += store.fencePartsByClaims(claimIds);
  const nights = nightsAround(lo, hi, deps.timezone());
  for (const f of forms) out.partsFenced += store.fencePartsByOrigin(f, nights);

  out.narrations += store.deleteNarrationsByOrigins(forms);
  const evIds = claimEventIds(reviews);
  for (const part of chunks(evIds)) out.narrations += store.deleteNarrationsBySourceEvents(part);
  return out;
}

/**
 * 006 onItemsDeleted listener: fn(db, {chatJid, chatForms, msgIds, cause, msgTs?}).
 * Synchronous. forget/revoke/edit only; a failure never undoes the user's
 * deletion (caught, degraded, audited).
 */
export function handleItemsDeleted(db, evt) {
  const cause = evt?.cause;
  if (!CHAT_CAUSES.has(cause)) return null;
  const conn = db && typeof db.transaction === 'function' ? db : deps.db();
  try {
    // Own savepoint: a failure half-way leaves none of our writes behind.
    const res = conn.transaction(() => withdrawForChat(conn, evt))();
    if (res.claims || res.partsFenced || res.narrations) {
      deps.logger.info({ evt: 'arcs.hook', cause, claims: res.claims, withdrawn: res.withdrawn, fenced: res.partsFenced, narrations: res.narrations },
        'story: deletion applied');
    }
    return res;
  } catch (err) {
    markDegraded(cause, err);
    return null;
  }
}

function markDegraded(cause, err) {
  const at = Math.floor(deps.now());
  degraded = { at, where: 'hooks', cause };
  deps.logger.warn({ evt: 'issue', where: 'arcs.hooks', cause, err: err?.code || err?.name || 'error' }, 'story: deletion hook failed (degraded)');
  try { store.patchState({ degraded: { at, where: 'hooks' } }); } catch { /* the in-memory marker still holds */ }
  try {
    const r = deps.auditWrite('system:arcs', 'arcs.hook.fail', null, { cause, code: String(err?.code || err?.name || 'error').slice(0, 40) });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* audit is best effort */ }
}

// ── purge ─────────────────────────────────────────────────────────────────

function allReviews() {
  const out = [];
  let before = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = store.listReviews({ before, limit: REVIEW_PAGE });
    out.push(...page);
    if (page.length < REVIEW_PAGE) break;
    before = page[page.length - 1].id;
  }
  return out;
}

function namesFor(forms) {
  const out = new Set();
  if (typeof deps.namesOf !== 'function') return out;
  for (const j of forms) {
    try {
      for (const n of deps.namesOf(j) || []) { const f = fold(n); if (f.length >= 2) out.add(f); }
    } catch { /* names are an extra match only */ }
  }
  return out;
}

function eventRedacted(id) {
  if (!Number.isSafeInteger(id)) return false;
  try { return deps.getEvent(id)?.redacted === true; } catch { return false; }
}

/**
 * Purge of a person (every identity form), inside purgePerson's transaction.
 * DB-only, works detached; idempotent; errors propagate. → counts
 */
export function onRedacted(jids) {
  const forms = uniq((Array.isArray(jids) ? jids : [jids]).filter(j => typeof j === 'string' && j)).slice(0, 32);
  const out = { reviews: 0, groupReviews: 0, claims: 0, parts: 0, narrations: 0 };
  if (!forms.length) return out;
  const db = deps.db();
  const formSet = new Set(forms);
  const names = namesFor(forms);

  // Their DM claims' reviews (009 already deletes the life_claims rows of their DM).
  out.reviews += store.deleteReviewsByOrigins(forms);

  // Group reviews that resolved them: their life_claims rows go too (009 keeps group claims).
  const hit = [];
  for (const r of allReviews()) {
    if (r.originKind !== 'group') continue;
    const subject = isObj(r.resolution) ? r.resolution.subjectJid : null;
    const people = Array.isArray(r.extraction?.people) ? r.extraction.people.map(fold) : [];
    if ((typeof subject === 'string' && formSet.has(subject))
        || eventRedacted(r.adoptedEventId)
        || (names.size && people.some(p => names.has(p)))) hit.push(r);
  }
  const claimIds = hit.map(r => r.claimId);
  const evIds = claimEventIds(hit);
  if (claimIds.length) {
    out.parts += store.deletePartsBySourceClaims(claimIds);
    out.groupReviews += store.deleteReviewsByClaims(claimIds);
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'life_claims'").get();
    if (has) out.claims += db.prepare('DELETE FROM life_claims WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(claimIds)).changes;
  }
  for (const part of chunks(evIds)) out.narrations += store.deleteNarrationsBySourceEvents(part);

  // Parts and narrations from their DM (origin), or citing an event now redacted.
  out.parts += store.deletePartsByOrigins(forms);
  out.narrations += store.deleteNarrationsByOrigins(forms);
  const redacted = db.prepare('SELECT id FROM world_events WHERE redacted = 1 ORDER BY id').pluck().all();
  for (const part of chunks(redacted)) {
    out.parts += store.deletePartsBySourceEvents(part);
    out.narrations += store.deleteNarrationsBySourceEvents(part);
  }
  if (out.reviews || out.groupReviews || out.parts || out.narrations) {
    deps.logger.info({ evt: 'arcs.hook', cause: 'purge', ...out }, 'story: purge applied');
  }
  return out;
}
