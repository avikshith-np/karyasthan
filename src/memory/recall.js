// The one audience-filtered read path for remembered things (spec 006, R1/R6,
// contracts/recall.md). Every surface builds an Audience — the people who will see
// the output — and reads memories, facets, nicknames, relationships, slang and
// imitation exemplars through here. The filter runs in SQL before anything reaches
// a prompt; no prompt line is relied on for privacy (constitution II).
//
// The rule, for an item from origin chat X used in output chat Y:
//   1. Y == X → usable.
//   2. DM- and call-origin items → only in Y == X (never via the subset path).
//   3. Group/IG-origin items in Y ≠ X → members(Y) non-empty, no outsiders, X and Y
//      both fresh, and every member of Y is a current member of X who joined at or
//      before the item's learned_at.
//   4. Derived items (item_origins rows) → rule 1–3 for EVERY contributing origin.
//   5. Self-origin, underived, subject-less → anywhere. The bot's own chat gets nothing.
//   Owner notes (origin 'owner') follow their visibility: 'subject_dm' (default) →
//   the subject's DM; 'subject_groups' → plus fresh, outsider-free chats the subject
//   is in; 'everywhere' → anywhere. A NULL-subject owner note needs 'everywhere'.
//
// Fail closed: any error → only the current chat's own items plus underived,
// subject-less self items (logged 'recall_fail_closed', never with content).

import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { sanitizeWebContent } from '../brain/webSearch.js';
import { resolvePerson, identitiesOf, bareJid, isPersonJid, isSelfJid } from './identity.js';
import { getMembership, groupsOf, isFresh, getIgMembership, IG_GROUP_JID } from './membership.js';

// 'episode' (spec 008): the mind's per-chat summaries. Default recall (no kinds) leaves
// them out so they don't crowd facts; recallEpisodes() is their read path.
const KINDS = new Set(['fact', 'event', 'temporary', 'interest', 'lore', 'preference', 'episode']);
const nowSec = () => Math.floor(Date.now() / 1000);
const marks = (n) => Array(n).fill('?').join(',');

/**
 * @typedef {{ chatJid: string|null, kind: 'group'|'dm'|'ig'|'call'|'self', members: Set<string>,
 *   outsiders: boolean, fresh: boolean, personJid?: string|null, sameChat?: string[] }} Audience
 */

function emptyAudience(chatJid, kind) {
  return { chatJid: chatJid || null, kind, members: new Set(), outsiders: true, fresh: false, personJid: null,
    sameChat: chatJid ? [bareJid(chatJid) || chatJid] : [] };
}

function igSendersUnknown(senders) {
  if (!Array.isArray(senders) || !senders.length) return false;
  const find = getDb().prepare(`SELECT person_jid, is_self, in_group FROM ig_members
    WHERE username = ? OR display_name = ? ORDER BY in_group DESC LIMIT 1`);
  return senders.some(s => {
    const m = s ? find.get(String(s), String(s)) : null;
    if (m?.is_self) return false;
    return !m || !m.in_group || !m.person_jid;
  });
}

/**
 * Who will see the output. Never throws (an error yields an outsider-only audience).
 * Extra, optional: `senders` (Instagram thread senders this turn; any unknown or
 * unlinked one sets outsiders).
 * @returns {Audience}
 */
