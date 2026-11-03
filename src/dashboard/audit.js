import { getDb } from '../memory/db.js';
import { logger } from '../utils/logger.js';

export function auditWrite(actor, action, target, payload) {
  try {
    getDb().prepare(
      `INSERT INTO dashboard_audit (actor, action, target, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(actor || 'unknown', action, target || null, payload ? JSON.stringify(payload) : null);
  } catch (err) {
    logger.warn({ err: err.message, action, target }, 'Failed to write dashboard_audit row');
  }
}

export function getRecentAudit(limit = 100) {
  try {
    return getDb().prepare(
      `SELECT * FROM dashboard_audit ORDER BY ts DESC LIMIT ?`
    ).all(limit);
  } catch {
    return [];
  }
}
