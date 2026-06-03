import { Writable } from 'stream';

const RING_SIZE = 500;
const ring = [];
const subscribers = new Set();

function push(entry) {
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

export function subscribeLogs(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}
