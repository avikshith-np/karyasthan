import { config, getProviderKey } from '../utils/config.js';
import { logger, scrubSecrets } from '../utils/logger.js';
import { PROVIDER_NAMES, PROVIDER_KEY_FIELD } from './providers.js';
import { ROLE_NAMES, METERED_LABELS, resolveRole } from './roles.js';
import { recordUsage, budgetState } from './usage.js';

// Provider adapters. Every provider-specific detail (endpoint, auth header, body
// shape, effort knob, usage fields, refusal) lives here; callRole below is
// provider-agnostic (roles, chains, budgets, metering).
//
// buildRequest({ system, user, model, maxTokens, temperature, effort, key })
//   system: string | { core, profile, volatile? }  (core = stable prefix, profile = group profile;
//     volatile = its bytes change every turn, as while imitating: no cache marker, no write premium)
// extractText(data) → string|null
// extractUsage(data) → { input, output, cacheRead, cacheWrite, providerCost } | null
//   input = UNCACHED input tokens; output includes reasoning/thinking when reported.
// isRefusal(data) → { category } | null   (non-retryable link failure)

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One system string for providers with a single system message (stable bytes first). */
function systemText(system) {
  if (typeof system === 'string') return system;
  return [system?.core, system?.profile].filter((t) => typeof t === 'string' && t).join('\n');
}

function chatMessages(system, user) {
  return [
    { role: 'system', content: systemText(system) },
    { role: 'user', content: user },
  ];
}

const chatText = (data) => data?.choices?.[0]?.message?.content || null;

/**
 * OpenAI-compatible usage block → ledger shape. cached_tokens are part of prompt_tokens. A
 * total above prompt + completion is output the completion count left out (a thinking model's
 * reasoning, billed as output): `output` includes it, as the ledger's contract says.
 */
function openaiCompatUsage(data) {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  const cacheRead = num(u.prompt_tokens_details?.cached_tokens);
  const cacheWrite = num(u.prompt_tokens_details?.cache_write_tokens);
  const hidden = prompt !== null && completion !== null && total !== null ? Math.max(0, total - prompt - completion) : 0;
  return {
    input: prompt === null ? null : Math.max(0, prompt - (cacheRead || 0) - (cacheWrite || 0)),
    output: completion === null ? null : completion + hidden,
    cacheRead,
    cacheWrite,
    providerCost: null,
  };
}

// xAI's usage.cost_in_usd_ticks: 1 USD = 10^10 ticks (docs.x.ai/developers/cost-tracking).
const XAI_TICKS_PER_USD = 1e10;

// Models that accept the `fallbacks: "default"` server-side refusal fallback.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

