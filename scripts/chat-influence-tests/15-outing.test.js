// 012 invitations, the outing (plan §P2.4): a committed "go" amends his plan
// through 009/010's outing machinery — the outing and its trips carry the inviter
// as subjectJid, the outing block's kind is the real activity kind (social /
// leisure class; an eat-out skips the dinner at home). His inner line names the
// plan (with the inviter's own push name) only where the inviter is — the
// inviting group, and with arcs on their DM — never in a chat without them. No
// cast tension from an invitation's reversal. The inviter cancelling closes a
// committed one before the point of no return, also inside 009's chat cooldown.
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied, setSkills,
  seedGroups, stopEngine, startEngine, eventsOf, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
let perceiveAs = 'invite';
const jev = inviteJev({ perceive: () => ({ kind: perceiveAs, target: 'him', intensity: 'mid' }), answer: 'yes' });
const t = await bootInfluence({ jev, areas: { invites: true, mood: false, sleep: false, work: false } });
const [THIRD] = await seedGroups([{ jid: '120363000000770003@g.us', name: 'Third group', members: [t.B, t.C] }], { at: Date.UTC(2026, 6, 1) / 1000 });
const { resolveAudience } = await import('../../src/memory/recall.js');
const { hhmm } = await import('../../src/life/clock.js');
const { activityClass } = await import('../../src/life/vitals.js');
const tz = t.world.timezone;
const BOT = '10000000000@s.whatsapp.net';
t.config.chatInfluence.perSenderPerHour = 20;
t.config.chatInfluence.perChatPerHour = 60;
t.config.chatInfluence.invitesMaxPerDay = 10;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();
const dec = (id) => t.life.getState().decisions.get(id);
const line = (chatJid) => t.life.innerStateLine(resolveAudience({ chatJid }));

section('a committed "go" amends his plan with the inviter as subject');
// 19:50 (he is free at home from 18:42; the base plan's own evening outing starts later).
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tonight', time: '19:50', part: null }, minutes: 70, kind: 'dinner', place: null }));
await say(t, { chat: t.GROUP, sender: t.A, text: 'dinner at 7:50?', id: 'O1', verdict: 'now', mentioned: [BOT] });
await idle(t);
const d = inviteDecisions(t)[0];
await replied(t, { chat: t.GROUP, text: 'yes!', triggerMsgId: 'O1' });
await idle(t);
eq('(setup) committed go by reply, an eat-out', [dec(d.id)?.committed?.optionId, d.kind], ['go', 'eat-out']);
// Before the outing is applied (at the point of no return), his line names the plan where the inviter is.
const pre = d.ponrAt;
for (let i = 0; i < 20 && t.clock.now() < pre; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
const plan = t.life.getState().plan;
check('the plan was amended for the outing (its own blocks)', plan?.blocks?.some(b => b.fromAmendment && b.placeId === d.subject.placeId), plan?.blocks);
const own = plan.blocks.filter(b => b.fromAmendment);
check('…its outing and trips carry the inviter as subjectJid', own.length >= 2 && own.every(b => b.subjectJid === t.A), own);
const outing = own.find(b => b.kind !== 'commute');
eq('…the outing block is the real kind (eat-out), a social / meal class', [outing?.kind, ['social', 'leisure', 'meal'].includes(activityClass(outing?.kind))], ['eat-out', true]);
check('…an eat-out outing: no dinner at home after it', !plan.blocks.some(b => b.kind === 'dinner' && b.start >= (outing?.start ?? 0)));

section('his line names the plan only where the inviter is');
// Go back to the moment before the outing starts: tick until he is on his way / there.
const lG = line(t.GROUP);
const lT = line(THIRD);
check('in the inviting group: "with Avery"', /Avery/.test(lG), lG);
check('in a group without the inviter: no name, no plan details', !/Avery/.test(lT) && !/eat|restaurant|dinner out/i.test(lT), lT);
await setSkills({ arcs: true });
await new Promise(r => setTimeout(r, 50));       // 006's canUseIn resolves once (lazy import)
const lD = line(t.A);
check('with arcs on (006\'s rule), in the inviter\'s DM it is told, by their own name', /Avery/.test(lD), lD);
await setSkills({ arcs: false });

section('no cast tension from an invitation\'s reversal');
const tensionBefore = t.life.getState().cast.get('cast:flatmate')?.metrics?.tension;
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '20:00', part: null }, people: ['my flatmate'], minutes: 90 }));
await say(t, { chat: t.OTHER, sender: t.C, text: 'cinema tomorrow with the flatmate?', id: 'O2', verdict: 'now', mentioned: [BOT] });
await idle(t);
const d2 = inviteDecisions(t)[0];
await replied(t, { chat: t.OTHER, text: 'yes for sure', triggerMsgId: 'O2' });
await idle(t);
eq('(setup) the flatmate is in it, committed go', [d2?.subject.castIds, dec(d2.id)?.committed?.optionId], [['cast:flatmate'], 'go']);
const { appendEvent } = await import('../../src/life/eventLog.js');
appendEvent({ type: 'decision.reversed', at: t.clock.now(), actor: 'engine', causeId: dec(d2.id).committed.eventId,
  payload: { decisionId: d2.id, from: 'go', to: 'stay', p: 0.8 } });