export function resolveAudience({ chatJid = null, kind, personJid = null, senders = null } = {}) {
  try {
    const k = kind || (chatJid?.endsWith('@g.us') ? 'group'
      : chatJid === IG_GROUP_JID || chatJid?.startsWith?.('ig:') ? 'ig'
        : 'dm');

    if (k === 'group') {
      if (!chatJid?.endsWith('@g.us')) return emptyAudience(chatJid, 'group');
      const m = getMembership(chatJid);
      return { chatJid, kind: 'group', members: new Set(m.members.keys()), outsiders: false, fresh: m.fresh,
        personJid: null, sameChat: [chatJid] };
    }

    if (k === 'ig') {
      const ig = getIgMembership();
      return { chatJid: IG_GROUP_JID, kind: 'ig', members: new Set(ig.members.keys()),
        outsiders: ig.unlinked > 0 || igSendersUnknown(senders), fresh: ig.fresh, personJid: null,
        sameChat: [IG_GROUP_JID] };
    }

    // dm / call: the audience is one person. A call's chat is the caller's DM.
    const raw = k === 'call' ? (personJid || chatJid) : chatJid;
    if (raw && isSelfJid(raw)) {
      return { chatJid: bareJid(raw), kind: 'self', members: new Set(), outsiders: false, fresh: false, personJid: null, sameChat: [] };
    }
    // resolvePerson also takes a bare phone number (calls); unknown → outsider audience.
    const p = raw ? resolvePerson(raw) : null;
    if (!p) return emptyAudience(isPersonJid(raw) ? raw : null, k === 'call' ? 'call' : 'dm');
    const sameChat = [...new Set([...identitiesOf(p), ...(isPersonJid(raw) ? [bareJid(raw)] : [])])];
    return { chatJid: k === 'call' ? p : chatJid, kind: k === 'call' ? 'call' : 'dm', members: new Set([p]),
      outsiders: false, fresh: true, personJid: p, sameChat };
  } catch (err) {
    logger.warn({ err: err.message }, 'resolveAudience failed — outsider audience');
    return emptyAudience(chatJid, kind === 'call' ? 'call' : kind === 'group' ? 'group' : kind === 'ig' ? 'ig' : 'dm');
  }
}

function sameChatOf(audience) {
  if (!audience || audience.kind === 'self') return [];
  if (Array.isArray(audience.sameChat)) return audience.sameChat;
  if (!audience.chatJid) return [];
  if (audience.kind === 'dm' || audience.kind === 'call') {
    const p = audience.personJid || resolvePerson(audience.chatJid);
    return p ? [...new Set([...identitiesOf(p), bareJid(audience.chatJid)])] : [bareJid(audience.chatJid)];
  }
  return [audience.chatJid];
}

// Every member's join time in `members` (a Map) → the floor, or null if anyone is
// missing or has no known join time (fail closed).
function floorFor(audienceMembers, originMembers) {
  let floor = 1;   // > 0 so a NULL learned_at never passes a cross-chat check
  for (const m of audienceMembers) {
    if (!originMembers.has(m)) return null;
    const j = originMembers.get(m);
    if (!Number.isFinite(j)) return null;
    if (j > floor) floor = j;
  }
  return floor;
}

// [{ originJid, minLearnedAt, same }] — same-chat origins, then the subset path.
function originsFor(audience) {
  if (!audience || audience.kind === 'self') return [];
  const out = sameChatOf(audience).filter(Boolean).map(j => ({ originJid: j, minLearnedAt: 0, same: true }));
  const members = audience.members instanceof Set ? [...audience.members] : [];
  if (audience.outsiders || !audience.fresh || !members.length) return out;
  const own = new Set(out.map(o => o.originJid));

  // WhatsApp groups that contain every audience member.
  for (const { groupJid } of groupsOf(members[0])) {
    if (own.has(groupJid) || !isFresh(groupJid)) continue;
    const floor = floorFor(members, getMembership(groupJid).members);
    if (floor != null) out.push({ originJid: groupJid, minLearnedAt: floor, same: false });
  }
  // The Instagram group (every audience member a linked IG member).
  if (!own.has(IG_GROUP_JID)) {
    const ig = getIgMembership();
    if (ig.fresh) {
      const floor = floorFor(members, ig.members);
      if (floor != null) out.push({ originJid: IG_GROUP_JID, minLearnedAt: floor, same: false });
    }
  }
  return out;
}

/**
 * Chat origins usable for this audience (same chat first, then subset-path groups /
 * the Instagram group with their join-time floor). Owner and self items are not
 * chat origins — recall() applies their own rules. Never throws.
 * @returns {Array<{ originJid: string, minLearnedAt: number }>}
 */
export function allowedOrigins(audience) {
  try {
    return originsFor(audience).map(({ originJid, minLearnedAt }) => ({ originJid, minLearnedAt }));
  } catch (err) {
    logger.warn({ err: err.message }, 'allowedOrigins failed — same chat only');
    return sameChatOf(audience).map(j => ({ originJid: j, minLearnedAt: 0 }));
  }
}

// SQL for "this row's origin passes": col/learned/kind are column expressions.
function originClause(origins, { col, learned, kind }) {
  const parts = []; const params = [];
  for (const o of origins) {
    if (o.same) { parts.push(`${col} = ?`); params.push(o.originJid); }
    else {
      parts.push(`(${col} = ? AND ${kind} IN ('group', 'ig') AND ${learned} >= ?)`);
      params.push(o.originJid, o.minLearnedAt);
    }
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params };
}

