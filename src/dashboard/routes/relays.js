import { getDb } from '../../memory/db.js';

// Explicit DM → group relays (spec 006, R10): read-only operator view. A relay is
// the one path a DM's content may take into another chat, so the owner can see
// every request, its target and what happened to it.

const STATES = new Set(['pending', 'confirmed', 'sent', 'declined', 'expired', 'failed']);

export default async function relaysRoutes(app) {
  app.get('/api/relays', async (req, reply) => {
    const state = req.query?.state ? req.query.state.toString() : null;
    if (state && !STATES.has(state)) {
      reply.code(400).send({ error: `state must be one of ${[...STATES].join('|')}` });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query?.limit || '100', 10) || 100, 1), 500);
    return getDb().prepare(`
      SELECT r.id, r.requester_jid, r.source_dm_jid, r.target_jid, r.content, r.source_msg_id, r.state,
        r.created_at, r.confirmed_at, r.sent_at, r.error,
        COALESCE(pr.real_name, pr.push_name) AS requester_name,
        COALESCE(g.name, COALESCE(pt.real_name, pt.push_name)) AS target_name
      FROM relays r
      LEFT JOIN people pr ON pr.jid = r.requester_jid
      LEFT JOIN groups g ON g.jid = r.target_jid
      LEFT JOIN people pt ON pt.jid = r.target_jid
      ${state ? 'WHERE r.state = ?' : ''}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `).all(...(state ? [state, limit] : [limit]));
  });
}
