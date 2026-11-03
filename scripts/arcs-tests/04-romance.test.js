// 010 T014 — the romance state machine (src/life/story/romance.js), research R8.
//
//   unit  the R8 table, partner eligibility (cast:* only, never family), the
//         onset roll's gates and slider, the step decision (thresholds AND
//         dwell, one stage at a time, step|wait, big from dating→committed on,
//         lead time), the breakup decision, fizzle, the daily metrics part,
//         controls (pins, frozen, guided) and the consequence (caused by the
//         decision's own decision.opened, commitEventId in the payload; null
//         for wait or once applied);
//   2y    the real 009 pulse + decision engine on a scratch DB for two
//         simulated years, with the cast daily item and a stand-in for the
//         facade's consequence items: no stage is skipped, every dwell holds,
//         every step is caused by its decision.opened, the partner is a
//         fictional non-family member, one romance at a time;
//   sim   the same through the life facade once T024 wires the story.
// Offline: fake clock, fixed Jev probabilities, invented names only.
import {
  setupScratchDb, fakeClock, fakeJevFixed, section, check, eq, near, report, exampleWorld, exampleArcSeed,
  skipSimUnlessWired, bootLife, simulateDays, stopLife, blockNetwork, DAY,
} from './_helpers.js';
import { setClock, zonedToUnix, dateKey } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, getEvent } from '../../src/life/eventLog.js';
import { createInitialState, project, applyAppended } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters } from '../../src/life/decisions.js';
import { createPulse, genesis } from '../../src/life/pulse.js';
import { check as controlsCheck } from '../../src/life/story/controls.js';
import { dailyItems } from '../../src/life/story/cast.js';
import {
  STAGES, THRESHOLDS, DWELL_DAYS, BIG_STEPS, ONSET_P, nextStage, nextStep, onsetRoll, partnerScore, pickPartner,
  romanceEligible, dailyDelta, dailyRomance, breakupSpec, consequence, pendingDecisions, FIZZLE_AFTER_DAYS, FIZZLE_GRACE_DAYS,
} from '../../src/life/story/romance.js';

const H = 3600;
blockNetwork();
setRngSeed(11);

await setupScratchDb();
const WORLD = await exampleWorld();
const SEED = await exampleArcSeed();
const TZ = WORLD.timezone;
const T0 = zonedToUnix(2026, 10, 26, 5, 0, TZ);
const A = 'cast:coworker-a';
const B = 'cast:coworker-b';
const FLAT = 'cast:flatmate';
const PARENT = 'cast:parent';
const BOSS = 'cast:manager';

let nextId = 1;
function ev(type, at, payload = {}, extra = {}) {
  return { id: nextId++, at, type, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false, ...extra };
}
const apply = (s, e) => project(s, e, WORLD);
function baseState() {
  nextId = 1;
  let s = createInitialState(WORLD);
  s = apply(s, ev('genesis', T0, { source: 'example', timezone: TZ, self: WORLD.self }));
  for (const p of WORLD.places) s = apply(s, ev('place.created', T0, p));
  for (const c of WORLD.cast) s = apply(s, ev('cast.created', T0, c));
  return s;
}
const rel = (s, id, delta, at = T0) => apply(s, ev('relationship.changed', at, { castId: id, delta, reason: 'owner' }, { actor: 'owner', originKind: 'owner', originJid: 'owner' }));
function boost(s, id, m, at = T0) {
  // relationship.changed clamps each delta to ±0.2: step up in pieces.
  for (let i = 0; i < 6; i++) s = rel(s, id, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === 'togetherMin' ? v / 6 : v / 6])), at);
  return s;
}
const started = (s, id, at, stage = 'interested') => apply(s, ev('arc.started', at, { category: 'romance', kind: 'romance', castIds: [id], stage }));
const NO = () => () => 0.99;
const YES = () => () => 0;

