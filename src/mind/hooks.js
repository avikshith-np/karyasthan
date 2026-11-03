// Mind handlers for 006's deletion, purge and identity events (spec 008, research R9,
// data-model "Identity, deletion and purge obligations").
//
//   handleItemsDeleted(db, {chatJid, chatForms, msgIds, cause, byType, episodes})
//       relationshipStore.onItemsDeleted, fired INSIDE the 006 transaction of
//       forgetRecent / onMessageRevoked / onMessageEdited / purgePerson, after
//       deleteItems. It:
//         1. writes mind_episode_log for every deleted daily episode (`episodes`:
//            [{id, originJid, attribute}], read by 006 before the delete)
//            (forget → fenced, revoke/edit → deleted + rebuild_requested, purge →
//            deleted, owner (a dashboard delete) → tombstoned), and for a forget also fences the chat's current night(s), so the
//            next sleep writes no episode for that chat-night (the forgotten lines are
//            already no_learn; a fenced night is never built or rebuilt);
//         2. un-supersedes the dailies of a deleted weekly: their ids come from
//            mindReads.episodesFor (superseded included) and relationshipStore.unsupersede
//            clears the dead pointer — the src/mind tree never touches `memories`;
//         3. cancels the chat's drafting|queued proactive rows (content_changed) and
//            nulls the text of its shadow|would_send rows (proactive.cancelForChat),
//            rows of other chats whose basis origins name it included;
//         4. nulls mind free text tied to that chat (store.nullFreeText).
//         For revoke/edit with a known message time (evt.msgTs), 3 and 4 touch only rows
//         made at or after it (less 5 min of clock skew): nothing older saw the message;
//         for owner the same with the deleted memory's created_at.
//       For forget/revoke/edit a failure is caught (a mind bug must never undo a
//       revoke): logged evt:'issue' (codes only), audited mind.hook.fail, and the mind
//       goes *degraded* — no self-state line, no dispatch — until the pulse recovers.
//       The handler's own writes run in a savepoint, so a failure leaves none behind.
//       For purge errors propagate and roll the purge back (009 redactPerson contract).
//   handlePersonPurged(db, person, forms)
//       relationshipStore.onPersonPurged, inside purgePerson's transaction, NO try/catch:
//       cancels pending drafts whose audience/origins involve the person, deletes their
//       DM-keyed mind rows (exclusions are kept), nulls free text naming them and all
//       mind free text of the last 7 days.
//   handleIdentityChange(change)
//       identity.onIdentityChange (merge / record / reassign) → store.rekey. identity.js
//       swallows listener errors, so this wraps its own body: evt:'issue' + audit
//       mind.identity.fail + degraded.
//
// The degraded state lives here (isDegraded / degradedInfo / markDegraded /
// clearDegraded / restoreDegraded), mirrored in mind_settings so it survives a
// restart; the pulse clears it after knobs.reload() + store.selfCheck().
// Nothing here logs chat- or model-derived text: ids, causes, counts, error codes.

import * as store from './store.js';
import * as stance from './stance.js';
import * as relationshipStore from '../memory/relationshipStore.js';
import { onIdentityChange } from '../memory/identity.js';
import { chatKeyOf } from '../memory/learningPipeline.js';
import { auditWrite } from '../dashboard/audit.js';
import { logger } from '../utils/logger.js';
import { now as clockNow, nightKey, daysBeforeKey } from './clock.js';
import * as mindReads from '../memory/mindReads.js';

const DAY = 86400;
const FORGET_WINDOW_SEC = 600;   // forgetRecent only fences lines from the last 10 minutes
const EDIT_SKEW_SEC = 300;       // a sender's clock may run ahead of ours
const daysAfterKey = (key, n) => daysBeforeKey(key, -n);

/** cancelForChat(forms, reason, {since}): proactive.js owns the real one; this is the same rule on store primitives. */
function storeCancelForChat(forms, reason = 'content_changed', { since = null } = {}) {
  const list = (forms || []).filter(Boolean);
  if (!list.length) return { dropped: 0, nulled: 0 };
  const window = Number.isFinite(Number(since)) && since !== null ? { createdSince: Math.floor(Number(since)) } : {};
  const dropped = store.updateDraftsWhere({ chatForms: list, statuses: store.DRAFT_PENDING, matchOrigins: true, ...window },
    { status: 'dropped', dropReason: reason, intent: null, voicedText: null, altText: null });
  const nulled = store.updateDraftsWhere({ chatForms: list, statuses: ['shadow', 'would_send'], matchOrigins: true, ...window },
    { intent: null, voicedText: null, altText: null });
  return { dropped, nulled };
}

