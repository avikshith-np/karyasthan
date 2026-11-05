// Plans made face to face (owner 2026-11-05): what a scene says they decided really happens, like plans in texts. Another
// day, straight on from there, back to one of their places, an errand or chore together or alone, a new spot, someone else
// asked along. Kept unless it clashes (then he says so in a text); a companion of the scene, so a revert takes it only if he
// hasn't set off.
import { setupScratchDb, bootLife, fakeCallRole, simulateHours, section, check, eq, report } from './_helpers.js';
import { listEvents, lastEventId } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, hhmm, weekday, dateKey } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { plansOf } from '../../src/life/story/scenes/schema.js';
import { plansOf as phonePlans } from '../../src/life/story/phone/worker.js';
import { isLockedOuting } from '../../src/life/pulse.js';
import { homeIdsOf } from '../../src/life/publicView.js';
import { haversineKm } from '../../src/life/travel.js';
import { config } from '../../src/utils/config.js';
import { logger } from '../../src/utils/logger.js';
import { __setWalletForTest } from '../../src/life/spending.js';
__setWalletForTest(false);

await setupScratchDb();

let plans = [];
let hisText = () => ({ messages: ['ah that wont work, another time?'], tone: 'warm', topic: 'plan', end: true });
const sceneJson = (o = {}) => JSON.stringify({
  narration: 'They met at the cafe after work and talked for a long while about small things. The rain had stopped and the street was quiet. '
    + 'He laughed more than he had all week, and by the end they had decided what to do next, the way people do when it is going well.',
  impressions: null, topics: ['old flatmates'], highlight: 'trading stories', awkward: null, chemistry: 0.6, focus: 'P1', ending: 'plan_to_meet', effects: [], plans, ...o,
});
let phonePlan = () => ({ agreed: false, kind: null, placeHint: null, when: null, day: null, minutes: null, confidence: 0.2 });
const usage = () => [];
const cr = fakeCallRole({
  'life.scene.clerk': () => sceneJson(),
  'life.scene.mind': () => sceneJson(),
  'life.phone.his': () => JSON.stringify(hisText()),
  'life.phone.mind': () => JSON.stringify(hisText()),
  'life.phone.cast': () => JSON.stringify({ messages: ['sure sounds good'], tone: 'warm', topic: 'plan', end: true }),
  'life.phone.plan': () => JSON.stringify(phonePlan()),
});
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'], identity: async () => 'You are Kiran.' });
config.arcs.phoneOrganicPerDay = 0;
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const friend = 'cast:flatmate';
const DAY = 86400;

const at = (off, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + off * DAY; };
async function untilTime(t) { while (clock.now() < t) await simulateHours(0.25); }
async function drain() { await story.idle(); await story.runScenesNow(); await story.idle(); await story.runPhoneNow(); await story.idle(); await (story.lastScheduleKick() ?? null); await story.idle(); }
async function apply(action) { const pv = await story.director.preview(action); const res = await story.director.apply(pv.previewId, pv.fingerprint); await story.idle(); await (story.lastScheduleKick() ?? null); await story.idle(); return res; }
const scenePlans = (castId = null) => [...S().decisions.values()].filter(d => d.committed?.by === 'scene' && d.status === 'committed' && (castId === null || (d.subject?.castIds ?? []).includes(castId)));
const planLog = [];
const info0 = logger.info.bind(logger);
logger.info = (obj, ...rest) => { if (obj?.evt === 'arcs_phone_plan') planLog.push(obj); return info0(obj, ...rest); };

// An outing at the cafe with them on the next free evening; the scene plays with `plans`, written as it ends.
let dayNo = 0;
async function outingWith(castId, p, { place = 'place:cafe' } = {}) {
  let k = 1;
  while (at(k, 12) <= clock.now() || [0, 6].includes(weekday(at(k, 12), tz))) k++;
  await untilTime(at(k, 17, 0));
  await drain();
  plans = p;
  const startAt = Math.round(at(0, 19, 30) / 300) * 300;
  const res = await apply({ kind: 'scene', shape: 'outing', placeId: place, castIds: [castId], startAt, minutes: 60, label: `Catch-up ${++dayNo}` });
  const after = lastEventId();
  await untilTime(startAt + 60 * 60);
  // The tick that ends it is followed by the scene job: run it right at the end, as live.
  await drain();
  await story.idle();
  plans = [];
  const row = sceneStore.listByStatus('done').at(-1);
  return { res, after, startAt, end: startAt + 3600, row };
}
const activities = (from) => listEvents({ types: ['activity.started'], from, limit: 500 });
const trips = (from) => listEvents({ types: ['travel.started'], from, limit: 200 });

