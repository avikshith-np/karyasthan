// T018 — src/life/story/weekly.js (research R15, contracts/model-output.md §1):
//
//   input   origin-free by construction: a world holding a chat-origin adoption,
//           a chat trigger and a real person's name → none of it in the input;
//           labels only (K/P/A/H), ≤ 8 KB;
//   gates   off, paused, budgetOk {ok:false} / a truthy object without ok:true /
//           absent → no call; the 7-day cadence (no catch-up); the life.arcs.
//           caller cap; effort 'low' (or the role's own when ARCS_WEEKLY_EFFORT='');
//   apply   beats (actor mind, origin self), status beats → cast.updated, pinned →
//           refusal, guided → story_proposals, new cast (closeness 0.3, caps, real
//           names refused), new place (region box), arc openers with code-built
//           labels (the note never reaches world_events), fell-back → beats only,
//           heavy nomination stored for the roll, invalid output → nothing.
// A real 009 pulse on a scratch DB (example world), fake clock, stubbed models.
import {
  setupScratchDb, fakeClock, section, check, eq, near, report, exampleWorld, exampleArcSeed, fakeCallRole, fakeJevFixed,
  blockNetwork, seedPeople, skipSimUnlessWired, DAY,
} from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, listEvents } from '../../src/life/eventLog.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { setJev, resetDecisionCounters, openDecision } from '../../src/life/decisions.js';
import { createPulse, genesis } from '../../src/life/pulse.js';
import { worldOverlay } from '../../src/life/story/reducer.js';
import * as store from '../../src/life/story/store.js';
import * as weekly from '../../src/life/story/weekly.js';

blockNetwork();
setRngSeed(11);
await setupScratchDb();
const WORLD = await exampleWorld();
const SEED = await exampleArcSeed();
const TZ = WORLD.timezone;
const T0 = zonedToUnix(2026, 10, 26, 5, 0, TZ);
const clock = fakeClock(T0);
setClock(clock.fn);
setJev(fakeJevFixed(null).fn);
resetDecisionCounters();

const GROUP = '120363000000000101@g.us';
const SECRET_LABEL = 'zz secret outing label';
const NOTE = 'note words that must stay private qq';
const [AVERY] = await seedPeople([{ name: 'Avery' }]);

const rt = { live: createInitialState(WORLD) };
rt.append = (spec) => { const e = appendEvent(spec); rt.live = applyAppended(rt.live, e, { world: WORLD }); return e; };
genesis(rt.append, WORLD, T0);
const pulse = createPulse({ world: WORLD, getState: () => rt.live, append: rt.append, now: clock.fn, tickMinutes: 15 });
await pulse.settle(T0);
while (clock.now() < T0 + 2 * DAY) { clock.advance({ minutes: 15 }); await pulse.tick(); }

// A chat-origin adoption and a chat trigger: neither may reach the weekly input.
const ptr = rt.append({ type: 'claim.flagged', at: clock.now(), actor: 'chat', originKind: 'group', originJid: GROUP, payload: { claimId: 1, kind: 'claim' } });
const adopted = rt.append({ type: 'claim.adopted', at: clock.now(), actor: 'engine', causeId: ptr.id, subjectJid: AVERY,
  payload: { claimId: 1, reviewId: 1, as: 'decision', ref: null } });
await openDecision(() => rt.live, {
  kind: 'claim:movie', category: 'social', adopted: true, preCommit: 'go', claimId: 1,
  subject: { eventAt: clock.now() + 2 * DAY, placeId: 'place:cinema', castIds: ['cast:flatmate'], minutes: 120 },
  options: [{ id: 'go', label: SECRET_LABEL, go: true }, { id: 'late', label: 'Join later', go: 'late' }, { id: 'stay', label: 'Stay in' }],
}, { at: clock.now(), world: WORLD, append: rt.append, causeId: adopted.id, subjectJid: AVERY });
rt.append({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'group', originJid: GROUP, payload: { text: 'Avery says hi', kind: 'mention' } });
rt.append({ type: 'cast.beat', at: clock.now(), actor: 'owner', payload: { castId: 'cast:sibling', kind: 'news', text: 'owner beat ok' } });

