import { config as loadEnv } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_NAMES, PROVIDER_KEY_FIELD } from '../brain/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

loadEnv({ path: path.join(PROJECT_ROOT, '.env') });

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback) {
  return process.env[key] || fallback;
}

// ---------------------------------------------------------------------------
// Persona
//
// The bot's identity is split in two:
//   - persona.json       structured fields the *code* needs (name, aliases the
//                        bot answers to, WhatsApp display name, voice descriptor)
//   - identity.md        the free-form prose injected into the LLM system prompt
//
// Both live under src/personality/ and are gitignored — each install owns its
// own. `npm run setup` generates them. If persona.json is missing we fall back
// to the committed persona.example.json so a fresh checkout still boots.
// ---------------------------------------------------------------------------
const PERSONALITY_DIR = path.join(PROJECT_ROOT, 'src', 'personality');

function normalizePersona(p) {
  const name = String(p.name || 'Karyasthan').trim();
  const displayName = String(p.displayName || name).trim();
  const nameLower = name.toLowerCase();
  let aliases = Array.isArray(p.aliases)
    ? p.aliases.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  // The bot must always answer to its own name.
  if (!aliases.includes(nameLower)) aliases = [nameLower, ...aliases];
  aliases = [...new Set(aliases)];
  return {
    name,
    displayName,
    aliases,
    age: p.age ?? null,
    region: String(p.region || '').trim(),
    language: String(p.language || 'English').trim(),
    voiceDescriptor: String(p.voiceDescriptor || 'a young adult speaking casually to friends').trim(),
    vibe: String(p.vibe || '').trim(),
  };
}