section('the writer\'s plans: closed shape, a bad entry is dropped, never the scene');
{
  const ctx = { labels: { P1: friend } };
  eq('a full entry', plansOf([{ kind: 'outing', who: ['P1'], placeHint: 'Cinema', when: '19:30', day: 'saturday', minutes: 120 }], ctx)[0], { kind: 'outing', who: [friend], also: [], when: '19:30', day: 'saturday', minutes: 120, placeHint: 'cinema', spot: null, doing: null });
  eq('an extra key drops it', plansOf([{ kind: 'outing', who: ['P1'], note: 'x' }], ctx), []);
  eq('a bad kind drops it', plansOf([{ kind: 'heist', who: ['P1'] }], ctx), []);
  eq('alone: errands and chores only', plansOf([{ kind: 'outing', who: [] }, { kind: 'errand', who: [], doing: 'groceries' }], ctx).map(p => p.kind), ['errand']);
  eq('at most 3', plansOf(Array(5).fill({ kind: 'chore', who: [] }), ctx).length, 3);
  eq('a real person\'s scene has none', plansOf([{ kind: 'chore', who: [] }], ctx, { selfOnly: true }), []);
  eq('it went badly: nothing with them, his own chore stays', plansOf([{ kind: 'outing', who: ['P1'] }, { kind: 'chore', who: [] }], ctx, { negative: true }).map(p => p.kind), ['chore']);
  eq('a business-shaped word in capitals with digits isn\'t a spot', plansOf([{ kind: 'outing', who: ['P1'], spot: 'Cafe 42' }], ctx)[0].spot, null);
}

