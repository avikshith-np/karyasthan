// 014 sched — the Director prompt maps wishes to schedule edits (plan §A6a,
// review R34): the charter lists the schedule kinds and no longer puts "jobs"
// in the can't-do list (with 015 merged, jobs / money / home are Director powers); the catalogue's `schedule` (days 0–7: type, work, wake,
// sleep, overrides) and `overrides` are code-built and trimmed first; the
// validator accepts the shapes (anchored to the prompt's date), a `venueQuery`
// range → a `needs_venue` draft with the query (never planned, never batchable);
// schedule drafts are never in APPLY ALL (target_resolved), schedule.clear is;
// the four owner examples (invented names, stubbed model) give one draft each,
// which previews and applies like a hand-built one. No network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole,
} from './_helpers.js';
import { getEvent } from '../../src/life/eventLog.js';
import { resolveTimezone, dateKey } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as promptMod from '../../src/life/story/prompt.js';
import * as story from '../../src/life/story/index.js';
import { validatePromptOutput } from '../../src/life/story/schema.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
await simulateHours(7);              // Tue 27 Oct ~13:00, at the office

const { PROMPT_CHARTER, batchableOf, buildCatalogue, VOCAB } = promptMod;

section('charter (A6a)');
{
  check('lists schedule and schedule.clear', /"kind":"schedule","day"/.test(PROMPT_CHARTER) && /"kind":"schedule.clear"/.test(PROMPT_CHARTER));
  const rules = PROMPT_CHARTER.slice(PROMPT_CHARTER.indexOf('Rules:'));
  // Integrated with 015 P1: jobs, money and moving home are Director powers now, so the
  // merged can't-do line lists neither; schedule edits keep their "one action" rule.
  check('can\'t-do: no "jobs" / employer / money in the merged line; the rest-of-day rule stays', !/money, jobs,/.test(rules)
    && !/changing his employer or job/.test(rules) && /hard life events/.test(rules)
    && /"the rest of the day off and go to X" is ONE schedule action/.test(rules));
  check('"never invent … a real company" stays', /never invent a real person, a real company/.test(PROMPT_CHARTER));
  check('"rest of the day off and go to X" is one schedule action', /ONE schedule action/.test(PROMPT_CHARTER));
}

section('catalogue: schedule + overrides');
let check0;
{
  const { model, check: c } = buildCatalogue(S(), world, clock.now(), tz);
  check0 = c;
  eq('8 days', model.schedule.map(d => d.day), [0, 1, 2, 3, 4, 5, 6, 7]);
  const d0 = model.schedule[0];
  eq('day 0: office, wake and sleep times as HH:MM', [d0.dayType, d0.work, /^\d\d:\d\d$/.test(d0.wakes), /^\d\d:\d\d$/.test(d0.sleeps)], ['office', 'office', true, true]);
  check('a weekend day reads work none', model.schedule.some(d => d.dayType === 'weekend' && d.work === 'none'));
  eq('no overrides yet', model.overrides, []);
  check('the check sets carry overrideIds', c.overrideIds instanceof Set);
}

