import { getDb } from '../../memory/db.js';
import { getPerson, getNicknames, updateRealName, updateSummary, updateTraits, updateInterests } from '../../memory/peopleStore.js';
import { getRelationshipsForPerson, getMemoriesForPerson } from '../../memory/relationshipStore.js';
import { auditWrite } from '../audit.js';
import { config } from '../../utils/config.js';

function parseJsonSafe(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export default async function peopleRoutes(app) {
  app.get('/api/people', async (req) => {
    const db = getDb();
    const q = (req.query?.q || '').toString().toLowerCase();
    const group = req.query?.group ? req.query.group.toString() : null;
    const limit = Math.min(parseInt(req.query?.limit || '200', 10) || 200, 500);

    let rows;
    if (group) {
      rows = db.prepare(`
        SELECT p.* FROM people p
        JOIN group_members gm ON gm.person_jid = p.jid
        WHERE gm.group_jid = ?
        ORDER BY p.last_seen DESC LIMIT ?
      `).all(group, limit);
    } else {
      rows = db.prepare(`SELECT * FROM people ORDER BY last_seen DESC LIMIT ?`).all(limit);
    }

    return rows
      .filter(r => !q || (r.push_name || '').toLowerCase().includes(q) || (r.real_name || '').toLowerCase().includes(q))
      .map(r => ({
        jid: r.jid,
        phone: r.phone,
        pushName: r.push_name,
        realName: r.real_name,
        traits: parseJsonSafe(r.traits_json, []),
        interests: parseJsonSafe(r.interests_json, []),
        summary: r.summary,
        messageCount: r.message_count,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      }));
  });

  app.get('/api/people/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const person = getPerson(jid);
    if (!person) { reply.code(404).send({ error: 'Person not found' }); return; }

    const db = getDb();
    const nicknames = getNicknames(jid);
    const relationships = getRelationshipsForPerson(jid);
    const memories = getMemoriesForPerson(jid, 50);
    const groups = db.prepare(`
      SELECT g.jid, g.name, gm.role, gm.joined_at
      FROM group_members gm
      JOIN groups g ON g.jid = gm.group_jid
      WHERE gm.person_jid = ?
    `).all(jid);
    const recentMessages = db.prepare(`
      SELECT * FROM messages WHERE sender_jid = ? ORDER BY timestamp DESC LIMIT 30
    `).all(jid);

    return {
      ...person,
      traits: parseJsonSafe(person.traits_json, []),
      interests: parseJsonSafe(person.interests_json, []),
      nicknames,
      relationships,
      memories,
      groups,
      recentMessages,
    };
  });

  app.patch('/api/people/:jid', async (req, reply) => {
    const jid = req.params.jid;
    const body = req.body || {};
    if (!getPerson(jid)) { reply.code(404).send({ error: 'person not found' }); return; }
    const changes = {};
    if (typeof body.real_name === 'string') { updateRealName(jid, body.real_name); changes.real_name = body.real_name; }
    if (typeof body.summary === 'string')   { updateSummary(jid, body.summary); changes.summary = body.summary; }
    if (Array.isArray(body.traits))         { updateTraits(jid, body.traits); changes.traits = body.traits; }
    if (Array.isArray(body.interests))      { updateInterests(jid, body.interests); changes.interests = body.interests; }
    if (!Object.keys(changes).length) {
      reply.code(400).send({ error: 'No known fields (real_name, summary, traits[], interests[])' });
      return;
    }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'person.patch', jid, changes);
    return { ok: true, changes };
  });
}
