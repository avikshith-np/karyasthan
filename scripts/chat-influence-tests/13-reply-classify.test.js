// 012 invitations, his reply (plan §P2.6): the invitation waiting for his word
// rides along as one more question of 009's claim call — yes → go `by:'reply'`,
// late → late, no → stay, maybe → it stays open; the claim prefilter is bypassed
// only while one is waiting; an answered reply leaves no claim row and no
// claim.flagged pointer; the claims hourly cap doesn't block it; `they_said` is
// the invitation read at classification time (gone → not asked). Never for an
// imitated, a follow-up or an unsent / DRY_RUN reply; ≤ 3 tries per invitation;
// a Jev error records nothing; controls changed since the open → expired
// {frozen|paused}; never answered → expired {unanswered} at its deadline.
import {
  setupScratchDb, bootInfluence, say, sent, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied, setSkills,
  eventsOf, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
let answerFor = () => 'yes';
let claimKind = 'none';
const jev = inviteJev({ answer: (req) => answerFor(req), claim: 'none' });
const t = await bootInfluence({ jev, areas: { invites: true, mood: false, sleep: false, work: false } });
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tonight', time: '21:00', part: null } }));
const BOT = '10000000000@s.whatsapp.net';
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.invitesMaxPerDay = 10;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();
let n = 0;
const claimCalls = () => t.jev.calls.filter(c => c.caller === 'life.claim');
const claimRows = () => t.db.prepare('SELECT COUNT(*) AS n FROM life_claims').get().n;
void claimKind;

async function reset() {
  for (const r of t.db.prepare(`SELECT pointer_event_id AS id FROM chat_influence_items WHERE kind = 'invite' AND pointer_event_id IS NOT NULL`).all()) {
    try { t.life.revertEvent(r.id, { reason: 'test reset', by: 'test' }); } catch { /* already out */ }
  }
  t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'invite'`).run();
}

async function invite({ chat = t.GROUP, sender = t.A } = {}) {
  await reset();
  const id = `I${++n}`;
  await say(t, { chat, sender, text: 'cinema tonight at 9?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  return { d: inviteDecisions(t)[0], id };
}

const dec = (id) => t.life.getState().decisions.get(id);

section('yes / late / no / maybe');
for (const [answer, text, want] of [['yes', 'yeah sure', 'go'], ['late', 'sure, might be a bit late though', 'late'], ['no', 'nah, not today', 'stay']]) {
  const { d, id } = await invite();
  answerFor = () => answer;
  await replied(t, { chat: t.GROUP, text, triggerMsgId: id });
  await idle(t);
  const x = dec(d.id);
  eq(`"${text}" (${answer}) → committed ${want}, by reply`, [x?.status, x?.committed?.optionId, x?.committed?.by, x?.inviteAnswer], ['committed', want, 'reply', answer]);
}
const { d: dm, id: im } = await invite();
answerFor = () => 'maybe';
await replied(t, { chat: t.GROUP, text: 'maybe, let me see', triggerMsgId: im });
await idle(t);
eq('"maybe" → stays open, answer maybe', [dec(dm.id)?.status, dec(dm.id)?.inviteAnswer], ['open', 'maybe']);
const ans = (await eventsOf(['invite.answered'])).at(-1);
check('invite.answered: engine, caused by the decision, its chat origin, no text', ans?.actor === 'engine' && ans.causeId === dm.id
  && ans.originJid === t.GROUP && !/let me see/.test(JSON.stringify(ans.payload)));
const req = claimCalls().at(-1);
check('they_said is the invitation (fenced), his reply is his_reply', /cinema tonight at 9/.test(req?.state?.they_said ?? '')
  && /STORY_DATA/.test(req.state.they_said) && /let me see/.test(req.state.his_reply), req?.state);
answerFor = () => 'maybe';
await replied(t, { chat: t.GROUP, text: 'maybe, will know later', triggerMsgId: im });
await idle(t);
eq('…a second "maybe" changes nothing', [dec(dm.id)?.status, dec(dm.id)?.inviteAnswer], ['open', 'maybe']);
answerFor = () => 'yes';
await replied(t, { chat: t.GROUP, text: "ok I'm in, see you at 9", triggerMsgId: im });
await idle(t);
const xm = dec(dm.id);
eq('…a later "yes" settles the maybe: committed go, by reply, the answer now yes', [xm?.status, xm?.committed?.optionId, xm?.committed?.by, xm?.inviteAnswer],
  ['committed', 'go', 'reply', 'yes']);
eq('…two invite.answered events, the latest wins', (await eventsOf(['invite.answered'])).filter(e => e.payload.decisionId === dm.id).map(e => e.payload.answer), ['maybe', 'yes']);
eq('…not a follow-up case (he said it himself)', t.influence.dueFollowUps(t.clock.now()).filter(f => f.decisionId === dm.id).length, 0);
const cAfter = claimCalls().length;
await replied(t, { chat: t.GROUP, text: 'no wait', triggerMsgId: im });
await idle(t);
eq('…after a definite answer it is no longer asked', claimCalls().length, cAfter);

section('the decision opens only after his reply went out (a slow clerk)');
{
  await reset();
  let release;
  const gate = new Promise(r => { release = r; });
  await inviteClerk(async () => { await gate; return inviteExtraction({ when: { date: null, relative: 'tonight', time: '21:00', part: null } }); });
  const id = `I${++n}`;
  await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema tonight at 9?', id, verdict: null, mentioned: [BOT] });
  t.life.gateOutcome(t.GROUP, id, 'now');
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  answerFor = () => 'yes';
  await sent(t, { chat: t.GROUP, text: 'yeah sure', id: `SL${n}` });
  const p = t.life.onReplySent({ chatJid: t.GROUP, text: 'yeah sure', triggerText: '', msgId: `SL${n}`, triggerMsgId: id });
  t.clock.advance({ seconds: 4 });               // the clerk answers 4 s after the reply went out
  release();
  await p;
  await idle(t);
  const d = inviteDecisions(t)[0];
  check('(setup) it opened after the reply was sent', d && d.opensAt > t.clock.now() - 10, d && { opensAt: d.opensAt });
  eq('his reply is still taken as the answer: committed go, by reply', [d?.status, d?.committed?.optionId, d?.committed?.by, d?.inviteAnswer],
    ['committed', 'go', 'reply', 'yes']);
  await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tonight', time: '21:00', part: null } }));
}

section('the prefilter bypass only while an invitation waits');
await reset();
const c0 = claimCalls().length;
await replied(t, { chat: t.GROUP, text: 'yeah sure' });
eq('no invitation waiting: "yeah sure" never reaches Jev', claimCalls().length, c0);

section('an answered reply leaves no claim row and no claim.flagged; the hourly cap does not block it');
const { d: dc, id: ic } = await invite();
const rows0 = claimRows();
const flagged0 = (await eventsOf(['claim.flagged'])).length;
t.config.life.claimsMaxPerHour = 0;
answerFor = () => 'yes';
await replied(t, { chat: t.GROUP, text: "yes I'll be there at 9 tonight", triggerMsgId: ic });
await idle(t);
eq('committed (the claims cap is 0)', dec(dc.id)?.committed?.optionId, 'go');
eq('…no life_claims row, no claim.flagged', [claimRows() - rows0, (await eventsOf(['claim.flagged'])).length - flagged0], [0, 0]);
t.config.life.claimsMaxPerHour = 10;

section('never for an imitated, a follow-up or an unsent / DRY_RUN reply');
const { d: dn, id: inn } = await invite();
const c1 = claimCalls().length;
await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: inn, imitating: true });
await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: inn, followUp: true });
await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: inn, dryRun: true });
await t.life.onReplySent({ chatJid: t.GROUP, text: 'yeah sure', msgId: null, triggerMsgId: inn });
await idle(t);
eq('none of them asked Jev', claimCalls().length, c1);
eq('…and the invitation still waits', [dec(dn.id)?.status, dec(dn.id)?.inviteAnswer ?? null], ['open', null]);
const cf = claimCalls().length;
await replied(t, { chat: t.GROUP, text: "I'm going home at 9 tonight", followUp: true });
eq('a follow-up reply is never claim-flagged either', claimCalls().length, cf);

section('replies without a yes/no/maybe cue are not asked about and spend no tries');
const { d: dq, id: iq } = await invite();
const cq = claimCalls().length;
for (const text of ['haha', 'same', 'true that']) await replied(t, { chat: t.GROUP, text, triggerMsgId: iq });
eq('three cue-less replies → no Jev call', claimCalls().length, cq);
answerFor = () => 'yes';
await replied(t, { chat: t.GROUP, text: 'yes ok', triggerMsgId: iq });
await idle(t);
eq('…then his "yes" still commits it', dec(dq.id)?.committed?.optionId, 'go');
const { d: dn2, id: in2 } = await invite();
void dn2;

section('≤ 3 tries per invitation; a Jev error records nothing');
answerFor = () => 'none';
const c1b = claimCalls().length;
for (let i = 0; i < 4; i++) await replied(t, { chat: t.GROUP, text: 'haha ok sure', triggerMsgId: in2 });
await idle(t);
eq('three classification calls at most', claimCalls().length - c1b, 3);
const { d: de, id: ie } = await invite();
t.jev.fail(new Error('boom'));
await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: ie });
await idle(t);
t.jev.recover();
eq('Jev error → still waiting, no answer', [dec(de.id)?.status, dec(de.id)?.inviteAnswer ?? null], ['open', null]);

section('they_said read at classification time: a revoked invitation is not asked about');
const { d: dr, id: ir } = await invite();
t.db.prepare('UPDATE messages SET no_learn = 1 WHERE id = ?').run(ir);
const c2 = claimCalls().length;
answerFor = () => 'yes';
await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: ir });
await idle(t);
eq('no Jev call, nothing committed', [claimCalls().length - c2, dec(dr.id)?.committed ?? null], [0, null]);
t.db.prepare('UPDATE messages SET no_learn = 0 WHERE id = ?').run(ir);

section('controls changed since it opened → expired {frozen | paused}');
await setSkills({ arcs: true });
for (const [type, payload, reason] of [['director.fate_set', { category: 'social', mode: 'frozen' }, 'frozen'], ['director.paused', {}, 'paused']]) {
  const { d, id } = await invite();
  t.life.appendOwnerBatch([{ type, at: t.clock.now(), payload }], { by: 'test' });
  answerFor = () => 'yes';
  await replied(t, { chat: t.GROUP, text: 'yeah sure', triggerMsgId: id });
  await idle(t);
  const ex = (await eventsOf(['decision.expired'])).find(e => e.payload.decisionId === d.id);
  // (the projector closes a 'frozen' one as cancelled, like 010's refused consequences)
  eq(`${reason} → expired {${reason}}, nothing committed`, [['expired', 'cancelled'].includes(dec(d.id)?.status), ex?.payload.reason, dec(d.id)?.committed ?? null], [true, reason, null]);
  t.life.appendOwnerBatch([type === 'director.paused'
    ? { type: 'director.resumed', at: t.clock.now(), payload: {} }
    : { type: 'director.fate_set', at: t.clock.now(), payload: { category: 'social', mode: 'natural' } }], { by: 'test' });
}
await setSkills({ arcs: false });

section('never answered → expired {unanswered} at its deadline');
const { d: du } = await invite();
for (let i = 0; i < 12 && dec(du.id)?.status === 'open'; i++) {
  t.clock.advance({ minutes: 15 });
  await t.life.tick();
}
const exU = (await eventsOf(['decision.expired'])).find(e => e.payload.decisionId === du.id);
eq('expired unanswered, no outing', [dec(du.id)?.status, exU?.payload.reason], ['expired', 'unanswered']);
check('…not before its deadline', exU && exU.at >= du.decideBy - 1 && exU.at <= du.decideBy + 1, { at: exU?.at, decideBy: du.decideBy });

report();
