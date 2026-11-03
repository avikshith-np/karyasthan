// Shared, metered transport for the direct-fetch Gemini callers (spec 007 R6).
//
//   geminiPost     — one native Gemini REST call (generateContent, :predict, the
//                    Interactions API): budget check → own key (x-goog-api-key header,
//                    never a key in the URL) → fetch → scrubbed error log → one llm_usage row.
//   geminiGenerate — generateContent on top of geminiPost; returns the text.
//   describeInline — "describe/transcribe this media" for chat input (transcription,
//                    image/sticker description) with today's routing: OpenRouter when
//                    its key is set, else native Gemini. One copy of what transcribe.js
//                    and describeMedia.js each carried twice.
//
// None of these throw: they return a result object (or null) and the caller keeps
// its own degrade path. Budgets (R4): `senses` is chat input — never blocked, only
// metered (one notice an hour when over); every other label (`bill`, `image`,
// `voice`, …) over budget writes a `budget` row and returns without a call.
// Callers keep their own model vars (TRANSCRIPTION_MODEL, IG_DESCRIBE_MODEL,
// BILL_SPLIT_MODEL, IMAGE_GEN_*): multimodal inline requests are not role calls.

import { getProviderKey } from '../utils/config.js';
import { logger, scrubSecrets } from '../utils/logger.js';
import { recordUsage, budgetState } from './usage.js';

export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Labels that are chat input: degrade-never-block (R4 "floor").
const FLOOR_LABELS = new Set(['senses']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const noticeAt = new Map();
function noticeOncePer(key, ms) {
  const t = Date.now();
  if (t - (noticeAt.get(key) || 0) < ms) return false;
  noticeAt.set(key, t);
  return true;
}

/**
 * Native Gemini usage → ledger shape. promptTokenCount includes cached tokens;
 * thinking tokens are billed as output. Absent usage → null (the price table's
 * perCall applies, or the call is unpriced).
 */
export function geminiUsage(data) {
  const u = data?.usageMetadata;
  if (!u || typeof u !== 'object') return null;
  const prompt = num(u.promptTokenCount);
  const cached = num(u.cachedContentTokenCount);
  const cand = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  return {
    input: prompt === null ? null : Math.max(0, prompt - (cached || 0)),
    output: cand === null && thoughts === null ? null : (cand || 0) + (thoughts || 0),
    cacheRead: cached,
    cacheWrite: null,
  };
}

/** OpenRouter (OpenAI-compatible) usage → ledger shape + its own reported cost. */
function openrouterUsage(data) {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return { usage: null, providerCost: null };
  const prompt = num(u.prompt_tokens);
  const cacheRead = num(u.prompt_tokens_details?.cached_tokens);
  const cost = u.cost;
  return {
    usage: {
      input: prompt === null ? null : Math.max(0, prompt - (cacheRead || 0)),
      output: num(u.completion_tokens),
      cacheRead,
      cacheWrite: null,
    },
    providerCost: typeof cost === 'number' || typeof cost === 'string' ? cost : null,
  };
}

/**
 * Budget gate for one label. → true when the call may run. A refused call writes a
 * `budget` row (zero tokens) so the Usage page shows the degradation.
 */
export function budgetAllows(label, { provider, model, caller }) {
  const state = budgetState(label);
  if (state.allowed) return true;
  const detail = { label, reason: state.reason, spentUsd: state.spentUsd, budgetUsd: state.budgetUsd, globalSpentUsd: state.globalSpentUsd, globalBudgetUsd: state.globalBudgetUsd };
  if (FLOOR_LABELS.has(label)) {
    if (noticeOncePer(`floor:${label}`, 3_600_000)) {
      logger.warn({ evt: 'budget_degraded', ...detail }, `${label} over budget — still running (chat input is never blocked)`);
    }
    return true;
  }
  if (noticeOncePer(`skip:${label}`, 3_600_000)) {
    logger.warn({ evt: 'budget_skip', ...detail }, `${label} over budget — skipped until next month`);
  }
  recordUsage({ role: label, provider, model, caller, usage: {}, ok: false, status: 'budget', latencyMs: 0 });
  return false;
}

/**
 * One native Gemini POST. Never throws.
 *   { label, caller, model, url?, method = 'generateContent', body, timeoutMs, fellBack, record = true }
 *   url defaults to `${GEMINI_API_URL}/${model}:${method}`; pass it for other Gemini
 *   endpoints (the Interactions API). record:false lets a caller with its own retry
 *   policy write the row itself (see recordGeminiUsage).
 * → { ok, data, status, error, latencyMs, usage, skipped? }
 *   status: 'ok' | 'http_<code>' | 'timeout' | 'error' | 'no_key' | 'budget'
 */
export async function geminiPost({ label, caller, model, url, method = 'generateContent', body, timeoutMs = 0, fellBack = false, record = true }) {
  const row = { role: label, provider: 'gemini', model, caller, fellBack };
  const apiKey = getProviderKey('gemini');
  if (!apiKey) {
    if (noticeOncePer(`nokey:${caller}`, 600_000)) logger.warn({ label, caller, model }, 'No GEMINI_API_KEY — Gemini call skipped');
    return { ok: false, data: null, status: 'no_key', error: 'no GEMINI_API_KEY', latencyMs: 0, usage: null, skipped: 'no_key' };
  }
  if (!budgetAllows(label, { provider: 'gemini', model, caller })) {
    return { ok: false, data: null, status: 'budget', error: `${label} over budget`, latencyMs: 0, usage: null, skipped: 'budget' };
  }

  const started = Date.now();
  const done = (fields) => {
    const out = { latencyMs: Date.now() - started, usage: null, ...fields };
    if (record) {
      recordUsage({ ...row, usage: out.usage || {}, latencyMs: out.latencyMs, ok: out.ok, status: out.status });
    }
    return out;
  };

  try {
    const res = await fetch(url || `${GEMINI_API_URL}/${model}:${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) {
      const errBody = scrubSecrets(await res.text().catch(() => ''));
      logger.warn({ label, caller, status: res.status, errBody: errBody.slice(0, 300), model }, 'Gemini API error');
      return done({ ok: false, data: null, status: `http_${res.status}`, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}` });
    }
    const data = await res.json();
    return done({ ok: true, data, status: 'ok', error: null, usage: geminiUsage(data) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const message = scrubSecrets(err?.message || String(err));
    logger.warn({ label, caller, err: message, model }, 'Gemini call failed');
    return done({ ok: false, data: null, status: timedOut ? 'timeout' : 'error', error: message });
  }
}

/** Write the ledger row for a geminiPost made with record:false (e.g. one row per successful attempt). */
export function recordGeminiUsage({ label, caller, model, result, fellBack = false }) {
  return recordUsage({
    role: label, provider: 'gemini', model, caller, fellBack,
    usage: result?.usage || {}, latencyMs: result?.latencyMs ?? null, ok: !!result?.ok, status: result?.status || 'error',
  });
}

/** Text of a generateContent response (thought parts excluded), trimmed; '' when none. */
export function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => !p?.thought && typeof p?.text === 'string').map((p) => p.text).join('').trim();
}

