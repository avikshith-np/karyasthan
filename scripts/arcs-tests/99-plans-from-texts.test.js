// 019 his phone — plans from texts (owner 2026-11-01): when he and someone from his world agree
// in texts to meet, it becomes a real plan in his life; a writer never agrees to a plan his world
// can't hold. The two live misses replayed on the example world with a stubbed clerk:
//   (a) she texts "on my way over to your place now" at 23:26 → a visit at his place 15–30 min on,
//       committed and locked (by 'text'), caused by that text, fitted into his night;
//   (b) he and she agree a "Wednesday evening showdown" → an outing on Wednesday evening.
// Plus: the prefilter (small talk never reaches the clerk), refusals (a clash, a frozen story, a
// place his world doesn't have, asleep), a second "see you then" makes no second plan, the revert
// cascade (reverting the agreeing text takes the plan and the fitted day), both writers seeing it
// as "[with them]", Life · Day's row, codes-only logs, the charter lines.
// Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole,
} from './_helpers.js';
import { getEvent, listEvents } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, dateKey, weekday, hhmm } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { plansOf, CALLER_PLAN } from '../../src/life/story/phone/worker.js';
import { cueCheck, validatePlanOutput, resolveTextPlan, planLabel, PLAN_PROMPT } from '../../src/life/story/phone/plans.js';
import { HIS_CHARTER, CAST_CHARTER } from '../../src/life/story/phone/charter.js';
import { isLockedOuting } from '../../src/life/pulse.js';
import { logger } from '../../src/utils/logger.js';
import { config } from '../../src/utils/config.js';
import { __setWalletForTest } from '../../src/life/spending.js';
__setWalletForTest(false);

await setupScratchDb();

// Codes-only log lines of the plan step.
const planLogs = [];
const info0 = logger.info.bind(logger);
logger.info = (obj, ...rest) => { if (obj?.evt === 'arcs_phone_plan') planLogs.push(obj); return info0(obj, ...rest); };

const ledger = [];
const usage = (prefix, since) => {
  const rows = new Map();
  for (const r of ledger) {
    if (r.at < since || !r.caller.startsWith(prefix)) continue;
    const x = rows.get(r.caller) ?? { caller: r.caller, calls: 0, costUsd: 0 };
    x.calls += 1; x.costUsd += r.cost;
    rows.set(r.caller, x);
  }
  return [...rows.values()];
};
const WORDS = ['moon', 'chai', 'rain', 'song', 'stars', 'balcony', 'noodles', 'traffic', 'cricket', 'beach', 'dogs', 'mango'];
let turnNo = 0;
const fresh = () => `${WORDS[turnNo++ % WORDS.length]} ${turnNo}`;
let his = () => ({ messages: [fresh()], tone: 'warm', topic: 'chat', end: false });
let theirs = () => ({ messages: [fresh()], tone: 'warm', topic: 'chat', end: false });
let plan = () => ({ agreed: false, kind: 'outing', placeHint: null, when: null, day: null, minutes: null, confidence: 0.2 });
let clockNow = () => 0;
const cr = fakeCallRole({
  'life.phone.his': () => { ledger.push({ caller: 'life.phone.his', at: clockNow(), cost: 0.001 }); return JSON.stringify(his()); },
  'life.phone.mind': () => { ledger.push({ caller: 'life.phone.mind', at: clockNow(), cost: 0.01 }); return JSON.stringify(his()); },
  'life.phone.cast': () => { ledger.push({ caller: 'life.phone.cast', at: clockNow(), cost: 0.001 }); return JSON.stringify(theirs()); },
  [CALLER_PLAN]: () => { ledger.push({ caller: CALLER_PLAN, at: clockNow(), cost: 0.0005 }); return JSON.stringify(plan()); },
});
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
clockNow = () => clock.now();
story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: false }), knownNames: () => ['Quinn Marlow'],
  identity: async () => 'You are Kiran, a 28-year-old from the example town.' });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const visitor = 'cast:coworker-a';
