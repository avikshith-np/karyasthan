// Model-role registry (spec 007 R2). The ONE place that says which roles exist,
// which .env names configure them and what their defaults are. Config defaults
// (config.roles), the dashboard-mutable keys and their types, the config → .env
// persistence map, the dashboard routing rows and the role block of .env.example
// are all generated from ROLE_DEFS — add a field or role here, nowhere else.
//
// Pure module: imports only providers.js (config.js imports this file, so it must
// not import config.js back).
//
// Raw vs effective: config.roles.* holds the RAW values ('' = inherit for a role
// with `inherit`); resolveRole() computes the effective routing at call time,
// field by field, so a runtime change to mouth flows to clerk and persisting
// never freezes an inherited value into .env.

import { PROVIDER_NAMES, EFFORT_LEVELS } from './providers.js';

export const ROLE_NAMES = ['mouth', 'clerk', 'mind', 'fun', 'desire', 'gate', 'jev'];

// Non-role callers that are metered and budgeted but keep their own model
// settings (TRANSCRIPTION_MODEL, IMAGE_GEN_MODEL, …). Budget only.
export const METERED_LABELS = ['senses', 'image', 'voice', 'bill', 'probe'];

// Field → .env suffix. A role's var is `${prefix}${suffix}`.
const SUFFIX = {
  provider: 'PROVIDER',
  model: 'MODEL',
  effort: 'EFFORT',
  maxTokens: 'MAX_TOKENS',
  fallbackProvider: 'FALLBACK_PROVIDER',
  fallbackModel: 'FALLBACK_MODEL',
  timeoutMs: 'TIMEOUT_MS',
  budgetUsd: 'BUDGET_USD',
};

const CHAT_FIELDS = Object.keys(SUFFIX);
const JEV_FIELDS = ['model', 'timeoutMs', 'budgetUsd'];
const LABEL_FIELDS = ['budgetUsd'];

// Fields an inheriting role takes from its parent when its own raw value is ''.
const INHERITABLE = new Set(['provider', 'model', 'effort', 'maxTokens', 'timeoutMs']);

const MAX_TOKENS_CAP = 1_000_000;
const TIMEOUT_MS_CAP = 600_000; // 10 min
const BUDGET_TYPE = 'float:0..100000';

// Dashboard/coerce types. `?` types accept '' (clear → inherit / disabled).
//   enum:fallback accepts '' (inherit mouth's fallback), 'none' (no fallback) or a provider.
function fieldType(def, field) {
  const optional = !!def.inherit || def.optionalRouting;
  switch (field) {
    case 'provider': return optional ? 'enum:provider?' : 'enum:provider';
    case 'model': return optional ? 'string?' : 'string';
    case 'effort': return 'enum:effort';
    // Bounded like .env parsing (never negative): a negative timeoutMs would abort
    // every call of the role, a negative budget would silently lift its cap.
    case 'maxTokens': return def.inherit ? 'int?' : `int:0..${MAX_TOKENS_CAP}`;
    case 'timeoutMs': return def.inherit ? 'int?' : `int:0..${TIMEOUT_MS_CAP}`;
    case 'fallbackProvider': return 'enum:fallback';
    case 'fallbackModel': return 'string?';
    case 'budgetUsd': return BUDGET_TYPE;
    default: return 'string?';
  }
}