function loadPersona() {
  const primary = path.join(PERSONALITY_DIR, 'persona.json');
  const example = path.join(PERSONALITY_DIR, 'persona.example.json');
  let file = primary;
  if (!fs.existsSync(primary)) {
    file = example;
    console.warn(
      '[config] persona.json not found — falling back to persona.example.json. ' +
      'Run `npm run setup` to create your own persona.',
    );
  }
  try {
    return normalizePersona(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    console.warn(`[config] could not load persona from ${file}: ${err.message}. Using built-in defaults.`);
    return normalizePersona({});
  }
}

export const persona = loadPersona();

/** The active persona (structured fields). See normalizePersona for the shape. */
export function getPersona() {
  return persona;
}

export const config = {
  projectRoot: PROJECT_ROOT,

  // LLM
  llm: {
    provider: optional('LLM_PROVIDER', 'anthropic'),
    model: optional('LLM_MODEL', 'gemini-3-flash-preview'),
    apiKey: process.env.LLM_API_KEY || '',
    // Endpoint for the 'local' provider — a local OpenAI-compatible server
    // (llama.cpp / LM Studio / vLLM). Applies ONLY when provider is 'local'; cloud
    // providers always use their own endpoint. .env-only routing surface —
    // deliberately not in MUTABLE_KEYS/getSafeConfig.
    baseUrl: optional('LLM_BASE_URL', ''),
    monthlyBudgetUsd: parseFloat(optional('LLM_MONTHLY_BUDGET_USD', '30')),
    fallbackProvider: optional('LLM_FALLBACK_PROVIDER', 'ollama'),
    fallbackModel: optional('LLM_FALLBACK_MODEL', 'gemini-3-flash-preview'),
    glmApiKey: process.env.GLM_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    maxTokens: parseInt(optional('LLM_MAX_TOKENS', '3072'), 10),
    temperature: parseFloat(optional('LLM_TEMPERATURE', '0.7')),
  },

  // Transcription
  transcriptionModel: optional('TRANSCRIPTION_MODEL', ''),

  // Behavior
  responseRate: parseFloat(optional('RESPONSE_RATE', '0.15')),
  maxResponseLength: parseInt(optional('MAX_RESPONSE_LENGTH', '500'), 10),
  sleepStartHour: parseInt(optional('SLEEP_START_HOUR', '0'), 10),
  sleepEndHour: parseInt(optional('SLEEP_END_HOUR', '7'), 10),
  timezone: optional('TIMEZONE', 'Asia/Kolkata'),

  // Rate limits
  maxPerGroupHour: parseInt(optional('MAX_PER_GROUP_HOUR', '8'), 10),
  maxGlobalHour: parseInt(optional('MAX_GLOBAL_HOUR', '20'), 10),

  // Paths
  dbPath: path.resolve(PROJECT_ROOT, optional('DB_PATH', './data/karyasthan.db')),
  authPath: path.resolve(PROJECT_ROOT, optional('AUTH_PATH', './data/auth_info_baileys')),
  logLevel: optional('LOG_LEVEL', 'info'),

  // Warm-up
  warmupEnabled: optional('WARMUP_ENABLED', 'true') === 'true',

  // Dry run
  dryRun: optional('DRY_RUN', 'false') === 'true',

  // WhatsApp phone number (digits only, with country code, e.g. 919876543210)
  phoneNumber: process.env.WA_PHONE_NUMBER || '',

  // Bill Split
  billSplitModel: optional('BILL_SPLIT_MODEL', 'gemini-2.5-pro'),

  // Image Generation (uses GEMINI_API_KEY)
  imageGen: {
    enabled: optional('IMAGE_GEN_ENABLED', 'true') === 'true',
    model: optional('IMAGE_GEN_MODEL', 'imagen-4.0-generate-001'),
    editModel: optional('IMAGE_EDIT_MODEL', 'gemini-3-pro-image-preview'),
    maxPerHour: parseInt(optional('IMAGE_GEN_MAX_PER_HOUR', '5'), 10),
  },

  // Voice Notes (uses GEMINI_API_KEY for Gemini TTS)
  voiceNote: {
    enabled: optional('VOICE_NOTE_ENABLED', 'true') === 'true',
    model: optional('VOICE_NOTE_MODEL', 'gemini-3.1-flash-tts-preview'),
    voiceName: optional('VOICE_NOTE_VOICE', 'Puck'),
    maxPerHour: parseInt(optional('VOICE_NOTE_MAX_PER_HOUR', '10'), 10),
  },

  // Stickers + GIFs (GIPHY)
  media: {
    giphyApiKey: process.env.GIPHY_API_KEY || '',
    stickerMaxPerHour: parseInt(optional('STICKER_MAX_PER_HOUR', '8'), 10),
    gifMaxPerHour: parseInt(optional('GIF_MAX_PER_HOUR', '8'), 10),
  },

  // Web Search + Browsing.
  //   search  → self-hosted SearXNG JSON API (no API key)
  //   browse  → Playwright headless Chromium (renders JS)
  // The master on/off is the "web-search" skill (Skills tab); WEB_SEARCH_ENABLED is
  // only its BOOT DEFAULT (see src/skills/web-search.skill.js enabledByDefault).
  webSearch: {
    enabled: optional('WEB_SEARCH_ENABLED', 'true') === 'true',
    searxngUrl: optional('SEARXNG_URL', 'http://127.0.0.1:8888').replace(/\/+$/, ''),
    maxResults: parseInt(optional('WEB_SEARCH_MAX_RESULTS', '4'), 10),
    // One tool round (initial + 1 lookup). 2 enables search→browse-a-result but also
    // needs IN_FLIGHT_SAFETY_MS raised (events.js) — see plan/CLAUDE.md.
    maxHops: parseInt(optional('WEB_SEARCH_MAX_HOPS', '1'), 10),
    timeoutMs: parseInt(optional('WEB_SEARCH_TIMEOUT_MS', '5000'), 10),
    // Wall-clock budget for all web ops in one turn; once spent, force a no-tool answer.
    budgetMs: parseInt(optional('WEB_SEARCH_BUDGET_MS', '20000'), 10),
    searchMaxPerHour: parseInt(optional('WEB_SEARCH_MAX_PER_HOUR', '30'), 10),
    browse: {
      enabled: optional('WEB_BROWSE_ENABLED', 'true') === 'true',
      maxPerHour: parseInt(optional('WEB_BROWSE_MAX_PER_HOUR', '15'), 10),
      timeoutMs: parseInt(optional('WEB_BROWSE_TIMEOUT_MS', '8000'), 10),
      maxContentChars: parseInt(optional('WEB_BROWSE_MAX_CHARS', '4000'), 10),
      maxConcurrent: parseInt(optional('WEB_BROWSE_CONCURRENCY', '2'), 10),
      idleMs: parseInt(optional('WEB_BROWSE_IDLE_MS', '300000'), 10),
      // SSRF escape hatch — keep false in production. .env only (never dashboard-mutable).
      allowPrivate: optional('WEB_BROWSE_ALLOW_PRIVATE', 'false') === 'true',
    },
  },

  // Quality Gate
  qualityGate: {
    enabled: optional('QUALITY_GATE_ENABLED', 'true') === 'true',
    provider: optional('QUALITY_GATE_PROVIDER', 'gemini'),
    model: optional('QUALITY_GATE_MODEL', 'gemini-3-flash-preview'),
    threshold: parseFloat(optional('QUALITY_GATE_THRESHOLD', '0.4')),
    mentionThreshold: parseFloat(optional('QUALITY_GATE_MENTION_THRESHOLD', '0.25')),
    maxTokens: parseInt(optional('QUALITY_GATE_MAX_TOKENS', '256'), 10),
    temperature: parseFloat(optional('QUALITY_GATE_TEMPERATURE', '0.1')),
    timeoutMs: parseInt(optional('QUALITY_GATE_TIMEOUT_MS', '8000'), 10),
  },

  // Dashboard (read-only web UI)
  dashboard: {
    enabled: optional('DASHBOARD_ENABLED', 'false') === 'true',
    host: optional('DASHBOARD_HOST', '127.0.0.1'),
    port: parseInt(optional('DASHBOARD_PORT', '7070'), 10),
    user: optional('DASHBOARD_USER', ''),
    passHash: optional('DASHBOARD_PASS_HASH', ''),
    cookieSecret: optional('DASHBOARD_COOKIE_SECRET', ''),
    allowCidrs: optional('DASHBOARD_ALLOW_CIDRS', '127.0.0.1/32,::1/128')
      .split(',').map(s => s.trim()).filter(Boolean),
    readOnly: optional('DASHBOARD_READONLY', 'true') === 'true',
  },
};

// Fail-loud if 'local' is the primary/fallback provider but no base URL is set —
// local calls would otherwise fetch('') and fall through to the fallback every message.
if ((config.llm.provider === 'local' || config.llm.fallbackProvider === 'local') && !config.llm.baseUrl) {
  console.error('[config] LLM provider "local" selected but LLM_BASE_URL is empty — local calls will fail. Set LLM_BASE_URL.');
}

// Keys the dashboard is allowed to mutate in-memory, with their expected type.
// Typing here (not inferred from the live value) because Number.isInteger(0)
// is true, which would mis-type a float field that happens to currently hold 0.
const MUTABLE_KEYS = {
  'responseRate': 'float',
  'dryRun': 'bool',
  'warmupEnabled': 'bool',
  'maxPerGroupHour': 'int',
  'maxGlobalHour': 'int',
  'llm.temperature': 'float',
  'llm.maxTokens': 'int',
  // LLM routing — provider/model are dashboard-switchable live (enum validated against
  // src/brain/providers.js). llm.baseUrl is deliberately NOT here — .env-only SSRF surface.
  'llm.provider': 'enum:provider',
  'llm.model': 'string',
  'llm.fallbackProvider': 'enum:provider',
  'llm.fallbackModel': 'string',
  'qualityGate.enabled': 'bool',
  'qualityGate.threshold': 'float',
  'qualityGate.mentionThreshold': 'float',
  'qualityGate.provider': 'enum:provider',
  'qualityGate.model': 'string',
  'imageGen.enabled': 'bool',
  'imageGen.maxPerHour': 'int',
  'voiceNote.enabled': 'bool',
  'voiceNote.maxPerHour': 'int',
  'media.stickerMaxPerHour': 'int',
  'media.gifMaxPerHour': 'int',
  // Web search — master on/off lives in the Skills tab (not here). searxngUrl and
  // browse.allowPrivate are deliberately .env-only (SSRF surface).
  'webSearch.maxResults': 'int',
  'webSearch.maxHops': 'int',
  'webSearch.searchMaxPerHour': 'int',
  'webSearch.browse.enabled': 'bool',
  'webSearch.browse.maxPerHour': 'int',
  'webSearch.browse.maxConcurrent': 'int',
};

function coerce(type, incoming) {
  if (type === 'bool') {
    if (typeof incoming === 'boolean') return incoming;
    if (incoming === 'true') return true;
    if (incoming === 'false') return false;
    return null;
  }
  if (type === 'int' || type === 'float') {
    const n = Number(incoming);
    if (!Number.isFinite(n)) return null;
    return type === 'int' ? Math.round(n) : n;
  }
  if (type === 'string') {
    return typeof incoming === 'string' && incoming.trim() ? incoming.trim() : null;
  }
  if (type === 'enum:provider') {
    if (typeof incoming !== 'string') return null;
    const v = incoming.trim();
    return PROVIDER_NAMES.includes(v) ? v : null;
  }
  return null;
}

/**
 * Apply an allow-listed patch to the running config singleton. Returns
 * { applied, rejected }. Nothing touches .env — changes revert on restart.
 */
export function updateConfig(patch) {
  const applied = {};
  const rejected = {};
  for (const [key, incoming] of Object.entries(patch || {})) {
    const type = MUTABLE_KEYS[key];
    if (!type) {
      rejected[key] = 'not allow-listed';
      continue;
    }
    const parts = key.split('.');
    let cursor = config;
    let missingParent = false;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor[parts[i]];
      if (!cursor || typeof cursor !== 'object') { missingParent = true; break; }
    }
    if (missingParent) {
      rejected[key] = 'missing parent';
      continue;
    }
    const leaf = parts[parts.length - 1];
    const coerced = coerce(type, incoming);
    if (coerced === null) {
      rejected[key] = `bad type (expected ${type})`;
      continue;
    }
    // Provider-switch usability guard, scoped to enum:provider keys ONLY (every other
    // key's flow is unchanged): refuse a switch to a cloud provider whose API key isn't
    // configured — it would silently break responses (callLlm returns null on an
    // unkeyed provider) or force the fallback. ollama has no key field, so never rejected.
    if (type === 'enum:provider') {
      if (coerced === 'local' && !config.llm.baseUrl) {
        rejected[key] = 'local base URL not set (LLM_BASE_URL)';
        continue;
      }
      const keyField = PROVIDER_KEY_FIELD[coerced];
      if (keyField && !config.llm[keyField] && !config.llm.apiKey) {
        rejected[key] = 'provider key not configured';
        continue;
      }
    }
    cursor[leaf] = coerced;
    applied[key] = coerced;
  }
  return { applied, rejected };
}

