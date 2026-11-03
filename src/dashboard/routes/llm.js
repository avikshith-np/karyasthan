import { config, updateLlmKeys, getProviderKey, getJevKey } from '../../utils/config.js';
import { writeEnvVars, LLM_KEY_ENV } from '../envWriter.js';
import { auditWrite } from '../audit.js';
import { callRole } from '../../brain/llm.js';
import { PROVIDER_NAMES, EFFORT_LEVELS } from '../../brain/providers.js';
import { ROLE_NAMES, routingRows, resolveRole } from '../../brain/roles.js';
import { getBudgets } from '../../brain/usage.js';
import { addModel, removeModel } from '../modelStore.js';
import { actorOf } from '../auth.js';

/** Presence booleans only — never a key value. */
function keyFlags() {
  return {
    anthropic: !!getProviderKey('anthropic'),
    gemini: !!getProviderKey('gemini'),
    glm: !!getProviderKey('glm'),
    openrouter: !!getProviderKey('openrouter'),
    xai: !!getProviderKey('xai'),
    openai: !!getProviderKey('openai'),
    jev: !!getJevKey(),
  };
}

export default async function llmRoutes(app) {
  // Model-role routing for the Settings page (spec 007): the registry rows, each
  // role's raw values ('' = inherit), its effective routing right now, its month-
  // to-date budget state, and which provider keys are configured (booleans only).
  app.get('/api/llm/roles', async () => {
    const budgets = Object.fromEntries(getBudgets().map((b) => [b.name, b]));
    const roles = routingRows().map((row) => {
      const eff = resolveRole(row.role, config);
      const b = budgets[row.role];
      return {
        ...row,
        values: { ...(config.roles[row.role] || {}) },
        effective: {
          provider: eff.provider, model: eff.model, effort: eff.effort, maxTokens: eff.maxTokens,
          timeoutMs: eff.timeoutMs, budgetUsd: eff.budgetUsd, fallback: eff.fallback,
          disabled: eff.disabled, shadowOnly: eff.shadowOnly,
        },
        budget: b ? { budgetUsd: b.budgetUsd, spentUsd: b.spentUsd, state: b.state } : null,
      };
    });
    const g = budgets.global;
    return {
      roles,
      global: g ? { budgetUsd: g.budgetUsd, spentUsd: g.spentUsd, state: g.state } : null,
      keys: keyFlags(),
      // Option lists for the Settings form (so the page hardcodes none of them).
      providers: PROVIDER_NAMES,
      efforts: EFFORT_LEVELS,
      localConfigured: !!config.llm.baseUrl, // boolean only — the URL stays .env-side
    };
  });

  // Set/update a provider API key. In-memory immediately; optionally persisted to
  // .env (isolated 0600 write). The value is NEVER echoed back or audited — only
  // the field name + whether it persisted. Inherits readOnlyGuard + csrfGuard.
  app.post('/api/llm/keys', { config: { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } } }, async (req, reply) => {
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

    auditWrite(actorOf(req), 'llm.keys.set', null, {
      applied: result.applied, rejected: result.rejected, persisted,
    });
    return { applied: result.applied, rejected: result.rejected, persisted };
  });

  // Test a provider/model — or a role's current primary ({role}) — with a cheap,
  // no-fallback probe before switching to it. Metered under the `probe` label.
  // Rate-limited because it spends real budget. Uses the in-memory key (save the
  // key first, then test). Provider 'local' is probed at config.llm.baseUrl; every
  // cloud provider at its own endpoint (callRole routes both).
  app.route({
    method: 'POST',
    url: '/api/llm/test',
    config: { rateLimit: { max: 10, timeWindow: '1 minute', allowList: [] } },
    handler: async (req, reply) => {
      const body = req.body || {};
      let provider;
      let model;
      let effort;
      let role = null;
      if (body.role !== undefined) {
        if (!ROLE_NAMES.includes(body.role)) {
          reply.code(400).send({ error: 'unknown role' });
          return;
        }
        const eff = resolveRole(body.role, config);
        if (eff.kind !== 'chat') {
          reply.code(400).send({ error: 'not a text role (Jev is tested from the Instagram page)' });
          return;
        }
        if (eff.disabled) {
          reply.code(400).send({ error: 'role disabled (no provider/model)' });
          return;
        }
        role = body.role;
        ({ provider, model, effort } = eff);
      } else {
        provider = body.provider;
        model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!PROVIDER_NAMES.includes(provider)) {
          reply.code(400).send({ error: 'unknown provider' });
          return;
        }
      }

      const diag = {};
      const opts = {
        caller: role ? `probe.${role}` : 'probe',
        provider,
        model: model || undefined,
        maxTokens: 256, // headroom for thinking models (floored to >=256 in callRole anyway)
        temperature: 0,
        timeoutMs: 10000,
        noFallback: true,
        diag,
      };
      if (effort !== undefined) opts.effort = effort;
      const started = Date.now();
      const res = await callRole('probe', 'Reply with exactly: ok', 'ping', opts);
      const latencyMs = Date.now() - started;
      const text = res?.text || null;
      const ok = !!text;

      auditWrite(actorOf(req), 'llm.test', null, {
        role, provider, model: model || null, ok, latencyMs,
      });
      return {
        ok,
        latencyMs,
        role,
        provider,
        model: res?.model || model || null,
        reply: ok ? String(text).slice(0, 80) : null,
        error: ok ? null : (diag.lastError || (res?.skipped ? { message: res.skipped } : null)),
        usage: res?.usage || null,
        costUsd: res?.costUsd ?? null,
      };
    },
  });

  // Add a model to a provider's catalog (persisted to data/llm-models.json). The
  // model id is NOT validated — providers name their own; a bad id shows up via TEST.
  app.post('/api/llm/models', async (req, reply) => {
    const { provider, model } = req.body || {};
    const r = addModel(provider, model);
    if (!r.ok) { reply.code(400).send({ error: r.error }); return; }
    auditWrite(actorOf(req), 'llm.models.add', null, { provider, model });
    return { ok: true, provider, models: r.models };
  });

  // Remove a model from a provider's catalog.
  app.delete('/api/llm/models', async (req, reply) => {
    const { provider, model } = req.body || {};
    const r = removeModel(provider, model);
    if (!r.ok) { reply.code(400).send({ error: r.error }); return; }
    auditWrite(actorOf(req), 'llm.models.remove', null, { provider, model });
    return { ok: true, provider, models: r.models };
  });
}