await stopEngine(t);
await startEngine(t);
eq('reversed, and the flatmate\'s tension did not move', [dec(d2.id)?.committed?.optionId, t.life.getState().cast.get('cast:flatmate')?.metrics?.tension],
  ['stay', tensionBefore]);

section('the inviter cancels: a committed one closes before the point of no return, inside 009\'s cooldown');
// (020 decision 16: a chat lean on a promise only when the line pushes against it, so this line does.)
await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'tomorrow', time: '21:00', part: null }, minutes: 60 }));
await say(t, { chat: t.GROUP, sender: t.B, text: 'movie tomorrow at 9?', id: 'O3', verdict: 'now', mentioned: [BOT] });
await idle(t);
const d3 = inviteDecisions(t)[0];
await replied(t, { chat: t.GROUP, text: 'yes', triggerMsgId: 'O3' });
await idle(t);
perceiveAs = 'none';
await say(t, { chat: t.GROUP, sender: t.B, text: 'maybe skip the cinema tomorrow, it looks packed', id: 'O4', verdict: 'now', mentioned: [BOT] });
const trig = (await eventsOf(['chat.trigger'])).filter(e => e.payload.decisionId === d3.id);
check('(setup) 009\'s matcher took a chat lean on it just now (its cooldown runs)', trig.length >= 1, trig.length);
perceiveAs = 'cancel';
await say(t, { chat: t.GROUP, sender: t.B, text: 'sorry, cant do tomorrow after all', id: 'O5', verdict: 'now', mentioned: [BOT] });
await idle(t);
const ex = (await eventsOf(['decision.expired'])).find(e => e.payload.decisionId === d3.id);
eq('closed: expired {inviter_cancelled}, status cancelled', [ex?.payload.reason, dec(d3.id)?.status], ['inviter_cancelled', 'cancelled']);
const cptr = (await eventsOf(['chat.perceived'])).find(e => e.payload.kind === 'cancel');
check('…caused by the inviter\'s cancel pointer (same chat, same person)', ex?.causeId === cptr?.id && cptr?.subjectJid === t.B);
perceiveAs = 'cancel';
await say(t, { chat: t.GROUP, sender: t.C, text: 'not coming to anything today', id: 'O6', verdict: 'now', mentioned: [BOT] });
await idle(t);
check('someone else\'s "cancel" touches nothing (no pointer for it)', !(await eventsOf(['chat.perceived'])).some(e => e.payload.msgId === 'O6'));

report();
void hhmm; void tz;