export const ROLE_DEFS = {
  mouth: {
    label: 'Mouth',
    description: 'chat replies: group/DM replies, web-search loop, Instagram chat replies and captions',
    prefix: 'LLM_',
    kind: 'chat',
    inherit: null,
    shadowOnly: false,
    defaults: {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      effort: 'low', // today's hardcoded Gemini reasoning_effort
      maxTokens: 3072,
      fallbackProvider: 'ollama',
      fallbackModel: 'gemini-3-flash-preview',
      timeoutMs: 0, // 0 = no per-link deadline (today's chat path)
      budgetUsd: 0, // 0 = no role budget (the global cap still applies)
    },
  },
  clerk: {
    label: 'Clerk',
    description: 'background text work: batch learning, call summaries, voice descriptors, GIF queries, taste card',
    prefix: 'LLM_CLERK_',
    kind: 'chat',
    inherit: 'mouth', // empty fields → mouth's (routing unchanged on deploy)
    shadowOnly: false,
    defaults: {
      provider: '', model: '', effort: '', maxTokens: '',
      fallbackProvider: '', fallbackModel: '', timeoutMs: '', budgetUsd: 0,
    },
  },
  mind: {
    label: 'Mind',
    description: 'deliberate reasoning: the mind (mind.*), life world seed, Director prompt, story passes, dashboard probe',
    prefix: 'LLM_MIND_',
    kind: 'chat',
    inherit: null,
    optionalRouting: true, // clearing provider/model disables it
    shadowOnly: false,
    defaults: {
      provider: 'anthropic', // direct Anthropic API (owner: never via OpenRouter)
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 16000,
      fallbackProvider: '',
      fallbackModel: '',
      timeoutMs: 120000,
      budgetUsd: 10,
    },
  },
  fun: {
    label: 'Fun',
    description: 'shadow-only experiments (never sends to a chat), e.g. the proactive A/B',
    prefix: 'LLM_FUN_',
    kind: 'chat',
    inherit: null,
    optionalRouting: true,
    shadowOnly: true,
    defaults: {
      provider: 'openrouter',
      model: 'x-ai/grok-4.7',
      effort: '',
      maxTokens: 1024,
      fallbackProvider: 'none',
      fallbackModel: '',
      timeoutMs: 30000,
      budgetUsd: 2,
    },
  },
  // Explicit in-world texts and private scenes. shadowOnly refuses send:true
  // (never a WhatsApp reply). fallbackProvider 'none' so a refusal does not
  // inherit the mouth's model. Not a shadow experiment: the prose stays in the
  // life log; real chats only see a non-graphic gist.
  desire: {
    label: 'Desire',
    description: 'explicit in-world texts and private scenes (never a chat send; no fallback)',
    prefix: 'LLM_DESIRE_',
    kind: 'chat',
    inherit: null,
    optionalRouting: true,
    shadowOnly: true,
    defaults: {
      provider: 'openrouter',
      model: 'x-ai/grok-4.7',
      effort: '',
      maxTokens: 1024,
      fallbackProvider: 'none',
      fallbackModel: '',
      timeoutMs: 60000,
      budgetUsd: 5,
    },
  },
  gate: {
    label: 'Gate',
    description: 'quality gate judge (fails open for plain text, closed for cloned voice)',
    prefix: 'QUALITY_GATE_',
    kind: 'chat',
    inherit: null,
    shadowOnly: false,
    defaults: {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      effort: 'low', // the 256-token cap relies on minimal thinking
      maxTokens: 256,
      fallbackProvider: '', // '' → mouth's fallback (today's behaviour)
      fallbackModel: '',
      timeoutMs: 8000,
      budgetUsd: 0,
    },
  },
  jev: {
    label: 'Jev',
    description: 'TypeSafe System One typed decisions via OpenRouter (Instagram judge + chat choice, relay intent, pre-filter, life decisions + claims, mind glances, chat perception)',
    prefix: 'JEV_',
    kind: 'jev',
    provider: 'openrouter', // fixed: /api/v1/systemone
    inherit: null,
    shadowOnly: false,
    defaults: {
      model: 'typesafe/jev-1.14', // pinned: thresholds are tuned against one version
      timeoutMs: 30000,
      budgetUsd: 0,
    },
  },
};

const LABEL_DEFS = {
  senses: { label: 'Senses', description: 'transcription, media description, reel description (never blocked: chat input)' },
  image: { label: 'Image', description: 'image generation and editing' },
  voice: { label: 'Voice', description: 'voice-note TTS' },
  bill: { label: 'Bill', description: 'receipt and assignment parsing' },
  probe: { label: 'Probe', description: 'dashboard TEST button' },
};

function fieldsOf(name) {
  if (LABEL_DEFS[name]) return LABEL_FIELDS;
  return ROLE_DEFS[name]?.kind === 'jev' ? JEV_FIELDS : CHAT_FIELDS;
}

function isNumericField(field) {
  return field === 'maxTokens' || field === 'timeoutMs' || field === 'budgetUsd';
}

/** .env name of a role/label field: envName('clerk','model') → 'LLM_CLERK_MODEL'. */
export function envName(role, field) {
  if (LABEL_DEFS[role]) return `LLM_${role.toUpperCase()}_BUDGET_USD`;
  const def = ROLE_DEFS[role];
  if (!def || !SUFFIX[field]) throw new Error(`unknown role field ${role}.${field}`);
  return `${def.prefix}${SUFFIX[field]}`;
}

/** Registry default (raw) of a role/label field. */
export function defaultFor(role, field) {
  if (LABEL_DEFS[role]) return field === 'budgetUsd' ? 0 : undefined;
  return ROLE_DEFS[role]?.defaults?.[field];
}

