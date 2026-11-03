import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { PROVIDER_NAMES } from '../brain/providers.js';

// Per-provider catalog of selectable model names for the dashboard LLM-routing
// dropdowns. Persisted to data/llm-models.json so additions survive restart.
// Model ids are NOT validated — providers accept their own naming, and a bad id
// surfaces via the TEST button.
//
// File shape (spec 007 R14): { models: { provider: [operator additions] },
// removed: { provider: [defaults the operator removed] } }. The effective list is
// file ∪ (DEFAULTS − removed), so a default added in code reaches an existing
// install while a removal sticks. The old flat { provider: [...] } shape is read
// as `models`.
let STORE_FILE = path.join(config.projectRoot, 'data', 'llm-models.json');

const DEFAULTS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'],
  gemini: ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  glm: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
  // The fun role's default so its dropdown shows it (the mind is direct Anthropic).
  openrouter: ['x-ai/grok-4.7'],
  // Direct ids carry no vendor prefix (docs.x.ai/developers/models).
  xai: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
  ollama: [],
  local: [],
};

let stored = null;  // { models: {p: []}, removed: {p: []} }
let catalog = null; // effective { p: [] }

const cleanList = (list) => [...new Set((Array.isArray(list) ? list : []).map((m) => String(m).trim()).filter(Boolean))];

function readStored(raw) {
  const nested = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models);
  const models = nested ? raw.models : (raw && typeof raw === 'object' ? raw : {});
  const removed = nested && raw.removed && typeof raw.removed === 'object' ? raw.removed : {};
  const out = { models: {}, removed: {} };
  for (const p of PROVIDER_NAMES) {
    out.models[p] = cleanList(models[p]);
    out.removed[p] = cleanList(removed[p]);
  }
  return out;
}

function effective() {
  // Guarantee every known provider has a string[] (deduped, trimmed).
  const out = {};
  for (const p of PROVIDER_NAMES) {
    const removed = new Set(stored.removed[p]);
    out[p] = cleanList([...stored.models[p], ...(DEFAULTS[p] || []).filter((m) => !removed.has(m))]);
  }
  return out;
}

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(stored, null, 2));
  } catch (err) {
    logger.warn({ err: err.message, file: STORE_FILE }, 'Failed to persist model catalog');
  }
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    // Missing or corrupt — defaults only.
  }
  stored = readStored(raw);
  catalog = effective();
  if (!raw) persist(); // write the (empty) store on first run
}

/** The full effective { provider: [models] } catalog (loads on first call). */
export function getModelCatalog() {
  if (!catalog) load();
  return catalog;
}

/** Add a model to a provider's list and persist. Returns { ok, models?, error? }. */
export function addModel(provider, model) {
  if (!catalog) load();
  if (!PROVIDER_NAMES.includes(provider)) return { ok: false, error: 'unknown provider' };
  const name = String(model || '').trim();
  if (!name) return { ok: false, error: 'empty model name' };
  if (name.length > 200) return { ok: false, error: 'model name too long' };
  const wasRemoved = stored.removed[provider].includes(name);
  if (wasRemoved) stored.removed[provider] = stored.removed[provider].filter((m) => m !== name);
  if (!catalog[provider].includes(name) || wasRemoved) {
    if (!(DEFAULTS[provider] || []).includes(name) && !stored.models[provider].includes(name)) {
      stored.models[provider].push(name);
    }
    catalog = effective();
    persist();
  }
  return { ok: true, models: catalog[provider] };
}

/** Remove a model from a provider's list and persist. Returns { ok, models?, error? }. */
export function removeModel(provider, model) {
  if (!catalog) load();
  if (!PROVIDER_NAMES.includes(provider)) return { ok: false, error: 'unknown provider' };
  const name = String(model || '').trim();
  stored.models[provider] = stored.models[provider].filter((m) => m !== name);
  // A removed default is remembered, or the merge would bring it straight back.
  if ((DEFAULTS[provider] || []).includes(name) && !stored.removed[provider].includes(name)) {
    stored.removed[provider].push(name);
  }
  catalog = effective();
  persist();
  return { ok: true, models: catalog[provider] };
}

// ── test hooks ────────────────────────────────────────────────────────────────
export const __test = {
  /** Point the store at another file (scratch) and drop the in-memory state. */
  setFile(file) { STORE_FILE = file; stored = null; catalog = null; },
  defaults: DEFAULTS,
};
