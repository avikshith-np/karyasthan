// Neutral single source of truth for the LLM provider enum.
//
// This lives in its own module (not llm.js) so that config.js can import the
// provider list for validation WITHOUT creating a circular import: llm.js already
// imports config.js, so config.js importing from llm.js would be a cycle. This
// module imports nothing, so both config.js and llm.js can depend on it freely.
//
// Keep PROVIDER_NAMES in sync with the keys of the PROVIDERS map in llm.js
// (llm.js asserts this at load time).

export const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini', 'glm', 'openrouter', 'xai', 'ollama', 'local'];

// Which config.llm.* field each provider authenticates with. Used for the
// "is this provider usable?" check, the dashboard key UI and getProviderKey()
// (src/utils/config.js). Every cloud provider has its OWN key — no provider ever
// falls back to another provider's key (spec 007 R7).
//   - anthropic → ANTHROPIC_API_KEY; openai → LLM_API_KEY (the OpenAI key only).
//   - ollama (local) needs no key.
//   - local (llama.cpp / LM Studio / vLLM, OpenAI-compatible) needs no key; it
//     targets config.llm.baseUrl (LLM_BASE_URL) and has its own optional
//     LLM_LOCAL_API_KEY, read by its adapter.
export const PROVIDER_KEY_FIELD = {
  anthropic: 'anthropicApiKey',
  openai: 'apiKey',
  gemini: 'geminiApiKey',
  glm: 'glmApiKey',
  openrouter: 'openrouterApiKey',
  xai: 'xaiApiKey',
  ollama: null,
  local: null,
};

// config.llm key field → .env var (the isolated 0600 key-persistence path).
export const PROVIDER_KEY_ENV = {
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  apiKey: 'LLM_API_KEY',
  geminiApiKey: 'GEMINI_API_KEY',
  glmApiKey: 'GLM_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  xaiApiKey: 'XAI_API_KEY',
};

// Reasoning effort a role may request. '' = send none (provider default).
// anthropic → output_config.effort; gemini, xai → reasoning_effort; openrouter →
// reasoning.effort; the others ignore it.
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