// Every item_origins row of the item must pass (derived items, R14). 'self' inputs pass.
function derivedClause(origins, itemType, idExpr) {
  const parts = ["io.origin_jid = 'self'"]; const params = [];
  for (const o of origins) {
    if (o.same) { parts.push('io.origin_jid = ?'); params.push(o.originJid); }
    else { parts.push('(io.origin_jid = ? AND io.min_learned_at >= ?)'); params.push(o.originJid, o.minLearnedAt); }
  }
  return {
    sql: `NOT EXISTS (SELECT 1 FROM item_origins io WHERE io.item_type = '${itemType}' AND io.item_id = ${idExpr}
            AND NOT (${parts.join(' OR ')}))`,
    params,
  };
}

// Owner-note visibility for a row whose subject column is `subjectCol`.
function ownerClause(audience, { subjectCol, visibilityCol }) {
  const vis = visibilityCol ? `COALESCE(${visibilityCol}, 'subject_dm')` : `'subject_dm'`;
  const parts = []; const params = [];
  if (visibilityCol) parts.push(`${vis} = 'everywhere'`);
  if ((audience.kind === 'dm' || audience.kind === 'call') && audience.personJid) {
    const forms = sameChatOf(audience);
    parts.push(`(${vis} IN ('subject_dm', 'subject_groups') AND ${subjectCol} IN (${marks(forms.length)}))`);
    params.push(...forms);
  } else if ((audience.kind === 'group' || audience.kind === 'ig') && visibilityCol
             && audience.fresh && !audience.outsiders && audience.members?.size) {
    const ms = [...audience.members];
    parts.push(`(${vis} = 'subject_groups' AND ${subjectCol} IN (${marks(ms.length)}))`);
    params.push(...ms);
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params };
}

