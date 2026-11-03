import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
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
import relaysRoutes from './routes/relays.js';
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
import callsRoutes from './routes/calls.js';
import instagramRoutes from './routes/instagram.js';
import usageRoutes from './routes/usage.js';
import mindRoutes from './routes/mind.js';
import lifeRoutes from './routes/life.js';
import arcsRoutes from './routes/arcs.js';
import directorRoutes from './routes/director.js';
import influenceRoutes from './routes/influence.js';
import publicSiteRoutes from './routes/publicSite.js';
import placesRoutes from './routes/places.js';   // 014 geo: Director place lookups
import reviewRoutes from './routes/review.js';   // plan 020 E4: the weekly review
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

  // trustProxy stays off: with it on, req.ip honours a client-supplied
  // X-Forwarded-For, which would let anyone spoof past the CIDR gate and the
  // rate limits on a non-loopback bind.
  const app = Fastify({ logger: false, trustProxy: false });

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

  await app.register(statusRoutes, { getSock });
  await app.register(groupsRoutes, { getSock });
  await app.register(peopleRoutes);
  await app.register(callsRoutes);
  await app.register(instagramRoutes);
  await app.register(usageRoutes);
  await app.register(messagesRoutes);
  await app.register(memoriesRoutes);
  await app.register(relaysRoutes);
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
  await app.register(mindRoutes, { getSock });
  await app.register(lifeRoutes);
  await app.register(arcsRoutes);
  await app.register(directorRoutes);
  await app.register(influenceRoutes);
  await app.register(publicSiteRoutes);
  await app.register(placesRoutes);
  await app.register(reviewRoutes);

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