const rival = 'cast:coworker-b';
const flat = 'cast:flatmate';
config.arcs.phoneOrganicPerDay = 0;   // no texts out of the blue mixing into the threads under test

async function drain() { await story.idle(); await story.runPhoneNow(); await story.idle(); await (story.lastScheduleKick() ?? null); await story.idle(); }
async function applyAction(action) {
  const pv = await story.director.preview(action);
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  await story.lastPhoneKick();
  await story.idle();
  await (story.lastScheduleKick() ?? null);
  return { pv, res };
}
const at = (dayOffset, hh, mm = 0) => {
  const p = localParts(clock.now(), tz);
  return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * 86400;
};
async function untilTime(t) { while (clock.now() < t) await simulateHours(0.25); }
const textPlans = (castId) => [...S().decisions.values()].filter(d => d.committed?.by === 'text' && (d.subject?.castIds ?? []).includes(castId));
const planCalls = () => cr.callsFor(CALLER_PLAN).length;
const msgEv = (castId) => phoneStore.threadOf(castId, { live: true })[0]?.eventId;

section('first job seeds the cursor');
{
  await simulateHours(0.5);
  await drain();
  check('cursor seeded', phoneStore.getCursor() !== null);
}

section('the prefilter: a plan cue and a yes in the newest turn — small talk never reaches the clerk');
{
  check('"on my way over to your place now" (both cues in one turn)', cueCheck('on my way over to your place now'));
  check('"deal, see you wednesday" after "wednesday showdown?"', cueCheck('deal! see you wed', 'wednesday evening showdown?'));
  check('"sure" after "coffee at 7?"', cueCheck('sure', 'coffee at 7?'));
  check('small talk: "haha same"', !cueCheck('haha same', 'cant sleep either'));
  check('a plan cue without a yes: "dinner tomorrow?"', !cueCheck('dinner tomorrow?', 'hey'));
  check('a yes without any plan: "yeah totally"', !cueCheck('yeah totally', 'that was so weird right'));
  check('everyday words that are also day abbreviations don\'t count ("sun", "sat")', !cueCheck('yeah the sun was out', 'sat by the window all day'));
  // Live: an exchange of small talk spends no plan call.
  const n0 = planCalls();
  his = () => ({ messages: ['how was your day'], tone: 'warm', topic: 'day', end: false });
  theirs = () => ({ messages: ['long one, so tired lol'], tone: 'casual', topic: 'day', end: true });
  await untilTime(at(1, 12, 30));
  await applyAction({ kind: 'text', castId: flat, gist: 'ask how their day was' });
  for (let i = 0; i < 6 && phoneStore.threadOf(flat, { live: true }).length < 2; i++) { await simulateHours(0.25); await drain(); }
  check('the chat ran (his text, their answer)', phoneStore.threadOf(flat, { live: true }).length >= 2);
  eq('no plan clerk call for small talk', planCalls(), n0);
}

section('the clerk\'s answer is held to its schema');
{
  check('a full answer passes', validatePlanOutput(JSON.stringify({ agreed: true, kind: 'outing', placeHint: 'cafe', when: '19:00', day: 'wednesday', minutes: 120, confidence: 0.8 })).ok);
  eq('an extra key → keys', validatePlanOutput(JSON.stringify({ agreed: true, kind: 'outing', confidence: 0.9, note: 'x' })).reason, 'keys');
  check('"nothing agreed" may leave the kind empty (→ nothing not_agreed, not invalid)', validatePlanOutput(JSON.stringify({ agreed: false, kind: null, confidence: 0.9 })).ok);
  eq('an agreement must name its kind', validatePlanOutput(JSON.stringify({ agreed: true, kind: null, confidence: 0.9 })).reason, 'kind');
  eq('a bad kind', validatePlanOutput(JSON.stringify({ agreed: true, kind: 'party', confidence: 0.9 })).reason, 'kind');
  eq('a bad time', validatePlanOutput(JSON.stringify({ agreed: true, kind: 'outing', when: '7pm', confidence: 0.9 })).reason, 'when');
  eq('a bad day', validatePlanOutput(JSON.stringify({ agreed: true, kind: 'outing', day: 'someday', confidence: 0.9 })).reason, 'day');
  eq('not JSON', validatePlanOutput('they agreed to meet').reason, 'parse');
  check('the prompt is persona-neutral and fenced (STORY_DATA, no names)', /STORY_DATA/.test(PLAN_PROMPT) && !/Kiran|Coworker/.test(PLAN_PROMPT));
}

