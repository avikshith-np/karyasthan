import { getDb } from '../../memory/db.js';
import { addMemory, isTombstoned, deleteMemory } from '../../memory/relationshipStore.js';
import { getPerson } from '../../memory/peopleStore.js';
import { resolvePerson, identitiesOf, isPersonJid, bareJid } from '../../memory/identity.js';
import { isFresh, IG_GROUP_JID } from '../../memory/membership.js';
import { memoryFingerprint } from '../../memory/migrations/fingerprint.js';
import { auditWrite } from '../audit.js';
import { actorOf } from '../auth.js';

// Operator view (spec 006, FR-027, contracts/dashboard-api.md): the dashboard sees
// every item, unfiltered, with where it was learned and who may hear it. Origin is
// never client-settable — notes typed here are owner items, and an edit can't move
// an item to another chat.

const VALID_CATEGORIES = new Set(['fact', 'event', 'temporary', 'interest', 'lore', 'preference']);
const VISIBILITIES = new Set(['subject_dm', 'subject_groups', 'everywhere']);
const ORIGIN_KINDS = new Set(['self', 'group', 'dm', 'call', 'ig', 'owner']);
// Fields a client may never send on a memory write (provenance is the bot's, not the operator's).
const IMMUTABLE_FIELDS = ['origin_kind', 'origin_jid', 'group_jid', 'subject_jid', 'learned_at', 'source',
  'fingerprint', 'attribute', 'superseded_by', 'superseded_at', 'recall_count', 'last_recalled_at', 'created_at'];
const CONTENT_MAX = 1000;
const marks = (n) => Array(n).fill('?').join(',');

const normContent = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── Shared provenance helpers (people.js / groups.js import these) ───────────

function personName(p) {
  return p?.real_name || p?.push_name || null;
}

// Lookup tables for labelling a batch of rows: group names + member counts, people
// names, and the Instagram group's linked-member count. One query each per request.
function labelContext(db, rows) {
  const groupJids = new Set();
  const personJids = new Set();
  for (const r of rows) {
    const o = r.origin_jid;
    if (o?.endsWith('@g.us')) groupJids.add(o);
    else if (o && o !== 'owner' && o !== 'self' && !o.startsWith('ig:')) personJids.add(o);
    if (r.subject_jid) personJids.add(r.subject_jid);
  }
  const groups = new Map();
  const gj = [...groupJids];
  for (let i = 0; i < gj.length; i += 400) {
    const chunk = gj.slice(i, i + 400);
    for (const g of db.prepare(`SELECT g.jid, g.name, g.members_synced_at,
        (SELECT COUNT(*) FROM group_members gm WHERE gm.group_jid = g.jid) AS member_count
      FROM groups g WHERE g.jid IN (${marks(chunk.length)})`).all(...chunk)) groups.set(g.jid, g);
  }
  const people = new Map();
  const pj = [...personJids];
  for (let i = 0; i < pj.length; i += 400) {
    const chunk = pj.slice(i, i + 400);
    for (const p of db.prepare(`SELECT jid, push_name, real_name FROM people WHERE jid IN (${marks(chunk.length)})`)
      .all(...chunk)) people.set(p.jid, p);
  }
  let igMembers = null;
  if (rows.some(r => r.origin_kind === 'ig')) {
    try {
      igMembers = db.prepare(`SELECT COUNT(*) FROM ig_members WHERE in_group = 1 AND COALESCE(is_self, 0) = 0
        AND person_jid IS NOT NULL`).pluck().get();
    } catch { igMembers = null; }
  }
  return { groups, people, igMembers };
}

function originLabel(ctx, kind, originJid) {
  if (kind === 'owner' || originJid === 'owner') return 'owner';
  if (kind === 'self' || originJid === 'self') return 'self';
  if (kind === 'ig' || originJid?.startsWith('ig:')) return 'Instagram group';
  if (!originJid) return '—';
  if (originJid.endsWith('@g.us')) return ctx.groups.get(originJid)?.name || originJid;
  const name = personName(ctx.people.get(originJid)) || originJid;
  return kind === 'call' ? `calls with ${name}` : `DM with ${name}`;
}

function freshSafe(jid) {
  try { return isFresh(jid); } catch { return false; }
}

