import { getDb } from '../../memory/db.js';
import { getPerson, getAllNicknames, getAllFacets, updateRealName, upsertFacet } from '../../memory/peopleStore.js';
import { getAllRelationshipsForPerson, getAllMemoriesForPerson, purgePerson } from '../../memory/relationshipStore.js';
import { resolvePerson, identitiesOf, listMergeQueue, decideMerge } from '../../memory/identity.js';
import { withProvenance } from './memories.js';
import { auditWrite } from '../audit.js';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getPersonVoice } from '../../memory/voiceStore.js';
import { clearImitationTarget } from '../../behavior/imitationState.js';
import {
  enrollVoice, removeVoice, retryPendingVoiceDeletes, VoiceCloneError, CONSENT_STATEMENTS, defaultConsentLanguage,
} from '../../brain/voiceClone.js';
import { actorOf } from '../auth.js';

// Operator view (spec 006, contracts/dashboard-api.md): a person's profile is a set
// of facets, one per chat it was learned in, plus the owner facet the dashboard
// edits. The operator sees every facet; the bot only reads them through recall.js.

const VISIBILITIES = new Set(['subject_dm', 'subject_groups', 'everywhere']);
// allowList: [] — like /api/login, destructive owner actions are capped on loopback too.
const STRICT_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } };
const marks = (n) => Array(n).fill('?').join(',');

// A JID in the URL may be any known form (LID, PN, device-suffixed): use the canonical id.
function canonicalJid(jid) {
  return (typeof jid === 'string' && jid ? resolvePerson(jid) : null) || jid;
}

const MAX_AUDIO_B64 = 15 * 1024 * 1024; // per recording, base64 chars

function decodeAudio(field) {
  if (!field || typeof field.data !== 'string' || !field.data) return null;
  if (field.data.length > MAX_AUDIO_B64) return null;
  const buf = Buffer.from(field.data.replace(/^data:[^,]*,/, ''), 'base64');
  return buf.length > 1000 ? buf : null;
}

