import crypto from 'crypto';
import { issueCsrfCookie } from '../middleware/csrf.js';

const COOKIE_NAME = 'dash_session';
const THIRTY_DAYS = 30 * 24 * 60 * 60;

export default async function loginRoutes(app) {
  app.route({
    method: 'POST',
    url: '/api/login',
    config: { rateLimit: { max: 20, timeWindow: '1 minute', allowList: [] } },
    preValidation: app.basicAuth,
    handler: async (req, reply) => {
      const nonce = crypto.randomBytes(16).toString('hex');
      reply.setCookie(COOKIE_NAME, nonce, {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
        maxAge: THIRTY_DAYS,
        signed: true,
      });
      issueCsrfCookie(reply);
      return { ok: true };
    },
  });

  app.route({
    method: 'POST',
    url: '/api/logout',
    handler: async (req, reply) => {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      reply.clearCookie('csrf_token', { path: '/' });
      return { ok: true };
    },
  });
}
