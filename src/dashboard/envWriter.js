import fs from 'fs';
import path from 'path';
import { config, ENV_UNSAFE, mindKeyToEnv, mindDefaultForKey, arcsKeyToEnv, arcsDefaultForKey,
  chatInfluenceKeyToEnv, chatInfluenceDefaultForKey } from '../utils/config.js';
import { keyToEnv, defaultForKey } from '../brain/roles.js';
import { PROVIDER_KEY_ENV } from '../brain/providers.js';

// Plain (non-role, non-mind/arcs) persistable keys: dot path → [.env name, the
// default config.js uses when the variable is unset]. The default keeps an unset
// variable whose live value still equals it out of /api/config/diff (persisting it
// would be a no-op). Every dashboard-mutable key must be here, in a registry table
// below, or in NOT_PERSISTABLE (test:dashboard checks it). The .env-only SSRF/secret
// surfaces (searxngUrl, browse.allowPrivate, llm.baseUrl, API keys) are never mutable
// and never listed.
const PLAIN_KEYS = {
  'responseRate': ['RESPONSE_RATE', 0.15],
  'dryRun': ['DRY_RUN', false],
  'warmupEnabled': ['WARMUP_ENABLED', true],
  'maxPerGroupHour': ['MAX_PER_GROUP_HOUR', 8],
  'maxGlobalHour': ['MAX_GLOBAL_HOUR', 20],
  'capCatchUp.enabled': ['CAP_CATCHUP_ENABLED', true],
  'capCatchUp.maxAgeMinutes': ['CAP_CATCHUP_MAX_AGE_MINUTES', 120],
  'llm.temperature': ['LLM_TEMPERATURE', 0.7],
  'llm.monthlyBudgetUsd': ['LLM_MONTHLY_BUDGET_USD', 30],
  'qualityGate.enabled': ['QUALITY_GATE_ENABLED', true],
  'qualityGate.threshold': ['QUALITY_GATE_THRESHOLD', 0.4],
  'qualityGate.mentionThreshold': ['QUALITY_GATE_MENTION_THRESHOLD', 0.25],
  'imageGen.enabled': ['IMAGE_GEN_ENABLED', true],
  'imageGen.maxPerHour': ['IMAGE_GEN_MAX_PER_HOUR', 5],
  'voiceNote.enabled': ['VOICE_NOTE_ENABLED', true],
  'voiceNote.maxPerHour': ['VOICE_NOTE_MAX_PER_HOUR', 10],
  'media.stickerMaxPerHour': ['STICKER_MAX_PER_HOUR', 8],
  'media.gifMaxPerHour': ['GIF_MAX_PER_HOUR', 8],
  'webSearch.maxResults': ['WEB_SEARCH_MAX_RESULTS', 4],
  'webSearch.maxHops': ['WEB_SEARCH_MAX_HOPS', 1],
  'webSearch.searchMaxPerHour': ['WEB_SEARCH_MAX_PER_HOUR', 30],
  'webSearch.browse.enabled': ['WEB_BROWSE_ENABLED', true],
  'webSearch.browse.maxPerHour': ['WEB_BROWSE_MAX_PER_HOUR', 15],
  'webSearch.browse.maxConcurrent': ['WEB_BROWSE_CONCURRENCY', 2],
  'instagram.sessionsPerDay': ['IG_SESSIONS_PER_DAY', 4],
  'instagram.sessionMinMinutes': ['IG_SESSION_MIN_MINUTES', 5],
  'instagram.sessionMaxMinutes': ['IG_SESSION_MAX_MINUTES', 12],
  'instagram.likesPerDay': ['IG_LIKES_PER_DAY', 25],
  'instagram.sharesPerDay': ['IG_SHARES_PER_DAY', 3],
  'instagram.approvalMode': ['IG_APPROVAL_MODE', 'approve-each'],
  'instagram.warmupDays': ['IG_WARMUP_DAYS', 10],
  'instagram.clipSeconds': ['IG_CLIP_SECONDS', 15],
  'instagram.framesToJev': ['IG_FRAMES_TO_JEV', false],
  'instagram.watchMode': ['IG_WATCH_MODE', 'live'],
  'instagram.chatPollMinutes': ['IG_CHAT_POLL_MINUTES', 20],
  'instagram.chatMaxRepliesPerHour': ['IG_CHAT_MAX_REPLIES_PER_HOUR', 6],
  'instagram.firstLookSeconds': ['IG_FIRST_LOOK_SECONDS', 3],
  'instagram.fullLookSeconds': ['IG_FULL_LOOK_SECONDS', 12],
  'instagram.hazardThreshold': ['IG_HAZARD_THRESHOLD', 0.25],
  'instagram.minConfidence': ['IG_MIN_CONFIDENCE', 0.4],
  'instagram.likeHumour': ['IG_LIKE_HUMOUR', 1.8],
  'instagram.likeFit': ['IG_LIKE_FIT', 1.5],
  'instagram.queueHumour': ['IG_QUEUE_HUMOUR', 2.2],
  'instagram.queueFit': ['IG_QUEUE_FIT', 1.8],
  'life.jevMaxPerDay': ['LIFE_JEV_MAX_PER_DAY', 40],
  'life.commitP': ['LIFE_COMMIT_P', 0.8],
  'life.phraseBanks': ['LIFE_PHRASE_BANKS', false],
  'life.selfMentionBudget': ['LIFE_SELF_MENTION_BUDGET', 3],
  'life.queueMaxAgeHours': ['LIFE_QUEUE_MAX_AGE_HOURS', 18],
  'prefilter.mode': ['JEV_PREFILTER_MODE', 'shadow'],
  'prefilter.skipBelow': ['JEV_PREFILTER_SKIP_BELOW', 0.25],
};