function parseList(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Registry view of a person's facets: the owner facet first, then learned ones —
// traits / interests unioned (operator view), summary from the owner facet or the
// most recently updated learned one.
function facetDigest(facets) {
  const traits = []; const interests = []; const seenT = new Set(); const seenI = new Set();
  let summary = null;
  for (const f of facets) {
    if (!summary && f.summary) summary = f.summary;
    for (const t of parseList(f.traits_json)) if (!seenT.has(String(t).toLowerCase())) { seenT.add(String(t).toLowerCase()); traits.push(t); }
    for (const t of parseList(f.interests_json)) if (!seenI.has(String(t).toLowerCase())) { seenI.add(String(t).toLowerCase()); interests.push(t); }
  }
  return { summary, traits, interests };
}

function withMergeNames(rows) {
  if (!rows.length) return rows;
  const name = getDb().prepare('SELECT COALESCE(real_name, push_name) FROM people WHERE jid = ?').pluck();
  return rows.map(r => ({ ...r, keep_name: name.get(r.keep_jid) || null, drop_name: name.get(r.drop_jid) || null }));
}

const PEOPLE_COLS = 'p.jid, p.phone, p.push_name, p.real_name, p.message_count, p.first_seen, p.last_seen';

export default async function peopleRoutes(app) {
  app.get('/api/people', async (req) => {
    const db = getDb();
    const q = (req.query?.q || '').toString().toLowerCase();
    const group = req.query?.group ? req.query.group.toString() : null;
    const limit = Math.min(parseInt(req.query?.limit || '200', 10) || 200, 500);

    const rows = group
      ? db.prepare(`SELECT ${PEOPLE_COLS} FROM people p
          JOIN group_members gm ON gm.person_jid = p.jid
          WHERE gm.group_jid = ?
          ORDER BY p.last_seen DESC LIMIT ?`).all(group, limit)
      : db.prepare(`SELECT ${PEOPLE_COLS} FROM people p ORDER BY p.last_seen DESC LIMIT ?`).all(limit);

    const facetsBy = new Map();
    const jids = rows.map(r => r.jid);
    for (let i = 0; i < jids.length; i += 400) {
      const chunk = jids.slice(i, i + 400);
      for (const f of db.prepare(`SELECT person_jid, origin_kind, summary, traits_json, interests_json FROM person_facets
          WHERE person_jid IN (${marks(chunk.length)})
          ORDER BY origin_kind = 'owner' DESC, updated_at DESC`).all(...chunk)) {
        if (!facetsBy.has(f.person_jid)) facetsBy.set(f.person_jid, []);
        facetsBy.get(f.person_jid).push(f);
      }
    }

    return rows
      .filter(r => !q || (r.push_name || '').toLowerCase().includes(q) || (r.real_name || '').toLowerCase().includes(q))
      .map(r => {
        const facets = facetsBy.get(r.jid) || [];
        const d = facetDigest(facets);
        return {
          jid: r.jid,
          phone: r.phone,
          pushName: r.push_name,
          realName: r.real_name,
          traits: d.traits,
          interests: d.interests,
          summary: d.summary,
          facetCount: facets.length,
          messageCount: r.message_count,
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
        };
      });
  });

  // Pending identity merges (both rows hold DM-origin items, so the owner decides).
  // ?decision=rejected lists the pairs the owner rejected (not queued again unless
  // evidence of another kind arrives); ?all=1 every row.
  // Static path: registered before /api/people/:jid wins in find-my-way regardless.
  app.get('/api/people/merge-queue', async (req) => {
    const pendingOnly = req.query?.all?.toString() !== '1';
    const decision = req.query?.decision?.toString() === 'rejected' ? 'rejected' : null;
    return withMergeNames(listMergeQueue({ pendingOnly, decision, limit: 200 }));
  });

  app.post('/api/people/merge-queue/:id/:decision', { config: STRICT_LIMIT }, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const decision = { approve: 'approved', reject: 'rejected' }[req.params.decision];
    if (!Number.isInteger(id) || !decision) {
      reply.code(400).send({ error: 'POST /api/people/merge-queue/:id/approve|reject' });
      return;
    }
    const actor = actorOf(req);
    const res = decideMerge(id, decision, actor);
    if (!res.ok) {
      reply.code(res.error === 'not found' ? 404 : 422).send({ error: res.error === 'not found'
        ? 'No pending merge with that id' : 'Merge failed (see logs)' });
      return;
    }
    auditWrite(actor, decision === 'approved' ? 'identity.merge.approve' : 'identity.merge.reject', String(id),
      { merged: !!res.merged });
    return { ok: true, decision, merged: !!res.merged };
  });

  app.get('/api/people/:jid', async (req, reply) => {
    const jid = canonicalJid(req.params.jid);
    const person = getPerson(jid);
    if (!person) { reply.code(404).send({ error: 'Person not found' }); return; }

    const db = getDb();
    const forms = identitiesOf(jid);
    const facets = withProvenance(getAllFacets(jid)).map(f => {
      const { traits_json: _t, interests_json: _i, ...rest } = f;
      return rest;
    });
    const owner = facets.find(f => f.origin_kind === 'owner') || null;
    const identities = db.prepare(`SELECT jid, kind, source, seen_at FROM person_identities
      WHERE person_jid = ? ORDER BY kind, seen_at DESC`).all(jid);
    const nicknames = withProvenance(getAllNicknames(jid));
    const relationships = withProvenance(getAllRelationshipsForPerson(jid));
    const memories = withProvenance(getAllMemoriesForPerson(jid, 50), { audience: true, derivedType: 'memory' });
    const groups = db.prepare(`
      SELECT g.jid, g.name, gm.role, gm.joined_at
      FROM group_members gm
      JOIN groups g ON g.jid = gm.group_jid
      WHERE gm.person_jid = ?
    `).all(jid);
    const recentMessages = db.prepare(`
      SELECT * FROM messages WHERE sender_jid IN (${marks(forms.length)}) ORDER BY timestamp DESC LIMIT 30
    `).all(...forms);
    const formSet = new Set(forms);
    const mine = (m) => formSet.has(m.keep_jid) || formSet.has(m.drop_jid);
    const mergeQueue = withMergeNames(listMergeQueue({ pendingOnly: true, limit: 200 }).filter(mine));
    const rejectedMerges = withMergeNames(listMergeQueue({ decision: 'rejected', limit: 200 }).filter(mine));

    return {
      ...person,
      // Legacy fields: the owner facet (what the edit form writes).
      summary: owner?.summary ?? null,
      traits: owner?.traits || [],
      interests: owner?.interests || [],
      visibility: owner?.visibility || 'subject_dm',
      facets,
      identities,
      nicknames,
      relationships,
      memories,
      groups,
      recentMessages,
      mergeQueue,
      rejectedMerges,
      voice: (() => {
        const v = getPersonVoice(jid, { includeInactive: true });
        return {
          active: !!getPersonVoice(jid),
          enrolledAt: v?.created_at || null,
          expiresAt: v?.expire_time || null,
          via: v?.enrolled_via || null,
          revokedAt: v?.revoked_at || null,
          revokeReason: v?.revoke_reason || null,
          consentStatements: CONSENT_STATEMENTS,
        };
      })(),
    };
  });

  // Owner action: remove everything remembered about this person (memories about
  // them or from their DM / calls, facets, nicknames, relationships, evidence, style
  // cards, call summaries/transcripts, relay texts, imitation targets and identity
  // forms). Messages stay (they're the chat log). Audited once (by purgePerson, as
  // this operator) with a count only.
  app.post('/api/people/:jid/purge', { config: STRICT_LIMIT }, async (req, reply) => {
    if (req.body?.confirm !== true) {
      reply.code(400).send({ error: 'Send { "confirm": true } to purge everything remembered about this person' });
      return;
    }
    const jid = canonicalJid(req.params.jid);
    if (!getPerson(jid)) { reply.code(404).send({ error: 'person not found' }); return; }
    const actor = actorOf(req);
    const forms = identitiesOf(jid);
    const imitating = getDb().prepare(`SELECT group_jid FROM group_imitation
      WHERE target_jid IN (${forms.map(() => '?').join(',')})`).pluck().all(...forms);
    const { deleted, voicePending } = purgePerson(jid, 'dashboard', actor);
    for (const g of imitating) clearImitationTarget(g);   // drop the in-memory target too
    // The purge revoked their cloned voice(s); delete them at Google now (a failure
    // stays marked and the 6-hourly maintenance retries). Every form's row counts — a
    // merge can leave one under a merged-away form — and any still marked after the
    // retry → delete_pending.
    let voice = 'none';
    if (voicePending) {
      const res = await retryPendingVoiceDeletes({ personJids: forms }).catch(() => ({ pending: voicePending }));
      voice = res.pending ? 'delete_pending' : 'deleted';
    }
    return { ok: true, deleted, voice };
  });

  // ── Cloned voice (imitate-voice) ──
  // Upload the person's OWN two recordings: a 10–30 s natural sample and them
  // reading the consent statement. Google speaker-verifies one against the other,
  // so this can't enroll a voice without its owner's recorded consent.
  app.post('/api/people/:jid/voice', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const jid = canonicalJid(req.params.jid);
    const person = getPerson(jid);
    if (!person) { reply.code(404).send({ error: 'person not found' }); return; }
    const body = req.body || {};
    if (body.confirmOwnerConsent !== true) {
      reply.code(400).send({ error: 'Confirm that both recordings are this person, recorded by them, with their consent' });
      return;
    }
    const languageCode = CONSENT_STATEMENTS[body.languageCode] ? body.languageCode : defaultConsentLanguage();
    const sourceAudio = decodeAudio(body.sample);
    const consentAudio = decodeAudio(body.consent);
    if (!sourceAudio || !consentAudio) {
      reply.code(400).send({ error: 'Both recordings are required (sample + consent), max ~10 MB each' });
      return;
    }
    const actor = actorOf(req);
    try {
      const { voiceId, expireTime } = await enrollVoice({
        personJid: jid,
        displayName: person.push_name || person.real_name || jid,
        sourceAudio,
        consentAudio,
        languageCode,
        consentRef: `dashboard:${actor}:${Date.now()}`,
        via: 'dashboard',
      });
      auditWrite(actor, 'voice.enroll', jid, { voiceId, languageCode });
      return { ok: true, expiresAt: expireTime };
    } catch (err) {
      logger.warn({ err: err.message, jid }, 'Dashboard voice enrollment failed');
      reply.code(err instanceof VoiceCloneError && err.code !== 'api' ? 400 : 502)
        .send({ error: err instanceof VoiceCloneError ? err.userMessage : 'Voice enrollment failed' });
    }
  });

  app.delete('/api/people/:jid/voice', async (req, reply) => {
    const jid = canonicalJid(req.params.jid);
    const removed = await removeVoice(jid, { reason: 'dashboard' });
    if (!removed) { reply.code(404).send({ error: 'No active voice for this person' }); return; }
    auditWrite(actorOf(req), 'voice.delete', jid, {});
    return { ok: true };
  });

  // Writes the OWNER facet (plus real_name on the people row). visibility widens or
  // narrows who may hear the owner facet; the change is audited (R8).
  app.patch('/api/people/:jid', async (req, reply) => {
    const jid = canonicalJid(req.params.jid);
    const body = req.body || {};
    if (!getPerson(jid)) { reply.code(404).send({ error: 'person not found' }); return; }
    if (body.visibility !== undefined && !VISIBILITIES.has(body.visibility)) {
      reply.code(400).send({ error: 'visibility must be subject_dm|subject_groups|everywhere' });
      return;
    }
    const strList = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
    if ((body.traits !== undefined && !strList(body.traits)) || (body.interests !== undefined && !strList(body.interests))) {
      reply.code(400).send({ error: 'traits / interests must be arrays of strings' });
      return;
    }
    const facet = {};
    if (typeof body.summary === 'string') facet.summary = body.summary;
    if (body.traits !== undefined) facet.traits = body.traits;
    if (body.interests !== undefined) facet.interests = body.interests;
    const realName = typeof body.real_name === 'string' ? body.real_name.trim().slice(0, 120) : undefined;
    if (realName === undefined && !Object.keys(facet).length && body.visibility === undefined) {
      reply.code(400).send({ error: 'No known fields (real_name, summary, traits[], interests[], visibility)' });
      return;
    }

    // Field names and the visibility change only — never the text.
    const changes = { fields: [] };
    if (realName !== undefined) { updateRealName(jid, realName || null); changes.fields.push('real_name'); }
    if (Object.keys(facet).length || body.visibility !== undefined) {
      const before = getDb().prepare(`SELECT visibility FROM person_facets WHERE person_jid = ? AND origin_jid = 'owner'`)
        .pluck().get(jid) || null;
      const res = upsertFacet(jid, 'owner', 'owner', facet, { visibility: body.visibility ?? null });
      if (!res) { reply.code(422).send({ error: 'Could not write the owner facet' }); return; }
      changes.fields.push(...Object.keys(facet));
      if (body.visibility !== undefined && body.visibility !== before) {
        changes.visibility = { from: before || 'subject_dm', to: res.visibility };
      }
    }
    auditWrite(actorOf(req), 'person.update', jid, changes);
    return { ok: true, changes };
  });
}
