// 020 §A4: he backed out of a plan made with a real person in a chat → one message there.
// An accepted invitation that falls through (he rethought it, he couldn't go, the owner called it
// off) or an adopted claim naming them gets ONE follow-up turn through the catch-up path (chat lock,
// ctx.followUp, the can't-make-it note), once per broken plan, across a restart. None for a "no" or a
// "maybe"; none with chatInfluence.tellBackOut off; none when muted, the person left, imitating, his
// own line already said he can't, or the time has passed; a solo adopted claim isn't told. An
// invitation he never answered that the owner picks or calls off: the inviter hears once. Told, then
// the plan comes back: one correction. A cap or a cooldown spends nothing (the next check retries);
// a turn that ran does. The send itself is the normal path (the stub stands in for processMessage;
// DRY_RUN lives there, so here: the phone itself never sends, a turn with nothing out counts as not sent).
// Example world, fake clock, stubbed Jev / clerk, no network.
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions, replied, setSkills,
  stopEngine, startEngine, eventsOf, fakeSock, jevChoice, section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const sock = fakeSock();
const turns = [];
let sendOnTurn = true;
let onTurn = null;
let answerNow = 'yes';
const muted = new Set();
const { storeMessage } = await import('../../src/memory/messageStore.js');
const { appendEvent } = await import('../../src/life/eventLog.js');
const { hhmm } = await import('../../src/life/clock.js');
const decisions = await import('../../src/life/decisions.js');
const baseJev = inviteJev({ answer: () => answerNow });
const t = await bootInfluence({
  jev: baseJev,
  areas: { invites: true, mood: false, sleep: false, work: false },
  getSock: () => sock,
  isGroupMuted: (j) => muted.has(j),
  processMessage: async (s, msg, ctx) => {
    turns.push({ msg, ctx });
    if (onTurn) await onTurn(msg, ctx);
    if (sendOnTurn && ctx.followUp) {
      storeMessage({ id: `BO${turns.length}`, groupJid: ctx.chatJid, senderJid: t.bot.pn, content: 'sorry, can not make it', messageType: 'text',
        timestamp: t.clock.now(), isFromSelf: true });
    }
  },
});
const { config } = t;
t.influence.__setTellMaxForTest(1000);   // the day's cap has its own section
const BOT = '10000000000@s.whatsapp.net';
config.chatInfluence.perSenderPerHour = 20;
config.chatInfluence.perChatPerHour = 60;
config.chatInfluence.invitesMaxPerDay = 100;
config.warmupEnabled = false;
config.maxPerGroupHour = 0;
config.maxGlobalHour = 0;
t.clock.advance({ minutes: 60 });                 // 19:00, home from the office
await t.life.tick();
let n = 0;
const dec = (id) => t.life.getState().decisions.get(id);
const fu = () => turns.filter(x => x.ctx.followUp);
const row = (id) => t.db.prepare(`SELECT followup_status AS s FROM chat_influence_items WHERE decision_id = ? AND category IS NULL`).get(id)?.s ?? null;
const told = (id) => t.db.prepare(`SELECT value FROM chat_influence_state WHERE key = ?`).get(`backout:${id}`)?.value ?? null;

const seenInvites = new Set();
async function reset() {
  for (const r of t.db.prepare(`SELECT pointer_event_id AS id FROM chat_influence_items WHERE kind = 'invite' AND pointer_event_id IS NOT NULL`).all()) {
    try { t.life.revertEvent(r.id, { reason: 'test reset', by: 'test' }); } catch { /* already out */ }
  }
  t.db.prepare(`DELETE FROM chat_influence_items WHERE kind = 'invite'`).run();
}
// The next day's early evening (a day's own plans are out of the way).
async function nextEvening() {
  for (let i = 0; i < 96; i++) {
    t.clock.advance({ minutes: 15 });
    await t.life.tick();
    if (hhmm(t.clock.now(), t.world.timezone).startsWith('19:0') && i > 8) return;
  }
}
async function eveningRoom() {
  const h = () => Number(hhmm(t.clock.now(), t.world.timezone).slice(0, 2));
  for (let i = 0; i < 60 && (h() >= 21 || h() < 19); i++) { t.clock.advance({ minutes: 30 }); await t.life.tick(); }
}
// An invitation ~75 min ahead, answered (or not).
async function invited({ answer = 'yes', chat = t.GROUP, sender = t.A, keep = false, ahead = 75, tries = 4 } = {}) {
  if (!keep) {
    await reset();
    await eveningRoom();
  }
  const time = hhmm(t.clock.now() + ahead * 60, t.world.timezone);
  await inviteClerk(() => inviteExtraction({ when: { date: null, relative: 'today', time, part: null }, minutes: 60 }));
  const id = `B${++n}`;
  await say(t, { chat, sender, text: 'cinema tonight?', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  const d = inviteDecisions(t).find(x => !seenInvites.has(x.id));
  // The day's own plans hold that time: the next evening has room.
  if (!d && !keep && tries > 0) {
    await nextEvening();
    return invited({ answer, chat, sender, keep, ahead, tries: tries - 1 });
  }
  if (d) seenInvites.add(d.id);
  if (answer) {
    answerNow = answer;
    await replied(t, { chat, text: answer === 'no' ? 'nah not today' : answer === 'maybe' ? 'maybe, let me see' : 'yes, in', triggerMsgId: id });
    await idle(t);
  }
  t.clock.advance({ minutes: 1 });
  return { d: dec(d?.id), id };
}
// The log says so and the engine restarts: the fold, phone.onEvent's check and a restart are one path here.
// Then the grace before any tell passes (its own test below).
const grace = () => t.clock.advance({ seconds: t.influence.TELL_GRACE_SEC });
async function closeWith(d, reason) {
  const ev = appendEvent({ type: 'decision.expired', at: t.clock.now(), actor: 'engine', causeId: d.committed?.eventId ?? d.id,
    ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}), payload: { decisionId: d.id, reason } });
  await stopEngine(t);
  await startEngine(t);
  grace();
  return ev;
}
async function reverseTo(d, to = 'stay') {
  const ev = appendEvent({ type: 'decision.reversed', at: t.clock.now(), actor: 'engine', causeId: d.committed?.eventId ?? d.id,
    ...(d.subjectJid ? { subjectJid: d.subjectJid } : {}), payload: { decisionId: d.id, from: d.committed.optionId, to, p: 0.95 } });
  await stopEngine(t);
  await startEngine(t);
  grace();
  return ev;
}
const isDue = (id, at = t.clock.now()) => t.influence.dueFollowUps(at).some(f => f.decisionId === id);
const noteOf = (turn) => (turn?.ctx?.promptNotes ?? []).join(' ');
async function check1(name, id, { trigger = null } = {}) {
  const k = fu().length;
  await t.life.checkPhoneNow();
  const mine = fu().slice(k).filter(x => x.ctx.followUp.decisionId === id);
  eq(`${name}: exactly one follow-up turn`, mine.length, 1);
  check(`${name}: the can't-make-it note, through the catch-up path`, /can't make it/.test(noteOf(mine[0])) && mine[0]?.ctx.catchUp?.followUp === true
    && (trigger === null || mine[0].ctx.catchUp.triggerIds[0] === trigger), JSON.stringify(mine[0]?.ctx));
  const k2 = fu().length;
  await t.life.checkPhoneNow();
  eq(`${name}: the next check sends nothing`, fu().length, k2);
  await stopEngine(t);
  await startEngine(t);
  await t.life.checkPhoneNow();
  eq(`${name}: nor after a restart`, fu().length, k2);
  return mine[0];
}
async function none(name, id, extra = null) {
  const k = fu().length;
  await t.life.checkPhoneNow();
  eq(`${name}: no follow-up turn`, fu().slice(k).filter(x => x.ctx.followUp.decisionId === id).length, 0);
  if (extra) extra();
}

