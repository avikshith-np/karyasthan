import { config, updateLlmKeys } from '../../utils/config.js';
import { writeEnvVars, LLM_KEY_ENV } from '../envWriter.js';
import { auditWrite } from '../audit.js';
import { callLlm } from '../../brain/llm.js';
import { PROVIDER_NAMES } from '../../brain/providers.js';
import { addModel, removeModel } from '../modelStore.js';

export default async function llmRoutes(app) {
  // Set/update a provider API key. In-memory immediately; optionally persisted to
  // .env (isolated 0600 write). The value is NEVER echoed back or audited — only
  // the field name + whether it persisted. Inherits readOnlyGuard + csrfGuard.
  app.post('/api/llm/keys', async (req, reply) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.field === 'string') patch[body.field] = body.value;

    const result = updateLlmKeys(patch);
    if (!result.applied.length) {
      reply.code(400).send({ error: 'no key set', rejected: result.rejected });
      return;
    }

    let persisted = false;
    if (body.persist === true) {
      const vars = {};
      for (const field of result.applied) {
        const envName = LLM_KEY_ENV[field];
        if (envName) vars[envName] = config.llm[field];
      }
      if (Object.keys(vars).length) { writeEnvVars(vars); persisted = true; }
    }

    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'llm.keys.set', null, {
      applied: result.applied, rejected: result.rejected, persisted,
    });
    return { applied: result.applied, rejected: result.rejected, persisted };
  });

  // Test a provider/model with a cheap, no-fallback probe before switching to it.
  // Rate-limited because it spends real budget. Uses the in-memory key (save the
  // key first, then test). For the current primary provider with a configured
  // baseUrl, the probe targets that same local endpoint the bot would use.
  app.route({
    method: 'POST',
    url: '/api/llm/test',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = req.body || {};
      const { provider } = body;
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!PROVIDER_NAMES.includes(provider)) {
        reply.code(400).send({ error: 'unknown provider' });
        return;
      }

      const diag = {};
      const opts = {
        provider,
        model: model || undefined,
        maxTokens: 256, // headroom for thinking models (floored to >=256 in callLlm anyway)
        temperature: 0,
        timeoutMs: 10000,
        noFallback: true,
        diag,
      };
      // No baseUrl override needed: callLlm routes provider 'local' to config.llm.baseUrl
      // and every cloud provider to its own endpoint.
      const started = Date.now();
      const text = await callLlm('Reply with exactly: ok', 'ping', opts);
      const latencyMs = Date.now() - started;
      const ok = !!text;

      auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'llm.test', null, {
        provider, model: model || null, ok, latencyMs,
      });
      return { ok, latencyMs, reply: ok ? String(text).slice(0, 80) : null, error: ok ? null : (diag.lastError || null) };
    },
  });

  // Add a model to a provider's catalog (persisted to data/llm-models.json). The
  // model id is NOT validated — providers name their own; a bad id shows up via TEST.
  app.post('/api/llm/models', async (req, reply) => {
    const { provider, model } = req.body || {};
    const r = addModel(provider, model);
    if (!r.ok) { reply.code(400).send({ error: r.error }); return; }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'llm.models.add', null, { provider, model });
    return { ok: true, provider, models: r.models };
  });

  // Remove a model from a provider's catalog.
  app.delete('/api/llm/models', async (req, reply) => {
    const { provider, model } = req.body || {};
    const r = removeModel(provider, model);
    if (!r.ok) { reply.code(400).send({ error: r.error }); return; }
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'llm.models.remove', null, { provider, model });
    return { ok: true, provider, models: r.models };
  });
}