const clean = (s, max = 600) => {
  const t = sanitizeWebContent(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function tokens(query) {
  if (!query) return [];
  return [...new Set(String(query).toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 3))].slice(0, 12);
}

const toItem = (r) => ({
  id: r.id, category: r.category, content: clean(r.content), subjectJid: r.subject_jid,
  originKind: r.origin_kind, originJid: r.origin_jid, learnedAt: r.learned_at, importance: r.importance,
});

function bumpRecall(ids) {
  if (!ids.length) return;
  try {
    getDb().prepare(`UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled_at = ?
      WHERE id IN (${marks(ids.length)})`).run(nowSec(), ...ids);
  } catch (err) {
    logger.debug({ err: err.message }, 'recall count bump failed');
  }
}

const MEM_COLS = 'm.id, m.category, m.content, m.subject_jid, m.origin_kind, m.origin_jid, m.learned_at, m.importance, m.created_at';

function recallFallback(audience, limit) {
  try {
    if (!audience || audience.kind === 'self') return [];
    const same = sameChatOf(audience).filter(Boolean);
    const sameSql = same.length
      ? `(m.origin_jid IN (${marks(same.length)}) AND m.origin_kind NOT IN ('owner', 'self')
          AND NOT EXISTS (SELECT 1 FROM item_origins io WHERE io.item_type = 'memory' AND io.item_id = m.id
                          AND io.origin_jid NOT IN (${marks(same.length)})))`
      : '0';
    return getDb().prepare(`SELECT ${MEM_COLS} FROM memories m
      WHERE m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) AND m.category != 'episode'
        AND (${sameSql} OR (m.origin_kind = 'self' AND m.subject_jid IS NULL
             AND NOT EXISTS (SELECT 1 FROM item_origins io WHERE io.item_type = 'memory' AND io.item_id = m.id)))
      ORDER BY m.importance DESC, COALESCE(m.learned_at, m.created_at) DESC LIMIT ?`)
      .all(nowSec(), ...same, ...same, limit).map(toItem);
  } catch (err) {
    logger.warn({ err: err.message }, 'recall fallback failed — nothing recalled');
    return [];
  }
}

/**
 * Current (non-superseded, non-expired) memories this audience may see.
 * Content is sanitized. Bumps recall counts unless opts.track === false. Never throws.
 */
export function recall(audience, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 100));
  try {
    if (!audience || audience.kind === 'self') return [];
    const origins = originsFor(audience);
    const o = originClause(origins, { col: 'm.origin_jid', learned: 'm.learned_at', kind: 'm.origin_kind' });
    const d = derivedClause(origins, 'memory', 'm.id');
    const own = ownerClause(audience, { subjectCol: 'm.subject_jid', visibilityCol: 'm.visibility' });

    const where = [
      'm.superseded_by IS NULL',
      '(m.expires_at IS NULL OR m.expires_at > ?)',
      `((m.origin_kind NOT IN ('owner', 'self') AND ${o.sql})
        OR (m.origin_kind = 'owner' AND ${own.sql})
        OR (m.origin_kind = 'self' AND (m.subject_jid IS NULL
            OR EXISTS (SELECT 1 FROM item_origins io2 WHERE io2.item_type = 'memory' AND io2.item_id = m.id))))`,
      d.sql,
    ];
    const params = [nowSec(), ...o.params, ...own.params, ...d.params];

    const kinds = (opts.kinds || []).filter(k => KINDS.has(k));
    if (kinds.length) { where.push(`m.category IN (${marks(kinds.length)})`); params.push(...kinds); }
    else where.push(`m.category != 'episode'`);
    const subjects = [...new Set((opts.subjects || []).map(s => resolvePerson(s) || bareJid(s)).filter(Boolean))];
    if (opts.strictSubjects) {
      if (!subjects.length) return [];
      where.push(`m.subject_jid IN (${marks(subjects.length)})`); params.push(...subjects);
    }

    const pool = Math.min(Math.max(limit * 6, 40), 300);
    const rows = getDb().prepare(`SELECT ${MEM_COLS} FROM memories m WHERE ${where.join(' AND ')}
      ORDER BY m.importance DESC, COALESCE(m.learned_at, m.created_at) DESC LIMIT ?`).all(...params, pool);

    const subjectSet = new Set(subjects);
    const toks = tokens(opts.query);
    const same = new Set(origins.filter(x => x.same).map(x => x.originJid));
    const scored = rows.map(r => {
      const text = String(r.content || '').toLowerCase();
      return {
        r,
        subj: subjectSet.has(r.subject_jid) ? 1 : 0,
        hits: toks.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0),
        own: same.has(r.origin_jid) ? 1 : 0,
      };
    });
    scored.sort((a, b) => (b.subj - a.subj) || (b.hits - a.hits) || (b.own - a.own)
      || ((b.r.importance ?? 0) - (a.r.importance ?? 0))
      || ((b.r.learned_at ?? b.r.created_at ?? 0) - (a.r.learned_at ?? a.r.created_at ?? 0)));
    const out = scored.slice(0, limit).map(s => toItem(s.r));
    if (opts.track !== false) bumpRecall(out.map(i => i.id));
    return out;
  } catch (err) {
    logger.warn({ err: err.message, kind: audience?.kind }, 'recall_fail_closed');
    return recallFallback(audience, limit);
  }
}

/**
 * The mind's episodes (category 'episode', spec 008 R7) this audience may see, newest
 * first: the same origin / derived rules as recall(), chat origins only (an episode is
 * always written with its one chat as origin; owner/self rows are never episodes here).
 * opts: { limit = 2 (≤ 10), withinDays = 10 (≤ 400), track = true }. Only rows with a
 * learned_at inside the window count: a NULL learned_at never passes (fail closed).
 * Content is sanitized. Never throws; any error → [] (no episode is better than a
 * wrong one).
 * @returns {Array<{ id, content, originJid, originKind, learnedAt, attribute }>}
 */
export function recallEpisodes(audience, { limit = 2, withinDays = 10, track = true } = {}) {
  try {
    if (!audience || audience.kind === 'self') return [];
    const n = Math.max(1, Math.min(Math.floor(Number(limit)) || 2, 10));
    const days = Math.max(0, Math.min(Number.isFinite(Number(withinDays)) ? Number(withinDays) : 10, 400));
    const origins = originsFor(audience);
    if (!origins.length) return [];
    const o = originClause(origins, { col: 'm.origin_jid', learned: 'm.learned_at', kind: 'm.origin_kind' });
    const d = derivedClause(origins, 'memory', 'm.id');
    const now = nowSec();
    const rows = getDb().prepare(`SELECT m.id, m.content, m.origin_jid, m.origin_kind, m.learned_at, m.attribute
      FROM memories m
      WHERE m.category = 'episode' AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
        AND m.origin_kind NOT IN ('owner', 'self') AND m.learned_at IS NOT NULL AND m.learned_at >= ?
        AND ${o.sql} AND ${d.sql}
      ORDER BY m.learned_at DESC, m.id DESC LIMIT ?`)
      .all(now, now - Math.round(days * 86400), ...o.params, ...d.params, n);
    const out = rows.map(r => ({ id: r.id, content: clean(r.content, 700), originJid: r.origin_jid,
      originKind: r.origin_kind, learnedAt: r.learned_at, attribute: r.attribute })).filter(e => e.content);
    if (track !== false) bumpRecall(out.map(e => e.id));
    return out;
  } catch (err) {
    logger.warn({ err: err.message, kind: audience?.kind }, 'recall_fail_closed (episodes)');
    return [];
  }
}

