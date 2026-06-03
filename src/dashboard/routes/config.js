import { config, getSafeConfig, updateConfig, CONFIG_MUTABLE_KEYS } from '../../utils/config.js';
import { auditWrite } from '../audit.js';
import { computeEnvDiff, persistEnvDiff } from '../envWriter.js';

export default async function configRoutes(app) {
  app.get('/api/config', async () => ({
    mutableKeys: CONFIG_MUTABLE_KEYS,
    values: getSafeConfig(),
  }));

  app.patch('/api/config', async (req, reply) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      reply.code(400).send({ error: 'Body must be an object of key→value' });
      return;
    }
    const result = updateConfig(patch);
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'config.patch', null, result);
    return {
      ...result,
      note: 'Changes are in-memory only — restart reverts them.',
      values: getSafeConfig(),
    };
  });

  app.get('/api/config/diff', async () => computeEnvDiff());

  app.post('/api/config/persist', async (req, reply) => {
    const body = req.body || {};
    if (body.confirm !== true) {
      reply.code(400).send({ error: 'confirm=true required — this writes to .env' });
      return;
    }
    try {
      const result = persistEnvDiff(Array.isArray(body.keys) ? body.keys : null);
      auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'config.persist', result.backup, result);
      return result;
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });
}
