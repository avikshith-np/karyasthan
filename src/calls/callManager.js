import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger as baseLogger } from '../utils/logger.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { emitDashboardEvent } from '../dashboard/events.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { addMemory } from '../memory/relationshipStore.js';
import { resolvePerson, recordIdentity, bareJid } from '../memory/identity.js';
import { canUseChatContent } from '../memory/recall.js';
import { callLlm } from '../brain/llm.js';
import {
  createCall, setCallStatus, markCallAnswered, endCall, setCallSummary,
  addTranscriptLine, getTranscript, closeStaleCalls,
} from '../memory/callStore.js';
import { AriClient } from './ari.js';
import { RtpEndpoint, Resampler } from './rtp.js';
import { LiveSession } from './liveSession.js';
import { buildCallPrompt, personLabel, callAudience } from './callPrompt.js';
import { toE164 } from './phoneNumber.js';

// Phone calls: Asterisk (deploy/asterisk/) hands every call on the gateway phone's SIM
// to the ARI app; each call is bridged to one Gemini Live session.
//
// Runs inside the main bot process (it needs the live Baileys socket for LID → phone
// mapping and the dashboard event bus). Every callback is guarded so a failure ends
// the call, never the process. The gateway is a single cellular line, so there is at
// most one call at a time.

const log = baseLogger.child({ module: 'calls' });
const LIVE_SETUP_TIMEOUT_MS = 8000;
const WRAP_UP_LEAD_MS = 30000;

let ari = null;
let getSockRef = () => null;
let active = null;

export class CallError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ── Phone numbers ────────────────────────────────────────────────────────────

const bareUser = (jid) => String(jid).split('@')[0].split(':')[0];

async function phoneForPerson(personJid) {
  if (personJid.endsWith('@s.whatsapp.net')) return `+${bareUser(personJid)}`;
  if (personJid.endsWith('@lid')) {
    const sock = getSockRef();
    if (!sock) throw new CallError('WhatsApp is not connected; cannot look up their number', 503);
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(personJid);
      if (pn) return `+${bareUser(pn)}`;
    } catch (err) {
      log.debug({ err: err.message }, 'LID → phone lookup failed');
    }
  }
  return null;
}

// Inbound caller ID → a known person (R2: a known number gets that person's DM
// audience — accepted risk, caller ID can be spoofed). Canonical identity first,
// then Baileys' PN → LID map (recorded so the next lookup is direct).
async function personForPhone(e164) {
  if (!e164) return null;
  const pnJid = `${e164.replace(/\D/g, '')}@s.whatsapp.net`;
  const known = resolvePerson(pnJid);
  const direct = known ? getPerson(known) : null;
  if (direct) return direct;
  try {
    const lid = await getSockRef()?.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
    const person = lid ? getPerson(resolvePerson(`${bareUser(lid)}@lid`) || `${bareUser(lid)}@lid`) : null;
    if (person) recordIdentity(pnJid, person.jid, 'lidmap');
    return person || null;
  } catch (err) {
    log.debug({ err: err.message }, 'phone → LID lookup failed');
  }
  return null;
}

/** Number the dashboard would dial for this person, or null. */
export async function dialableNumber(personJid) {
  const phone = await phoneForPerson(personJid);
  return phone && new RegExp(config.calls.allowedNumberPattern).test(phone) ? phone : null;
}

// ── Public state ─────────────────────────────────────────────────────────────

function publicCall(c) {
  if (!c) return null;
  return {
    id: c.id, direction: c.direction, context: c.context,
    personJid: c.personJid, groupJid: c.groupJid, phone: c.phone,
    name: c.name, groupName: c.groupName,
    status: c.status, startedAt: c.startedAt, answeredAt: c.answeredAt,
    partial: { ...c.partial },
  };
}

function getActiveCall() {
  return publicCall(active);
}

export function callsStatus() {
  return { enabled: isSkillEnabled('calls'), ariConnected: !!ari?.connected, active: getActiveCall() };
}

function emit(c, kind, extra = {}) {
  emitDashboardEvent('call', { kind, callId: c.id, call: publicCall(c), ...extra });
}

// ── Call lifecycle ───────────────────────────────────────────────────────────

