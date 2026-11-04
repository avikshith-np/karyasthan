// Pure helpers for the setup wizard: no prompts, no network, nothing written.
// Tested by scripts/test-install.js.
import { PROVIDER_NAMES } from '../../src/brain/providers.js';

/** Every provider setup offers. An empty model means we have no suggestion: ask for an id. */
export const PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', note: 'has a free tier, enough to start', keyEnv: 'GEMINI_API_KEY', model: 'gemini-3.8-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'anthropic', label: 'Anthropic', note: 'Claude, direct', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', note: 'one key, many models', keyEnv: 'OPENROUTER_API_KEY', model: 'google/gemini-3.8-flash', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'xai', label: 'xAI', note: 'Grok, direct; you choose the model', keyEnv: 'XAI_API_KEY', model: '', keyUrl: 'https://console.x.ai' },
  { id: 'openai', label: 'OpenAI', note: 'you choose the model', keyEnv: 'LLM_API_KEY', model: '', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'glm', label: 'Zhipu GLM', note: 'you choose the model', keyEnv: 'GLM_API_KEY', model: '', keyUrl: 'https://open.bigmodel.cn/' },
  { id: 'ollama', label: 'Ollama', note: 'runs on this machine, no key', keyEnv: null, model: '', keyUrl: '' },
  { id: 'local', label: 'Other local server', note: 'OpenAI-compatible, no key', keyEnv: null, model: '', keyUrl: '', needsBaseUrl: true },
];
export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

/** Parse a .env body into KEY -> value. An inline comment is dropped unless the value is quoted. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if (q === '"' || q === "'") {
      const end = val.indexOf(q, 1);
      if (end > 0) val = val.slice(1, end);
    } else {
      const m = val.match(/(^|\s)#/);
      if (m) val = val.slice(0, m.index).trim();
    }
    out[key] = val;
  }
  return out;
}

/** A value as it must be written so dotenv reads it back whole. Throws on a line break. */
export function quoteEnvValue(value) {
  const v = String(value);
  if (/[\r\n\0]/.test(v)) throw new Error('A setting cannot hold a line break.');
  if (!/[\s#"'`]/.test(v)) return v;
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  throw new Error('A setting cannot hold both kinds of quote.');
}

/** Replace KEY= lines in place and append missing keys. Comments and other lines are left alone. */
export function applyEnvUpdates(body, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return body;
  const seen = new Set();
  const lines = String(body).split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    seen.add(key);
    return `${key}=${quoteEnvValue(updates[key])}`;
  });
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', '# Added by setup');
    for (const k of missing) lines.push(`${k}=${quoteEnvValue(updates[k])}`);
  }
  const result = lines.join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}

/**
 * Read a phone number the way people type it.
 * { ok, digits } or { ok: false, why: 'digits' | 'no_country_code' }
 */
export function normalizePhone(raw) {
  let s = String(raw || '').trim();
  const plus = s.startsWith('+');
  s = s.replace(/[\s().-]/g, '').replace(/^\+/, '');
  let international = plus;
  if (s.startsWith('00')) { s = s.slice(2); international = true; }
  if (!/^\d{8,15}$/.test(s)) return { ok: false, why: 'digits' };
  if (!international && s.length <= 10) return { ok: false, why: 'no_country_code' };
  return { ok: true, digits: s };
}

/** A blank age is fine. A character is always an adult. */
export function parseAge(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, age: null };
  if (!/^\d{1,3}$/.test(s)) return { ok: false, why: 'A whole number, or blank.' };
  const age = Number(s);
  if (age < 18 || age > 100) return { ok: false, why: 'The character must be an adult: 18 to 100, or blank.' };
  return { ok: true, age };
}

