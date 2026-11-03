// 012 invitations, the turn (plan §P2.4–P2.5): the stage notes within the wait
// (decision open → the detailed line; only "an invite" known → the generic line;
// nothing → none), the first lean from code with no early commit before his
// answer, the answer grace for short-notice invitations, the catch-up turn's
// note from state (its own chat and message only), and a "Your evening" clause
// that never states another chat's plan times.
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied,
  eventsOf, fakeSock, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const jev = inviteJev({
  // An invitation is a line with a question mark; anything else is chatter.
  perceive: (req) => (/\?/.test(String(req.state?.message ?? '')) ? { kind: 'invite', target: 'him', intensity: 'mid' } : { kind: 'none' }),
  answer: (req) => (/nah|nope/.test(req.state?.his_reply ?? '') ? 'no' : 'yes'),
});
const sock = fakeSock();
const turns = [];
let onTurn = null;
const t = await bootInfluence({
  jev, areas: { invites: true, mood: false, sleep: false, work: false },
  getSock: () => sock,
  processMessage: async (s, msg, ctx) => { turns.push({ msg, ctx, note: onTurn ? await onTurn(msg, ctx) : null }); },
});
let clerk = await inviteClerk();
const { resolveAudience } = await import('../../src/memory/recall.js');
const { hhmm } = await import('../../src/life/clock.js');
const tz = t.world.timezone;
const BOT = '10000000000@s.whatsapp.net';
const audG = resolveAudience({ chatJid: t.GROUP });
const audO = resolveAudience({ chatJid: t.OTHER });

section('a live invitation in a group: the decision opens before the reply');
const m1 = await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema at 8 tonight?', id: 'INV1', verdict: null, mentioned: [BOT], name: 'Avery' });
t.life.gateOutcome(t.GROUP, m1.id, 'now');
const note1 = await t.life.inviteNote(t.GROUP, m1.id, audG, { startedAt: Date.now() });
await idle(t);
const d1 = inviteDecisions(t)[0];
check('an invitation decision opened', !!d1 && d1.status === 'open' && d1.invite === true, d1);
eq('…go / late / stay, the kind from the allow-list, at the cinema', [d1?.options.map(o => o.id), d1?.kind, d1?.subject.placeId],
  [['go', 'late', 'stay'], 'movie', 'place:cinema']);
eq('…the inviter is the subject', d1?.subjectJid, t.A);
check('…its first lean came from code (no Jev decision call)', d1?.lean?.by === 'engine'
  && !t.jev.calls.some(c => c.caller === 'life.decision'), d1?.lean);
const leanEv = (await eventsOf(['decision.lean'])).find(e => e.payload.decisionId === d1?.id);
eq('…labelled invite_open, not life_off', leanEv?.payload.fallback, 'invite_open');
check('the note: the detailed line, with the time and his evening', /^Avery just invited you: a movie at Cinema with a friend at 20:00\. /.test(note1)
  && /yes, no or maybe/.test(note1) && note1.length <= 240, note1);
check('…one clerk call, fenced, the message in it', clerk.calls.length === 1 && clerk.calls[0].opts.caller === 'life.chat.invite'
  && /STORY_DATA/.test(clerk.calls[0].user) && /cinema at 8/.test(clerk.calls[0].user));
const ptr = (await eventsOf(['chat.perceived'])).find(e => e.payload.kind === 'invite');
check('the pointer: the chat origin, the sender as subject, no text', ptr?.originJid === t.GROUP && ptr.subjectJid === t.A
  && !/cinema at 8/.test(JSON.stringify(ptr.payload)));
const opened = (await eventsOf(['decision.opened'])).find(e => e.id === d1?.id);
check('…the decision is caused by it (its origin inherited)', opened?.causeId === ptr?.id && opened?.originJid === t.GROUP);
eq('…and no note in another chat for that message', await t.life.inviteNote(t.OTHER, m1.id, audO, { startedAt: Date.now() }), '');

section('no early commit before his answer');
t.clock.advance({ minutes: 15 });
await t.life.tick();
check('still open after a tick', t.life.getState().decisions.get(d1.id)?.status === 'open');

