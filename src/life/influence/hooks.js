// Chat influence deletion hooks (spec 012 plan §P1.5, pattern story/hooks.js).
// DB-only on the 006 side: they touch the v12 tables through store.js, never the
// projection, so they work with life stopped, detached, or never booted.
//
//   registerHooks()   once per process, idempotent; the life facade calls it
//                     BEFORE its enabled check. Registers:
//     - 006 onItemsDeleted (forget | revoke | edit in chat X): active items (and
//       pending advice, which has no pointer and simply leaves the tray) of X
//       naming one of the message ids — a forget also every item of X made in
//       [now − 20 min, now + 10 min] — go `withdrawn`; held ones are deleted. The
//       world half (revert of each withdrawn item's chat.perceived pointer, whose
//       engine consequences — mood.chat, sleep.delayed — cascade out) is
//       applyPendingWithdrawals(): right after the 006 transaction (setImmediate),
//       on every tick and at boot, also with the skill off.
//       A failure is caught: our savepoint rolls back, the request is PERSISTED
//       (chat_influence_pending_withdrawals) with chat_influence_state.degraded =
//       1, `chatInfluence.hook.fail` is audited, and the user's deletion stands.
//       While degraded, every influence entry point and the mood overlay are off;
//       it clears only once no persisted request is left.
//     - 006 onPersonPurged → every item the person sent or of their DM is
//       deleted. Errors PROPAGATE (the purge rolls back). The world side is 009's
//       eventLog.redactPerson (pointers carry the person as subject/origin).
//
// Logging: ids, counts and causes only.

import * as store from './store.js';
import { getDb } from '../../memory/db.js';
// Namespace imports, used lazily at call time (relationshipStore → life/index.js →
// influence → here is a cycle; story/hooks.js resolves it the same way).
import * as relationshipStore from '../../memory/relationshipStore.js';
import * as identity from '../../memory/identity.js';
import { logger } from '../../utils/logger.js';
import { now as clockNow } from '../clock.js';
import { revertEvent as logRevert } from '../eventLog.js';

const MIN = 60;
const FORGET_BEFORE_SEC = 20 * MIN;
const FORGET_AFTER_SEC = 10 * MIN;
const CHAT_CAUSES = new Set(['forget', 'revoke', 'edit']);
const FORMS_MAX = 32;
const TRIGGER_REVERT = 'trigger_revert:';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = (a) => [...new Set(a)];

const DEFAULT_DEPS = {
  now: () => clockNow(),
  db: () => getDb(),
  auditWrite: (...args) => import('../../dashboard/audit.js').then(m => m.auditWrite(...args)).catch(() => {}),
  relationshipStore: () => relationshipStore,
  // The facade's revert (rebuilds the live projection); null → the log only (life stopped).
  revert: null,
  logger,
};
let deps = { ...DEFAULT_DEPS };
let registered = false;
let unsubscribe = [];
let degraded = null;          // in-memory marker { at, cause } (also set when the DB write failed)
let degradedLoaded = false;
let applying = false;

/** Test seam: replace deps (null restores the defaults and forgets the registration). */
export function __setDepsForTest(over) {
  if (over === null) {
    for (const off of unsubscribe) { try { off?.(); } catch { /* best effort */ } }
    unsubscribe = [];
    registered = false;
    degraded = null;
    degradedLoaded = false;
    deps = { ...DEFAULT_DEPS };
    return;
  }
  deps = { ...deps, ...(isObj(over) ? over : {}) };
}

/** Production seam (the facade at attach/detach): { revert }. */
export function configure(over = {}) {
  if (isObj(over)) deps = { ...deps, ...over };
}

// ── Degraded ──────────────────────────────────────────────────────────────

/** True after a hook failure until every persisted request was applied. Fails closed. */
export function isDegraded() {
  if (degraded) return true;
  if (!degradedLoaded) {
    try {
      degradedLoaded = true;
      if (store.getStateValue('degraded') === '1') degraded = { at: null, cause: 'persisted' };
    } catch {
      degradedLoaded = false;
      return true;
    }
  }
  return degraded !== null;
}