section('another day: a movie on Saturday → a real plan, locked, with no vague follow-up on top');
let satPlan;
{
  await simulateHours(1); await drain();
  const { row } = await outingWith(friend, [{ kind: 'outing', who: ['P1'], placeHint: 'cinema', when: '19:30', day: 'saturday', minutes: 120 }]);
  check('the scene was written', !!row, row);
  [satPlan] = scenePlans(friend);
  check('a plan by scene', !!satPlan && isLockedOuting(satPlan), satPlan?.committed);
  eq('the cinema, Saturday, 19:30', [satPlan?.subject?.placeId, weekday(satPlan?.subject?.eventAt ?? 0, tz), hhmm(satPlan?.subject?.eventAt ?? 0, tz)], ['place:cinema', 6, '19:30']);
  check('it names the scene', Number.isSafeInteger(satPlan?.sceneEventId));
  eq('no vague follow-up as well', listEvents({ types: ['scene.followup'], limit: 50 }).length, 0);
  const u = cr.callsFor('life.scene.mind').at(-1)?.user ?? cr.callsFor('life.scene.clerk').at(-1)?.user ?? '';
  check('the writer saw his week and who else he knows', /his week: work/.test(u) && /others he knows: /.test(u), u.slice(-600));
  check('both phone writers can see it', phonePlans(S(), friend, clock.now(), tz, { aheadHours: 7 * 24 }).some(l => /\[with them/.test(l)));
  // He really goes.
  const from = clock.now();
  await untilTime(satPlan.subject.eventAt + 1800);
  check('Saturday comes and he is at the cinema with them', activities(from).some(e => e.payload?.placeId === 'place:cinema' && (e.payload?.withCast ?? []).includes(friend)), activities(from).slice(-4).map(e => e.payload));
  await untilTime(satPlan.subject.endAt ?? satPlan.subject.eventAt + 7200);
  await simulateHours(1); await drain();
}

section('straight on from here: he turns round and goes, they stay together');
{
  const { end } = await outingWith(friend, [{ kind: 'outing', who: ['P1'], placeHint: 'cinema', when: 'now', minutes: 90 }]);
  const d = scenePlans(friend).at(-1);
  check('a plan to go on', d?.continuing === true && d?.subject?.placeId === 'place:cinema', d?.subject);
  check('it starts within the hour of the outing', d && d.subject.eventAt - end <= 3600, d?.subject?.eventAt - end);
  await untilTime(d.subject.eventAt + 900);
  const ts = trips(end - 60);
  check('he left the cafe for the cinema', ts.some(e => e.payload?.from === 'place:cafe' && e.payload?.to === 'place:cinema'), ts.map(e => e.payload));
  check('never got home in between', !activities(end).some(e => e.at < d.subject.eventAt && e.payload?.placeId === 'place:home'), activities(end).map(e => [e.at - end, e.payload?.kind, e.payload?.placeId]));
  check('there with them', activities(end).some(e => e.payload?.placeId === 'place:cinema' && (e.payload?.withCast ?? []).includes(friend)));
  await simulateHours(3); await drain();
}

section('back to his place: already heading home, they go with him');
{
  const who = 'cast:coworker-a';
  const { end } = await outingWith(who, [{ kind: 'visit_his', who: ['P1'], when: 'now', minutes: 90 }]);
  const d = scenePlans(who).at(-1);
  eq('a visit at his place', [d?.kind, d?.subject?.placeId], ['visit', 'place:home']);
  await untilTime(d.subject.eventAt + 900);
  check('home with them', activities(end).some(e => e.payload?.placeId === 'place:home' && (e.payload?.withCast ?? []).includes(who)), activities(end).map(e => [e.payload?.kind, e.payload?.placeId, e.payload?.withCast]));
  await simulateHours(3); await drain();
}

section('back to their place, where his world had no home for them: one is made, private');
{
  const who = 'cast:coworker-b';
  const { end } = await outingWith(who, [{ kind: 'visit_theirs', who: ['P1'], when: 'now', minutes: 90 }]);
  const d = scenePlans(who).at(-1);
  const home = S().cast.get(who)?.home;
  check('their home is set and is the plan\'s place', typeof home === 'string' && d?.subject?.placeId === home, [home, d?.subject]);
  eq('kind home', S().places.get(home)?.kind, 'home');
  check('counted as a home by the public filter', homeIdsOf(S()).has(home));
  await untilTime(d.subject.eventAt + 900);
  check('he went from the cafe', trips(end - 60).some(e => e.payload?.from === 'place:cafe' && e.payload?.to === home), trips(end - 60).map(e => e.payload));
  await simulateHours(3); await drain();
}

section('his own errand and chore: he actually does them');
{
  await outingWith(friend, [
    { kind: 'errand', who: [], doing: 'groceries', when: '10:00', day: 'saturday', minutes: 45 },
    { kind: 'chore', who: [], doing: 'laundry', when: '12:00', day: 'saturday', minutes: 45 },
  ]);
  const mine = scenePlans().filter(d => !(d.subject?.castIds ?? []).length);
  eq('two plans of his own', mine.length, 2);
  const shop = mine.find(d => d.subject.placeId !== 'place:home');
  const chore = mine.find(d => d.subject.placeId === 'place:home');
  eq('groceries at the shop', [S().places.get(shop?.subject?.placeId)?.kind, shop?.options?.find(o => o.id === 'go')?.label], ['shop', 'Groceries']);
  eq('laundry at home', chore?.options?.find(o => o.id === 'go')?.label, 'Laundry at home');
  const from = clock.now();
  await untilTime(chore.subject.eventAt + 900);
  const a = activities(from);
  check('he went to the shop', a.some(e => e.payload?.placeId === shop.subject.placeId), a.slice(-6).map(e => e.payload));
  check('and did the chore at home', a.some(e => e.payload?.placeId === 'place:home' && e.at >= chore.subject.eventAt - 600 && e.payload?.kind === 'errand'), a.slice(-6).map(e => [e.payload?.kind, e.payload?.placeId]));
  await simulateHours(2); await drain();
}

section('an errand together; a chore counts for them too');
{
  const who = friend;
  await outingWith(who, [{ kind: 'errand', who: ['P1'], doing: 'groceries', when: '11:00', day: 'sunday', minutes: 60 }]);
  const d = scenePlans(who).at(-1);
  eq('at the shop, with them', [S().places.get(d?.subject?.placeId)?.kind, d?.subject?.castIds], ['shop', [who]]);
}

section('a spot his world doesn\'t have: it is added, generic, and only two a week');
{
  const who = 'cast:coworker-a';
  await outingWith(who, [{ kind: 'outing', who: ['P1'], placeHint: 'restaurant', spot: 'dosa place', when: '20:00', day: 'tuesday' }]);
  const d = scenePlans(who).at(-1);
  const p = S().places.get(d?.subject?.placeId);
  eq('a new place', [p?.name, p?.kind], ['Dosa place', 'restaurant']);
  check('a little way from where they were', haversineKm(S().places.get('place:cafe'), p) <= 3.2);
  const n0 = listEvents({ types: ['place.created'], limit: 200 }).length;
  await outingWith(who, [{ kind: 'outing', who: ['P1'], placeHint: 'restaurant', spot: 'dosa place', when: '20:00', day: 'friday' }]);
  eq('the same spot again adds nothing', listEvents({ types: ['place.created'], limit: 200 }).length, n0);
}

section('someone else asked along: they join the plan and he texts them');
{
  await outingWith(friend, [{ kind: 'outing', who: ['P1'], also: ['Manager'], placeHint: 'restaurant', when: '20:30', day: 'sunday' }]);
  const d = scenePlans(friend).at(-1);
  eq('both on the plan', d?.subject?.castIds, [friend, 'cast:manager']);
  await simulateHours(0.25); await drain();
  const row = phoneStore.threadOf('cast:manager', { live: true })[0];
  eq('he texts them', [row?.trigger, row?.dir], ['plan_invite', 'out']);
  const hu = cr.callsFor('life.phone.his').at(-1)?.user ?? cr.callsFor('life.phone.mind').at(-1)?.user ?? '';
  check('told why', /why now: he has plans and asks Manager/.test(hu), hu.split('\n').filter(l => /why now/.test(l)));
  check('going is not asked of anyone else', !phoneStore.pendingFor(friend).some(r => r.trigger === 'plan_invite'));
}

section('it clashes: no plan, and he texts them to say so');
{
  const who = 'cast:coworker-b';
  const before = scenePlans(who).length;
  await outingWith(who, [{ kind: 'outing', who: ['P1'], placeHint: 'park', when: '11:00', day: 'wednesday' }]);
  eq('no plan', scenePlans(who).length, before);
  for (let i = 0; i < 4 && !phoneStore.threadOf(who, { live: true }).some(r => r.trigger === 'plan_clash'); i++) { await simulateHours(0.25); await drain(); }
  const u = cr.callsFor('life.phone.his').at(-1)?.user ?? '';
  check('the plan_clash text went out, told why', phoneStore.threadOf(who, { live: true }).some(r => r.trigger === 'plan_clash') && /he (?:is at work|has a meeting) then/.test(u), u.slice(-400));
}

section('reverting the scene takes a plan he hasn\'t set off for; a lived one stays');
{
  const who = 'cast:coworker-a';
  await outingWith(who, [{ kind: 'outing', who: ['P1'], placeHint: 'park', when: '09:00', day: 'sunday' }]);
  const d = scenePlans(who).at(-1);
  eq('at the park', d?.subject?.placeId, 'place:park');
  life.revertEvent(d.sceneEventId, { reason: 'test', by: 'owner' });
  await story.idle(); await drain();
  check('the plan went with the scene', S().excluded?.has?.(d.id) || S().excluded?.has?.(d.eventId), S().decisions.get(d.id)?.status);
  check('a lived plan isn\'t touched: Saturday\'s cinema is still in the log', !S().excluded?.has?.(satPlan.eventId ?? satPlan.id));
}

section('later texts can move a plan made face to face');
{
  const who = 'cast:coworker-a';
  await outingWith(who, [{ kind: 'outing', who: ['P1'], placeHint: 'restaurant', when: '20:00', day: 'saturday' }]);
  const d = scenePlans(who).at(-1);
  eq('the plan', [S().places.get(d?.subject?.placeId)?.kind, hhmm(d?.subject?.eventAt ?? 0, tz)], ['restaurant', '20:00']);
  phonePlan = () => ({ agreed: true, kind: 'outing', placeHint: null, when: '21:00', day: null, minutes: null, confidence: 0.9, change: 'move' });
  hisText = () => ({ messages: ['can we make it 9 instead on saturday'], tone: 'warm', topic: 'plan', end: true });
  await apply({ kind: 'text', castId: who, gist: 'ask to make saturday later' });
  await drain();
  const now = scenePlans(who).at(-1);
  eq('moved to 21:00, still a face-to-face plan, the old one closed', [hhmm(now?.subject?.eventAt ?? 0, tz), now?.committed?.by, S().decisions.get(d.id)?.status], ['21:00', 'scene', 'cancelled']);
}

report();