const DEFAULT_DEPS = {
  now: () => clockNow(),
  auditWrite,
  logger,
  cancelForChat: storeCancelForChat,
  unsupersede: (ids) => (typeof relationshipStore.unsupersede === 'function' ? relationshipStore.unsupersede(ids) : 0),
  onItemsDeleted: (fn) => (typeof relationshipStore.onItemsDeleted === 'function' ? relationshipStore.onItemsDeleted(fn) : null),
  onPersonPurged: (fn) => (typeof relationshipStore.onPersonPurged === 'function' ? relationshipStore.onPersonPurged(fn) : null),
  onIdentityChange: (fn) => onIdentityChange(fn),
  rekey: (change) => store.rekey(change),
  episodesFor: (chatJid, opts) => mindReads.episodesFor(chatJid, opts),
};
let deps = { ...DEFAULT_DEPS };

/** Test seam: replace any of { now, auditWrite, logger, cancelForChat, unsupersede, onItemsDeleted, onPersonPurged, onIdentityChange, rekey, episodesFor }. null resets. */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

// ── degraded state ───────────────────────────────────────────────────────────

let degraded = null;   // { at, source, cause }

/** True while a mind hook failure has not been recovered (no self-state line, no dispatch). */
export function isDegraded() {
  return degraded !== null;
}

/** { at, source, cause } of the failure, or null. */
export function degradedInfo() {
  return degraded ? { ...degraded } : null;
}

/**
 * Enter the degraded state (the earliest failure time is kept). Also stored
 * (mind_settings 'degraded'), so a restart before the pulse recovers keeps it; a
 * failed write keeps the in-memory marker (never throws).
 */
export function markDegraded(source, cause = null) {
  const at = Math.floor(deps.now());
  if (!degraded) {
    degraded = { at, source: String(source || 'unknown').slice(0, 40), cause: cause ? String(cause).slice(0, 40) : null };
    try { store.setDegraded(degraded); } catch (err) {
      try { deps.logger.warn({ evt: 'issue', where: 'mind.hooks.degraded', code: errCode(err) }, 'mind: degraded marker not stored'); } catch { /* never throws */ }
    }
  }
  return degradedInfo();
}

/** Leave the degraded state (the pulse calls this after a successful self-check). Throws when the stored marker can't be cleared. */
export function clearDegraded() {
  store.setDegraded(null);
  const was = degraded;
  degraded = null;
  return was;
}

/** Boot (startMind): pick up a degraded marker stored before a restart. Never throws. */
export function restoreDegraded() {
  try {
    const d = store.getDegraded();
    if (d && !degraded) degraded = { at: d.at ?? Math.floor(deps.now()), source: d.source, cause: d.cause };
  } catch { /* stays as it was */ }
  return degradedInfo();
}

/** Test seam: forget the in-memory marker only (a simulated restart). */
export function __resetDegradedMemoryForTest() {
  degraded = null;
}

function errCode(err) {
  return String(err?.code || err?.name || 'error').slice(0, 60);
}

function fail(source, action, target, cause, err) {
  try {
    deps.logger.warn({ evt: 'issue', where: `mind.hooks.${source}`, cause: cause || null, code: errCode(err) },
      'mind hook failed; mind degraded until recovery');
  } catch { /* logging must not throw */ }
  try {
    deps.auditWrite('mind', action, target ? String(target).slice(0, 200) : null,
      { source, cause: cause || null, code: errCode(err) });
  } catch { /* auditWrite already swallows */ }
  markDegraded(source, cause);
}

// ── onItemsDeleted ───────────────────────────────────────────────────────────

const unique = (list) => [...new Set(list.filter(x => typeof x === 'string' && x))];

function formsOf(evt) {
  const forms = [...(Array.isArray(evt.chatForms) ? evt.chatForms : []), evt.chatJid];
  let key = null;
  try { key = evt.chatJid ? chatKeyOf(evt.chatJid) : null; } catch { key = null; }
  if (key) forms.push(key);
  return { forms: unique(forms), key: key || (typeof evt.chatJid === 'string' ? evt.chatJid : null) };
}

const DAY_ATTR = /^day:(\d{4}-\d{2}-\d{2})$/;
const WEEK_ATTR = /^week:(\d{4}-\d{2}-\d{2})$/;

