// 015 Phase 2 — the continuity code rules (src/life/story/continuity.js, the
// director.plan hook; plan §P2.1, §P2.2): every rule is a WARNING (never a
// refusal) with a severity, code-built text and refs; open threads in 014's
// conflictsOf row shape; ≤ 4 code suggestions that are real actions and plan;
// warnings ride in the content signature, never in the fingerprint; chat-made
// plans are tagged fromChat and genericised; vitals are the base numbers (a
// strong chat mood changes nothing); a rule about a type another part adds runs
// only when the log knows that type.
//
// unit + integration: a realistic log from the life facade (example world,
// timers off), then the Director runs on a local projection and appender.
// Invented, persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed, HOUR, DAY,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended, setOverlayGate } from '../../src/life/projector.js';
import { zonedToUnix, dateKey, dayStart, addDays, resolveTimezone } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import {
  checkContinuity, codesAtLeast, plannerSuggestions, chatRefsOf, decisionFromChat, SKIP_KINDS, __test as cont,
} from '../../src/life/story/continuity.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(1);
await simulateHours(7);               // Wed 28 Oct, early afternoon
await stopLife();

let state = rebuild({ world });
const append = (spec) => {
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
const KNOWN = ['Quinlan Marsh'];
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append,
  knownNames: () => KNOWN, seed: () => seed, setClaimStatus: () => {}, fit: () => null,
  projectionBudgetMs: 20_000,
});
const tz = resolveTimezone(world.timezone ?? config.timezone);
const now = () => clock.now();
const tomorrow = addDays(dayStart(now(), tz), 1, tz);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const codes = (p) => (p?.continuity?.warnings ?? []).map(w => w.code);
const warning = (p, code) => (p?.continuity?.warnings ?? []).find(w => w.code === code) ?? null;
const outing = (placeId, startAt, minutes = 120, castIds = [], label = undefined) => ({
  kind: 'scene', shape: 'outing', placeId, startAt, minutes, castIds, ...(label ? { label } : {}),
});
let keepA = {};
async function applyAction(action) {
  const p = await director.preview(action, { project: false });
  return director.apply(p.previewId, p.fingerprint, { by: 'tester' });
}

section('the hook: plan() returns continuity; cheap kinds carry nothing');
{
  const p = director.plan({ kind: 'quick', button: 'tired' }, state, { now: now() });
  check('continuity is an object with the three lists', Array.isArray(p.continuity?.warnings) && Array.isArray(p.continuity?.threads)
    && Array.isArray(p.continuity?.suggestions));
  for (const k of ['fate', 'slider', 'pause', 'bookmark']) check(`${k} is a cheap kind`, SKIP_KINDS.has(k));
  const f = director.plan({ kind: 'fate', category: 'social', mode: 'guided' }, state, { now: now() });
  eq('fate: no warning, no thread', [f.continuity.warnings.length, f.continuity.threads.length], [0, 0]);
  const off = director.plan({ kind: 'quick', button: 'tired' }, state, { now: now(), continuity: false });
  eq('continuity:false → none at all', off.continuity, undefined);
}

section('C01 two_places · C02 travel_infeasible · C03 sleeping');
{
  const a = await applyAction(outing('place:restaurant', at(tomorrow, 19), 120, [], 'dinner out'));
  check('a first outing applied (committed tomorrow 19:00 at the restaurant)', a.ok && a.eventIds.length >= 3);
  const decisionA = a.eventIds.find(id => state.decisions.get(id));
  // 2026-11-02: an outing over a plan cancels it by default — kept here (KEEP IT INSTEAD) to see the clash rules.
  keepA = { resolutions: { [`decision:${decisionA}`]: 'keep' } };
  const b = director.plan({ ...outing('place:cinema', at(tomorrow, 19, 30), 90), ...keepA }, state, { now: now() });
  const w = warning(b, 'two_places');
  check('overlapping outing elsewhere → two_places (warn)', w?.severity === 'warn' && w.refs.decisionIds.includes(decisionA));
  check('… with a code-built text naming the other plan', /dinner out/.test(w?.text ?? '') && w.text.length <= 160);
  check('… and a conflict thread in the conflictsOf row shape', b.continuity.threads.some(t => t.kind === 'decision' && t.id === decisionA
    && t.fate === 'conflict' && typeof t.label === 'string' && 'fromChat' in t));
  check('a warning never refuses: the events are planned', b.refusals.length === 0 && b.events.some(e => e.type === 'decision.opened'));
  const same = director.plan(outing('place:restaurant', at(tomorrow, 19, 30), 60), state, { now: now() });
  check('same place → no two_places', !codes(same).includes('two_places'));
  const c = director.plan(outing('place:cinema', at(tomorrow, 21, 1), 90), state, { now: now() });
  check('right after it at another place → travel_infeasible (warn)', warning(c, 'travel_infeasible')?.severity === 'warn');
  const later = director.plan(outing('place:cinema', at(tomorrow, 22, 0), 60), state, { now: now() });
  check('an hour later → reachable, no travel warning', !codes(later).includes('travel_infeasible'));
  const night = director.plan(outing('place:cafe', at(tomorrow, 23, 0), 120), state, { now: now() });
  eq('into his sleep → sleeping (info)', warning(night, 'sleeping')?.severity, 'info');
}