/**
 * generateContent → { ok, text, data, status, error, usage, skipped? }. Never throws.
 *   { label, caller, model, parts, systemInstruction?, generationConfig?, role?, timeoutMs }
 */
export async function geminiGenerate({ label, caller, model, parts, systemInstruction, generationConfig, role, timeoutMs = 0 }) {
  const content = role ? { role, parts } : { parts };
  const body = { contents: [content] };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (generationConfig) body.generationConfig = generationConfig;
  const r = await geminiPost({ label, caller, model, body, timeoutMs });
  return { ...r, text: r.ok ? geminiText(r.data) : '' };
}

async function viaOpenRouter({ label, caller, model, prompt, base64, mime, timeoutMs }) {
  const key = getProviderKey('openrouter');
  if (!budgetAllows(label, { provider: 'openrouter', model, caller })) return null;
  const started = Date.now();
  const record = (fields) => recordUsage({
    role: label, provider: 'openrouter', model, caller, fellBack: false, latencyMs: Date.now() - started, ...fields,
  });
  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        }],
        usage: { include: true }, // OpenRouter's own cost in usage.cost
      }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) {
      const errBody = scrubSecrets(await res.text().catch(() => ''));
      logger.warn({ label, caller, status: res.status, errBody: errBody.slice(0, 300), model }, 'OpenRouter media call error');
      record({ usage: {}, ok: false, status: `http_${res.status}` });
      return null;
    }
    const data = await res.json();
    const { usage, providerCost } = openrouterUsage(data);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      logger.warn({ label, caller, model, data: scrubSecrets(JSON.stringify(data)).slice(0, 300) }, 'OpenRouter returned empty media response');
      record({ usage: usage || {}, providerCost, ok: false, status: 'empty' });
      return null;
    }
    record({ usage: usage || {}, providerCost, ok: true, status: 'ok' });
    return { text, provider: 'openrouter', model };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    logger.warn({ label, caller, err: scrubSecrets(err?.message || String(err)), model }, 'OpenRouter media call failed');
    record({ usage: {}, ok: false, status: timedOut ? 'timeout' : 'error' });
    return null;
  }
}

async function viaGemini({ label, caller, model, prompt, base64, mime, timeoutMs }) {
  const r = await geminiGenerate({
    label, caller, model, timeoutMs,
    parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }],
  });
  if (!r.ok) return null;
  if (!r.text) {
    logger.warn({ label, caller, model, data: scrubSecrets(JSON.stringify(r.data)).slice(0, 300) }, 'Gemini returned empty media response');
    return null;
  }
  return { text: r.text, provider: 'gemini', model };
}

/**
 * Describe (or transcribe) one inline media item.
 *   { label = 'senses', model, prompt, data: Buffer|base64 string, mime, caller, timeoutMs = 0 }
 * Routing by the model id's shape, each provider with its own key only (R7): a
 * `vendor/model` id (OpenRouter's catalogue) goes to OpenRouter, a bare id
 * (`gemini-3-flash-preview`, Google's) to native Gemini. With only one key set,
 * that provider takes either shape (a `google/` prefix is dropped for native
 * Gemini). → { text, provider, model } | null
 */
export async function describeInline({ label = 'senses', model, prompt, data, mime, caller, timeoutMs = 0 }) {
  const base64 = Buffer.isBuffer(data) ? data.toString('base64') : String(data || '');
  const args = { label, caller, model, prompt, base64, mime, timeoutMs };
  const hasOpenRouter = !!getProviderKey('openrouter');
  const hasGemini = !!getProviderKey('gemini');
  const vendorId = String(model || '').includes('/');
  if (hasOpenRouter && (vendorId || !hasGemini)) return viaOpenRouter(args);
  if (hasGemini) return viaGemini({ ...args, model: String(model || '').replace(/^google\//, '') });
  if (noticeOncePer(`nokey:${caller}`, 600_000)) {
    logger.warn({ caller }, 'No OPENROUTER_API_KEY or GEMINI_API_KEY — media not described');
  }
  return null;
}
