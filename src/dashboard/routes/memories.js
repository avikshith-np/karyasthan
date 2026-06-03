import { getDb } from '../../memory/db.js';
import { addMemory } from '../../memory/relationshipStore.js';
import { auditWrite } from '../audit.js';
import { config } from '../../utils/config.js';

const VALID_CATEGORIES = new Set(['fact', 'temporary', 'interest']);

export default async function memoriesRoutes(app) {
  app.get('/api/memories', async (req) => {
    const db = getDb();
    const category = req.query?.category?.toString();
    const subject = req.query?.subject?.toString();
    const group = req.query?.group?.toString();
    const expired = req.query?.expired?.toString() === '1';
    const limit = Math.min(parseInt(req.query?.limit || '200', 10) || 200, 1000);

    const where = [];
    const params = [];
    if (category) { where.push('category = ?'); params.push(category); }
    if (subject)  { where.push('subject_jid = ?'); params.push(subject); }
    if (group)    { where.push('group_jid = ?'); params.push(group); }
    if (!expired) where.push('(expires_at IS NULL OR expires_at > unixepoch())');

    const sql = `
      SELECT m.*, p.push_name AS subject_name, g.name AS group_name
      FROM memories m
      LEFT JOIN people p ON p.jid = m.subject_jid
      LEFT JOIN groups g ON g.jid = m.group_jid
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    return db.prepare(sql).all(...params);
  });

  app.post('/api/memories', async (req, reply) => {
    const body = req.body || {};
    if (!VALID_CATEGORIES.has(body.category)) {
      reply.code(400).send({ error: 'category must be fact|temporary|interest' });
      return;
    }
    if (!body.content || typeof body.content !== 'string') {
      reply.code(400).send({ error: 'content is required' });
      return;
    }
    if (!body.subject_jid && !body.group_jid) {
      reply.code(400).send({ error: 'either subject_jid or group_jid required' });
      return;
    }
    const importance = typeof body.importance === 'number'
      ? Math.max(0, Math.min(1, body.importance))
      : 0.5;
    const expiresInDays = typeof body.expires_in_days === 'number' ? body.expires_in_days : null;
    const result = addMemory(body.category, body.subject_jid || null, body.group_jid || null, body.content, importance, expiresInDays);
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'memory.create', String(result.lastInsertRowid), {
      category: body.category, subject_jid: body.subject_jid, group_jid: body.group_jid, importance,
    });
    return { ok: true, id: result.lastInsertRowid };
  });

  app.patch('/api/memories/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const fields = [];
    const values = [];
    if (typeof body.content === 'string')    { fields.push('content = ?'); values.push(body.content); }
    if (typeof body.importance === 'number') { fields.push('importance = ?'); values.push(Math.max(0, Math.min(1, body.importance))); }
    if ('expires_at' in body) {
      fields.push('expires_at = ?');
      values.push(body.expires_at == null ? null : parseInt(body.expires_at, 10));
    }
    if (!fields.length) { reply.code(400).send({ error: 'No updatable fields' }); return; }
    values.push(id);
    const db = getDb();
    const r = db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (r.changes === 0) { reply.code(404).send({ error: 'memory not found' }); return; }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'memory.patch', String(id), body);
    return { ok: true };
  });

  app.delete('/api/memories/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const r = getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (r.changes === 0) { reply.code(404).send({ error: 'memory not found' }); return; }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'memory.delete', String(id), {});
    return { ok: true };
  });
}