section('C04 cast_away · C05 cast_at_work · C06 he_at_work (a later date: planDay rules)');
{
  append({ type: 'cast.beat', at: now(), actor: 'owner', payload: { castId: 'cast:flatmate', kind: 'away', text: 'visiting relatives', until: now() + 3 * DAY } });
  const p = director.plan(outing('place:park', at(tomorrow, 17, 0), 60, ['cast:flatmate']), state, { now: now() });
  check('with a member who is away → cast_away (warn)', warning(p, 'cast_away')?.severity === 'warn' && warning(p, 'cast_away').refs.castIds[0] === 'cast:flatmate');
  // Thursday is an office day in the example routine (09:30–18:00).
  const w = director.plan(outing('place:cafe', at(tomorrow, 14, 0), 60, ['cast:coworker-a']), state, { now: now() });
  check('his own work hours on an office day → he_at_work (warn)', warning(w, 'he_at_work')?.severity === 'warn');
  check('a coworker in work hours → cast_at_work (info)', warning(w, 'cast_at_work')?.severity === 'info');
  // 014 merged: the day-off plan edit is the suggestion, and it plans.
  check('014 schedule kind → a "take that time off work" suggestion', w.continuity.suggestions.some(s => s.action.kind === 'schedule' && s.action.background?.activity === 'off'),
    JSON.stringify(w.continuity.suggestions).slice(0, 300));
  const sat = (() => { let d = tomorrow; for (let i = 0; i < 7 && new Date((d + 12 * HOUR) * 1000).getUTCDay() !== 6; i++) d = addDays(d, 1, tz); return d; })();
  const weekend = director.plan(outing('place:cafe', at(sat, 14, 0), 60, ['cast:coworker-a']), state, { now: now() });
  check('a weekend → neither work warning', !codes(weekend).includes('he_at_work') && !codes(weekend).includes('cast_at_work'));
}

section('C13 threads · C20 chat_said (a chat-made plan is genericised and tagged)');
{
  const dm = '15550003333@s.whatsapp.net';
  const ev = at(tomorrow, 20, 0);
  const opened = append({ type: 'decision.opened', at: now(), actor: 'engine', subjectJid: dm, payload: {
    kind: 'hangout', subject: { eventAt: ev, endAt: ev + 2 * HOUR, placeId: 'place:park', castIds: [] }, opensAt: now(), decideBy: ev - HOUR,
    ponrAt: ev - 30 * 60, travelMin: 10, prepMin: 20, mode: 'auto', category: 'social',
    options: [{ id: 'go', label: 'SECRET-CHAT-LABEL', expiresAt: ev - 30 * 60 }, { id: 'late', label: 'Join later', expiresAt: ev + 2 * HOUR }, { id: 'stay', label: 'Stay in', expiresAt: null }],
  } });
  append({ type: 'decision.committed', at: now(), actor: 'engine', subjectJid: dm, payload: { decisionId: opened.id, optionId: 'go', p: 1, sampled: false, by: 'early' } });
  check('fixture: the decision reads as chat-made', decisionFromChat(state.decisions.get(opened.id)));
  keepA = { resolutions: { ...keepA.resolutions, [`decision:${opened.id}`]: 'keep' } };   // 020: a chat plan may be cancelled; kept here to see the clash
  const p = director.plan({ ...outing('place:cinema', at(tomorrow, 20, 30), 90), ...keepA }, state, { now: now() });
  const w = p.continuity.warnings.find(x => x.code === 'two_places' && x.fromChat);
  check('a clash with the chat plan is flagged fromChat (its own entry, never merged into an own one)', w?.severity === 'warn'
    && p.continuity.warnings.some(x => x.code === 'two_places' && !x.fromChat));
  const t = p.continuity.threads.find(x => x.id === opened.id);
  check('its thread is genericised and fromChat', t?.label === 'a plan from a chat' && t.fromChat === true);
  check('no warning or thread text carries the chat label', !JSON.stringify(p.continuity).includes('SECRET-CHAT-LABEL'));
  check('the chat thread counts in chat_said (info, fromChat) and overrides_open_chat (warn)',
    p.continuity.warnings.some(x => x.code === 'chat_said' && x.fromChat && x.severity === 'info')
    && p.continuity.warnings.some(x => x.code === 'overrides_open_chat' && x.fromChat && x.severity === 'warn'));
}

