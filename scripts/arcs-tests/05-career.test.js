// 010 T015 — career (src/life/story/career.js, research R9): the yearly appraisal
// in the seed's month (band from the work log + Jev, code fallback, salary within
// the seed bounds ∩ −5…+20), the job hunt, interviews in work hours (work-conflict
// cost + travel), the big offer (lead ≥ 24 h; accepting is the resignation),
// notice → job change, worldOverlay moving the office (office days unchanged),
// pins/frozen, and consequences caused by the decision's own decision.opened.
//
// unit: hand-built projections through the real projector and the real
//       decisions.openDecision (noJev) on an in-memory log; a two-year roll loop;
//       a scratch-DB section for the R14 item 8 cause rule.
// sim:  two years through the life facade — skipped until T024.
// Invented, persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, exampleWorld, exampleArcSeed, skipSimUnlessWired,
  fakeJevFixed, bootLife, stopLife, simulateDays, DAY, HOUR,
} from './_helpers.js';
import { createInitialState, project } from '../../src/life/projector.js';
import { genesis as pulseGenesis } from '../../src/life/pulse.js';
import { EVENT_TYPES } from '../../src/life/eventLog.js';
import { zonedToUnix, dateKey, localParts, minuteOfDay } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { dayType, planDay, routineOf } from '../../src/life/routine.js';
import { openDecision, evaluate as evaluateDecisions } from '../../src/life/decisions.js';
import { worldOverlay } from '../../src/life/story/reducer.js';
import * as career from '../../src/life/story/career.js';

setRngSeed(777);
const base = await exampleWorld();
// A second office-kind place the routine knows (job changes move to existing places).
const world = {
  ...base,
  places: [...base.places, { id: 'place:office-north', name: 'North office', kind: 'office', lat: 0.052, lon: 0.036 }],
};
const tz = world.timezone;
const T0 = zonedToUnix(2026, 10, 27, 6, 0, tz);

function makeLog() {
  let state = createInitialState(world);
  const events = [];
  const add = (d) => {
    if (!EVENT_TYPES.has(d.type)) throw new Error(`unknown type ${d.type}`);
    const actor = d.actor ?? 'engine';
    const e = {
      id: events.length + 1, at: d.at, type: d.type, actor, causeId: d.causeId ?? null, payload: structuredClone(d.payload ?? {}),
      originKind: actor === 'owner' ? 'owner' : 'self', originJid: actor === 'owner' ? 'owner' : 'self', subjectJid: null, heavy: d.heavy === true, redacted: false,
    };
    events.push(e);
    state = project(state, e, world);
    return e;
  };
  pulseGenesis(add, world, T0);
  const L = {
    get state() { return state; }, events, add,
    owner: (type, at, payload) => add({ type, at, actor: 'owner', payload }),
    getEvent: (id) => events.find(e => e.id === id) ?? null,
    getState: () => state,
  };
  L.open = (getState, spec, ctx) => openDecision(getState, spec, { ...ctx, noJev: true });
  L.deps = (extra = {}) => ({ openDecision: L.open, getState: L.getState, world, ...extra });
  return L;
}

const always = () => { const r = () => 0; r.int = (a) => a; r.float = (a) => a; return r; };
const never = () => { const r = () => 0.999999; r.int = (a, b) => b; r.float = (a, b) => b; return r; };
const runItem = async (L, it) => { const n = L.events.length; await it.run(L.add); return L.events.slice(n); };
const ofType = (L, t) => L.events.filter(e => e.type === t);
const commit = (L, d, optionId, at) => L.add({ type: 'decision.committed', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, optionId, p: 1, sampled: false, by: 'lean' } });

