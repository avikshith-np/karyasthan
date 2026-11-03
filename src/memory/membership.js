// Group membership: complete, canonical and fresh (spec 006, R3/R4).
//
// The audience rule (recall.js) shares group-origin items with people who were in
// that group when the item was learned, so membership must be COMPLETE (silent
// members included) and FRESH. A full participant sync runs on every connection
// open and every 3 h (armed in src/index.js); until this connection's sync has
// completed for a group, that group is stale and recall shares nothing across it.
//
//   fresh(group) = synced on this connection  AND  synced ≤ 7 h ago  AND  not marked stale
//   fresh(ig)    = ig_sync_state.members_synced_at ≤ 26 h ago (the People screen is read daily)
//
// A sender seen in a group but missing from the map is added (joined now) and the
// group is marked stale until the next sync. Participant ids are canonicalised
// (identity.js) before every add/remove; the bot's own forms and non-person JIDs
// are dropped. Importable without a socket — tests seed freshness with the
// __…ForTest helpers at the bottom.

import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { resolvePerson, recordIdentity, bareJid, isPersonJid, isSelfJid, onIdentityChange } from './identity.js';
import {
  upsertMember, removeMember, logMembership, ensureGroup, setMembersSyncedAt, getMembersSyncedAt,
  getGroupFirstObservedAt, getAllMemberships, getAllGroups, canonicalMemberJid, onMembershipChange,
} from './groupStore.js';

export const IG_GROUP_JID = 'ig:group';
export const FRESH_SEC = 7 * 3600;
export const IG_FRESH_SEC = 26 * 3600;
const MAP_TTL_MS = 60_000;   // safety net for writes that bypass groupStore

const nowSec = () => Math.floor(Date.now() / 1000);

let map = null;                          // { groups: Map<jid, { members: Map<person, joinedAt>, syncedAt }>, byPerson, loadedAt }
const syncedThisConnection = new Map();  // groupJid → unix s of this connection's sync
const staleGroups = new Set();           // sender seen outside the map → stale until next sync
let suppressStale = 0;                   // >0 while a sync / participant event writes rows
let inflight = null;
let lastSync = null;                     // { ok, at, synced: Set<groupJid> } — latest full sync on this connection

export function invalidateMembership() {
  map = null;
}

onMembershipChange(({ groupJid, action, inserted }) => {
  map = null;
  // A member added outside a sync or a participant event (e.g. a direct
  // upsertMember for a new sender) means our picture was incomplete.
  if (action === 'add' && inserted && !suppressStale && groupJid) staleGroups.add(groupJid);
});
onIdentityChange(() => { map = null; });

function loadMap() {
  if (map && Date.now() - map.loadedAt < MAP_TTL_MS) return map;
  const groups = new Map();
  const byPerson = new Map();
  const db = getDb();
  for (const g of db.prepare(`SELECT jid, members_synced_at FROM groups WHERE jid LIKE '%@g.us'`).all()) {
    groups.set(g.jid, { members: new Map(), syncedAt: g.members_synced_at ?? null });
  }
  for (const r of getAllMemberships()) {
    if (!r.group_jid?.endsWith('@g.us')) continue;
    let g = groups.get(r.group_jid);
    if (!g) { g = { members: new Map(), syncedAt: null }; groups.set(r.group_jid, g); }
    g.members.set(r.person_jid, Number.isFinite(r.joined_at) ? r.joined_at : null);
    if (!byPerson.has(r.person_jid)) byPerson.set(r.person_jid, new Set());
    byPerson.get(r.person_jid).add(r.group_jid);
  }
  map = { groups, byPerson, loadedAt: Date.now() };
  return map;
}

// ── Freshness ────────────────────────────────────────────────────────────────

/** Fresh membership for a WhatsApp group or the Instagram group. DMs are trivially fresh. */
export function isFresh(chatJid, now = nowSec()) {
  try {
    if (chatJid === IG_GROUP_JID) return getIgMembership(now).fresh;
    if (!chatJid?.endsWith('@g.us')) return isPersonJid(chatJid);
    if (staleGroups.has(chatJid)) return false;
    const at = syncedThisConnection.get(chatJid);
    if (!at) return false;
    const g = loadMap().groups.get(chatJid);
    const synced = Math.min(at, g?.syncedAt ?? at);
    return now - synced <= FRESH_SEC;
  } catch {
    return false;
  }
}

/** On every connection open, before that connection's sync: nothing is fresh until synced again. */
export function markAllUnsynced() {
  syncedThisConnection.clear();
  lastSync = null;
  map = null;
}