section('a slow chain: the generic line, the reply not held past the wait');
t.config.chatInfluence.inviteWaitMs = 200;
let release;
const gate = new Promise(r => { release = r; });
clerk = await inviteClerk(async () => { await gate; return inviteExtraction({ kind: 'dinner', place: null, when: { date: null, relative: 'tonight', time: '19:45', part: null } }); });
const m2 = await say(t, { chat: t.OTHER, sender: t.C, text: 'dinner later? you in', id: 'INV2', verdict: null, mentioned: [BOT] });
t.life.gateOutcome(t.OTHER, m2.id, 'now');
const keepAlive = setInterval(() => {}, 1000);   // the wait's timer is unref'd (it never holds the process)
const t0 = Date.now();
const note2 = await t.life.inviteNote(t.OTHER, m2.id, audO, { startedAt: t0 });
const waited = Date.now() - t0;
check('the generic line while the extraction runs', /invited you out/.test(note2), note2);
check('…within the wait (≈ 200 ms, not the clerk\'s time)', waited < 700, waited);
release();
clearInterval(keepAlive);
await idle(t);
const d2 = inviteDecisions(t)[0];
eq('…the decision still opens afterwards: a meal out at the restaurant (the world\'s venue for it)', [d2?.kind, d2?.subject.placeId], ['eat-out', 'place:restaurant']);
t.config.chatInfluence.inviteWaitMs = 2000;

section('nothing perceived → no note');
const m3 = await say(t, { chat: t.GROUP, sender: t.B, text: 'lol same here', id: 'NOPE1', verdict: 'now', mentioned: [BOT] });
eq('no note', await t.life.inviteNote(t.GROUP, m3.id, audG, { startedAt: Date.now() }), '');
eq('…imitating → no note even for an invitation', await t.life.inviteNote(t.GROUP, m1.id, audG, { startedAt: Date.now(), imitating: true }), '');

section('the answer grace: a short-notice invitation stays open for his reply');
// Close the two open ones first (≤ 2 open at once).
await replied(t, { chat: t.GROUP, text: 'nah not today', triggerMsgId: 'INV1' });
await replied(t, { chat: t.OTHER, text: 'nope, maybe next time', triggerMsgId: 'INV2' });
await idle(t);
eq('…both closed by his "no"', [t.life.getState().decisions.get(d1.id)?.committed?.optionId, t.life.getState().decisions.get(d2.id)?.committed?.optionId], ['stay', 'stay']);
t.clock.advance({ minutes: 60 });                // 19:15: home from the office (the work commute is fixed)
await t.life.tick();
const nowT = t.clock.now();
const soon = hhmm(nowT + 40 * 60, tz);
clerk = await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time: soon, part: null }, place: 'cafe', kind: 'coffee', minutes: 60 }));
await say(t, { chat: t.GROUP, sender: t.B, text: 'coffee in a bit?', id: 'INV4', verdict: 'now', mentioned: [BOT] });
await idle(t);
const d4 = inviteDecisions(t)[0];
check('opened for the café, kind cafe', d4?.subject.placeId === 'place:cafe' && d4.kind === 'cafe' && d4.status === 'open', d4);
check('…decideBy is at least 20 min out (the grace), never past the end', d4 && d4.decideBy >= nowT + 20 * 60 - 1
  && d4.decideBy <= d4.subject.eventAt + 60 * 60, { decideBy: d4?.decideBy, now: nowT });
t.clock.advance({ minutes: 12 });
await t.life.tick();
check('…12 min later it is still open', t.life.getState().decisions.get(d4?.id)?.status === 'open');
await replied(t, { chat: t.GROUP, text: 'yes sure, coming', triggerMsgId: 'INV4' });
await idle(t);
const d4b = t.life.getState().decisions.get(d4?.id);
check('…and his "yes" commits it (go, or late once go is gone), by reply', d4b?.status === 'committed'
  && ['go', 'late'].includes(d4b.committed.optionId) && d4b.committed.by === 'reply', d4b?.committed);

