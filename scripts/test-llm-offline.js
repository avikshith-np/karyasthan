// Offline checks for the LLM transport fixes — no network. globalThis.fetch is
// replaced by a mock before any call, so nothing leaves the process. Model calls
// write llm_usage rows (spec 007), so a scratch DB under data/ is used and deleted.
//   1. callLlm's timeoutMs is one total budget for the attempt loop; each attempt still
//      gets a fresh (never pre-aborted) signal for what is left.
//   2. The 'local' provider never sends the shared LLM_API_KEY as its Bearer token.
//   3. getJevKey() follows a runtime change of config.llm.openrouterApiKey.
//   4. The direct xAI provider: its URL and header, its own key only, a no_key row. Never the real API.
//
// Usage:  node scripts/test-llm-offline.js
// Exits non-zero if any check fails. Keys used here are fake placeholders.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRATCH_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', `test-llm-offline-${process.pid}.db`);
process.env.DB_PATH = SCRATCH_DB;
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'silent';

const { config, getJevKey } = await import('../src/utils/config.js');
const { callLlm } = await import('../src/brain/llm.js');
const { askJev } = await import('../src/brain/jev.js');
const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
runMigrations();
config.llm.monthlyBudgetUsd = 0; // budgets are test-roles' job; never let a stray row block a call here

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const chatBody = { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] };

// Hangs until its signal aborts (rejecting at once if it is already aborted).
function hangUntilAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    if (!signal) return; // no signal → would hang forever; the test never does this
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}

const realFetch = globalThis.fetch;
// AbortSignal.timeout() timers are unref'd; keep the loop alive while a mock hangs.
const keepAlive = setInterval(() => {}, 1000);
config.llm.baseUrl = 'http://127.0.0.1:9/v1/chat/completions'; // never contacted: fetch is mocked
const TIMEOUT = 80;

// ── 1. Timeout budget ─────────────────────────────────────────────────────────
{
  // A hung provider: the whole call is bounded by ~timeoutMs (no retry once the
  // budget can't cover the 1 s backoff) — not timeoutMs × attempts.
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ signal: opts.signal, abortedAtStart: !!opts.signal?.aborted, t0: Date.now() });
    return hangUntilAbort(opts.signal);
  };
  const t0 = Date.now();
  const out = await callLlm('sys', 'user', { role: 'probe', provider: 'local', model: 'm', timeoutMs: TIMEOUT, noFallback: true });
  const ms = Date.now() - t0;
  check('all-timeout run returns null', out === null);
  check('every attempt has a signal', calls.length > 0 && calls.every(c => c.signal));
  check('no attempt starts with an already-aborted signal', calls.every(c => !c.abortedAtStart));
  check('hung call stays within ~timeoutMs total', ms >= TIMEOUT - 15 && ms < TIMEOUT + 400, `${ms}ms, ${calls.length} attempt(s)`);
}
{
  // Fast 5xx on attempt 1 with budget left for the backoff → the retry gets a fresh,
  // live signal for the remaining budget and succeeds.
  const BUDGET = 1600;
  let n = 0;
  const signals = [];
  globalThis.fetch = async (url, opts) => {
    n++;
    signals.push(opts.signal);
    if (opts.signal?.aborted) throw new Error('aborted before start');
    if (n === 1) return { ok: false, status: 503, text: async () => 'busy', json: async () => ({}) };
    return okResponse(chatBody);
  };
  const out = await callLlm('sys', 'user', { role: 'probe', provider: 'local', model: 'm', timeoutMs: BUDGET, noFallback: true });
  check('retry within the budget succeeds', out === 'hello', `got ${JSON.stringify(out)} after ${n} attempts`);
  check('each attempt gets its own signal', new Set(signals).size === signals.length);
}

// ── 2. Local provider Authorization ───────────────────────────────────────────
{
  const SHARED = 'shared-cloud-key-FAKE';
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(opts.headers?.Authorization); return okResponse(chatBody); };
  config.llm.apiKey = SHARED;

  config.llm.localApiKey = '';
  await callLlm('sys', 'user', { role: 'probe', provider: 'local', model: 'm', noFallback: true });
  config.llm.localApiKey = 'local-key-FAKE';
  await callLlm('sys', 'user', { role: 'probe', provider: 'local', model: 'm', noFallback: true });

  check('local requests were made', seen.length === 2, `got ${seen.length}`);
  check('local Authorization never carries the shared key', seen.every(h => h && !h.includes(SHARED)));
  check('no local key → placeholder bearer', seen[0] === 'Bearer local');
  check('LLM_LOCAL_API_KEY is used when set', seen[1] === 'Bearer local-key-FAKE');
  config.llm.apiKey = '';
  config.llm.localApiKey = '';
}