section('validator: shapes, dates, venueQuery');
{
  const out = (actions) => validatePromptOutput(JSON.stringify({ actions: actions.map(a => ({ action: a, why: 'x' })) }), check0, VOCAB);
  const ok = out([{ kind: 'schedule', day: 1, background: { activity: 'work_home', wholeDay: true } }]);
  eq('WFH tomorrow → the draft carries the date', [ok.drafts[0]?.action.date, ok.drafts[0]?.action.background], [dateKey(clock.now() + 86400, tz), { activity: 'work_home', wholeDay: true }]);
  const v = out([{ kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' }, ranges: [{ activity: 'out', venueQuery: { name: 'Lantern Cafe', area: 'Old Quarter' }, from: '16:00', to: '18:00' }] }]);
  const d = v.drafts[0];
  eq('venueQuery → needs_venue with the query, no place on the range', [d?.status, d?.venues, 'placeId' in (d?.action.ranges[0] ?? {}), 'venueQuery' in (d?.action.ranges[0] ?? {})],
    ['needs_venue', [{ range: 0, query: { name: 'Lantern Cafe', area: 'Old Quarter' } }], false, false]);
  eq('an unknown place → unknown_place', out([{ kind: 'schedule', day: 0, ranges: [{ activity: 'out', placeId: 'place:nope', from: '16:00', to: '18:00' }] }]).dropped[0]?.reason, 'unknown_place');
  eq('day 9 → bad_time', out([{ kind: 'schedule', day: 9, background: { activity: 'off', wholeDay: true } }]).dropped[0]?.reason, 'bad_time');
  eq('a bad time → bad_time', out([{ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '25:00', to: '26:00' }] }]).dropped[0]?.reason, 'bad_time');
  eq('"now" only on day 0', out([{ kind: 'schedule', day: 2, ranges: [{ activity: 'home', from: 'now', to: '20:00' }] }]).dropped[0]?.reason, 'bad_time');
  eq('a URL in a venue name → identifier_in_text', out([{ kind: 'schedule', day: 0, ranges: [{ activity: 'out', venueQuery: { name: 'see https://x.example' }, from: '16:00', to: '18:00' }] }]).dropped[0]?.reason, 'identifier_in_text');
  eq('four ranges → bad_field', out([{ kind: 'schedule', day: 0, ranges: Array(4).fill({ activity: 'home', from: '16:00', to: '17:00' }) }]).dropped[0]?.reason, 'bad_field');
  eq('schedule.clear of an unknown id → unknown_ref', out([{ kind: 'schedule.clear', overrideId: 12345 }]).dropped[0]?.reason, 'unknown_ref');
  const keys = Object.keys(out([{ kind: 'schedule', day: 1, background: { activity: 'off', wholeDay: true }, evil: 1 }]).drafts[0].action);
  check('unknown keys dropped', !keys.includes('evil'), keys);
}

section('batchable (R34)');
{
  eq('schedule → review individually (target_resolved)', batchableOf({ kind: 'schedule', date: '2026-10-28', background: { activity: 'off', wholeDay: true } }), { batchable: false, reviewReason: 'target_resolved' });
  eq('schedule.clear → batchable', batchableOf({ kind: 'schedule.clear', overrideId: 5 }), { batchable: true, reviewReason: null });
}

section('the owner\'s four examples → one draft each, previewed and applied like hand-built ones');
{
  const today = dateKey(clock.now(), tz);
  const examples = [
    ['take the rest of the day off and go to the Lantern Cafe in the Old Quarter', { kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' }, ranges: [{ activity: 'out', venueQuery: { name: 'Lantern Cafe', area: 'Old Quarter' }, from: '16:00', to: '18:00' }] }],
    ['work from home tomorrow', { kind: 'schedule', day: 1, background: { activity: 'work_home', wholeDay: true } }],
    ['sleep in on Saturday', { kind: 'schedule', day: 4, ranges: [{ activity: 'sleep', from: '00:00', to: '10:30' }] }],
    ['stay in tonight', { kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '18:00', to: 'endOfDay' }] }],
  ];
  for (const [wish, action] of examples) {
    const fcr = fakeCallRole({ 'director.prompt': () => JSON.stringify({ actions: [{ action, why: 'as asked' }], cantDo: [] }) });
    story.__setDepsForTest({ callRole: fcr.fn, getUsageByCaller: () => [], knownNames: () => ['Quinlan Marsh'], mindBudgetOk: async () => ({ ok: true }) });
    const r = await story.director.prompt(wish);
    eq(`"${wish}": one draft, status ok`, [r.status, r.drafts.length], ['ok', 1]);
    const draft = r.drafts[0];
    check(`…a schedule draft, never batchable`, draft?.action.kind === 'schedule' && draft.batchable === false && draft.reviewReason === 'target_resolved', draft);
    check('…the route shape check passes', actionProblem(draft.action) === null, actionProblem(draft.action));
    if (draft.status === 'needs_venue') {
      eq('…the venue wish waits for a pick (no geo here): no events planned yet', [draft.events, draft.venues[0].query.name], [0, 'Lantern Cafe']);
      continue;
    }
    check('…planned (events > 0, no refusals)', draft.events > 0 && draft.refusals.length === 0, draft);
  }
  // One of them, end to end: WFH tomorrow.
  const fcr = fakeCallRole({ 'director.prompt': () => JSON.stringify({ actions: [{ action: examples[1][1], why: 'x' }] }) });
  story.__setDepsForTest({ callRole: fcr.fn });
  const r = await story.director.prompt('work from home tomorrow');
  const pv = await director.preview(r.drafts[0].action);
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  const ov = res.eventIds.map(getEvent).find(e => e.type === 'schedule.override_set');
  eq('applied: tomorrow, whole-day work_home', [ov?.payload.date, ov?.payload.background?.activity, ov?.payload.background?.wholeDay], [dateKey(clock.now() + 86400, tz), 'work_home', true]);
  const { model } = buildCatalogue(S(), world, clock.now(), tz);
  check('the catalogue now lists it under overrides and day 1 reads wfh', model.overrides.some(o => o.id === ov.id && o.day === 1) && model.schedule[1].dayType === 'wfh', model.schedule[1]);
  void today;
  story.__setDepsForTest({ callRole: undefined, getUsageByCaller: undefined, knownNames: undefined, mindBudgetOk: undefined });
}

report();
