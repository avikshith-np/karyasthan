import crypto from 'crypto';
import { config } from '../../utils/config.js';

const COOKIE_NAME = 'csrf_token';
const HEADER_NAME = 'x-csrf-token';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Session-management endpoints bootstrap the CSRF cookie itself, so they
// don't require a token on the incoming request.
const EXEMPT_PATHS = new Set(['/api/login', '/api/logout']);

export function issueCsrfCookie(reply) {
  const token = crypto.randomBytes(24).toString('hex');
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: false,        // must be readable by JS to set the header
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return token;
}

export function csrfGuard(req, reply, done) {
  if (!WRITE_METHODS.has(req.method)) return done();
  const path = req.url.split('?')[0];
  if (EXEMPT_PATHS.has(path)) return done();
  // When read-only is active, readOnlyGuard will 403 before we reach here.
  // (CSRF still runs for the handful of readOnly-exempt writes, like login.)
  if (config.dashboard.readOnly) return done();

  const header = req.headers[HEADER_NAME];
  const cookie = req.cookies?.[COOKIE_NAME];
  if (!header || !cookie || header !== cookie) {
    reply.code(403).send({ error: 'CSRF token missing or mismatched' });
    return;
  }
  done();
}
