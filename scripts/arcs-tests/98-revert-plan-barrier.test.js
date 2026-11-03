// 2026-11-02 live: the owner set up a café date (15:00) and, later the same
// morning, a visit at his place (17:30). The visit's commit re-made the day's
// plan, and the café's blocks were then started from that plan. REVERT THIS
// CHANGE of the visit cascaded through the plan and took the café date too
// (the walk there, the date, the money, the scene). A revert's cascade now
// stops at a plan's activity / trip that belongs to ANOTHER decision's block —
// in eventLog.cascadeIds and in the projector's fold alike. The plan itself
// reverted directly still takes everything it started.
// Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, HOUR,
} from './_helpers.js';
import { listEvents, getEvent, cascadeIds, planBlockDecision } from '../../src/life/eventLog.js';
import { isExcludedId, rebuild } from '../../src/life/projector.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

section('planBlockDecision');
{
  const plan = { blocks: [
    { kind: 'commute', start: 100, end: 200, decisionId: 7 },
    { kind: 'hangout', start: 200, end: 500, decisionId: 7 },
    { kind: 'free', start: 500, end: 600 },
    { kind: 'visit', start: 600, end: 900, decisionId: 9 },
  ] };
  eq('a trip in an outing\'s commute block', planBlockDecision(plan, { type: 'travel.started', at: 100 }), 7);
  eq('a trip leaving a minute early still counts', planBlockDecision(plan, { type: 'travel.started', at: 50 }), 7);
  eq('the outing itself, resumed mid-block', planBlockDecision(plan, { type: 'activity.started', at: 377, payload: { kind: 'hangout' } }), 7);
  eq('another decision\'s block', planBlockDecision(plan, { type: 'activity.started', at: 600, payload: { kind: 'visit' } }), 9);
  eq('a routine block → null', planBlockDecision(plan, { type: 'activity.started', at: 500, payload: { kind: 'free' } }), null);
  eq('kind must match', planBlockDecision(plan, { type: 'activity.started', at: 250, payload: { kind: 'visit' } }), null);
  eq('other event types → null', planBlockDecision(plan, { type: 'money.spent', at: 250, payload: {} }), null);
}

