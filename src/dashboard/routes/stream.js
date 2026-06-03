import { getRecentLogs, subscribeLogs } from '../logStream.js';
import { onDashboardEvent } from '../events.js';

function sseHeaders(reply) {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();
}

function sseWrite(reply, event, data) {
  try {
    if (event) reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

export default async function streamRoutes(app) {
  app.get('/api/stream/logs', async (req, reply) => {
    sseHeaders(reply);

    const initial = getRecentLogs(200);
    for (const entry of initial) sseWrite(reply, 'log', entry);

    const unsub = subscribeLogs((entry) => sseWrite(reply, 'log', entry));
    const keepalive = setInterval(() => {
      try { reply.raw.write(':keepalive\n\n'); } catch {}
    }, 15000);

    req.raw.on('close', () => { unsub(); clearInterval(keepalive); });
  });

  app.get('/api/stream/decisions', async (req, reply) => {
    sseHeaders(reply);

    const unsub = onDashboardEvent('decision', (payload) => sseWrite(reply, 'decision', payload));
    const keepalive = setInterval(() => {
      try { reply.raw.write(':keepalive\n\n'); } catch {}
    }, 15000);

    req.raw.on('close', () => { unsub(); clearInterval(keepalive); });
  });
}
