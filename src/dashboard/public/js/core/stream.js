// One shared EventSource per tab (spec 007 R12). Pages subscribe to topics; the
// connection carries the union of live subscriptions and is reopened (debounced)
// when that set changes. With no subscriptions there is no connection at all.
//
// Resumable topics (logs) carry `id: <topic>:<seq>`: the mux remembers the last
// id per topic and passes it as ?since= when it opens a new connection, so a
// topic change does not replay lines the page already has. (On the browser's own
// auto-reconnect the Last-Event-ID header does the same.)
//
// A non-200 reply (429 too many streams, 5xx during a restart) ends an EventSource
// for good — the browser only auto-reconnects a stream that was open. When the
// connection ends CLOSED after an error, the mux reopens it itself with backoff
// (1 s, 2 s, 5 s, 10 s, 30 s cap), reset once a connection opens.
//
// createMux takes the EventSource constructor so it runs in node with a fake
// (scripts/test-dashboard.js). Nothing touches `window` at import time.

export const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

export function createMux(EventSourceCtor, { base = '/api/stream', debounceMs = 250, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const handlers = new Map(); // topic → Set<fn>
  const stateFns = new Set(); // fn(state) — 'idle' | 'connecting' | 'open' | 'error'
  const lastIds = {}; // topic → 'topic:seq'
  let es = null;
  let esKey = '';
  let esListeners = [];
  let timer = null;
  let state = 'idle';
  let closed = false;
  let force = false; // reconnect even if the topic set is unchanged (fresh backlog wanted)
  let retryTimer = null;
  let retries = 0;

  const setState = (s) => {
    if (s === state) return;
    state = s;
    for (const fn of [...stateFns]) { try { fn(s); } catch {} }
  };

  const topicsWanted = () => [...handlers.keys()].filter((t) => handlers.get(t).size).sort();

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function teardown() {
    clearRetry();
    if (!es) return;
    for (const [evt, fn] of esListeners) { try { es.removeEventListener(evt, fn); } catch {} }
    esListeners = [];
    try { es.close(); } catch {}
    es = null;
    esKey = '';
  }

  function dispatch(topic, e) {
    if (e?.lastEventId && String(e.lastEventId).startsWith(topic + ':')) lastIds[topic] = String(e.lastEventId);
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const set = handlers.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      if (!set.has(fn)) continue; // unsubscribed by an earlier handler in this loop
      try { fn(data, e); } catch (err) { console.error('stream handler', topic, err); }
    }
  }

  function sync() {
    timer = null;
    if (closed) return;
    const topics = topicsWanted();
    const key = topics.join(',');
    if (key === esKey && es && !force) return;
    force = false;
    teardown();
    if (!topics.length) { setState('idle'); return; }
    const since = topics.map((t) => lastIds[t]).filter(Boolean);
    const url = `${base}?topics=${topics.join(',')}${since.length ? `&since=${encodeURIComponent(since.join(','))}` : ''}`;
    setState('connecting');
    es = new EventSourceCtor(url);
    esKey = key;
    const on = (evt, fn) => { es.addEventListener(evt, fn); esListeners.push([evt, fn]); };
    const mine = es;
    on('open', () => { retries = 0; setState('open'); });
    on('error', () => {
      setState('error');
      // readyState 0 = the browser is already reconnecting; 2 = CLOSED, it won't.
      if (closed || es !== mine || mine.readyState !== 2 || retryTimer) return;
      const delay = retryDelaysMs[Math.min(retries, retryDelaysMs.length - 1)];
      retries++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (closed || es !== mine) return;
        force = true;
        sync();
      }, delay);
    });
    for (const t of topics) on(t, (e) => dispatch(t, e));
  }

  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(sync, debounceMs);
  }

  return {
    /**
     * Subscribe fn(data, event) to a topic. Returns an idempotent unsubscribe.
     * { resume: false } forgets the topic's last id, so the next connection gets
     * the full backlog again (a page mounting fresh wants the tail; it dedupes
     * by id itself).
     */
    subscribe(topic, fn, { resume = true } = {}) {
      if (!resume) { delete lastIds[topic]; force = true; }
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      const set = handlers.get(topic);
      // Wrap so the same fn can be subscribed twice and removed independently.
      const h = (d, e) => fn(d, e);
      set.add(h);
      schedule();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set.delete(h);
        if (!set.size) handlers.delete(topic);
        schedule();
      };
    },
    /** Watch the connection state. Returns an unsubscribe. */
    onState(fn) {
      stateFns.add(fn);
      try { fn(state); } catch {}
      return () => stateFns.delete(fn);
    },
    state: () => state,
    topics: topicsWanted,
    handlerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    openCount: () => (es ? 1 : 0),
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearRetry();
      handlers.clear();
      teardown();
      setState('idle');
    },
  };
}

let shared = null;

/** The tab's shared mux (created on first use; browser only). */
export function stream() {
  if (!shared) {
    if (typeof EventSource === 'undefined') throw new Error('EventSource not available');
    shared = createMux(EventSource);
  }
  return shared;
}