// A plain-language reading of research R1 / R8 for one item. Descriptive only — the
// enforced rule lives in recall.js; this never feeds a prompt.
function audienceSummary(ctx, row, derivedCount = 0) {
  const kind = row.origin_kind;
  const o = row.origin_jid;
  let s;
  if (!kind || !o) s = 'unscoped (never recalled across chats)';
  else if (kind === 'owner') {
    const subj = row.subject_jid ? (personName(ctx.people.get(row.subject_jid)) || row.subject_jid) : null;
    const vis = row.visibility || 'subject_dm';
    if (vis === 'everywhere') s = 'everywhere';
    else if (!subj) s = "nowhere (a note without a subject needs 'everywhere')";
    else if (vis === 'subject_groups') s = `DM with ${subj} + outsider-free groups ${subj} is in`;
    else s = `DM with ${subj} only`;
  } else if (kind === 'self') s = derivedCount ? 'where every contributing chat allows' : 'everywhere';
  else if (kind === 'dm') s = `${originLabel(ctx, kind, o)} only`;
  else if (kind === 'call') s = `DM / calls with ${personName(ctx.people.get(o)) || o} only`;
  else if (kind === 'group') {
    const g = ctx.groups.get(o);
    const n = g?.member_count ?? 0;
    const label = g?.name || o;
    s = freshSafe(o)
      ? `${label} + DMs/sub-groups of its ${n} member${n === 1 ? '' : 's'} (joined before it was learned)`
      : `${label} only (membership not synced)`;
  } else if (kind === 'ig') {
    s = freshSafe(IG_GROUP_JID)
      ? `Instagram group + chats of its ${ctx.igMembers ?? '?'} linked members (joined before it was learned)`
      : 'Instagram group only (members not synced)';
  } else s = originLabel(ctx, kind, o);
  if (derivedCount > 0) s += ` · derived from ${derivedCount} chat${derivedCount === 1 ? '' : 's'} (each must allow)`;
  return s;
}

/**
 * Adds origin_label (and, with audience:true, audience_summary) to rows that carry
 * origin_kind / origin_jid (memories, facets, nicknames, relationships, slang).
 * derivedType: the item_origins item_type, to count a derived item's contributing chats.
 */
export function withProvenance(rows, { audience = false, derivedType = null, idKey = 'id' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const db = getDb();
  const ctx = labelContext(db, rows);
  const derived = new Map();
  if (audience && derivedType) {
    const ids = rows.map(r => r[idKey]).filter(Number.isFinite);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of db.prepare(`SELECT item_id, COUNT(*) AS n FROM item_origins WHERE item_type = ?
          AND item_id IN (${marks(chunk.length)}) GROUP BY item_id`).all(derivedType, ...chunk)) derived.set(r.item_id, r.n);
    }
  }
  return rows.map(r => {
    const out = { ...r, origin_label: originLabel(ctx, r.origin_kind, r.origin_jid) };
    if (audience) out.audience_summary = audienceSummary(ctx, r, derived.get(r[idKey]) || 0);
    return out;
  });
}

function canonicalSubject(jid) {
  if (!jid || typeof jid !== 'string') return null;
  return resolvePerson(jid) || (isPersonJid(jid) ? bareJid(jid) : null);
}

// ── Routes ───────────────────────────────────────────────────────────────────