/** Text shaped like an API key: it must never land in the character, which goes into every prompt. */
export function looksLikeSecret(raw) {
  const s = String(raw || '').trim();
  if (/^(AIza[\w-]{20,}|sk-[\w-]{16,}|gsk_\w{16,}|xai-\w{16,}|ghp_\w{16,})$/.test(s)) return true;
  return s.length >= 32 && !/\s/.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s);
}

/** Reads "1,3" or "1 3" against n choices. Numbers only; null if anything else is there. */
export function parseNumberList(raw, n) {
  const parts = String(raw || '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return [];
  const out = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 1 || v > n) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Shows that a value is set without showing it. */
export function mask(value) {
  const s = String(value ?? '');
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${'•'.repeat(Math.min(8, s.length - 2))}${s.slice(-2)}`;
}

const COMMON_WORDS = new Set('the and but you are for not all can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use ok okay yes bro man hey hi'.split(' '));

/**
 * Names it answers to match anywhere inside a message, so a short or common one
 * makes it think it's addressed all the time.
 * { keep: [...], refused: [...], warn: [...] }
 */
export function checkAliases(list) {
  const keep = []; const refused = []; const warn = [];
  for (const raw of list) {
    const a = String(raw).toLowerCase().trim();
    if (!a || keep.includes(a)) continue;
    if ([...a].length < 2 || COMMON_WORDS.has(a)) { refused.push(a); continue; }
    if ([...a].length <= 3) warn.push(a);
    keep.push(a);
  }
  return { keep, refused, warn };
}

export function validTimeZone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

export function detectTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function localTimeIn(tz, at = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** identity.md from the template, plus a starting character's lines if one was picked. A blank answer drops its words, never leaves a hole. */
export function renderIdentity(template, persona, character = null) {
  const age = persona.age == null ? '' : String(persona.age);
  const region = String(persona.region || '').trim();
  const values = {
    NAME: persona.name,
    AGE: age,
    REGION: region,
    LANGUAGE: persona.language || 'English',
    VIBE: persona.vibe || '',
  };
  const out = [];
  for (const line of String(template).split('\n')) {
    if (line.includes('{{AGE}}') && line.includes('{{REGION}}')) {
      const words = [age && `${age} years old`, region && `from ${region}`].filter(Boolean).join(', ');
      if (words) out.push(`- ${words}.`);
      continue;
    }
    const blank = Object.entries(values).some(([k, v]) => !v && line.includes(`{{${k}}}`));
    if (blank) continue;
    out.push(line.replace(/\{\{(NAME|AGE|REGION|LANGUAGE|VIBE)\}\}/g, (_, k) => values[k]));
    if (character && line.includes('{{VIBE}}')) {
      for (const t of character.talk || []) out.push(`- ${t}`);
    }
    if (character && line.includes('{{AGE}}') === false && line.startsWith('## Your background')) {
      if (character.job) out.push(`- You work as ${character.job}.`);
      if (character.cares?.length) out.push(`- You care about: ${character.cares.join(', ')}.`);
    }
  }
  return out.join('\n');
}

/**
 * The settings that go with a choice of reply model on a new install, so no job is
 * left pointing at a provider the owner has no key for.
 */
export function routingFor(provider, model, { hasGemini = false, hasOpenrouter = false } = {}) {
  const updates = {
    LLM_PROVIDER: provider,
    LLM_MODEL: model,
    QUALITY_GATE_PROVIDER: provider,
    QUALITY_GATE_MODEL: model,
    LLM_FALLBACK_PROVIDER: 'none',
    LLM_FALLBACK_MODEL: '',
  };
  if (!hasGemini && hasOpenrouter) updates.TRANSCRIPTION_MODEL = 'google/gemini-3-flash-preview';
  return updates;
}

/**
 * What can't work on this machine stays off on a new install, each with a reason.
 * facts: { hasGemini, hasOpenrouter, ffmpeg, searxng, chromium }
 */
export function featuresToSwitchOff(facts) {
  const off = [];
  if (!facts.hasOpenrouter) off.push({ key: 'JEV_PREFILTER_ENABLED', label: 'Pre-filter', why: 'needs an OpenRouter key' });
  if (!facts.hasGemini) off.push({ key: 'IMAGE_GEN_ENABLED', label: 'Images', why: 'needs a Gemini key' });
  if (!facts.hasGemini) off.push({ key: 'VOICE_NOTE_ENABLED', label: 'Voice notes', why: 'needs a Gemini key' });
  else if (!facts.ffmpeg) off.push({ key: 'VOICE_NOTE_ENABLED', label: 'Voice notes', why: 'needs ffmpeg' });
  if (!facts.searxng) off.push({ key: 'WEB_SEARCH_ENABLED', label: 'Web search', why: 'no SearXNG server answered' });
  if (!facts.chromium) off.push({ key: 'WEB_BROWSE_ENABLED', label: 'Browsing', why: 'run: npx playwright install chromium' });
  return off;
}

export const TEMPLATE_IDS = ['dry-friend', 'warm-one', 'chaos-friend', 'quiet-nerd', 'organiser'];

/** Everything wrong with a headless run, found before anything is written. */
export function validateHeadless(env, { personaExists = false, currentEnv = {} } = {}) {
  const errors = [];
  const provider = (env.LLM_PROVIDER || currentEnv.LLM_PROVIDER || '').toLowerCase();
  if (provider && !PROVIDER_NAMES.includes(provider)) {
    errors.push(['LLM_PROVIDER', `"${env.LLM_PROVIDER}" is not one of ${PROVIDER_NAMES.join(', ')}`]);
  } else if (env.LLM_PROVIDER && !env.LLM_MODEL && !providerById(provider)?.model) {
    errors.push(['LLM_MODEL', `required with LLM_PROVIDER=${provider}`]);
  }
  if (env.KARYASTHAN_TEMPLATE && !TEMPLATE_IDS.includes(env.KARYASTHAN_TEMPLATE)) errors.push(['KARYASTHAN_TEMPLATE', `one of ${TEMPLATE_IDS.join(', ')}`]);
  if (env.WA_PHONE_NUMBER) {
    const p = normalizePhone(env.WA_PHONE_NUMBER);
    if (!p.ok) errors.push(['WA_PHONE_NUMBER', 'needs digits with a country code, like +15550100123']);
  }
  if (env.TIMEZONE && !validTimeZone(env.TIMEZONE)) errors.push(['TIMEZONE', 'not a known time zone, like Africa/Lagos']);
  if (!personaExists) {
    if (!env.KARYASTHAN_NAME) errors.push(['KARYASTHAN_NAME', 'required on a new install']);
    else if (looksLikeSecret(env.KARYASTHAN_NAME)) errors.push(['KARYASTHAN_NAME', 'looks like an API key']);
    if (env.KARYASTHAN_AGE) {
      const a = parseAge(env.KARYASTHAN_AGE);
      if (!a.ok) errors.push(['KARYASTHAN_AGE', a.why]);
    }
  }
  return errors;
}

export { credsAreLinked } from '../../src/utils/bootCheck.js';

/** What still stands between this install and working. Empty means ready. */
export function whatsLeft(current, { linked = false } = {}) {
  const left = [];
  const provider = (current.LLM_PROVIDER || '').toLowerCase();
  const def = providerById(provider);
  if (!provider || !current.LLM_MODEL) left.push({ what: 'A model for replies', how: 'npm run setup' });
  else if (def?.keyEnv && !current[def.keyEnv]) left.push({ what: `A ${def.label} key for replies`, how: `Add ${def.keyEnv} to .env (${def.keyUrl})` });
  if (!current.WA_PHONE_NUMBER) left.push({ what: 'The WhatsApp number', how: 'npm run setup' });
  if (!linked) left.push({ what: 'Link WhatsApp', how: 'npm run setup   (choose Link WhatsApp)' });
  return left;
}
