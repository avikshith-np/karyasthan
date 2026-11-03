import { Writable } from 'stream';

const RING_SIZE = 500;
const ring = [];
const subscribers = new Set();
// Monotonic SSE event id. Seeded from the clock so ids from before a restart
// are always lower than new ones — a reconnect carrying a stale Last-Event-ID
// then still gets this process's lines instead of none.
let seq = Date.now();

function push(entry) {
  entry.id = ++seq;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  for (const sub of subscribers) {
    try { sub(entry); } catch {}
  }
}

export const logSink = new Writable({
  write(chunk, _enc, cb) {
    const text = chunk.toString('utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { parsed = { msg: line }; }
      push({ raw: line, parsed });
    }
    cb();
  },
});

export function getRecentLogs(limit = 200) {
  return ring.slice(-limit);
}

// Lines newer than `afterId` (an SSE Last-Event-ID), capped to the last `limit`.
// An id from the future can only predate a restart — send the normal tail.
export function getLogsSince(afterId, limit = 200) {
  if (afterId > seq) return getRecentLogs(limit);
  return ring.filter(e => e.id > afterId).slice(-limit);
}

export function subscribeLogs(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}
