import dgram from 'dgram';
import crypto from 'crypto';
import { EventEmitter } from 'events';

// Asterisk externalMedia (format slin16) sends us RTP with slin16 payloads: 16 kHz
// mono, 16-bit **big-endian** samples (RTP L16 is network byte order) on dynamic
// payload type 118.
//
// It does NOT accept slin16 back: an externalMedia channel has no SDP mapping for
// dynamic payload types, so incoming PT 118 is silently dropped (ASTERISK-28751,
// still open). Static PT 11 is accepted and read as 8 kHz slin, so the bot's voice
// goes back at 8 kHz (the normal phone band) while the caller's audio reaches Gemini
// at 16 kHz. Everything above this module uses little-endian PCM.
const TX_RATE = 8000;
const TX_PT = 11;
const FRAME_MS = 20;
const FRAME_SAMPLES = TX_RATE / 50;
const FRAME_BYTES = FRAME_SAMPLES * 2;
// Cap queued outbound audio so a runaway generator can't buffer minutes of speech.
const MAX_QUEUE_BYTES = TX_RATE * 2 * 60;

function swap16(buf) {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2));
  for (let i = 0; i < out.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return out;
}

/**
 * One call's RTP leg to Asterisk. Emits 'audio' with little-endian 16 kHz PCM for
 * every received packet. Outbound 8 kHz audio is queued with enqueue() and sent as a
 * steady 20 ms stream (silence when the queue is empty) to the address set with
 * setRemote() or learned from Asterisk's packets.
 */
export class RtpEndpoint extends EventEmitter {
  constructor(logger) {
    super();
    this.log = logger;
    this.sock = dgram.createSocket('udp4');
    this.remote = null;
    this.rxPayloadType = null;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = crypto.randomBytes(4).readUInt32BE(0);
    this.queue = [];
    this.queuedBytes = 0;
    this.timer = null;
    this.closed = false;
    this.stats = { rxPackets: 0, txPackets: 0, txSilent: 0 };
  }

  async bind(host) {
    await new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(0, host, () => { this.sock.off('error', reject); resolve(); });
    });
    this.sock.on('error', (err) => this.log.warn({ err: err.message }, 'RTP socket error'));
    this.sock.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
    return this.sock.address().port;
  }

  onPacket(msg, rinfo) {
    if (msg.length < 12 || (msg[0] >> 6) !== 2) return;
    const csrcCount = msg[0] & 0x0f;
    const hasExt = (msg[0] & 0x10) !== 0;
    let offset = 12 + csrcCount * 4;
    if (hasExt) {
      if (msg.length < offset + 4) return;
      offset += 4 + msg.readUInt16BE(offset + 2) * 4;
    }
    if (offset >= msg.length) return;
    // Follow Asterisk's actual source and payload type (symmetric RTP).
    if (!this.remote || this.remote.port !== rinfo.port || this.remote.address !== rinfo.address) {
      this.remote = { address: rinfo.address, port: rinfo.port };
    }
    this.rxPayloadType = msg[1] & 0x7f;
    if (!this.timer && !this.closed) this.startSending();
    this.stats.rxPackets++;
    this.emit('audio', swap16(msg.subarray(offset)));
  }

  /**
   * Start sending to Asterisk's RTP address (externalMedia's UNICASTRTP_LOCAL_ADDRESS/PORT)
   * right away, instead of waiting for Asterisk to send first — it may stay quiet.
   */
  setRemote(address, port) {
    if (!address || !port) return;
    this.remote = { address, port: Number(port) };
    if (!this.timer && !this.closed) this.startSending();
  }

  /** Queue little-endian 8 kHz PCM for playback toward the caller. */
  enqueue(pcm) {
    if (this.closed || !pcm.length) return;
    if (this.queuedBytes + pcm.length > MAX_QUEUE_BYTES) return;
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
  }

  /** Drop queued playback (barge-in). */
  clear() {
    this.queue = [];
    this.queuedBytes = 0;
  }

  get playing() { return this.queuedBytes > 0; }

  takeFrame() {
    if (this.queuedBytes < FRAME_BYTES) {
      // Flush a short tail padded with silence rather than holding it forever.
      if (!this.queuedBytes) return null;
      const tail = Buffer.concat(this.queue);
      this.clear();
      return Buffer.concat([tail, Buffer.alloc(FRAME_BYTES - tail.length)]);
    }
    const out = Buffer.allocUnsafe(FRAME_BYTES);
    let filled = 0;
    while (filled < FRAME_BYTES) {
      const head = this.queue[0];
      const n = Math.min(head.length, FRAME_BYTES - filled);
      head.copy(out, filled, 0, n);
      filled += n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
    this.queuedBytes -= FRAME_BYTES;
    return out;
  }

  sendFrame(pcmLe) {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80;
    header[1] = TX_PT;
    header.writeUInt16BE(this.seq, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0;
    this.sock.send(Buffer.concat([header, swap16(pcmLe)]), this.remote.port, this.remote.address);
    this.stats.txPackets++;
  }

  // Self-correcting 20 ms clock: setTimeout drifts, so each tick sends however many
  // frames are due since start, which keeps the outbound rate exact on average.
  startSending() {
    const start = performance.now();
    let sent = 0;
    const silence = Buffer.alloc(FRAME_BYTES);
    const tick = () => {
      if (this.closed) return;
      const due = Math.floor((performance.now() - start) / FRAME_MS) + 1;
      // After a long stall, skip ahead instead of bursting dozens of frames.
      if (due - sent > 10) sent = due - 1;
      while (sent < due) {
        const frame = this.takeFrame();
        if (!frame) this.stats.txSilent++;
        try { this.sendFrame(frame || silence); } catch {}
        sent++;
      }
      this.timer = setTimeout(tick, Math.max(1, start + sent * FRAME_MS - performance.now()));
    };
    tick();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.sock.close(); } catch {}
  }
}

