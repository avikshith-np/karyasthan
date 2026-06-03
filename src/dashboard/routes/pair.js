import { spawn } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { auditWrite } from '../audit.js';

// Single active job slot. Re-pairing must be exclusive — two pair.js processes
// would fight over data/auth_info_baileys.
let activeJob = null;

function broadcast(job, event, data) {
  for (const sub of job.subscribers) {
    try { sub({ event, data }); } catch {}
  }
}

function record(job, event, data) {
  const entry = { event, data, ts: Date.now() };
  job.buffer.push(entry);
  if (job.buffer.length > 500) job.buffer.shift();
  broadcast(job, event, data);
}

function sockConnected(getSock) {
  const sock = getSock?.();
  return !!(sock && sock.user);
}

export default async function pairRoutes(app, opts) {
  const { getSock } = opts || {};

  app.post('/api/pair/start', async (req, reply) => {
    if (sockConnected(getSock)) {
      reply.code(409).send({
        error: 'Bot is currently connected to WhatsApp. Pairing requires a disconnected state — unlink this device from your phone first, then retry.',
      });
      return;
    }
    if (activeJob && !activeJob.done) {
      reply.code(409).send({ error: 'A pairing job is already running', id: activeJob.id });
      return;
    }

    const body = req.body || {};
    const phoneRaw = body.phone || config.phoneNumber;
    const phone = String(phoneRaw || '').replace(/\D/g, '');
    if (!phone || phone.length < 8) {
      reply.code(400).send({ error: 'phone is required (digits only, with country code — e.g. 919876543210)' });
      return;
    }

    const id = crypto.randomBytes(6).toString('hex');
    const proc = spawn('node', ['scripts/pair.js', phone], {
      cwd: config.projectRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const job = {
      id,
      phone,
      startedAt: Date.now(),
      proc,
      buffer: [],
      subscribers: new Set(),
      done: false,
      pairingCode: null,
    };
    activeJob = job;

    logger.info({ jobId: id, phone, pid: proc.pid }, 'Pair job started');
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'pair.start', id, { phone });

    const handleLine = (stream) => (chunk) => {
      const text = chunk.toString('utf-8');
      for (const raw of text.split('\n')) {
        if (!raw.length && text.endsWith('\n')) continue;
        record(job, 'line', { stream, text: raw });
        const m = raw.match(/PAIRING CODE:\s*([A-Z0-9-]+)/i);
        if (m) {
          job.pairingCode = m[1];
          record(job, 'code', { code: m[1] });
        }
        if (/PAIRED SUCCESSFULLY/i.test(raw)) {
          record(job, 'paired', {});
        }
      }
    };

    proc.stdout.on('data', handleLine('stdout'));
    proc.stderr.on('data', handleLine('stderr'));
    proc.on('exit', (code, signal) => {
      job.done = true;
      record(job, 'exit', { code, signal });
      logger.info({ jobId: id, code, signal }, 'Pair job exited');
    });
    proc.on('error', (err) => {
      record(job, 'error', { message: err.message });
      logger.warn({ jobId: id, err: err.message }, 'Pair job spawn error');
    });

    return { id, pid: proc.pid, phone };
  });

  app.get('/api/pair/status', async () => {
    if (!activeJob) return { active: false };
    return {
      active: true,
      id: activeJob.id,
      phone: activeJob.phone,
      startedAt: activeJob.startedAt,
      done: activeJob.done,
      pairingCode: activeJob.pairingCode,
      lines: activeJob.buffer.length,
    };
  });

  app.get('/api/pair/:id/stream', async (req, reply) => {
    const id = req.params.id;
    if (!activeJob || activeJob.id !== id) {
      reply.code(404).send({ error: 'job not found' });
      return;
    }
    const job = activeJob;

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const write = ({ event, data }) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    // Replay buffered events
    for (const entry of job.buffer) write(entry);
    if (job.done) write({ event: 'closed', data: {} });

    job.subscribers.add(write);
    const keepalive = setInterval(() => {
      try { reply.raw.write(':keepalive\n\n'); } catch {}
    }, 15000);

    req.raw.on('close', () => {
      job.subscribers.delete(write);
      clearInterval(keepalive);
    });
  });

  app.post('/api/pair/:id/stop', async (req, reply) => {
    const id = req.params.id;
    if (!activeJob || activeJob.id !== id) {
      reply.code(404).send({ error: 'job not found' });
      return;
    }
    if (activeJob.done) return { ok: true, alreadyDone: true };
    try { activeJob.proc.kill('SIGTERM'); } catch {}
    auditWrite(req.basicAuthUser?.username || config.dashboard.user, 'pair.stop', id, {});
    return { ok: true };
  });
}
