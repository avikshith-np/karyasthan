import { config, getSafeConfig, updateConfig, CONFIG_MUTABLE_KEYS, CONFIG_KEY_TYPES, CONFIG_ENUM_CHOICES } from '../../utils/config.js';
import { PROVIDER_NAMES } from '../../brain/providers.js';
import { getModelCatalog } from '../modelStore.js';
import { auditWrite } from '../audit.js';
import { computeEnvDiff, persistEnvDiff, KEY_TO_ENV, NOT_PERSISTABLE } from '../envWriter.js';
import { logger } from '../../utils/logger.js';
import { getMind } from './mind.js';
import { actorOf } from '../auth.js';

// allowList: [] — loopback (an SSH tunnel) is not exempt; mind.* caps are tuned here (spec 008).
const PATCH_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute', allowList: [] } };

export default async function configRoutes(app) {
  app.get('/api/config', async () => ({
    mutableKeys: CONFIG_MUTABLE_KEYS,
    // Each key's type ('int', 'float', 'int:1..1440', 'enum:…') so the Settings page
    // can pick a step and bounds, and which keys PERSIST → .ENV can write.
    types: CONFIG_KEY_TYPES,
    enums: CONFIG_ENUM_CHOICES,
    persistable: CONFIG_MUTABLE_KEYS.filter((k) => k in KEY_TO_ENV),
    notPersistable: CONFIG_MUTABLE_KEYS.filter((k) => NOT_PERSISTABLE.has(k) || !(k in KEY_TO_ENV)),
    providers: PROVIDER_NAMES,
    models: getModelCatalog(),
    values: getSafeConfig(),
  }));

  app.patch('/api/config', { config: PATCH_LIMIT }, async (req, reply) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      reply.code(400).send({ error: 'Body must be an object of key→value' });
      return;
    }
    const result = updateConfig(patch);
    auditWrite(actorOf(req), 'config.patch', null, result);
    // The owner wins (spec 008 FR-023): clear mind nudges on knobs the owner just set.
    const appliedKeys = Object.keys(result.applied || {});
    if (appliedKeys.length) {
      try { (await getMind())?.onOwnerConfigChange?.(appliedKeys); } catch (err) { logger.warn({ evt: 'issue', err: err?.message }, 'mind.onOwnerConfigChange failed'); }
    }
    return {
      ...result,
      note: 'Changes are in-memory only — restart reverts them.',
      values: getSafeConfig(),
    };
  });

  app.get('/api/config/diff', async () => computeEnvDiff());

  app.post('/api/config/persist', { config: { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } } }, async (req, reply) => {
    const body = req.body || {};
    if (body.confirm !== true) {
      reply.code(400).send({ error: 'confirm=true required — this writes to .env' });
      return;
    }
    try {
      const result = persistEnvDiff(Array.isArray(body.keys) ? body.keys : null);
      auditWrite(actorOf(req), 'config.persist', result.backup, result);
      return result;
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });
}
