import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

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
};

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

  const url = options.baseUrl || provider.url;
  const overrides = { maxTokens: options.maxTokens, temperature: options.temperature };
  const reqOptions = provider.buildRequest(systemPrompt, userMessage, model, overrides);

  // Add timeout signal if requested
  if (options.timeoutMs) {
    reqOptions.signal = AbortSignal.timeout(options.timeoutMs);
  }

  const maxAttempts = options.noFallback ? 2 : 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const startTime = Date.now();
      const res = await fetch(url, reqOptions);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.warn({ status: res.status, attempt, errBody: errBody.slice(0, 200) }, 'LLM API error');

        if (attempt < maxAttempts) {
          await sleep(1000 * Math.pow(3, attempt - 1)); // 1s, 3s
          continue;
        }
        break;
      }

      const data = await res.json();
      const text = provider.extractText(data);
      const latencyMs = Date.now() - startTime;

      logger.info({ provider: providerName, model, latencyMs, tokens: text?.length }, 'LLM response');
      return text;
    } catch (err) {
      logger.warn({ err: err.message, attempt }, 'LLM call failed');
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
    logger.info('Trying fallback LLM provider');
    return callLlm(systemPrompt, userMessage, {
      provider: config.llm.fallbackProvider,
      model: config.llm.fallbackModel,
    });
  }

  logger.error('All LLM attempts failed');
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
