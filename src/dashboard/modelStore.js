import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { PROVIDER_NAMES } from '../brain/providers.js';

// Per-provider catalog of selectable model names for the dashboard LLM-routing
// dropdowns. Persisted to data/llm-models.json so additions survive restart.
// Seeded from the project's documented models (.env.example table); the operator
// can add more from the UI. Model ids are NOT validated — providers accept their
// own naming, and a bad id surfaces via the TEST button.
const STORE_FILE = path.join(config.projectRoot, 'data', 'llm-models.json');

const DEFAULTS = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'],
  gemini: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  glm: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
  openrouter: [],
  ollama: [],
  local: [],
};

let catalog = null;

function normalize(raw) {
  // Guarantee every known provider has a string[] (deduped, trimmed).
  const out = {};
  for (const p of PROVIDER_NAMES) {
    const fromFile = Array.isArray(raw?.[p]) ? raw[p] : null;
    const list = fromFile || DEFAULTS[p] || [];
    out[p] = [...new Set(list.map((m) => String(m).trim()).filter(Boolean))];
  }
  return out;
}

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(catalog, null, 2));
  } catch (err) {
    logger.warn({ err: err.message, file: STORE_FILE }, 'Failed to persist model catalog');
  }
}

function load() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    // Missing or corrupt — seed from defaults below.
  }
  catalog = normalize(raw);
  if (!raw) persist(); // write the seed on first run
}

/** The full { provider: [models] } catalog (loads + seeds on first call). */
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
  if (!catalog[provider].includes(name)) {
    catalog[provider].push(name);
    persist();
  }
  return { ok: true, models: catalog[provider] };
}

/** Remove a model from a provider's list and persist. Returns { ok, models?, error? }. */
export function removeModel(provider, model) {
  if (!catalog) load();
  if (!PROVIDER_NAMES.includes(provider)) return { ok: false, error: 'unknown provider' };
  const name = String(model || '').trim();
  catalog[provider] = catalog[provider].filter((m) => m !== name);
  persist();
  return { ok: true, models: catalog[provider] };
}
