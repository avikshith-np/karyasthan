// Which model we suggest for which job, given the keys someone holds. They decide:
// every job can be changed to any provider and model id, and setup tests the choice.
// One table, dated. A newer id can always be typed. Pure.
import fs from 'node:fs';
import path from 'node:path';
import { ROLE_DEFS } from '../../src/brain/roles.js';

export const SUGGESTIONS_AS_OF = '2026-11';

const MODELS = {
  gemini: [
    { model: 'gemini-3.8-flash', tier: 'fast', note: 'fast, cheap, keeps its voice' },
    { model: 'gemini-2.5-pro', tier: 'deep', note: 'stronger, costs more' },
  ],
  anthropic: [
    { model: 'claude-haiku-5-5', tier: 'fast', note: 'cheapest Claude' },
    { model: 'claude-sonnet-5-5', tier: 'mid', note: 'strong writing, costs more' },
    { model: 'claude-opus-5-5', tier: 'deep', note: 'best writing, costs most' },
  ],
  openrouter: [
    { model: 'google/gemini-3.8-flash', tier: 'fast', note: 'fast, cheap, keeps its voice' },
    { model: 'anthropic/claude-opus-5.5', tier: 'deep', note: 'best writing, costs most' },
    { model: 'x-ai/grok-4.7', tier: 'fun', note: 'Grok' },
  ],
  xai: [{ model: 'grok-4.7', tier: 'fun', note: 'Grok, direct' }],
};
export const modelsFor = (provider) => MODELS[provider] || [];
const pick = (provider, tier) => MODELS[provider]?.find((m) => m.tier === tier)?.model || '';

const CHEAP_ORDER = [
  ['gemini', 'fast', ''],
  ['openrouter', 'fast', ''],
  ['anthropic', 'fast', 'less tested than Gemini here'],
];

/** Every job someone can route. `off` jobs may be left without a model. */
export const JOBS = [
  { id: 'replies', label: 'Replies', what: 'every message it sends', prefix: 'LLM_', why: 'fast, cheap, keeps its voice', order: CHEAP_ORDER },
  { id: 'background', label: 'Background work', what: 'learning, digests, scenes', prefix: 'LLM_CLERK_', why: 'many small calls, keep it cheap', order: CHEAP_ORDER },
  { id: 'check', label: 'Quality check', what: 'a verdict on each reply', prefix: 'QUALITY_GATE_', why: 'one short verdict per reply', order: CHEAP_ORDER },
  {
    id: 'deep', label: 'Deep thinking', what: 'mind, world, weekly story', prefix: 'LLM_MIND_', why: 'best writing, only a few calls', off: true, order: [
      ['anthropic', 'deep', 'what the author runs, direct'],
      ['openrouter', 'deep', 'same model through OpenRouter'],
      ['gemini', 'deep', 'works, less tested'],
    ],
  },
  {
    id: 'fictional', label: 'Fictional texts', what: "life's phone, optional", prefix: 'LLM_DESIRE_', why: 'optional', off: true, order: [
      ['openrouter', 'fun', ''],
      ['xai', 'fun', ''],
    ],
  },
];
export const jobById = (id) => JOBS.find((j) => j.id === id) || null;

/** The fixed one: thresholds are tuned to one Jev version, which only OpenRouter serves. */
export const smallDecisions = (have) => (have.has('openrouter')
  ? { model: 'typesafe/jev-1.14', why: 'fixed: its thresholds are tuned to this version' }
  : { model: 'code decides', why: 'needs OpenRouter; works without it' });

const NO_SUGGESTION = ['xai', 'openai', 'glm', 'ollama', 'local'];

/** { provider, model, why } for a job, or { provider: '', model: '', why } when nothing fits. */
export function suggest(job, have) {
  for (const [provider, tier, note] of job.order) {
    if (have.has(provider)) return { provider, model: pick(provider, tier), why: note || job.why };
  }
  if (job.id === 'deep' && !NO_SUGGESTION.some((p) => p !== 'ollama' && p !== 'local' && have.has(p))) {
    return { provider: '', model: '', why: 'needs a key: a local model has no price, and the mind refuses that' };
  }
  if (job.off) {
    const own = NO_SUGGESTION.filter((p) => p !== 'ollama' && p !== 'local').find((p) => have.has(p));
    if (job.id === 'deep' && own) return { provider: own, model: '', why: 'type a model id; no suggestion yet' };
    return { provider: '', model: '', why: 'off until you choose one' };
  }
  const own = NO_SUGGESTION.find((p) => have.has(p));
  if (own) return { provider: own, model: '', why: 'type a model id; no suggestion yet' };
  return { provider: '', model: '', why: 'needs a key' };
}

