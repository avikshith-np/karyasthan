// 012 invitations, the follow-up (plan §P2.7): a "maybe" that later committed
// (or a reversal) gets ONE turn in that chat at the next phone check, through the
// catch-up path (the chat lock, ctx.followUp + catchUp.followUp, its note) — the
// attempt counted under the lock, so a turn that sends nothing ([SKIP], a cap)
// still spends it. Dropped when he wrote there since, the invitation is gone or
// out of the transcript window, the inviter cancelled, it is too late, the group
// is muted or imitating, or the owner froze / paused social. A commit of such an
// invitation schedules a check within minutes. Derived from the projection: a
// restart loses nothing. (decide()'s branch, the pre-filter and the prompt bar:
// test:pipeline.)
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied, setSkills,
  stopEngine, startEngine, eventsOf, fakeSock, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const sock = fakeSock();
const turns = [];
let sendOnTurn = true;
let answerNow = 'maybe';
const muted = new Set();
const { storeMessage } = await import('../../src/memory/messageStore.js');
const t = await bootInfluence({
  jev: inviteJev({ answer: () => answerNow }),
  areas: { invites: true, mood: false, sleep: false, work: false },
  getSock: () => sock,
  isGroupMuted: (j) => muted.has(j),
  processMessage: async (s, msg, ctx) => {
    turns.push({ msg, ctx });
    if (sendOnTurn && ctx.followUp) {
      storeMessage({ id: `FUS${turns.length}`, groupJid: ctx.chatJid, senderJid: t.bot.pn, content: 'ok see you there', messageType: 'text',
        timestamp: t.clock.now(), isFromSelf: true });
    }
  },
});
const BOT = '10000000000@s.whatsapp.net';
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.invitesMaxPerDay = 10;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();
const start = t.clock.now();
let n = 0;
const dec = (id) => t.life.getState().decisions.get(id);
const fuTurns = () => turns.filter(x => x.ctx.followUp);
const row = (decisionId) => t.db.prepare(`SELECT followup_status AS s FROM chat_influence_items WHERE decision_id = ? AND category IS NULL`).get(decisionId)?.s ?? null;