// LLM provider API-key fields settable from the dashboard (Tier 3). Kept separate
// from MUTABLE_KEYS so secrets never flow through the generic patch/diff path.
const LLM_KEY_FIELDS = new Set(['apiKey', 'geminiApiKey', 'glmApiKey', 'openrouterApiKey']);

/**
 * In-memory setter for provider API keys. Returns applied FIELD NAMES only —
 * never key values. Callers (and audit) must not log the values. Changes revert
 * on restart unless persisted to .env via the route's writeEnvVars path.
 */
export function updateLlmKeys(patch) {
  const applied = [];
  const rejected = {};
  for (const [field, value] of Object.entries(patch || {})) {
    if (!LLM_KEY_FIELDS.has(field)) { rejected[field] = 'unknown key field'; continue; }
    if (typeof value !== 'string' || !value.trim()) { rejected[field] = 'must be a non-empty string'; continue; }
    config.llm[field] = value.trim();
    applied.push(field);
  }
  return { applied, rejected };
}

/**
 * Safe read-only snapshot with secrets redacted. For the dashboard settings
 * page — never expose API keys or the pass hash.
 */
export function getSafeConfig() {
  return {
    responseRate: config.responseRate,
    dryRun: config.dryRun,
    warmupEnabled: config.warmupEnabled,
    maxPerGroupHour: config.maxPerGroupHour,
    maxGlobalHour: config.maxGlobalHour,
    sleepStartHour: config.sleepStartHour,
    sleepEndHour: config.sleepEndHour,
    timezone: config.timezone,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
      fallbackProvider: config.llm.fallbackProvider,
      fallbackModel: config.llm.fallbackModel,
      // Presence booleans only — never the key values (mirrors media.giphyConfigured).
      apiKeyConfigured: !!config.llm.apiKey,
      geminiKeyConfigured: !!(config.llm.geminiApiKey || config.llm.apiKey),
      glmKeyConfigured: !!(config.llm.glmApiKey || config.llm.apiKey),
      openrouterKeyConfigured: !!(config.llm.openrouterApiKey || config.llm.apiKey),
      baseUrlConfigured: !!config.llm.baseUrl,
    },
    qualityGate: {
      enabled: config.qualityGate.enabled,
      provider: config.qualityGate.provider,
      model: config.qualityGate.model,
      threshold: config.qualityGate.threshold,
      mentionThreshold: config.qualityGate.mentionThreshold,
    },
    imageGen: {
      enabled: config.imageGen.enabled,
      model: config.imageGen.model,
      maxPerHour: config.imageGen.maxPerHour,
    },
    voiceNote: {
      enabled: config.voiceNote.enabled,
      model: config.voiceNote.model,
      maxPerHour: config.voiceNote.maxPerHour,
    },
    media: {
      stickerMaxPerHour: config.media.stickerMaxPerHour,
      gifMaxPerHour: config.media.gifMaxPerHour,
      giphyConfigured: !!config.media.giphyApiKey,
    },
    webSearch: {
      enabled: config.webSearch.enabled,
      searxngConfigured: !!config.webSearch.searxngUrl,
      maxResults: config.webSearch.maxResults,
      maxHops: config.webSearch.maxHops,
      searchMaxPerHour: config.webSearch.searchMaxPerHour,
      browse: {
        enabled: config.webSearch.browse.enabled,
        maxPerHour: config.webSearch.browse.maxPerHour,
        maxConcurrent: config.webSearch.browse.maxConcurrent,
        allowPrivate: config.webSearch.browse.allowPrivate,
      },
    },
    dashboard: {
      readOnly: config.dashboard.readOnly,
      host: config.dashboard.host,
      port: config.dashboard.port,
    },
  };
}

export const CONFIG_MUTABLE_KEYS = Object.keys(MUTABLE_KEYS);
export const CONFIG_KEY_TYPES = { ...MUTABLE_KEYS };
