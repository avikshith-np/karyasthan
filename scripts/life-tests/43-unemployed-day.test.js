// 015 Director as god — out of work (plan §P1.2): with world.self.employed false
// the routine has no office (officeOf before any fallback), a weekday is 'off'
// with the weekend wake, the plan has no work / meeting / office commute; an
// ordinary (employed) weekday is unchanged; the appraisal skips and a hunt starts
// with reason `unemployed`; an engine career.job_changed after an owner fire makes
// him employed again; the fold clears / sets the office; the overlay memo moves
// with overlayKey; "between jobs" and "former coworker" show in every audience
// (owner decision 7: shared freely). Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours,
} from '../arcs-tests/_helpers.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { rebuild } from '../../src/life/projector.js';
import { dayType, wakeTime, planDay, routineOf } from '../../src/life/routine.js';
import { zonedToUnix, dayStart, weekday } from '../../src/life/clock.js';
import { worldOverlay, overlayKey, overlayMemoKey } from '../../src/life/story/reducer.js';
import { appraisalDue, huntTrigger } from '../../src/life/story/career.js';
import * as director from '../../src/life/story/director.js';
import { worldOf } from '../../src/life/story/index.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(28);
const S = () => life.getState();
const tz = world.timezone;

section('routine: an employed weekday is unchanged; out of work it is off');
{
  const r = routineOf(world);
  // A weekday that is an office day in the example routine.
  let day = dayStart(clock.now(), tz);
  for (let i = 0; i < 7 && !(r.officeDays.includes(weekday(day + 43200, tz))); i++) day += 86400;
  const employedType = dayType(day, world, {});
  check(`employed: an office day stays office (got ${employedType})`, employedType === 'office');
  const jobless = { ...world, self: { ...world.self, employed: false, job: null } };
  eq('out of work: the same weekday is off', dayType(day, jobless, {}), 'off');
  const w1 = wakeTime(S(), day, world);
  const w2 = wakeTime(S(), day, jobless);
  check('…and he wakes at the weekend time', w2.base > w1.base);
  const plan = planDay(S(), day, jobless);
  check('no work, meeting or office commute in the plan', !plan.blocks.some(b => b.kind === 'work' || b.kind === 'meeting'
    || (b.kind === 'commute' && (b.to === world.self?.officePlaceId || b.to === world.self?.job?.officePlaceId))));
  check('the weekend is still the weekend', dayType(day + 86400 * ((7 + r.weekend[0] - weekday(day + 43200, tz)) % 7), jobless, {}) === 'weekend');
}

section('fire: the fold, the overlay, the career module');
{
  const keyBefore = overlayMemoKey(S());
  const officeBefore = S().self.officePlaceId;
  const p = await director.preview({ kind: 'career', change: 'fire' }, { relax: true });
  await director.apply(p.previewId, p.fingerprint);
  check('employed false, office cleared (story and self)', S().story.career.employed === false && S().story.career.officePlaceId === null && S().self.officePlaceId === null);
  check('overlayKey / memo key moved', overlayKey(S()) !== null && overlayMemoKey(S()) !== keyBefore);
  const w = worldOf(S(), world);
  check('worldOf: no job, salary 0, employed false', w.self.job === null && w.money.salary === 0 && w.self.employed === false);
  eq('the appraisal skips (unemployed)', appraisalDue(S(), clock.now(), { career: { appraisalMonth: 10 } }, world).reason, 'unemployed');
  eq('a hunt starts with reason unemployed', huntTrigger(S(), clock.now())?.reason, 'unemployed');
  const dm = { chatJid: '15550000001@s.whatsapp.net', kind: 'dm', members: new Set(['15550000001@s.whatsapp.net']) };
  const group = { chatJid: '120363000000000001@g.us', kind: 'group', members: new Set(['15550000001@s.whatsapp.net']) };
  const coworker = [...S().cast.values()].find(c => c.relation === 'coworker' || c.relation === 'manager');
  if (coworker) {
    const cardsDm = life.castCards(dm, `talking about ${coworker.name}`, 3).join(' | ');
    const cardsGroup = life.castCards(group, `talking about ${coworker.name}`, 3).join(' | ');
    check('a work cast card says former (DM)', /former (coworker|manager)/.test(cardsDm), cardsDm);
    check('…and the same in a group (shared freely)', /former (coworker|manager)/.test(cardsGroup), cardsGroup);
  }
  const lineDm = life.innerStateLine(dm);
  const lineGroup = life.innerStateLine(group);
  check('"between jobs" is told the same way in a DM and a group', /between jobs/.test(lineDm) === /between jobs/.test(lineGroup));
  // An engine rehire (the hunt's job change) makes him employed again.
  appendEvent({ type: 'career.job_changed', at: clock.now(), actor: 'engine', payload: { title: 'Planner', employerName: 'Fernway Labs', officePlaceId: officeBefore } });
  const folded = rebuild({ world });
  check('career.job_changed → employed again, with the office back', folded.story.career.employed === true && folded.self.officePlaceId === officeBefore);
}

section('hire to a new (owner-created) office: the plan commutes there');
{
  const near = [...S().places.values()].find(p => p.kind !== 'home');
  if (life.getState().story.career.employed !== false) {
    // Hire needs him out of work in the live state.
    const f = await director.preview({ kind: 'career', change: 'fire' }, { relax: true });
    await director.apply(f.previewId, f.fingerprint);
  }
  const p2 = await director.preview({ kind: 'career', change: 'hire', title: 'Coordinator', employerName: 'Quillmere Ltd', salary: 40000,
    newPlace: { name: 'Quillmere office', near: near.id, offsetKm: 2 } }, { relax: true });
  const res = await director.apply(p2.previewId, p2.fingerprint);
  const office = res.eventIds.map(getEvent).find(e => e.type === 'place.created')?.payload?.id;
  check('a new office place', typeof office === 'string');
  const w = worldOf(S(), world);
  check('the overlay world knows the new office', (Array.isArray(w.places) ? w.places : [...(w.places?.values?.() ?? [])]).some(x => x.id === office));
  let commute = false;
  for (let d = 1; d <= 7 && !commute; d++) {
    try { commute = planDay(S(), clock.now() + d * 86400, w).blocks.some(b => b.kind === 'commute' && b.to === office); } catch { /* skip */ }
  }
  check('a coming office day commutes to it', commute);
}

section('a pre-015 state: the overlay is the identity');
{
  const plain = { story: { career: { eventId: null } }, self: {} };
  check('overlayKey null → worldOverlay returns the world itself', overlayKey(plain) === null && worldOverlay(plain, world) === world);
}

await stopLife();
report();