section('a deferred invitation: the catch-up turn gets the full note from state');
clerk = await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '21:00', part: null } }));
const m5 = await say(t, { chat: t.OTHER, sender: t.A, text: 'movie tomorrow at 9?', id: 'INV5', verdict: 'defer', mentioned: [BOT] });
const held = t.db.prepare(`SELECT status, kind, held FROM chat_influence_items WHERE msg_id = 'INV5'`).get();
check('defer → a held invite row (codes only)', held?.status === 'held' && held.kind === 'invite' && !/movie/.test(held.held), held);
t.life.enqueueDeferred(m5, { isMention: true }, { remoteJid: t.OTHER, id: 'INV5', participant: t.A, fromMe: false });
t.clock.advance({ minutes: 30 });
onTurn = (msg, ctx) => t.life.inviteNote(ctx.chatJid, msg.id, resolveAudience({ chatJid: ctx.chatJid }), { catchUp: ctx.catchUp });
const n0 = turns.length;
const check1 = await t.life.checkPhoneNow();
const turn = turns[n0];
check('the catch-up turn ran after the decision opened', check1.drained === 1 && !!turn, check1);
check('…its note is the detailed one (from state)', /just invited you: a movie at Cinema with a friend at 21:00/.test(turn?.note ?? ''), turn?.note);
const d5 = inviteDecisions(t)[0];
const ptr5 = (await eventsOf(['chat.perceived'])).find(e => e.payload.msgId === 'INV5');
check('…the pointer is dated at read time', ptr5 && ptr5.at >= t.clock.now() - 300, ptr5?.at);
check('…a decision for tomorrow 19:00', d5 && hhmm(d5.subject.eventAt, tz) === '21:00' && d5.subject.eventAt > t.clock.now() + 12 * 3600);
eq('…a catch-up of another chat with that message id gets nothing', await t.life.inviteNote(t.GROUP, 'INV5', audG,
  { catchUp: { triggerIds: ['INV5'], itemIds: [] } }), '');

section('"Your evening" never shows another chat\'s plan times');
const { eveningClause, setBlockOrigin } = await import('../../src/life/innerState.js');
const s = t.life.getState();
const eve = d5.subject.eventAt - 30 * 60;
// Tomorrow evening as planned once the OTHER-origin outing (with A) is in the plan.
const planned = { ...s, plan: { ...s.plan, sleepAt: eve + 6 * 3600, amendedFor: d5.id, blocks: [
  { kind: 'free', start: eve - 3600, end: d5.subject.eventAt, placeId: 'place:home', withCast: [] },
  { kind: 'movie', start: d5.subject.eventAt, end: d5.subject.eventAt + 7200, placeId: 'place:cinema', withCast: [], fromAmendment: true, subjectJid: t.A },
] } };
setBlockOrigin((plan, b) => (b.fromAmendment ? ptr5.id : plan.eventId));
const evG = eveningClause(planned, eve, audG);
const evO = eveningClause(planned, eve, audO);
check('in the chat that plan came from it shows its time', /plans at 21:00/.test(evO), evO);
check('in another group (the inviter is a member there too): "something on later", no time', /something on later/.test(evG) && !/21:00/.test(evG), evG);
setBlockOrigin(null);

