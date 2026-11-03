// 015 Director as god — scheduled changes (plan §1.3): a planned wake nudge is
// appended through the pulse's atWake seam before that morning's plan; a planned
// nudge reverted before it is due never fires; a later career change fires as an
// engine change.applied caused by its owner event (and re-plans today when it
// lands during his day); a planned sick spell starts once, and reverting that
// start alone does not bring it back (excluded consequence = happened and undone);
// pending.js never appends an owner event. Example world, fake clock, stubbed
// models, no network (arcs helpers' bootLife).
import fs from 'fs';
import path from 'path';
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR, PROJECT_ROOT,
} from '../arcs-tests/_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, addDays, dayStart } from '../../src/life/clock.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(28);              // Wed 28 Oct, morning
const S = () => life.getState();
const tz = world.timezone;

async function applyOk(action) {
  const p = await director.preview(action, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  return r.eventIds.map(getEvent);
}
const byType = (evs, t) => evs.find(e => e.type === t);
const after = (id, types) => listEvents({ types, after: id, limit: 500 });

section('a planned wake nudge lands before that morning\'s plan (atWake)');
{
  const evs = await applyOk({ kind: 'mood', preset: 'exhausted', wakeDay: 1 });
  const planned = byType(evs, 'vitals.planned');
  const tomorrow = dateKey(addDays(dayStart(clock.now(), tz), 1, tz), tz);
  eq('wakeDate = tomorrow', planned.payload.wakeDate, tomorrow);
  const skipped = byType(await applyOk({ kind: 'mood', preset: 'great', wakeDay: 1 }), 'vitals.planned');
  life.revertEvent(skipped.id, { reason: 'test: reverted before due' });
  await simulateHours(26);
  const nudges = after(planned.id, ['vitals.nudged']).filter(e => e.payload?.reason === 'planned');
  eq('exactly one planned nudge fired', nudges.length, 1);
  const n = nudges[0];
  check('…caused by the owner vitals.planned, engine, self', n?.causeId === planned.id && n.actor === 'engine' && n.originKind === 'self');
  check('…with the preset delta', n?.payload?.delta?.energy === -30 && n.payload.delta.stress === 10);
  const woke = after(planned.id, ['woke']).find(e => dateKey(e.at, tz) === tomorrow);
  const plan = after(planned.id, ['plan.made']).find(e => e.causeId === woke?.id);
  check('…at the wake, before that morning\'s plan.made', !!woke && n.at === woke.at && !!plan && n.id < plan.id);
  check('…the pending entry is consumed', !S().story.pending?.[planned.id]);
  check('the reverted one never fired', !after(skipped.id, ['vitals.nudged']).some(e => e.causeId === skipped.id));
}

section('a later career change fires once (change.applied) and re-plans today');
{
  // Mid-morning on a day he is awake: a salary change in 2 h.
  const evs = await applyOk({ kind: 'career', change: 'salary', salary: 88000, when: { inMinutes: 120 } });
  const set = byType(evs, 'career.set');
  check('pending until due', !!S().story.pending?.[set.id] && S().story.career.salary !== 88000);
  await simulateHours(3);
  const applied = after(set.id, ['change.applied']);
  eq('one change.applied', applied.length, 1);
  check('…engine, caused by the career.set', applied[0]?.causeId === set.id && applied[0].actor === 'engine');
  eq('the salary changed', S().story.career.salary, 88000);
  check('the pending entry is gone', !S().story.pending?.[set.id]);
  let msg = null;
  try { life.revertEvent(set.id, { reason: 'test' }); } catch (e) { msg = e.message; }
  check('once applied the career.set is no longer revertible', /cannot be reverted/.test(msg ?? ''), msg);
  await simulateHours(1);
  eq('…and never fires again', after(set.id, ['change.applied']).length, 1);
}

section('a planned sick spell starts once; its start reverted alone stays undone');
{
  const evs = await applyOk({ kind: 'health', change: 'sick', days: 1, when: { inMinutes: 60 } });
  const planned = byType(evs, 'sick.planned');
  await simulateHours(2);
  const starts = after(planned.id, ['sick.started']).filter(e => e.causeId === planned.id);
  eq('one engine sick.started {planned}', starts.length, 1);
  check('…reason planned', starts[0]?.payload?.reason === 'planned');
  check('he is sick', S().vitals.sick === true);
  life.revertEvent(starts[0].id, { reason: 'test: undo the start alone' });
  await simulateHours(1);
  eq('no second start after the revert (happened and undone)', after(planned.id, ['sick.started']).filter(e => e.causeId === planned.id).length, 1);
}

section('a scheduled fire during his working day re-plans the rest of today');
{
  // Next working morning: run to 10:00 local on a weekday he works.
  const fireIn = async () => {
    for (let i = 0; i < 6; i++) {
      const s = S();
      const work = (s.plan?.blocks ?? []).some(b => (b.kind === 'work' || b.kind === 'meeting') && b.start > clock.now() + 2 * HOUR);
      if (s.activity?.kind !== 'sleep' && work && !(s.plan?.blocks ?? []).some(b => b.fromAmendment)) return true;
      await simulateHours(4);
    }
    return false;
  };
  const ready = await fireIn();
  check('found a working day to test on', ready);
  if (ready) {
    const evs = await applyOk({ kind: 'career', change: 'fire', when: { inMinutes: 60 } });
    const set = byType(evs, 'career.set');
    await simulateHours(1.5);
    const applied = after(set.id, ['change.applied'])[0];
    const replan = applied ? after(applied.id, ['plan.made']).find(e => e.causeId === applied.id) : null;
    check('change.applied, then an engine plan.made caused by it', !!applied && !!replan && replan.actor === 'engine');
    check('…the rest of today has no work or meeting', !(S().plan?.blocks ?? []).some(b => (b.kind === 'work' || b.kind === 'meeting') && b.end > clock.now()));
    check('…he is out of work', S().story.career.employed === false);
  }
}

section('pending.js never appends an owner event (21-guards style)');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src/life/story/pending.js'), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  check('no actor owner in pending.js', !/actor:\s*['"]owner['"]/.test(src));
  void HOUR;
}

await stopLife();
report();