// ── 3. Jev key resolved at call time ──────────────────────────────────────────
{
  config.instagram.jevApiKey = '';
  config.llm.openrouterApiKey = '';
  check('no keys → empty Jev key', getJevKey() === '');
  let threw = false;
  try { await askJev({ state: {}, questions: {} }); } catch { threw = true; }
  check('askJev refuses without a key (fails closed)', threw);

  config.llm.openrouterApiKey = 'or-key-A-FAKE';
  check('Jev key follows the OpenRouter key', getJevKey() === 'or-key-A-FAKE');
  config.llm.openrouterApiKey = 'or-key-B-FAKE'; // e.g. set on the dashboard at runtime
  check('Jev key follows a runtime change', getJevKey() === 'or-key-B-FAKE');

  let auth = null;
  globalThis.fetch = async (url, opts) => { auth = opts.headers?.Authorization; return okResponse({ answers: {} }); };
  await askJev({ state: {}, questions: {} });
  check('askJev sends the current key', auth === 'Bearer or-key-B-FAKE');

  config.instagram.jevApiKey = 'jev-override-FAKE';
  check('JEV_API_KEY override wins', getJevKey() === 'jev-override-FAKE');
  config.instagram.jevApiKey = '';
  config.llm.openrouterApiKey = '';
}

// ── 4. The direct xAI provider ────────────────────────────────────────────────
{
  const rowsOf = () => getDb().prepare("SELECT status, ok, provider FROM llm_usage WHERE provider = 'xai' ORDER BY id").all();
  const opts = { role: 'probe', provider: 'xai', model: 'grok-4.7', noFallback: true };
  const others = ['apiKey', 'anthropicApiKey', 'geminiApiKey', 'glmApiKey', 'openrouterApiKey', 'localApiKey'];
  const kept = Object.fromEntries(others.map((f) => [f, config.llm[f]]));
  for (const f of others) config.llm[f] = `FAKE-${f}-000000`;
  config.instagram.jevApiKey = 'FAKE-jev-000000';
  config.llm.xaiApiKey = '';

  const seen = [];
  globalThis.fetch = async (url, o) => { seen.push({ url: String(url), auth: o.headers?.Authorization, body: JSON.parse(o.body) }); return okResponse(chatBody); };
  const none = await callLlm('s', 'u', opts);
  check('xai without XAI_API_KEY, every other key set: nothing sent', seen.length === 0 && none === null);
  check('…and one no_key row in the ledger', JSON.stringify(rowsOf()) === JSON.stringify([{ status: 'no_key', ok: 0, provider: 'xai' }]), JSON.stringify(rowsOf()));

  config.llm.xaiApiKey = 'FAKE-xai-key-000000';
  const res = await callLlm('s', 'u', { ...opts, maxTokens: 500, temperature: 0.4, effort: 'low' });
  check("xai: xAI's chat completions URL", seen.length === 1 && seen[0].url === 'https://api.x.ai/v1/chat/completions', seen[0]?.url);
  check('xai: Bearer XAI_API_KEY and no other key', seen[0]?.auth === 'Bearer FAKE-xai-key-000000');
  check('xai: the id as given, max_completion_tokens not the deprecated max_tokens, effort as reasoning_effort',
    seen[0]?.body.model === 'grok-4.7' && seen[0]?.body.max_completion_tokens === 500 && !('max_tokens' in seen[0]?.body)
      && seen[0]?.body.reasoning_effort === 'low' && seen[0]?.body.temperature === 0.4, JSON.stringify(seen[0]?.body));
  check('xai: system and user messages, and the answer comes back',
    JSON.stringify(seen[0]?.body.messages) === JSON.stringify([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]) && res === 'hello');
  await callLlm('s', 'u', { ...opts, effort: '' });
  check('xai: no effort set sends none', !('reasoning_effort' in seen[1].body), JSON.stringify(seen[1].body));

  config.llm.xaiApiKey = '';
  config.instagram.jevApiKey = '';
  for (const f of others) config.llm[f] = kept[f];
}

globalThis.fetch = realFetch;
clearInterval(keepAlive);
closeDb();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(SCRATCH_DB + suffix, { force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll offline LLM checks passed');
process.exit(failures ? 1 : 0);