section('an accepted invitation: he couldn\'t go');
{
  const { d, id } = await invited();
  check('(setup) committed go by his reply', d?.committed?.optionId === 'go' && d.committed.by === 'reply', d?.committed);
  check('…a plain yes is not followed up', !isDue(d.id));
  const ev = await closeWith(d, 'could_not_go');
  eq('(setup) missed', dec(d.id)?.status, 'missed');
  check('the expiry is a follow-up event (phone.onEvent schedules a check)', t.influence.isFollowUpEvent(ev) === true);
  check('due', isDue(d.id));
  const turn = await check1('could_not_go', d.id, { trigger: id });
  check('…the note names the plan and his yes, never the group\'s words', /Earlier you answered about a movie at Cinema/.test(noteOf(turn)) && !/cinema tonight/.test(noteOf(turn)), noteOf(turn));
  eq('…spent: the mark, the row sent, invite.followed_up', [told(d.id) != null, row(d.id), (await eventsOf(['invite.followed_up'])).filter(e => e.payload.decisionId === d.id).map(e => e.payload.sent)], [true, 'sent', [true]]);
  check('…and no more due', !isDue(d.id));
}

section('a cap, a cooldown or warmup spend nothing: the next check tries again');
{
  const { d, id } = await invited();
  await closeWith(d, 'could_not_go');
  // The rate limiter counts on the real clock: this runs while the test's clock is still behind it.
  storeMessage({ id: `CAP${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'hello there', messageType: 'text', timestamp: Math.floor(Date.now() / 1000), isFromSelf: true });
  config.maxPerGroupHour = 1;
  const k = fu().length;
  await t.life.checkPhoneNow();
  eq('capped: no turn, no mark, the row untouched', [fu().length - k, told(d.id), row(d.id)], [0, null, null]);
  check('…still due', isDue(d.id));
  config.maxPerGroupHour = 0;
  config.warmupEnabled = true;
  const warm = (await import('../../src/behavior/warmup.js')).checkWarmup('text');
  await t.life.checkPhoneNow();
  if (!warm.allowed) eq('warmup: no turn, no mark', [fu().length - k, told(d.id)], [0, null]);
  config.warmupEnabled = false;
  const turn = await check1('…the cap freed', d.id, { trigger: id });
  check('…a back-out turn', turn?.ctx.catchUp.followUpKind === 'back_out', JSON.stringify(turn?.ctx.catchUp));
}
// From here on the test's clock passes the real one, where the limiter would count its own future messages.
t.influence.__setTurnGateForTest(() => true);

section('an accepted invitation: he rethought it (a reversal)');
{
  const { d, id } = await invited();
  const ev = await reverseTo(d);
  check('a reversal is a follow-up event', t.influence.isFollowUpEvent(ev) === true);
  eq('(setup) committed stay after one reversal', [dec(d.id)?.committed?.optionId, dec(d.id)?.reversals], ['stay', 1]);
  await check1('reversal', d.id, { trigger: id });
}

section('…the whole path: a sure Jev lean on a yes');
{
  let pick = null;
  decisions.setJev(async (req) => {
    if (req?.questions?.pick && pick) return { model: 'fake', answers: { pick: jevChoice(Object.entries(pick).sort((a, b) => b[1] - a[1])[0][0], pick) }, usage: {}, ms: 0 };
    return baseJev.fn(req);
  });
  const { d } = await invited();
  t.perceive.setJev(inviteJev({ perceive: { kind: 'none', target: 'him' } }).fn);
  pick = { go: 0.1, late: 0.05, stay: 0.85 };
  await say(t, { chat: t.GROUP, sender: t.B, text: 'skip that movie', id: `L${++n}`, verdict: 'now' });
  eq('a lean of 0.85: he keeps his word, nothing to tell', [dec(d.id)?.committed?.optionId, isDue(d.id)], ['go', false]);
  t.clock.advance({ minutes: 16 });
  await t.life.tick();
  pick = { go: 0.02, late: 0.03, stay: 0.95 };
  await say(t, { chat: t.GROUP, sender: t.B, text: 'skip that movie really', id: `L${++n}`, verdict: 'now' });
  eq('a lean of 0.95: reversed', [dec(d.id)?.committed?.optionId, dec(d.id)?.reversals], ['stay', 1]);
  grace();
  await check1('a sure lean', d.id);
  pick = null;
  decisions.setJev(baseJev.fn);
  t.perceive.setJev(baseJev.fn);
}

section('an accepted invitation: "late" that fell through; the owner called it off');
{
  const { d } = await invited({ answer: 'late' });
  check('(setup) committed late', dec(d.id)?.committed?.optionId === 'late', dec(d.id)?.committed);
  await closeWith(d, 'could_not_go');
  await check1('a "late" he missed', d.id);
  const { d: dx } = await invited();
  const ev = await closeWith(dx, 'owner_cancelled');
  check('owner_cancelled: closed, a follow-up event', dec(dx.id)?.status === 'cancelled' && t.influence.isFollowUpEvent(ev) === true, dec(dx.id)?.status);
  await check1('owner_cancelled', dx.id);
}

section('the owner, through the Director');
{
  await setSkills({ arcs: true });
  const director = await import('../../src/life/story/director.js');
  const apply = async (a) => { const p = await director.preview(a, { relax: true, project: false }); const r = await director.apply(p.previewId, p.fingerprint); grace(); return r; };
  const { d: d1 } = await invited();
  await apply({ kind: 'decision.pick', decisionId: d1.id, optionId: 'stay' });
  eq('a pick: the owner\'s stay', [dec(d1.id)?.committed?.optionId, dec(d1.id)?.committed?.by], ['stay', 'owner']);
  await check1('owner pick', d1.id);
  const { d: d2 } = await invited();
  await apply({ kind: 'quick', button: 'cancel_tonight' });
  eq('CANCEL TONIGHT closes it', dec(d2.id)?.status, 'cancelled');
  await check1('CANCEL TONIGHT', d2.id);
  const { d: d3 } = await invited();
  await apply({ kind: 'outcome', decisionId: d3.id, outcome: 'cancelled' });
  for (let i = 0; i < 12 && dec(d3.id)?.status === 'committed'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  eq('outcome cancelled lands', dec(d3.id)?.status, 'cancelled');
  await check1('outcome cancelled', d3.id);
  // A schedule stretch or an owner outing over it: a chat plan now cancels by default too.
  const { d: d5 } = await invited();
  const from = hhmm(d5.subject.eventAt - 15 * 60, t.world.timezone);
  const to = hhmm(d5.subject.eventAt + 60 * 60, t.world.timezone);
  await apply({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from, to, label: 'quiet night' }], resolutions: { [`invite:${d5.id}`]: 'cancel', [`decision:${d5.id}`]: 'cancel' } });
  for (let i = 0; i < 3 && dec(d5.id)?.status === 'committed'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  eq('a schedule stretch over it closes it', dec(d5.id)?.status, 'cancelled');
  await check1('schedule', d5.id);
  await nextEvening();
  const { d: d4 } = await invited();
  await apply({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: d4.subject.eventAt, minutes: 60, castIds: [], label: 'Owner coffee' });
  eq('an owner outing over it closes it', [dec(d4.id)?.status, (await eventsOf(['decision.expired'])).filter(e => e.payload.decisionId === d4.id).map(e => e.payload.reason)], ['cancelled', ['owner_plan']]);
  await check1('owner_plan', d4.id);
  await nextEvening();

  section('the preview is told the truth by the real path');
  {
    const high = (p) => (p.continuity?.warnings ?? []).filter(w => w.code === 'messages_real_person');
    const { d: w } = await invited();
    const plan = (a) => director.plan(a, t.life.getState(), { relax: true });
    const a = { kind: 'decision.pick', decisionId: w.id, optionId: 'stay' };
    eq('a pick that breaks his word: HIGH', high(plan(a)).length, 1);
    const c = plan({ kind: 'outcome', decisionId: w.id, outcome: 'cancelled' });
    check('a cancel: HIGH, "he tells them there"', high(c).length === 1 && c.warnings.includes(director.CHAT_PLAN_TOLD), JSON.stringify(c.warnings));
    config.chatInfluence.tellBackOut = false;
    const off = plan({ kind: 'outcome', decisionId: w.id, outcome: 'cancelled' });
    check('the switch off: no HIGH, "nobody is told"', high(off).length === 0 && off.warnings.includes(director.CHAT_PLAN), JSON.stringify(off.warnings));
    config.chatInfluence.tellBackOut = true;
    muted.add(t.GROUP);
    eq('muted: no HIGH', high(plan(a)).length, 0);
    muted.delete(t.GROUP);
    const { d: may } = await invited({ answer: 'maybe' });
    const cm = plan({ kind: 'outcome', decisionId: may.id, outcome: 'cancelled' });
    check('a maybe called off: nobody is told', high(cm).length === 0 && cm.warnings.includes(director.CHAT_PLAN), JSON.stringify(cm.warnings));
  }
  await nextEvening();

  section('the owner answers for him: an invitation he never answered → the inviter hears, once');
  const heard = async (name, action, re, id) => {
    await apply(action);
    const k = fu().length;
    await t.life.checkPhoneNow();
    const mine = fu().slice(k).filter(x => x.ctx.followUp.decisionId === id);
    eq(`${name}: one turn`, mine.length, 1);
    check(`${name}: the note`, re.test(noteOf(mine[0])) && /You hadn't answered about/.test(noteOf(mine[0])), noteOf(mine[0]));
    const k2 = fu().length;
    await t.life.checkPhoneNow();
    await stopEngine(t);
    await startEngine(t);
    await t.life.checkPhoneNow();
    eq(`${name}: once, across a restart`, fu().length, k2);
  };
  const { d: ug } = await invited({ answer: null });
  await heard('pick go', { kind: 'decision.pick', decisionId: ug.id, optionId: 'go' }, /decided to go/, ug.id);
  await nextEvening();
  const { d: ul } = await invited({ answer: null });
  await heard('pick late', { kind: 'decision.pick', decisionId: ul.id, optionId: 'late' }, /join a bit late/, ul.id);
  await nextEvening();
  const { d: us } = await invited({ answer: null });
  await heard('pick stay', { kind: 'decision.pick', decisionId: us.id, optionId: 'stay' }, /can't make it/, us.id);
  const { d: uc } = await invited({ answer: null });
  await apply({ kind: 'outcome', decisionId: uc.id, outcome: 'cancelled' });
  for (let i = 0; i < 12 && dec(uc.id)?.status === 'open'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  eq('called off, unanswered', dec(uc.id)?.status, 'cancelled');
  const kc = fu().length;
  await t.life.checkPhoneNow();
  eq('called off: one turn', fu().slice(kc).filter(x => x.ctx.followUp.decisionId === uc.id).length, 1);
  await nextEvening();

  section('told, then the plan is back on: one correction, once');
  const fixTurns = () => turns.filter(x => x.ctx.catchUp?.followUpKind === 'correction');
  const { d: r1 } = await invited();
  const exp = await reverseTo(r1);
  await check1('(setup) told', r1.id);
  t.life.revertEvent(exp.id, { reason: 'test', by: 'owner' });
  grace();
  eq('(setup) the plan is back', [dec(r1.id)?.status, dec(r1.id)?.committed?.optionId], ['committed', 'go']);
  check('a correction is due', isDue(r1.id));
  await t.life.checkPhoneNow();
  eq('one correction turn', fixTurns().filter(x => x.ctx.followUp.decisionId === r1.id).length, 1);
  check('…its note', /you can after all/.test(noteOf(fixTurns().at(-1))), noteOf(fixTurns().at(-1)));
  await t.life.checkPhoneNow();
  await stopEngine(t);
  await startEngine(t);
  await t.life.checkPhoneNow();
  eq('…once, across a restart', fixTurns().filter(x => x.ctx.followUp.decisionId === r1.id).length, 1);
  // Too late to matter: nothing.
  await nextEvening();
  const { d: r2 } = await invited();
  const exp2 = await reverseTo(r2);
  await check1('(setup) told again', r2.id);
  t.life.revertEvent(exp2.id, { reason: 'test', by: 'owner' });
  const lateNow = t.influence.dueFollowUps(r2.subject.eventAt + 60).some(f => f.decisionId === r2.id);
  check('past its time: no correction', !lateNow);
  // Nothing was told (the turn sent nothing): nothing to correct.
  sendOnTurn = false;
  await nextEvening();
  const { d: r3 } = await invited();
  const exp3 = await reverseTo(r3);
  await t.life.checkPhoneNow();
  sendOnTurn = true;
  t.life.revertEvent(exp3.id, { reason: 'test', by: 'owner' });
  check('the back-out sent nothing: no correction', !isDue(r3.id));
  await nextEvening();
  await setSkills({ arcs: false });
}

section('not his word: a no, a maybe, a deadline he let pass');
{
  const { d: no } = await invited({ answer: 'no' });
  check('(setup) committed stay by reply', dec(no.id)?.committed?.optionId === 'stay', dec(no.id)?.committed);
  await closeWith(no, 'owner_cancelled');
  check('a "no" that closes: not due', !isDue(no.id));
  await none('a "no"', no.id);
  const { d: un } = await invited({ answer: null });
  check('(setup) open, unanswered', dec(un.id)?.status === 'open' && !dec(un.id).inviteAnswer);
  await closeWith(un, 'unanswered');
  await none('unanswered, its own deadline', un.id);
  const { d: may } = await invited({ answer: 'maybe' });
  check('(setup) open, a maybe', dec(may.id)?.status === 'open' && dec(may.id).inviteAnswer === 'maybe');
  await closeWith(may, 'owner_cancelled');
  await none('a maybe', may.id);
  eq('…no mark for any of them', [told(no.id), told(un.id), told(may.id)], [null, null, null]);
}

section('the inviter called it off: no "can\'t make it" to them');
{
  const { d } = await invited();
  t.perceive.setJev(inviteJev({ perceive: { kind: 'cancel', target: 'him', intensity: 'mid' } }).fn);
  await say(t, { chat: t.GROUP, sender: t.A, text: 'not happening today, sorry', id: `C${++n}`, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  t.perceive.setJev(baseJev.fn);
  eq('closed by the inviter', dec(d.id)?.status, 'cancelled');
  check('not due', !isDue(d.id));
  await none('inviter cancelled', d.id);
}

section('chatInfluence.tellBackOut off');
{
  const { d } = await invited();
  config.chatInfluence.tellBackOut = false;
  const ev = await closeWith(d, 'could_not_go');
  check('not a follow-up event', t.influence.isFollowUpEvent(ev) !== true);
  await none('off, could_not_go', d.id);
  config.chatInfluence.tellBackOut = true;
  // Back on before its time: it was never told, it may be now.
  check('…back on: due again', isDue(d.id));
  const { d: r } = await invited();
  config.chatInfluence.tellBackOut = false;
  await reverseTo(r);
  check('off, a reversal: not due', !isDue(r.id));
  await none('off, a reversal', r.id);
  config.chatInfluence.tellBackOut = true;
}

section('a promise he confirmed in a follow-up still gets a back-out');
{
  const { d } = await invited({ answer: 'maybe' });
  t.db.prepare(`UPDATE chat_influence_items SET followup_status = 'sent' WHERE decision_id = ? AND category IS NULL`).run(d.id);
  appendEvent({ type: 'decision.committed', at: t.clock.now(), actor: 'engine', causeId: d.id, subjectJid: d.subjectJid, payload: { decisionId: d.id, optionId: 'go', p: 0.9, sampled: true, by: 'sample' } });
  appendEvent({ type: 'invite.followed_up', at: t.clock.now(), actor: 'engine', causeId: d.id, subjectJid: d.subjectJid, payload: { decisionId: d.id, outcome: 'going', sent: true } });
  await stopEngine(t);
  await startEngine(t);
  eq('(setup) confirmed', [dec(d.id)?.status, dec(d.id)?.followUp?.outcome], ['committed', 'going']);
  await closeWith(dec(d.id), 'could_not_go');
  await check1('confirmed, then missed', d.id);
  // Yes, then "I'll be late" sent, then cancelled.
  const { d: y } = await invited();
  await reverseTo(dec(y.id), 'late');
  await t.life.checkPhoneNow();
  eq('(setup) the "late" went out', [dec(y.id)?.followUp?.outcome, row(y.id)], ['late', 'sent']);
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(y.id), 'owner_cancelled');
  await check1('late sent, then called off', y.id);
}

section('deploy: a plan broken before this code first ran is never told');
{
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  check('(setup) due', isDue(d.id));
  const key = 'backout:since';
  const was = t.db.prepare(`SELECT value FROM chat_influence_state WHERE key = ?`).get(key)?.value;
  check('(setup) the first run is on record', Number(was) > 0, String(was));
  t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(t.clock.now() + 60), key);
  check('broken before it: not due', !isDue(d.id));
  await none('broken before the cutoff', d.id);
  t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(was), key);
  await check1('(cleanup)', d.id);
}

section('drops, checked under the lock: once, whatever happened');
async function dropCase(name, setup, undo = () => {}) {
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  await setup(d);
  const k = fu().length;
  await t.life.checkPhoneNow();
  await undo(d);
  eq(`${name}: no turn`, fu().length - k, 0);
  eq(`${name}: the row is dropped, never re-offered`, row(d.id), 'dropped');
  await t.life.checkPhoneNow();
  eq(`${name}: not at the next check either`, fu().length - k, 0);
}
// Decisions 23, 24, 36: only his own line saying he can't cancels it (an unrelated line used to).
await dropCase('his own line already said he can\'t', async () => {
  t.clock.advance({ minutes: 1 });
  storeMessage({ id: `HS${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'sorry guys, can\'t make it tonight', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
});
{
  const { d, id } = await invited();
  await closeWith(d, 'could_not_go');
  t.clock.advance({ minutes: 1 });
  storeMessage({ id: `HS${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'that match was unreal', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  await check1('an unrelated line of his cancels nothing', d.id, { trigger: id });
}
{
  // A line from before it broke, even one saying he can't, doesn't count.
  const { d } = await invited();
  storeMessage({ id: `HS${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'sorry, cant do lunch', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  t.clock.advance({ minutes: 1 });
  await closeWith(d, 'could_not_go');
  await check1('his line before it broke', d.id);
}
await dropCase('the group is muted', async () => { muted.add(t.GROUP); }, async () => { muted.delete(t.GROUP); });
const { setImitationTarget, clearImitationTarget } = await import('../../src/behavior/imitationState.js');
await setSkills({ imitate: true });
await dropCase('the group is imitating someone', async () => {
  setImitationTarget(t.GROUP, { targetJid: t.C, label: 'Casey', durationMinutes: 30, enabledBy: 'test', reason: 'test' });
}, async () => { clearImitationTarget(t.GROUP); });
await setSkills({ imitate: false });

section('after the event time');
{
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  const late = d.subject.eventAt + 60;
  check('due before it', isDue(d.id));
  check('not due after it', !isDue(d.id, late));
  const f = t.influence.dueFollowUps(t.clock.now()).find(x => x.decisionId === d.id);
  t.clock.set(late);
  await t.life.tick();
  const k = fu().length;
  await t.life.checkPhoneNow();
  eq('the phone check sends nothing', fu().length - k, 0);
  eq('a stale entry is refused under the lock', t.influence.prepareFollowUp(f, { loadMessage: () => ({ id: f.msgId }) }), null);
  eq('…row dropped', row(d.id), 'dropped');
}

section('the send path: the phone itself never sends, one attempt whatever the turn did');
{
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  sendOnTurn = false;
  const sends = () => sock.sent.length;
  const s0 = sends();
  const k = fu().length;
  await t.life.checkPhoneNow();
  sendOnTurn = true;
  eq('one turn through processMessage, DRY_RUN on (config)', [fu().length - k, config.dryRun], [1, true]);
  eq('nothing sent by the phone', sends(), s0);
  const fev = (await eventsOf(['invite.followed_up'])).find(e => e.payload.decisionId === d.id);
  eq('nothing out: followed_up {sent:false}, row skipped', [fev?.payload.sent, row(d.id)], [false, 'skipped']);
  await t.life.checkPhoneNow();
  eq('…spent', fu().length - k, 1);
}

// ── Adopted claims ───────────────────────────────────────────────────────────
function adopted({ subject = t.A, chat = t.GROUP, at = t.clock.now() + 75 * 60, label = 'Dinner with a friend' } = {}) {
  const now = t.clock.now();
  const claimId = Number(t.db.prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, ?, ?, ?, 'x', 'claim', 0.9, 'adopted', ?)`).run(chat, chat.endsWith('@g.us') ? 'group' : 'dm', chat, `CLM${++n}`, now).lastInsertRowid);
  const sub = subject ? { subjectJid: subject } : {};
  const opened = appendEvent({ type: 'decision.opened', at: now, actor: 'engine', ...sub, payload: {
    kind: 'claim:eat-out', category: 'social', adopted: true, preCommit: 'go', claimId,
    subject: { eventAt: at, placeId: 'place:restaurant', castIds: [], minutes: 60 },
    options: [{ id: 'go', label, go: true, kind: 'eat-out' }, { id: 'late', label: 'Join later', go: 'late', kind: 'eat-out', expiresAt: at + 3600 }, { id: 'stay', label: 'Stay in', kind: 'rest' }],
    opensAt: now, decideBy: at - 30 * 60, ponrAt: at - 30 * 60,
  } });
  appendEvent({ type: 'decision.committed', at: now, actor: 'engine', causeId: opened.id, ...sub, payload: { decisionId: opened.id, optionId: 'go', p: 1, sampled: false, by: 'adopted' } });
  return opened.id;
}
const line = (chat, sender, text = 'see you around') => {
  const id = `AL${++n}`;
  storeMessage({ id, groupJid: chat, senderJid: sender, content: text, messageType: 'text', timestamp: t.clock.now() });
  return id;
};
const restart = async () => { await stopEngine(t); await startEngine(t); };

section('an adopted claim naming a real person: told once');
{
  await eveningRoom();
  const lineId = line(t.GROUP, t.A);
  t.clock.advance({ minutes: 1 });
  const id = adopted();
  await restart();
  check('(setup) a committed adopted plan with them as subject', dec(id)?.status === 'committed' && dec(id).adopted === true && dec(id).subjectJid === t.A);
  check('not due while it stands', !isDue(id));
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(id), 'could_not_go');
  const turn = await check1('adopted, could_not_go', id, { trigger: lineId });
  check('…"you told <the person it names> about it", in code words', /Earlier you told Avery about Dinner with a friend/.test(noteOf(turn)), noteOf(turn));
  check('…its own contribution bar, not "the invitation"', turn?.ctx.catchUp.followUpKind === 'back_out', JSON.stringify(turn?.ctx.catchUp));
  eq('…its mark; no item row, no invite event', [told(id) != null, (await eventsOf(['invite.followed_up'])).filter(e => e.payload.decisionId === id).length], [true, 0]);
}

section('…reversed, after he chatted on as usual since the adoption');
{
  await eveningRoom();
  line(t.GROUP, t.A);
  t.clock.advance({ minutes: 1 });
  const id = adopted();
  await restart();
  t.clock.advance({ minutes: 2 });
  storeMessage({ id: `ACH${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'haha yes', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  t.clock.advance({ minutes: 2 });
  line(t.GROUP, t.A, 'anyway');
  t.clock.advance({ minutes: 2 });
  const ev = await reverseTo(dec(id));
  check('a reversal of an adopted plan is a follow-up event', t.influence.isFollowUpEvent(ev) === true);
  check('due', isDue(id));
  await check1('adopted, reversed', id);
}

section('an adopted claim: the line it answers is the named person\'s, a real text line');
{
  await eveningRoom();
  const lineA = line(t.GROUP, t.A, 'dinner sounds good');
  t.clock.advance({ minutes: 1 });
  const id = adopted();
  await restart();
  t.clock.advance({ minutes: 1 });
  line(t.GROUP, t.B, 'unrelated, from someone else');
  storeMessage({ id: `RC${++n}`, groupJid: t.GROUP, senderJid: t.A, content: '👍', messageType: 'reaction', timestamp: t.clock.now() });
  storeMessage({ id: `IM${++n}`, groupJid: t.GROUP, senderJid: t.A, content: '', messageType: 'image', timestamp: t.clock.now() });
  const poof = `DM${++n}`;
  storeMessage({ id: poof, groupJid: t.GROUP, senderJid: t.A, content: 'poof', messageType: 'text', timestamp: t.clock.now() });
  t.db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 86400, poof);
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(id), 'could_not_go');
  await check1('newest are a stranger, a reaction, media, a disappearing line', id, { trigger: lineA });
}
{
  // They are in the chat but haven't said anything in the transcript: no message (nothing to answer), logged; it stays open.
  await eveningRoom();
  const id = adopted({ subject: t.C });
  await restart();
  t.clock.advance({ minutes: 1 });
  line(t.GROUP, t.B, 'something else');
  await closeWith(dec(id), 'could_not_go');
  await none('no line of theirs', id, () => eq('no mark', told(id), null));
  const lineC = line(t.GROUP, t.C, 'are we on tonight');
  await check1('…then they speak', id, { trigger: lineC });
}

section('a solo adopted claim: nobody to tell');
{
  await eveningRoom();
  line(t.GROUP, t.A);
  const id = adopted({ subject: null });
  await restart();
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(id), 'could_not_go');
  check('not due', !isDue(id));
  await none('solo', id, () => eq('no mark', told(id), null));
}

section('an adopted claim: off, spoke, late');
{
  await eveningRoom();
  line(t.GROUP, t.A);
  const off = adopted();
  await restart();
  t.clock.advance({ minutes: 1 });
  config.chatInfluence.tellBackOut = false;
  await closeWith(dec(off), 'could_not_go');
  await none('off', off);
  config.chatInfluence.tellBackOut = true;
  t.clock.advance({ minutes: 1 });
  storeMessage({ id: `AS${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: 'sorry, can\'t make dinner', messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  await none('his line said he can\'t since it fell through', off);
  line(t.GROUP, t.A);
  const late = adopted({ at: t.clock.now() + 40 * 60 });
  await restart();
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(late), 'could_not_go');
  check('past its time: not due', !isDue(late, dec(late).subject.eventAt + 1));
}

section('an adopted claim in a DM, the chat stored under the phone-number form');
{
  await eveningRoom();
  const PN = '15550007201@s.whatsapp.net';
  const lineId = line(PN, t.A);
  t.clock.advance({ minutes: 1 });
  const id = adopted({ chat: PN });
  await restart();
  t.clock.advance({ minutes: 1 });
  await closeWith(dec(id), 'could_not_go');
  check('due', isDue(id));
  await check1('adopted in a DM', id, { trigger: lineId });
}

section('the person left');
{
  const membership = await import('../../src/memory/membership.js');
  const { d } = await invited({ chat: t.OTHER, sender: t.C });
  await closeWith(d, 'could_not_go');
  membership.onParticipantsUpdate({ id: t.OTHER, participants: [t.C], action: 'remove' });
  const k = fu().length;
  await t.life.checkPhoneNow();
  eq('an invitation: the inviter left the group → no turn; dropped', [fu().length - k, row(d.id)], [0, 'dropped']);
  membership.onParticipantsUpdate({ id: t.OTHER, participants: [t.C], action: 'add' });

  // An adopted claim: the person it named left; someone else spoke last.
  await eveningRoom();
  const id = adopted({ chat: t.GROUP, subject: t.C });
  await restart();
  t.clock.advance({ minutes: 1 });
  line(t.GROUP, t.B, 'after they left');
  membership.onParticipantsUpdate({ id: t.GROUP, participants: [t.C], action: 'remove' });
  await closeWith(dec(id), 'could_not_go');
  const k2 = fu().length;
  await t.life.checkPhoneNow();
  eq('an adopted claim: the person it named left → no turn', fu().length - k2, 0);
}

// ── Final review (second round) ──────────────────────────────────────────────
const relStore = await import('../../src/memory/relationshipStore.js');
const membershipMod = await import('../../src/memory/membership.js');
const directorMod = await import('../../src/life/story/director.js');
const applyD = async (a, { pass = true } = {}) => {
  const p = await directorMod.preview(a, { relax: true, project: false });
  const r = await directorMod.apply(p.previewId, p.fingerprint);
  if (pass) grace();
  return r;
};
const cancelBy = async (sender, chat = t.GROUP) => {
  const id = `CX${++n}`;
  t.perceive.setJev(inviteJev({ perceive: { kind: 'cancel', target: 'him', intensity: 'mid' } }).fn);
  await say(t, { chat, sender, text: 'not happening today, sorry', id, verdict: 'now', mentioned: [BOT] });
  await idle(t);
  t.perceive.setJev(baseJev.fn);
  return id;
};
await nextEvening();
await setSkills({ arcs: true });

section('finding 1: the inviter called it off, then the owner closes it: nothing to them');
{
  const { d } = await invited({ answer: null });
  const cancelId = await cancelBy(t.A);
  eq('(setup) the cancel leaned stay; still open', dec(d.id)?.status, 'open');
  check('the preview knows: no message', t.influence.willTellBackOut(dec(d.id), { to: null }) === false);
  await applyD({ kind: 'outcome', decisionId: d.id, outcome: 'cancelled' });
  for (let i = 0; i < 12 && dec(d.id)?.status === 'open'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  eq('(setup) closed by the owner', dec(d.id)?.status, 'cancelled');
  check('not due', !isDue(d.id));
  await none('owner closed what the inviter cancelled', d.id);
  eq('…nothing spent: it may matter if the cancel goes', told(d.id), null);
  // The inviter takes the cancel back: the mark goes, and the owner's cancel stands: they hear.
  relStore.onMessageRevoked(cancelId, t.GROUP);
  await new Promise(r => setImmediate(r));
  check('the cancel revoked: due again', isDue(d.id));
  await check1('the cancel revoked', d.id);
}
{
  await nextEvening();
  const { d } = await invited();
  await cancelBy(t.A);
  // A yes past its point of no return: the cancel couldn't expire it, it falls through later.
  if (dec(d.id)?.status === 'committed') {
    await closeWith(dec(d.id), 'could_not_go');
    check('a yes the inviter called off, falling through later: not due', !isDue(d.id));
    await none('a yes he was told off', d.id);
  } else {
    eq('(a cancelled yes closed at once)', dec(d.id)?.status, 'cancelled');
    check('not due', !isDue(d.id));
  }
}

section('finding 2: undoing what broke the plan brings it back');
{
  await nextEvening();
  const { d } = await invited();
  const sick = await applyD({ kind: 'quick', button: 'sick_day' }, { pass: false });
  t.clock.advance({ minutes: 15 });
  await t.life.tick();
  eq('(setup) it fell through', dec(d.id)?.status, 'missed');
  const exp = (await eventsOf(['decision.expired'])).filter(e => e.payload.decisionId === d.id).at(-1);
  eq('the expiry is caused by the sick day', (await import('../../src/life/eventLog.js')).getEvent(exp.causeId)?.type, 'sick.started');
  const actionId = sick.actionEventIds?.[0] ?? sick.actionEventId ?? (await eventsOf(['director.action'])).at(-1).id;
  const pv = t.life.revertChangePreview(actionId);
  check('REVERT THIS CHANGE is offered', !pv.refusals?.length, JSON.stringify(pv.refusals));
  t.life.revertChange(actionId, { fingerprint: pv.fingerprint, by: 'owner' });
  eq('undone: the plan is back, not missed', [dec(d.id)?.status, dec(d.id)?.committed?.optionId, t.life.getState().vitals?.sick === true], ['committed', 'go', false]);
  grace();
  check('nothing to tell', !isDue(d.id));
  await none('sick day undone before any tell', d.id);
}
{
  await nextEvening();
  const { d } = await invited();
  const fixes = () => turns.filter(x => x.ctx.catchUp?.followUpKind === 'correction' && x.ctx.followUp.decisionId === d.id).length;
  const sick = await applyD({ kind: 'quick', button: 'sick_day' });
  t.clock.advance({ minutes: 15 });
  await t.life.tick();
  grace();
  eq('(setup) fell through', dec(d.id)?.status, 'missed');
  await check1('(setup) told', d.id);
  const actionId = sick.actionEventIds?.[0] ?? sick.actionEventId ?? (await eventsOf(['director.action'])).at(-1).id;
  const pv = t.life.revertChangePreview(actionId);
  t.life.revertChange(actionId, { fingerprint: pv.fingerprint, by: 'owner' });
  grace();
  eq('undone after the message: the plan is back', dec(d.id)?.status, 'committed');
  await t.life.checkPhoneNow();
  eq('…and the message gets its correction', fixes(), 1);
}
{
  await nextEvening();
  const { d } = await invited();
  const r = await applyD({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: d.subject.eventAt, minutes: 60, castIds: [], label: 'Owner coffee',
    resolutions: { [`decision:${d.id}`]: 'keep', [`invite:${d.id}`]: 'keep' } }, { pass: false });
  for (let i = 0; i < 16 && dec(d.id)?.status === 'committed'; i++) { t.clock.advance({ minutes: 5 }); await t.life.tick(); }
  eq('(setup) kept under the owner\'s outing, it falls through', dec(d.id)?.status, 'missed');
  const { getEvent } = await import('../../src/life/eventLog.js');
  const exp = (await eventsOf(['decision.expired'])).filter(e => e.payload.decisionId === d.id).at(-1);
  eq('the expiry is caused by the outing that holds the time', [getEvent(exp.causeId)?.type, getEvent(exp.causeId)?.actor], ['decision.committed', 'owner']);
  const actionId = r.actionEventIds?.[0] ?? r.actionEventId ?? (await eventsOf(['director.action'])).at(-1).id;
  const pv = t.life.revertChangePreview(actionId);
  check('REVERT THIS CHANGE is offered', !pv.refusals?.length, JSON.stringify(pv.refusals));
  t.life.revertChange(actionId, { fingerprint: pv.fingerprint, by: 'owner' });
  eq('undone: the promise is back', [dec(d.id)?.status, dec(d.id)?.committed?.optionId], ['committed', 'go']);
}

section('finding 3 + the cap: two promises in one chat, a mass break');
{
  eq('a bare sorry says nothing', ['sorry which movie?', "can't believe this", "can't believe it", "won't happen again", 'sorry?', 'going home'].map(t.influence.saysHeCant), [false, false, false, false, false, false]);
  eq('he said it', ["can't make it", 'sorry, can not make it', "won't be able to come", "sorry, it's off", 'not coming today', "can't go tonight", 'cannot make it', "can't do it"].map(t.influence.saysHeCant), Array(8).fill(true));
  await nextEvening();
  const { d: a } = await invited();
  const { d: b } = await invited({ keep: true, sender: t.B, ahead: 200 });
  check('(setup) two yes in one group, from different people', a?.id !== b?.id && dec(a.id)?.committed?.optionId === 'go' && dec(b.id)?.committed?.optionId === 'go', [dec(a.id)?.committed, dec(b.id)?.committed]);
  await applyD({ kind: 'quick', button: 'sick_day' }, { pass: false });
  t.clock.advance({ minutes: 15 });
  await t.life.tick();
  grace();
  eq('(setup) a sick day breaks both', [dec(a.id)?.status, dec(b.id)?.status], ['missed', 'missed']);
  const mine = () => fu().filter(x => [a.id, b.id].includes(x.ctx.followUp.decisionId)).map(x => x.ctx.followUp.decisionId);
  const k = mine().length;
  await t.life.checkPhoneNow();
  eq('one per chat per check', mine().length - k, 1);
  await t.life.checkPhoneNow();
  eq('the second at the next check: the first tell did not cancel it', mine().slice(k).sort(), [a.id, b.id].sort());
  eq('both marked told', [told(a.id) != null && !String(told(a.id)).startsWith('dropped'), told(b.id) != null && !String(told(b.id)).startsWith('dropped')], [true, true]);
  // An unrelated line after the break cancels nothing; his own "can't make it" does.
  await nextEvening();
  const { d: c } = await invited();
  await closeWith(c, 'could_not_go');
  storeMessage({ id: `US${++n}`, groupJid: t.GROUP, senderJid: t.bot.pn, content: "sorry which movie?", messageType: 'text', timestamp: t.clock.now(), isFromSelf: true });
  await check1('sorry which movie?', c.id);
}
{
  t.influence.__setTellMaxForTest(null);
  eq('(the day\'s cap)', t.influence.TELL_MAX_PER_DAY, 5);
  await nextEvening();
  const { dateKey } = await import('../../src/life/clock.js');
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  const day = dateKey(t.clock.now(), t.world.timezone);
  t.db.prepare(`INSERT INTO chat_influence_state (key, value) VALUES (?, '5') ON CONFLICT(key) DO UPDATE SET value = '5'`).run(`backout_day:${day}`);
  await none('five sent today: over the cap', d.id);
  eq('…nothing spent', told(d.id), null);
  t.db.prepare(`DELETE FROM chat_influence_state WHERE key = ?`).run(`backout_day:${day}`);
  await check1('…under it again', d.id);
  eq('…counted', t.db.prepare(`SELECT value FROM chat_influence_state WHERE key = ?`).get(`backout_day:${day}`)?.value, '1');
  t.influence.__setTellMaxForTest(1000);
}

section('the opt-out: "don\'t text me first" holds a tell');
{
  const mind = await import('../../src/mind/index.js');
  t.restartOpts.personOptedOut = (j) => mind.personOptedOut(j);
  await stopEngine(t);
  await startEngine(t);
  await nextEvening();
  const { d } = await invited();
  check('(not yet) the preview says he tells them', t.influence.willTellBackOut(dec(d.id), { to: null }) === true);
  t.db.prepare(`INSERT INTO mind_exclusions (kind, jid, source, created_at) VALUES ('person', ?, 'detected', ?)`).run(t.A, t.clock.now());
  check('the facade answers over the identities', mind.personOptedOut(t.A) === true && mind.personOptedOut('15550007201@s.whatsapp.net') === true && mind.personOptedOut(t.B) === false);
  check('the preview says he doesn\'t', t.influence.willTellBackOut(dec(d.id), { to: null }) === false);
  await closeWith(d, 'could_not_go');
  await none('opted out', d.id);
  eq('…spent with its reason', told(d.id), 'dropped:opt_out');
  t.db.prepare(`DELETE FROM mind_exclusions`).run();
  // A failed read holds the message; nothing spent.
  t.restartOpts.personOptedOut = () => { throw new Error('db'); };
  await stopEngine(t);
  await startEngine(t);
  await nextEvening();
  const { d: f } = await invited();
  await closeWith(f, 'could_not_go');
  await none('the exclusions can\'t be read', f.id);
  eq('…nothing spent', told(f.id), null);
  delete t.restartOpts.personOptedOut;
  await stopEngine(t);
  await startEngine(t);
  await check1('…read again', f.id);
}

section('finding 4: a tell the quality gate blocked gets one retry, then it ends');
{
  await nextEvening();
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  const mine = () => fu().filter(x => x.ctx.followUp.decisionId === d.id).length;
  sendOnTurn = false;
  onTurn = (_m, ctx) => { if (ctx.followUp) ctx.followUp.blocked = 'gate'; };
  await t.life.checkPhoneNow();
  eq('one turn, nothing out', mine(), 1);
  eq('not spent: one retry', told(d.id), null);
  await t.life.checkPhoneNow();
  eq('the retry', mine(), 2);
  check('…spent now', told(d.id) != null);
  await t.life.checkPhoneNow();
  eq('…and it ends', mine(), 2);
  onTurn = null;
  sendOnTurn = true;
}

section('finding 5: a grace before any tell, and the plan re-read right before the send');
{
  await nextEvening();
  const { d } = await invited();
  const ev = appendEvent({ type: 'decision.reversed', at: t.clock.now(), actor: 'engine', causeId: d.committed?.eventId ?? d.id, subjectJid: d.subjectJid, payload: { decisionId: d.id, from: 'go', to: 'stay', p: 0.95 } });
  await stopEngine(t);
  await startEngine(t);
  check('just broken: not due', !isDue(d.id));
  await none('inside the grace', d.id);
  eq('…nothing spent', told(d.id), null);
  t.life.revertEvent(ev.id, { reason: 'test', by: 'owner' });
  eq('undone inside it', [dec(d.id)?.status, dec(d.id)?.committed?.optionId], ['committed', 'go']);
  grace();
  check('…nobody hears anything', !isDue(d.id));
  // Past the grace: the turn starts, and the plan comes back while it runs.
  const again = appendEvent({ type: 'decision.reversed', at: t.clock.now(), actor: 'engine', causeId: dec(d.id).committed?.eventId ?? d.id, subjectJid: d.subjectJid, payload: { decisionId: d.id, from: 'go', to: 'stay', p: 0.95 } });
  await stopEngine(t);
  await startEngine(t);
  grace();
  let before = null;
  let after = null;
  sendOnTurn = false;
  onTurn = (_m, ctx) => {
    if (!ctx.followUp?.stillApplies) return;
    before = ctx.followUp.stillApplies();
    t.life.revertEvent(again.id, { reason: 'test', by: 'owner' });
    after = ctx.followUp.stillApplies();
  };
  await t.life.checkPhoneNow();
  onTurn = null;
  sendOnTurn = true;
  eq('the turn can tell it no longer applies', [before, after], [true, false]);
  eq('…unspent: it may still break later', told(d.id), null);
}

section('findings 6, 7: a plan committed before this code first ran');
{
  const key = 'backout:since';
  const was = t.db.prepare(`SELECT value FROM chat_influence_state WHERE key = ?`).get(key)?.value;
  await nextEvening();
  const { d } = await invited();
  t.clock.advance({ minutes: 2 });
  t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(t.clock.now()), key);
  t.clock.advance({ minutes: 2 });
  await closeWith(d, 'could_not_go');
  check('broken after the cutoff, promised before it: not due', !isDue(d.id));
  await none('promised before', d.id);
  t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(was), key);
  await nextEvening();
  // The Ask-me card's door to an owner's pick: an unanswered invitation, committed by the owner.
  const { d: u } = await invited({ answer: null });
  await decisions.ownerCommit(() => t.life.getState(), u.id, 'go', { at: t.clock.now(), world: t.world, append: (e) => appendEvent(e), by: 'owner' }).catch(() => null);
  await stopEngine(t);
  await startEngine(t);
  if (dec(u.id)?.committed?.by === 'owner') {
    t.clock.advance({ minutes: 1 });
    t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(t.clock.now()), key);
    t.clock.advance({ minutes: 1 });
    check('an owner\'s pick before the cutoff: not due', !isDue(u.id));
    t.db.prepare(`UPDATE chat_influence_state SET value = ? WHERE key = ?`).run(String(was), key);
    check('…after it: due', isDue(u.id));
    await t.life.checkPhoneNow();
  } else check('(setup) the owner\'s pick landed', false, dec(u.id)?.committed);
}

section('finding 9: a gap in the membership data spends nothing');
{
  await nextEvening();
  const { d } = await invited();
  await closeWith(d, 'could_not_go');
  membershipMod.markAllUnsynced();
  check('(setup) stale', !membershipMod.isFresh(t.GROUP));
  const k = fu().length;
  await t.life.checkPhoneNow();
  eq('a group: no turn, nothing spent', [fu().length - k, told(d.id)], [0, null]);
  membershipMod.__markSyncedForTest(t.GROUP);
  membershipMod.__markSyncedForTest(t.OTHER);
  await check1('…synced again', d.id);
  // A DM inviter.
  await nextEvening();
  const dm = await invited({ chat: t.A, sender: t.A });
  await closeWith(dm.d, 'could_not_go');
  membershipMod.markAllUnsynced();
  const k2 = fu().length;
  await t.life.checkPhoneNow();
  eq('a DM: no turn, not "left"', [fu().length - k2, told(dm.d.id)], [0, null]);
  membershipMod.__markSyncedForTest(t.GROUP);
  membershipMod.__markSyncedForTest(t.OTHER);
  await check1('…synced again (a DM)', dm.d.id);
}

section('finding 10: his own words, no invented reason');
{
  const { followUpNote } = await import('../../src/life/influence/invites.js');
  const d = { invite: true, inviteAnswer: 'yes', options: [{ id: 'go', label: 'a movie at Cinema with a friend' }], subject: { eventAt: 1793500000 } };
  for (const [name, note] of [['back-out', followUpNote({ d, outcome: 'not_going', tz: t.world.timezone })], ['correction', followUpNote({ d, outcome: 'going', tz: t.world.timezone, correction: true })],
    ['adopted', followUpNote({ d: { ...d, invite: false, adopted: true }, outcome: 'not_going', tz: t.world.timezone, name: 'Avery' })]]) {
    check(`${name}: the added line survives the clip`, /what they called it on the >>> line/.test(note) && /Don't give a reason you don't have/.test(note), note);
  }
  const plain = followUpNote({ d: { ...d, inviteAnswer: 'maybe' }, outcome: 'going', tz: t.world.timezone });
  check('a plain "I\'m coming" is unchanged', !/>>>/.test(plain), plain);
}

report();
