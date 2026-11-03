// One small call to prove a key and a model work together. Sent to that provider only,
// through a fixed address; the key is never logged, printed or sent anywhere else.
const CHAT_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
};

/** Pure: status + body → what went wrong, in the terms we explain to a person. */
export function classifyFailure(status, body = '') {
  const b = String(body).toLowerCase();
  if (status === 401 || status === 403 || /api[_ ]key[_ ](invalid|not valid)|invalid[_ ]api[_ ]key|incorrect api key/.test(b)) return 'bad_key';
  if (status === 402 || /insufficient|credit balance|no credit|exceeded your current quota|billing/.test(b)) return 'no_credit';
  if (status === 404 || /model.*(not found|does not exist|not supported|invalid)|(unknown|invalid) model/.test(b)) return 'no_model';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'refused';
}

const WORDS = {
  bad_key: (p) => `${p} refused this key. Check it and try again.`,
  no_credit: (p) => `The key is real, but the ${p} account has no credit. Add some, or pick another provider.`,
  no_model: (p) => `${p} doesn't know this model, or this key can't use it.`,
  rate: (p) => `${p} says too many requests right now. The key looks fine.`,
  server: (p) => `${p} had a problem on its side. The key isn't proven bad.`,
  network: (p) => `Couldn't reach ${p}. The key isn't proven bad.`,
  refused: (p) => `${p} refused the call.`,
};
export const failureWords = (why, providerLabel) => (WORDS[why] || WORDS.refused)(providerLabel);
/** Not a verdict on the key, so it's kept and marked untested. */
export const isInconclusive = (why) => why === 'network' || why === 'server' || why === 'rate';

/** Tests only: KARYASTHAN_TEST_PROBE=ok,bad_key,... answers in order, last one repeats. */
let stubIndex = 0;
function stubbed() {
  const list = String(process.env.KARYASTHAN_TEST_PROBE || '').split(',').filter(Boolean);
  if (!list.length) return null;
  const v = list[Math.min(stubIndex, list.length - 1)];
  stubIndex += 1;
  return v === 'ok' ? { ok: true, ms: 1 } : { ok: false, why: v };
}

export async function testModel({ provider, model, key = '', baseUrl = '', fetchFn = fetch, timeoutMs = 25000 }) {
  const s = stubbed();
  if (s) return s;
  const started = Date.now();
  const messages = [{ role: 'user', content: 'Reply with the word ok.' }];
  let url; let headers; let body;
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = { model, max_tokens: 16, messages };
  } else if (provider === 'ollama') {
    url = 'http://127.0.0.1:11434/api/chat';
    headers = {};
    body = { model, stream: false, messages };
  } else if (provider === 'local') {
    url = baseUrl;
    headers = key ? { Authorization: `Bearer ${key}` } : {};
    body = { model, max_tokens: 16, messages };
  } else {
    url = CHAT_URLS[provider];
    if (!url) return { ok: false, why: 'refused' };
    headers = { Authorization: `Bearer ${key}` };
    body = provider === 'xai' ? { model, max_completion_tokens: 16, messages } : { model, max_tokens: 16, messages };
  }
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, ms: Date.now() - started };
    const text = await res.text().catch(() => '');
    return { ok: false, why: classifyFailure(res.status, text), status: res.status };
  } catch {
    return { ok: false, why: 'network' };
  }
}