const PROVIDERS = {
  // Anthropic Messages API, shaped for Opus 5.5 (spec 007 R3): no sampling params
  // (400 on Opus 5.5) and no `thinking` field (always on; disabled/budget is a 400) —
  // depth is `output_config.effort`. The system prompt is cacheable text blocks.
  // Dropping temperature HERE (not at call sites) keeps a role that falls back to
  // Anthropic safe. anthropic-version stays 2023-06-01 (owner decision O8).
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    buildRequest({ system, user, model, maxTokens, effort, key }) {
      const parts = typeof system === 'string' ? [system] : [system?.core, system?.profile];
      // A volatile system (imitating: per-turn exemplars at its head) can never be read back, so a
      // marker would only pay the write premium.
      const volatile = typeof system === 'object' && system?.volatile === true;
      // Empty text blocks are a 400; a block below the cacheable minimum just doesn't cache.
      const blocks = parts
        .filter((t) => typeof t === 'string' && t.length)
        .map((text) => (volatile ? { type: 'text', text } : { type: 'text', text, cache_control: { type: 'ephemeral' } }));
      const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: user }] };
      if (blocks.length) body.system = blocks;
      if (effort) body.output_config = { effort };
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      };
      // Server-side refusal fallback: on a safety decline Anthropic re-runs the
      // request on a model it picks per refusal category, inside the same call.
      if (SERVER_FALLBACK_MODELS.has(model)) {
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }
      return { method: 'POST', headers, body: JSON.stringify(body) };
    },
    // Thinking blocks (empty by default) may precede the text; join every text block.
    extractText(data) {
      const text = (Array.isArray(data?.content) ? data.content : [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      return text || null;
    },
    extractUsage(data) {
      const u = data?.usage;
      if (!u) return null;
      return {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        providerCost: null,
      };
    },
    isRefusal(data) {
      return data?.stop_reason === 'refusal' ? { category: data?.stop_details?.category || null } : null;
    },
    finishReason: (data) => data?.stop_reason,
    // Server-side refusal fallback: the served-by signal is a `fallback_message` entry in
    // usage.iterations (sticky-served turns carry no `fallback` content block); top-level
    // `model` names the model that produced the message. A dated snapshot of the
    // requested id (`<model>-YYYYMMDD`) is the same model, not a fallback.
    servedBy(data, requested) {
      const iters = Array.isArray(data?.usage?.iterations) ? data.usage.iterations : [];
      const viaIteration = iters.some((it) => it?.type === 'fallback_message');
      const served = typeof data?.model === 'string' && data.model ? data.model : null;
      const esc = String(requested || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const snapshot = !!served && new RegExp(`^${esc}-\\d{8}$`).test(served);
      const otherModel = !!served && served !== requested && !snapshot;
      if (!viaIteration && !otherModel) return null;
      return { model: otherModel ? served : (served || requested), fellBack: true };
    },
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    buildRequest({ system, user, model, maxTokens, temperature, key }) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: chatMessages(system, user) }),
      };
    },
    extractText: chatText,
    extractUsage: openaiCompatUsage,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
    buildRequest({ system, user, model, maxTokens, temperature, effort, key }) {
      const body = { model, max_tokens: maxTokens, temperature };
      // The role's effort (mouth/gate default 'low' = the value this adapter always
      // sent before roles). It also keeps thinking from bleeding into the content of
      // Gemini "thinking" models on the OpenAI-compat endpoint; Gemini rejects
      // reasoning_effort + thinking_config together, so only this knob is used.
      // An explicit '' sends none (owner opt-out). postProcess stays the hard guarantee.
      if (effort) body.reasoning_effort = effort;
      body.messages = chatMessages(system, user);
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
      };
    },
    extractText: chatText,
    // Implicit-cache hits appear as usage.prompt_tokens_details.cached_tokens (verify: T015 --live).
    extractUsage: openaiCompatUsage,
  },
  glm: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    buildRequest({ system, user, model, maxTokens, temperature, key }) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: chatMessages(system, user) }),
      };
    },
    extractText: chatText,
    extractUsage: openaiCompatUsage,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    buildRequest({ system, user, model, maxTokens, temperature, effort, key }) {
      const body = { model, max_tokens: maxTokens, messages: chatMessages(system, user) };
      // Anthropic models (Opus 5.5) reject sampling params natively. Don't rely on
      // OpenRouter stripping them: drop temperature here, like the anthropic adapter.
      if (!String(model || '').startsWith('anthropic/')) body.temperature = temperature;
      // OpenRouter's unified reasoning knob, and its own cost in the response's
      // usage.cost (both to verify: T015 --live).
      if (effort) body.reasoning = { effort };
      body.usage = { include: true };
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
      };
    },
    extractText: chatText,
    extractUsage(data) {
      const u = openaiCompatUsage(data);
      if (!u) return null;
      const cost = data?.usage?.cost;
      u.providerCost = typeof cost === 'number' || typeof cost === 'string' ? cost : null;
      return u;
    },
  },
  // xAI direct, with a key from console.x.ai. Model ids have no vendor prefix here (grok-4.7, not
  // OpenRouter's x-ai/grok-4.7). xAI calls this endpoint legacy, with no removal date; its
  // Responses API is what it recommends for new work. max_tokens is deprecated there, and
  // max_completion_tokens caps the visible answer only: reasoning is billed on top of it.
  // Which efforts a model takes depends on the model (docs.x.ai/developers/rest-api-reference/
  // inference/chat-completions). The example there has total_tokens above prompt + completion by
  // the reasoning tokens, which openaiCompatUsage counts as output either way.
  xai: {
    url: 'https://api.x.ai/v1/chat/completions',
    buildRequest({ system, user, model, maxTokens, temperature, effort, key }) {
      const body = { model, max_completion_tokens: maxTokens, temperature };
      if (effort) body.reasoning_effort = effort;
      body.messages = chatMessages(system, user);
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
      };
    },
    extractText: chatText,
    extractUsage(data) {
      const u = openaiCompatUsage(data);
      if (!u) return null;
      // A missing or zero cost leaves the price table to count it, so tokens never go unbudgeted.
      const ticks = num(data.usage.cost_in_usd_ticks);
      u.providerCost = ticks > 0 ? ticks / XAI_TICKS_PER_USD : null;
      return u;
    },
  },
  ollama: {
    url: 'http://127.0.0.1:11434/api/chat',
    buildRequest({ system, user, model, maxTokens, temperature }) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature, num_predict: maxTokens },
          messages: chatMessages(system, user),
        }),
      };
    },
    extractText(data) {
      return data?.message?.content || null;
    },
    extractUsage(data) {
      if (data?.prompt_eval_count == null && data?.eval_count == null) return null;
      return { input: num(data.prompt_eval_count), output: num(data.eval_count), cacheRead: null, cacheWrite: null, providerCost: null };
    },
  },
  // Local OpenAI-compatible server (llama.cpp / LM Studio / vLLM). Same request
  // shape as `openai`; its endpoint is config.llm.baseUrl (LLM_BASE_URL), resolved
  // in runLink below — so selecting "local" routes the bot to your own server.
  local: {
    url: '',
    buildRequest({ system, user, model, maxTokens, temperature }) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Own key only (LLM_LOCAL_API_KEY) — never a cloud key, since
          // LLM_BASE_URL can point anywhere.
          'Authorization': `Bearer ${config.llm.localApiKey || 'local'}`,
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: chatMessages(system, user) }),
      };
    },
    extractText: chatText,
    extractUsage: openaiCompatUsage,
  },
};

