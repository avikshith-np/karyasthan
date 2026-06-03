import { logger } from '../../utils/logger.js';

export function errorHandler(err, req, reply) {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    logger.error({ err, path: req.url, method: req.method }, 'Dashboard route error');
  } else {
    logger.debug({ err: err.message, path: req.url, method: req.method }, 'Dashboard route 4xx');
  }
  reply.code(status).send({ error: err.message || 'Internal error' });
}