await setupScratchDb();
const { world, clock, life } = await bootLife();
await simulateHours(54);   // a morning, two days in
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const day0 = dayStart(clock.now(), tz);
const at = (h, m = 0) => { const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number); return zonedToUnix(y, mo, d, h, m, tz); };
async function apply(action) {
  const p = await director.preview(action, { relax: true, project: false });
  check(`${action.label}: previews without refusals`, !p.refusals?.length, JSON.stringify(p.refusals));
  return director.apply(p.previewId, p.fingerprint);
}
const decisionOf = (label) => [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
const places = [...(S().world?.places ?? world.places ?? [])].filter(p => p && !/home/i.test(p.kind ?? '') && !/home/i.test(p.id));
const cafe = (places.find(p => /cafe|coffee|restaurant|bar|park/i.test(`${p.kind} ${p.id}`)) ?? places.find(p => !/office|work/i.test(`${p.kind} ${p.id}`)))?.id;
const home = world.self?.homePlaceId ?? 'place:home';
const friend = [...S().cast.values()].find(c => c.relation !== 'flatmate' && !/flatmate/i.test(c.role ?? ''))?.id;
check('the example world has a place out to meet at', !!cafe, JSON.stringify(places.map(p => p.id)));

const startOf = (d) => listEvents({ types: ['activity.started'], limit: 3000 })
  .find(e => e.at >= d.subject.eventAt - 5 * 60 && e.at < d.subject.eventAt + 30 * 60 && e.payload?.kind === d.kind);
const chainReaches = (id, target) => {
  for (let e = getEvent(id), n = 0; e && n < 200; e = e.causeId ? getEvent(e.causeId) : null, n++) if (e.id === target) return true;
  return false;
};

section('the live day: a café date, then a visit set up after it');
await apply({ kind: 'scene', shape: 'outing', placeId: cafe, startAt: at(15, 0), minutes: 120, castIds: [friend], label: 'Café date' });
await simulateHours(1);
const visitApply = await apply({ kind: 'scene', shape: 'visit', placeId: home, startAt: at(17, 30), minutes: 90, castIds: [friend], label: 'She comes over' });
const cafeD = decisionOf('Café date');
const visitD = decisionOf('She comes over');
check('both outings are committed', cafeD?.status === 'committed' && visitD?.status === 'committed',
  JSON.stringify([cafeD?.status, visitD?.status, visitApply]));
await simulateHours(Math.ceil((at(20, 0) - clock.now()) / HOUR));
const cafeStart = startOf(cafeD);
const visitStart = startOf(visitD);
check('he went to both', !!cafeStart && !!visitStart, JSON.stringify({ cafe: cafeStart?.id, visit: visitStart?.id,
  d: [cafeD, visitD].map(d => ({ kind: d?.kind, at: d?.subject?.eventAt, end: d?.subject?.endAt, place: d?.subject?.placeId })),
  acts: listEvents({ types: ['activity.started'], limit: 3000 }).filter(e => e.at >= at(14, 0)).map(e => [e.id, e.at, e.payload?.kind, e.payload?.placeId, e.causeId]) }));
const cafePlan = cafeStart ? getEvent(cafeStart.causeId) : null;
check('precondition (the live shape): the café was started from a plan re-made for the visit',
  cafePlan?.type === 'plan.made' && chainReaches(cafePlan.id, visitD.id),
  JSON.stringify({ plan: cafePlan?.id, cause: cafePlan?.causeId }));

section('reverting the visit keeps the café date');
{
  const ids = cascadeIds(visitD.id);
  check('the cascade takes the visit', ids.includes(visitStart.id));
  check('the cascade takes the re-made plan', ids.includes(cafePlan.id));
  check('the cascade stops at the café\'s start (another decision\'s block)', !ids.includes(cafeStart.id), JSON.stringify(ids));
  const p = life.revertChangePreview(visitApply.actionEventId);
  check('REVERT THIS CHANGE of the visit runs', !p.refusals.length && p.targets.length > 0, JSON.stringify(p.refusals));
  life.revertChange(visitApply.actionEventId, { fingerprint: p.fingerprint });
  const s = S();
  check('the visit is gone from his day', isExcludedId(s, visitStart.id));
  check('the café date is still in his day', !isExcludedId(s, cafeStart.id));
  const cafeKids = listEvents({ limit: 5000 }).filter(e => e.causeId === cafeStart.id);
  check('and everything it caused (its end, its spend)', cafeKids.length > 0 && cafeKids.every(e => !isExcludedId(s, e.id)),
    JSON.stringify(cafeKids.map(e => [e.id, e.type, isExcludedId(s, e.id)])));
  const trip = listEvents({ types: ['travel.started'], limit: 3000 }).find(e => e.causeId === cafePlan.id && e.payload?.to === cafe);
  if (trip) check('the walk there is kept', !isExcludedId(s, trip.id));
  eq('the café decision is still committed', s.decisions.get(cafeD.id)?.status, 'committed');
  const fresh = rebuild({ world, useSnapshot: false });
  check('a full rebuild agrees (café kept, visit gone)', !isExcludedId(fresh, cafeStart.id) && isExcludedId(fresh, visitStart.id));
  const snap = rebuild({ world });
  check('a snapshot rebuild agrees', !isExcludedId(snap, cafeStart.id) && isExcludedId(snap, visitStart.id));
}

section('the plan itself reverted still takes what it started');
{
  const ids = cascadeIds(cafePlan.id);
  check('a direct revert of the plan cascades into the café\'s start', ids.includes(cafeStart.id), JSON.stringify(ids));
}

report();