function newCall({ direction, context, person, groupJid, phone, initiatedBy }) {
  // The audience of every call is the person on the line (R2), fixed at call start.
  const audience = person ? callAudience(person.jid) : null;
  const id = createCall({
    direction, context, personJid: person?.jid || null, groupJid, phone,
    model: config.calls.liveModel, initiatedBy, status: direction === 'inbound' ? 'ringing' : 'dialing',
  });
  return {
    id, direction, context, phone, initiatedBy,
    personJid: person?.jid || null,
    groupJid: groupJid || null,
    name: personLabel(person, audience) || null,
    audience,
    groupName: groupJid ? (getGroup(groupJid)?.name || null) : null,
    status: direction === 'inbound' ? 'ringing' : 'dialing',
    startedAt: Math.floor(Date.now() / 1000),
    answeredAt: null,
    channelId: null, extChannelId: null, bridgeId: null,
    rtp: null, live: null, livePromise: null, resampler: new Resampler(),
    partial: { them: '', bot: '' },
    lines: 0,
    debug: config.calls.debugAudio ? { in: [], out: [] } : null,
    timers: [],
    ending: false,
    log: log.child({ callId: id }),
  };
}

function guard(c, what, fn) {
  return (...args) => {
    try { return fn(...args); } catch (err) {
      c.log.error({ err: err.message, what }, 'call handler failed');
      finish(c, 'failed', `${what}: ${err.message}`);
    }
  };
}


function openLive(c) {
  const systemPrompt = buildCallPrompt({
    context: c.context, direction: c.direction, personJid: c.personJid, groupJid: c.groupJid, audience: c.audience,
  });
  const live = new LiveSession({
    apiKey: config.llm.geminiApiKey,
    model: config.calls.liveModel,
    voiceName: config.calls.voiceName,
    systemPrompt,
    languageCodes: config.calls.languageCodes,
    logger: c.log,
  });
  c.live = live;
  c.livePromise = live.connect(LIVE_SETUP_TIMEOUT_MS);
  // A setup failure surfaces where livePromise is awaited; avoid an unhandled rejection meanwhile.
  c.livePromise.catch(() => {});
  return c.livePromise;
}

function flush(c, speaker, cut = false) {
  const text = c.partial[speaker].replace(/\s+/g, ' ').trim();
  c.partial[speaker] = '';
  if (!text) return;
  const line = cut ? `${text} —` : text;
  try { addTranscriptLine(c.id, speaker, line); } catch (err) { c.log.warn({ err: err.message }, 'transcript write failed'); }
  c.lines++;
  emit(c, 'line', { speaker, text: line });
}

async function bridgeMedia(c) {
  c.rtp = new RtpEndpoint(c.log);
  const port = await c.rtp.bind(config.calls.rtpHost);
  const ext = await ari.externalMedia({ host: `${config.calls.rtpHost}:${port}` });
  c.extChannelId = ext.id;
  c.rtp.setRemote(ext.channelvars?.UNICASTRTP_LOCAL_ADDRESS, ext.channelvars?.UNICASTRTP_LOCAL_PORT);
  const bridge = await ari.createBridge();
  c.bridgeId = bridge.id;
  await ari.addToBridge(bridge.id, [c.channelId, ext.id]);

  const live = c.live;
  c.rtp.on('audio', guard(c, 'rtp audio', (pcm) => { live.sendAudio(pcm); c.debug?.in.push(pcm); }));
  live.on('audio', guard(c, 'live audio', (pcm24) => {
    const pcm8 = c.resampler.process(pcm24);
    c.rtp.enqueue(pcm8);
    c.debug?.out.push(pcm8);
  }));
  live.on('interrupted', guard(c, 'interrupted', () => {
    c.rtp.clear();
    c.resampler.reset();
    flush(c, 'bot', true);
  }));
  live.on('inputText', guard(c, 'input text', (t) => {
    if (c.partial.bot) flush(c, 'bot');
    c.partial.them += t;
    emit(c, 'partial', { speaker: 'them', text: c.partial.them });
  }));
  live.on('outputText', guard(c, 'output text', (t) => {
    if (c.partial.them) flush(c, 'them');
    c.partial.bot += t;
    emit(c, 'partial', { speaker: 'bot', text: c.partial.bot });
  }));
  live.on('turnComplete', guard(c, 'turn complete', () => { flush(c, 'them'); flush(c, 'bot'); }));
  live.on('goAway', () => {
    c.log.info('Gemini Live goAway; ending call');
    live.sendText('(The call is about to drop. Say a quick goodbye now.)');
    c.timers.push(setTimeout(() => finish(c, 'ended', 'ai session limit'), 6000));
  });
  live.on('close', (code, reason) => finish(c, 'ended', `ai session closed (${code}${reason ? `: ${reason}` : ''})`));
}

