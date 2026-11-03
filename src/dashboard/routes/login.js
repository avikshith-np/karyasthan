import { issueCsrfCookie } from '../middleware/csrf.js';
import { SESSION_COOKIE as COOKIE_NAME, SESSION_MAX_AGE_SEC, newSessionValue } from '../auth.js';

export default async function loginRoutes(app) {
  app.route({
    method: 'POST',
    url: '/api/login',
    config: { rateLimit: { max: 20, timeWindow: '1 minute', allowList: [] } },
    preValidation: app.basicAuth,
    handler: async (req, reply) => {
      reply.setCookie(COOKIE_NAME, newSessionValue(), {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
        maxAge: SESSION_MAX_AGE_SEC,
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
