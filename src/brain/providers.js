// Neutral single source of truth for the LLM provider enum.
//
// This lives in its own module (not llm.js) so that config.js can import the
// provider list for validation WITHOUT creating a circular import: llm.js already
// imports config.js, so config.js importing from llm.js would be a cycle. This
// module imports nothing, so both config.js and llm.js can depend on it freely.
//
// Keep PROVIDER_NAMES in sync with the keys of the PROVIDERS map in llm.js
// (llm.js asserts this at load time).

export const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini', 'glm', 'openrouter', 'ollama', 'local'];

// Which config.llm.* field each provider authenticates with. Used for the
// "is this provider usable?" check and the dashboard key UI.
//   - anthropic + openai SHARE the single `apiKey` (no dedicated var).
//   - ollama (local) needs no key.
//   - local (llama.cpp / LM Studio / vLLM, OpenAI-compatible) needs no key; it
//     targets config.llm.baseUrl (LLM_BASE_URL) instead of a cloud endpoint.
export const PROVIDER_KEY_FIELD = {
  anthropic: 'apiKey',
  openai: 'apiKey',
  gemini: 'geminiApiKey',
  glm: 'glmApiKey',
  openrouter: 'openrouterApiKey',
  ollama: null,
  local: null,
};