function canonicalList(personJids, max = 60) {
  return [...new Set((personJids || []).map(p => resolvePerson(p) || bareJid(p)).filter(Boolean))].slice(0, max);
}

/**
 * Per-person profile merged from the facets this audience may see (own chat, owner,
 * subset-path origins). Merged at read time only — never stored. Never throws.
 * @returns {Map<string, { summary: string|null, traits: string[], interests: string[] }>}
 */
export function recallFacets(audience, personJids) {
  const out = new Map();
  try {
    if (!audience || audience.kind === 'self') return out;
    const persons = canonicalList(personJids);
    if (!persons.length) return out;
    const origins = originsFor(audience);
    const o = originClause(origins, { col: 'f.origin_jid', learned: 'f.learned_at', kind: 'f.origin_kind' });
    const d = derivedClause(origins, 'facet', 'f.rowid');
    const own = ownerClause(audience, { subjectCol: 'f.person_jid', visibilityCol: 'f.visibility' });
    const rows = getDb().prepare(`SELECT f.person_jid, f.origin_kind, f.origin_jid, f.summary, f.traits_json,
        f.interests_json, f.learned_at FROM person_facets f
      WHERE f.person_jid IN (${marks(persons.length)})
        AND ((f.origin_kind NOT IN ('owner', 'self') AND ${o.sql}) OR (f.origin_kind = 'owner' AND ${own.sql}))
        AND ${d.sql}`).all(...persons, ...o.params, ...own.params, ...d.params);

    const same = new Set(origins.filter(x => x.same).map(x => x.originJid));
    const rank = (r) => (same.has(r.origin_jid) ? 0 : r.origin_kind === 'owner' ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || (b.learned_at ?? 0) - (a.learned_at ?? 0));
    const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    for (const r of rows) {
      let f = out.get(r.person_jid);
      if (!f) { f = { summary: null, traits: [], interests: [], _s: [], _t: new Set(), _i: new Set() }; out.set(r.person_jid, f); }
      const s = r.summary ? clean(r.summary, 400) : '';
      if (s && f._s.length < 2 && !f._s.includes(s)) f._s.push(s);
      for (const [list, seen, src] of [[f.traits, f._t, r.traits_json], [f.interests, f._i, r.interests_json]]) {
        for (const x of parse(src)) {
          const v = clean(String(x), 60);
          if (v && !seen.has(v.toLowerCase()) && list.length < 10) { seen.add(v.toLowerCase()); list.push(v); }
        }
      }
    }
    for (const f of out.values()) {
      f.summary = f._s.length ? f._s.join(' · ') : null;
      delete f._s; delete f._t; delete f._i;
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'recall_fail_closed (facets)');
    return new Map();
  }
}

/**
 * Nicknames this audience may see, per person (scoped to the chat they were observed
 * in, FR-019). Owner-scope nicknames count as subject_dm. Never throws.
 * @returns {Map<string, Array<{ nickname, source, confidence }>>}
 */