section('a debounced burst of two senders: the invitation is an earlier line than the turn\'s message');
{
  // Fresh daily counts (≤ 2 per chat per day); d5 stays open (≤ 2 open at once).
  t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'invite'`).run();
  const { storeMessage } = await import('../../src/memory/messageStore.js');
  const botIds = { botJid: '10000000000:1@s.whatsapp.net', botLid: '10000000000:1@lid' };
  const burst = (inv, last) => {
    const at = t.clock.now();
    storeMessage({ id: inv, groupJid: t.GROUP, senderJid: t.A, senderName: 'Avery', content: 'movie tomorrow at 8?', messageType: 'text', timestamp: at, metadata: { mentionedJids: [BOT] } });
    const m = { id: last, groupJid: t.GROUP, senderJid: t.B, senderName: 'Blake', content: 'me too, bring snacks', messageType: 'text', timestamp: at, metadata: {} };
    storeMessage(m);
    return m;
  };
  clerk = await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null } }));
  // Live: the note names the inviter, not the turn's last sender.
  const mL = burst('INV7', 'LAST7');
  await t.life.perceiveChat(mL, audG, { ...botIds, burstIds: ['INV7', 'LAST7'] });
  t.life.gateOutcome(t.GROUP, 'LAST7', 'now');
  const noteL = await t.life.inviteNote(t.GROUP, 'LAST7', audG, { startedAt: Date.now() });
  await idle(t);
  check('live: the note names the inviter (Avery), not the burst\'s last sender (Blake)', /^Avery just invited you: /.test(noteL) && !/Blake/.test(noteL), noteL);
  const d7 = inviteDecisions(t)[0];
  await replied(t, { chat: t.GROUP, text: 'nah, not tomorrow', triggerMsgId: 'LAST7' });
  await idle(t);
  eq('(setup) …closed by his "no"', t.life.getState().decisions.get(d7?.id)?.committed?.optionId, 'stay');
  // Deferred: the held row is the invitation line's; the queue holds the turn's message.
  t.clock.advance({ minutes: 11 });              // not "talking" there any more: only the mention is a candidate
  const mD = burst('INV8', 'LAST8');
  await t.life.perceiveChat(mD, audG, { ...botIds, burstIds: ['INV8', 'LAST8'] });
  t.life.gateOutcome(t.GROUP, 'LAST8', 'defer');
  await idle(t);
  const heldRow = () => t.db.prepare(`SELECT status FROM chat_influence_items WHERE msg_id = 'INV8'`).get()?.status ?? null;
  eq('(setup) defer → a held row for the invitation line', heldRow(), 'held');
  t.life.enqueueDeferred(mD, { isMention: false }, { remoteJid: t.GROUP, id: 'LAST8', participant: t.B, fromMe: false });
  t.clock.advance({ minutes: 20 });
  onTurn = (msg, ctx) => t.life.inviteNote(ctx.chatJid, msg.id, resolveAudience({ chatJid: ctx.chatJid }), { catchUp: ctx.catchUp });
  const k = turns.length;
  const c8 = await t.life.checkPhoneNow();
  const turn8 = turns[k];
  check('the phone check applied it: the row is active, its decision open', heldRow() === 'active'
    && inviteDecisions(t).some(d => d.status === 'open' && t.db.prepare(`SELECT decision_id AS id FROM chat_influence_items WHERE msg_id = 'INV8'`).get()?.id === d.id), { row: heldRow(), c8 });
  check('…and the catch-up turn got the detailed note, named after the inviter', /^Avery just invited you: a movie at Cinema with a friend at 20:00/.test(turn8?.note ?? ''), turn8?.note);
  onTurn = null;
}

section('a code lean above commitP at open still waits for his word (unit, last: it writes past the facade)');
const { openDecision } = await import('../../src/life/decisions.js');
const { appendEvent } = await import('../../src/life/eventLog.js');
const at0 = t.clock.now();
const res = await openDecision(() => t.life.getState(), {
  kind: 'movie', subject: { eventAt: at0 + 3 * 3600, placeId: 'place:cinema', castIds: [], minutes: 120 },
  options: [{ id: 'go', label: 'a movie', go: true, kind: 'movie', bias: 3 }, { id: 'late', label: 'Join later', go: 'late', kind: 'movie', bias: -3 },
    { id: 'stay', label: 'Stay in', kind: 'rest', bias: -3 }],
  invite: { pointerId: ptr.id, maxReversals: 1 }, answerGraceSec: 1200,
}, { at: at0, world: t.world, append: appendEvent, causeId: ptr.id, noJev: true, noJevReason: 'invite_open' });
const lean = res.events.find(e => e.type === 'decision.lean');
check('the code lean is confident (p > 0.8)', lean?.payload.p > 0.8, lean?.payload);
check('…and nothing committed', !res.events.some(e => e.type === 'decision.committed'));
eq('…the opened event carries the invite flag', res.decision.payload.invite, { pointerId: ptr.id, maxReversals: 1 });

report();
