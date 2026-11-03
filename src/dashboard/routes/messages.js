import { getDb } from '../../memory/db.js';
import { searchMessages } from '../../memory/messageStore.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../utils/config.js';

// A user-typed MATCH string that FTS can't parse (unbalanced quote, stray
// operator, `col:` filter…) — the caller's fault, not ours.
const FTS_QUERY_ERR = /fts5|syntax error|unterminated string|no such column|malformed MATCH|unknown special query/i;

export default async function messagesRoutes(app) {
  app.get('/api/messages/search', async (req, reply) => {
    const q = (req.query?.q || '').toString().trim();
    const group = req.query?.group?.toString();
    const limit = Math.min(parseInt(req.query?.limit || '50', 10) || 50, 200);
    if (!q) { reply.code(400).send({ error: 'q required' }); return; }
    try {
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
    } catch (err) {
      // Never hand SQLite's message back to the client.
      if (err?.code === 'SQLITE_ERROR' && FTS_QUERY_ERR.test(err.message || '')) {
        reply.code(400).send({ error: 'invalid search query' });
        return;
      }
      logger.error({ err: err?.message, path: '/api/messages/search' }, 'Message search failed');
      reply.code(500).send({ error: 'Internal error' });
    }
  });

  // Messages per calendar day in the bot's timezone (config.timezone), for the Status
  // volume chart. SQLite has no timezone table, so rows are counted per 15-minute bucket
  // (every real UTC offset is a multiple of 15 min) and each bucket is assigned to its
  // local day here. The window starts at local midnight `days - 1` days ago.
  app.get('/api/stats/activity', async (req) => {
    const days = Math.min(parseInt(req.query?.days || '30', 10) || 30, 180);
    const group = req.query?.group?.toString();
    const db = getDb();
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const keyOf = (sec) => dayKey.format(new Date(sec * 1000));
    const now = Math.floor(Date.now() / 1000);
    const firstKey = keyOf(now - (days - 1) * 86400);
    // Rough lower bound (a day of slack either side of the offset), trimmed by key below.
    const cutoff = now - (days + 1) * 86400;

    const params = [cutoff];
    let where = 'timestamp >= ?';
    if (group) { where += ' AND group_jid = ?'; params.push(group); }

    const buckets = db.prepare(`
      SELECT
        (timestamp / 900) * 900 AS t,
        SUM(is_from_self) AS self_count,
        SUM(1 - is_from_self) AS human_count
      FROM messages
      WHERE ${where}
      GROUP BY t
      ORDER BY t ASC
    `).all(...params);

    const byDay = new Map();
    for (const b of buckets) {
      const day = keyOf(b.t);
      if (day < firstKey) continue;
      const cur = byDay.get(day) || { day, self_count: 0, human_count: 0 };
      cur.self_count += Number(b.self_count) || 0;
      cur.human_count += Number(b.human_count) || 0;
      byDay.set(day, cur);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  });
}