// Dashboard-mutable keys with no .env variable (live-only; the Settings page marks
// them "not persistable"). Empty today: every mutable key above has one.
export const NOT_PERSISTABLE = new Set();

// Maps config dot-path → .env key. Only these keys can be persisted. Role routing
// keys (`roles.<role>.<field>` → LLM_PROVIDER, LLM_CLERK_MODEL, QUALITY_GATE_*, JEV_*)
// come from the registry (src/brain/roles.js), so persisting roles.mouth.provider
// writes LLM_PROVIDER exactly like the old llm.provider key did.
export const KEY_TO_ENV = {
  ...Object.fromEntries(Object.entries(PLAIN_KEYS).map(([k, [env]]) => [k, env])),
  ...keyToEnv(),
  // Mind owner caps (spec 008): mind.* → MIND_* from the MIND_SETTINGS table in
  // config.js. Owner-only; the mind's own lever nudges never touch config, so they
  // can never appear here (contracts/levers.md).
  ...mindKeyToEnv(),
  // Arcs owner caps (spec 010): arcs.* → ARCS_* from the ARCS_SETTINGS table in
  // config.js (dashboard-mutable rows only; the .env-only caps never appear here).
  ...arcsKeyToEnv(),
  // Chat influence (spec 012): chatInfluence.* → CHAT_INFLUENCE_* (dashboard-mutable rows only).
  ...chatInfluenceKeyToEnv(),
};

