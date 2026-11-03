// One multiplexed Server-Sent-Events stream for the dashboard (spec 007 R12).
//
//   GET /api/stream?topics=logs,decisions
//
// Each topic is registered once by the route module that owns its data
// (registerTopic). A connection subscribes to the topics it asks for; every
// event is written with `event: <topic>`, and resumable topics (logs) also carry
// `id: <topic>:<seq>` so a reconnect resumes where it left off — from the
// browser's Last-Event-ID header (auto-reconnect) or a `?since=<topic>:<seq>`
// query (a new EventSource opened by the frontend mux, which can't set headers).
//
// The handler is a plain GET inside the Fastify app, so the global CIDR gate and
// cookie/basic-auth hooks apply unchanged; readOnlyGuard/csrfGuard only look at
// writes, and nothing here writes bot state. Every rejection (unknown topic, too
// many topics, too many open streams) is a normal JSON reply sent BEFORE the
// event-stream headers go out.

export const TOPIC_NAMES = Object.freeze(['logs', 'decisions', 'calls', 'instagram', 'usage']);
export const MAX_TOPICS = 6;
// Keyed on the TCP peer, so over an SSH tunnel / loopback every browser tab and
// phone shares one count (and a sleeping phone's half-open stream holds its slot
// until TCP gives up). R12 said 4; 16 leaves room for that while still bounding
// one peer. The frontend mux backs off and retries if it is ever hit.
export const MAX_STREAMS_PER_IP = 16;
export const KEEPALIVE_MS = 15_000;

const topics = new Map(); // name → { subscribe, snapshot?, replay?, idOf? }
const openPerIp = new Map(); // ip → open stream count

/**
 * Register (or replace — tests boot the dashboard more than once per process) a topic.
 *   subscribe(cb) → unsubscribe     live events; cb(payload)
 *   snapshot?() → payload           one event sent on connect (calls, instagram)
 *   replay?(sinceSeq|null) → [entries]   resumable backlog sent on connect (logs)
 *   idOf?(entry) → number           sequence number of a resumable entry
 */
export function registerTopic(name, def) {
  if (!TOPIC_NAMES.includes(name)) throw new Error(`sse: unknown topic "${name}"`);
  if (!def || typeof def.subscribe !== 'function') throw new Error(`sse: topic "${name}" needs subscribe()`);
  topics.set(name, def);
}

/** Open-stream count for one peer (tests / diagnostics). */
export function openStreams(ip) {
  return ip == null ? [...openPerIp.values()].reduce((a, b) => a + b, 0) : (openPerIp.get(ip) || 0);
}

// TCP peer only, never X-Forwarded-For (same rule as the CIDR gate in auth.js).
function peerIp(req) {
  const addr = req.socket?.remoteAddress || req.raw?.socket?.remoteAddress || '';
  return addr.replace(/^::ffff:/i, '') || 'unknown';
}

/** Parse `?topics=` into a deduped list, or { error }. */
export function parseTopics(raw, defaults) {
  if (raw == null || raw === '') {
    if (defaults?.length) return { list: [...defaults] };
    return { error: 'topics required' };
  }
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'topics required' };
  if (parts.length > MAX_TOPICS) return { error: `at most ${MAX_TOPICS} topics` };
  const list = [];
  for (const t of parts) {
    if (!TOPIC_NAMES.includes(t) || !topics.has(t)) return { error: `unknown topic: ${t.slice(0, 40)}` };
    if (!list.includes(t)) list.push(t);
  }
  return { list };
}

/**
 * Resume point per topic from Last-Event-ID / ?since=. Accepts `<topic>:<seq>`,
 * several comma-separated (query only), or a bare number (= logs: a tab that was
 * open across the deploy still sends the old id form).
 */
export function parseResume(header, query) {
  const out = {};
  // Query first, header last: on a browser auto-reconnect the URL still carries
  // the original ?since= while Last-Event-ID holds the newer position.
  for (const src of [query, header]) {
    if (src == null) continue;
    for (const part of String(src).split(',')) {
      const s = part.trim();
      let m = /^([a-z]{1,16}):(\d{1,16})$/.exec(s);
      if (m && TOPIC_NAMES.includes(m[1])) { out[m[1]] = Number(m[2]); continue; }
      m = /^(\d{1,16})$/.exec(s);
      if (m) out.logs = Number(m[1]);
    }
  }
  return out;
}

/** Fastify handler for /api/stream: `?topics=` is required. */
export function streamHandler() {
  return async function sseStream(req, reply) {
    const parsed = parseTopics(req.query?.topics, null);
    if (parsed.error || !parsed.list.length) {
      reply.code(400).send({ error: parsed.error || 'topic not available' });
      return reply;
    }

    const ip = peerIp(req);
    const open = openPerIp.get(ip) || 0;
    if (open >= MAX_STREAMS_PER_IP) {
      reply.code(429).send({ error: `too many open streams (max ${MAX_STREAMS_PER_IP})` });
      return reply;
    }
    openPerIp.set(ip, open + 1);

    const resume = parseResume(req.headers['last-event-id'], req.query?.since);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const write = (chunk) => {
      if (closed) return;
      try { raw.write(chunk); } catch { /* socket gone — close handler cleans up */ }
    };
    const send = (topic, data, seq) => {
      let body;
      try { body = JSON.stringify(data); } catch { return; }
      let frame = '';
      if (seq != null) frame += `id: ${topic}:${seq}\n`;
      frame += `event: ${topic}\n`;
      frame += `data: ${body}\n\n`;
      write(frame);
    };

    // Comment line first: proves the stream is open to clients and tests.
    write(':keepalive\n\n');

    const unsubs = [];
    for (const name of parsed.list) {
      const def = topics.get(name);
      try {
        if (def.replay) {
          for (const entry of def.replay(resume[name] ?? null) || []) send(name, entry, def.idOf?.(entry));
        }
        if (def.snapshot) send(name, def.snapshot());
      } catch { /* a failing snapshot must not kill the other topics */ }
      try {
        unsubs.push(def.subscribe((payload) => send(name, payload, def.idOf?.(payload))));
      } catch { /* subscribe failed — topic stays silent */ }
    }

    const keepalive = setInterval(() => write(':keepalive\n\n'), KEEPALIVE_MS);
    keepalive.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      for (const u of unsubs) { try { u?.(); } catch {} }
      const n = (openPerIp.get(ip) || 1) - 1;
      if (n > 0) openPerIp.set(ip, n); else openPerIp.delete(ip);
    };
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
    raw.on('error', cleanup);
    // A socket that died before these listeners existed has already emitted
    // 'close' — release its slot now instead of leaking it.
    if (raw.destroyed || raw.socket?.destroyed) cleanup();
  };
}
