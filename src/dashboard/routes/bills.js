import { getDb } from '../../memory/db.js';
import { expireOpenBill, getBillSplit } from '../../memory/billStore.js';
import { auditWrite } from '../audit.js';
import { actorOf } from '../auth.js';

function parseJsonSafe(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export default async function billsRoutes(app) {
  app.get('/api/bills', async (req) => {
    const db = getDb();
    const group = req.query?.group?.toString();
    const state = req.query?.state?.toString();
    const limit = Math.min(parseInt(req.query?.limit || '100', 10) || 100, 500);

    const where = [];
    const params = [];
    if (group) { where.push('group_jid = ?'); params.push(group); }
    if (state) { where.push('state = ?'); params.push(state); }

    const rows = db.prepare(`
      SELECT * FROM bill_splits
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit);

    return rows.map(r => ({
      id: r.id,
      groupJid: r.group_jid,
      imageMsgId: r.image_msg_id,
      restaurant: r.restaurant,
      bill: parseJsonSafe(r.bill_json, {}),
      people: parseJsonSafe(r.people_json, []),
      assignments: parseJsonSafe(r.assignments_json, []),
      participantJids: parseJsonSafe(r.participant_jids_json, []),
      state: r.state,
      initiatorJid: r.initiator_jid,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    }));
  });

  app.post('/api/bills/:id/expire', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const bill = getBillSplit(id);
    if (!bill) { reply.code(404).send({ error: 'bill not found' }); return; }
    if (expireOpenBill(id).changes === 0) { reply.code(409).send({ error: `bill is ${bill.state}, not open` }); return; }
    auditWrite(actorOf(req), 'bill.expire', String(id), {});
    return { ok: true };
  });
}