/**
 * May membership-gated maintenance (retention purge, orphaned-voice removal) run?
 * Yes only when this connection's latest full sync succeeded, reconciled at least one
 * group, and every group it reconciled is still fresh. Groups the fetch didn't return
 * (the bot left them) don't block it — their member rows are left as they are.
 * @returns {{ ok: boolean, reason?: string, stale?: string[] }}
 */
export function membershipGate(now = nowSec()) {
  if (!lastSync) return { ok: false, reason: 'no full sync on this connection yet' };
  if (!lastSync.ok) return { ok: false, reason: 'the last full sync had failures' };
  if (!lastSync.synced.size) return { ok: false, reason: 'the last full sync reconciled no groups' };
  const stale = [...lastSync.synced].filter(g => !isFresh(g, now));
  return stale.length ? { ok: false, reason: 'groups stale since the last full sync', stale } : { ok: true };
}

function markGroupSynced(groupJid, at) {
  syncedThisConnection.set(groupJid, at);
  staleGroups.delete(groupJid);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** { members: Map<personJid, joinedAt|null>, syncedAt, fresh } — never throws. Don't mutate `members`. */
export function getMembership(groupJid) {
  try {
    if (groupJid === IG_GROUP_JID) {
      const ig = getIgMembership();
      return { members: ig.members, syncedAt: ig.syncedAt, fresh: ig.fresh };
    }
    const g = loadMap().groups.get(groupJid);
    return { members: g?.members || new Map(), syncedAt: g?.syncedAt ?? null, fresh: isFresh(groupJid) };
  } catch (err) {
    logger.debug({ err: err.message }, 'getMembership failed');
    return { members: new Map(), syncedAt: null, fresh: false };
  }
}

/** Current WhatsApp groups of a canonical person: [{ groupJid, joinedAt }]. */
export function groupsOf(personJid) {
  try {
    const m = loadMap();
    return [...(m.byPerson.get(personJid) || [])].map(g => ({ groupJid: g, joinedAt: m.groups.get(g)?.members.get(personJid) ?? null }));
  } catch {
    return [];
  }
}

/** Every WhatsApp group jid in the map. */
export function allGroupJids() {
  try { return [...loadMap().groups.keys()]; } catch { return []; }
}

export function isCurrentMember(groupJid, personJid) {
  const p = resolvePerson(personJid) || bareJid(personJid);
  return getMembership(groupJid).members.has(p);
}

/**
 * Instagram group: members = linked (person_jid), in-group, non-self rows of ig_members;
 * unlinked = in-group non-self rows with no WhatsApp person (outsiders to us).
 * joinedAt comes from group_membership_log ('ig:group'), null if never logged.
 */
export function getIgMembership(now = nowSec()) {
  const db = getDb();
  const syncedAt = db.prepare('SELECT members_synced_at FROM ig_sync_state WHERE id = 1').pluck().get() ?? null;
  const rows = db.prepare('SELECT username, person_jid FROM ig_members WHERE in_group = 1 AND is_self = 0').all();
  const joins = igOpenJoins(db);
  const members = new Map();
  let unlinked = 0;
  for (const r of rows) {
    const p = r.person_jid ? (resolvePerson(r.person_jid) || bareJid(r.person_jid)) : null;
    if (!p) { unlinked++; continue; }
    members.set(p, joins.get(p) ?? null);
  }
  const fresh = !!syncedAt && now - syncedAt <= IG_FRESH_SEC;
  return { members, unlinked, syncedAt, fresh };
}

// Latest 'join' per person that no later 'leave' closes.
function igOpenJoins(db) {
  const open = new Map();
  for (const r of db.prepare(`SELECT person_jid, action, at FROM group_membership_log
      WHERE group_jid = ? ORDER BY at, id`).all(IG_GROUP_JID)) {
    if (r.action === 'join') open.set(r.person_jid, r.at);
    else open.delete(r.person_jid);
  }
  return open;
}

/**
 * Call after the Instagram People screen was read (igStore.upsertMembers) or a member
 * was linked/unlinked on the dashboard: logs joins/leaves of linked members under
 * 'ig:group' and stamps ig_sync_state. First-ever sync back-dates to the earliest
 * message seen in the thread (R4 rule, Instagram flavour). Never throws.
 */
export function noteIgMembersSynced(at = nowSec(), { markSynced = true } = {}) {
  try {
    const db = getDb();
    db.transaction(() => {
      const first = (db.prepare('SELECT members_synced_at FROM ig_sync_state WHERE id = 1').pluck().get() ?? null) == null;
      const joinAt = first ? (db.prepare('SELECT MIN(seen_at) FROM ig_messages').pluck().get() ?? at) : at;
      const linked = new Set(db.prepare(`SELECT person_jid FROM ig_members
          WHERE in_group = 1 AND is_self = 0 AND person_jid IS NOT NULL`).pluck().all()
        .map(p => resolvePerson(p) || bareJid(p)).filter(Boolean));
      const open = igOpenJoins(db);
      for (const p of linked) if (!open.has(p)) logMembership(IG_GROUP_JID, p, 'join', 'sync', joinAt);
      for (const p of open.keys()) if (!linked.has(p)) logMembership(IG_GROUP_JID, p, 'leave', 'sync', at);
      if (markSynced) db.prepare('UPDATE ig_sync_state SET members_synced_at = ? WHERE id = 1').run(at);
    })();
  } catch (err) {
    logger.warn({ err: err.message }, 'noteIgMembersSynced failed');
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

// All person forms carried by a Baileys participant entry (string or object).
function participantForms(p) {
  const raw = typeof p === 'string' ? [p] : [p?.id, p?.lid, p?.phoneNumber, p?.jid];
  return [...new Set(raw.filter(x => typeof x === 'string').map(bareJid).filter(isPersonJid))];
}

// Record the participant's identities (platform-attested) and return its canonical id.
function canonicalParticipant(p, selfForms) {
  const forms = participantForms(p);
  if (!forms.length) return null;
  if (forms.some(f => isSelfJid(f) || selfForms.has(f))) return null;
  const lid = forms.find(f => f.endsWith('@lid'));
  const pn = forms.find(f => f.endsWith('@s.whatsapp.net'));
  if (lid && pn) recordIdentity(pn, resolvePerson(lid) || lid, 'sync');
  else recordIdentity(lid || pn, resolvePerson(lid || pn) || lid || pn, 'sync');
  return resolvePerson(lid) || resolvePerson(pn) || lid || pn;
}

function roleOf(p) {
  const admin = typeof p === 'object' ? p?.admin : null;
  return admin === 'admin' || admin === 'superadmin' ? admin : 'member';
}

function syncGroup(groupJid, meta, participants, selfForms) {
  const db = getDb();
  const now = nowSec();
  const seen = new Map();   // canonical → role
  for (const p of participants) {
    const person = canonicalParticipant(p, selfForms);
    if (person) seen.set(person, roleOf(p));
  }
  if (!seen.size) return { added: 0, removed: 0, skipped: true };

  const first = getMembersSyncedAt(groupJid) == null;
  const joinAt = first ? (getGroupFirstObservedAt(groupJid) ?? now) : now;
  let added = 0; let removed = 0;
  suppressStale++;
  try {
    db.transaction(() => {
      ensureGroup(groupJid, meta?.subject || null);
      // Existing rows on canonical ids: re-key legacy raw forms, drop non-persons.
      const existing = new Map();
      for (const r of db.prepare('SELECT person_jid, joined_at, role FROM group_members WHERE group_jid = ?').all(groupJid)) {
        const c = canonicalMemberJid(r.person_jid);
        if (c !== r.person_jid) {
          db.prepare('DELETE FROM group_members WHERE group_jid = ? AND person_jid = ?').run(groupJid, r.person_jid);
          if (!c) continue;
          upsertMember(groupJid, c, r.role, r.joined_at);
        }
        const prev = existing.get(c);
        existing.set(c, prev == null ? r.joined_at : Math.max(prev, r.joined_at ?? prev));
      }
      for (const [person, role] of seen) {
        if (existing.has(person)) { upsertMember(groupJid, person, role); continue; }
        upsertMember(groupJid, person, role, joinAt);
        logMembership(groupJid, person, 'join', 'sync', joinAt);
        added++;
      }
      for (const person of existing.keys()) {
        if (seen.has(person)) continue;
        removeMember(groupJid, person);
        logMembership(groupJid, person, 'leave', 'sync', now);
        removed++;
      }
      setMembersSyncedAt(groupJid, now);
    })();
  } finally {
    suppressStale--;
  }
  markGroupSynced(groupJid, now);
  return { added, removed, skipped: false };
}

/**
 * Full participant sync via groupFetchAllParticipating(). Only groups present in the
 * response with a non-empty participant list are reconciled; groups we know that the
 * response lacks are logged as unknown and left untouched (they stay stale).
 * Concurrent calls share one run. Never throws.
 * @returns {Promise<{ ok: boolean, synced: number, added: number, removed: number, empty: number, unknown: number, failed: number }>}
 */
export function syncAllGroups(sock) {
  if (inflight) return inflight;
  inflight = (async () => {
    const summary = { ok: false, synced: 0, added: 0, removed: 0, empty: 0, unknown: 0, failed: 0 };
    let res;
    try {
      res = await sock?.groupFetchAllParticipating?.();
    } catch (err) {
      logger.warn({ err: err.message }, 'Membership sync: fetch failed');
      lastSync = { ok: false, at: nowSec(), synced: new Set() };
      return summary;
    }
    if (!res || typeof res !== 'object') {
      lastSync = { ok: false, at: nowSec(), synced: new Set() };
      return summary;
    }
    const selfForms = new Set([sock?.user?.id, sock?.user?.lid].map(bareJid).filter(Boolean));
    const present = new Set();
    const synced = new Set();
    for (const [key, meta] of Object.entries(res)) {
      const groupJid = meta?.id || key;
      if (!groupJid?.endsWith('@g.us')) continue;
      present.add(groupJid);
      const participants = Array.isArray(meta?.participants) ? meta.participants : [];
      if (!participants.length) { summary.empty++; continue; }
      try {
        const r = syncGroup(groupJid, meta, participants, selfForms);
        if (r.skipped) { summary.empty++; continue; }
        synced.add(groupJid);
        summary.synced++; summary.added += r.added; summary.removed += r.removed;
      } catch (err) {
        summary.failed++;
        logger.warn({ err: err.message, groupJid }, 'Membership sync: group failed');
      }
    }
    try {
      summary.unknown = getAllGroups().filter(g => g.jid.endsWith('@g.us') && !present.has(g.jid)).length;
    } catch { /* counting only */ }
    map = null;
    summary.ok = summary.failed === 0;
    lastSync = { ok: summary.ok, at: nowSec(), synced };
    logger.info(summary, 'Membership sync complete');
    return summary;
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * A message from `personJid` in `groupJid`. Unknown sender → added (joined now),
 * logged, and the group goes stale until the next sync. Returns true if added.
 */
export function noteSender(groupJid, personJid) {
  try {
    if (!groupJid?.endsWith('@g.us')) return false;
    const person = canonicalMemberJid(personJid);
    if (!person) return false;
    if (loadMap().groups.get(groupJid)?.members.has(person)) return false;
    const now = nowSec();
    const { inserted } = upsertMember(groupJid, person, 'member', now);
    if (inserted) {
      logMembership(groupJid, person, 'join', 'message', now);
      staleGroups.add(groupJid);
    }
    map = null;
    return inserted;
  } catch (err) {
    logger.debug({ err: err.message }, 'noteSender failed');
    return false;
  }
}

/**
 * Baileys 'group-participants.update' ({ id, participants, action }), canonicalised.
 * add/remove are applied and logged ('event'); promote/demote update the role. The
 * bot itself being added or removed makes the group stale until the next sync.
 */
export function onParticipantsUpdate({ id, participants, action } = {}, sock = null) {
  try {
    if (!id?.endsWith('@g.us') || !Array.isArray(participants)) return;
    const selfForms = new Set([sock?.user?.id, sock?.user?.lid].map(bareJid).filter(Boolean));
    const now = nowSec();
    suppressStale++;
    try {
      for (const p of participants) {
        const forms = participantForms(p);
        if (forms.some(f => isSelfJid(f) || selfForms.has(f))) {
          staleGroups.add(id);
          syncedThisConnection.delete(id);
          continue;
        }
        const person = canonicalParticipant(p, selfForms);
        if (!person) continue;
        if (action === 'add') {
          const { inserted } = upsertMember(id, person, 'member', now);
          if (inserted) logMembership(id, person, 'join', 'event', now);
        } else if (action === 'remove') {
          const { changes } = removeMember(id, person);
          if (changes) logMembership(id, person, 'leave', 'event', now);
        } else if (action === 'promote' || action === 'demote') {
          upsertMember(id, person, action === 'promote' ? 'admin' : 'member');
        }
      }
    } finally {
      suppressStale--;
    }
    map = null;
  } catch (err) {
    logger.warn({ err: err.message, groupJid: id }, 'Participant update failed');
  }
}

// ── Test helpers (scratch DBs only) ──────────────────────────────────────────

/** Mark a group synced on this connection at `syncedAt` (default now) and clear its stale flag. */
export function __markSyncedForTest(groupJid, { syncedAt = nowSec() } = {}) {
  setMembersSyncedAt(groupJid, syncedAt);
  markGroupSynced(groupJid, syncedAt);
  map = null;
}

/** Set ig_sync_state.members_synced_at (null = never synced). */
export function __setIgSyncedForTest(syncedAt = nowSec()) {
  getDb().prepare('UPDATE ig_sync_state SET members_synced_at = ? WHERE id = 1').run(syncedAt);
}

/** Forget all in-memory state (as after a restart). */
export function __resetMembershipForTest() {
  syncedThisConnection.clear();
  staleGroups.clear();
  lastSync = null;
  map = null;
}
