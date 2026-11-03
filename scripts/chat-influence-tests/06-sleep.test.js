// 012 late chats (plan §P1.3): a live chat at bedtime pushes his sleep 30 min at
// a time (exactly two events per push, the current activity runs on, plan /
// activity / availability follow), re-checked each push, ≤ 120 min a night;
// reachable in that chat, a little less elsewhere; "up late chatting" only
// there; less sleep → more sleep debt. No push without a live chat, in a
// catch-up replay, after the owner undid tonight's push, or while the Director
// is paused.
import { setupScratchDb, bootInfluence, sent, say, eventsOf, stopEngine, startEngine, setSkills, section, check, eq, report } from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence();
const { storeMessage } = await import('../../src/memory/messageStore.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const { eventsAfter, lastEventId } = await import('../../src/life/eventLog.js');
const { hhmm } = await import('../../src/life/clock.js');
const tz = t.world.timezone;
const st = () => t.life.getState();
let n = 0;

// Tick until the coming night's bedtime is `minBefore` minutes away.
async function toBedtime(minBefore) {
  for (let i = 0; i < 200; i++) {
    const s = st();
    if (s.activity.kind !== 'sleep' && s.plan?.sleepAt && s.plan.sleepAt > t.clock.now() && s.plan.sleepAt - t.clock.now() <= minBefore * 60) return s.plan.sleepAt;
    t.clock.advance({ minutes: 15 });
    await t.life.tick();
  }
  throw new Error('no bedtime ahead');
}

// Three of his messages and three of theirs in the last few minutes of the group.
function liveChat(chat = t.GROUP) {
  const now = t.clock.now();
  for (let i = 0; i < 3; i++) {
    storeMessage({ id: `L${++n}`, groupJid: chat, senderJid: t.bot.pn, content: 'haha yes', messageType: 'text', timestamp: now - 60 * (i + 1), isFromSelf: true });
    storeMessage({ id: `L${++n}`, groupJid: chat, senderJid: [t.A, t.B, t.C][i], content: 'no way, really?', messageType: 'text', timestamp: now - 60 * (i + 1) - 20 });
  }
}

async function step(minutes = 15, live = true) {
  t.clock.advance({ minutes });
  if (live) liveChat();
  await t.life.tick();
}

section('night 1: a live chat keeps him up, 30 min at a time, ≤ 2 h');
let bed = await toBedtime(30);
const debtBefore = st().vitals.sleepDebt;
const firstId = lastEventId();
for (let i = 0; i < 12; i++) await step();
const pushes = (await eventsOf(['sleep.delayed'])).filter(e => e.id > firstId);
eq('four pushes (30 → 120 min), then he sleeps', pushes.map(e => e.payload.totalMin), [30, 60, 90, 120]);
const slept = eventsAfter(firstId, 10000).find(e => e.type === 'sleep.started');
eq('…he falls asleep 2 h after bedtime', slept && hhmm(slept.at, tz), hhmm(bed + 120 * 60, tz));
const evs = eventsAfter(firstId, 10000);
check('each push is exactly two events: the live pointer, then sleep.delayed caused by it', pushes.every((p) => {
  const i = evs.findIndex(e => e.id === p.id);
  const ptr = evs[i - 1];
  return ptr?.type === 'chat.perceived' && ptr.payload.kind === 'live' && p.causeId === ptr.id && ptr.actor === 'chat'
    && ptr.originJid === t.GROUP && p.originJid === t.GROUP;
}));
check('…and never ends the current activity (no activity.ended at a push)', pushes.every(p => !evs.some(e => e.type === 'activity.ended' && e.at === p.at)));
check('the pointer names the evidence message only (no text)', pushes.every(p => !/no way/.test(JSON.stringify(evs.find(e => e.id === p.causeId)?.payload))));

section('during a push');
await stopEngine(t);
// Replay the night up to the second push to look at the state then: a fresh boot on a fresh night instead.
await startEngine(t);
bed = await toBedtime(30);
for (let i = 0; i < 2; i++) await step();                        // 15 min before … 15 min after bedtime
let s = st();
const df = s.sleep?.delayedFor;
check('pushed: delayedFor names the live chat', df?.chatJid === t.GROUP && df.totalMin === 30, df);
eq('…plan.sleepAt and the sleep block moved +30 min', [s.plan.sleepAt, s.plan.blocks.find(b => b.kind === 'sleep')?.start], [bed + 1800, bed + 1800]);
check('…the activity runs on until then', s.activity.kind !== 'sleep' && s.activity.endAt === bed + 1800, s.activity);
const gG = t.life.gateMessage({ id: 'GG', groupJid: t.GROUP, senderJid: t.A }, { isGroup: true });
const gO = t.life.gateMessage({ id: 'GO', groupJid: t.OTHER, senderJid: t.A }, { isGroup: true });
check('the gate: the live chat as free, other chats a little less (light)', /^free:/.test(gG.reason) && /^light:/.test(gO.reason), [gG.reason, gO.reason]);
const lineG = t.life.innerStateLine(resolveAudience({ chatJid: t.GROUP }));
const lineO = t.life.innerStateLine(resolveAudience({ chatJid: t.OTHER }));
check('"up late chatting" only in that chat', /up late chatting/.test(lineG) && !/up late chatting/.test(lineO), [lineG, lineO]);
for (let i = 0; i < 12; i++) await step();
for (let i = 0; i < 40 && st().activity.kind === 'sleep'; i++) await step(15, false);
const woke = eventsAfter(0, 100000).filter(e => e.type === 'woke').at(-1);
check('next morning: less sleep → more sleep debt', st().vitals.sleepDebt > debtBefore + 1, { before: debtBefore, after: st().vitals.sleepDebt, slept: woke?.payload?.sleptMin });

section('no live chat → no push, no retry storm');
bed = await toBedtime(30);
let mark = lastEventId();
for (let i = 0; i < 4; i++) await step(15, false);
eq('no sleep.delayed, no live pointer', (await eventsOf(['sleep.delayed', 'chat.perceived'])).filter(e => e.id > mark).length, 0);
const night = eventsAfter(mark, 10000).filter(e => e.at >= bed - 60 && e.at <= bed + 60);
check('…he goes to sleep at bedtime with a handful of events', night.some(e => e.type === 'sleep.started' && e.at === bed) && night.length < 6, night.map(e => e.type));

section('an undone push stays undone that night');
bed = await toBedtime(30);
mark = lastEventId();
for (let i = 0; i < 2; i++) await step();
const push1 = (await eventsOf(['sleep.delayed'])).filter(e => e.id > mark);
check('pushed once', push1.length === 1);
t.life.revertEvent(push1[0].id, { reason: 'test', by: 'owner' });
for (let i = 0; i < 4; i++) await step();
eq('…the owner reverts it: no new push tonight despite the live chat', (await eventsOf(['sleep.delayed'])).filter(e => e.id > push1[0].id).length, 0);
check('…and he is asleep', st().activity.kind === 'sleep');

section('a catch-up replay never pushes');
bed = await toBedtime(60);
mark = lastEventId();
await stopEngine(t);
t.clock.set(bed - 120);
liveChat();
t.clock.set(bed + 3 * 3600);
await startEngine(t);
eq('downtime over bedtime with a live chat in the log → no push on replay', (await eventsOf(['sleep.delayed'])).filter(e => e.id > mark).length, 0);

section('paused Director → no push');
await setSkills({ arcs: true });
bed = await toBedtime(30);
t.life.appendOwnerBatch([{ type: 'director.paused', payload: { reason: 'test' } }]);
mark = lastEventId();
for (let i = 0; i < 4; i++) await step();
eq('paused: the live chat does not push his sleep', (await eventsOf(['sleep.delayed'])).filter(e => e.id > mark).length, 0);
await setSkills({ arcs: false });

section('area off');
t.config.chatInfluence.sleep = false;
bed = await toBedtime(30);
mark = lastEventId();
for (let i = 0; i < 4; i++) await step();
eq('chatInfluence.sleep off → no push', (await eventsOf(['sleep.delayed'])).filter(e => e.id > mark).length, 0);
void sent; void say;

report();
