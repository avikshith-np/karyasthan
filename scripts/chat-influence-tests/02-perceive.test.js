// 012 perception (plan §P1.1): who and what may be perceived (one Jev call per
// candidate, none otherwise), the burst rule, the caps (per sender, per chat, per
// day — also across a restart — a ledger read failure, concurrency), the gate
// verdicts (now/sneak land, defer is held until the phone reads it, ignore drops),
// untrusted answers, the live wire shapes, and no chat text in what is stored.
import {
  setupScratchDb, bootInfluence, say, sent, idle, eventsOf, perceiveCalls, fakeSock, liveChoice,
  section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const muted = new Set();
const sock = fakeSock();
const turns = [];
const t = await bootInfluence({
  isGroupMuted: (j) => muted.has(j),
  getSock: () => sock,
  processMessage: async (s, msg, ctx) => { turns.push({ msg, ctx }); },
  loadMessage: (item) => ({ id: item.msgId, groupJid: item.chatJid, senderJid: item.senderJid ?? item.chatJid, content: 'x' }),
});
const { getPersona } = await import('../../src/utils/config.js');
const membership = await import('../../src/memory/membership.js');
const { setImitationTarget, clearImitationTarget, loadImitationModes } = await import('../../src/behavior/imitationState.js');
const { seedPeople, setSkills } = await import('./_helpers.js');
const BOT = '10000000000@s.whatsapp.net';
const [D] = await seedPeople([{ jid: '7209@lid', name: 'Drew' }]);   // in no group
const calls = () => perceiveCalls(t).length;
const resetCaps = () => t.influence.__resetForTest();

async function asks(name, opts, expected = 1) {
  const n0 = calls();
  await say(t, opts);
  return eq(name, calls() - n0, expected);
}

section('candidates → one call');
await asks('DM from a known member', { chat: t.A, sender: t.A, text: 'how was the day, all good?' });
await asks('group @-mention', { chat: t.GROUP, sender: t.B, text: 'what do you reckon about this', mentioned: [BOT] });
const mine = await sent(t, { chat: t.OTHER, text: 'nah not today' });
t.clock.advance({ minutes: 20 });
await asks('group reply to him', { chat: t.OTHER, sender: t.C, text: 'oh come on, why not', quotedId: mine.id });
const alias = getPersona().aliases?.[0] || getPersona().name;
await asks(`group name/alias hit ("${alias}")`, { chat: t.GROUP, sender: t.C, text: `${alias} what do you think` });
await sent(t, { chat: t.GROUP, text: 'that is wild' });
await asks('group while he is in the conversation (he sent < 10 min ago)', { chat: t.GROUP, sender: t.B, text: 'right?? absolutely wild' });

section('not candidates → no call');
t.clock.advance({ minutes: 30 });
await asks('plain group chatter', { chat: t.GROUP, sender: t.B, text: 'anyone seen the match last night' }, 0);
muted.add(t.GROUP);
await asks('muted group', { chat: t.GROUP, sender: t.B, text: 'hey you, what do you think', mentioned: [BOT] }, 0);
muted.delete(t.GROUP);
await asks('outsider in a group (not a member)', { chat: t.GROUP, sender: D, text: 'hey you, what do you think', mentioned: [BOT] }, 0);
await asks('DM from someone who shares no group', { chat: D, sender: D, text: 'hey, remember me? long time' }, 0);
await asks('unknown sender', { chat: t.GROUP, sender: 'unknown', text: 'hey you, what do you think', mentioned: [BOT] }, 0);
await asks('his own message', { chat: t.A, sender: t.A, text: 'hey there how are you', fromSelf: true }, 0);
await asks('forwarded', { chat: t.A, sender: t.A, text: 'look at this amazing thing', forwarded: true }, 0);
await asks('too short', { chat: t.A, sender: t.A, text: 'lol' }, 0);
await asks('digits only', { chat: t.A, sender: t.A, text: '12345 678' }, 0);
await asks('disappearing message', { chat: t.A, sender: t.A, text: 'this one will vanish soon', expiresAt: Math.floor(Date.now() / 1000) + 3600 }, 0);
{
  const n0 = calls();
  const msg = { id: 'NL1', groupJid: t.A, senderJid: t.A, content: 'forgotten already somehow', messageType: 'text', timestamp: t.clock.now() };
  const { storeMessage } = await import('../../src/memory/messageStore.js');
  storeMessage(msg);
  t.db.prepare('UPDATE messages SET no_learn = 1 WHERE id = ?').run('NL1');
  await say(t, { ...msg, chat: t.A, sender: t.A, text: msg.content, id: 'NL1', store: false });
  eq('a no_learn (forgotten) message', calls() - n0, 0);
}
await asks('a non-text message', { chat: t.A, sender: t.A, text: 'photo caption here', type: 'image' }, 0);
membership.markAllUnsynced();
await asks('stale group membership', { chat: t.GROUP, sender: t.B, text: 'hey you, what do you think', mentioned: [BOT] }, 0);
await asks('…and a DM whose sender is only in stale groups', { chat: t.A, sender: t.A, text: 'how was the day, all good?' }, 0);
for (const g of [t.GROUP, t.OTHER]) membership.__markSyncedForTest(g);
loadImitationModes();
setImitationTarget(t.GROUP, { targetJid: t.C, label: 'Casey', durationMinutes: 30, enabledBy: 'test', reason: 'test' });
await setSkills({ imitate: true });
await asks('a group he is imitating someone in', { chat: t.GROUP, sender: t.B, text: 'hey you, what do you think', mentioned: [BOT] }, 0);
clearImitationTarget(t.GROUP);
await setSkills({ imitate: false });

section('burst: the newest candidate line is the one asked about');
{
  const n0 = calls();
  await say(t, { chat: t.GROUP, sender: t.B, text: 'oi, you clown, you lost us the quiz', id: 'B1', mentioned: [BOT], verdict: null });
  await idle(t);
  const before = calls();
  await say(t, { chat: t.GROUP, sender: t.C, text: 'anyway who wants tea', id: 'B2', burstIds: ['B1', 'B2'] });
  const last = perceiveCalls(t).at(-1);
  eq('one call for the burst turn', calls() - before, 1);
  check('…about the mention in the earlier line', /you clown/.test(last?.state?.message ?? '') && !/who wants tea/.test(last?.state?.message ?? ''));
  void n0;
}

section('caps');
resetCaps();
t.config.chatInfluence.perSenderPerHour = 2;
for (let i = 0; i < 3; i++) await say(t, { chat: t.A, sender: t.A, text: `message number ${i} for you` });
const sameSender = perceiveCalls(t).slice(-3).length;
void sameSender;
resetCaps();
let n0 = calls();
for (let i = 0; i < 3; i++) await say(t, { chat: t.A, sender: t.A, text: `another message ${i} for you` });
eq('per sender per hour (2)', calls() - n0, 2);
t.clock.advance({ minutes: 61 });
n0 = calls();
await say(t, { chat: t.A, sender: t.A, text: 'an hour later, hello again' });
eq('…the window slides', calls() - n0, 1);
t.config.chatInfluence.perSenderPerHour = 6;
resetCaps();
t.config.chatInfluence.perChatPerHour = 2;
n0 = calls();
for (const s of [t.A, t.B, t.C]) await say(t, { chat: t.GROUP, sender: s, text: 'hey you, what do you think', mentioned: [BOT] });
eq('per chat per hour (2)', calls() - n0, 2);
t.config.chatInfluence.perChatPerHour = 20;

resetCaps();
const { dayStart } = await import('../../src/life/clock.js');
const ledgerToday = () => t.db.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE caller = 'life.chat.perceive'`).get().n;
const addLedger = (n) => {
  const ins = t.db.prepare(`INSERT INTO llm_usage (ts, role, provider, model, caller, cost_source) VALUES (?, 'jev', 'openrouter', 'fake', 'life.chat.perceive', 'unknown')`);
  for (let i = 0; i < n; i++) ins.run(t.clock.now() - 60);
};
void dayStart;
t.config.chatInfluence.jevMaxPerDay = 3;
addLedger(3 - ledgerToday());
n0 = calls();
await say(t, { chat: t.A, sender: t.A, text: 'after a restart, still capped?' });
eq('day cap from the ledger after a "restart" (local counter 0, 3 ledger rows)', calls() - n0, 0);
t.config.chatInfluence.jevMaxPerDay = 4;
t.db.exec('ALTER TABLE llm_usage RENAME TO llm_usage_moved');
n0 = calls();
await say(t, { chat: t.A, sender: t.A, text: 'ledger unreadable, so what now' });
eq('a ledger read failure counts as the cap reached', calls() - n0, 0);
t.db.exec('ALTER TABLE llm_usage_moved RENAME TO llm_usage');
resetCaps();
n0 = calls();
const { resolveAudience } = await import('../../src/memory/recall.js');
const { storeMessage } = await import('../../src/memory/messageStore.js');
const msgs = [t.A, t.B, t.C].map((s, i) => ({ id: `CC${i}`, groupJid: s, senderJid: s, content: `concurrent hello number ${i}`, messageType: 'text', timestamp: t.clock.now() }));
for (const m of msgs) storeMessage(m);
await Promise.all(msgs.map(m => t.life.perceiveChat(m, resolveAudience({ chatJid: m.groupJid }), {})));
await idle(t);
eq('three concurrent candidates with one slot left → one call', calls() - n0, 1);
t.config.chatInfluence.jevMaxPerDay = 80;
t.db.exec(`DELETE FROM llm_usage`);

section('gate verdicts');
resetCaps();
let ev0 = (await eventsOf(['chat.perceived'])).length;
await say(t, { chat: t.A, sender: t.A, text: 'you complete muppet', id: 'IG1', verdict: 'ignore' });
eq('ignore → nothing lands', (await eventsOf(['chat.perceived'])).length - ev0, 0);
await say(t, { chat: t.A, sender: t.A, text: 'you complete muppet again', id: 'RE1', verdict: 'react' });
eq('react → nothing lands', (await eventsOf(['chat.perceived'])).length - ev0, 0);
await say(t, { chat: t.A, sender: t.A, text: 'you complete muppet, sneaky', id: 'SN1', verdict: 'sneak' });
eq('sneak → lands', (await eventsOf(['chat.perceived'])).length - ev0, 1);
ev0 += 1;
const deferAt = t.clock.now();
const deferred = await say(t, { chat: t.B, sender: t.B, text: 'you are a disgrace, mate', id: 'DF1', verdict: 'defer' });
const held = t.db.prepare(`SELECT status, held, pointer_event_id FROM chat_influence_items WHERE msg_id = 'DF1'`).get();
check('defer → a held row (codes only, no pointer, no event)', held?.status === 'held' && held.pointer_event_id === null
  && JSON.parse(held.held).kind === 'affect' && !/disgrace/.test(held.held) && (await eventsOf(['chat.perceived'])).length === ev0);
t.life.enqueueDeferred(deferred, { isDm: true }, { remoteJid: t.B, id: 'DF1', fromMe: false });
t.clock.advance({ minutes: 40 });
const res = await t.life.checkPhoneNow();
const landed = (await eventsOf(['chat.perceived'])).find(e => e.payload.msgId === 'DF1');
check('…applied when the phone check reads it (dated at read time)', res.drained === 1 && !!landed && landed.at > deferAt + 30 * 60, { res, at: landed?.at });
eq('…the row is active now', t.db.prepare(`SELECT status FROM chat_influence_items WHERE msg_id = 'DF1'`).get()?.status, 'active');

section('untrusted answers → no event');
const perceiveMod = t.perceive;
const base = { kind: liveChoice('affect'), target: liveChoice('him'), affect: liveChoice('roast'), intensity: liveChoice('high'), advice: liveChoice('none') };
const variants = [
  ['Jev error', () => { throw new Error('boom'); }],
  ['BudgetError', async () => { const { BudgetError } = await import('../../src/brain/usage.js'); throw new BudgetError({ reason: 'test' }); }],
  ['unknown kind choice', () => ({ ...base, kind: liveChoice('explode') })],
  ['affect kind p < 0.5', () => ({ ...base, kind: liveChoice('affect', { affect: 0.45, none: 0.55 }) })],
  ['affect choice p < 0.5', () => ({ ...base, affect: liveChoice('roast', { roast: 0.45, praise: 0.3, none: 0.25 }) })],
  ['target someone_else', () => ({ ...base, target: liveChoice('someone_else') })],
  ['affect none', () => ({ ...base, affect: liveChoice('none') })],
  ['unknown affect', () => ({ ...base, affect: liveChoice('stabby') })],
  ['kind none', () => ({ ...base, kind: liveChoice('none') })],
  ['answers missing', () => ({})],
];
let k = 0;
for (const [name, fn] of variants) {
  perceiveMod.setJev(async (req) => ({ model: 'fake', answers: await fn(req), usage: {}, ms: 0 }));
  resetCaps();
  const e0 = (await eventsOf(['chat.perceived', 'mood.chat'])).length;
  await say(t, { chat: t.C, sender: t.C, text: `you are the worst ${k++}, honestly` });
  eq(name, (await eventsOf(['chat.perceived', 'mood.chat'])).length - e0, 0);
}
perceiveMod.setJev(t.jev.fn);
check('the classifier reads the live shape (type/choice/probabilities/confidence)', perceiveMod.classify(base)?.affect === 'roast'
  && perceiveMod.classify({ ...base, intensity: liveChoice('high', { high: 0.4, mid: 0.3, low: 0.3 }) })?.intensity === 'low');

section('mood moments count from 0.5; invites and advice keep 0.6 (owner 2026-10-31)');
{
  const affect55 = perceiveMod.classifyWhy({ ...base, kind: liveChoice('affect', { affect: 0.55, none: 0.45 }), affect: liveChoice('roast', { roast: 0.52, praise: 0.28, none: 0.2 }) });
  check('an affect at 0.55 with its affect at 0.52 is accepted', affect55.result?.kind === 'affect' && affect55.result?.affect === 'roast' && affect55.reason === null, affect55);
  eq('an affect at 0.49 is refused kind_p', perceiveMod.classifyWhy({ ...base, kind: liveChoice('affect', { affect: 0.49, none: 0.51 }) }).reason, 'kind_p');
  eq('an invite at 0.55 is still refused kind_p', perceiveMod.classifyWhy({ ...base, kind: liveChoice('invite', { invite: 0.55, none: 0.45 }) }).reason, 'kind_p');
  eq('advice at 0.55 is still refused kind_p', perceiveMod.classifyWhy({ ...base, kind: liveChoice('advice', { advice: 0.55, none: 0.45 }), advice: liveChoice('career') }).reason, 'kind_p');
  eq('the target bar stays 0.6 for an affect', perceiveMod.classifyWhy({ ...base, target: liveChoice('him', { him: 0.3, group_with_him: 0.25, someone_else: 0.45 }) }).reason, 'target_p');
  eq('an uncertain intensity (0.55) still reads low', perceiveMod.classify({ ...base, intensity: liveChoice('high', { high: 0.55, mid: 0.25, low: 0.2 }) })?.intensity, 'low');
}

section('target: him and the group with him count together (P(not someone_else) ≥ 0.6)');
{
  const tgt = (probs, choice) => ({ ...base, target: liveChoice(choice, probs) });
  const split = perceiveMod.classifyWhy(tgt({ him: 0.23, group_with_him: 0.55, someone_else: 0.22 }, 'group_with_him'));
  check('a split 0.23 + 0.55 is accepted', split.result?.affect === 'roast' && split.reason === null, split);
  eq('…the effective target is the larger of the two', split.target, 'group_with_him');
  eq('…and the other way round', perceiveMod.classifyWhy(tgt({ him: 0.45, group_with_him: 0.2, someone_else: 0.35 }, 'him')).target, 'him');
  const other = perceiveMod.classifyWhy(tgt({ him: 0.25, group_with_him: 0.1, someone_else: 0.65 }, 'someone_else'));
  check('someone_else at ≥ 0.6 is still refused', other.result === null && other.reason === 'target_other', other);
  const low = perceiveMod.classifyWhy(tgt({ him: 0.3, group_with_him: 0.25, someone_else: 0.45 }, 'someone_else'));
  check('…and him + group under 0.6 too', low.result === null, low);
  const lowTop = perceiveMod.classifyWhy(tgt({ him: 0.35, group_with_him: 0.2, someone_else: 0.45 }, 'him'));
  check('…(target_p when someone_else is not the top answer)', lowTop.result === null && lowTop.reason === 'target_p', lowTop);
  // Through the real path: one split-target message lands.
  perceiveMod.setJev(async () => ({ model: 'fake', answers: tgt({ him: 0.23, group_with_him: 0.55, someone_else: 0.22 }, 'group_with_him'), usage: {}, ms: 0 }));
  resetCaps();
  const e0 = (await eventsOf(['chat.perceived'])).length;
  await say(t, { chat: t.GROUP, sender: t.B, text: 'you lot are hopeless, you especially', mentioned: [BOT], verdict: 'now' });
  eq('…a split-target message lands (one chat.perceived)', (await eventsOf(['chat.perceived'])).length - e0, 1);
  perceiveMod.setJev(t.jev.fn);
}

section('no Jev call on a turn he will not read');
for (const [verdict, expected] of [['ignore', 0], ['react', 0], ['error', 0], ['now', 1], ['sneak', 1], ['defer', 1]]) {
  resetCaps();
  const c0 = calls();
  await say(t, { chat: t.A, sender: t.A, text: `you utter clown, verdict ${verdict}`, verdict });
  eq(`gate ${verdict} → ${expected} call${expected === 1 ? '' : 's'}`, calls() - c0, expected);
}
t.db.exec(`DELETE FROM chat_influence_items WHERE status = 'held'`);   // the deferred one is not read here
{
  resetCaps();
  const c0 = calls();
  const day = t.influence.outcomesToday();
  await say(t, { chat: t.GROUP, sender: t.B, text: 'just chatter between us, nobody', verdict: 'ignore' });
  eq('…a non-candidate is not counted at all', [calls() - c0, t.influence.outcomesToday().nothing - day.nothing], [0, 0]);
}

section('outcomes: one INFO line (codes only) + a per-day count for every perception');
{
  const { logger } = await import('../../src/utils/logger.js');
  const lines = [];
  const orig = logger.info;
  logger.info = function spy(obj, ...rest) {
    if (obj?.evt === 'chatInfluence.outcome') lines.push(obj);
    return orig.call(this, obj, ...rest);
  };
  t.db.exec(`DELETE FROM chat_influence_state WHERE key LIKE 'outcome:%'`);
  const answer = (over) => async () => ({ model: 'fake', answers: { ...base, ...over }, usage: {}, ms: 0 });
  const run = async (over, sayOpts) => {
    perceiveMod.setJev(over === 'error' ? async () => { throw new Error('boom'); } : answer(over));
    resetCaps();
    await say(t, sayOpts);
  };
  let i = 0;
  const txt = () => `you absolute legend number ${i++}`;
  await run({}, { chat: t.A, sender: t.A, text: txt(), verdict: 'now' });
  await run({}, { chat: t.B, sender: t.B, text: txt(), verdict: 'ignore' });
  await run({}, { chat: t.C, sender: t.C, text: txt(), verdict: 'react' });
  await run({ kind: liveChoice('none') }, { chat: t.A, sender: t.A, text: txt() });
  await run({ target: liveChoice('someone_else', { someone_else: 0.45, him: 0.3, group_with_him: 0.25 }) }, { chat: t.B, sender: t.B, text: txt() });
  await run({ target: liveChoice('someone_else') }, { chat: t.C, sender: t.C, text: txt() });
  await run('error', { chat: t.A, sender: t.A, text: txt() });
  const dm = 'OC1';
  await run({}, { chat: t.B, sender: t.B, text: txt(), id: dm, verdict: 'defer' });
  const counts1 = t.influence.outcomesToday();
  eq('applied / held / dropped / nothing today', [counts1.applied, counts1.held, counts1.dropped, counts1.nothing], [1, 1, 0, 6]);
  eq('…by reason (ignore/react: no call, counted as nothing:gate_<verdict>)', counts1.reasons, {
    'applied:affect': 1, 'held:affect': 1, 'nothing:gate_ignore': 1, 'nothing:gate_react': 1,
    'nothing:jev_error': 1, 'nothing:kind_none': 1, 'nothing:target_other': 2,
  });
  t.life.enqueueDeferred({ id: dm, groupJid: t.B, senderJid: t.B, content: 'x', timestamp: t.clock.now() }, { isDm: true }, { remoteJid: t.B, id: dm, fromMe: false });
  t.clock.advance({ minutes: 40 });
  await t.life.checkPhoneNow();
  const counts2 = t.influence.outcomesToday();
  eq('…the held one lands at the phone check (applied:held_affect)', counts2.reasons['applied:held_affect'], 1);
  const view = t.life.influenceNow();
  eq('GET /api/influence/now carries today\'s counts', [view.perceptions?.applied, view.perceptions?.nothing], [2, 6]);
  logger.info = orig;
  perceiveMod.setJev(t.jev.fn);
  eq('one INFO line per outcome', lines.length, 9);
  const KEYS = new Set(['evt', 'outcome', 'reason', 'kind', 'target', 'chat', 'n']);
  check('…codes only (no text, ids of people or chats)', lines.every(l => Object.keys(l).every(key => KEYS.has(key))
    && !/legend|@|\d{6,}/.test(JSON.stringify(l))), lines.slice(0, 3));
}

section('what is sent and what is stored');
resetCaps();
await say(t, { chat: t.A, sender: t.A, text: 'SECRET-PHRASE you utter clown', id: 'TX1' });
const req = perceiveCalls(t).at(-1);
check('the Jev request holds the fenced excerpt', /<<<STORY_DATA kind="claim">>>[\s\S]*SECRET-PHRASE[\s\S]*<<<END_STORY_DATA>>>/.test(req?.state?.message ?? ''));
check('…labelled earlier lines only (P1/P2/HIM)', typeof req?.state?.earlier === 'string' && /^<<<STORY_DATA kind="facts">>>/.test(req.state.earlier)
  && (req.state.earlier.match(/^(?!<<<)([^:\n]+):/gm) || []).every(l => /^(P\d|HIM):$/.test(l)));
eq('…typed questions only', Object.keys(req?.questions || {}).sort(), ['advice', 'affect', 'intensity', 'kind', 'target']);
eq('…and the caller label', req?.caller, 'life.chat.perceive');
const all = (await eventsOf(['chat.perceived', 'mood.chat', 'sleep.delayed', 'work.behind']));
check('no event payload holds message text', all.length > 0 && all.every(e => !/SECRET|clown|muppet|disgrace|worst|legend/i.test(JSON.stringify(e.payload))));
const rows = t.db.prepare('SELECT * FROM chat_influence_items').all();
check('no item row holds message text', rows.length > 0 && rows.every(r => !/SECRET|clown|muppet|disgrace|worst/i.test(JSON.stringify(r))));
const ptr = all.find(e => e.payload.msgId === 'TX1');
eq('the pointer: actor chat, the DM origin (canonical person), no subject in a DM', [ptr?.actor, ptr?.originKind, ptr?.originJid, ptr?.subjectJid],
  ['chat', 'dm', t.A, null]);
const g = all.find(e => e.type === 'chat.perceived' && e.originKind === 'group');
eq('…in a group: the group origin and the sender as subject', [g?.originJid, g?.subjectJid], [t.GROUP, t.B]);

report();
