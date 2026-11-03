// Shared helpers for the spec 012 tests (scripts/chat-influence-tests/*.test.js).
//
// Import this module FIRST in a test file. It re-exports scripts/arcs-tests/_helpers.js
// (which re-exports the life helpers: scratch DB under data/, DRY_RUN, quiet logger —
// all set before anything imports config). Offline: fake clock, stubbed Jev in the
// LIVE wire shapes (verified 2026-10-29 — a fake of another shape once hid a live
// bug), no network. Every name here is invented and persona-neutral.
//
//   import { setupScratchDb, bootInfluence, say, perceiveJev, check, report } from './_helpers.js';
//   const { db } = await setupScratchDb();
//   const t = await bootInfluence();            // life + chat-influence on, example world
//   await say(t, { chat: t.GROUP, sender: t.A, text: 'nice one, legend', id: 'M1' });
//   report();

import { bootLife, setBot, seedPeople, seedGroups, fakeJev, fakeClock, blockNetwork } from '../arcs-tests/_helpers.js';

export * from '../arcs-tests/_helpers.js';

/** A Jev `choice` answer exactly as the live API sends it. */
export function liveChoice(choice, probabilities = { [choice]: 0.95 }) {
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] ?? 0 };
}

/** A Jev `noul` answer exactly as the live API sends it. */
export function liveNoul(p) {
  return { type: 'noul', noul: p };
}

/**
 * A perception Jev (askJev stand-in) answering every life.chat.perceive request
 * with `spec` = { kind, target, affect, intensity, advice, p } (p = the chosen
 * probability of every answer, default 0.9) — or `spec(req, i)` for per-call answers.
 * Non-perceive calls (decisions, claims) get the softmax-free default: empty answers.
 */
export function perceiveJev(spec = { kind: 'affect', target: 'him', affect: 'roast', intensity: 'high' }) {
  return fakeJev((req, i) => {
    if (req?.caller !== 'life.chat.perceive') return {};
    const s = typeof spec === 'function' ? spec(req, i) : spec;
    if (!s) return {};
    const p = typeof s.p === 'number' ? s.p : 0.9;
    const ans = (c, ids) => liveChoice(c, Object.fromEntries(ids.map(id => [id, id === c ? p : Math.round(((1 - p) / Math.max(1, ids.length - 1)) * 1000) / 1000])));
    const q = req.questions || {};
    const out = {};
    for (const [key, val] of Object.entries({ kind: s.kind ?? 'none', target: s.target ?? 'him', affect: s.affect ?? 'none',
      intensity: s.intensity ?? 'mid', advice: s.advice ?? 'none' })) {
      if (q[key]) out[key] = ans(val, Object.keys(q[key].criteria || {}));
    }
    return out;
  });
}

/**
 * Boot life with chat influence on: the bot's identity, three people (A, B, C), a
 * group G with all three, a second group H (A and C), a fake clock (Tue 27 Oct
 * 2026, 18:00 world time unless `at` is given), skills { life, chat-influence }
 * (arcs off unless asked) and the perception Jev wired in. opts: { at, jev,
 * skills, areas: { mood, sleep, work } overrides, ...startLife opts }.
 * → { life, influence, perceive, clock, world, jev, GROUP, OTHER, A, B, C, bot, db }
 */