function markDegraded(cause, err) {
  const at = Math.floor(deps.now());
  degraded = { at, cause };
  deps.logger.warn({ evt: 'issue', where: 'chatInfluence.hooks', cause, err: err?.code || err?.name || 'error' },
    'chat influence: deletion hook failed (degraded)');
  try {
    const r = deps.auditWrite('system:chatInfluence', 'chatInfluence.hook.fail', null,
      { cause, code: String(err?.code || err?.name || 'error').slice(0, 40) });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* audit is best effort */ }
}

// ── Registration ──────────────────────────────────────────────────────────

/** Register the 006 listeners once per process (idempotent, synchronous, never throws). */
export function registerHooks() {
  if (registered) return true;
  registered = true;
  try {
    const rs = deps.relationshipStore();
    if (typeof rs.onItemsDeleted === 'function') unsubscribe.push(rs.onItemsDeleted(handleItemsDeleted));
    if (typeof rs.onPersonPurged === 'function') unsubscribe.push(rs.onPersonPurged((db, person, forms) => onPurged(db, forms?.length ? forms : [person])));
    return true;
  } catch (err) {
    registered = false;
    deps.logger.warn({ evt: 'issue', where: 'chatInfluence.hooks', err: err?.code || err?.name || 'error' }, 'chat influence: hook registration failed');
    return false;
  }
}

/** True once registerHooks() succeeded. */
export function hooksRegistered() {
  return registered;
}

// ── Canonical forms ───────────────────────────────────────────────────────

/** Every stored form of these chat ids: as given, bare (device suffix off), and the DM person's canonical id. */
export function canonicalForms(list) {
  const out = [];
  for (const j of (Array.isArray(list) ? list : [list])) {
    if (typeof j !== 'string' || !j) continue;
    out.push(j);
    let bare = null;
    try { bare = identity.bareJid(j); } catch { bare = null; }
    if (bare) out.push(bare);
    if (bare && !bare.endsWith('@g.us')) {
      try {
        const p = identity.resolvePerson(bare);
        if (p) out.push(p);
      } catch { /* the given forms still match */ }
    }
  }
  return uniq(out).slice(0, FORMS_MAX);
}

// ── forget / revoke / edit ────────────────────────────────────────────────

function formsOf(evt) {
  const forms = Array.isArray(evt?.chatForms) ? evt.chatForms.filter(j => typeof j === 'string' && j) : [];
  if (typeof evt?.chatJid === 'string' && evt.chatJid) forms.push(evt.chatJid);
  return canonicalForms(forms);
}

function applyRequest(db, req, at) {
  const window = req.cause === 'forget' ? { lo: at - FORGET_BEFORE_SEC, hi: at + FORGET_AFTER_SEC } : null;
  const res = store.withdrawMatching(db, { chatForms: req.chatForms, msgIds: req.msgIds, window, reason: req.cause });
  return { ...res, triggers: markTriggers(db, req, window) };
}

// 020 (final review 12): a chat line's nudge on his own plan. Its chat.trigger names the line; the revert
// (the lean and a commit it nudged follow, eventLog.cascadeIds) runs after the 006 transaction like the
// withdrawn items' pointers, from a request written here, so a crash in between loses nothing.
function markTriggers(db, req, window) {
  const rows = db.prepare(`SELECT id FROM world_events WHERE type = 'chat.trigger' AND redacted = 0
    AND origin_jid IN (SELECT value FROM json_each(?))
    AND (json_extract(payload_json, '$.msgId') IN (SELECT value FROM json_each(?))
      OR (? IS NOT NULL AND at BETWEEN ? AND ?))`)
    .all(JSON.stringify(req.chatForms), JSON.stringify(req.msgIds), window?.lo ?? null, window?.lo ?? null, window?.hi ?? null);
  for (const r of rows) store.setStateValue(`${TRIGGER_REVERT}${r.id}`, req.cause, db);
  return rows.length;
}

/**
 * 006 onItemsDeleted listener: fn(db, {chatJid, chatForms, msgIds, cause, msgTs?}).
 * Synchronous. A failure never undoes the user's deletion.
 */
