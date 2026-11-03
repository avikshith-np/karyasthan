// Public site (spec 013): upload to Cloudflare R2 over its S3 API with a
// hand-written AWS SigV4 signature (no SDK). Credentials come from process.env
// at call time only — never config, never logged, never on the dashboard:
//
//   R2_ENDPOINT           https://<account id>.r2.cloudflarestorage.com
//   R2_BUCKET             bucket name
//   R2_ACCESS_KEY_ID      token key id   (a token scoped to that one bucket)
//   R2_SECRET_ACCESS_KEY  token secret
//
// The endpoint must be https on *.r2.cloudflarestorage.com (an .env typo can't
// send the snapshot or the signature anywhere else).

import crypto from 'crypto';

const REGION = 'auto';
const SERVICE = 's3';
const TIMEOUT_MS = 15_000;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** The R2 settings from the environment, or { ok: false, reason } (no secrets in the reason). */
export function r2Config(env = process.env) {
  const endpoint = String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = String(env.R2_BUCKET || '').trim();
  const keyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secret = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint && !bucket && !keyId && !secret) return { ok: false, reason: 'not_configured' };
  let url;
  try { url = new URL(endpoint); } catch { return { ok: false, reason: 'bad_endpoint' }; }
  if (url.protocol !== 'https:' || !/^[a-f0-9]{32}\.(?:[a-z]{2,8}\.)?r2\.cloudflarestorage\.com$/i.test(url.hostname) || url.pathname !== '/') {
    return { ok: false, reason: 'bad_endpoint' };
  }
  if (!BUCKET_RE.test(bucket)) return { ok: false, reason: 'bad_bucket' };
  if (!keyId || !secret) return { ok: false, reason: 'no_credentials' };
  return { ok: true, host: url.hostname, endpoint: url.origin, bucket, keyId, secret };
}

/** SigV4 headers for one request (exported for the test vectors). */
export function sign({ method, host, path, query = '', payloadHash, keyId, secret, amzDate }) {
  const date = amzDate.slice(0, 8);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, path, query, ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payloadHash].join('\n');
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${secret}`, date);
  const kSigning = hmac(hmac(hmac(kDate, REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
  };
}

function amzNow(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * PUT one object. → { ok: true, status } | { ok: false, reason, status? }.
 * Never throws; never includes the body, the URL's credentials or the signature in the result.
 */
export async function putObject(key, body, { contentType = 'application/json', cacheControl = 'public, max-age=60', env = process.env, fetchImpl = fetch } = {}) {
  const cfg = r2Config(env);
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  if (!KEY_RE.test(key) || key.includes('..')) return { ok: false, reason: 'bad_key' };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const path = `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const headers = sign({ method: 'PUT', host: cfg.host, path, payloadHash: sha256(buf), keyId: cfg.keyId, secret: cfg.secret, amzDate: amzNow() });
  try {
    const res = await fetchImpl(`${cfg.endpoint}${path}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': contentType, 'cache-control': cacheControl, 'content-length': String(buf.length) },
      body: buf,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    try { await res.arrayBuffer(); } catch { /* drain */ }
    return res.ok ? { ok: true, status: res.status } : { ok: false, reason: 'http', status: res.status };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