export function recallNicknames(audience, personJids) {
  const out = new Map();
  try {
    if (!audience || audience.kind === 'self') return out;
    const persons = canonicalList(personJids);
    if (!persons.length) return out;
    const origins = originsFor(audience);
    const o = originClause(origins, { col: 'n.origin_jid', learned: 'n.learned_at', kind: 'n.origin_kind' });
    const d = derivedClause(origins, 'nickname', 'n.id');
    const own = ownerClause(audience, { subjectCol: 'n.person_jid', visibilityCol: null });
    const rows = getDb().prepare(`SELECT n.person_jid, n.nickname, n.source, n.confidence, n.use_count FROM nicknames n
      WHERE n.person_jid IN (${marks(persons.length)})
        AND ((n.origin_kind NOT IN ('owner', 'self') AND ${o.sql}) OR (n.origin_kind = 'owner' AND ${own.sql}))
        AND ${d.sql}
      ORDER BY n.confidence DESC, n.use_count DESC`).all(...persons, ...o.params, ...own.params, ...d.params);
    for (const r of rows) {
      const nick = clean(r.nickname, 40);
      if (!nick) continue;
      const list = out.get(r.person_jid) || [];
      if (list.length >= 6 || list.some(x => x.nickname.toLowerCase() === nick.toLowerCase())) continue;
      list.push({ nickname: nick, source: r.source, confidence: r.confidence });
      out.set(r.person_jid, list);
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'recall_fail_closed (nicknames)');
    return new Map();
  }
}

/**
 * Relationship dynamics this audience may see (own chat first, then strength).
 * Owner-scope rows count as subject_dm for either person. Never throws.
 */