function logOutcome(chatJid, nk, cause, memoryId) {
  const fields = cause === 'forget' ? { outcome: 'fenced', cause: 'forget' }
    : cause === 'revoke' || cause === 'edit' ? { outcome: 'deleted', cause, rebuildRequested: true }
      : cause === 'purge' ? { outcome: 'deleted', cause: 'purge' }
        // The owner deleted the episode on the dashboard: tombstoned (never rebuilt).
        : cause === 'owner' ? { outcome: 'tombstoned', cause: null } : null;
  if (!fields) return false;
  if (Number.isFinite(Number(memoryId))) fields.memoryId = Number(memoryId);
  store.logEpisodeNight(chatJid, nk, fields);
  return true;
}

function itemsDeletedBody(evt) {
  const cause = evt.cause;
  const { forms, key } = formsOf(evt);
  const memIds = (evt.byType?.memory || []).map(Number).filter(Number.isFinite);
  const episodes = (Array.isArray(evt.episodes) ? evt.episodes : [])
    .filter(e => e && typeof e.originJid === 'string' && typeof e.attribute === 'string');
  const out = { episodeNights: 0, fencedNights: 0, unsuperseded: 0, drafts: null, freeText: null };

  // 1. Episode-log outcomes for deleted daily episodes: from the episode rows 006 read
  //    before the delete ({id, originJid, attribute}), plus any log row citing a deleted id.
  const done = new Set();
  for (const e of episodes) {
    const m = e.attribute.match(DAY_ATTR);
    if (!m) continue;
    const k = `${e.originJid}|${m[1]}`;
    if (done.has(k)) continue;
    done.add(k);
    if (logOutcome(e.originJid, m[1], cause, e.id)) out.episodeNights++;
  }
  for (const row of store.episodeNightsForMemories(memIds)) {
    const k = `${row.chatJid}|${row.nightKey}`;
    if (done.has(k)) continue;
    done.add(k);
    if (logOutcome(row.chatJid, row.nightKey, cause, row.memoryId)) out.episodeNights++;
  }

  // 2. A deleted weekly ('week:<first NK>') leaves its seven dailies pointing at a dead
  //    superseder: find them (mindReads, superseded included) and let 006 clear them.
  const dailyIds = [];
  for (const e of episodes) {
    const m = e.attribute.match(WEEK_ATTR);
    if (!m) continue;
    const attrs = Array.from({ length: 7 }, (_, i) => `day:${daysAfterKey(m[1], i)}`);
    for (const d of deps.episodesFor(e.originJid, { attributes: attrs, current: false }) || []) {
      if (Number.isFinite(Number(d?.id))) dailyIds.push(Number(d.id));
    }
  }
  if (dailyIds.length) out.unsuperseded = Number(deps.unsupersede([...new Set(dailyIds)])) || 0;

  // A forget fences the chat-night(s) of the forgotten lines (all within the last 10 min),
  // unless an episode of that night is still standing.
  if (cause === 'forget' && key) {
    const t = Math.floor(deps.now());
    for (const nk of unique([nightKey(t), nightKey(t - FORGET_WINDOW_SEC)])) {
      const cur = store.episodeNight(key, nk);
      if (cur && cur.outcome === 'written' && !memIds.includes(Number(cur.memoryId))) continue;
      store.logEpisodeNight(key, nk, { outcome: 'fenced', cause: 'forget' });
      out.fencedNights++;
    }
  }

  // 3. Drafts of this chat (or based on it); 4. free text tied to it. A revoke/edit with
  //    a known message time touches only rows made at or after it (less a clock-skew
  //    margin): an older draft or run cannot contain the message. Unknown time → all.
  if (forms.length) {
    // (owner: msgTs is the deleted memory's created_at — nothing older could have used it.)
    const since = (cause === 'revoke' || cause === 'edit' || cause === 'owner') && Number.isFinite(evt.msgTs) ? evt.msgTs - EDIT_SKEW_SEC : null;
    out.drafts = deps.cancelForChat(forms, 'content_changed', since === null ? {} : { since });
    out.freeText = store.nullFreeText({ chatForms: forms, ...(since === null ? {} : { sinceAt: since }) });
    // 5. what that chat did to his interests and opinions (plan 020 B); a forget covers its window only.
    const stanceSince = cause === 'forget' ? Math.floor(deps.now()) - FORGET_WINDOW_SEC - EDIT_SKEW_SEC : since;
    out.stanceEvidence = stance.removeEvidenceFor(forms, { ...(stanceSince === null ? {} : { since: stanceSince }), memoryIds: memIds, keepCited: cause === 'owner' });
    // What he told himself he'd do, resting on that chat: active elements stay active otherwise, and the
    // thought stream would raise them again after its own rows were deleted (final review 13).
    if (cause !== 'owner') out.elements = store.supersedeElementsOf(forms, since === null ? {} : { since });
  }
  return out;
}