export async function bootInfluence({ at = null, jev = null, skills = {}, areas = {}, ...startOpts } = {}) {
  blockNetwork();
  const bot = await setBot();
  const [A, B, C] = await seedPeople([
    { jid: '7201@lid', name: 'Avery', pn: '15550007201@s.whatsapp.net' },
    { jid: '7202@lid', name: 'Blake' },
    { jid: '7203@lid', name: 'Casey' },
  ], { at: Date.UTC(2026, 6, 1) / 1000 });
  const [GROUP, OTHER] = await seedGroups([
    { jid: '120363000000770001@g.us', name: 'Test group', members: [A, B, C] },
    { jid: '120363000000770002@g.us', name: 'Other group', members: [A, C] },
  ], { at: Date.UTC(2026, 6, 1) / 1000 });
  const { config } = await import('../../src/utils/config.js');
  for (const [k, v] of Object.entries({ mood: true, sleep: true, work: true, invites: false, advice: false, ...areas })) {
    config.chatInfluence[k] = v;
  }
  const { zonedToUnix } = await import('../../src/life/clock.js');
  const { exampleWorld } = await import('../arcs-tests/_helpers.js');
  const world = await exampleWorld();
  const clock = fakeClock(at ?? zonedToUnix(2026, 10, 27, 18, 0, world.timezone));
  const j = jev ?? perceiveJev();
  const perceive = await import('../../src/life/influence/perceive.js');
  perceive.setJev(j.fn);
  const { life } = await bootLife({
    world, clock, jev: j, skills: { life: true, arcs: false, 'chat-influence': true, imitate: false, ...skills }, ...startOpts,
  });
  const influence = await import('../../src/life/influence/index.js');
  const { getDb } = await import('../../src/memory/db.js');
  const restartOpts = { world, timers: false, isEnabled: () => true, seed: 42, isGroupMuted: () => false, isMember: () => true,
    sleep: async () => {}, ...startOpts };
  return { life, influence, perceive, clock, world, jev: j, GROUP, OTHER, A, B, C, bot, db: getDb(), config, restartOpts };
}

/** Stop the life facade (the "process" ends). */
export async function stopEngine(t) {
  await t.life.stopLife();
}

/** Start it again with bootInfluence's options (a restart: rebuild, catch-up, boot-time withdrawals). */
export async function startEngine(t, over = {}) {
  await t.life.startLife({ ...t.restartOpts, ...over });
}

let seq = 0;

/**
 * One incoming message: stored like events.js stores it, then perceived like
 * processTurn does (perceiveChat with the turn's audience and bot ids), then — unless
 * `verdict: null` — the gate verdict ('now' by default) is reported and the
 * perception awaited. opts: { chat, sender, text, id, at, mentioned, quotedId,
 * fromSelf, verdict, burstIds, store:false, forwarded, expiresAt, name (the sender's push name) }. → the msg
 */
export async function say(t, { chat, sender, text, id = `MSG${++seq}`, at = t.clock.now(), mentioned = [], quotedId = null,
  fromSelf = false, verdict = 'now', burstIds, store = true, forwarded = false, expiresAt = null, type = 'text', name = 'x' } = {}) {
  const { storeMessage } = await import('../../src/memory/messageStore.js');
  const { resolveAudience } = await import('../../src/memory/recall.js');
  const metadata = mentioned.length ? { mentionedJids: mentioned } : {};
  const msg = {
    id, groupJid: chat, senderJid: fromSelf ? t.bot.pn : sender, senderName: name, content: text, messageType: type,
    timestamp: at, quotedId, metadata, isFromSelf: fromSelf, isForwarded: forwarded,
  };
  if (store) {
    storeMessage(msg);
    if (expiresAt) t.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(expiresAt, id);
  }
  if (fromSelf) return msg;
  const audience = resolveAudience({ chatJid: chat });
  const ctx = { botJid: '10000000000:1@s.whatsapp.net', botLid: '10000000000:1@lid', burstIds };
  if (verdict === null || typeof t.life.perceiveInfluence !== 'function') {
    // No verdict yet (or a pre-gate build): the perception starts regardless.
    await t.life.perceiveChat(msg, audience, ctx);
  } else {
    // processTurn's order: 009's matcher, then the gate's verdict, then the perception.
    await t.life.perceiveChat(msg, audience, { ...ctx, influence: false });
    t.life.perceiveInfluence(msg, audience, ctx, verdict);
  }
  if (verdict !== null) {
    t.life.gateOutcome(chat, id, verdict);
    await idle(t);
  }
  return msg;
}

/** His own sent message (stored only). */
export async function sent(t, { chat, text = 'haha yes', id = `SELF${++seq}`, at = t.clock.now() } = {}) {
  return say(t, { chat, text, id, at, fromSelf: true });
}

/** Wait for every pending perception (and the setImmediate withdrawals) to settle. */
export async function idle(t) {
  await t.influence.__idle();
  await new Promise(r => setImmediate(r));
}