// Provider API-key field (config.llm.*) → .env var name, for Tier-3 key persistence.
// Intentionally NOT in KEY_TO_ENV so secret values never appear in computeEnvDiff /
// the /api/config/diff response. Written only via writeEnvVars (isolated path).
export const LLM_KEY_ENV = { ...PROVIDER_KEY_ENV };

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
  // A quoted value (envLiteral quotes one holding '#') ends at its closing quote.
  const q = /^(['"`])(.*?)\1(\s+#.*)?$/.exec(v);
  if (q) return q[2];
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
    // A role field absent from .env that still holds its registry default (or '' =
    // inherit) is not a change: without this every unset role var would show up as
    // a diff, and persisting would freeze inherited values into .env.
    if (envParsed == null) {
      // Arcs keys (spec 010): only the table default is "unchanged" — ARCS_WEEKLY_EFFORT
      // defaults to low, so a live '' (= the role's effort) is a real change to persist.
      const arcsDef = arcsDefaultForKey(keyPath) ?? chatInfluenceDefaultForKey(keyPath);
      if (arcsDef !== undefined) {
        if (liveFormatted === formatValue(arcsDef)) continue;
      } else {
        const def = defaultForKey(keyPath) ?? mindDefaultForKey(keyPath) ?? PLAIN_KEYS[keyPath]?.[1];
        if (liveFormatted === '' || (def !== undefined && liveFormatted === formatValue(def))) continue;
      }
    } else if (envParsed === '' && liveFormatted === '') {
      continue;
    }
    // 0.80 in .env and a live 0.8 are the same number: not a change.
    const asNum = (x) => (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
    if (Number.isFinite(asNum(envParsed)) && asNum(envParsed) === asNum(liveFormatted)) continue;
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

// .env.bak.<ts> copies hold every key the file had: keep only the newest few, so a
// rotated key doesn't stay on disk forever.
export const ENV_BACKUPS_KEPT = 5;

function pruneEnvBackups(envPath) {
  try {
    const dir = path.dirname(envPath);
    const prefix = `${path.basename(envPath)}.bak.`;
    const backups = fs.readdirSync(dir)
      .map((f) => ({ f, m: /^(\d+)(?:-(\d+))?$/.exec(f.slice(prefix.length)) }))
      .filter((x) => x.f.startsWith(prefix) && x.m)
      .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2] || 0) - Number(a.m[2] || 0))
      .map((x) => x.f);
    for (const f of backups.slice(ENV_BACKUPS_KEPT)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

// One .env line per key: a CR/LF/NUL would add lines of its own (the .env-only
// switches must stay .env-only), so it is refused here too, whatever the caller
// validated. dotenv cuts an unquoted value at '#', so such a value is quoted.
function envLiteral(key, value) {
  const v = String(value ?? '');
  if (ENV_UNSAFE.test(v)) throw new Error(`refusing to write ${key}: value contains a line break or NUL`);
  if (!/#|^['"`]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
  throw new Error(`refusing to write ${key}: value cannot be quoted safely`);
}

/**
 * Low-level: write a map of { ENV_KEY: value } into .env. Backs up the existing
 * .env to .env.bak.<ms>[-n] first (the newest ENV_BACKUPS_KEPT are kept), rewrites
 * matching KEY=VALUE lines (preserving comments/blanks), appends missing keys,
 * and renames atomically. Both .env and
 * the backup are chmod 0600 since the map MAY carry secrets (Tier-3 API keys).
 * Returns { applied: [envKey], backup }. NEVER log the values passed here.
 */
export function writeEnvVars(vars) {
  const envPath = path.join(config.projectRoot, '.env');
  const patchByEnvKey = new Map(Object.entries(vars || {}).map(([k, v]) => [k, envLiteral(k, v)]));
  if (!patchByEnvKey.size) return { applied: [], backup: null };

  let original = '';
  try { original = fs.readFileSync(envPath, 'utf-8'); } catch {}

  const ts = Date.now();
  let backupPath = null;
  if (original) {
    // Never overwrite an earlier backup (two writes in one millisecond would lose the
    // pre-change file): exclusive create, with a counter suffix on a clash.
    for (let n = 0; !backupPath; n++) {
      const candidate = `${envPath}.bak.${ts}${n ? `-${n}` : ''}`;
      try {
        fs.writeFileSync(candidate, original, { flag: 'wx', mode: 0o600 });
        backupPath = candidate;
      } catch (err) {
        if (err.code !== 'EEXIST' || n >= 100) throw err;
      }
    }
    try { fs.chmodSync(backupPath, 0o600); } catch {}
    pruneEnvBackups(envPath);
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
