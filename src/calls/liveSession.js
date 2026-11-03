import { EventEmitter } from 'events';
import WebSocket from 'ws';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Mic audio is batched into ~100 ms chunks instead of one message per 20 ms packet.
const SEND_CHUNK_BYTES = 16000 * 2 / 10;

/**
 * One Gemini Live (BidiGenerateContent) session: 16 kHz PCM in, 24 kHz PCM out,
 * with server-side voice activity detection, barge-in and transcription both ways.
 *
 * Events: 'audio' (Buffer, 24 kHz LE PCM), 'inputText' / 'outputText' (transcript
 * fragments), 'interrupted', 'turnComplete', 'goAway', 'close' (code, reason).
 */
export class LiveSession extends EventEmitter {
  constructor({ apiKey, model, voiceName, systemPrompt, languageCodes = [], logger }) {
    super();
    this.languageCodes = languageCodes;
    this.apiKey = apiKey;
    this.model = model;
    this.voiceName = voiceName;
    this.systemPrompt = systemPrompt;
    this.log = logger;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.pending = [];
    this.pendingBytes = 0;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(this.apiKey)}`);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error('Gemini Live setup timed out'));
        this.close();
      }, timeoutMs);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          setup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } } },
            },
            systemInstruction: { parts: [{ text: this.systemPrompt }] },
            inputAudioTranscription: this.languageCodes.length ? { languageCodes: this.languageCodes } : {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
          },
        }));
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.setupComplete) {
          clearTimeout(timer);
          this.ready = true;
          resolve();
          return;
        }
        try { this.onServerMessage(msg); } catch (err) {
          this.log.error({ err: err.message }, 'Gemini Live message handling failed');
        }
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        const why = reason?.toString() || '';
        if (!this.ready) reject(new Error(`Gemini Live closed during setup (${code}${why ? `: ${why}` : ''})`));
        this.ready = false;
        if (!this.closed) {
          this.closed = true;
          this.emit('close', code, why);
        }
      });
      ws.on('error', (err) => this.log.warn({ err: err.message }, 'Gemini Live socket error'));
    });
  }

  onServerMessage(msg) {
    const sc = msg.serverContent;
    if (sc) {
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
      }
      if (sc.inputTranscription?.text) this.emit('inputText', sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.emit('outputText', sc.outputTranscription.text);
      if (sc.interrupted) this.emit('interrupted');
      if (sc.turnComplete) this.emit('turnComplete');
    }
    if (msg.goAway) this.emit('goAway', msg.goAway.timeLeft);
  }

  send(obj) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  /** Feed caller audio (little-endian 16 kHz PCM). */
  sendAudio(pcm) {
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    if (this.pendingBytes < SEND_CHUNK_BYTES) return;
    const data = Buffer.concat(this.pending).toString('base64');
    this.pending = [];
    this.pendingBytes = 0;
    this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } });
  }

  /** A text turn from the "system side" (e.g. "the call just connected — greet them"). */
  sendText(text) {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  close() {
    this.closed = true;
    this.ready = false;
    try { this.ws?.close(); } catch {}
  }
}
