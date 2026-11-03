import { config, getJevKey } from '../utils/config.js';
import { logger, scrubSecrets } from '../utils/logger.js';
import { resolveRole } from './roles.js';
import { recordUsage, budgetState, BudgetError } from './usage.js';

// Jev (TypeSafe's "System One" decision model) through OpenRouter's System One API.
// Not an LLM: it takes a `state` plus typed questions and returns typed answers with
// probabilities and confidence — Choice, Score, Noul (and Box on images). It does not
// generate text and does not read audio/video, so callers describe media first.
// Request/response shapes: https://openrouter.ai/docs/guides/community/typesafe-sdk.md
//
// Routing is the `jev` role (config.roles.jev: JEV_MODEL, JEV_TIMEOUT_MS, JEV_BUDGET_USD;
// spec 007). Every call writes one llm_usage row (cost = Jev's own usage.cost).

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';

export const noul = (instructions) => ({ type: 'noul', instructions });
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

/** Image part for `state` (PNG/JPEG; Jev needs 256–1568 px per side). */
export const imagePart = (buffer, mime = 'image/jpeg') =>
  ({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Ask Jev. Returns { model, answers, usage:{input_tokens, output_tokens, cost}, ms }.
 * Throws on HTTP/transport errors, and BudgetError when the `jev` budget (or the
 * global cap) is spent; callers decide what failing closed means.
 * `model`/`timeoutMs` default to the `jev` role; `caller` labels the ledger row.
 */
export async function askJev({ state, questions, model, timeoutMs, caller = 'jev' }) {
  const role = resolveRole('jev', config);
  const useModel = model || role.model;
  const useTimeout = timeoutMs || role.timeoutMs || 30_000;
  const record = (fields) => recordUsage({
    role: 'jev', provider: 'openrouter', model: useModel, caller, fellBack: false, ...fields,
  });

  const key = getJevKey();
  if (!key) throw new Error('No Jev key: set JEV_API_KEY or OPENROUTER_API_KEY');
  if (!useModel) throw new Error('Jev disabled: JEV_MODEL is empty');

  const budget = budgetState('jev');
  if (!budget.allowed) {
    record({ usage: {}, ok: false, status: 'budget', latencyMs: 0 });
    throw new BudgetError('jev', budget);
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, state, questions }),
      signal: AbortSignal.timeout(useTimeout),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    record({ usage: {}, ok: false, status: timedOut ? 'timeout' : 'error', latencyMs: Date.now() - started });
    throw new Error(`Jev ${timedOut ? 'timeout' : 'request failed'}: ${scrubSecrets(err?.message || String(err))}`);
  }
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  const u = body?.usage || {};
  const usage = { input: num(u.input_tokens), output: num(u.output_tokens) };
  if (!res.ok) {
    record({ usage, providerCost: u.cost, ok: false, status: `http_${res.status}`, latencyMs: ms });
    throw new Error(`Jev ${res.status}: ${scrubSecrets(body?.error?.message || JSON.stringify(body).slice(0, 200))}`);
  }
  const answeredBy = body.model || useModel;
  record({ model: answeredBy, usage, providerCost: u.cost, ok: true, status: 'ok', latencyMs: ms });
  logger.debug({ model: answeredBy, ms, cost: u.cost, caller }, 'Jev answered');
  return { model: answeredBy, answers: body.answers || {}, usage: u, ms };
}
