import { getDb } from '../../memory/db.js';
import { getRecentMessages, searchMessages } from '../../memory/messageStore.js';

export default async function messagesRoutes(app) {
  app.get('/api/messages/recent', async (req) => {
    const group = req.query?.group?.toString();
    const limit = Math.min(parseInt(req.query?.limit || '100', 10) || 100, 500);
    if (group) return getRecentMessages(group, limit);

    const db = getDb();
    return db.prepare(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?`).all(limit);
  });

  app.get('/api/messages/search', async (req, reply) => {
    const q = (req.query?.q || '').toString().trim();
    const group = req.query?.group?.toString();
    const limit = Math.min(parseInt(req.query?.limit || '50', 10) || 50, 200);
    if (!q) { reply.code(400).send({ error: 'q required' }); return; }
    if (!group) {
      // FTS across all groups
      const db = getDb();
      return db.prepare(`
        SELECT m.* FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ?
        ORDER BY m.timestamp DESC LIMIT ?
      `).all(q, limit);
    }
    return searchMessages(q, group, limit);
  });

  app.get('/api/stats/activity', async (req) => {
    const days = Math.min(parseInt(req.query?.days || '30', 10) || 30, 180);
    const group = req.query?.group?.toString();
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const params = [cutoff];
    let where = 'timestamp >= ?';
    if (group) { where += ' AND group_jid = ?'; params.push(group); }

    const rows = db.prepare(`
      SELECT
        date(timestamp, 'unixepoch') AS day,
        SUM(is_from_self) AS self_count,
        SUM(1 - is_from_self) AS human_count
      FROM messages
      WHERE ${where}
      GROUP BY day
      ORDER BY day ASC
    `).all(...params);

    return rows;
  });
}
