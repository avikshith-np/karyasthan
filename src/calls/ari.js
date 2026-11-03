import { EventEmitter } from 'events';
import WebSocket from 'ws';

/**
 * Minimal Asterisk REST Interface client: REST requests plus the Stasis event
 * WebSocket, reconnecting with backoff. Events are re-emitted by their ARI `type`
 * (StasisStart, ChannelStateChange, ChannelDestroyed, …).
 */
export class AriClient extends EventEmitter {
  constructor({ url, user, password, app, logger }) {
    super();
    this.url = url;
    this.app = app;
    this.log = logger;
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.backoffMs = 2000;
  }

  async request(method, path, query = {}, body = undefined) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${this.url}/ari${path}${qs.size ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`ARI ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  connect() {
    if (this.closed) return;
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/ari/events?app=${encodeURIComponent(this.app)}&subscribeAll=false`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: this.auth } });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoffMs = 2000;
      this.log.info({ app: this.app }, 'ARI connected');
      this.emit('connected');
    });
    ws.on('message', (data) => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      try { this.emit(event.type, event); } catch (err) {
        this.log.error({ err: err.message, type: event.type }, 'ARI event handler failed');
      }
    });
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.log.warn('ARI disconnected');
      this.emit('disconnected');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      }
    });
    ws.on('error', (err) => {
      // 'close' follows and schedules the reconnect; log once per backoff step.
      if (this.backoffMs <= 4000) this.log.debug({ err: err.message }, 'ARI socket error');
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }

  // ── Convenience wrappers ──
  answer(channelId) { return this.request('POST', `/channels/${encodeURIComponent(channelId)}/answer`); }
  hangup(channelId, reason = 'normal') {
    return this.request('DELETE', `/channels/${encodeURIComponent(channelId)}`, { reason });
  }
  createBridge() { return this.request('POST', '/bridges', { type: 'mixing' }); }
  addToBridge(bridgeId, channelIds) {
    return this.request('POST', `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, { channel: channelIds.join(',') });
  }
  destroyBridge(bridgeId) { return this.request('DELETE', `/bridges/${encodeURIComponent(bridgeId)}`); }
  externalMedia({ host, format = 'slin16' }) {
    return this.request('POST', '/channels/externalMedia', {
      app: this.app, external_host: host, format, encapsulation: 'rtp', transport: 'udp', direction: 'both',
    });
  }
  originate({ endpoint, channelId, appArgs, timeout, callerId }) {
    return this.request('POST', '/channels', {
      endpoint, app: this.app, appArgs, channelId, timeout, callerId,
    });
  }
}
