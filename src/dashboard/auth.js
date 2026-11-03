import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

function ipInCidr(ip, cidr) {
  if (!cidr) return false;
  if (cidr === ip) return true;

  const [range, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw, 10);

  if (range.includes(':') || ip.includes(':')) {
    // IPv6: only exact-match /128 or equivalent loopback for v1
    if (ip === range && (Number.isNaN(bits) || bits === 128)) return true;
    return false;
  }

  const ipNum = ipToInt(ip);
  const rangeNum = ipToInt(range);
  if (ipNum === null || rangeNum === null) return false;

  const prefix = Number.isNaN(bits) ? 32 : bits;
  // Out-of-range prefixes would wrap the shift (e.g. /33 → /1, admitting half the space).
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToInt(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// The TCP peer only — never req.ip / X-Forwarded-For, which a client controls.
// IPv4-mapped IPv6 (::ffff:1.2.3.4 on a dual-stack bind) is reduced to plain v4.
function clientIp(req) {
  const addr = req.socket?.remoteAddress || req.raw?.socket?.remoteAddress || '';
  return addr.replace(/^::ffff:/i, '');
}

export function cidrGate(req, reply, done) {
  const cidrs = config.dashboard.allowCidrs;
  if (!cidrs.length) return done();
  const ip = clientIp(req);
  const ok = !!ip && cidrs.some(c => ipInCidr(ip, c));
  if (!ok) {
    logger.warn({ ip, path: req.url }, 'Dashboard CIDR gate blocked request');
    reply.code(403).send({ error: 'Forbidden' });
    return;
  }
  done();
}

// Session cookie (signed): `<issuedAtSec>.<nonce>`. The 30-day lifetime is checked
// here too, not only by the browser's maxAge, so a copied cookie stops working.
// A cookie without an issue time (pre-fix format) is refused → one re-login.
export const SESSION_COOKIE = 'dash_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export function newSessionValue(nowSec = Math.floor(Date.now() / 1000)) {
  return `${nowSec}.${crypto.randomBytes(16).toString('hex')}`;
}

export function checkSessionCookie(req) {
  try {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (!raw) return false;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned?.valid) return false;
    const m = /^(\d{1,12})\.[0-9a-f]{32}$/.exec(unsigned.value || '');
    if (!m) return false;
    const age = Math.floor(Date.now() / 1000) - Number(m[1]);
    return age >= -300 && age <= SESSION_MAX_AGE_SEC;
  } catch {
    return false;
  }
}

// The audit actor of a dashboard write. One login exists (basic-auth or its session
// cookie), so it is always the configured user.
export const actorOf = (_req) => config.dashboard.user;

// Basic-auth failure throttle, per TCP peer. It lives in the validator because
// @fastify/rate-limit's hook runs per route AFTER the app-level auth hook, so a
// bad-auth request to any route but /api/login is rejected before the limiter
// ever counts it. Checked before bcrypt.compare (also caps the CPU cost); no
// loopback exemption; a success clears the peer's count.
const AUTH_FAIL_MAX = 20;
const AUTH_FAIL_WINDOW_MS = 60_000;
const authFailures = new Map(); // ip → { count, resetAt } (attempts not yet cleared by a success)

function authThrottled(ip, now) {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_MAX;
}

function recordAuthFailure(ip, now) {
  const entry = authFailures.get(ip);
  if (entry && now < entry.resetAt) {
    entry.count++;
    return;
  }
  // Prune expired peers so the map can't grow without bound.
  if (authFailures.size >= 1000) {
    for (const [k, v] of authFailures) if (now >= v.resetAt) authFailures.delete(k);
  }
  authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
}

export async function basicAuthValidator(username, password, req) {
  const expectedUser = config.dashboard.user;
  const expectedHash = config.dashboard.passHash;
  if (!expectedUser || !expectedHash) {
    throw new Error('Dashboard auth not configured (set DASHBOARD_USER + DASHBOARD_PASS_HASH)');
  }
  // No peer address → one shared bucket (fail closed rather than unthrottled).
  const ip = (req && clientIp(req)) || 'unknown';
  const now = Date.now();
  if (authThrottled(ip, now)) {
    logger.warn({ ip, path: req?.url }, 'Dashboard basic-auth throttled — too many failures');
    throw Object.assign(new Error('Too many failed logins — try again later'), { statusCode: 429 });
  }
  // Counted up front (and cleared on success) so a parallel burst can't slip
  // past the check while its bcrypt calls are still running.
  recordAuthFailure(ip, now);
  if (username !== expectedUser) {
    throw new Error('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, expectedHash);
  if (!ok) throw new Error('Invalid credentials');
  authFailures.delete(ip);
}
