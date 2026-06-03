import { config } from '../../utils/config.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Session management is not a "write" in the data sense — it only mutates
// the client's own cookie, not bot state. Always allowed.
const AUTH_ENDPOINTS = new Set(['/api/login', '/api/logout']);

export function readOnlyGuard(req, reply, done) {
  if (AUTH_ENDPOINTS.has(req.url.split('?')[0])) return done();
  if (config.dashboard.readOnly && WRITE_METHODS.has(req.method)) {
    reply.code(403).send({ error: 'DASHBOARD_READONLY=true' });
    return;
  }
  done();
}