export default async function memoriesRoutes(app) {
  app.get('/api/memories', async (req, reply) => {
    const db = getDb();
    const qs = req.query || {};
    const category = qs.category?.toString();
    const originKind = qs.origin_kind?.toString();
    const originJid = qs.origin_jid?.toString();
    const subject = qs.subject?.toString();
    const group = qs.group?.toString();          // legacy: memories learned in this chat
    const q = qs.q?.toString().trim();
    const expired = qs.expired?.toString() === '1';
    const includeSuperseded = qs.include_superseded?.toString() === '1';
    const limit = Math.min(parseInt(qs.limit || '200', 10) || 200, 1000);

    if (originKind && !ORIGIN_KINDS.has(originKind)) {
      reply.code(400).send({ error: 'origin_kind must be one of self|group|dm|call|ig|owner' });
      return;
    }

    const where = [];
    const params = [];
    if (category)   { where.push('m.category = ?'); params.push(category); }
    if (originKind) { where.push('m.origin_kind = ?'); params.push(originKind); }
    if (originJid)  {
      // A DM origin is stored under the canonical person id: accept any of its forms.
      const chatLike = originJid.endsWith('@g.us') || originJid === 'owner' || originJid === 'self' || originJid.startsWith('ig:');
      const forms = chatLike ? [originJid] : identitiesOf(canonicalSubject(originJid) || originJid);
      where.push(`m.origin_jid IN (${marks(forms.length)})`); params.push(...forms);
    }
    if (group)      { where.push('(m.origin_jid = ? OR (m.origin_jid IS NULL AND m.group_jid = ?))'); params.push(group, group); }
    if (subject)    {
      const forms = identitiesOf(canonicalSubject(subject) || subject);
      where.push(`m.subject_jid IN (${marks(forms.length)})`); params.push(...forms);
    }
    if (q)          { where.push("m.content LIKE ? ESCAPE '\\'"); params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
    if (!expired) where.push('(m.expires_at IS NULL OR m.expires_at > unixepoch())');
    if (!includeSuperseded) where.push('m.superseded_by IS NULL');

    const sql = `
      SELECT m.id, m.category, m.subject_jid, m.group_jid, m.content, m.importance, m.recall_count,
        m.created_at, m.expires_at, m.origin_kind, m.origin_jid, m.learned_at, m.attribute, m.source,
        m.superseded_by, m.superseded_at, m.last_recalled_at, m.visibility,
        COALESCE(p.real_name, p.push_name) AS subject_name
      FROM memories m
      LEFT JOIN people p ON p.jid = m.subject_jid
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = withProvenance(db.prepare(sql).all(...params), { audience: true, derivedType: 'memory' });
    // group_name kept for older clients: the origin chat's label when it's a group.
    return rows.map(r => ({ ...r, group_name: r.origin_kind === 'group' ? r.origin_label : null }));
  });

  // Owner note. The origin is always 'owner' — an operator can't forge a group or DM
  // origin (which would widen who hears it). visibility defaults to the subject's DM.
  app.post('/api/memories', async (req, reply) => {
    const body = req.body || {};
    const forged = IMMUTABLE_FIELDS.filter(f => f !== 'subject_jid' && body[f] != null);
    if (forged.length) {
      reply.code(400).send({ error: `Not client-settable: ${forged.join(', ')} (dashboard notes are owner notes)` });
      return;
    }
    if (!VALID_CATEGORIES.has(body.category)) {
      reply.code(400).send({ error: `category must be ${[...VALID_CATEGORIES].join('|')}` });
      return;
    }
    const content = typeof body.content === 'string' ? normContent(body.content) : '';
    if (!content) { reply.code(400).send({ error: 'content is required' }); return; }
    if (content.length > CONTENT_MAX) { reply.code(400).send({ error: `content is limited to ${CONTENT_MAX} characters` }); return; }
    const visibility = body.visibility == null || body.visibility === '' ? 'subject_dm' : body.visibility;
    if (!VISIBILITIES.has(visibility)) {
      reply.code(400).send({ error: 'visibility must be subject_dm|subject_groups|everywhere' });
      return;
    }
    let subjectJid = null;
    if (body.subject_jid != null && body.subject_jid !== '') {
      subjectJid = canonicalSubject(String(body.subject_jid));
      if (!subjectJid || !getPerson(subjectJid)) { reply.code(400).send({ error: 'subject_jid is not a known person' }); return; }
    }
    if (!subjectJid && visibility !== 'everywhere') {
      reply.code(400).send({ error: "A note without a subject is only ever used with visibility 'everywhere'" });
      return;
    }
    const importance = typeof body.importance === 'number' && Number.isFinite(body.importance)
      ? Math.max(0, Math.min(1, body.importance)) : 0.5;
    const expiresInDays = typeof body.expires_in_days === 'number' && Number.isFinite(body.expires_in_days)
      && body.expires_in_days > 0 ? body.expires_in_days : null;

    let result;
    try {
      result = addMemory({
        category: body.category, subjectJid, originKind: 'owner', originJid: 'owner',
        content, importance, expiresInDays, visibility, source: 'dashboard',
      });
    } catch (err) {
      reply.code(400).send({ error: err.message });
      return;
    }
    if (result.refused) {
      reply.code(409).send({ error: result.refused === 'tombstoned'
        ? "This was forgotten at the subject's request and cannot be re-added" : `Refused (${result.refused})` });
      return;
    }
    auditWrite(actorOf(req), 'memory.create', String(result.id), {
      category: body.category, subject_jid: subjectJid, visibility, importance, merged: !!result.merged,
    });
    return { ok: true, id: result.id, merged: !!result.merged };
  });

  // Edit text / importance / category, and an owner note's visibility. Origin,
  // subject and learned_at are immutable.
  app.patch('/api/memories/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) { reply.code(400).send({ error: 'invalid id' }); return; }
    const body = req.body || {};
    const forged = IMMUTABLE_FIELDS.filter(f => f in body);
    if (forged.length) { reply.code(400).send({ error: `Immutable: ${forged.join(', ')}` }); return; }

    const db = getDb();
    const row = db.prepare('SELECT id, origin_kind, origin_jid, subject_jid, content, visibility FROM memories WHERE id = ?').get(id);
    if (!row) { reply.code(404).send({ error: 'memory not found' }); return; }

    const fields = [];
    const values = [];
    const changed = {};
    if (body.content !== undefined) {
      const content = typeof body.content === 'string' ? normContent(body.content) : '';
      if (!content) { reply.code(400).send({ error: 'content cannot be empty' }); return; }
      if (content.length > CONTENT_MAX) { reply.code(400).send({ error: `content is limited to ${CONTENT_MAX} characters` }); return; }
      if (content !== row.content) {
        // The fingerprint is the dedupe key: keep it in step with the text.
        const fp = memoryFingerprint({ originJid: row.origin_jid, subjectJid: row.subject_jid, content });
        if (isTombstoned(fp, { originJid: row.origin_jid, content })) { reply.code(409).send({ error: "This was forgotten at the subject's request" }); return; }
        fields.push('content = ?', 'fingerprint = ?'); values.push(content, fp);
        changed.content = true;
      }
    }
    if (body.importance !== undefined) {
      if (typeof body.importance !== 'number' || !Number.isFinite(body.importance)) {
        reply.code(400).send({ error: 'importance must be a number 0..1' }); return;
      }
      const imp = Math.max(0, Math.min(1, body.importance));
      fields.push('importance = ?'); values.push(imp); changed.importance = imp;
    }
    if (body.category !== undefined) {
      if (!VALID_CATEGORIES.has(body.category)) {
        reply.code(400).send({ error: `category must be ${[...VALID_CATEGORIES].join('|')}` }); return;
      }
      fields.push('category = ?'); values.push(body.category); changed.category = body.category;
    }
    if (body.visibility !== undefined) {
      if (row.origin_kind !== 'owner') {
        reply.code(400).send({ error: 'visibility applies to owner notes only — learned items follow their chat' }); return;
      }
      if (!VISIBILITIES.has(body.visibility)) {
        reply.code(400).send({ error: 'visibility must be subject_dm|subject_groups|everywhere' }); return;
      }
      if (!row.subject_jid && body.visibility !== 'everywhere') {
        reply.code(400).send({ error: "A note without a subject is only ever used with visibility 'everywhere'" }); return;
      }
      fields.push('visibility = ?'); values.push(body.visibility);
      changed.visibility = { from: row.visibility || 'subject_dm', to: body.visibility };
    }
    if (!fields.length) { reply.code(400).send({ error: 'No updatable fields (content, importance, category, visibility)' }); return; }

    values.push(id);
    try {
      db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) {
        reply.code(409).send({ error: 'Another current memory from the same chat already says this' }); return;
      }
      throw err;
    }
    // Field names (and the visibility change) only — never the text.
    auditWrite(actorOf(req), 'memory.update', String(id), changed);
    return { ok: true };
  });

  app.delete('/api/memories/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) { reply.code(400).send({ error: 'invalid id' }); return; }
    // Through 006's delete path (like "forget that"): a learned fact is tombstoned so
    // the next batch can't relearn it, and the deletion hooks (mind episodes, drafts)
    // run. Audited with the id and whether it was tombstoned, never the text.
    const r = deleteMemory(id);
    if (r.deleted === 0) { reply.code(404).send({ error: 'memory not found' }); return; }
    auditWrite(actorOf(req), 'memory.delete', String(id), { tombstoned: r.tombstoned });
    return { ok: true, tombstoned: r.tombstoned };
  });
}
