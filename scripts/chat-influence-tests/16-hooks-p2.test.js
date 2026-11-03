// 012 invitations and 006's deletions (plan §P1.5 applied to P2): forgetting,
// revoking or editing the invitation withdraws its row and reverts its pointer —
// the decision, his answer, the outing amendment and any follow-up cascade out —
// also when the deletion lands while the extraction / open is still running (the
// post-await re-read). Purging the inviter deletes the rows and redacts the
// decision chain; a full rebuild folds the redacted invite.answered /
// invite.followed_up as no-ops.
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied,
  eventsOf, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
let perceiveAs = 'invite';
let answerAs = 'yes';
const t = await bootInfluence({ jev: inviteJev({ perceive: () => ({ kind: perceiveAs, target: 'him', intensity: 'mid' }), answer: () => answerAs }),
  areas: { invites: true, mood: false, sleep: false, work: false } });
const rs = await import('../../src/memory/relationshipStore.js');
const BOT = '10000000000@s.whatsapp.net';
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.invitesMaxPerDay = 10;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();
const settle = () => new Promise(r => setImmediate(r));
const row = (id) => t.db.prepare(`SELECT * FROM chat_influence_items WHERE msg_id = ? AND category IS NULL`).get(id);
const excluded = (id) => t.life.getState().excluded.has(id);
const dec = (id) => t.life.getState().decisions.get(id);
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null }, minutes: 60 }));

async function invited(id, { chat = t.GROUP, sender = t.A, answer = true, at } = {}) {
  await say(t, { chat, sender, text: 'cinema tomorrow at 8?', id, verdict: 'now', mentioned: [BOT], ...(at ? { at } : {}) });
  await idle(t);
  const d = inviteDecisions(t)[0];
  if (answer) {
    await replied(t, { chat, text: 'yes!', triggerMsgId: id });
    await idle(t);
  }
  return d;
}

section('revoke: the decision and everything after it cascade out');
const d1 = await invited('H1');
const ptr1 = (await eventsOf(['chat.perceived'])).find(e => e.payload.msgId === 'H1');
check('(setup) committed go by his reply', dec(d1.id)?.committed?.by === 'reply');
const chain = (await eventsOf(['decision.opened', 'decision.lean', 'decision.committed', 'invite.answered'])).filter(e => e.id === d1.id || e.payload.decisionId === d1.id);
rs.onMessageRevoked('H1', t.GROUP);
await settle();
eq('the row: reverted', row('H1')?.status, 'reverted');
check('…the pointer and the whole decision chain are out of the projection', excluded(ptr1.id) && chain.every(e => excluded(e.id)), chain.map(e => [e.type, excluded(e.id)]));
check('…the decision is gone from the projection', !dec(d1.id));
eq('…and nothing is due as a follow-up', t.influence.dueFollowUps(t.clock.now()).length, 0);

section('forget (a DM invitation)');
// "forget that" fences the sender's last few messages by the wall clock: this one
// is stamped now (wall time) and names tomorrow's date explicitly.
const { dateKey } = await import('../../src/life/clock.js');
await inviteClerk(() => inviteExtraction({ when: { date: dateKey(t.clock.now() + 86400, t.world.timezone), relative: null, time: '20:00', part: null }, minutes: 60 }));
const d2 = await invited('H2', { chat: t.B, sender: t.B, at: Math.floor(Date.now() / 1000) });
check('(setup) the DM invitation opened and committed', dec(d2?.id)?.status === 'committed' && d2.origins?.[0]?.jid === t.B);
rs.forgetRecent(t.B, t.B);
await settle();
check('forget → withdrawn → reverted; the decision is gone', row('H2')?.status === 'reverted' && !dec(d2.id), row('H2'));
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null }, minutes: 60 }));

section('edit');
const d3 = await invited('H3', { answer: false });
check('(setup) open', dec(d3?.id)?.status === 'open');
rs.onMessageEdited('H3', 'actually never mind', t.GROUP);
await settle();
check('edit → reverted; the open decision is gone', row('H3')?.status === 'reverted' && !dec(d3.id));

section('a revoke while the extraction is still running leaves nothing');
let release;
const hold = new Promise(r => { release = r; });
await inviteClerk(async () => { await hold; return inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null }, minutes: 60 }); });
const before = (await eventsOf(['chat.perceived', 'decision.opened'])).length;
await say(t, { chat: t.GROUP, sender: t.C, text: 'cinema tomorrow at 8?', id: 'H4', verdict: null, mentioned: [BOT] });
t.life.gateOutcome(t.GROUP, 'H4', 'now');
await new Promise(r => setTimeout(r, 30));
rs.onMessageRevoked('H4', t.GROUP);
await settle();
release();
await idle(t);
eq('no pointer, no decision, no row', [(await eventsOf(['chat.perceived', 'decision.opened'])).length - before, row('H4') ?? null], [0, null]);

