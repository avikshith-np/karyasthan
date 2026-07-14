import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';

// Maps config dot-path → .env key. Only these keys can be persisted.
export const KEY_TO_ENV = {
  'responseRate': 'RESPONSE_RATE',
  'dryRun': 'DRY_RUN',
  'warmupEnabled': 'WARMUP_ENABLED',
  'maxPerGroupHour': 'MAX_PER_GROUP_HOUR',
  'maxGlobalHour': 'MAX_GLOBAL_HOUR',
  'llm.temperature': 'LLM_TEMPERATURE',
  'llm.maxTokens': 'LLM_MAX_TOKENS',
  'llm.provider': 'LLM_PROVIDER',
  'llm.model': 'LLM_MODEL',
  'llm.fallbackProvider': 'LLM_FALLBACK_PROVIDER',
  'llm.fallbackModel': 'LLM_FALLBACK_MODEL',
  'qualityGate.enabled': 'QUALITY_GATE_ENABLED',
  'qualityGate.threshold': 'QUALITY_GATE_THRESHOLD',
  'qualityGate.mentionThreshold': 'QUALITY_GATE_MENTION_THRESHOLD',
  'qualityGate.provider': 'QUALITY_GATE_PROVIDER',
  'qualityGate.model': 'QUALITY_GATE_MODEL',
  'imageGen.enabled': 'IMAGE_GEN_ENABLED',
  'imageGen.maxPerHour': 'IMAGE_GEN_MAX_PER_HOUR',
  'voiceNote.enabled': 'VOICE_NOTE_ENABLED',
  'voiceNote.maxPerHour': 'VOICE_NOTE_MAX_PER_HOUR',
};

// Provider API-key field (config.llm.*) → .env var name, for Tier-3 key persistence.
// Intentionally NOT in KEY_TO_ENV so secret values never appear in computeEnvDiff /
// the /api/config/diff response. Written only via writeEnvVars (isolated path).
export const LLM_KEY_ENV = {
  apiKey: 'LLM_API_KEY',
  geminiApiKey: 'GEMINI_API_KEY',
  glmApiKey: 'GLM_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
};

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function formatValue(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

function parseEnvValue(raw) {
  if (raw == null) return null;
  let v = raw.trim();
  // Strip inline comments cautiously: only treat ' #' as a comment marker
  const hashIdx = v.indexOf(' #');
  if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Compute the diff between current in-memory config and what .env holds.
 * Returns { diffs: [{key, envKey, envValue, liveValue}], envPath }.
 */
export function computeEnvDiff() {
  const envPath = path.join(config.projectRoot, '.env');
  const diffs = [];
  let envText = '';
  try { envText = fs.readFileSync(envPath, 'utf-8'); } catch {}
  const envMap = {};
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) envMap[m[1]] = parseEnvValue(m[2]);
  }

  for (const [keyPath, envKey] of Object.entries(KEY_TO_ENV)) {
    const liveValue = getByPath(config, keyPath);
    const envRaw = envMap[envKey];
    const envParsed = envRaw == null ? null : envRaw;
    const liveFormatted = formatValue(liveValue);
    if (envParsed !== liveFormatted) {
      diffs.push({
        key: keyPath,
        envKey,
        envValue: envParsed,
        liveValue: liveFormatted,
      });
    }
  }
  return { diffs, envPath };
}

/**
 * Persist diffs to .env. Backs up existing .env to .env.bak.<ts> first.
 * Writes atomically via temp file + rename. Preserves comments and blank
 * lines; only mutates matching KEY=VALUE lines. Missing keys are appended.
 */
/**
 * Low-level: write a map of { ENV_KEY: value } into .env. Backs up the existing
 * .env to .env.bak.<ts> first, rewrites matching KEY=VALUE lines (preserving
 * comments/blanks), appends missing keys, and renames atomically. Both .env and
 * the backup are chmod 0600 since the map MAY carry secrets (Tier-3 API keys).
 * Returns { applied: [envKey], backup }. NEVER log the values passed here.
 */
export function writeEnvVars(vars) {
  const envPath = path.join(config.projectRoot, '.env');
  const patchByEnvKey = new Map(Object.entries(vars || {}));
  if (!patchByEnvKey.size) return { applied: [], backup: null };

  let original = '';
  try { original = fs.readFileSync(envPath, 'utf-8'); } catch {}

  const ts = Math.floor(Date.now() / 1000);
  const backupPath = `${envPath}.bak.${ts}`;
  if (original) {
    fs.writeFileSync(backupPath, original);
    try { fs.chmodSync(backupPath, 0o600); } catch {}
  }

  const appliedEnvKeys = new Set();
  const outLines = original.split('\n').map(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m) return line;
    const key = m[1];
    if (!patchByEnvKey.has(key)) return line;
    appliedEnvKeys.add(key);
    return `${key}=${patchByEnvKey.get(key)}`;
  });

  for (const [envKey, value] of patchByEnvKey.entries()) {
    if (!appliedEnvKeys.has(envKey)) {
      if (outLines[outLines.length - 1] !== '') outLines.push('');
      outLines.push(`${envKey}=${value}`);
    }
  }

  const tmpPath = `${envPath}.tmp.${process.pid}.${ts}`;
  fs.writeFileSync(tmpPath, outLines.join('\n'));
  try { fs.chmodSync(tmpPath, 0o600); } catch {}
  fs.renameSync(tmpPath, envPath);

  return { applied: [...patchByEnvKey.keys()], backup: backupPath };
}

/**
 * Persist diffs to .env (non-secret allow-listed keys via KEY_TO_ENV). Backs up
 * the existing .env first; preserves comments/blank lines; appends missing keys.
 */
export function persistEnvDiff(keysToPersist) {
  const { diffs } = computeEnvDiff();
  const filtered = keysToPersist && keysToPersist.length
    ? diffs.filter(d => keysToPersist.includes(d.key))
    : diffs;

  if (!filtered.length) return { applied: [], backup: null, skipped: diffs.map(d => d.key) };

  const vars = {};
  for (const d of filtered) vars[d.envKey] = d.liveValue;
  const { backup } = writeEnvVars(vars);

  return {
    applied: filtered.map(d => ({ key: d.key, envKey: d.envKey, value: d.liveValue })),
    backup,
    skipped: diffs.filter(d => !filtered.includes(d)).map(d => d.key),
  };
}