export function handleItemsDeleted(db, evt) {
  const cause = evt?.cause;
  if (!CHAT_CAUSES.has(cause)) return null;
  const conn = db && typeof db.transaction === 'function' ? db : deps.db();
  const at = Math.floor(deps.now());
  const req = { cause, chatForms: formsOf(evt), msgIds: Array.isArray(evt?.msgIds) ? evt.msgIds.map(String) : [], msgTs: evt?.msgTs ?? null };
  if (!req.chatForms.length) return null;
  try {
    const res = conn.transaction(() => applyRequest(conn, req, at))();
    if (res.withdrawn || res.held || res.triggers) {
      deps.logger.info({ evt: 'chatInfluence.hook', cause, withdrawn: res.withdrawn, held: res.held, triggers: res.triggers }, 'chat influence: deletion applied');
      scheduleApply();
    }
    return res;
  } catch (err) {
    try {
      store.addPendingWithdrawal(conn, { ...req, at });
      store.setStateValue('degraded', '1', conn);
    } catch { /* the in-memory marker and the tick's evidence sweep still hold */ }
    markDegraded(cause, err);
    return null;
  }
}

function scheduleApply() {
  setImmediate(() => {
    try { applyPendingWithdrawals(); } catch { /* retried on the next tick */ }
  });
}

/**
 * Apply what the hooks recorded: re-run every persisted request, then revert the
 * pointer of every withdrawn item (its engine consequences cascade). Clears the
 * degraded flag once no request is left. → { requests, reverted, failed }
 */
export function applyPendingWithdrawals() {
  const out = { requests: 0, reverted: 0, failed: 0 };
  if (applying) return out;
  applying = true;
  try {
    const db = deps.db();
    const at = Math.floor(deps.now());
    let left = 0;
    for (const req of store.listPendingWithdrawals()) {
      try {
        db.transaction(() => { applyRequest(db, req, at); store.deletePendingWithdrawal(req.id); })();
        out.requests++;
      } catch {
        left++;
      }
    }
    for (const item of store.listWithdrawn()) {
      try {
        if (Number.isSafeInteger(item.pointerEventId)) {
          const opts = { reason: 'withdrawn', by: 'system:withdrawn' };
          if (typeof deps.revert === 'function') deps.revert(item.pointerEventId, opts);
          else logRevert(item.pointerEventId, { ...opts, at });
        }
        store.markReverted(item.id);
        out.reverted++;
      } catch {
        out.failed++;
      }
    }
    for (const key of store.stateKeys(TRIGGER_REVERT)) {
      try {
        const id = Number(key.slice(TRIGGER_REVERT.length));
        const opts = { reason: 'withdrawn', by: 'system:withdrawn' };
        if (typeof deps.revert === 'function') deps.revert(id, opts);
        else logRevert(id, { ...opts, at });
        store.setStateValue(key, null);
        out.reverted++;
      } catch {
        out.failed++;
      }
    }
    if (!left && !out.failed && store.countPendingWithdrawals() === 0) {
      if (degraded || store.getStateValue('degraded') === '1') {
        store.setStateValue('degraded', null);
        degraded = null;
        deps.logger.info({ evt: 'chatInfluence.hook', requests: out.requests }, 'chat influence: degraded cleared');
      }
    }
    if (out.reverted) deps.logger.info({ evt: 'chatInfluence.hook', reverted: out.reverted }, 'chat influence: withdrawals reverted');
  } catch (err) {
    deps.logger.warn({ evt: 'issue', where: 'chatInfluence.withdraw', err: err?.code || err?.name || 'error' }, 'chat influence: withdrawals not applied');
  } finally {
    applying = false;
  }
  return out;
}

// ── purge ─────────────────────────────────────────────────────────────────

/** Purge of a person (every identity form), inside purgePerson's transaction. Errors propagate. */
export function onPurged(db, forms) {
  const conn = db && typeof db.prepare === 'function' ? db : deps.db();
  const n = store.deleteForPerson(conn, canonicalForms(forms));
  if (n) deps.logger.info({ evt: 'chatInfluence.hook', cause: 'purge', items: n }, 'chat influence: purge applied');
  return n;
}