let seed;
try {
  seed = await exampleArcSeed();
  const seedNov = { ...seed, career: { ...seed.career, appraisalMonth: 11 } };

  section('inert without a month or a section');
  eq('example seed: appraisal month null → no_appraisal_month', career.careerStatus(null, seed).inert, 'no_appraisal_month');
  eq('no career section → no_seed_section', career.careerStatus(null, { ...seed, career: null }).inert, 'no_seed_section');
  eq('month set → not inert', career.careerStatus(null, seedNov).inert, null);
  const L0 = makeLog();
  eq('no month → never due', career.appraisalDue(L0.state, zonedToUnix(2026, 11, 2, 9, 0, tz), seed, world).reason, 'no_appraisal_month');
  const inertOut = await career.dailyRoll({ state: L0.state, add: L0.add, at: zonedToUnix(2026, 11, 2, 9, 0, tz), world, seed: { ...seed, career: null } });
  eq('no career section → the daily roll is inert and appends nothing', [inertOut.outcome, L0.events.length > 0 && ofType(L0, 'career.appraisal').length], ['inert', 0]);

  section('appraisal due: workday of the seeded month, once a year');
  {
    const L = makeLog();
    const mon = zonedToUnix(2026, 11, 2, 9, 0, tz);
    const wd = localParts(mon, tz).weekday;
    const sat = zonedToUnix(2026, 11, 7, 9, 0, tz);
    eq('October → not_month', career.appraisalDue(L.state, zonedToUnix(2026, 10, 30, 9, 0, tz), seedNov, world).reason, 'not_month');
    check(`2 Nov is a workday (${dayType(mon, world, {})}, weekday ${wd})`, ['office', 'wfh'].includes(dayType(mon, world, {})));
    eq('… so it is due', career.appraisalDue(L.state, mon, seedNov, world).due, true);
    eq('a weekend day of the month → not_workday', career.appraisalDue(L.state, sat, seedNov, world).reason, 'not_workday');
    L.add({ type: 'career.appraisal', at: mon, actor: 'engine', payload: { year: 2026, band: 'good', pct: 3, salaryFrom: 60000, salaryTo: 61800, score: 0.1, probs: {} } });
    eq('after the appraisal → done for the year', career.appraisalDue(L.state, zonedToUnix(2026, 11, 3, 9, 0, tz), seedNov, world).reason, 'done');
    eq('next November → due again', career.appraisalDue(L.state, zonedToUnix(2027, 11, 1, 9, 0, tz), seedNov, world).due, true);
    eq('the appraisal moved the salary the world sees', worldOverlay(L.state, world).money.salary, 61800);
  }

  section('band score from the work log');
  {
    const at = zonedToUnix(2026, 11, 20, 9, 0, tz);
    const good = makeLog();
    for (let d = 1; d <= 20; d++) good.add({ type: 'work.late', at: T0 + d * DAY, actor: 'engine', payload: { extraMin: 30 } });
    const bad = makeLog();
    for (let d = 1; d <= 8; d++) bad.add({ type: 'sick.started', at: T0 + d * 2 * DAY, actor: 'engine', payload: { days: 2, until: T0 + d * 2 * DAY + DAY } });
    const sg = career.appraisalScore(good.state, at);
    const sb = career.appraisalScore(bad.state, at);
    check('late days count as effort, sick days as strain', sg.lateDays === 20 && sb.sickDays >= 15 && sg.score > sb.score, { sg, sb });
    const tense = makeLog();
    tense.add({ type: 'relationship.changed', at: T0 + 60, actor: 'engine', payload: { castId: 'cast:manager', delta: { tension: 0.2 }, reason: 'arc' } });
    tense.add({ type: 'relationship.changed', at: T0 + 61, actor: 'engine', payload: { castId: 'cast:manager', delta: { tension: 0.2 }, reason: 'arc' } });
    tense.add({ type: 'relationship.changed', at: T0 + 62, actor: 'engine', payload: { castId: 'cast:manager', delta: { tension: 0.2 }, reason: 'arc' } });
    check('manager tension lowers the score', career.appraisalScore(tense.state, at).score < career.appraisalScore(makeLog().state, at).score);
    const fp = career.fallbackProbs(1.5);
    check('fallback softmax favours great for a high score, poor for a low one', fp.great > fp.poor && career.fallbackProbs(-1.5).poor > career.fallbackProbs(-1.5).great);
  }

  section('appraise: Jev probabilities, code fallback, salary bounds');
  {
    const L = makeLog();
    const at = zonedToUnix(2026, 11, 2, 9, 0, tz);
    const jev = fakeJevFixed({ band: { poor: 0, fair: 0, good: 0, great: 1 } });
    const ev = await career.appraise(L.state, at, seedNov, { askJev: jev.fn, world });
    const call = jev.calls?.[0] ?? null;
    check('one Jev call, caller life.arc.appraisal, choice over the four bands', jev.calls.length === 1 && call?.caller === 'life.arc.appraisal'
      && call?.questions?.band?.type === 'choice' && Object.keys(call.questions.band.criteria).sort().join() === 'fair,good,great,poor', call);
    check('Jev state carries only the score inputs', Object.keys(call.state).sort().join() === 'crunches,lateDays,meanStress,score,sickDays,tensionWithManager,yearsInRole', call?.state);
    check('great → pct in the top 30% of the seed max (8)', ev.payload.band === 'great' && ev.payload.pct >= 0.7 * 8 && ev.payload.pct <= 8 && !ev.payload.fallback, ev.payload);
    eq('salaryTo = salaryFrom × (1 + pct)', ev.payload.salaryTo, Math.round(ev.payload.salaryFrom * (1 + ev.payload.pct / 100)));
    const err = await career.appraise(L.state, at, seedNov, { askJev: async () => { throw new Error('down'); }, world });
    check('Jev error → fallback jev_error with softmax probabilities', err.payload.fallback === 'jev_error' && Math.abs(Object.values(err.payload.probs).reduce((a, b) => a + b, 0) - 1) < 1e-3, err.payload);
    const be = await career.appraise(L.state, at, seedNov, { askJev: async () => { const e = new Error('budget'); e.name = 'BudgetError'; throw e; }, world });
    eq('Jev over budget → fallback jev_budget', be.payload.fallback, 'jev_budget');
    eq('junk answer → fallback jev_invalid', (await career.appraise(L.state, at, seedNov, { askJev: async () => ({ answers: { band: { probabilities: { bogus: 1 } } } }), world })).payload.fallback, 'jev_invalid');
    eq('no Jev client → fallback no_jev', (await career.appraise(L.state, at, seedNov, { world })).payload.fallback, 'no_jev');
    eq('sim → fallback sim (no call)', (await career.appraise(L.state, at, seedNov, { askJev: jev.fn, world, sim: true })).payload.fallback, 'sim');
    eq('still one Jev call', jev.calls.length, 1);
    const wide = { career: { ...seedNov.career, salaryChangePct: { min: -10, max: 50 } } };
    const pcts = [];
    for (const band of career.BANDS) for (let i = 0; i < 20; i++) pcts.push(career.bandPct(band, wide, () => i / 19));
    check('salary change always within −5…+20 even with a wider seed', pcts.every(p => p >= -5 && p <= 20) && Math.min(...pcts) === -5 && Math.max(...pcts) === 20, [Math.min(...pcts), Math.max(...pcts)]);
    eq('a poor band never raises the salary', career.bandPct('poor', seedNov, () => 0.99) <= 0, true);
    eq('bandFromProbs argmax without an rng', career.bandFromProbs({ poor: 0.1, fair: 0.6, good: 0.2, great: 0.1 }), 'fair');
  }

  section('two years of daily rolls: exactly one appraisal a year, in the month');
  {
    const L = makeLog();
    const jev = fakeJevFixed({ band: { poor: 0.1, fair: 0.4, good: 0.4, great: 0.1 } });
    for (let day = 1; day <= 730; day++) {
      const at = zonedToUnix(2026, 10, 27, 9, 0, tz) + day * DAY;
      for (const it of career.huntItems(L.state, at, L.deps({ seed: seedNov }))) await runItem(L, it);
      await career.dailyRoll({ state: L.state, add: L.add, at, date: dateKey(at, tz), world, seed: seedNov }, L.deps({ askJev: jev.fn }));
      if ([...L.state.decisions.values()].some(d => d.status === 'open')) await evaluateDecisions(L.getState, { world, at, append: L.add, noJev: true });
    }
    const aps = ofType(L, 'career.appraisal');
    eq('two appraisals in two years', aps.length, 2);
    check('both in November, on workdays, one per year', aps.every(e => localParts(e.at, tz).month === 11 && ['office', 'wfh'].includes(dayType(e.at, world, {})))
      && new Set(aps.map(e => e.payload.year)).size === 2, aps.map(e => dateKey(e.at, tz)));
    check('every salary change within the seed bounds', aps.every(e => e.payload.pct >= -2 && e.payload.pct <= 8));
    const hunts = ofType(L, 'career.hunt');
    console.log(`    (${aps.map(e => e.payload.band).join(', ')}; ${hunts.length} hunt events, ${L.events.filter(e => e.type === 'decision.opened' && e.payload.category === 'career').length} career decisions)`);
  }

  section('two years, poor appraisals, ambition 1: a hunt runs through the decision engine');
  {
    const L = makeLog();
    L.owner('director.slider_set', T0 + 1, { slider: 'careerAmbition', value: 1 });
    const jev = fakeJevFixed({ band: { poor: 1, fair: 0, good: 0, great: 0 } });
    for (let day = 1; day <= 730; day++) {
      const at = zonedToUnix(2026, 10, 27, 9, 0, tz) + day * DAY;
      for (let k = 0; k < 4; k++) {
        const items = career.huntItems(L.state, at, L.deps({ seed: seedNov }));
        if (!items.length) break;
        for (const it of items) await runItem(L, it);
      }
      await career.dailyRoll({ state: L.state, add: L.add, at, date: dateKey(at, tz), world, seed: seedNov }, L.deps({ askJev: jev.fn }));
      if ([...L.state.decisions.values()].some(d => d.status === 'open')) await evaluateDecisions(L.getState, { world, at: at + 12 * HOUR, append: L.add, noJev: true });
    }
    const opened = L.events.filter(e => e.type === 'decision.opened' && e.payload.category === 'career');
    const hunts = ofType(L, 'career.hunt').filter(e => e.payload.phase === 'started');
    check('a poor appraisal started a hunt', hunts.length >= 1 && hunts[0].payload.reason === 'poor_appraisal', hunts.map(e => e.payload));
    check('interviews opened as timed decisions (009 engine: decideBy, ponrAt, costs)', opened.some(e => e.payload.kind === 'career:interview'
      && Number.isInteger(e.payload.decideBy) && Number.isInteger(e.payload.ponrAt) && e.payload.options[0].cost), opened.length);
    const stages = ofType(L, 'arc.stage');
    check('every arc stage move is caused by a decision.opened (self), with commitEventId', stages.filter(e => e.payload.reason === 'decision')
      .every(e => L.getEvent(e.causeId)?.type === 'decision.opened' && Number.isInteger(e.payload.commitEventId)));
    check('career.* consequences are caused by a decision.opened', L.events.filter(e => ['career.resigned', 'career.job_changed'].includes(e.type))
      .every(e => L.getEvent(e.causeId)?.type === 'decision.opened'));
    check('offers are big Ask-me cards with ≥ 24 h lead', opened.filter(e => e.payload.kind === 'career:offer')
      .every(e => e.payload.big && e.payload.mode === 'ask' && e.payload.decideBy - e.payload.opensAt >= 24 * HOUR));
    eq('still one appraisal a year', ofType(L, 'career.appraisal').length, 2);
    console.log(`    (${hunts.length} hunts, ${opened.filter(e => e.payload.kind === 'career:interview').length} interviews, `
      + `${opened.filter(e => e.payload.kind === 'career:offer').length} offers, ${ofType(L, 'career.job_changed').length} job changes)`);
  }

  section('hunt start: triggers, pins, frozen, employers, cooldown');
  {
    const at = zonedToUnix(2026, 12, 1, 9, 0, tz);
    const poor = () => {
      const L = makeLog();
      L.add({ type: 'career.appraisal', at: at - 5 * DAY, actor: 'engine', payload: { year: 2026, band: 'poor', pct: -1, salaryFrom: 60000, salaryTo: 59400, score: -1, probs: {} } });
      return L;
    };
    const L = poor();
    eq('a poor appraisal is a trigger', career.huntTrigger(L.state, at)?.reason, 'poor_appraisal');
    const out = await career.dailyRoll({ state: L.state, add: L.add, at, world, seed }, L.deps({ rngFor: () => always() }));
    eq('hit → hunt started', out.hunt, 'started');
    const arc = ofType(L, 'arc.started').at(-1);
    check('arc.started {career, hunt, searching} + career.hunt {started} caused by it', arc.payload.kind === 'hunt' && arc.payload.category === 'career'
      && ofType(L, 'career.hunt').at(-1).causeId === arc.id && L.state.story.career.huntArcId === arc.id, L.state.story.career);
    check('no place is created by default', !L.events.some(e => e.type === 'place.created' && e.at === at));
    const P = poor();
    P.owner('director.pin_set', at - 60, { pinKey: 'self.job' });
    const refusals = [];
    eq('pin self.job → refused, no hunt', (await career.dailyRoll({ state: P.state, add: P.add, at, world, seed }, P.deps({ rngFor: () => always(), refuse: r => refusals.push(r) }))).hunt, 'refused');
    check('… with a refusal row naming the pin', refusals.some(r => r.pinKey === 'self.job'), refusals);
    const F = poor();
    F.owner('director.fate_set', at - 60, { category: 'career', mode: 'frozen' });
    eq('career frozen → refused', (await career.dailyRoll({ state: F.state, add: F.add, at, world, seed }, F.deps({ rngFor: () => always() }))).hunt, 'refused');
    const E = poor();
    eq('no other employer in the seed → no hunt', (await career.dailyRoll({ state: E.state, add: E.add, at, world, seed: { ...seed, career: { ...seed.career, employers: [] } } }, E.deps({ rngFor: () => always() }))).hunt, 'no_employers');
    eq('no trigger on a fresh world', career.huntTrigger(makeLog().state, T0 + DAY), null);
    eq('two years in role is a trigger', career.huntTrigger(makeLog().state, T0 + 2 * 365 * DAY + DAY)?.reason, 'long_tenure');
    const lowAmb = poor();
    lowAmb.owner('director.slider_set', at - 60, { slider: 'careerAmbition', value: 0 });
    const amb = await career.dailyRoll({ state: lowAmb.state, add: lowAmb.add, at, world, seed }, lowAmb.deps({ rngFor: () => never() }));
    check('careerAmbition scales the hunt p (0 → ×0.5)', amb.huntP === 0.04, amb);
  }

  section('interview: work hours, work conflict + travel, then the offer');
  let L;
  let hunt;
  {
    L = makeLog();
    const at = zonedToUnix(2026, 12, 1, 9, 0, tz);
    L.add({ type: 'career.appraisal', at: at - 5 * DAY, actor: 'engine', payload: { year: 2026, band: 'poor', pct: -1, salaryFrom: 60000, salaryTo: 59400, score: -1, probs: {} } });
    await career.dailyRoll({ state: L.state, add: L.add, at, world, seed }, L.deps({ rngFor: () => always() }));
    hunt = career.huntArc(L.state);
    const at2 = at + DAY;
    // A night's sleep before the roll: since the vitals rebalance (2026-10-31) two
    // weeks awake with no sleep in this synthetic log leave him exhausted (fatigue),
    // and an exhausted man skips an interview — not what this section tests.
    L.add({ type: 'sleep.started', at: at2 - 9 * HOUR, payload: {} });
    L.add({ type: 'woke', at: at2 - HOUR, payload: {} });
    const out = await career.dailyRoll({ state: L.state, add: L.add, at: at2, world, seed }, L.deps({ rngFor: () => always() }));
    eq('searching + hit → an interview decision opens', out.interview, 'opened');
    const op = ofType(L, 'decision.opened').at(-1);
    const r = routineOf(world);
    const mins = minuteOfDay(op.payload.subject.eventAt, tz);
    check('career:interview, category career, arcId, options go|skip (never go/late/stay)', op.payload.kind === 'career:interview' && op.payload.category === 'career'
      && op.payload.arcId === hunt.id && op.payload.options.map(o => o.id).join() === 'go,skip', op.payload);
    check('inside work hours on a workday 2–7 days ahead', mins >= r.workStart && mins + 60 <= r.workEnd
      && ['office', 'wfh'].includes(dayType(op.payload.subject.eventAt, world, {}))
      && op.payload.subject.eventAt - at2 >= 2 * DAY - 12 * HOUR && op.payload.subject.eventAt - at2 <= 8 * DAY, { mins, at: op.payload.subject.eventAt });
    const go = op.payload.options.find(o => o.id === 'go');
    const skip = op.payload.options.find(o => o.id === 'skip');
    check('at the other office: the go option carries travel and the work-conflict stress', op.payload.subject.placeId === 'place:office-north'
      && go.cost.travelMin > 0 && go.cost.stress > skip.cost.stress, { go: go.cost, skip: skip.cost });
    eq('nothing else is pending: no second interview while one is open', (await career.dailyRoll({ state: L.state, add: L.add, at: at2 + DAY, world, seed }, L.deps({ rngFor: () => always() }))).interview, undefined);

    const d = L.state.decisions.get(op.id);
    check('the hunt pulls toward going (bias on go): not committed to skip', d.status === 'open' || d.committed?.optionId === 'go', d.committed);
    if (d.status === 'open') commit(L, d, 'go', at2 + 2 * HOUR);
    const end = op.payload.subject.eventAt + 60 * 60;
    eq('no outcome before the interview ends', career.huntItems(L.state, end - 1, L.deps({ seed })).length, 0);
    const [it] = career.huntItems(L.state, end, L.deps({ seed, rngFor: () => always() }));
    check('an outcome item at the end, keyed by the decision', it && it.at === end && it.id === op.id, it);
    const evs = await runItem(L, it);
    const offer = evs.find(e => e.type === 'decision.opened');
    const stage = evs.find(e => e.type === 'arc.stage');
    check('hit → an offer opens, caused by the interview\'s decision.opened', offer && offer.causeId === op.id && offer.payload.kind === 'career:offer', evs.map(e => e.type));
    check('the offer is big, an Ask-me card, lead ≥ 24 h', offer.payload.big === true && offer.payload.mode === 'ask' && offer.payload.decideBy - offer.payload.opensAt >= 24 * HOUR, offer.payload);
    check('accept|decline; the accept label names the seed employer', offer.payload.options.map(o => o.id).join() === 'accept,decline'
      && seed.career.employers.some(e => offer.payload.options[0].label.includes(e.name)), offer.payload.options);
    check('arc.stage → offer, caused by decision.opened, with commitEventId', stage.payload.to === 'offer' && stage.causeId === op.id
      && Number.isInteger(stage.payload.commitEventId), stage);
    eq('the outcome is not due again', career.huntItems(L.state, end + DAY, L.deps({ seed })).filter(x => x.id === op.id).length, 0);

    // a miss goes back to searching
    const M = makeLog();
    M.add({ type: 'career.appraisal', at: at - 5 * DAY, actor: 'engine', payload: { year: 2026, band: 'poor', pct: -1, salaryFrom: 60000, salaryTo: 59400, score: -1, probs: {} } });
    await career.dailyRoll({ state: M.state, add: M.add, at, world, seed }, M.deps({ rngFor: () => always() }));
    M.add({ type: 'sleep.started', at: at2 - 9 * HOUR, payload: {} });   // rested, as above
    M.add({ type: 'woke', at: at2 - HOUR, payload: {} });
    await career.dailyRoll({ state: M.state, add: M.add, at: at2, world, seed }, M.deps({ rngFor: () => always() }));
    const op2 = ofType(M, 'decision.opened').at(-1);
    if (M.state.decisions.get(op2.id).status === 'open') commit(M, M.state.decisions.get(op2.id), 'go', at2 + HOUR);
    const miss = await runItem(M, career.huntItems(M.state, op2.payload.subject.eventAt + 3600, M.deps({ seed, rngFor: () => never() }))[0]);
    check('a miss → arc.stage searching, no offer', miss.length === 1 && miss[0].payload.to === 'searching', miss);
    eq('… not due again', career.huntItems(M.state, op2.payload.subject.eventAt + 2 * DAY, M.deps({ seed })).length, 0);
  }

  section('offer accepted → notice → job change; worldOf moves the office');
  {
    const offer = [...L.state.decisions.values()].find(d => d.kind === 'career:offer');
    const at = offer.opensAt + 30 * HOUR;
    commit(L, offer, 'accept', at);
    const [it] = career.huntItems(L.state, at, L.deps({ seed }));
    const evs = await runItem(L, it);
    const res = evs.find(e => e.type === 'career.resigned');
    check('career.resigned caused by the offer\'s decision.opened, commitEventId, notice = seed noticeDays', res && res.causeId === offer.id
      && Number.isInteger(res.payload.commitEventId) && res.payload.noticeUntil === at + seed.career.noticeDays * DAY
      && res.payload.toOfficePlaceId === 'place:office-north', res);
    eq('arc → notice', L.state.story.arcs[hunt.id].stage, 'notice');
    eq('no second resignation', career.huntItems(L.state, at + DAY, L.deps({ seed })).length, 0);
    const until = res.payload.noticeUntil;
    eq('no job change before the notice ends', career.huntItems(L.state, until - 1, L.deps({ seed })).length, 0);
    const job = await runItem(L, career.huntItems(L.state, until, L.deps({ seed }))[0]);
    eq('job change, hunt ended, arc done', job.map(e => e.type), ['career.job_changed', 'career.hunt', 'arc.ended']);
    check('all caused by the offer decision', job.every(e => e.causeId === offer.id));
    eq('the projection moved the office', L.state.self.officePlaceId, 'place:office-north');
    const W = worldOverlay(L.state, world);
    eq('worldOverlay: office, employer and title from the job change', [W.self.job.officePlaceId, W.self.job.employerName, W.self.job.title],
      [job[0].payload.officePlaceId, job[0].payload.employerName, job[0].payload.title]);
    eq('office days unchanged (hybrid pattern kept)', routineOf(W).officeDays, routineOf(world).officeDays);
    let officeDay = until + DAY;
    while (dayType(officeDay, W, {}) !== 'office') officeDay += DAY;
    const plan = planDay(L.state, officeDay, W);
    check('planDay on an office day puts the work block at the new office', plan.blocks.some(b => b.kind === 'work' && b.placeId === 'place:office-north'),
      plan.blocks.map(b => `${b.kind}@${b.placeId}`));
    check('… while the base world still says the old one', planDay(L.state, officeDay, world).blocks.some(b => b.kind === 'work' && b.placeId === 'place:office'));
    eq('no hunt any more', career.huntArc(L.state), null);
  }

  section('pins and frozen on consequences');
  {
    const setup = async () => {
      const P = makeLog();
      const at = zonedToUnix(2026, 12, 1, 9, 0, tz);
      P.add({ type: 'career.appraisal', at: at - 5 * DAY, actor: 'engine', payload: { year: 2026, band: 'poor', pct: -1, salaryFrom: 60000, salaryTo: 59400, score: -1, probs: {} } });
      await career.dailyRoll({ state: P.state, add: P.add, at, world, seed }, P.deps({ rngFor: () => always() }));
      P.add({ type: 'sleep.started', at: at + DAY - 9 * HOUR, payload: {} });   // rested (see the interview section)
      P.add({ type: 'woke', at: at + DAY - HOUR, payload: {} });
      await career.dailyRoll({ state: P.state, add: P.add, at: at + DAY, world, seed }, P.deps({ rngFor: () => always() }));
      const iv = ofType(P, 'decision.opened').at(-1);
      if (P.state.decisions.get(iv.id).status === 'open') commit(P, P.state.decisions.get(iv.id), 'go', at + DAY + HOUR);
      await runItem(P, career.huntItems(P.state, iv.payload.subject.eventAt + 3600, P.deps({ seed, rngFor: () => always() }))[0]);
      const offer = [...P.state.decisions.values()].find(d => d.kind === 'career:offer');
      return { P, offer };
    };
    {
      const { P, offer } = await setup();
      P.owner('director.pin_set', offer.opensAt + HOUR, { pinKey: 'self.job' });
      commit(P, offer, 'accept', offer.opensAt + 2 * HOUR);
      const evs = await runItem(P, career.huntItems(P.state, offer.opensAt + 2 * HOUR, P.deps({ seed }))[0]);
      check('pin self.job after the offer → accept refused: terminal decision.expired {pinned}', evs.length === 1 && evs[0].type === 'decision.expired'
        && evs[0].payload.reason === 'pinned' && evs[0].causeId === offer.id, evs);
      eq('… the committed offer is closed', P.state.decisions.get(offer.id).status, 'cancelled');
      check('… no resignation ever', !P.events.some(e => e.type === 'career.resigned'));
    }
    {
      const { P, offer } = await setup();
      P.owner('director.fate_set', offer.opensAt + HOUR, { category: 'career', mode: 'frozen' });
      commit(P, offer, 'accept', offer.opensAt + 2 * HOUR);
      const evs = await runItem(P, career.huntItems(P.state, offer.opensAt + 2 * HOUR, P.deps({ seed }))[0]);
      eq('career frozen → decision.expired {frozen}', evs.map(e => `${e.type}:${e.payload.reason}`), ['decision.expired:frozen']);
    }
    {
      const { P, offer } = await setup();
      commit(P, offer, 'decline', offer.opensAt + 2 * HOUR);
      const evs = await runItem(P, career.huntItems(P.state, offer.opensAt + 2 * HOUR, P.deps({ seed }))[0]);
      check('decline → back to searching', evs.length === 1 && evs[0].type === 'arc.stage' && evs[0].payload.to === 'searching', evs);
    }
    {
      const { P, offer } = await setup();
      commit(P, offer, 'accept', offer.opensAt + 2 * HOUR);
      const res = (await runItem(P, career.huntItems(P.state, offer.opensAt + 2 * HOUR, P.deps({ seed }))[0])).find(e => e.type === 'career.resigned');
      P.owner('director.pin_set', res.at + DAY, { pinKey: 'self.job' });
      const refusals = [];
      eq('pin self.job during the notice → the job change is held (not offered)', career.huntItems(P.state, res.payload.noticeUntil, P.deps({ seed, refuse: r => refusals.push(r) })).length, 0);
      check('… and logged as a refusal with the pin key', refusals.some(r => r.reason === 'pinned' && r.pinKey === 'self.job'), refusals);
      P.owner('director.pin_cleared', res.payload.noticeUntil + DAY, { pinKey: 'self.job' });
      const job = await runItem(P, career.huntItems(P.state, res.payload.noticeUntil + DAY, P.deps({ seed }))[0]);
      eq('pin cleared → the job change happens', job[0].type, 'career.job_changed');
    }
  }

  section('offer upkeep and a long hunt');
  {
    const P = makeLog();
    const at = zonedToUnix(2026, 12, 1, 9, 0, tz);
    P.add({ type: 'career.appraisal', at: at - 5 * DAY, actor: 'engine', payload: { year: 2026, band: 'poor', pct: -1, salaryFrom: 60000, salaryTo: 59400, score: -1, probs: {} } });
    await career.dailyRoll({ state: P.state, add: P.add, at, world, seed }, P.deps({ rngFor: () => always() }));
    const arc = career.huntArc(P.state);
    P.add({ type: 'arc.stage', at: at + HOUR, actor: 'engine', payload: { arcId: arc.id, from: 'searching', to: 'offer', reason: 'decision' } });
    const out = await career.dailyRoll({ state: P.state, add: P.add, at: at + 2 * DAY, world, seed }, P.deps({ rngFor: () => never() }));
    check('an offer stage with no live offer → back to searching', out.hunt === 'offer_lapsed' && P.state.story.arcs[arc.id].stage === 'searching', out);
    const out2 = await career.dailyRoll({ state: P.state, add: P.add, at: at + 181 * DAY, world, seed }, P.deps({ rngFor: () => never() }));
    check('searching for 180 days → the hunt ends (fizzled)', out2.hunt === 'ended' && P.state.story.arcs[arc.id].outcome === 'fizzled' && !career.huntArc(P.state), out2);
    eq('… and a new hunt waits out the cooldown', (await career.dailyRoll({ state: P.state, add: P.add, at: at + 200 * DAY, world, seed }, P.deps({ rngFor: () => always() }))).hunt, 'no_trigger');
  }

  section('consequences never inherit a chat-tainted commit (scratch DB, R14 item 8)');
  {
    await setupScratchDb();
    const log = await import('../../src/life/eventLog.js');
    const at = T0 + DAY;
    log.appendEvent({ type: 'genesis', at: T0, actor: 'engine', payload: { timezone: tz } });
    const opened = log.appendEvent({ type: 'decision.opened', at, actor: 'engine', payload: { kind: 'career:offer', category: 'career', options: [] } });
    const trig = log.appendEvent({ type: 'chat.trigger', at, actor: 'chat', originKind: 'group', originJid: '120363000000000401@g.us', payload: { decisionId: opened.id } });
    const lean = log.appendEvent({ type: 'decision.lean', at, actor: 'engine', causeId: trig.id, payload: { decisionId: opened.id, optionId: 'accept' } });
    const commitEv = log.appendEvent({ type: 'decision.committed', at, actor: 'engine', causeId: lean.id, payload: { decisionId: opened.id, optionId: 'accept' } });
    eq('the commit carries the chat origin', commitEv.originKind, 'group');
    let threw = false;
    try { log.appendEvent({ type: 'career.resigned', at, actor: 'engine', causeId: commitEv.id, payload: { noticeUntil: at + DAY } }); } catch { threw = true; }
    check('career.* caused by the tainted commit is refused', threw);
    const ok = log.appendEvent({ type: 'career.resigned', at, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, noticeUntil: at + DAY, commitEventId: commitEv.id } });
    check('caused by decision.opened (self) with commitEventId → accepted, origin self', ok.originKind === 'self');
  }

  section('sim: two years through the life facade');
  if (!(await skipSimUnlessWired())) {
    await setupScratchDb();
    const { life } = await bootLife({ arcSeed: seedNov, jev: fakeJevFixed({ band: { poor: 0.2, fair: 0.3, good: 0.3, great: 0.2 } }) });
    const { listEvents } = await import('../../src/life/eventLog.js');
    await simulateDays(400, { stepMinutes: 60 });
    const aps = listEvents({ types: ['career.appraisal'], limit: 10 });
    check('one appraisal per November through the facade', aps.length >= 1 && aps.every(e => localParts(e.at, tz).month === 11)
      && new Set(aps.map(e => e.payload.year)).size === aps.length, aps.map(e => dateKey(e.at, tz)));
    await stopLife();
  }

  section('sim: the appraisal asks Jev in production, within ARCS_JEV_MAX_PER_DAY');
  if (!(await skipSimUnlessWired())) {
    const { config } = await import('../../src/utils/config.js');
    const story = await import('../../src/life/story/index.js');
    const { listEvents } = await import('../../src/life/eventLog.js');
    const { fakeClock } = await import('./_helpers.js');
    const nov2 = () => fakeClock(zonedToUnix(2026, 11, 2, 6, 0, tz));   // Mon 2 Nov: the first workday of the month
    const appraisals = () => listEvents({ types: ['career.appraisal'], limit: 5 });
    const capBefore = config.arcs.jevMaxPerDay;

    // a) the facade's own client: a stub through the test seam, counted.
    await setupScratchDb();
    const jev = fakeJevFixed({ band: { poor: 0, fair: 0, good: 0, great: 1 } });
    await bootLife({ arcSeed: seedNov, clock: nov2(), jev });
    await simulateDays(1, { stepMinutes: 30 });
    let ap = appraisals();
    const calls = () => jev.calls.filter(c => c.caller === 'life.arc.appraisal');
    check('one appraisal, answered by Jev (caller life.arc.appraisal, no fallback)', ap.length === 1 && calls().length === 1 && !ap[0].payload.fallback,
      [ap.map(e => e.payload.fallback ?? null), calls().length]);
    await stopLife();

    // b) the daily arc Jev cap is spent → no call, the code fallback.
    await setupScratchDb();
    const jev2 = fakeJevFixed({ band: { poor: 0, fair: 0, good: 0, great: 1 } });
    config.arcs.jevMaxPerDay = 0;
    try {
      await bootLife({ arcSeed: seedNov, clock: nov2(), jev: jev2 });
      await simulateDays(1, { stepMinutes: 30 });
    } finally { config.arcs.jevMaxPerDay = capBefore; }
    ap = appraisals();
    check('cap 0 → no Jev call, fallback budget', ap.length === 1 && jev2.calls.filter(c => c.caller === 'life.arc.appraisal').length === 0
      && ap[0].payload.fallback === 'budget', [ap.map(e => e.payload.fallback ?? null), jev2.calls.length]);
    await stopLife();

    // c) no test double: the real brain/jev.js client (keyless or network-blocked here → it throws → jev_error, never no_jev).
    await setupScratchDb();
    await bootLife({ arcSeed: seedNov, clock: nov2() });
    story.__setDepsForTest({ askJev: undefined });
    await simulateDays(1, { stepMinutes: 30 });
    ap = appraisals();
    check('production client wired: the appraisal tried the real Jev (jev_error offline, not no_jev)', ap.length === 1 && ap[0].payload.fallback === 'jev_error',
      ap.map(e => e.payload.fallback ?? null));
    await stopLife();
  }
} finally {
  // nothing global to restore
}

report();