// The dashboard-facing provider enum (providers.js) must stay in sync with the
// runtime PROVIDERS map. Warn loudly at load if they drift.
if (PROVIDER_NAMES.length !== Object.keys(PROVIDERS).length ||
    !PROVIDER_NAMES.every((p) => PROVIDERS[p])) {
  logger.warn(
    { enum: PROVIDER_NAMES, map: Object.keys(PROVIDERS) },
    'PROVIDER_NAMES (providers.js) drifted from the PROVIDERS map (llm.js)',
  );
}

// Floor the completion budget. Thinking models (e.g. gemini-3-flash-preview) burn
// ~50 hidden reasoning tokens against max_tokens BEFORE emitting any content, so a
// tiny cap yields HTTP 200 with EMPTY content (finish_reason=length). 256 leaves
// ample headroom and Math.max never shrinks a larger configured budget — this is
// the single chokepoint that protects every callsite (test probe, GIF picker,
// quality gate) from the small-cap-empties-reasoning-models failure.
const MIN_COMPLETION_BUDGET = 256;

// Roles that are chat input/output — plus the quality gate, the safety net on that
// output: over budget they degrade, they are never blocked.
const FLOOR_ROLES = new Set(['mouth', 'senses', 'gate']);

const EMPTY_USAGE = { input: null, output: null, cacheRead: null, cacheWrite: null };

// ── throttled notices ─────────────────────────────────────────────────────────
const noticeAt = new Map();
function noticeOncePer(key, ms) {
  const t = Date.now();
  const last = noticeAt.get(key) || 0;
  if (t - last < ms) return false;
  noticeAt.set(key, t);
  return true;
}

