import { getRecentAudit } from '../audit.js';

export default async function auditRoutes(app) {
  app.get('/api/audit', async (req) => {
    const limit = Math.min(parseInt(req.query?.limit || '100', 10) || 100, 500);
    const rows = getRecentAudit(limit);
    return rows.map(r => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      target: r.target,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    }));
  });
}