let wed;
section('(b) "Wednesday evening showdown" — he asks, she says deal → an outing on Wednesday evening');
{
  // An evening at home (by day he is at work with her: their texts wait until they part).
  await untilTime(at(1, 20, 0));
  const n0 = planCalls();
  his = () => ({ messages: ['rematch? wednesday evening showdown at the cafe'], tone: 'teasing', topic: 'showdown', end: false });
  theirs = () => ({ messages: ['deal. see you wednesday, loser buys coffee'], tone: 'teasing', topic: 'showdown', end: false });
  plan = () => ({ agreed: true, kind: 'outing', placeHint: 'cafe', when: null, day: 'wednesday', minutes: 120, confidence: 0.85 });
  await applyAction({ kind: 'text', castId: rival, gist: 'challenge her to a wednesday evening showdown at the cafe' });
  for (let i = 0; i < 8 && !textPlans(rival).length; i++) { await simulateHours(0.25); await drain(); }
  [wed] = textPlans(rival);
  check('a plan clerk call after her "deal"', planCalls() > n0);
  check('an outing with her, committed by text', wed?.status === 'committed' && wed?.kind === 'hangout' && wed?.committed?.by === 'text', wed);
  eq('at the cafe, on a Wednesday (3), in the evening', [wed?.subject?.placeId, weekday(wed?.subject?.eventAt ?? 0, tz), hhmm(wed?.subject?.eventAt ?? 0, tz) >= '19:00'], ['place:cafe', 3, true]);
  check('within 7 days', wed && wed.subject.eventAt - clock.now() <= 7 * 86400);
  eq('the label', wed?.options?.find(o => o.id === 'go')?.label, 'Coffee with Coworker at the cafe');
  // His next text sees it on his sheet (planLines → "[with them …]").
  his = () => ({ messages: ['bring your a game wednesday'], tone: 'teasing', topic: 'showdown', end: true });
  for (let i = 0; i < 6 && !phoneStore.threadOf(rival, { live: true }).some(r => r.text === 'bring your a game wednesday'); i++) { await simulateHours(0.25); await drain(); }
  const hu = cr.callsFor('life.phone.his').at(-1)?.user ?? '';
  check('his writer\'s sheet lists it [with them]', /Coffee with Coworker at the cafe/.test(hu) && /\[with them/.test(hu), hu.slice(hu.indexOf('his plans'), hu.indexOf('his plans') + 300));
}

section('a second "see you then" in the same exchange makes no second plan (and spends no call)');
{
  const n0 = planCalls();
  theirs = () => ({ messages: ['ok cool, bring snacks'], tone: 'warm', topic: 'showdown', end: true });
  const id = phoneStore.insertPending({ castId: rival, dir: 'in', trigger: 'reply', triggerEventId: msgEv(rival), exchange: 3, dueAt: clock.now(), createdAt: clock.now() });
  await drain();
  check('her line went out', phoneStore.getMessage(id)?.status === 'live', phoneStore.getMessage(id));
  eq('still one plan with her', textPlans(rival).length, 1);
  eq('no clerk call (already planned in this exchange)', planCalls(), n0);
  check('logged nothing already_planned', planLogs.at(-1)?.outcome === 'nothing' && planLogs.at(-1)?.code === 'already_planned', planLogs.at(-1));
}

let visit; let visitText;
section('(a) 23:26 — she texts "on my way over to your place now" → a visit at his place, locked, caused by the text');
{
  // Friday night (the live case was a weekend night: he was up, texting).
  let k = 0;
  while (weekday(at(k, 12), tz) !== 5 || at(k, 23, 26) <= clock.now()) k++;
  await untilTime(at(k, 23, 26));
  check('he is up and at home', S().activity?.kind !== 'sleep' && S().position?.placeId === 'place:home', [S().activity?.kind, S().position?.placeId]);
  plan = () => ({ agreed: true, kind: 'visit_his', placeHint: null, when: 'now', day: 'today', minutes: 90, confidence: 0.9 });
  theirs = () => ({ messages: ['door'], tone: 'warm', topic: 'visit', end: false });
  const t0 = clock.now();
  const n0 = planCalls();
  await applyAction({ kind: 'text', castId: visitor, from: 'them', words: 'on my way over to your place now' });
  await drain();
  visitText = phoneStore.threadOf(visitor, { live: true }).reverse()[0];
  eq('her text is live, verbatim', visitText?.text, 'on my way over to your place now');
  eq('one plan clerk call', planCalls(), n0 + 1);
  const pu = cr.callsFor(CALLER_PLAN).at(-1)?.user ?? '';
  check('the clerk sees the fenced texts and her fictional name only', /STORY_DATA/.test(pu) && /on my way over to your place now/.test(pu) && /them: Coworker/.test(pu) && !/@s\.whatsapp|Quinn/.test(pu), pu.slice(0, 400));
  [visit] = textPlans(visitor);
  check('a committed plan with her', visit?.status === 'committed' && visit.committed?.optionId === 'go', visit);
  eq('by text, a visit at his place, with her', [visit?.committed?.by, visit?.kind, visit?.subject?.placeId, visit?.subject?.castIds], ['text', 'visit', 'place:home', [visitor]]);
  const eta = (visit?.subject?.eventAt ?? 0) - t0;
  check('she is there 15–30 min after the text', eta >= 15 * 60 && eta <= 35 * 60, eta / 60);
  check('a locked outing (fitted like a goal / owner plan; wins over routine plans)', isLockedOuting(visit));
  const opened = getEvent(visit?.eventId);
  eq('decision.opened: engine, caused by the agreeing phone.message', [opened?.actor, getEvent(opened?.causeId)?.type, opened?.causeId], ['engine', 'phone.message', visitText?.eventId]);
  eq('the label is code-built', visit?.options?.find(o => o.id === 'go')?.label, 'Coworker comes over to his place');
  check('logged: applied visit_his (codes only)', planLogs.some(l => l.outcome === 'applied' && l.code === 'visit_his' && l.decisionId === visit?.id)
    && planLogs.every(l => Object.keys(l).every(k => ['evt', 'outcome', 'code', 'kind', 'id', 'decisionId'].includes(k))), planLogs.at(-1));
}

section('(a) both writers see it; the pulse fits it into his night');
{
  const lines = plansOf(S(), visitor, clock.now(), tz);
  check('"his plans": Coworker A (example) coming over to his place [with them]', lines.some(l => l.includes(`${S().cast.get(visitor).name} coming over to his place`) && /\[with them/.test(l)), lines);
  const fitted = listEvents({ types: ['plan.made'], from: visitText.at - 60, limit: 50 }).find(e => e.payload?.amendedFor === visit.id || (e.payload?.blocks ?? []).some(b => b.decisionId === visit.id));
  check('the pulse fitted the visit into the plan in force (settled at once, no wait for the tick)', !!fitted, listEvents({ types: ['plan.made'], from: visitText.at - 60, limit: 50 }).map(e => e.payload?.amendedFor));
  for (let i = 0; i < 6 && !(S().activity?.withCast ?? []).includes(visitor); i++) await simulateHours(0.25);
  check('she arrives: he is with her at home (a visit, not asleep)', (S().activity?.withCast ?? []).includes(visitor) && S().activity?.placeId === 'place:home', S().activity);
  const day = await life.dayView({ date: dateKey(visitText.at, tz) });
  const row = (day?.past?.decisions ?? []).find(d => d.id === visit.id);
  check('Life · Day: the decision row — its label, with her, settled by "text" (the page words it "agreed in texts")',
    row?.outcome?.by === 'text' && /comes over to his place/.test(row?.outcome?.label ?? '') && row?.with?.length === 1, row);
}

section('(a) reverting the agreeing text takes the plan and the fitted night with it');
{
  const ids = [visit.eventId, visit.committed.eventId];
  life.revertEvent(visitText.eventId, { reason: 'test', by: 'owner' });
  await story.idle();
  check('the decision is gone from his world', !S().decisions.get(visit.id) || S().excluded?.has?.(visit.eventId), S().decisions.get(visit.id)?.status);
  check('opened and committed are excluded', ids.every(id => S().excluded?.has?.(id)), ids);
  const fitted = listEvents({ types: ['plan.made'], from: visitText.at - 60, limit: 50 }).filter(e => e.causeId === visit.committed.eventId);
  check('the fitted plan.made went too', fitted.length > 0 && fitted.every(e => S().excluded?.has?.(e.id)), fitted.map(e => e.id));
  check('his plans no longer list it', !plansOf(S(), visitor, clock.now(), tz).some(l => /coming over/.test(l)));
}

section('asleep: her owner-started text wakes him ("on my way over to yours, open up") → the visit stands; his night bends around it');
{
  for (let i = 0; i < 24 && S().activity?.kind !== 'sleep'; i++) await simulateHours(0.25);
  await simulateHours(0.5);   // well into his sleep
  check('he is asleep', S().activity?.kind === 'sleep', S().activity?.kind);
  plan = () => ({ agreed: true, kind: 'visit_his', placeHint: null, when: 'now', day: 'today', minutes: 60, confidence: 0.9 });
  const before = textPlans(visitor).length;
  const { res } = await applyAction({ kind: 'text', castId: visitor, from: 'them', words: 'on my way over to yours, open up' });
  check('the text wakes him (owner wake via the phone)', res.eventIds.map(getEvent).some(e => e.type === 'wake.set'));
  await drain();
  const d = textPlans(visitor).find(x => x.status === 'committed' && !S().excluded?.has?.(x.eventId));
  check('a visit committed by text', textPlans(visitor).length > before && d?.kind === 'visit', planLogs.slice(-2));
  const woke = listEvents({ types: ['woke'], from: clock.now() - 3 * 3600, limit: 20 }).filter(e => e.payload?.interrupted).at(-1);
  check('her text woke him first (the wake applies before her text goes live), so the plan was made with him up', woke && getEvent(d?.eventId)?.at >= woke.at, [woke?.at, getEvent(d?.eventId)?.at]);
  for (let i = 0; i < 8 && !(S().activity?.withCast ?? []).includes(visitor); i++) { await simulateHours(0.25); await drain(); }
  check('he is up and with her at home', (S().activity?.withCast ?? []).includes(visitor) && S().activity?.kind !== 'sleep', S().activity);
}

section('refusals: a clash, a frozen story, a pin, a place his world doesn\'t have, asleep, the flatmate');
{
  const s = { ...S(), activity: { ...S().activity, kind: 'free' } };   // awake (the asleep case below sets sleep)
  const t = clock.now();
  const base = { agreed: true, kind: 'outing', placeHint: 'restaurant', when: hhmm(wed.subject.eventAt, tz), day: 'wednesday', minutes: 120, confidence: 0.9 };
  const r1 = resolveTextPlan(s, visitor, base, { at: t, tz, world });
  eq('the same Wednesday evening with someone else → refused clash_plan', [r1.ok, r1.outcome, r1.code], [false, 'refused', 'clash_plan']);
  const frozen = { ...s, story: { ...s.story, controls: { ...s.story.controls, fate: { social: 'frozen' } } } };
  eq('social frozen → refused frozen', resolveTextPlan(frozen, visitor, { ...base, day: 'saturday' }, { at: t, tz, world }).code, 'frozen');
  const pinned = { ...s, story: { ...s.story, controls: { ...s.story.controls, pins: { [visitor]: { eventId: 1, at: t } } } } };
  eq('the member pinned → refused pinned', resolveTextPlan(pinned, visitor, { ...base, day: 'saturday' }, { at: t, tz, world }).code, 'pinned');
  const paused = { ...s, story: { ...s.story, controls: { ...s.story.controls, paused: true } } };
  eq('the story paused → refused paused', resolveTextPlan(paused, visitor, { ...base, day: 'saturday' }, { at: t, tz, world }).code, 'paused');
  eq('no bowling alley in his world → refused no_place', resolveTextPlan(s, visitor, { ...base, placeHint: 'bowling', day: 'saturday' }, { at: t, tz, world }).code, 'no_place');
  eq('a coworker\'s home isn\'t a place in his world → refused no_their_home', resolveTextPlan(s, visitor, { ...base, kind: 'visit_theirs', day: 'saturday' }, { at: t, tz, world }).code, 'no_their_home');
  eq('the flatmate "coming over" → nothing (lives there)', resolveTextPlan(s, flat, { ...base, kind: 'visit_his', day: 'saturday' }, { at: t, tz, world }).code, 'lives_there');
  const asleep = { ...s, activity: { ...s.activity, kind: 'sleep' } };
  eq('asleep, not an owner chat → refused asleep', resolveTextPlan(asleep, visitor, { ...base, day: 'saturday' }, { at: t, tz, world }).code, 'asleep');
  check('asleep in an owner-started chat → a plan (the wake machinery gets him up)', resolveTextPlan(asleep, visitor, { ...base, day: 'saturday', when: '19:30' }, { at: t, tz, world, ownerChat: true }).ok);
  eq('a maybe → nothing not_agreed', resolveTextPlan(s, visitor, { ...base, agreed: false }, { at: t, tz, world }).code, 'not_agreed');
  eq('low confidence → nothing low_confidence', resolveTextPlan(s, visitor, { ...base, confidence: 0.5 }, { at: t, tz, world }).code, 'low_confidence');
  const tue = resolveTextPlan(s, visitor, { ...base, day: 'tuesday', when: '11:00' }, { at: t, tz, world });
  check('a weekday office-hours meet → refused (clash with work)', !tue.ok && /^clash_(work|meeting|commute)$/.test(tue.code), tue);
  check('a free weekend evening → ok', resolveTextPlan(s, visitor, { ...base, day: 'saturday', when: '19:30' }, { at: t, tz, world }).ok);
}

section('a refusal through the live path: nothing appended, logged refused <code>');
{
  const mgr = 'cast:manager';
  const before = textPlans(mgr).length;
  plan = () => ({ agreed: true, kind: 'outing', placeHint: 'bowling', when: '19:30', day: 'saturday', minutes: 120, confidence: 0.9 });
  theirs = () => ({ messages: ['yes! bowling saturday 7:30'], tone: 'excited', topic: 'bowling', end: true });
  his = () => ({ messages: ['bowling saturday?'], tone: 'warm', topic: 'bowling', end: false });
  await applyAction({ kind: 'text', castId: mgr, gist: 'ask them to go bowling on saturday' });
  for (let i = 0; i < 8 && !planLogs.some(l => l.code === 'no_place'); i++) { await simulateHours(0.25); await drain(); }
  check('logged refused no_place', planLogs.some(l => l.outcome === 'refused' && l.code === 'no_place'), planLogs.slice(-3));
  eq('no plan appended', textPlans(mgr).length, before);
}

section('the writers are told: agree only to what his plans allow; "on my way" only after a yes');
{
  check('his charter', /Plans: say yes to meeting up, a time or a place only if "his plans" leave that time free; if it clashes, say so and offer another time\. Say you are on your way or coming over only after they said yes/.test(HIS_CHARTER));
  check('their charter', /Plans: when you suggest or accept a time to meet, pick one his plans leave free/.test(CAST_CHARTER) && /on your way or coming over only after he said yes/.test(CAST_CHARTER));
  check('labels: code-built, no venue names', planLabel(S(), 'outing', S().cast.get(visitor), 'place:restaurant') === 'Dinner with Coworker at the restaurant' && planLabel(S(), 'visit_theirs', S().cast.get(visitor), null) === "Over at Coworker's place");
}

report();