/**
 * relationshipStore.onItemsDeleted listener. evt: { chatJid, chatForms, msgIds, cause:
 * 'forget'|'revoke'|'edit'|'purge'|'owner', byType }. Returns counts (or null after a caught failure).
 */
export function handleItemsDeleted(db, evt = {}) {
  const run = () => (db && typeof db.transaction === 'function' ? db.transaction(() => itemsDeletedBody(evt))() : itemsDeletedBody(evt));
  if (evt.cause === 'purge') return run();   // errors propagate: the purge rolls back
  try {
    return run();
  } catch (err) {
    fail('itemsDeleted', 'mind.hook.fail', formsOf(evt).key, evt.cause, err);
    return null;
  }
}

// ── onPersonPurged ───────────────────────────────────────────────────────────

function mentionsAny(json, forms) {
  if (json == null) return false;
  const s = typeof json === 'string' ? json : JSON.stringify(json);
  return forms.some(f => s.includes(JSON.stringify(f)));
}

/** relationshipStore.onPersonPurged listener: no try/catch — an error rolls the purge back. */
export function handlePersonPurged(db, person, forms = []) {
  const list = unique([person, ...(Array.isArray(forms) ? forms : [])]);
  if (!list.length) return { drafts: 0 };
  // Pending drafts elsewhere (a group) whose basis origins or audience snapshot name them.
  let drafts = 0;
  for (const d of store.listDrafts({ status: store.DRAFT_PENDING, limit: 100 })) {
    if (list.includes(d.chatJid) || list.includes(d.personJid) || mentionsAny(d.origins, list) || mentionsAny(d.audience, list)) {
      drafts += store.updateDraft(d.id, { status: 'dropped', dropReason: 'content_changed', intent: null, voicedText: null,
        altText: null });
    }
  }
  const stanceEvidence = stance.removeEvidenceFor(list);
  const deleted = store.deleteDmRows(db, list);
  const named = store.nullFreeText({ chatForms: list });
  const recent = store.nullFreeText({ sinceAt: Math.floor(deps.now()) - 7 * DAY });
  return { drafts, deleted, stanceEvidence, freeText: { named, recent } };
}

// ── onIdentityChange ─────────────────────────────────────────────────────────

/** identity.onIdentityChange listener (merge / record / reassign). Never throws. */
export function handleIdentityChange(change = {}) {
  try {
    if (!change || !['merge', 'record', 'reassign'].includes(change.type)) return null;
    const out = deps.rekey(change);
    if (change.type === 'reassign') stance.recomputeAll();   // the old owner's DM evidence went with the rekey
    return out;
  } catch (err) {
    fail('identity', 'mind.identity.fail', change?.keepJid || change?.personJid || null, change?.type, err);
    return null;
  }
}

// ── registration (startMind, T020) ───────────────────────────────────────────

let unregister = null;

/**
 * Subscribe the three handlers. Idempotent. opts.cancelForChat lets the facade wire
 * proactive.cancelForChat (default: the same rule on store primitives). The 006 seams
 * are feature-detected until the memory lane's relationshipStore additions land.
 * → { itemsDeleted, personPurged, identity } (booleans: which seams were found)
 */
export function registerHooks(opts = {}) {
  if (typeof opts.cancelForChat === 'function') deps.cancelForChat = opts.cancelForChat;
  if (unregister) return unregister.status;
  const offs = [];
  const status = { itemsDeleted: false, personPurged: false, identity: false };
  const a = deps.onItemsDeleted(handleItemsDeleted);
  if (typeof a === 'function') { offs.push(a); status.itemsDeleted = true; }
  const b = deps.onPersonPurged(handlePersonPurged);
  if (typeof b === 'function') { offs.push(b); status.personPurged = true; }
  const c = deps.onIdentityChange(handleIdentityChange);
  if (typeof c === 'function') { offs.push(c); status.identity = true; }
  unregister = { offs, status };
  if (!status.itemsDeleted || !status.personPurged) {
    try { deps.logger.warn({ evt: 'issue', where: 'mind.hooks.register', ...status }, 'mind: a 006 deletion seam is missing'); }
    catch { /* ignore */ }
  }
  return status;
}

/** Undo registerHooks (stopMind, tests). */
export function unregisterHooks() {
  if (!unregister) return;
  for (const off of unregister.offs) { try { off(); } catch { /* ignore */ } }
  unregister = null;
}