/** Events of these types after `afterId`. */
export async function eventsOf(types, afterId = 0) {
  const { eventsAfter } = await import('../../src/life/eventLog.js');
  const set = new Set(Array.isArray(types) ? types : [types]);
  return eventsAfter(afterId, 100000).filter(e => set.has(e.type));
}

/** Perception calls the Jev stub saw. */
export const perceiveCalls = (t) => t.jev.calls.filter(c => c.caller === 'life.chat.perceive');

// ── P2 invitations ──────────────────────────────────────────────────────────

/** A clerk extraction JSON (the invitation schema) with overrides. */
export function inviteExtraction(over = {}) {
  return JSON.stringify({
    type: 'plan', kind: 'movie', when: { date: null, relative: 'tonight', time: '20:00', part: null },
    minutes: 120, place: 'cinema', people: [], summary: 'a movie tonight', confidence: 0.9, ...over,
  });
}

/**
 * One Jev for invitations: perception answers (`perceive`: a spec or fn(req, i) like
 * perceiveJev) and the claim call's extra `answer` question (`answer`: 'yes'|'no'|
 * 'maybe'|'late'|'none' or fn(req) → that; `answerP` its p) plus its `kind`
 * question (`claim`, default 'none'). Every answer in the live wire shape.
 */
export function inviteJev({ perceive = { kind: 'invite', target: 'him', intensity: 'mid' }, answer = 'none', answerP = 0.9, claim = 'none' } = {}) {
  const ans = (c, ids, p) => liveChoice(c, Object.fromEntries(ids.map(id => [id, id === c ? p : Math.round(((1 - p) / Math.max(1, ids.length - 1)) * 1000) / 1000])));
  return fakeJev((req, i) => {
    const q = req?.questions || {};
    if (req?.caller === 'life.chat.perceive') {
      const s = typeof perceive === 'function' ? perceive(req, i) : perceive;
      if (!s) return {};
      const p = typeof s.p === 'number' ? s.p : 0.9;
      const out = {};
      for (const [key, val] of Object.entries({ kind: s.kind ?? 'none', target: s.target ?? 'him', affect: s.affect ?? 'none',
        intensity: s.intensity ?? 'mid', advice: s.advice ?? 'none' })) {
        if (q[key]) out[key] = ans(val, Object.keys(q[key].criteria || {}), p);
      }
      return out;
    }
    if (req?.caller === 'life.claim') {
      const out = {};
      if (q.kind) out.kind = ans(claim, Object.keys(q.kind.criteria || {}), 0.9);
      if (q.answer) {
        const a = typeof answer === 'function' ? answer(req, i) : answer;
        out.answer = ans(a, Object.keys(q.answer.criteria || {}), answerP);
      }
      return out;
    }
    return {};
  });
}

/**
 * The clerk for invitations (influence/invites.js setCallRole): `respond(system,
 * user, opts, i)` → text | { text } | a promise; default: inviteExtraction().
 * Calls are recorded in `.calls`.
 */
export async function inviteClerk(respond = () => inviteExtraction()) {
  const invites = await import('../../src/life/influence/invites.js');
  const clerk = { calls: [] };
  invites.setCallRole(async (role, system, user, opts = {}) => {
    const i = clerk.calls.length;
    clerk.calls.push({ role, system, user, opts: { ...opts } });
    const out = await respond(system, user, opts, i);
    if (out == null) return { text: null, status: 'ok' };
    return typeof out === 'string' ? { text: out, status: 'ok' } : { status: 'ok', ...out };
  });
  invites.setBudgetState(() => ({ allowed: true }));
  return clerk;
}

/** His reply was sent: the facade's onReplySent as lifeAfterReply calls it (sent, not a dry run, by default). */
export async function replied(t, { chat, text, triggerMsgId, sentId = `SENT${++seq}`, imitating = false, followUp = false, dryRun = false, store = true } = {}) {
  if (store) await sent(t, { chat, text, id: sentId });
  return t.life.onReplySent({ chatJid: chat, text, triggerText: '', msgId: sentId, triggerMsgId, imitating, followUp, dryRun });
}

/** The invitation decisions in the projection, newest first. */
export function inviteDecisions(t) {
  return [...(t.life.getState()?.decisions?.values?.() || [])].filter(d => d.invite === true).sort((a, b) => b.id - a.id);
}