/** A backup for a job: the next provider held, never the same one. */
export function suggestBackup(job, choice, have) {
  if (!choice.provider || job.id === 'fictional') return null;
  for (const [provider, tier] of job.order) {
    if (provider !== choice.provider && have.has(provider) && pick(provider, tier)) return { provider, model: pick(provider, tier) };
  }
  return null;
}

/** The .env lines for one job's choice. `none` keeps a role off even where a key exists. */
export function jobUpdates(job, choice, backup = null) {
  const p = job.prefix;
  const off = !choice.provider || !choice.model;
  const u = {
    [`${p}PROVIDER`]: off ? 'none' : choice.provider,
    [`${p}MODEL`]: off ? '' : choice.model,
    [`${p}FALLBACK_PROVIDER`]: backup ? backup.provider : 'none',
    [`${p}FALLBACK_MODEL`]: backup ? backup.model : '',
  };
  return u;
}

const ROLE_OF = { replies: 'mouth', background: 'clerk', check: 'gate', deep: 'mind', fictional: 'desire' };

/**
 * What the bot will really use for a job: the .env's value, else the role's built-in default,
 * as config.js reads it. An empty background job means "same as replies".
 */
export function currentChoice(job, env) {
  const d = ROLE_DEFS[ROLE_OF[job.id]]?.defaults || {};
  const p = env[`${job.prefix}PROVIDER`] || d.provider || '';
  const m = env[`${job.prefix}MODEL`] || d.model || '';
  if (p === 'none') return { provider: '', model: '' };
  if (!p && job.id === 'background') return currentChoice(JOBS[0], env);
  return { provider: p, model: m };
}

/** Catches a provider and a model that can't belong together, before a call is spent. */
export function modelFitsProvider(provider, model) {
  const m = String(model || '');
  if (provider === 'openrouter' && !m.includes('/')) return `OpenRouter ids look like vendor/model, like ${pick('openrouter', 'fast')}.`;
  if (provider !== 'openrouter' && provider !== 'ollama' && provider !== 'local' && m.includes('/')) return 'That looks like an OpenRouter id. Change the provider, or type a model for this one.';
  if (provider === 'anthropic' && !/^claude/i.test(m)) return "That isn't a Claude model. Change the provider, or type a Claude model.";
  if (provider === 'gemini' && !/^gemini/i.test(m)) return "That isn't a Gemini model. Change the provider, or type a Gemini model.";
  if (provider === 'xai' && !/^grok/i.test(m)) return "That isn't a Grok model. Change the provider, or type a Grok model.";
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; }
}
const priceKey = (provider, model) => `${provider}/${model}`;
export function priceKnown(root, provider, model) {
  const key = priceKey(provider, model);
  return Boolean(readJson(path.join(root, 'data/llm-prices.json'))[key] || readJson(path.join(root, 'src/brain/llm-prices.example.json'))[key]);
}
/** Written so the usage ledger can count it: same place and shape as the committed table. */
export function savePrice(root, provider, model, inputPerM, outputPerM) {
  const file = path.join(root, 'data/llm-prices.json');
  const all = readJson(file);
  all[priceKey(provider, model)] = { inputPerM, outputPerM };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
/** "0.20 0.80" → [0.2, 0.8], else null. */
export function parsePrice(raw) {
  const m = String(raw || '').trim().match(/^\$?(\d+(?:\.\d+)?)[\s,/]+\$?(\d+(?:\.\d+)?)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The table setup prints. */
export function jobTable(rows) {
  const lines = [`     ${'Job'.padEnd(18)}${'Model'.padEnd(34)}Why`];
  rows.forEach((r, i) => {
    const n = r.fixed ? ' ' : String(i + 1);
    const name = r.model ? (r.provider ? `${r.model}${r.provider === 'anthropic' && !r.model.startsWith('claude') ? '' : ''}` : r.model) : 'off';
    lines.push(`   ${n} ${r.label.padEnd(18)}${name.padEnd(34)}${r.why || ''}`);
  });
  return lines;
}
