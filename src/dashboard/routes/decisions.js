import { getDb } from '../../memory/db.js';

function parseFactors(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export default async function decisionsRoutes(app) {
  app.get('/api/decisions', async (req) => {
    const db = getDb();
    const group = req.query?.group?.toString();
    const decided = req.query?.decided?.toString();
    const since = req.query?.since ? parseInt(req.query.since, 10) : null;
    const limit = Math.min(parseInt(req.query?.limit || '200', 10) || 200, 1000);

    const where = [];
    const params = [];
    if (group)   { where.push('rl.group_jid = ?'); params.push(group); }
    if (decided) { where.push('rl.decided = ?'); params.push(decided); }
    if (since)   { where.push('rl.created_at >= ?'); params.push(since); }

    const sql = `
      SELECT rl.id, rl.message_id, rl.group_jid, rl.score, rl.decided,
             rl.factors_json, rl.created_at,
             m.sender_name, m.content, m.timestamp AS msg_timestamp, m.message_type
      FROM response_log rl
      LEFT JOIN messages m ON m.id = rl.message_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY rl.created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all(...params);

    return rows.map(r => ({
      id: r.id,
      messageId: r.message_id,
      groupJid: r.group_jid,
      score: r.score,
      decided: r.decided,
      factors: parseFactors(r.factors_json),
      createdAt: r.created_at,
      message: r.content ? {
        senderName: r.sender_name,
        content: r.content,
        timestamp: r.msg_timestamp,
        type: r.message_type,
      } : null,
    }));
  });

  app.get('/api/quality', async (req) => {
    const db = getDb();
    const group = req.query?.group?.toString();
    const since = req.query?.since ? parseInt(req.query.since, 10) : Math.floor(Date.now() / 1000) - 7 * 86400;

    const groupClause = group ? 'AND group_jid = ?' : '';
    const params = group ? [since, group] : [since];

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(was_gated) AS gated_count,
        AVG(quality_score) AS avg_score,
        SUM(reaction_count) AS total_reactions,
        SUM(positive_reactions) AS pos_reactions,
        SUM(negative_reactions) AS neg_reactions
      FROM response_quality
      WHERE created_at >= ? ${groupClause}
    `).get(...params);

    const recentGated = db.prepare(`
      SELECT id, message_id, group_jid, response_text, trigger_msg_id,
             quality_score, quality_reason, created_at
      FROM response_quality
      WHERE was_gated = 1 AND created_at >= ? ${groupClause}
      ORDER BY created_at DESC LIMIT 50
    `).all(...params);

    return {
      since,
      stats,
      recentGated,
    };
  });
}