section('revoking the inviter\'s cancel undoes what the cancel did (its lean, an early commit, the follow-up)');
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null }, minutes: 60 }));
{
  const d = await invited('HC1', { chat: t.OTHER, answer: false });
  answerAs = 'maybe';
  await replied(t, { chat: t.OTHER, text: 'maybe, let me see', triggerMsgId: 'HC1' });
  await idle(t);
  check('(setup) open, answered maybe', dec(d?.id)?.status === 'open' && dec(d.id).inviteAnswer === 'maybe');
  const leanBefore = JSON.stringify(dec(d.id).lean);
  const lastBefore = t.life.getState().lastEventId;
  perceiveAs = 'cancel';
  await say(t, { chat: t.OTHER, sender: t.A, text: 'ah not coming tomorrow after all, sorry', id: 'HC2', verdict: 'now', mentioned: [BOT] });
  await idle(t);
  await new Promise(r => setTimeout(r, 30));
  perceiveAs = 'invite';
  const caused = (await eventsOf(['chat.trigger', 'decision.lean', 'decision.committed', 'decision.expired'], lastBefore)).filter(e => e.payload.decisionId === d.id);
  const cptr = (await eventsOf(['chat.perceived'], lastBefore)).find(e => e.payload.kind === 'cancel');
  eq('(setup) the cancel\'s lean committed stay early', [dec(d.id)?.status, dec(d.id)?.committed?.optionId, dec(d.id)?.committed?.by], ['committed', 'stay', 'early']);
  check('(setup) the cancel pushed a lean, caused by its own pointer (no chat.trigger of its own)', !!cptr && caused.some(e => e.type === 'decision.lean' && e.causeId === cptr.id)
    && !caused.some(e => e.type === 'chat.trigger'), caused.map(e => [e.type, e.causeId]));
  eq('…no "can\'t make it" follow-up to the person who called it off', t.influence.dueFollowUps(t.clock.now()).filter(f => f.decisionId === d.id).length, 0);
  rs.onMessageRevoked('HC2', t.OTHER);
  await settle();
  await new Promise(r => setTimeout(r, 30));
  check('the revoke takes out the pointer and everything the cancel caused', excluded(cptr.id) && caused.every(e => excluded(e.id)), caused.map(e => [e.type, excluded(e.id)]));
  eq('…the cancel row is reverted', t.db.prepare(`SELECT status FROM chat_influence_items WHERE msg_id = 'HC2'`).get()?.status, 'reverted');
  const back = dec(d.id);
  eq('…the decision is back to its pre-cancel status and lean', [back?.status, JSON.stringify(back?.lean)], ['open', leanBefore]);
  eq('…and no follow-up is due', t.influence.dueFollowUps(t.clock.now()).filter(f => f.decisionId === d.id).length, 0);
  answerAs = 'yes';
}

section('purge of the inviter: rows deleted, the chain redacted, a rebuild folds it');
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '21:00', part: null }, minutes: 60 }));
const d5 = await invited('H5', { sender: t.C, chat: t.OTHER });
check('(setup) C\'s invitation committed', dec(d5?.id)?.status === 'committed' && d5.subjectJid === t.C);
const { appendEvent } = await import('../../src/life/eventLog.js');
appendEvent({ type: 'invite.followed_up', at: t.clock.now(), actor: 'engine', causeId: dec(d5.id).committed.eventId, subjectJid: t.C,
  payload: { decisionId: d5.id, outcome: 'going', sent: true } });
const chain5 = (await eventsOf(['chat.perceived', 'decision.opened', 'decision.lean', 'decision.committed', 'invite.answered', 'invite.followed_up']))
  .filter(e => e.id === d5.id || e.payload?.decisionId === d5.id || e.subjectJid === t.C).map(e => e.id);
rs.purgePerson(t.C, 'test', 'test');
eq('C\'s rows are deleted', t.db.prepare(`SELECT COUNT(*) AS n FROM chat_influence_items WHERE sender_jid = ?`).get(t.C).n, 0);
const red = (await eventsOf(['chat.perceived', 'decision.opened', 'decision.lean', 'decision.committed', 'invite.answered', 'invite.followed_up']))
  .filter(e => chain5.includes(e.id));
check('…the decision chain naming C is redacted (pointer, decision, lean, answer, commit, follow-up)', red.length >= 6 && red.every(e => e.redacted),
  red.map(e => [e.type, e.redacted]));
const projector = await import('../../src/life/projector.js');
let rebuilt = null;
try { rebuilt = projector.rebuild({ world: t.world, useSnapshot: false }); } catch (err) { rebuilt = err; }
check('…and a full rebuild folds the redacted answer / follow-up cleanly', rebuilt && !(rebuilt instanceof Error)
  && ![...(rebuilt.decisions?.values?.() || [])].some(d => d.subjectJid === t.C), rebuilt?.message);

report();