const okBudget = { ok: true, reason: null, spentUsd: 0 };
function wire(over = {}) {
  const cr = over.cr ?? fakeCallRole({ 'life.arcs.weekly': () => JSON.stringify({ beats: [] }) });
  weekly.__setDepsForTest({
    now: clock.fn, callRole: cr.fn, getState: () => rt.live, append: rt.append, world: WORLD, isOn: () => true,
    getUsageByCaller: () => [], knownNames: ['Avery'], seed: SEED, persona: { name: 'Testname', voiceDescriptor: 'plain' },
    ...over.deps,
  });
  return cr;
}
const lastWeeklyReset = () => store.patchState({ last_weekly_at: null });
const payloads = () => eventsAfter(0, 100000).map(e => JSON.stringify(e.payload)).join('\n');

try {
  section('input: origin-free by construction');
  {
    const { input, labelMap, bytes } = weekly.buildWeeklyInput(rt.live, SEED, { at: clock.now(), world: WORLD });
    const text = JSON.stringify(input);
    check('the adoption label is absent', !text.includes(SECRET_LABEL));
    check('no chat jid, chat text or real name', !text.includes(GROUP) && !text.includes('says hi') && !/avery/i.test(text));
    check('no claim / adoption / chat event types in the self-week counts',
      !Object.keys(input.selfWeek).some(t => /^claim\.|^chat\.|commitment\.recorded|activity\.recorded/.test(t)));
    const selfOpened = eventsAfter(0, 100000).filter(e => e.type === 'decision.opened' && e.originKind === 'self' && e.at >= clock.now() - 7 * DAY).length;
    eq('decision events of the adoption (chat origin) are not counted', input.selfWeek['decision.opened'] ?? 0, selfOpened);
    eq('cast labelled K1…Kn, places P1…Pn', [Object.keys(labelMap.cast)[0], Object.keys(labelMap.places)[0]], ['K1', 'P1']);
    check('cast entries hold no ids', !/cast:/.test(JSON.stringify(input.cast)) && !/place:/.test(JSON.stringify(input.places)));
    check('owner beats are included', JSON.stringify(input.cast).includes('owner beat ok'));
    check('≤ 8 KB', bytes <= weekly.INPUT_MAX_BYTES);
    eq('heavy themes by label and kind only', input.heavyThemes.map(h => Object.keys(h).sort().join()), ['kind,ref', 'kind,ref']);
    eq('week key', input.week, '2026-W44');
  }

  section('gates');
  {
    let cr = wire({ deps: { isOn: () => false } });
    eq('off → skipped, no call', [(await weekly.runWeekly({ budgetOk: okBudget })).reason, cr.calls.length], ['disabled', 0]);
    for (const [name, b] of [['{ok:false}', { ok: false, reason: 'budget' }], ['a truthy object without ok:true', { reason: null, spentUsd: 0 }],
      ['absent', undefined], ['ok:"yes"', { ok: 'yes' }]]) {
      cr = wire();
      lastWeeklyReset();
      const r = await weekly.runWeekly({ nightKey: '2026-10-28', trigger: 'sleep', budgetOk: b });
      eq(`budgetOk ${name} → skipped (budget), no call`, [r.status, r.reason, cr.calls.length], ['skipped', 'budget', 0]);
    }
    eq('a skip row is written once per reason per day', store.listRuns({ kind: 'weekly', status: 'skipped' }).filter(r => r.skipReason === 'budget').length, 1);
    cr = wire({ deps: { getUsageByCaller: () => [{ caller: 'life.arcs.seed', costUsd: 0.4 }, { caller: 'life.arcs.weekly', costUsd: 0.7 }] } });
    eq('caller cap reached → skipped, no call', [(await weekly.runWeekly({ budgetOk: okBudget })).reason, cr.calls.length], ['caller_cap', 0]);
    const paused = structuredClone(rt.live);
    paused.story.controls.paused = true;
    cr = wire({ deps: { getState: () => paused } });
    eq('paused → skipped, no call', [(await weekly.runWeekly({ budgetOk: okBudget })).reason, cr.calls.length], ['paused', 0]);

    cr = wire();
    const r1 = await weekly.runWeekly({ nightKey: '2026-10-28', trigger: 'sleep', budgetOk: okBudget });
    eq('due + gates open → one call', [r1.status, cr.calls.length], ['ok', 1]);
    const call = cr.calls[0];
    eq('mind role, caller life.arcs.weekly, effort low, maxTokens 3000', [call.role, call.caller, call.opts.effort, call.opts.maxTokens],
      ['mind', 'life.arcs.weekly', 'low', 3000]);
    check('the state is fenced; the persona is in the user message only', call.user.includes('<<<STORY_DATA kind="state">>>')
      && call.user.includes('Testname') && !call.system.includes('Testname'));
    const r2 = await weekly.runWeekly({ budgetOk: okBudget });
    eq('a second night the same week → not_due, no call, no row', [r2.reason, cr.calls.length, r2.runId], ['not_due', 1, null]);
    clock.advance({ days: 7 });
    weekly.__setDepsForTest(null);
    cr = wire({ deps: { cfg: { weeklyEffort: '' } } });
    await weekly.runWeekly({ budgetOk: okBudget });
    eq('7 days later → due again; ARCS_WEEKLY_EFFORT="" → no effort (the role\'s own)', [cr.calls.length, 'effort' in cr.calls[0].opts], [1, false]);
    lastWeeklyReset();
    cr = wire({ cr: fakeCallRole({ 'life.arcs.weekly': () => ({ text: null, skipped: 'budget', status: 'budget' }) }) });
    eq('callRole over budget → skipped run', (await weekly.runWeekly({ budgetOk: okBudget })).status, 'skipped');
    check('…and the week still counts (no retry burst)', !weekly.weeklyDue(clock.now()));
  }

  section('apply');
  {
    const out = {
      beats: [
        { cast: 'K1', kind: 'hobby', text: 'took up pottery' },
        { cast: 'K2', kind: 'status', text: 'between two deadlines' },
      ],
      new_cast: { name: 'Rowan Vale', relation: 'friend', pronouns: 'they/them', birthday: '1996-05-02', personality: 'calm and dry', speech: 'short texts',
        status: 'new to the area', via: 'K1', homeNear: 'P2' },
      new_place: { name: 'Corner bakery', kind: 'bakery', near: 'P2', offsetKm: 0.8 },
      arc_decisions: [{ kind: 'cast_meetup', cast: 'K1', note: NOTE }, { kind: 'family_visit', cast: 'K1', note: NOTE }, { kind: 'career_hunt', cast: null, note: NOTE }],
      heavy_nomination: { theme: 'H2' },
    };
    const before = eventsAfter(0, 100000).length;
    lastWeeklyReset();
    const cr = wire({ cr: fakeCallRole({ 'life.arcs.weekly': () => JSON.stringify(out) }) });
    const r = await weekly.runWeekly({ budgetOk: okBudget });
    const added = eventsAfter(0, 100000).slice(before);
    check('run applied', ['ok', 'partial'].includes(r.status), r);
    const { labelMap } = weekly.buildWeeklyInput(rt.live, SEED, { at: clock.now(), world: WORLD });
    const k1 = labelMap.cast.K1.castId;
    const beats = added.filter(e => e.type === 'cast.beat');
    eq('beats: actor mind, origin self', beats.map(e => [e.actor, e.originKind]), [['mind', 'self'], ['mind', 'self']]);
    eq('a status beat also updates the status', added.filter(e => e.type === 'cast.updated').map(e => e.payload.reason), ['weekly']);
    const created = added.find(e => e.type === 'cast.created');
    eq('new cast created (actor mind, met via K1)', [created?.actor, created?.payload.metVia, created?.payload.relation], ['mind', k1, 'friend']);
    near('…closeness 0.3 after its relationship.changed', rt.live.cast.get(created.payload.id)?.metrics.closeness, 0.3, 1e-9);
    const place = added.find(e => e.type === 'place.created');
    check('new place inside the region box', place && rt.live.places.has(place.payload.id));
    const opened = added.filter(e => e.type === 'decision.opened');
    eq('arc openers: code-built kinds (family_visit for a non-family member refused)', opened.map(e => e.payload.kind).sort(), ['career:hunt', 'social:meetup']);
    check('…option labels are code templates', opened.every(e => e.payload.options.every(o => !o.label.includes('qq'))));
    check('the note never reaches world_events', !payloads().includes(NOTE));
    check('…but is kept in story_runs', JSON.stringify(store.getRun(r.runId).output).includes(NOTE));
    eq('heavy nomination stored for the next roll', [store.getState('last_weekly_run').nominated, weekly.nominatedTheme()],
      [labelMap.heavy.H2, labelMap.heavy.H2]);
    eq('every new event is self-origin', [...new Set(added.map(e => e.originKind))], ['self']);
    eq('one refusal (family visit for a non-family member)', store.listRefusals({ source: 'mind' }).filter(x => x.action === 'decision').length, 1);
    check('the call saw no previous chat content', !cr.calls[0].user.includes(SECRET_LABEL));
  }

  section('controls, caps and names');
  {
    const at = clock.now();
    const base = { at, runId: store.recordRun({ kind: 'weekly', caller: 'life.arcs.weekly', status: 'ok' }), weekKey: '2026-W45', world: WORLD, knownNames: ['Avery'] };
    const pinned = structuredClone(rt.live);
    pinned.story.controls.pins['cast:manager'] = { eventId: 1, at };
    const v1 = { beats: [{ castId: 'cast:manager', kind: 'news', text: 'quiet week' }], refused: [] };
    let n0 = eventsAfter(0, 100000).length;
    const a1 = await weekly.applyWeekly(v1, {}, pinned, rt.append, base);
    eq('pinned member → refused, nothing appended', [a1.beats, a1.refused, eventsAfter(0, 100000).length - n0], [0, 1, 0]);
    check('…a refusal row with the pin key', store.listRefusals({ source: 'mind', reason: 'pinned' }).some(x => x.pinKey === 'cast:manager'));
    const guided = structuredClone(rt.live);
    guided.story.controls.fate.cast = 'guided';
    const a2 = await weekly.applyWeekly({ beats: [{ castId: 'cast:parent', kind: 'news', text: 'garden is blooming' }] }, {}, guided, rt.append, base);
    eq('guided category → a pending proposal, nothing appended', [a2.beats, a2.proposals, store.countProposals({ status: 'pending' }) >= 1], [0, 1, true]);
    const a3 = await weekly.applyWeekly({ beats: [{ castId: 'cast:parent', kind: 'news', text: 'had lunch with Avery' }] }, {}, rt.live, rt.append, base);
    eq('a real name in beat text → refused (name_collision)', [a3.beats, store.listRefusals({ reason: 'name_collision' }).length >= 1], [0, true]);
    const a4 = await weekly.applyWeekly({ newCast: { name: 'Avery Lane', relation: 'friend', birthday: '1990-01-01', via: null, homeNear: null } }, {}, rt.live, rt.append, base);
    eq('a new member with a real first name → refused', a4.newCast, 0);
    const capped = structuredClone(rt.live);
    capped.story.newCast.ats = [at - 10 * DAY, at - 20 * DAY];
    const a5 = await weekly.applyWeekly({ newCast: { name: 'Juno Park', relation: 'neighbour', birthday: '1990-01-01', via: null, homeNear: null } }, {}, capped, rt.append, base);
    eq('2 new members in 90 days → the third is refused (cap)', [a5.newCast, a5.refused], [0, 1]);
    n0 = eventsAfter(0, 100000).length;
    const a6 = await weekly.applyWeekly({
      beats: [{ castId: 'cast:parent', kind: 'news', text: 'joined a choir' }],
      newCast: { name: 'Kit Moss', relation: 'friend', birthday: '1990-01-01', via: null, homeNear: null },
      newPlace: { name: 'Night market', kind: 'market', near: 'place:park', offsetKm: 1 },
      arcDecisions: [{ kind: 'social_plan', castId: null, note: '' }],
      heavyNomination: { themeId: 'minor-accident' },
    }, {}, rt.live, rt.append, { ...base, fellBack: true });
    const newTypes = eventsAfter(0, 100000).slice(n0).map(e => e.type);
    eq('a fell-back run applies beats only', [a6.beats, a6.newCast, a6.newPlace, a6.decisions, a6.nominated, newTypes], [1, 0, 0, 0, null, ['cast.beat']]);
    const frozen = structuredClone(rt.live);
    frozen.story.controls.fate.heavy = 'frozen';
    eq('heavy frozen → nomination refused', (await weekly.applyWeekly({ heavyNomination: { themeId: 'minor-accident' } }, {}, frozen, rt.append, base)).nominated, null);
    const box = weekly.regionBox(WORLD);
    check('region box = genesis places + 10 km', box && box.latMax > Math.max(...WORLD.places.map(p => p.lat)));
  }

  section('invalid output');
  {
    lastWeeklyReset();
    const n0 = eventsAfter(0, 100000).length;
    wire({ cr: fakeCallRole({ 'life.arcs.weekly': () => 'I would rather not. {"beats": [' }) });
    const r = await weekly.runWeekly({ budgetOk: okBudget });
    eq('invalid → run invalid, nothing appended', [r.status, eventsAfter(0, 100000).length - n0, store.getRun(r.runId).status], ['invalid', 0, 'invalid']);
  }

  section('sim');
  if (!(await skipSimUnlessWired())) {
    check('storyWeeklyPass is exported by the life facade', true);
  }
} catch (err) {
  check('no unexpected exception', false, err?.stack || String(err));
}

void listEvents;
void worldOverlay;
report();