const warnedSites = new Set();
function warnMissingRole() {
  const site = (new Error().stack || '').split('\n')[4]?.trim() || 'unknown';
  if (warnedSites.has(site)) return;
  warnedSites.add(site);
  logger.warn({ site }, "LLM call without a role — treated as 'mouth' (pass opts.role)");
}

function scrubError(lastError) {
  if (!lastError) return lastError;
  const out = { ...lastError };
  if (out.body) out.body = scrubSecrets(out.body);
  if (out.message) out.message = scrubSecrets(out.message);
  return out;
}

function pickUsage(u) {
  return {
    input: u?.input ?? null,
    output: u?.output ?? null,
    cacheRead: u?.cacheRead ?? null,
    cacheWrite: u?.cacheWrite ?? null,
  };
}

function skippedResult(reason) {
  return { text: null, provider: null, model: null, usage: pickUsage(null), costUsd: null, fellBack: false, status: reason, skipped: reason };
}

/**
 * Run one chain link: key check → attempts (retry/backoff, fresh per-attempt signal)
 * → one ledger row. `timeoutMs` bounds the WHOLE link (retries + backoff), not each
 * attempt: a per-attempt budget would multiply a bounded caller's worst case (the
 * quality gate runs inside the turn guard). No retry starts once what is left can't
 * cover the backoff. The next link gets its own budget.
 */