section('C09 romance · C11/C12 family · C14 pacing · C15 heavy guard (unit, crafted batches)');
{
  const base = state;
  const ctx = (over = {}) => ({ now: now(), tz, world, idBase: Math.max(director.PREVIEW_ID_BASE, base.lastEventId), knownType: () => false,
    listEvents: () => [], cfg: { newCastPer90d: 2, beatsPerWeek: 8, heavyMinGapDays: 90 }, actionKinds: new Set(director.ACTION_KINDS), ...over });
  const run = (events, kind = 'scene', over = {}, beforeState = base) => {
    const evs = events.map((e, i) => ({ ref: `$${i + 1}`, at: now(), actor: 'owner', ...e }));
    const after = director.foldDescriptors(beforeState, evs, world);
    return checkContinuity({ action: { kind }, events: evs }, beforeState, after, ctx(over));
  };
  const cOf = (r) => r.warnings.map(w => w.code);

  // Romance: an ex from a recent breakup, a stage jump, tension.
  const ex = structuredClone(base);
  ex.story.arcs[999] = { id: 999, category: 'romance', kind: 'romance', castIds: ['cast:coworker-b'], stage: 'dating', status: 'ended', outcome: 'broken_up', endedAt: now() - 10 * DAY };
  const exP = { type: 'decision.opened', actor: 'owner', payload: { kind: 'hangout', subject: { eventAt: at(tomorrow, 20), placeId: 'place:cafe', castIds: ['cast:coworker-b'] }, options: [] } };
  check('a date with someone who broke up with him 10 days ago → romance_with_ex (warn)', cOf(run([exP], 'scene', {}, ex)).includes('romance_with_ex'));
  check('… not without the breakup', !cOf(run([exP])).includes('romance_with_ex'));
  const jump = run([{ type: 'arc.stage', payload: { arcId: 1, from: 'interested', to: 'committed' } }]);
  check('a stage jump > 1 → stage_jump (info)', jump.warnings.some(w => w.code === 'stage_jump' && w.severity === 'info'));
  const cool = structuredClone(base);
  cool.story.romance.cooldownUntil = now() + 5 * DAY;
  check('a romance start in the cooldown → romance_cooldown (info)', cOf(run([{ type: 'arc.started', payload: { category: 'romance', kind: 'romance', castIds: ['cast:coworker-a'], stage: 'interested' } }], 'scene', {}, cool)).includes('romance_cooldown'));

  // Family: role words, ages, a third parent.
  eq('role words map', ['mother', 'dad', 'son', 'sister', 'cousin'].map(r => cont.roleOf(`family:${r}`)), ['parent', 'parent', 'child', 'sibling', null]);
  const young = run([{ type: 'cast.created', payload: { id: 'cast:young-mum', name: 'Avery Lane', relation: 'family:mother', birthday: '1995-01-01', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } }], 'scene');
  check('a mother 4 years older than him → family_age (warn)', young.warnings.some(w => w.code === 'family_age' && w.severity === 'warn'));
  const fine = run([{ type: 'cast.created', payload: { id: 'cast:old-mum', name: 'Blake Lane', relation: 'family:mother', birthday: '1970-01-01', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } }], 'scene');
  check('a plausible mother → no family_age', !cOf(fine).includes('family_age'));
  const three = run([
    { type: 'cast.created', payload: { id: 'cast:p2', name: 'Casey Lane', relation: 'family:father', birthday: '1966-01-01', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
    { type: 'cast.created', payload: { id: 'cast:p3', name: 'Drew Lane', relation: 'family:mum', birthday: '1967-01-01', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
  ], 'bundle');
  check('three parents → family_duplicate (warn)', cOf(three).includes('family_duplicate'));

  // Pacing (owner warnings, the engine's limits unchanged).
  const twoNew = run([
    { type: 'cast.created', payload: { id: 'cast:n1', name: 'Emery Moss', relation: 'friend', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
    { type: 'cast.created', payload: { id: 'cast:n2', name: 'Finley Moss', relation: 'friend', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
    { type: 'cast.created', payload: { id: 'cast:n3', name: 'Gray Moss', relation: 'friend', metrics: { closeness: 0.3, trust: 0.4, tension: 0 } } },
  ], 'bundle');
  check('three new people with a pace of 2 per 90 days → new_cast_pace (info)', twoNew.warnings.some(w => w.code === 'new_cast_pace' && w.severity === 'info'));
  const beats = run([{ type: 'cast.beat', payload: { castId: 'cast:flatmate', kind: 'status', text: 'busy' } },
    { type: 'cast.beat', payload: { castId: 'cast:sibling', kind: 'status', text: 'busy' } }], 'bundle', { cfg: { beatsPerWeek: 1 } });
  check('beats over the weekly pace → beats_week (info)', cOf(beats).includes('beats_week'));
  const heavy = run([{ type: 'heavy.started', heavy: true, payload: { kind: 'minor_accident', until: now() + 5 * DAY } }], 'scene', { lastHeavyAt: () => now() - 20 * DAY });
  check('a hard stretch 20 days after the last → heavy_gap (high)', heavy.warnings.some(w => w.code === 'heavy_gap' && w.severity === 'high'));
  const heavyActive = structuredClone(base);
  heavyActive.story.heavy.active = { id: 77, kind: 'minor_accident', until: now() + 3 * DAY };
  const h2 = run([{ type: 'cast.beat', payload: { castId: 'cast:flatmate', kind: 'status', text: 'ok' } }], 'scene', {}, heavyActive);
  eq('any change during a hard stretch → heavy_guard (info)', h2.warnings.find(w => w.code === 'heavy_guard')?.severity, 'info');
  const h3 = run([{ type: 'heavy.started', heavy: true, payload: { kind: 'breakup', until: now() + 5 * DAY } }], 'scene', {}, heavyActive);
  check('a second hard stretch → ends_active_heavy + the heavy.end suggestion', h3.warnings.some(w => w.code === 'ends_active_heavy')
    && h3.suggestions.some(s => s.action.kind === 'heavy.end' && s.action.heavyId === 77 && s.source === 'code'));
  const paused = structuredClone(base);
  paused.story.controls.paused = true;
  check('the story paused → paused_story (info)', cOf(run([{ type: 'cast.beat', payload: { castId: 'cast:flatmate', kind: 'status', text: 'ok' } }], 'scene', {}, paused)).includes('paused_story'));

  // C10 money (base vitals; projection adds its minimum at preview).
  const broke = run([{ type: 'money.spent', actor: 'owner', payload: { amount: (state.vitals.money ?? 0) + 5000, for: 'test' } }], 'scene');
  check('a spend below zero → money_negative (warn)', broke.warnings.some(w => w.code === 'money_negative' && w.severity === 'warn'));

  // Unknown types (another part's) are skipped; known → the rule runs.
  const fire = [{ type: 'career.set', payload: { employed: false, reason: 'fire' } }];
  const evs = fire.map((e, i) => ({ ref: `$${i + 1}`, at: now(), actor: 'owner', ...e }));
  const r1 = checkContinuity({ action: { kind: 'career' }, events: evs }, base, base, ctx({ knownType: () => false }));
  check('a type the log does not know → its rules skip', !r1.warnings.some(w => w.code === 'job_loss_big'));
  const r2 = checkContinuity({ action: { kind: 'career' }, events: evs }, base, base, ctx({ knownType: (t) => t === 'career.set' }));
  check('… known → job_loss_big (warn) and the coworkers note', r2.warnings.some(w => w.code === 'job_loss_big' && w.severity === 'warn')
    && r2.warnings.some(w => w.code === 'work_cast_after_job'));
  const opened = run([{ type: 'arc.stage', payload: { arcId: 1, from: 'talking', to: 'dating' } }]);
  check('an adjacent stage → no stage_jump', !cOf(opened).includes('stage_jump'));
}

section('vitals are the base numbers (012): a strong chat mood changes nothing');
{
  const s0 = structuredClone(state);
  const evs = [{ ref: '$1', at: now(), actor: 'owner', type: 'money.spent', payload: { amount: 10, for: 'test' } }];
  const ctx = { now: now(), tz, world, idBase: director.PREVIEW_ID_BASE, knownType: () => false, cfg: {}, actionKinds: new Set() };
  const plain = checkContinuity({ action: { kind: 'scene' }, events: evs }, s0, director.foldDescriptors(s0, evs, world), ctx);
  const moody = structuredClone(s0);
  moody.chatMood = [{ at: now() - 60, valence: -1, stress: 40, social: -30, eventId: 1, sender: 'x' }];
  setOverlayGate(() => true);
  const strong = checkContinuity({ action: { kind: 'scene' }, events: evs }, moody, director.foldDescriptors(moody, evs, world), ctx);
  setOverlayGate(null);
  eq('identical findings with and without the mood', JSON.stringify(strong), JSON.stringify(plain));
}

section('signatures: continuity in contentSig, never in the fingerprint');
{
  const p = director.plan(outing('place:cinema', at(tomorrow, 19, 30), 90), state, { now: now() });
  const q = { ...p, continuity: { ...p.continuity, warnings: [...p.continuity.warnings, { code: 'extra_code', severity: 'warn' }] } };
  check('a changed warning changes the content signature', director.contentSigOf(p) !== director.contentSigOf(q));
  eq('… but not the fingerprint', director.fingerprintOf(p.action, q, 5), director.fingerprintOf(p.action, p, 5));
  const pv = await director.preview({ ...outing('place:cinema', at(tomorrow, 19, 30), 90), ...keepA }, { project: false });
  check('the preview carries continuity', Array.isArray(pv.continuity?.warnings) && pv.continuity.warnings.some(w => w.code === 'two_places'));
  const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  check('a preview with a warn applies (APPLY is always enabled)', res.ok === true);
  check('apply reports the overridden codes ≥ warn (for the audit)', Array.isArray(res.continuity) && res.continuity.includes('two_places')
    && !res.continuity.includes('sleeping'));
  eq('codesAtLeast: info is left out', codesAtLeast({ warnings: [{ code: 'a', severity: 'info' }, { code: 'b', severity: 'high' }] }), ['b']);
}

section('suggestions: code-built actions that plan; never for heavy; never on a chat plan');
{
  const kinds = new Set(director.ACTION_KINDS);
  eq('overrides_pin on a member → unpin', plannerSuggestions([{ code: 'overrides_pin', severity: 'warn', refs: { pinKey: 'cast:flatmate' } }], kinds).map(s => s.action),
    [{ kind: 'unpin', pinKey: 'cast:flatmate' }]);
  eq('overrides_pin on heavy → nothing', plannerSuggestions([{ code: 'overrides_pin', severity: 'high', refs: { pinKey: 'arc:3.stage', category: 'heavy' } }], kinds), []);
  eq('overrides_frozen on heavy → no fate natural', plannerSuggestions([{ code: 'overrides_frozen', severity: 'high', refs: { category: 'heavy' } }], kinds), []);
  eq('overrides_frozen elsewhere → fate natural', plannerSuggestions([{ code: 'overrides_frozen', severity: 'warn', refs: { category: 'social' } }], kinds).map(s => s.action),
    [{ kind: 'fate', category: 'social', mode: 'natural' }]);
  // A planner's own entry (P1 `b.continuity`) merges first, with its suggestion validated by a real plan.
  director.__setDepsForTest({});
  const p = director.plan({ kind: 'quick', button: 'tired' }, state, { now: now() });
  for (const s of p.continuity.suggestions) {
    let ok = false;
    try { ok = director.plan(s.action, p.afterState, { now: now(), continuity: false }).events.length > 0; } catch { ok = false; }
    check(`suggestion ${s.action.kind} plans`, ok);
  }
  check('chat refs: an engine event caused by a chat pointer is chat-made', (() => {
    const evs = [{ ref: '$1', actor: 'engine', type: 'claim.adopted', causeId: 5 }, { ref: '$2', actor: 'engine', type: 'decision.opened', causeRef: '$1' },
      { ref: '$3', actor: 'owner', type: 'director.action' }];
    const set = chatRefsOf(evs, { getEvent: (id) => (id === 5 ? { originKind: 'dm' } : null) });
    return set.has('$1') && set.has('$2') && !set.has('$3');
  })());
  check('a code suggestion never names a chat-made decision', !JSON.stringify(director.plan(outing('place:cinema', at(tomorrow, 20, 30), 90), state, { now: now() })
    .continuity.suggestions).match(/decision\.pick|outcome/));
}

report();