try {
  section('the R8 table');
  eq('stages in order', [...STAGES], ['single', 'interested', 'talking', 'dating', 'committed', 'engaged', 'married']);
  eq('dwell days', { ...DWELL_DAYS }, { interested: 7, talking: 14, dating: 60, committed: 365, engaged: 90 });
  eq('thresholds: talking', { ...THRESHOLDS.talking }, { intimacy: 0.25, passion: 0.4, togetherMin: 60 });
  eq('thresholds: committed', { ...THRESHOLDS.committed }, { intimacy: 0.6, passion: 0.5, commitment: 0.5, togetherMin: 1800 });
  eq('thresholds: engaged', { ...THRESHOLDS.engaged }, { intimacy: 0.75, passion: 0.45, commitment: 0.75, togetherMin: 9000 });
  eq('thresholds: married', { ...THRESHOLDS.married }, { intimacy: 0.8, passion: 0.4, commitment: 0.85 });
  eq('big steps', [...BIG_STEPS].sort(), ['committed', 'engaged', 'married']);
  eq('nextStage never skips', STAGES.map(nextStage), ['interested', 'talking', 'dating', 'committed', 'engaged', 'married', null]);

  section('partners: fictional, non-family');
  {
    let s = baseState();
    check('a coworker is eligible', romanceEligible(s, A) && partnerScore(s, A) !== null);
    eq('family is never a partner', partnerScore(s, PARENT), null);
    eq('the manager is not either', partnerScore(s, BOSS), null);
    eq('an unknown or non-cast id → null', [partnerScore(s, 'cast:nobody'), partnerScore(s, '7001@lid'), partnerScore(s, 'place:home')], [null, null, null]);
    eq('no one with passion ≥ 0.3 → no partner', pickPartner(s, SEED), null);
    s = boost(s, B, { passion: 0.35 });
    eq('the only attracted eligible member is picked', pickPartner(s, SEED), B);
    s = boost(s, PARENT, { passion: 0.9 });
    eq('… family never, however high', pickPartner(s, SEED), B);
    s = boost(s, A, { passion: 0.6, intimacy: 0.3 });
    check('a higher score wins', partnerScore(s, A, SEED) > partnerScore(s, B, SEED) && pickPartner(s, SEED) === A);
    check('meetVia adds a little for the named relation', partnerScore(s, FLAT, { romance: { meetVia: ['flatmate'] } }) > partnerScore(s, FLAT, { romance: { meetVia: [] } }));
  }

  section('onset roll');
  {
    let s = boostReady(baseState());
    s.at = T0 + DAY;
    eq('no romance seed → inert', onsetRoll(s, YES(), { seed: { ...SEED, romance: null } }).outcome, 'inert');
    eq('a roll above p → no', onsetRoll(s, NO(), { seed: SEED }).outcome, 'no');
    const hit = onsetRoll(s, YES(), { seed: SEED });
    eq('a hit names the partner', [hit.outcome, hit.partnerId], ['hit', A]);
    near('p = 0.004 at the default slider', hit.p, ONSET_P, 1e-12);
    const hi = structuredClone(s); hi.story.controls.sliders.romanceAppetite = 1;
    near('romanceAppetite 1 → ×1.5', onsetRoll(hi, YES(), { seed: SEED }).p, 0.006, 1e-12);
    const lo = structuredClone(s); lo.story.controls.sliders.romanceAppetite = 0;
    near('romanceAppetite 0 → ×0.5', onsetRoll(lo, YES(), { seed: SEED }).p, 0.002, 1e-12);
    const cool = structuredClone(s); cool.story.romance.cooldownUntil = T0 + 30 * DAY;
    eq('during the cool-down → cooldown', onsetRoll(cool, YES(), { seed: SEED, at: T0 + 2 * DAY }).outcome, 'cooldown');
    const act = started(s, A, T0 + DAY);
    eq('an active romance → active (one at a time)', onsetRoll(act, YES(), { seed: SEED }).outcome, 'active');
    const none = baseState();
    eq('nobody attracted → no_partner', onsetRoll(none, YES(), { seed: SEED }).outcome, 'no_partner');
    // via the daily plan: controls
    const plan = dailyRomance(s, { at: T0 + DAY, date: '2026-10-27', seed: SEED, rngFor: YES });
    eq('dailyRomance: onset → arc.started interested with the partner', plan.events.map(e => [e.type, e.payload.stage, e.payload.castIds]), [['arc.started', 'interested', [A]]]);
    const fz = structuredClone(s); fz.story.controls.fate.romance = 'frozen';
    const pf = dailyRomance(fz, { at: T0 + DAY, date: '2026-10-27', seed: SEED, rngFor: YES });
    eq('romance frozen → no onset', [pf.outcome, pf.events.length], ['frozen', 0]);
    const pin = structuredClone(s); pin.story.controls.pins['self.relationship'] = { eventId: 1, at: T0 };
    const pp = dailyRomance(pin, { at: T0 + DAY, date: '2026-10-27', seed: SEED, rngFor: YES });
    eq('pin self.relationship → no onset, refusal logged', [pp.outcome, pp.events.length, pp.refusals[0]?.pinKey], ['pinned', 0, 'self.relationship']);
    const pinC = structuredClone(s); pinC.story.controls.pins[A] = { eventId: 1, at: T0 };
    eq('pin on the partner → refused', dailyRomance(pinC, { at: T0 + DAY, date: '2026-10-27', seed: SEED, rngFor: YES }).outcome, 'pinned');
  }

  section('steps: thresholds AND dwell, one stage at a time');
  {
    let s = boostReady(baseState());
    s = started(s, A, T0);
    const arcId = s.story.romance.arcId;
    // talking: intimacy .25, passion .4, together 60, dwell 7 d
    eq('before the dwell → none', nextStep(s, T0 + 6 * DAY), null);
    const st = nextStep(s, T0 + 7 * DAY);
    eq('dwell met + thresholds → romance:step to talking', [st?.kind, st?.to, st?.arcId, st?.category], ['romance:step', 'talking', arcId, 'romance']);
    eq('… options step|wait (never go/late/stay)', st.options.map(o => o.id), ['step', 'wait']);
    eq('… not big, no placeId', [st.big, st.subject.placeId, st.subject.castIds], [false, null, [A]]);
    check('… step carries a code bias', typeof st.options[0].bias === 'number' && st.options[1].bias === undefined);
    const thin = structuredClone(s);
    thin.story.relationships[A].togetherMin = 30;
    eq('one threshold short (together) → none', nextStep(thin, T0 + 8 * DAY), null);
    // a pending decision blocks another
    const pend = structuredClone(s);
    pend.decisions.set(500, { id: 500, kind: 'romance:step', arcId, status: 'open', opensAt: T0 + 7 * DAY, options: [] });
    eq('an open step decision blocks a second', nextStep(pend, T0 + 8 * DAY), null);
    pend.decisions.set(500, { id: 500, kind: 'romance:step', arcId, status: 'committed', opensAt: T0 + 7 * DAY, committed: { optionId: 'step', at: T0 + 7 * DAY } });
    eq('… so does a committed step not yet applied', nextStep(pend, T0 + 8 * DAY), null);
    pend.decisions.set(500, { id: 500, kind: 'romance:step', arcId, status: 'committed', opensAt: T0 + 7 * DAY, committed: { optionId: 'wait', at: T0 + 7 * DAY } });
    check('… a committed wait does not', nextStep(pend, T0 + 8 * DAY)?.to === 'talking');
    // big steps
    let b = structuredClone(s);
    b = apply(b, ev('arc.stage', T0 + 10 * DAY, { arcId, from: 'interested', to: 'talking', reason: 'decision' }));
    b = apply(b, ev('arc.stage', T0 + 30 * DAY, { arcId, from: 'talking', to: 'dating', reason: 'decision' }));
    b = boost(b, A, { intimacy: 0.6, passion: 0.3, commitment: 0.6, togetherMin: 2400 }, T0 + 30 * DAY);
    eq('dating: dwell 60 d', nextStep(b, T0 + 89 * DAY), null);
    const big = nextStep(b, T0 + 90 * DAY);
    eq('dating → committed is big and asks the owner', [big?.to, big?.big, big?.mode], ['committed', true, 'ask']);
    check('… decideBy ≥ 24 h ahead', big.decideBy - (T0 + 90 * DAY) >= 24 * H);
    const mar = structuredClone(b);
    mar.story.arcs[arcId].stage = 'married';
    mar.story.romance.stage = 'married';
    eq('married → no further step', nextStep(mar, T0 + 900 * DAY), null);
    // controls on the step decision
    const g = structuredClone(s); g.story.controls.fate.romance = 'guided';
    const gp = dailyRomance(g, { at: T0 + 7 * DAY, date: '2026-11-02', seed: SEED, rngFor: YES });
    eq('guided romance → the step opens as an Ask-me card', [gp.decisions.length, gp.decisions[0]?.spec.mode], [1, 'ask']);
    check('… with no internal fields leaking into the spec', gp.decisions[0] && !('to' in gp.decisions[0].spec));
    const pa = structuredClone(s); pa.story.controls.pins[`arc:${arcId}.stage`] = { eventId: 1, at: T0 };
    const pp = dailyRomance(pa, { at: T0 + 7 * DAY, date: '2026-11-02', seed: SEED, rngFor: YES });
    eq('pin arc:<id>.stage → no step decision, refusal', [pp.decisions.length, pp.outcome, pp.refusals[0]?.pinKey], [0, 'pinned', `arc:${arcId}.stage`]);
    const nr = dailyRomance(s, { at: T0 + 9 * DAY, date: '2026-11-04', seed: SEED, rngFor: NO });
    eq('after the first chance, a re-open waits for the retry roll', nr.decisions.length, 0);
  }

  section('consequence: caused by decision.opened, one stage');
  {
    let s = boostReady(baseState());
    s = started(s, A, T0);
    const arcId = s.story.romance.arcId;
    const d = { id: 900, kind: 'romance:step', arcId, opensAt: T0 + 8 * DAY, status: 'committed', committed: { optionId: 'step', at: T0 + 9 * DAY, eventId: 905 } };
    const c = consequence(d, d.committed, s);
    eq('step → arc.stage interested→talking', c.events.map(e => [e.type, e.payload.from, e.payload.to]).slice(0, 1), [['arc.stage', 'interested', 'talking']]);
    check('… every event caused by the decision.opened, commitEventId set', c.events.every(e => e.causeId === 900 && e.payload.commitEventId === 905 && e.actor === 'engine'));
    eq('… plus a commitment bump for the partner', c.events[1].payload, { castId: A, delta: { commitment: 0.15, passion: 0.05 }, reason: 'decision', commitEventId: 905 });
    eq('… due at the commit, category romance / change', [c.at, c.category, c.action], [T0 + 9 * DAY, 'romance', 'change']);
    check('… pin keys cover the stage, the relationship and the partner', ['self.relationship', `arc:${arcId}.stage`, A].every(k => c.pinKeys.includes(k)));
    eq('wait → null (nothing to append)', consequence(d, { ...d.committed, optionId: 'wait' }, s), null);
    const moved = apply(s, ev('arc.stage', T0 + 9 * DAY, { arcId, from: 'interested', to: 'talking', reason: 'decision' }));
    eq('once applied → null (never twice, never a skip)', consequence(d, d.committed, moved), null);
    eq('no state → null', consequence(d, d.committed, null), null);
    const pinned = structuredClone(s); pinned.story.controls.pins['self.relationship'] = { eventId: 1, at: T0 };
    eq('the facade\'s controls check refuses it under a pin', controlsCheck({ source: 'engine', category: c.category, action: c.action, pinKeys: c.pinKeys }, pinned).reason, 'pinned');
    const fz = structuredClone(s); fz.story.controls.fate.romance = 'frozen';
    eq('… and under frozen', controlsCheck({ source: 'engine', category: c.category, action: c.action, pinKeys: c.pinKeys }, fz).reason, 'frozen');
    const pz = structuredClone(s); pz.story.controls.paused = true;
    eq('… but a pause lets an open decision\'s consequence through', controlsCheck({ source: 'engine', category: c.category, action: c.action, pinKeys: c.pinKeys }, pz).ok, true);
  }

  section('breakup and fizzle');
  {
    let s = boostReady(baseState());
    s = started(s, A, T0, 'dating');
    const arcId = s.story.romance.arcId;
    eq('low tension → no breakup decision', breakupSpec(s, T0 + 20 * DAY, YES()), null);
    s = boost(s, A, { tension: 0.8 });
    const bs = breakupSpec(s, T0 + 20 * DAY, YES());
    eq('tension ≥ 0.7 (proxy roll) → romance:breakup, big, ask, end|stay', [bs?.kind, bs?.big, bs?.mode, bs?.options.map(o => o.id)], ['romance:breakup', true, 'ask', ['end', 'stay']]);
    eq('… the roll says no → none today', breakupSpec(s, T0 + 20 * DAY, NO()), null);
    const exact = structuredClone(s); exact.story.relationships[A].tensionHighSince = T0 + 10 * DAY;
    eq('with a folded tensionHighSince: < 14 days → none', breakupSpec(exact, T0 + 20 * DAY, YES()), null);
    check('… ≥ 14 days → opens', breakupSpec(exact, T0 + 24 * DAY, NO())?.kind === 'romance:breakup');
    const early = started(baseState(), A, T0, 'talking');
    eq('not before dating', breakupSpec(boost(early, A, { tension: 0.9 }), T0 + 20 * DAY, YES()), null);
    const d = { id: 950, kind: 'romance:breakup', arcId, opensAt: T0 + 20 * DAY, status: 'committed', committed: { optionId: 'end', at: T0 + 22 * DAY, eventId: 951 } };
    const c = consequence(d, d.committed, s);
    eq('end → arc.ended broken_up', [c.events[0].type, c.events[0].payload.outcome, c.events[0].causeId], ['arc.ended', 'broken_up', 950]);
    const after = apply(s, { ...c.events[0], id: 960 });
    eq('… single again, cool-down 60 days', [after.story.romance.stage, after.story.romance.cooldownUntil - (T0 + 22 * DAY)], ['single', 60 * DAY]);
    eq('… self.relationship single', after.self.relationship, 'single');
    eq('stay → null', consequence(d, { ...d.committed, optionId: 'stay' }, s), null);
    // fizzle
    let f = started(boostReady(baseState()), A, T0);
    f = boost(f, A, { passion: -0.6 });
    const young = dailyRomance(f, { at: T0 + 4 * 3600, date: '2026-10-29', seed: SEED, rngFor: NO });
    check(`a romance under FIZZLE_GRACE_DAYS (${FIZZLE_GRACE_DAYS}) old never fizzles for low passion (live 2026-11-01: 4 h in)`, young.outcome !== 'fizzled', young.outcome);
    const fp = dailyRomance(f, { at: T0 + (FIZZLE_GRACE_DAYS + 1) * DAY, date: '2026-10-29', seed: SEED, rngFor: NO });
    eq('passion < 0.2 in an early stage after the grace → fizzled', [fp.outcome, fp.events[0]?.type, fp.events[0]?.payload.outcome], ['fizzled', 'arc.ended', 'fizzled']);
    const old = started(boostReady(baseState()), A, T0);
    eq('stalled too long → fizzled', dailyRomance(old, { at: T0 + (FIZZLE_AFTER_DAYS.interested + 1) * DAY, date: '2027-02-01', seed: SEED, rngFor: NO }).outcome, 'fizzled');
    const dated = started(boostReady(baseState()), A, T0, 'dating');
    check('dating never fizzles', dailyRomance(boost(dated, A, { passion: -0.6 }), { at: T0 + 400 * DAY, date: '2027-12-01', seed: SEED, rngFor: NO }).outcome !== 'fizzled');
    check('pendingDecisions sees an open breakup', pendingDecisions(Object.assign(structuredClone(s), {}), s.story.arcs[arcId]).length === 0);
  }

  section('daily metrics part');
  {
    let s = boostReady(baseState());
    const elig = dailyDelta(s, B, { sharedMin: 60 });
    eq('eligible, 60 min → half rate intimacy/passion, no commitment', elig, { intimacy: 0.01, passion: 0.01 });
    eq('family → nothing', dailyDelta(s, PARENT, { sharedMin: 600 }), {});
    s = started(s, A, T0, 'talking');
    eq('the partner (talking), 60 min → full rate + commitment', dailyDelta(s, A, { sharedMin: 60 }), { intimacy: 0.02, passion: 0.02, commitment: 0.005 });
    eq('… capped per day', dailyDelta(s, A, { sharedMin: 1000 }), { intimacy: 0.04, passion: 0.04, commitment: 0.01 });
    near('neglect: 8 days without contact → −0.01 passion', dailyDelta(s, A, { sharedMin: 0, noContactDays: 8 }).passion, -0.01, 1e-12);
    eq('within a week → nothing', dailyDelta(s, A, { sharedMin: 0, noContactDays: 6 }), {});
  }

  // ── Two simulated years on the real pulse + decision engine ─────────────
  section('2 years: the real pulse, decisions and the cast item');
  {
    // A seed whose onset roll hits within the first three weeks at romanceAppetite 1.
    let seed = null;
    for (let x = 1; x < 5000 && seed === null; x++) {
      setRngSeed(x);
      for (let d = 2; d < 21; d++) if (rngFor(dateKey(T0 + d * DAY, TZ), 'story:romance:onset')() < 0.006) { seed = x; break; }
    }
    setRngSeed(seed ?? 1);
    await setupScratchDb();
    resetDecisionCounters();
    const jev = fakeJevFixed({ step: 0.9, wait: 0.1, end: 0.2, stay: 0.8, go: 0.5, late: 0.2, stay_in: 0.3 });
    setJev(jev.fn);
    const clock = fakeClock(T0);
    setClock(clock.fn);
    let live = createInitialState(WORLD);
    const append = (spec) => { const e = appendEvent(spec); live = applyAppended(live, e, { world: WORLD }); return e; };
    genesis(append, WORLD, T0);
    // Scene set-up by the owner: he already likes one coworker; romance appetite up.
    append({ type: 'director.slider_set', at: T0, actor: 'owner', payload: { slider: 'romanceAppetite', value: 1 } });
    for (let i = 0; i < 2; i++) {
      append({ type: 'relationship.changed', at: T0, actor: 'owner', payload: { castId: A, delta: { passion: 0.2, intimacy: 0.15 }, reason: 'owner' } });
    }
    // The facade's consequence items, as story/index.js will offer them (T023).
    const failed = new Set();
    const consequenceItems = (s, g) => {
      const out = [];
      for (const d of s.decisions.values()) {
        if (d.status !== 'committed' || !String(d.kind).startsWith('romance:')) continue;
        const c = consequence(d, d.committed, s);
        if (!c || c.at > g || failed.has(d.id)) continue;
        const v = controlsCheck({ source: 'engine', category: c.category, action: c.action, pinKeys: c.pinKeys }, s);
        out.push({
          at: Math.max(c.at, s.at), prio: 9, label: 'romance:consequence', id: d.id,
          run: (add) => {
            if (!v.ok) { add({ type: 'decision.expired', at: Math.max(c.at, s.at), actor: 'engine', causeId: d.id, payload: { decisionId: d.id, reason: v.reason === 'pinned' ? 'pinned' : 'frozen' } }); return; }
            for (const e of c.events) add({ ...e, at: Math.max(e.at, s.at) });
          },
        });
      }
      return out;
    };
    const storyItems = (s, g) => [...dailyItems(s, g, WORLD, SEED, { getState: () => live }), ...consequenceItems(s, g)];
    const pulse = createPulse({ world: WORLD, getState: () => live, append, now: clock.fn, tickMinutes: 180, storyItems });
    const started0 = Date.now();
    const END = T0 + 730 * DAY;
    while (clock.now() < END) { clock.advance({ minutes: 180 }); await pulse.tick(); }
    const secs = ((Date.now() - started0) / 1000).toFixed(1);
    const evs = eventsAfter(0, 1e6);
    const byId = new Map(evs.map(e => [e.id, e]));
    const arcsStarted = evs.filter(e => e.type === 'arc.started' && e.payload.category === 'romance');
    const stages = evs.filter(e => e.type === 'arc.stage');
    console.log(`  (2 years in ${secs}s: ${evs.length} events, ${arcsStarted.length} romance arc(s), stages ${stages.map(e => e.payload.to).join('→') || 'none'}, final ${live.story.romance.stage})`);
    check('a romance started', arcsStarted.length >= 1);
    check('the partner is a fictional, non-family cast member', arcsStarted.every(e => e.payload.castIds.every(id => /^cast:/.test(id) && !String(live.cast.get(id)?.relation).startsWith('family') && live.cast.get(id)?.relation !== 'manager')));
    check('it progressed past interested', stages.length >= 2, stages.map(e => e.payload.to));
    // Walk each arc: no skip, dwell respected, caused by its decision.opened.
    let ok = true;
    let why = '';
    let activeAt = 0;
    for (const a of arcsStarted) {
      const ended = evs.find(e => e.type === 'arc.ended' && e.payload.arcId === a.id);
      if (a.at < activeAt) { ok = false; why = 'two romances at once'; }
      activeAt = ended ? ended.at : Infinity;
      let stage = a.payload.stage;
      let since = a.at;
      for (const st of stages.filter(e => e.payload.arcId === a.id)) {
        if (st.payload.from !== stage || st.payload.to !== nextStage(stage)) { ok = false; why = `skip ${stage}→${st.payload.to}`; }
        if (st.at - since < DWELL_DAYS[stage] * DAY) { ok = false; why = `dwell ${stage} ${((st.at - since) / DAY).toFixed(1)} d`; }
        const opened = byId.get(st.causeId);
        if (!opened || opened.type !== 'decision.opened' || opened.payload.kind !== 'romance:step' || opened.payload.arcId !== a.id) { ok = false; why = 'cause is not the step decision.opened'; }
        const commit = byId.get(st.payload.commitEventId);
        if (!commit || !['decision.committed', 'decision.reversed'].includes(commit.type) || commit.payload.decisionId !== st.causeId) { ok = false; why = 'commitEventId'; }
        if (BIG_STEPS.has(st.payload.to) && !(opened?.payload.big === true && opened.payload.decideBy - opened.at >= 24 * H)) { ok = false; why = 'big step without lead'; }
        if (st.originKind !== 'self') { ok = false; why = 'origin'; }
        stage = st.payload.to;
        since = st.at;
      }
    }
    check('no stage skipped, every dwell held, every step caused by its decision.opened (commit id in payload)', ok, why);
    const steps = evs.filter(e => e.type === 'decision.opened' && e.payload.kind === 'romance:step');
    check('step decisions use step|wait only', steps.every(e => e.payload.options.map(o => o.id).join('|') === 'step|wait'));
    eq('self.relationship follows the stage word', live.self.relationship, ['dating', 'committed', 'engaged', 'married'].includes(live.story.romance.stage) ? live.story.romance.stage : 'single');
    const marks = evs.filter(e => e.type === 'story.daily_done');
    eq('one daily marker per date over two years', marks.length, new Set(marks.map(e => e.payload.date)).size);
    check('the daily pass ran most days', marks.length >= 700, marks.length);
  }

  section('sim: the facade');
  if (!(await skipSimUnlessWired())) {
    await setupScratchDb();
    await bootLife({ jev: fakeJevFixed({ step: 0.9, wait: 0.1, end: 0.2, stay: 0.8, go: 0.5, late: 0.2 }) });
    await simulateDays(30, { stepMinutes: 60 });
    const evs = eventsAfter(0, 1e6);
    const stages = evs.filter(e => e.type === 'arc.stage');
    check('facade: every romance step is caused by a romance:step decision.opened',
      stages.every(st => getEvent(st.causeId)?.payload?.kind?.startsWith('romance:')));
    eq('facade: one marker per date', evs.filter(e => e.type === 'story.daily_done').length,
      new Set(evs.filter(e => e.type === 'story.daily_done').map(e => e.payload.date)).size);
    await stopLife();
  }
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}

// A attracted and close enough for the early thresholds (owner scene set-up).
function boostReady(s) {
  return boost(s, A, { passion: 0.5, intimacy: 0.45, commitment: 0.25, togetherMin: 600 });
}

report();