async function runLink(link, ctx) {
  const { system, user, opts, roleName, temperature, maxTokens, effort, timeoutMs, maxAttempts } = ctx;
  const providerName = link.provider;
  const model = link.model;
  const base = { provider: providerName, model, fellBack: !!link.fellBack };
  const adapter = PROVIDERS[providerName];
  const record = (fields) => recordUsage({
    role: roleName, provider: providerName, model, caller: opts.caller || null, fellBack: !!link.fellBack, ...fields,
  });

  if (!adapter) {
    logger.error({ providerName }, 'Unknown LLM provider');
    record({ usage: EMPTY_USAGE, ok: false, status: 'unroutable', latencyMs: 0 });
    return { ...base, text: null, status: 'error', lastError: { message: `unknown provider ${providerName}` } };
  }

  // Own key only (spec 007 R7): an unkeyed cloud provider fails before any network call.
  let key = null;
  if (PROVIDER_KEY_FIELD[providerName]) {
    key = getProviderKey(providerName);
    if (!key) {
      const lastError = { message: 'no key' };
      if (opts.diag) opts.diag.lastError = lastError;
      logger.warn({ role: roleName, provider: providerName, model, caller: opts.caller }, `LLM link skipped — no ${providerName} key configured`);
      record({ usage: EMPTY_USAGE, ok: false, status: 'no_key', latencyMs: 0 });
      return { ...base, text: null, status: 'no_key', lastError };
    }
  }

  // LLM_BASE_URL is the address of the 'local' provider and applies ONLY to provider
  // 'local' — never to a cloud provider. There is no per-call URL override (SSRF).
  const url = providerName === 'local' ? config.llm.baseUrl : adapter.url;
  if (!url) {
    const lastError = { message: 'local base URL not set (LLM_BASE_URL)' };
    if (opts.diag) opts.diag.lastError = lastError;
    logger.warn({ role: roleName, provider: providerName }, lastError.message);
    record({ usage: EMPTY_USAGE, ok: false, status: 'unroutable', latencyMs: 0 });
    return { ...base, text: null, status: 'error', lastError };
  }

  const reqOptions = adapter.buildRequest({ system, user, model, maxTokens, temperature, effort, key });
  const deadline = timeoutMs ? Date.now() + timeoutMs : null;
  const budgetLeft = () => (deadline ? deadline - Date.now() : Infinity);
  const linkStart = Date.now();

  let lastError = null;
  let status = 'error';
  let usage = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const startTime = Date.now();
      // Fresh signal per attempt: one shared across the loop stays aborted after the
      // first timeout, so every retry would abort instantly.
      const attemptOptions = deadline
        ? { ...reqOptions, signal: AbortSignal.timeout(Math.max(1, budgetLeft())) }
        : reqOptions;
      const res = await fetch(url, attemptOptions);

      if (!res.ok) {
        const errBody = scrubSecrets(await res.text().catch(() => ''));
        logger.warn({ role: roleName, provider: providerName, status: res.status, attempt, errBody: errBody.slice(0, 200) }, 'LLM API error');
        lastError = { status: res.status, body: errBody.slice(0, 300) };
        status = `http_${res.status}`;
        if (opts.diag) opts.diag.lastError = lastError;

        const backoff = 1000 * Math.pow(3, attempt - 1); // 1s, 3s
        if (attempt < maxAttempts && budgetLeft() > backoff) {
          await sleep(backoff);
          continue;
        }
        break;
      }

      const data = await res.json();
      usage = adapter.extractUsage?.(data) || null;
      const latencyMs = Date.now() - startTime;

      const refusal = adapter.isRefusal?.(data);
      if (refusal) {
        // A refusal is terminal for this link: no retry, the role's fallback runs.
        // Only the category is logged — never the refused content.
        logger.warn({ role: roleName, provider: providerName, model, latencyMs, category: refusal.category }, 'LLM refused — trying the role fallback');
        lastError = { status: 200, body: `refusal${refusal.category ? ` (${refusal.category})` : ''}` };
        status = 'refusal';
        if (opts.diag) opts.diag.lastError = lastError;
        break;
      }

      const text = adapter.extractText(data);
      if (!text) {
        // HTTP 200 but no content. Two deterministic causes: (a) a provider content
        // filter (e.g. Gemini PROHIBITED_CONTENT — finish_reason safety/stop, 0 output),
        // or (b) the budget was exhausted by hidden reasoning tokens (finish_reason
        // "length"). Retrying is pointless either way → go straight to the fallback. We
        // surface finish_reason so the dashboard TEST distinguishes "raise max_tokens"
        // from a real content filter.
        const finishReason = adapter.finishReason?.(data) || data?.choices?.[0]?.finish_reason || data?.candidates?.[0]?.finishReason || 'unknown';
        logger.warn(
          { role: roleName, provider: providerName, model, latencyMs, finishReason, body: scrubSecrets(JSON.stringify(data)).slice(0, 200) },
          'LLM returned empty content — trying fallback provider',
        );
        const raise = finishReason === 'length' || finishReason === 'max_tokens';
        lastError = { status: 200, body: `empty content (finish_reason=${finishReason}${raise ? ' — raise max_tokens' : ''})` };
        status = 'empty';
        if (opts.diag) opts.diag.lastError = lastError;
        break;
      }

      // A provider-side fallback inside this call (Anthropic `fallbacks`) is a fall-back
      // like a chain link: the served model is recorded and the result says fellBack.
      const served = adapter.servedBy?.(data, model) || null;
      const servedModel = served?.model || model;
      const fellBack = !!link.fellBack || !!served?.fellBack;
      logger.info({ role: roleName, caller: opts.caller, provider: providerName, model: servedModel, latencyMs, tokens: text.length, fellBack,
        ...(served ? { requestedModel: model, serverFallback: true } : {}) }, 'LLM response');
      const cost = record({
        usage: usage || EMPTY_USAGE, providerCost: usage?.providerCost, latencyMs: Date.now() - linkStart, ok: true, status: 'ok',
        ...(served ? { model: servedModel, fellBack: true } : {}),
      });
      return { ...base, model: servedModel, fellBack, serverFellBack: !!served, text, status: 'ok', usage: usage || EMPTY_USAGE,
        costUsd: cost.costUsd, lastError: null };
    } catch (err) {
      const message = scrubSecrets(err?.message || String(err));
      logger.warn({ role: roleName, provider: providerName, err: message, attempt }, 'LLM call failed');
      lastError = { message };
      status = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'error';
      if (opts.diag) opts.diag.lastError = lastError;
      const backoff = 1000 * Math.pow(3, attempt - 1);
      if (attempt < maxAttempts && budgetLeft() > backoff) {
        await sleep(backoff);
        continue;
      }
      break;
    }
  }

  const cost = record({
    usage: usage || EMPTY_USAGE, providerCost: usage?.providerCost, latencyMs: Date.now() - linkStart, ok: false, status,
  });
  return { ...base, text: null, status, usage: usage || EMPTY_USAGE, costUsd: cost.costUsd, lastError };
}

