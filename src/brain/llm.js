import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { PROVIDER_NAMES } from './providers.js';

const PROVIDERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.llm.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      };
    },
    extractText(data) {
      return data.content?.[0]?.text || null;
    },
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.choices?.[0]?.message?.content || null;
    },
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.geminiApiKey || config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          // Best-effort: minimize thinking so it doesn't bleed into the content field
          // for Gemini "thinking" models (e.g. gemini-3-flash-preview) on the OpenAI-compat
          // endpoint. (Gemini rejects reasoning_effort + thinking_config together, so use
          // only this knob.) postProcess remains the hard guarantee.
          reasoning_effort: 'low',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.choices?.[0]?.message?.content || null;
    },
  },
  glm: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.glmApiKey || config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.choices?.[0]?.message?.content || null;
    },
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.openrouterApiKey || config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.choices?.[0]?.message?.content || null;
    },
  },
  ollama: {
    url: 'http://127.0.0.1:11434/api/chat',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: {
            temperature: overrides.temperature ?? config.llm.temperature,
            num_predict: overrides.maxTokens || config.llm.maxTokens,
          },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.message?.content || null;
    },
  },
  // Local OpenAI-compatible server (llama.cpp / LM Studio / vLLM). Same request
  // shape as `openai`; its endpoint is config.llm.baseUrl (LLM_BASE_URL), resolved
  // in callLlm below — so selecting "local" routes the bot to your own server.
  local: {
    url: '',
    buildRequest(systemPrompt, userMessage, model, overrides = {}) {
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.apiKey || 'local'}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: overrides.maxTokens || config.llm.maxTokens,
          temperature: overrides.temperature ?? config.llm.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      };
    },
    extractText(data) {
      return data.choices?.[0]?.message?.content || null;
    },
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

/**
 * Call the LLM with a system prompt and user message.
 * Returns the response text or null on failure.
 *
 * Options:
 *   provider, model, baseUrl — routing
 *   maxTokens, temperature   — per-call overrides
 *   timeoutMs                — abort if the call takes too long
 *   noFallback               — skip fallback provider on failure (for quality gate)
 */
export async function callLlm(systemPrompt, userMessage, options = {}) {
  const providerName = options.provider || config.llm.provider;
  const model = options.model || config.llm.model;

  const provider = PROVIDERS[providerName];
  if (!provider) {
    logger.error({ providerName }, 'Unknown LLM provider');
    return null;
  }

  // LLM_BASE_URL is the address of the 'local' provider (a local OpenAI-compatible
  // server: llama.cpp / LM Studio / vLLM) and applies ONLY to provider 'local' — never
  // to a cloud provider, even when that cloud provider is the configured default. (It
  // used to key on "default provider", which misrouted e.g. gemini to the local URL
  // once gemini was set as primary.) To use a local server, set the provider to 'local'.
  const url = options.baseUrl || (providerName === 'local' ? config.llm.baseUrl : '') || provider.url;
  // Floor the completion budget. Thinking models (e.g. gemini-3-flash-preview) burn
  // ~50 hidden reasoning tokens against max_tokens BEFORE emitting any content, so a
  // tiny cap yields HTTP 200 with EMPTY content (finish_reason=length). 256 leaves
  // ample headroom and Math.max never shrinks a larger configured budget — this is
  // the single chokepoint that protects every callsite (test probe, GIF picker,
  // quality gate) from the small-cap-empties-reasoning-models failure.
  const MIN_COMPLETION_BUDGET = 256;
  const overrides = {
    maxTokens: Math.max(options.maxTokens || config.llm.maxTokens, MIN_COMPLETION_BUDGET),
    temperature: options.temperature,
  };
  const reqOptions = provider.buildRequest(systemPrompt, userMessage, model, overrides);

  // Add timeout signal if requested
  if (options.timeoutMs) {
    reqOptions.signal = AbortSignal.timeout(options.timeoutMs);
  }

  const maxAttempts = options.noFallback ? 2 : 3;

  // Remember the last failure so the terminal "all attempts failed" line can say
  // *why* (status/body/finish_reason/exception) without relying on the optional diag.
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const startTime = Date.now();
      const res = await fetch(url, reqOptions);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.warn({ status: res.status, attempt, errBody: errBody.slice(0, 200) }, 'LLM API error');
        lastError = { status: res.status, body: errBody.slice(0, 300) };
        if (options.diag) options.diag.lastError = lastError;

        if (attempt < maxAttempts) {
          await sleep(1000 * Math.pow(3, attempt - 1)); // 1s, 3s
          continue;
        }
        break;
      }

      const data = await res.json();
      const text = provider.extractText(data);
      const latencyMs = Date.now() - startTime;

      if (!text) {
        // HTTP 200 but no content. Two deterministic causes: (a) a provider content
        // filter (e.g. Gemini PROHIBITED_CONTENT — finish_reason safety/stop, 0 output),
        // or (b) the budget was exhausted by hidden reasoning tokens (finish_reason
        // "length"). Retrying is pointless either way → go straight to the fallback. We
        // surface finish_reason so the dashboard TEST distinguishes "raise max_tokens"
        // from a real content filter.
        const finishReason = data.choices?.[0]?.finish_reason || data.candidates?.[0]?.finishReason || 'unknown';
        logger.warn(
          { provider: providerName, model, latencyMs, finishReason, body: JSON.stringify(data).slice(0, 200) },
          'LLM returned empty content — trying fallback provider',
        );
        lastError = { status: 200, body: `empty content (finish_reason=${finishReason}${finishReason === 'length' ? ' — raise max_tokens' : ''})` };
        if (options.diag) options.diag.lastError = lastError;
        break;
      }

      logger.info({ provider: providerName, model, latencyMs, tokens: text?.length }, 'LLM response');
      return text;
    } catch (err) {
      logger.warn({ err: err.message, attempt }, 'LLM call failed');
      lastError = { message: err.message };
      if (options.diag) options.diag.lastError = lastError;
      if (attempt < maxAttempts) {
        await sleep(1000 * Math.pow(3, attempt - 1));
      }
    }
  }

  // Try fallback provider (unless noFallback is set).
  // Recursion guard: skip fallback only if it's the *same* provider AND model we just tried.
  const sameAsFallback =
    providerName === config.llm.fallbackProvider && model === config.llm.fallbackModel;
  if (!options.noFallback && config.llm.fallbackProvider && !sameAsFallback) {
    logger.info({
      from: { provider: providerName, model },
      to: { provider: config.llm.fallbackProvider, model: config.llm.fallbackModel },
      reason: lastError,
    }, `Primary LLM failed, trying fallback ${config.llm.fallbackProvider}/${config.llm.fallbackModel}`);
    return callLlm(systemPrompt, userMessage, {
      provider: config.llm.fallbackProvider,
      model: config.llm.fallbackModel,
      msgId: options.msgId,
      groupJid: options.groupJid,
      // Inherit the caller's per-call limits so a bounded caller (e.g. the quality
      // gate's timeoutMs) stays bounded through the fallback too. Undefined for the
      // main generation path → unchanged there.
      timeoutMs: options.timeoutMs,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
  }

  logger.error({
    evt: 'issue',
    provider: providerName,
    model,
    msgId: options.msgId,
    groupJid: options.groupJid,
    lastError,
  }, 'All LLM attempts failed');
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