function lowPassTaps(n, cutoffHz, rate) {
  const fc = cutoffHz / rate, mid = (n - 1) / 2, h = [];
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h.push(sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))));
  }
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map(v => v / sum);
}

/**
 * Streaming downsampler for little-endian 16-bit mono PCM: a Hamming-windowed sinc
 * low-pass (so energy above the new Nyquist doesn't alias) followed by linear
 * interpolation at the in/out rate step. Gemini Live outputs 24 kHz; the call leg
 * takes 8 kHz (see TX_RATE).
 */
export class Resampler {
  constructor(inRate = 24000, outRate = TX_RATE) {
    this.step = inRate / outRate;
    this.taps = lowPassTaps(inRate / outRate >= 2.5 ? 31 : 15, outRate * 0.45, inRate);
    this.reset();
  }

  reset() {
    this.history = new Float32Array(this.taps.length - 1); // last filter inputs
    this.phase = 0; // position of the next output sample, in input samples, relative to chunk start
    this.prev = 0;  // last filtered sample of the previous chunk (for interpolation)
  }

  process(buf) {
    const nIn = Math.floor(buf.length / 2);
    if (!nIn) return Buffer.alloc(0);
    const taps = this.taps;
    const hist = this.history.length;
    const x = new Float32Array(hist + nIn);
    x.set(this.history, 0);
    for (let i = 0; i < nIn; i++) x[hist + i] = buf.readInt16LE(i * 2);
    const y = new Float32Array(nIn);
    for (let i = 0; i < nIn; i++) {
      let acc = 0;
      for (let k = 0; k < taps.length; k++) acc += taps[k] * x[i + k];
      y[i] = acc;
    }
    this.history = x.slice(nIn);
    // Index -1 is the previous chunk's tail.
    const out = [];
    let pos = this.phase;
    while (pos <= nIn - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.prev : y[i];
      const b = y[i + 1 < nIn ? i + 1 : i];
      out.push(a + (b - a) * frac);
      pos += this.step;
    }
    this.phase = pos - nIn;
    this.prev = y[nIn - 1];
    const res = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      res.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), i * 2);
    }
    return res;
  }
}