function parseField(def, field, rawEnv) {
  const fallback = def.defaults[field];
  if (rawEnv === undefined || rawEnv === null) return fallback;
  const v = String(rawEnv).trim();
  if (isNumericField(field)) {
    if (v === '') return fallback;
    const n = field === 'budgetUsd' ? parseFloat(v) : parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  // A present-but-empty string is meaningful only where '' is a legal value:
  // effort ('' = send none), and every field of an inheriting/optional role
  // ('' = inherit / disabled). Elsewhere it means "unset" → default (like optional()).
  if (v === '') {
    if (field === 'effort') return '';
    if (field === 'fallbackProvider' || field === 'fallbackModel') return '';
    if (def.inherit || def.optionalRouting) return '';
    return fallback;
  }
  return v;
}

/**
 * Raw role config from an env map (process.env). Existing names keep working
 * because each role's prefix IS its legacy prefix (mouth ← LLM_*, gate ←
 * QUALITY_GATE_*, jev ← JEV_MODEL).
 */
export function readRoleConfig(env = {}) {
  const out = {};
  for (const name of ROLE_NAMES) {
    const def = ROLE_DEFS[name];
    const row = {};
    for (const field of fieldsOf(name)) row[field] = parseField(def, field, env[envName(name, field)]);
    out[name] = row;
  }
  for (const name of METERED_LABELS) {
    const raw = env[envName(name, 'budgetUsd')];
    const n = raw === undefined || String(raw).trim() === '' ? 0 : parseFloat(raw);
    out[name] = { budgetUsd: Number.isFinite(n) && n >= 0 ? n : 0 };
  }
  return out;
}

const isEmpty = (v) => v === '' || v === null || v === undefined;

function rolesOf(cfg) {
  return cfg?.roles || cfg || {};
}

function effectiveField(name, field, roles, depth = 0) {
  const raw = roles[name]?.[field];
  const def = ROLE_DEFS[name];
  if (isEmpty(raw) && def?.inherit && INHERITABLE.has(field) && depth < 4) {
    return effectiveField(def.inherit, field, roles, depth + 1);
  }
  return isEmpty(raw) ? (isNumericField(field) ? 0 : '') : raw;
}

/** Mouth's own fallback (mouth never inherits one). */
function mouthFallback(roles) {
  const p = roles.mouth?.fallbackProvider;
  const m = roles.mouth?.fallbackModel;
  if (isEmpty(p) || p === 'none' || isEmpty(m) || !PROVIDER_NAMES.includes(p)) return null;
  return { provider: p, model: m };
}

/**
 * Effective routing of a role (or metered label) at call time.
 *   → { name, kind, provider, model, effort, maxTokens, timeoutMs, budgetUsd,
 *       fallback:{provider,model}|null, chain:[{provider,model}], disabled, shadowOnly }
 * A role is disabled when its provider or model is empty after inheritance (or
 * the provider is unknown). An empty fallback inherits mouth's fallback; the
 * literal 'none' means no fallback; a fallback equal to the primary is dropped.
 */
export function resolveRole(name, cfg) {
  const roles = rolesOf(cfg);
  if (LABEL_DEFS[name]) {
    return {
      name, kind: 'label', provider: '', model: '', effort: '', maxTokens: 0, timeoutMs: 0,
      budgetUsd: Number(roles[name]?.budgetUsd) || 0, fallback: null, chain: [], disabled: false, shadowOnly: false,
    };
  }
  const def = ROLE_DEFS[name];
  if (!def) return null;

  if (def.kind === 'jev') {
    const model = effectiveField(name, 'model', roles);
    return {
      name, kind: 'jev', provider: def.provider, model, effort: '', maxTokens: 0,
      timeoutMs: Number(effectiveField(name, 'timeoutMs', roles)) || def.defaults.timeoutMs,
      budgetUsd: Number(roles[name]?.budgetUsd) || 0,
      fallback: null, chain: model ? [{ provider: def.provider, model }] : [], disabled: !model, shadowOnly: false,
    };
  }

  const provider = effectiveField(name, 'provider', roles);
  const model = effectiveField(name, 'model', roles);
  const effort = effectiveField(name, 'effort', roles);
  const maxTokens = Number(effectiveField(name, 'maxTokens', roles)) || 0;
  const timeoutMs = Number(effectiveField(name, 'timeoutMs', roles)) || 0;
  const budgetUsd = Number(roles[name]?.budgetUsd) || 0;
  const disabled = !provider || !model || !PROVIDER_NAMES.includes(provider);

  let fallback = null;
  const fp = roles[name]?.fallbackProvider;
  const fm = roles[name]?.fallbackModel;
  if (fp === 'none') {
    fallback = null;
  } else if (isEmpty(fp)) {
    fallback = name === 'mouth' ? null : mouthFallback(roles);
  } else if (PROVIDER_NAMES.includes(fp) && !isEmpty(fm)) {
    fallback = { provider: fp, model: fm };
  }
  if (fallback && fallback.provider === provider && fallback.model === model) fallback = null;

  const chain = disabled ? [] : [{ provider, model }];
  if (!disabled && fallback) chain.push(fallback);

  return {
    name, kind: def.kind, provider, model, effort: EFFORT_LEVELS.includes(effort) ? effort : '',
    maxTokens, timeoutMs, budgetUsd, fallback, chain, disabled, shadowOnly: !!def.shadowOnly,
  };
}

function allNames() {
  return [...ROLE_NAMES, ...METERED_LABELS];
}

function typeOf(name, field) {
  if (LABEL_DEFS[name]) return BUDGET_TYPE;
  return fieldType(ROLE_DEFS[name], field);
}

/** Dashboard-mutable keys → type: { 'roles.mouth.provider': 'enum:provider', … }. */
export function mutableKeys() {
  const out = {};
  for (const name of allNames()) {
    for (const field of fieldsOf(name)) out[`roles.${name}.${field}`] = typeOf(name, field);
  }
  return out;
}

/** Config path → .env name: { 'roles.mouth.provider': 'LLM_PROVIDER', … }. */
export function keyToEnv() {
  const out = {};
  for (const name of allNames()) {
    for (const field of fieldsOf(name)) out[`roles.${name}.${field}`] = envName(name, field);
  }
  return out;
}

/** Default value for a `roles.<name>.<field>` config path (undefined for other keys). */
export function defaultForKey(key) {
  const m = /^roles\.([a-z]+)\.([A-Za-z]+)$/.exec(key || '');
  return m ? defaultFor(m[1], m[2]) : undefined;
}

/** Rows for the dashboard routing table (values are filled in by the route). */
export function routingRows() {
  return allNames().map((name) => {
    const label = LABEL_DEFS[name];
    const def = ROLE_DEFS[name];
    return {
      role: name,
      label: label ? label.label : def.label,
      description: label ? label.description : def.description,
      kind: label ? 'label' : def.kind,
      inherit: def?.inherit || null,
      shadowOnly: !!def?.shadowOnly,
      fields: fieldsOf(name).map((field) => ({
        field,
        key: `roles.${name}.${field}`,
        type: typeOf(name, field),
        envName: envName(name, field),
        default: defaultFor(name, field),
      })),
    };
  });
}

// Notes printed on the mouth/jev lines of the generated block (once, not per role).
const FIELD_NOTE = {
  provider: PROVIDER_NAMES.join(' | '),
  effort: `${EFFORT_LEVELS.filter(Boolean).join(' | ')} (empty = send none)`,
  fallbackProvider: "other roles: empty = this fallback; 'none' = no fallback",
  timeoutMs: 'ms per chain link (retries included), 0 = none',
  budgetUsd: 'USD per calendar month in TIMEZONE; 0 = none',
};
const JEV_NOTE = { timeoutMs: 'ms per Jev call' };

/** The generated role block of .env.example (between the markers, markers excluded). */
export function envExampleBlock() {
  const lines = [
    '# One block per model role (spec 007). Every field is optional; the value shown is the',
    '# code default. A role with `inherit` takes the parent role\'s value for each EMPTY field.',
    '# Each provider uses ONLY its own key (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,',
    '# GLM_API_KEY, XAI_API_KEY; LLM_API_KEY is the OpenAI key). Budgets sit under the global LLM_MONTHLY_BUDGET_USD.',
    '# A Grok model id depends on the route: x-ai/grok-4.7 with provider=openrouter, grok-4.7 with',
    '# provider=xai (key from console.x.ai). Change the provider and the model together.',
  ];
  for (const name of ROLE_NAMES) {
    const def = ROLE_DEFS[name];
    lines.push('');
    lines.push(`# ${name} — ${def.description}${def.inherit ? ` (empty fields inherit ${def.inherit})` : ''}`);
    for (const field of fieldsOf(name)) {
      const value = def.defaults[field];
      const note = name === 'mouth' ? FIELD_NOTE[field] : name === 'jev' ? JEV_NOTE[field] : '';
      const line = `${envName(name, field)}=${value ?? ''}`;
      lines.push(note ? `${line.padEnd(40)} # ${note}` : line);
    }
  }
  lines.push('');
  lines.push('# Metered labels (budget only; their models are set elsewhere: TRANSCRIPTION_MODEL,');
  lines.push('# IG_DESCRIBE_MODEL, IMAGE_GEN_MODEL, VOICE_NOTE_MODEL, BILL_SPLIT_MODEL).');
  for (const name of METERED_LABELS) {
    lines.push(`${`${envName(name, 'budgetUsd')}=0`.padEnd(40)} # ${LABEL_DEFS[name].description}`);
  }
  return lines.join('\n');
}
