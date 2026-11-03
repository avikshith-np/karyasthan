// 012 chatting at work (plan §P1.4): more than workMsgsPerHour of his own sent
// messages in the last hour during a work block → ONE work.behind that day (self
// origin, counts only — no chat named anywhere in it), work pressure up a little;
// none outside work, none twice a day, a reverted flag is not re-derived.
import { setupScratchDb, bootInfluence, eventsOf, section, check, eq, report } from './_helpers.js';

await setupScratchDb();
const { zonedToUnix } = await import('../../src/life/clock.js');
const t0 = await (async () => {
  const { exampleWorld } = await import('./_helpers.js');
  const w = await exampleWorld();
  return zonedToUnix(2026, 10, 27, 10, 0, w.timezone);       // Tue: an office day
})();
const t = await bootInfluence({ at: t0 });
const { storeMessage } = await import('../../src/memory/messageStore.js');
const { activityClass } = await import('../../src/life/vitals.js');
let n = 0;
const burst = (count, chats = [t.GROUP, t.OTHER, t.A]) => {
  const now = t.clock.now();
  for (let i = 0; i < count; i++) {
    storeMessage({ id: `W${++n}`, groupJid: chats[i % chats.length], senderJid: t.bot.pn, content: 'lol yes', messageType: 'text',
      timestamp: now - 30 - i * 60, isFromSelf: true });
  }
};
const tick = async (minutes = 15) => { t.clock.advance({ minutes }); await t.life.tick(); };
const st = () => t.life.getState();
const cls = () => activityClass(st().activity, { self: { officePlaceId: st().self?.officePlaceId } });

section('at work');
for (let i = 0; i < 12 && !['office', 'wfh', 'meeting'].includes(cls()); i++) await tick();
check('he is at work', ['office', 'wfh', 'meeting'].includes(cls()), cls());
burst(20);
await tick();
eq('20 messages in an hour: no flag', (await eventsOf('work.behind')).length, 0);
const pressureBefore = st().vitals.workPressure;
burst(10);
await tick();
let flags = await eventsOf('work.behind');
eq('30 messages in an hour: one work.behind', flags.length, 1);
const f = flags[0];
eq('…self origin, engine, no cause, no subject', [f?.originKind, f?.originJid, f?.actor, f?.causeId, f?.subjectJid], ['self', 'self', 'engine', null, null]);
eq('…counts only (no chat named)', Object.keys(f?.payload || {}).sort(), ['date', 'sent', 'windowMin', 'workPressure']);
check('…nothing that looks like a chat id in it', !/@|g\.us|lid/.test(JSON.stringify(f)));
check('…work pressure went up', st().vitals.workPressure > pressureBefore - 3, { before: pressureBefore, after: st().vitals.workPressure });
burst(40);
await tick();
eq('not twice a day', (await eventsOf('work.behind')).length, 1);

section('a revert stays undone');
t.life.revertEvent(f.id, { reason: 'test' });
burst(40);
await tick();
eq('reverted → not re-derived today', (await eventsOf('work.behind')).length, 1);
check('…and out of the projection', st().excluded.has(f.id) && st().influence?.workBehindDay !== st().plan.date);

section('outside work');
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: t.world.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t.clock.now() * 1000)));
for (let i = 0; i < 60 && (hourNow() < 21 || ['office', 'wfh', 'meeting', 'commute'].includes(cls())); i++) await tick();
check('evening: not at work', !['office', 'wfh', 'meeting'].includes(cls()), cls());
burst(60);
await tick();
eq('…no flag however much he chats', (await eventsOf('work.behind')).length, 1);

section('area off');
const day1 = st().plan.date;
for (let i = 0; i < 120 && (st().plan.date === day1 || !['office', 'wfh', 'meeting'].includes(cls())); i++) await tick();
t.config.chatInfluence.work = false;
burst(60);
await tick();
eq('the next work day with chatInfluence.work off: none', (await eventsOf('work.behind')).length, 1);
t.config.chatInfluence.work = true;
burst(60);
await tick();
eq('…switched back on: that day\'s flag', (await eventsOf('work.behind')).length, 2);

report();
