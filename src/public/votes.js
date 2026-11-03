// Public site (spec 013): pull audience tallies from the votes Worker. Outbound
// only (the home server is never reachable). Settings from process.env at use:
//
//   PUBLIC_VOTES_URL         https://<worker host>   (the Worker's base URL)
//   PUBLIC_VOTES_READ_TOKEN  bearer token for GET /api/tally (read-only)
//
// → { ok, tallies: { <public decision id>: { <option id>: count } } } | { ok: false, reason }.
// The exporter accepts only ids it published itself, with their own option ids.

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const ID_RE = /^d_[0-9a-f]{10}$/;

/** The body as text, or null past `max` bytes (stops reading there; content-length may lie). */
async function readBounded(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export function votesConfig(env = process.env) {
  const base = String(env.PUBLIC_VOTES_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.PUBLIC_VOTES_READ_TOKEN || '').trim();
  if (!base && !token) return { ok: false, reason: 'not_configured' };
  let url;
  try { url = new URL(base); } catch { return { ok: false, reason: 'bad_url' }; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) return { ok: false, reason: 'bad_url' };
  if (token.length < 24) return { ok: false, reason: 'no_token' };
  return { ok: true, base: url.origin, token };
}

export async function pullTallies(ids, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = votesConfig(env);
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  const want = (ids || []).filter((x) => ID_RE.test(x)).slice(0, 10);
  if (!want.length) return { ok: true, tallies: {} };
  try {
    const res = await fetchImpl(`${cfg.base}/api/tally?ids=${want.join(',')}`, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http:${res.status}` };
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return { ok: false, reason: 'too_large' };
    const text = await readBounded(res, MAX_BYTES);
    if (text === null) return { ok: false, reason: 'too_large' };
    const body = JSON.parse(text);
    const tallies = {};
    for (const id of want) {
      const t = body?.tallies?.[id];
      if (t && typeof t === 'object' && !Array.isArray(t)) tallies[id] = t;
    }
    return { ok: true, tallies };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : err?.name === 'SyntaxError' ? 'bad_json' : 'network' };
  }
}
