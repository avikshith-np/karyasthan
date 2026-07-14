import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { basicAuthValidator, cidrGate, checkSessionCookie } from './auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { readOnlyGuard } from './middleware/readOnlyGuard.js';

import statusRoutes from './routes/status.js';
import groupsRoutes from './routes/groups.js';
import peopleRoutes from './routes/people.js';
import messagesRoutes from './routes/messages.js';
import memoriesRoutes from './routes/memories.js';
import decisionsRoutes from './routes/decisions.js';
import billsRoutes from './routes/bills.js';
import streamRoutes from './routes/stream.js';
import loginRoutes from './routes/login.js';
import configRoutes from './routes/config.js';
import llmRoutes from './routes/llm.js';
import identityRoutes from './routes/identity.js';
import skillsRoutes from './routes/skills.js';
import maintenanceRoutes from './routes/maintenance.js';
import auditRoutes from './routes/audit.js';
import pairRoutes from './routes/pair.js';
import { csrfGuard } from './middleware/csrf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(__dirname, 'public');

export async function startDashboard({ getSock }) {
  if (!config.dashboard.enabled) {
    logger.info('Dashboard disabled (DASHBOARD_ENABLED=false)');
    return null;
  }

  if (!config.dashboard.user || !config.dashboard.passHash) {
    logger.warn('Dashboard enabled but DASHBOARD_USER / DASHBOARD_PASS_HASH not set — refusing to start');
    return null;
  }

  const app = Fastify({ logger: false, trustProxy: true });

  app.setErrorHandler(errorHandler);

  await app.register(fastifyCookie, {
    secret: config.dashboard.cookieSecret || config.dashboard.passHash,
  });

  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: config.dashboard.allowCidrs.some(c => c.startsWith('127.')) ? ['127.0.0.1'] : [],
  });

  app.addHook('onRequest', cidrGate);

  await app.register(fastifyBasicAuth, {
    validate: basicAuthValidator,
    authenticate: { realm: `${getPersona().name} Dashboard` },
  });

  app.addHook('onRequest', (req, reply, done) => {
    // /api/login applies basic-auth itself (as preValidation) so the route-
    // level rate-limit can count brute-force attempts before auth rejects them.
    if (req.url.split('?')[0] === '/api/login') return done();
    if (checkSessionCookie(req)) return done();
    return app.basicAuth(req, reply, done);
  });
  app.addHook('preHandler', readOnlyGuard);
  app.addHook('preHandler', csrfGuard);

  await app.register(FastifySSEPlugin);

  await app.register(statusRoutes, { getSock });
  await app.register(groupsRoutes, { getSock });
  await app.register(peopleRoutes);
  await app.register(messagesRoutes);
  await app.register(memoriesRoutes);
  await app.register(decisionsRoutes);
  await app.register(billsRoutes);
  await app.register(streamRoutes);
  await app.register(loginRoutes);
  await app.register(configRoutes);
  await app.register(llmRoutes);
  await app.register(identityRoutes);
  await app.register(skillsRoutes);
  await app.register(maintenanceRoutes);
  await app.register(auditRoutes);
  await app.register(pairRoutes, { getSock });

  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: '/',
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.sendFile('index.html');
  });

  try {
    await app.listen({ host: config.dashboard.host, port: config.dashboard.port });
    logger.info({
      host: config.dashboard.host,
      port: config.dashboard.port,
      readOnly: config.dashboard.readOnly,
    }, 'Dashboard listening');
  } catch (err) {
    logger.error({ err }, 'Dashboard failed to start');
    return null;
  }

  return app;
}