function markAnswered(c) {
  c.status = 'active';
  c.answeredAt = Math.floor(Date.now() / 1000);
  markCallAnswered(c.id);
  const maxMs = config.calls.maxMinutes * 60000;
  c.timers.push(setTimeout(() => {
    c.live?.sendText('(The call has to end in 30 seconds. Wrap up and say goodbye naturally.)');
  }, Math.max(0, maxMs - WRAP_UP_LEAD_MS)));
  c.timers.push(setTimeout(() => finish(c, 'ended', 'max duration'), maxMs));
  emit(c, 'state');
}

/** Idempotent teardown. status: 'ended' | 'missed' | 'failed' | 'busy'. */
function finish(c, status, reason) {
  if (!c || c.ending) return;
  c.ending = true;
  for (const t of c.timers) clearTimeout(t);
  flush(c, 'them');
  flush(c, 'bot');
  try { c.live?.close(); } catch {}
  try { c.rtp?.close(); } catch {}
  const final = c.answeredAt ? 'ended' : status;
  if (ari) {
    if (c.bridgeId) ari.destroyBridge(c.bridgeId).catch(() => {});
    if (c.extChannelId) ari.hangup(c.extChannelId).catch(() => {});
    if (c.channelId) ari.hangup(c.channelId, status === 'busy' ? 'busy' : 'normal').catch(() => {});
  }
  try { endCall(c.id, final, reason); } catch (err) { c.log.warn({ err: err.message }, 'endCall write failed'); }
  c.status = final;
  c.log.info({ status: final, reason, lines: c.lines, rtp: c.rtp?.stats }, 'Call ended');
  emit(c, 'ended', { reason });
  if (active === c) active = null;
  if (c.debug) saveDebugAudio(c);
  if (c.answeredAt && c.lines >= 2) summarize(c).catch(err => c.log.warn({ err: err.message }, 'call summary failed'));
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** CALL_DEBUG_AUDIO: what Gemini heard (16 kHz) and what the caller was sent (8 kHz). */
function saveDebugAudio(c) {
  try {
    const dir = path.join(path.dirname(config.dbPath), 'calls-debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${c.id}-in.wav`), wav(Buffer.concat(c.debug.in), 16000));
    fs.writeFileSync(path.join(dir, `${c.id}-out.wav`), wav(Buffer.concat(c.debug.out), 8000));
  } catch (err) {
    c.log.warn({ err: err.message }, 'saving call debug audio failed');
  }
}

async function summarize(c) {
  const transcript = getTranscript(c.id);
  const who = c.name || 'the caller';
  const text = transcript.map(l => `${l.speaker === 'bot' ? 'You' : who}: ${l.text}`).join('\n');
  const summary = await callLlm(
    `Summarize this phone call for your own memory in 1-3 short sentences, third person about ${who}, ` +
    'keeping concrete facts, plans, dates and promises. No preamble. If nothing worth remembering was said, reply NONE.',
    text,
    { role: 'clerk', caller: 'call.summary', maxTokens: 300, timeoutMs: 30000 },
  );
  const clean = (summary || '').trim();
  if (!clean || /^none\.?$/i.test(clean)) return;
  setCallSummary(c.id, clean);
  if (c.personJid) {
    // Private to the caller's DM (R2), even for a group-context call; evidence = the
    // transcript lines (ids are synthetic: transcript lines are not messages).
    const caller = resolvePerson(c.personJid) || bareJid(c.personJid);
    const when = new Date((c.answeredAt || c.startedAt) * 1000).toISOString().slice(0, 10);
    const where = c.context === 'group' && c.groupName ? `, about ${c.groupName}` : '';
    const evidence = transcript
      .map((l, i) => ({ msgId: `call:${c.id}:${i}`, ts: Number(l.ts) }))
      .filter(e => Number.isFinite(e.ts) && e.ts > 0);
    if (!evidence.length) evidence.push({ msgId: `call:${c.id}`, ts: c.answeredAt || c.startedAt });
    try {
      addMemory({
        category: 'event', subjectJid: caller, originKind: 'call', originJid: caller,
        content: `Phone call on ${when} (${c.direction === 'inbound' ? 'they called' : 'you called'}${where}): ${clean}`,
        importance: 0.6, expiresInDays: 120, source: 'call', evidence,
      });
    } catch (err) {
      c.log.warn({ err: err.message }, 'storing the call summary memory failed');
    }
  }
  emitDashboardEvent('call', { kind: 'summary', callId: c.id, summary: clean });
}

// ── Inbound ──────────────────────────────────────────────────────────────────

async function onInbound(channel) {
  if (!isSkillEnabled('calls') || active) {
    log.info({ reason: active ? 'line busy' : 'calls skill off' }, 'Refusing inbound call');
    await ari.hangup(channel.id, 'busy').catch(() => {});
    return;
  }
  const phone = toE164(channel.caller?.number, config.calls.defaultCountryCode);
  const person = await personForPhone(phone);
  const c = newCall({ direction: 'inbound', context: person ? 'dm' : 'unknown', person, phone });
  c.channelId = channel.id;
  active = c;
  c.log.info({ known: !!person }, 'Inbound call');
  emit(c, 'state');
  try {
    // Gemini first, then answer: the caller keeps hearing ringback instead of dead air.
    await openLive(c);
    if (c.ending) return;
    await ari.answer(channel.id);
    markAnswered(c);
    await bridgeMedia(c);
    c.live.sendText('(The phone just connected — you picked up. Answer it now.)');
  } catch (err) {
    c.log.error({ err: err.message }, 'Inbound call setup failed');
    finish(c, c.answeredAt ? 'failed' : 'busy', `setup: ${err.message}`);
  }
}

// ── Outbound ─────────────────────────────────────────────────────────────────

export async function startOutboundCall({ personJid, groupJid = null, actor = null }) {
  if (!isSkillEnabled('calls')) throw new CallError('Calls are disabled (Skills tab → calls)', 409);
  if (!ari?.connected) throw new CallError('Not connected to Asterisk', 503);
  if (active) throw new CallError('A call is already in progress', 409);
  const person = getPerson(resolvePerson(personJid) || personJid);
  if (!person) throw new CallError('Person not found', 404);
  if (groupJid && !getGroup(groupJid)) throw new CallError('Group not found', 404);
  // Group context only while the callee is a fresh current member (R2) — the group's
  // transcript and blocks go into the call.
  if (groupJid && !canUseChatContent(callAudience(person.jid), groupJid)) {
    throw new CallError('They are not a current member of that group (or membership is not synced yet) — call with DM context', 409);
  }
  const phone = await phoneForPerson(personJid);
  if (!phone) throw new CallError('No phone number known for this person', 422);
  if (!new RegExp(config.calls.allowedNumberPattern).test(phone)) {
    throw new CallError('Number is outside the allowed calling range', 422);
  }
  if (active) throw new CallError('A call is already in progress', 409);

  const c = newCall({
    direction: 'outbound', context: groupJid ? 'group' : 'dm', person, groupJid, phone, initiatedBy: actor,
  });
  c.channelId = `karyasthan-out-${c.id}-${Date.now()}`;
  active = c;
  c.log.info({ context: c.context }, 'Outbound call');
  emit(c, 'state');
  // Backstop in case Asterisk never reports the unanswered channel going away.
  c.timers.push(setTimeout(() => {
    if (!c.answeredAt) finish(c, 'missed', 'no answer');
  }, (config.calls.ringTimeoutSec + 15) * 1000));
  // Warm the voice session while the phone rings so the first "hello" gets a quick reply.
  openLive(c).catch(err => {
    c.log.error({ err: err.message }, 'Voice session setup failed for outbound call');
    finish(c, 'failed', `ai setup: ${err.message}`);
  });
  try {
    await ari.originate({
      endpoint: `PJSIP/${phone}@${config.calls.gatewayEndpoint}`,
      channelId: c.channelId,
      appArgs: `outbound,${c.id}`,
      timeout: config.calls.ringTimeoutSec,
    });
  } catch (err) {
    finish(c, 'failed', `originate: ${err.message}`);
    throw new CallError(`Could not place the call: ${err.message}`, 502);
  }
  return publicCall(c);
}

async function onOutboundAnswered(channel, callId) {
  const c = active;
  if (!c || c.id !== callId || c.channelId !== channel.id) {
    await ari.hangup(channel.id).catch(() => {});
    return;
  }
  try {
    await c.livePromise;
    if (c.ending) return;
    markAnswered(c);
    await bridgeMedia(c);
    // If they pick up and say nothing, open the conversation anyway.
    c.timers.push(setTimeout(() => {
      if (!c.ending && !c.lines && !c.partial.them && !c.partial.bot) {
        c.live.sendText('(They picked up but haven\'t said anything. Say hello and why you\'re calling.)');
      }
    }, 3500));
  } catch (err) {
    c.log.error({ err: err.message }, 'Outbound call setup failed');
    finish(c, 'failed', `setup: ${err.message}`);
  }
}

export function hangupActiveCall(reason = 'hung up from dashboard') {
  if (!active) return false;
  finish(active, active.answeredAt ? 'ended' : 'failed', reason);
  return true;
}

// ── ARI wiring ───────────────────────────────────────────────────────────────

const HANGUP_CAUSES = { 16: 'normal', 17: 'busy', 18: 'no answer', 19: 'no answer', 21: 'rejected', 34: 'no circuit', 38: 'network out of order' };

function wireAri() {
  ari.on('StasisStart', (ev) => {
    const ch = ev.channel;
    if (!ch || ch.name?.startsWith('UnicastRTP/')) return; // our externalMedia legs
    const [kind, id] = ev.args || [];
    const run = kind === 'outbound' ? onOutboundAnswered(ch, Number(id)) : onInbound(ch);
    run.catch(err => log.error({ err: err.message }, 'StasisStart handling failed'));
  });
  ari.on('ChannelStateChange', (ev) => {
    const c = active;
    if (c && ev.channel?.id === c.channelId && ev.channel.state === 'Ringing' && c.status === 'dialing') {
      c.status = 'ringing';
      setCallStatus(c.id, 'ringing');
      emit(c, 'state');
    }
  });
  const onGone = (ev) => {
    const c = active;
    if (!c || ev.channel?.id !== c.channelId) return;
    const cause = ev.cause ? (HANGUP_CAUSES[ev.cause] || ev.cause_txt || `cause ${ev.cause}`) : 'hangup';
    if (c.answeredAt) { finish(c, 'ended', 'remote hangup'); return; }
    // An outbound call that never rang was refused by the gateway (bad number, SIM
    // unavailable, dial policy), not missed by the person.
    if (c.direction === 'outbound' && c.status === 'dialing') {
      finish(c, 'failed', `gateway refused the call (${ev.cause_txt || cause})`);
      return;
    }
    finish(c, ev.cause === 17 ? 'busy' : 'missed', cause);
  };
  ari.on('ChannelDestroyed', onGone);
  ari.on('StasisEnd', onGone);
  ari.on('disconnected', () => {
    if (active) finish(active, 'failed', 'lost connection to Asterisk');
  });
}

export function startCalls({ getSock }) {
  getSockRef = getSock;
  try {
    const closed = closeStaleCalls();
    if (closed) log.info({ closed }, 'Closed calls left open by a restart');
  } catch (err) {
    log.warn({ err: err.message }, 'closeStaleCalls failed');
  }
  if (!config.calls.ariPassword) {
    log.info('ARI_PASSWORD not set; phone calls are unavailable');
    return;
  }
  if (!config.llm.geminiApiKey) {
    log.warn('GEMINI_API_KEY not set; phone calls are unavailable');
    return;
  }
  ari = new AriClient({
    url: config.calls.ariUrl, user: config.calls.ariUser, password: config.calls.ariPassword,
    app: config.calls.ariApp, logger: log,
  });
  wireAri();
  ari.connect();
}

export function stopCalls() {
  if (active) finish(active, 'failed', 'shutting down');
  ari?.close();
}
