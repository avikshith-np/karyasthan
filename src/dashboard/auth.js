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
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToInt(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export function cidrGate(req, reply, done) {
  const cidrs = config.dashboard.allowCidrs;
  if (!cidrs.length) return done();
  const ip = clientIp(req).replace(/^::ffff:/, '');
  const ok = cidrs.some(c => ipInCidr(ip, c));
  if (!ok) {
    logger.warn({ ip, path: req.url }, 'Dashboard CIDR gate blocked request');
    reply.code(403).send({ error: 'Forbidden' });
    return;
  }
  done();
}

export function checkSessionCookie(req) {
  try {
    const raw = req.cookies?.dash_session;
    if (!raw) return false;
    const unsigned = req.unsignCookie(raw);
    return !!unsigned?.valid;
  } catch {
    return false;
  }
}

export async function basicAuthValidator(username, password) {
  const expectedUser = config.dashboard.user;
  const expectedHash = config.dashboard.passHash;
  if (!expectedUser || !expectedHash) {
    throw new Error('Dashboard auth not configured (set DASHBOARD_USER + DASHBOARD_PASS_HASH)');
  }
  if (username !== expectedUser) {
    throw new Error('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, expectedHash);
  if (!ok) throw new Error('Invalid credentials');
}