export function recallRelationships(audience, { limit = 15 } = {}) {
  try {
    if (!audience || audience.kind === 'self') return [];
    const origins = originsFor(audience);
    const o = originClause(origins, { col: 'r.origin_jid', learned: 'r.learned_at', kind: 'r.origin_kind' });
    const d = derivedClause(origins, 'relationship', 'r.id');
    let ownerSql = '0'; const ownerParams = [];
    if ((audience.kind === 'dm' || audience.kind === 'call') && audience.personJid) {
      const forms = sameChatOf(audience);
      ownerSql = `(r.person_a_jid IN (${marks(forms.length)}) OR r.person_b_jid IN (${marks(forms.length)}))`;
      ownerParams.push(...forms, ...forms);
    }
    const same = origins.filter(x => x.same).map(x => x.originJid);
    const sameOrder = same.length ? `(r.origin_jid IN (${marks(same.length)})) DESC,` : '';
    const rows = getDb().prepare(`SELECT r.person_a_jid, r.person_b_jid, r.relationship, r.dynamic, r.strength,
        COALESCE(pa.real_name, pa.push_name) AS a_name, COALESCE(pb.real_name, pb.push_name) AS b_name
      FROM relationships r
      LEFT JOIN people pa ON pa.jid = r.person_a_jid
      LEFT JOIN people pb ON pb.jid = r.person_b_jid
      WHERE ((r.origin_kind NOT IN ('owner', 'self') AND ${o.sql}) OR (r.origin_kind = 'owner' AND ${ownerSql}))
        AND ${d.sql}
      ORDER BY ${sameOrder} r.strength DESC LIMIT ?`)
      .all(...o.params, ...ownerParams, ...d.params, ...same, Math.min(Number(limit) || 15, 100));
    return rows.map(r => ({
      a: r.person_a_jid, b: r.person_b_jid, aName: r.a_name ? clean(r.a_name, 60) : null,
      bName: r.b_name ? clean(r.b_name, 60) : null, relationship: r.relationship ? clean(r.relationship, 120) : null,
      dynamic: r.dynamic ? clean(r.dynamic, 200) : null, strength: r.strength,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, 'recall_fail_closed (relationships)');
    return [];
  }
}

/** Slang meanings: this chat's own plus global ones (R9). Never throws. */
export function recallSlang(audience, limit = 20) {
  try {
    if (!audience || audience.kind === 'self') return [];
    const same = sameChatOf(audience).filter(Boolean);
    const n = Math.max(1, Math.min(Number(limit) || 20, 100));
    const sameSql = same.length ? `origin_jid IN (${marks(same.length)})` : '0';
    const rows = getDb().prepare(`SELECT term, meaning FROM slang
      WHERE meaning IS NOT NULL AND TRIM(meaning) != '' AND (${sameSql} OR is_global = 1)
      ORDER BY (${sameSql}) DESC, use_count DESC LIMIT ?`).all(...same, ...same, n * 3);
    const seen = new Set(); const out = [];
    for (const r of rows) {
      const term = clean(r.term, 40);
      if (!term || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      out.push({ term, meaning: clean(r.meaning, 160) });
      if (out.length >= n) break;
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'recall_fail_closed (slang)');
    return [];
  }
}

function ftsQuery(query) {
  const t = tokens(query).slice(0, 8);
  return t.length ? t.map(x => `"${x.replace(/"/g, '')}"`).join(' OR ') : null;
}

/**
 * A person's own text messages in THIS group only (imitation, R13): no other chat's
 * words ever become exemplars. Excludes no_learn / expired rows; content sanitized.
 * opts: { limit = 40, query } — query → topical (FTS) exemplars. Never throws.
 */
export function recallExemplars(audience, personJid, opts = {}) {
  try {
    if (!audience || audience.kind !== 'group' || !audience.chatJid?.endsWith('@g.us')) return [];
    const p = resolvePerson(personJid) || bareJid(personJid);
    if (!p) return [];
    const forms = identitiesOf(p);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 40, 500));
    const base = `m.group_jid = ? AND m.sender_jid IN (${marks(forms.length)}) AND m.message_type = 'text'
      AND m.content IS NOT NULL AND COALESCE(m.no_learn, 0) = 0 AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND COALESCE(m.is_from_self, 0) = 0`;
    const db = getDb();
    const fts = ftsQuery(opts.query);
    const rows = fts
      ? db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? AND ${base} ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`)
        .all(fts, audience.chatJid, ...forms, nowSec(), limit)
      : db.prepare(`SELECT m.* FROM messages m WHERE ${base} ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?`)
        .all(audience.chatJid, ...forms, nowSec(), limit);
    return rows.map(r => ({ ...r, content: clean(r.content, 1000) })).filter(r => r.content);
  } catch (err) {
    logger.warn({ err: err.message }, 'recall_fail_closed (exemplars)');
    return [];
  }
}

/**
 * May content of chat `chatJid` (a transcript, a group block) be shown to this
 * audience? Same chat → yes. A group / the IG group → only if both memberships are
 * fresh, the audience is non-empty with no outsiders, and every audience member is
 * a current member of it. Another DM → never. Never throws.
 */
export function canUseChatContent(audience, chatJid) {
  try {
    if (!audience || audience.kind === 'self' || !chatJid) return false;
    const target = chatJid === IG_GROUP_JID ? chatJid : bareJid(chatJid);
    if (sameChatOf(audience).includes(target) || target === audience.chatJid) return true;
    if (!target.endsWith('@g.us') && target !== IG_GROUP_JID) return false;
    const members = audience.members instanceof Set ? [...audience.members] : [];
    if (audience.outsiders || !audience.fresh || !members.length) return false;
    if (!isFresh(target)) return false;
    const m = getMembership(target).members;
    return members.every(p => m.has(p));
  } catch {
    return false;
  }
}

/**
 * The same rule for one item: { originJid, learnedAt, originKind?, subjectJid?,
 * visibility?, origins?: [{ originJid, minLearnedAt }] } (origins = item_origins).
 * Never throws.
 */
export function canUseIn(item, audience) {
  try {
    if (!item || !audience || audience.kind === 'self') return false;
    const allowed = originsFor(audience);
    const pass = (originJid, learnedAt) => originJid === 'self' || allowed.some(o => o.originJid === originJid
      && (o.same || (Number.isFinite(learnedAt) && learnedAt >= o.minLearnedAt)));
    const derivedOk = !Array.isArray(item.origins) || item.origins.every(o => pass(o.originJid, o.minLearnedAt));
    if (!derivedOk) return false;
    const origin = item.originJid;
    const kind = item.originKind || (origin === 'self' ? 'self' : origin === 'owner' ? 'owner'
      : origin?.endsWith?.('@g.us') ? 'group' : origin?.startsWith?.('ig:') ? 'ig' : 'dm');

    if (kind === 'self') return !item.subjectJid || (Array.isArray(item.origins) && item.origins.length > 0);
    if (kind === 'owner') {
      const vis = item.visibility || 'subject_dm';
      if (vis === 'everywhere') return true;
      const subject = item.subjectJid ? (resolvePerson(item.subjectJid) || bareJid(item.subjectJid)) : null;
      if (!subject) return false;
      if (audience.kind === 'dm' || audience.kind === 'call') return audience.personJid === subject;
      return vis === 'subject_groups' && audience.fresh && !audience.outsiders && audience.members.has(subject);
    }
    const o = allowed.find(a => a.originJid === origin);
    if (!o) return false;
    if (o.same) return true;
    if (kind !== 'group' && kind !== 'ig') return false;   // DM/call origins: same chat only
    return Number.isFinite(item.learnedAt) && item.learnedAt >= o.minLearnedAt;
  } catch {
    return false;
  }
}