async function reset() {
  for (const r of t.db.prepare(`SELECT pointer_event_id AS id FROM chat_influence_items WHERE kind = 'invite' AND pointer_event_id IS NOT NULL`).all()) {
    try { t.life.revertEvent(r.id, { reason: 'test reset', by: 'test' }); } catch { /* already out */ }
  }
  t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'invite'`).run();
}

// Each case: a fresh invitation ~75 min ahead (an hour long); late in the evening
// (no room before his bedtime) the clock first moves on to the next evening.
const { hhmm } = await import('../../src/life/clock.js');
async function eveningRoom() {
  for (let i = 0; i < 60 && (Number(hhmm(t.clock.now(), t.world.timezone).slice(0, 2)) >= 21 || Number(hhmm(t.clock.now(), t.world.timezone).slice(0, 2)) < 19); i++) {
    t.clock.advance({ minutes: 30 });
    await t.life.tick();
  }
}
async function maybeCommitted({ chat = t.GROUP, sender = t.A } = {}) {
  await reset();
  await eveningRoom();
  const time = hhmm(t.clock.now() + 75 * 60, t.world.timezone);
  await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time, part: null }, minutes: 60 }));
  const id = `F${++n}`;
  await say(t, { chat, sender, text: 'cinema tonight?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  const d = inviteDecisions(t)[0];
  if (!d || d.status !== 'open') return { d: null, id, time };
  await replied(t, { chat, text: 'maybe, let me see', triggerMsgId: id });
  await idle(t);
  // Tick to its deadline: a "maybe" commits like any decision.
  for (let i = 0; i < 40 && dec(d.id)?.status === 'open'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  return { d: dec(d.id), id, time };
}

section('a maybe that committed → one follow-up turn at the next phone check');
const { d: d1, id: i1, time: time1 } = await maybeCommitted();
check('the maybe committed at its deadline (not by reply)', d1?.status === 'committed' && d1.inviteAnswer === 'maybe' && d1.committed.by !== 'reply', d1?.committed);
const commitEv = (await eventsOf(['decision.committed'])).find(e => e.payload.decisionId === d1.id);
check('…that commit is a follow-up event (phone.onEvent schedules a check)', t.influence.isFollowUpEvent(commitEv) === true);
eq('…due now', t.influence.dueFollowUps(t.clock.now()).map(f => f.decisionId), [d1.id]);
const n0 = turns.length;
await t.life.checkPhoneNow();
const fu = turns.slice(n0).filter(x => x.ctx.followUp);
eq('exactly one follow-up turn', fu.length, 1);
const ctx = fu[0]?.ctx ?? {};
check('…through the catch-up path: catchUp.followUp, the invitation as its trigger, no queue rows',
  ctx.catchUp?.followUp === true && ctx.catchUp.triggerIds?.[0] === i1 && ctx.catchUp.itemIds?.length === 0 && ctx.rawMsg === null);
check('…its note says what he decided', (ctx.promptNotes || []).some(x => x.includes(`Earlier you weren't sure about a movie at Cinema with a friend at ${time1}.`)
  && (d1.committed.optionId === 'stay' ? /can't make it/.test(x) : /coming|join/.test(x))), ctx.promptNotes);
const fev = (await eventsOf(['invite.followed_up'])).find(e => e.payload.decisionId === d1.id);
eq('invite.followed_up {sent:true}; the row is "sent"', [fev?.payload.sent, row(d1.id)], [true, 'sent']);
check('…engine, with the chat origin, no text', fev?.actor === 'engine' && fev.originJid === t.GROUP && !/see you/.test(JSON.stringify(fev.payload)));
const n1 = fuTurns().length;
await t.life.checkPhoneNow();
eq('the next check: no second follow-up', fuTurns().length, n1);

section('a turn that sent nothing still spends the one attempt');
const { d: d2 } = await maybeCommitted();
sendOnTurn = false;
await t.life.checkPhoneNow();
sendOnTurn = true;
const fev2 = (await eventsOf(['invite.followed_up'])).find(e => e.payload.decisionId === d2.id);
eq('[SKIP] / a cap → followed_up {sent:false}, row "skipped"', [fev2?.payload.sent, row(d2.id)], [false, 'skipped']);
const n2 = fuTurns().length;
await t.life.checkPhoneNow();
eq('…never re-offered', fuTurns().length, n2);

section('drops (checked under the lock)');
async function dropCase(name, setup, undo = () => {}, want = 'dropped') {
  const { d } = await maybeCommitted();
  await setup(d);
  const k = fuTurns().length;
  await t.life.checkPhoneNow();
  await undo(d);
  check(`${name} → no turn`, fuTurns().length === k);
  eq(`…row ${want}`, row(d.id), want);
}
await dropCase('he wrote in that chat since the commit', async () => {
  storeMessage({ id: `HS${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'hey all', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
});
// A forgotten invitation is not even due (the due list re-reads it), so nothing is attempted.
await dropCase('the invitation was forgotten (no longer prompt-visible)', async () => {
  const r = t.db.prepare(`SELECT msg_id FROM chat_influence_items WHERE kind='invite' AND category IS NULL ORDER BY id DESC`).get();
  t.db.prepare('UPDATE messages SET no_learn = 1 WHERE id = ?').run(r.msg_id);
}, async () => {}, null);
await dropCase('the group is muted', async () => { muted.add(t.GROUP); }, async () => { muted.delete(t.GROUP); });
await dropCase('the invitation fell out of the transcript window', async () => {
  for (let i = 0; i < 55; i++) storeMessage({ id: `W${++n}`, groupJid: t.GROUP, senderJid: t.B, content: `chatter ${i}`, messageType: 'text', timestamp: t.clock.now() });
});
const { setImitationTarget, clearImitationTarget } = await import('../../src/behavior/imitationState.js');
await setSkills({ imitate: true });
await dropCase('the group is imitating someone (his plans are never voiced as another person)', async () => {
  setImitationTarget(t.GROUP, { targetJid: t.C, label: 'Casey', durationMinutes: 30, enabledBy: 'test', reason: 'test' });
}, async () => { clearImitationTarget(t.GROUP); });
await setSkills({ imitate: false });
await setSkills({ arcs: true });
await dropCase('social frozen by the owner', async () => {
  t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'frozen' } }], { by: 'test' });
}, async () => {
  t.life.appendOwnerBatch([{ type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'natural' } }], { by: 'test' });
});
await setSkills({ arcs: false });

section('not due: the inviter cancelled, or it is too late');
const { d: dc } = await maybeCommitted();
check('(setup) a committed invitation, due', dc?.status === 'committed' && t.influence.dueFollowUps(t.clock.now()).some(f => f.decisionId === dc.id));
{
  t.jev.reset();
  const cancelJev = inviteJev({ perceive: { kind: 'cancel', target: 'him', intensity: 'mid' } });
  t.perceive.setJev(cancelJev.fn);
  await say(t, { chat: t.GROUP, sender: t.A, text: 'not happening today, sorry', id: `CX${++n}`, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  t.perceive.setJev(t.jev.fn);
  if (dc.committed.optionId === 'stay') eq('the inviter cancelled → (staying in already) the follow-up is dropped', row(dc.id), 'dropped');
  else eq('the inviter cancelled → it closed (cancelled)', dec(dc.id)?.status, 'cancelled');
}
check('…and is not due any more', !t.influence.dueFollowUps(t.clock.now()).some(f => f.decisionId === dc.id));
{
  // The cancel lands while the "maybe" is still open: its own lean may commit
  // stay early — still no "can't make it" to the person who called it off.
  await reset();
  await eveningRoom();
  const time = hhmm(t.clock.now() + 75 * 60, t.world.timezone);
  await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time, part: null }, minutes: 60 }));
  const id = `F${++n}`;
  await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema tonight?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  const d = inviteDecisions(t)[0];
  await replied(t, { chat: t.GROUP, text: 'maybe, let me see', triggerMsgId: id });
  await idle(t);
  check('(setup) open, answered maybe', dec(d?.id)?.status === 'open' && dec(d.id).inviteAnswer === 'maybe');
  t.jev.reset();
  t.perceive.setJev(inviteJev({ perceive: { kind: 'cancel', target: 'him', intensity: 'mid' } }).fn);
  await say(t, { chat: t.GROUP, sender: t.A, text: 'ah forget it, not today', id: `CX${++n}`, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  t.perceive.setJev(t.jev.fn);
  for (let i = 0; i < 40 && dec(d.id)?.status === 'open'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  check('(setup) it committed after the cancel', dec(d.id)?.status === 'committed', dec(d.id)?.status);
  eq('maybe → the inviter cancelled → no follow-up due; the row dropped', [t.influence.dueFollowUps(t.clock.now()).some(f => f.decisionId === d.id), row(d.id)], [false, 'dropped']);
  const k = fuTurns().length;
  await t.life.checkPhoneNow();
  eq('…and the phone check runs no turn', fuTurns().length, k);
}
{
  // His own yes / no after the maybe (one the classifier did not settle it with,
  // e.g. a Jev error) is newer than the answer: the follow-up would contradict him.
  await reset();
  await eveningRoom();
  const time = hhmm(t.clock.now() + 75 * 60, t.world.timezone);
  await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time, part: null }, minutes: 60 }));
  const id = `F${++n}`;
  await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema tonight?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  const d = inviteDecisions(t)[0];
  await replied(t, { chat: t.GROUP, text: 'maybe, let me see', triggerMsgId: id });
  await idle(t);
  t.clock.advance({ minutes: 2 });
  storeMessage({ id: `HY${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: "ok I'm in, see you", messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  for (let i = 0; i < 40 && dec(d.id)?.status === 'open'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  check('(setup) the maybe committed at its deadline', dec(d.id)?.status === 'committed' && dec(d.id).inviteAnswer === 'maybe', dec(d.id)?.committed);
  const k = fuTurns().length;
  await t.life.checkPhoneNow();
  eq('a yes he wrote after his maybe (before the commit) → no follow-up turn, row dropped', [fuTurns().length - k, row(d.id)], [0, 'dropped']);
}
const { d: dl } = await maybeCommitted();
const lateAt = (dl.options.find(o => o.id === 'late')?.expiresAt ?? dl.subject.eventAt) + 60;
const due = t.influence.dueFollowUps(lateAt).map(f => f.decisionId);
check('past its time → not due', !due.includes(dl.id), due);

section('an answered invitation he reversed → one follow-up (≤ 1 reversal)');
await reset();
await eveningRoom();
answerNow = 'yes';
const timeR = hhmm(t.clock.now() + 75 * 60, t.world.timezone);
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time: timeR, part: null }, minutes: 60 }));
await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema tonight?', id: 'REV1', verdict: 'now', mentioned: [BOT] });
await idle(t);
const dR = inviteDecisions(t)[0];
await replied(t, { chat: t.GROUP, text: 'yes, in', triggerMsgId: 'REV1' });
await idle(t);
answerNow = 'maybe';
check('(setup) committed go by his reply', dec(dR.id)?.committed?.optionId === 'go' && dec(dR.id).committed.by === 'reply');
check('…a plain "yes" commit is not followed up', !t.influence.dueFollowUps(t.clock.now()).some(f => f.decisionId === dR.id));
const { appendEvent } = await import('../../src/life/eventLog.js');
const revEv = appendEvent({ type: 'decision.reversed', at: t.clock.now(), actor: 'engine', causeId: dec(dR.id).committed.eventId,
  payload: { decisionId: dR.id, from: 'go', to: 'stay', p: 0.8 } });
await stopEngine(t);
await startEngine(t);
check('a reversal is a follow-up event', t.influence.isFollowUpEvent(revEv) === true);
// (A back-out waits out the grace before any tell: 21-back-out tests it.)
const dueR = t.influence.dueFollowUps(t.clock.now() + t.influence.TELL_GRACE_SEC).find(f => f.decisionId === dR.id);
eq('…due, as "not going"', dueR?.outcome, 'not_going');
eq('…the invitation allows one reversal only (inviteMaxRev)', dec(dR.id)?.inviteMaxRev, 1);

section('derived from the projection: due again after a restart');
const before = t.influence.dueFollowUps(t.clock.now()).map(f => f.decisionId).sort();
await stopEngine(t);
await startEngine(t);
const after = t.influence.dueFollowUps(t.clock.now()).map(f => f.decisionId).sort();
eq('the same follow-ups are due after the restart', after, before);

section('phone.onEvent: a follow-up commit schedules a check within minutes (unit)');
const { createPhone } = await import('../../src/life/phone.js');
const armed = [];
const phone = createPhone({
  getSock: () => sock, getState: () => t.life.getState(), world: t.world,
  setTimer: (fn, ms) => { armed.push(ms); return { fn }; }, clearTimer: () => {},
  followUps: { due: () => [], prepare: () => null, finish: () => {}, isDueEvent: (ev) => ev.payload?.decisionId === 7 },
  appendEvent: () => ({ id: 1 }),
});
await phone.start();
const nextBefore = phone.getNext();
await phone.onEvent({ type: 'decision.committed', at: t.clock.now(), id: 9, payload: { decisionId: 7 } });
const nx = phone.getNext();
check('rescheduled: reason follow_up, ~3 min out', nx?.reason === 'follow_up' && nx.at - t.clock.now() <= 5 * 60 && nx.at > t.clock.now(), { nextBefore, nx });
await phone.onEvent({ type: 'decision.committed', at: t.clock.now(), id: 10, payload: { decisionId: 8 } });
eq('…another decision\'s commit changes nothing', phone.getNext()?.reason, 'follow_up');
phone.stop();

section('a DM inviter who left every shared group gets no follow-up (an outsider now)');
{
  const { d } = await maybeCommitted({ chat: t.B, sender: t.B });
  check('(setup) the DM maybe committed and is due', d?.status === 'committed' && t.influence.dueFollowUps(t.clock.now()).some(f => f.decisionId === d.id), d?.status);
  const membership = await import('../../src/memory/membership.js');
  membership.onParticipantsUpdate({ id: t.GROUP, participants: [t.B], action: 'remove' });
  eq('(setup) B shares no group with him now', membership.groupsOf(t.B).length, 0);
  const k = fuTurns().length;
  await t.life.checkPhoneNow();
  eq('→ no follow-up turn; the row dropped', [fuTurns().length - k, row(d.id)], [0, 'dropped']);
}

report();
void start;
