import { cleanExpiredMemories, decayMemories } from '../../memory/relationshipStore.js';
import { expireStaleBills } from '../../memory/billStore.js';
import { auditWrite } from '../audit.js';
import { actorOf } from '../auth.js';

export default async function maintenanceRoutes(app) {
  app.post('/api/maintenance/memory', async (req) => {
    const expired = cleanExpiredMemories();
    const decayed = decayMemories();
    const result = { expired, decayed: decayed.changes };
    auditWrite(actorOf(req), 'maintenance.memory', null, result);
    return result;
  });

  app.post('/api/maintenance/bills', async (req) => {
    const r = expireStaleBills(2 * 60 * 60);
    const result = { expired: r.changes };
    auditWrite(actorOf(req), 'maintenance.bills', null, result);
    return result;
  });
}
