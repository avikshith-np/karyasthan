// The simulation's log reader honours a page size (batch 3 review, finding 41): the pulse reads the log in
// 500-row pages (its "did he start this outing" check), and createSimLog's eventsAfter dropped the limit,
// so every ensemble run re-read up to 5000 rows per recent locked outing. With a limit it now returns at
// most that many rows, real ones first then the simulation's own, and paging through it sees every row
// exactly once; with no limit it reads as before. Example world, fake clock, stubbed models.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole } from './_helpers.js';
import { lastEventId } from '../../src/life/eventLog.js';
import { createSimLog } from '../../src/life/story/tomorrow.js';
import { rebuild } from '../../src/life/projector.js';

await setupScratchDb();
const { world, life } = await bootLife({ callRole: fakeCallRole({}) });
await simulateHours(10);
const base = lastEventId();
const raw = rebuild({ world, useSnapshot: false });   // a projection, not a view
const sim = createSimLog(raw, world);
for (let i = 0; i < 4; i++) sim.append({ type: 'vitals.checkpoint', at: raw.at + 60 * (i + 1), actor: 'engine', payload: { date: '2026-10-27', vitals: raw.vitals } });

section('a limit is a page size');
{
  check('(setup) a real log of some size', base > 20, String(base));
  eq('eventsAfter(0, 5): 5 rows', sim.eventsAfter(0, 5).length, 5);
  eq('…the first five, in order', sim.eventsAfter(0, 5).map(e => e.id), [1, 2, 3, 4, 5]);
  eq('a page across the real / sim boundary', sim.eventsAfter(base - 2, 4).map(e => e.id), [base - 1, base, base + 1, base + 2]);
  eq('a page of sim rows only', sim.eventsAfter(base + 1, 10).map(e => e.id), [base + 2, base + 3, base + 4]);
}

section('paging with a limit sees every row once; no limit reads as before');
{
  const seen = [];
  for (let after = 0; ;) { const page = sim.eventsAfter(after, 7); seen.push(...page.map(e => e.id)); if (page.length < 7) break; after = page[page.length - 1].id; }
  const all = sim.eventsAfter(0).map(e => e.id);
  eq('every row once, in order', seen, all);
  eq('no limit: real rows then the sim\'s', [all.length, all[all.length - 1]], [base + 4, base + 4]);
}

report();