/**
 * Call a model role. Never throws.
 *
 *   role    'mouth' | 'clerk' | 'mind' | 'fun' | 'gate', or the 'probe' label
 *   system  string | { core, profile }
 *   opts    { caller, send (true when the text goes to a chat: reply, ig.chat, ig.caption),
 *             msgId, groupJid, maxTokens, temperature, timeoutMs, noFallback, diag, effort,
 *             provider, model (explicit primary: dashboard probe and not-yet-migrated callers) }
 *
 * → { text, provider, model, usage:{input,output,cacheRead,cacheWrite}, costUsd,
 *     fellBack, status, skipped?: 'budget'|'disabled'|'no_key'|'shadow_only' }
 *
 * The chain is [primary, that role's fallback] (spec 007 R4). Each link is
 * budget-checked and writes one llm_usage row. Over budget, mouth (and senses)
 * degrade to the fallback and, failing that, use the primary anyway — chat is
 * never blocked; every other role skips.
 */
export async function callRole(role, system, user, opts = {}) {
  let roleName = role;
  if (!roleName) {
    warnMissingRole();
    roleName = 'mouth';
  }
  const isProbe = roleName === 'probe';
  if (!ROLE_NAMES.includes(roleName) && !isProbe) {
    logger.error({ role: roleName, caller: opts.caller }, METERED_LABELS.includes(roleName)
      ? 'callRole: metered labels other than probe have no text route'
      : 'callRole: unknown role');
    return skippedResult('disabled');
  }

  const r = isProbe
    ? { name: 'probe', kind: 'label', provider: '', model: '', effort: 'low', maxTokens: 0, timeoutMs: 0, fallback: null, disabled: false, shadowOnly: false }
    : resolveRole(roleName, config);
  if (r.kind === 'jev') {
    logger.error({ caller: opts.caller }, "callRole: 'jev' is not a text role — use askJev()");
    return skippedResult('disabled');
  }

  // Principle VI: a shadow-only role can never produce text that is sent to a chat.
  if (r.shadowOnly && opts.send === true) {
    logger.warn({ role: roleName, caller: opts.caller }, 'shadow-only role refused for a chat send');
    return skippedResult('shadow_only');
  }

  // An explicit provider/model (dashboard probe, or a caller not yet migrated to a
  // role) replaces the primary; the role still supplies effort, limits and fallback.
  const primary = opts.provider
    ? { provider: opts.provider, model: opts.model || r.model }
    : { provider: r.provider, model: r.model };
  if (!opts.provider && r.disabled) {
    logger.debug({ role: roleName, caller: opts.caller }, 'LLM role disabled — skipped');
    return skippedResult('disabled');
  }
  if (!primary.provider || !primary.model) return skippedResult('disabled');

  let fallback = !opts.noFallback && !isProbe && r.fallback ? { ...r.fallback, fellBack: true } : null;
  if (fallback && fallback.provider === primary.provider && fallback.model === primary.model) fallback = null;

  const ctx = {
    system,
    user,
    opts,
    roleName,
    temperature: opts.temperature ?? config.llm.temperature,
    maxTokens: Math.max(opts.maxTokens || r.maxTokens || config.llm.maxTokens, MIN_COMPLETION_BUDGET),
    effort: opts.effort !== undefined ? opts.effort : r.effort,
    timeoutMs: opts.timeoutMs !== undefined ? opts.timeoutMs : r.timeoutMs,
    maxAttempts: opts.noFallback ? 2 : 3,
  };

  const budgetRow = (link) => recordUsage({
    role: roleName, provider: link.provider, model: link.model, caller: opts.caller || null,
    usage: EMPTY_USAGE, ok: false, status: 'budget', latencyMs: 0, fellBack: !!link.fellBack,
  });

  // ── budget → the links to run ──
  let links = [primary, ...(fallback ? [fallback] : [])];
  const state = budgetState(roleName);
  if (!state.allowed) {
    const detail = { role: roleName, reason: state.reason, spentUsd: state.spentUsd, budgetUsd: state.budgetUsd, globalSpentUsd: state.globalSpentUsd, globalBudgetUsd: state.globalBudgetUsd };
    if (FLOOR_ROLES.has(roleName)) {
      // Degrade, never block: the fallback first; if it fails or is unusable, the
      // primary anyway (the floor).
      const usableFallback = !!fallback && (!PROVIDER_KEY_FIELD[fallback.provider] || !!getProviderKey(fallback.provider));
      if (noticeOncePer(`degraded:${roleName}`, 3_600_000)) {
        logger.warn({ evt: 'budget_degraded', ...detail }, `${roleName} over budget — ${usableFallback ? 'using its fallback' : 'no usable fallback, primary anyway (floor)'}`);
      }
      if (usableFallback) {
        budgetRow(primary);
        links = [fallback, { ...primary, floor: true }];
      } else {
        links = [{ ...primary, floor: true }];
      }
    } else {
      if (noticeOncePer(`skip:${roleName}`, 3_600_000)) {
        logger.warn({ evt: 'budget_skip', ...detail }, `${roleName} over budget — skipped until next month`);
      }
      budgetRow(primary);
      if (opts.diag) opts.diag.lastError = { message: `budget (${state.reason})` };
      return { ...skippedResult('budget'), provider: primary.provider, model: primary.model };
    }
  }

  let last = null;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    // Re-check before a later link of a skippable role (the first may have crossed it).
    if (i > 0 && !FLOOR_ROLES.has(roleName) && !budgetState(roleName).allowed) {
      budgetRow(link);
      break;
    }
    if (i > 0) {
      logger.info({
        role: roleName,
        from: { provider: last.provider, model: last.model },
        to: { provider: link.provider, model: link.model },
        reason: last.lastError,
      }, `${link.floor ? 'Budget floor: back to the primary' : 'Primary LLM failed, trying fallback'} ${link.provider}/${link.model}`);
    }
    last = await runLink(link, ctx);
    if (last.text) {
      return {
        text: last.text,
        provider: last.provider,
        model: last.model,
        usage: pickUsage(last.usage),
        costUsd: last.costUsd ?? null,
        fellBack: !!link.fellBack || !!last.fellBack,
        status: 'ok',
      };
    }
  }

  const lastError = scrubError(last?.lastError);
  logger.error({
    evt: 'issue',
    role: roleName,
    caller: opts.caller,
    provider: last?.provider,
    model: last?.model,
    msgId: opts.msgId,
    groupJid: opts.groupJid,
    lastError,
  }, 'All LLM attempts failed');
  if (opts.diag && lastError) opts.diag.lastError = lastError;
  const onlyNoKey = links.length === 1 && last?.status === 'no_key';
  return {
    text: null,
    provider: last?.provider || primary.provider,
    model: last?.model || primary.model,
    usage: pickUsage(last?.usage),
    costUsd: last?.costUsd ?? null,
    fellBack: !!last?.fellBack,
    status: last?.status || 'error',
    ...(onlyNoKey ? { skipped: 'no_key' } : {}),
  };
}

/**
 * Text-only wrapper around callRole (spec 007 R1). Returns the response text or null.
 * opts.role names the role; a call without one warns once per call site and runs
 * as 'mouth'. Every other option is callRole's.
 */
export async function callLlm(systemPrompt, userMessage, options = {}) {
  const res = await callRole(options.role, systemPrompt, userMessage, options);
  return res?.text ?? null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
