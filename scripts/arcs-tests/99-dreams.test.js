// Plan 020 G: dreams. Ingredients, plan, REM timing and recall in code; a fragment from a phrase table; a vivid one with at most one small
// model call a night and a template otherwise. His own life only: no chats, real people or anything heavy. Never sexual; a nightmare is
// never graphic. Example world, fake clock, stubbed models, no network.
import fs from 'fs';
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, simulateDays, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { appendEvent, eventsAfter, getEvent, lastEventId } from '../../src/life/eventLog.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as dreamStore from '../../src/life/story/dreams/store.js';
import * as dreamWorker from '../../src/life/story/dreams/worker.js';
import * as plan from '../../src/life/story/dreams/plan.js';
import { buildSheet } from '../../src/life/story/phone/facts.js';
import { renderUser as phoneRender } from '../../src/life/story/phone/charter.js';
import { bulletFor } from '../../src/life/story/journal.js';
import { withChatMood } from '../../src/life/projector.js';
import { dayStart, localParts, resolveTimezone, zonedToUnix } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

section('REM grows toward morning');
{
  const p = plan.remPeriods(0, 8 * HOUR, seq(0.5));
  check('several cycles', p.length >= 4, p.length);
  const len = p.map(x => x.to - x.from);
  check('each longer than the last, up to the cap', len.every((l, i) => i === 0 || l >= len[i - 1]), len);
  check('the first is short, the last long', len[0] <= 15 * 60 && len.at(-1) >= 35 * 60, len);
  const debt = plan.remPeriods(0, 8 * HOUR, seq(0.5), { debtHours: 5 });
  check('more of it after lost sleep', debt[2].to - debt[2].from > len[2]);
}

section('recall: inside REM mostly, otherwise rarely, and a nightmare stays with him');
{
  const periods = [{ from: 1000, to: 2000 }];
  const rates = (wake, tone) => {
    let n = 0; let v = 0; let x = 0.0;
    for (let i = 0; i < 2000; i++) { x = (x + 0.6180339887) % 1; const r = plan.recallAt(wake, periods, tone, () => x); if (r) n++; if (r === 'vivid') v++; }
    return { any: n / 2000, vivid: v / 2000 };
  };
  const inside = rates(1500, 'flat');
  const after = rates(2300, 'flat');
  const far = rates(9000, 'flat');
  check('inside REM he can wake with a vivid one', inside.vivid > 0.15, inside);
  check('away from it, never vivid', after.vivid === 0 && far.vivid === 0);
  check('more just after than long after', after.any > far.any, [after, far]);
  check('mostly nothing far from it', far.any <= 0.1, far);
  check('a nightmare is remembered more', rates(1500, 'nightmare').any > inside.any);
}

section('tone: nightmares rise with stress');
{
  const rate = (stress) => { let n = 0; let x = 0; for (let i = 0; i < 2000; i++) { x = (x + 0.6180339887) % 1; if (plan.toneOf({ stress, mood: { valence: 0.2 } }, [], () => x) === 'nightmare') n++; } return n / 2000; };
  check('rare when calm', rate(20) <= 0.03, rate(20));
  check('higher under stress, still not common', rate(80) > rate(20) && rate(80) <= 0.2, rate(80));
}

section('the words a model may not use');
{
  eq('fine', plan.wordsProblem('He was at the cafe with Robin, and the stairs kept going down. It cut off there.', { names: ['Robin'] }), null);
  eq('too short', plan.wordsProblem('A dream.', {}), 'short');
  eq('too long', plan.wordsProblem('x '.repeat(300), {}), 'long');
  eq('graphic', plan.wordsProblem('He was at the cafe and there was blood across the whole floor of it.', {}), 'graphic');
  eq('an identifier', plan.wordsProblem('He was at the cafe and the number 5550100123 kept ringing him up.', {}), 'identifier');
  eq('a real person', plan.wordsProblem('He was at the cafe and quinn was there across the table from him.', { knownNames: ['Quinn Marlow'] }), 'real_name');
  eq('a person it was not given', plan.wordsProblem('He was at the cafe with Zanzibar, who kept on asking him things.', { names: ['Robin'] }), 'invented_name');
  // Finding 2: what the desire check doesn't know. A hit keeps the template.
  for (const [t, why] of [['She was naked on the bed in the cafe, and that was all of it.', 'sexual'], ['They were kissing at the bus stop, and it went on for a while.', 'sexual'],
    ['They were making love somewhere near the office, he thinks.', 'sexual'], ['He woke up aroused and could not remember why at all.', 'sexual'],
    ['His friend died in front of him at the cafe and nobody saw.', 'graphic'], ['Someone shot him in the chest at the office and he kept walking.', 'graphic'],
    ['He was bleeding and dying at the bus stop, and nobody looked.', 'graphic'], ['There was something at his throat in the dark at the office.', 'graphic']]) {
    eq(`refused: ${t.slice(0, 28)}`, plan.wordsProblem(t, { names: ['Robin'] }), why);
  }
  // Finding 4: a name at the start of a sentence.
  eq('a name it wasn\'t given, opening the dream', plan.wordsProblem('Rahul was there at the cafe, saying nothing useful at all to him.', { names: ['Robin'] }), 'invented_name');
  eq('…opening a later sentence', plan.wordsProblem('He was at the cafe. Rahul kept asking him for something he did not have.', { names: ['Robin'] }), 'invented_name');
  eq('a name it was given', plan.wordsProblem('Robin was there at the cafe, saying nothing useful at all to him.', { names: ['Robin'] }), null);
  eq('ordinary openers pass', plan.wordsProblem('Then it was a park. Someone was waiting. Nothing moved, and he never got there.', { names: [] }), null);
  // Re-review: an ordinary dream isn't refused for how it starts, a name behind a quote mark is, and the real refusals stand.
  const tail = ' He was at the cafe with Robin and nothing he said came out right at all.';
  for (const t of ['Suddenly the room was empty.', 'Somewhere a door kept closing.', 'Now he was late.', 'Instead of the office there was a long road.', 'Back at the cafe, the chairs were gone.', 'Walking felt slow.',
    'He had a shot of coffee.', 'It was a dead end.', 'Her lips moved but no sound came.']) {
    eq(`not refused: ${t}`, plan.wordsProblem(t + tail, { names: ['Robin'] }), null);
  }
  eq('a name behind an opening quote', plan.wordsProblem('He looked up. "Rahul was here," Robin said, and the lights went out.', { names: ['Robin'] }), 'invented_name');
  eq('…a curly one', plan.wordsProblem('He looked up. “Rahul was here,” Robin said, and the lights went out.', { names: ['Robin'] }), 'invented_name');
  eq('…a new line', plan.wordsProblem('He looked up at the cafe\nRahul was there, and the lights went out.', { names: ['Robin'] }), 'invented_name');
  eq('a name it was given, in quotes', plan.wordsProblem('He looked up. "Robin was here," someone said, and the lights went out.', { names: ['Robin'] }), null);
  for (const [t, why] of [['Someone shot him at the office, and he kept on walking.', 'graphic'], ['He was shot at the bus stop, and nobody looked up.', 'graphic'], ['His friend was dead on the floor of the cafe, and nobody saw.', 'graphic'],
    ['Then she was dead and he could not say why, at the cafe.', 'graphic'], ['Her lips on his neck, at the bus stop, and it went on.', 'sexual'], ['His lips pressed to hers at the cafe, for a long while.', 'sexual']]) {
    eq(`still refused: ${t.slice(0, 30)}`, plan.wordsProblem(t, { names: ['Robin'] }), why);
  }
  const src = fs.readFileSync(new URL('../../src/life/story/dreams/plan.js', import.meta.url), 'utf8');
  check('the desire check runs on every model dream, so it is never sexual', src.includes('if (contentProblem(t)) return \'content\''));
  check('the charter says so', /Never sexual/.test(plan.DREAM_CHARTER) && /never blood/.test(plan.DREAM_CHARTER));
}

section('the plan: grounded in that day, no one twice, an older thing sometimes');
{
  const recent = [{ charge: 1, tone: 'bad', placeId: 'place:cafe', castId: 'cast:a' }, { charge: 0.3, castId: 'cast:b' }];
  const args = { tone: 'flat', recent, lag: [{ placeId: 'place:park', castId: 'cast:c' }], remote: { placeIds: ['place:gym'], castIds: ['cast:d'] }, bonds: ['cast:a', 'cast:b'], placesToday: ['place:cafe', 'place:office'], concern: 'work', wordOfPlace: (id) => id.slice(6), nameOf: (id) => id.slice(5), home: 'place:home' };
  let older = 0;
  let x = 0.1;
  for (let i = 0; i < 300; i++) {
    const p = plan.planDream(args, () => { x = (x + 0.6180339887) % 1; return x; });
    if (i === 0) check('two or three scenes', p.scenes.length >= 2 && p.scenes.length <= 3);
    if (p.scenes[0].person !== 'a' || p.scenes[0].place !== 'cafe') { check('the first scene is the day\'s strongest', false, p.scenes[0]); break; }
    const people = p.scenes.map(s => s.person).filter(Boolean);
    if (new Set(people).size !== people.length) { check('no one twice', false, people); break; }
    if (p.scenes.some(s => s.source === 'lag' || s.source === 'remote')) older++;
  }
  check('sometimes something older', older > 30 && older < 250, older);
  eq('nothing lived, no dream', plan.planDream({ ...args, recent: [] }, seq(0.5)), null);
  const p = plan.planDream({ ...args, tone: 'nightmare' }, seq(0.5));
  eq('a nightmare ends in the chase', p.scenes.at(-1).kind, 'chase');
  check('a template that reads', /^He was at /.test(plan.vividTemplate(p)) && !/undefined|null/.test(plan.vividTemplate(p)));
  const f = plan.fragmentOf(p, 'nightmare', seq(0.5), []);
  check('a fragment is a filled line', typeof f.text === 'string' && !/[{}]/.test(f.text) && f.key.startsWith('nightmare:'), f);
  const keys = new Set();
  const used = [];
  for (let i = 0; i < 4; i++) { const g = plan.fragmentOf(p, 'nightmare', seq(0.5), used); keys.add(g.key); used.push(g.key); }
  eq('a phrase doesn\'t come back soon', keys.size, 4);
}

// ── the real log ───────────────────────────────────────────────────────────

const calls = [];
let dreamAnswer = () => JSON.stringify({ text: 'He was at the office with Coworker, and all the clocks said something different. Then it was a park, and he never got there.' });
const cr = fakeCallRole({ 'life.dream': (sys, user, opts) => { calls.push({ sys, user, opts }); return dreamAnswer(); } });
const deps = { getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => ['Quinn Marlow'] };
let { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest(deps);
config.arcs.scenesEnabled = false;
config.arcs.phoneOrganicPerDay = 0;
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const dreams = () => eventsAfter(0, 500000).filter(e => e.type === 'dream.had');
const at = (off, h, m = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, m, tz) + off * DAY; };
const realRng = (...a) => globalThis.__rngFor(...a);
const { rngFor } = await import('../../src/life/rng.js');
globalThis.__rngFor = rngFor;
const forceRecall = () => dreamWorker.configure({ rngFor: () => { const r = () => 0.001; r.int = (a) => a; r.weighted = (l) => l[0]; return r; } });
const naturalRecall = () => dreamWorker.configure({ rngFor: (...a) => realRng(...a) });

await simulateHours(30);
await story.idle();

section('a call to the worker: what stops a dream');
{
  const s = S();
  const added = [];
  const add = (e) => { added.push(e); return { id: 99, ...e }; };
  forceRecall();
  const sleepEv = eventsAfter(0, 50000).filter(e => e.type === 'sleep.started').at(-1);
  const t = clock.now();
  const base = { at: t, add, sleepEventId: sleepEv.id, startedAt: t - 7 * HOUR };
  eq('no sleep at all', dreamWorker.atDream(s, { ...base, sleepEventId: null, startedAt: null }), null);
  eq('a nap', dreamWorker.atDream(s, { ...base, startedAt: t - 40 * 60 }), null);
  const afternoon = at(0, 14);
  eq('a daytime sleep', dreamWorker.atDream(s, { ...base, at: afternoon + 3 * HOUR, startedAt: afternoon }), null);
  eq('downtime: nothing back-dated', dreamWorker.atDream(s, { ...base, at: t - 3 * HOUR, startedAt: t - 10 * HOUR }), null);
  config.arcs.dreamsEnabled = false;
  eq('switched off', dreamWorker.atDream(s, base), null);
  config.arcs.dreamsEnabled = true;
  eq('nothing was added', added.length, 0);
  naturalRecall();
}

section('an owner\'s wake mid-night: it reaches the dream as interrupted, caused by the sleep');
{
  await story.idle();
  const start = at(1, 2, 30);
  const asleepBy = at(1, 0, 30);
  const before = lastEventId();
  while (clock.now() < asleepBy) await simulateHours(0.5);
  check('he is asleep', S().sleep?.startedAt != null, S().sleep);
  forceRecall();
  const pv = await director.preview({ kind: 'wake', at: start, reason: 'cant_sleep' }, { relax: true }).catch(e => ({ err: e.code, reason: e.reason }));
  check('the wake previews', pv.previewId, pv);
  await director.apply(pv.previewId, pv.fingerprint);
  while (clock.now() < start + 1800) await simulateHours(0.25);
  await story.idle();
  const d = dreams().filter(e => e.id > before);
  eq('one dream', d.length, 1);
  eq('finding 9: caused by the wake that broke the night', getEvent(d[0].causeId).type, 'woke');
  eq('interrupted', d[0].payload.interrupted, true);
  eq('engine, no real person', [d[0].actor, d[0].subjectJid ?? null], ['engine', null]);
  check('codes in the log, no words', !JSON.stringify(d[0].payload).includes('stairs') && d[0].payload.text === undefined);
  const row = dreamStore.byEvent(d[0].id);
  check('the words are in the table', typeof row.text === 'string' && row.text.length > 10, row);
  naturalRecall();
  // He goes back to sleep and wakes again: one a night.
  const n = dreams().length;
  await simulateHours(12);
  await story.idle();
  eq('no second dream that night', dreams().filter(e => e.at < d[0].at + 12 * HOUR).length, n);
  // Finding 9: undo the wake and the dream goes with it, and his real morning can have one.
  const { isExcludedId } = await import('../../src/life/projector.js');
  const start2 = at(1, 2, 30);
  const asleep2 = at(1, 0, 30);
  while (clock.now() < asleep2) await simulateHours(0.5);
  forceRecall();
  const pw = await director.preview({ kind: 'wake', at: start2, reason: 'cant_sleep' }, { relax: true });
  const applied = await director.apply(pw.previewId, pw.fingerprint);
  while (clock.now() < start2 + 900) await simulateHours(0.25);
  await story.idle();
  const broke = dreams().at(-1);
  check('a dream from that wake', broke?.payload?.interrupted === true && broke.at === start2, broke);
  const rv = life.revertChangePreview(applied.eventIds[0]);
  life.revertChange(applied.eventIds[0], { fingerprint: rv.fingerprint, reason: 'test' });
  check('undoing the wake undoes the dream', isExcludedId(S(), broke.id));
  check('…so no mood and no line', S().story?.dream?.eventId !== broke.id);
  await story.runDreamsNow();
  eq('…and its words go', dreamStore.byEvent(broke.id).status, 'reverted');
  naturalRecall();
}

section('a vivid dream\'s words: one small call, its own cap, the template otherwise');
const vivid = () => {
  const ev = appendEvent({ type: 'dream.had', at: clock.now(), actor: 'engine', causeId: eventsAfter(0, 500000).filter(e => e.type === 'sleep.started').at(-1).id,
    payload: { recall: 'vivid', tone: 'flat', castIds: ['cast:coworker-a'], placeIds: ['place:office'], until: clock.now() + 4 * HOUR } });
  story.__rebuildForTest();
  const p = { scenes: [{ place: 'the office', person: 'Coworker', twist: 'all the clocks said something different', kind: 'odd' }, { place: 'a park', person: null, twist: 'the stairs kept going down', kind: 'impossible' }], task: 'looking for his laptop', ending: 'lost', castIds: ['cast:coworker-a'], placeIds: ['place:office'] };
  dreamStore.insertDream({ eventId: ev.id, sleepEventId: ev.causeId, night: '2026-01-01', at: ev.at, recall: 'vivid', tone: 'flat', plan: p, text: plan.vividTemplate(p), needsWords: true }, clock.now());
  return ev;
};
{
  calls.length = 0;
  const e1 = vivid();
  const tpl = dreamStore.byEvent(e1.id).text;
  await story.runDreamsNow();
  eq('one call', calls.length, 1);
  eq('role and caller', [cr.calls.at(-1).role, cr.calls.at(-1).caller], ['clerk', 'life.dream']);
  check('only the plan goes in: fictional names and kind words', calls[0].user.includes('the office') && calls[0].user.includes('Coworker') && !/@|whatsapp|Quinn/.test(calls[0].user));
  eq('its words now', dreamStore.byEvent(e1.id).tier, 'clerk');
  check('replacing the template', dreamStore.byEvent(e1.id).text !== tpl);

  calls.length = 0;
  const e2 = vivid();
  await story.runDreamsNow();
  eq('a second that night: no call', calls.length, 0);
  eq('it keeps the template', dreamStore.byEvent(e2.id).tier, 'code');
  check('…with words', dreamStore.byEvent(e2.id).text.length > 10);
}

section('budget stop, ledger failure, a bad answer: the template stays');
{
  const next = async () => { clock.advance({ days: 1 }); await simulateHours(0.25); await story.idle(); };
  await next();
  calls.length = 0;
  const cap = config.arcs.dreamBudgetUsd;
  config.arcs.dreamBudgetUsd = 0;
  const e1 = vivid();
  await story.runDreamsNow();
  eq('over budget: no call', calls.length, 0);
  eq('template', dreamStore.byEvent(e1.id).tier, 'code');
  config.arcs.dreamBudgetUsd = cap;

  await next();
  story.__setDepsForTest({ ...deps, getUsageByCaller: () => { throw new Error('ledger'); } });
  const e2 = vivid();
  await story.runDreamsNow();
  eq('an unreadable ledger fails closed', [calls.length, dreamStore.byEvent(e2.id).tier], [0, 'code']);
  story.__setDepsForTest(deps);

  await next();
  dreamAnswer = () => JSON.stringify({ text: 'He was at the office and there was blood across the whole floor of it, everywhere.' });
  const e3 = vivid();
  await story.runDreamsNow();
  eq('a graphic answer is refused', [calls.length, dreamStore.byEvent(e3.id).tier], [1, 'code']);
  check('…and not kept', !/blood/.test(dreamStore.byEvent(e3.id).text));
  dreamAnswer = () => 'not json';
  await next();
  const e4 = vivid();
  await story.runDreamsNow();
  eq('nonsense: template', dreamStore.byEvent(e4.id).tier, 'code');
  dreamAnswer = () => JSON.stringify({ text: 'He was at the office with Coworker, and all the clocks said something different. Then it was a park.' });
}

section('the mood: a small nudge, gone by midday, nothing left in his vitals');
{
  const t0 = at(1, 8);
  const noon = at(1, 12);
  const state = { story: { dream: { at: t0, until: noon, dv: -0.05, ds: 3, tone: 'nightmare' } } };
  const v = { mood: { valence: 0.2, arousal: 0.4 }, stress: 30, energy: 70, socialBattery: 50 };
  const atWake = withChatMood(v, state, t0);
  check('dented at his wake', atWake.mood.valence < 0.2 && atWake.mood.valence >= 0.149, atWake.mood);
  check('more stress', atWake.stress > 30 && atWake.stress <= 33.01, atWake.stress);
  const half = withChatMood(v, state, t0 + 2 * HOUR);
  check('fading', half.mood.valence > atWake.mood.valence && half.mood.valence < 0.2);
  eq('gone at midday', withChatMood(v, state, noon).mood.valence, 0.2);
  eq('before it, nothing', withChatMood(v, state, t0 - 60).mood.valence, 0.2);
  eq('story-family decisions leave it out, as with chat mood', withChatMood(v, state, t0, { chatMood: false }).mood.valence, 0.2);
  eq('a neutral dream changes nothing', withChatMood(v, { story: { dream: { at: t0, until: noon, dv: 0, ds: 0 } } }, t0), v);
  eq('no dream, the same object', withChatMood(v, {}, t0), v);
}

section('echoes: the tail until about 14:00, the phone sheet only when warm or neutral, the journal');
{
  await stopLife();
  const t = at(1, 9);
  clock.advance({ seconds: t - clock.now() });
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  await simulateHours(0.25);
  const ev = vivid();
  const s = S();
  // Finding 19: a DM only, the first turn or two, until he has mentioned it; never a group.
  const dm = { kind: 'dm', chatJid: '15550000001@s.whatsapp.net' };
  const dm2 = { kind: 'dm', chatJid: '15550000002@s.whatsapp.net' };
  const group = { kind: 'group', chatJid: '120363000000099001@g.us' };
  const line = (aud, recentText = [], t = clock.now()) => story.dreamLine(s, t, { audience: aud, recentText });
  dreamWorker.__resetDreamLineForTest();
  eq('never in a group', line(group), '');
  const l1 = line(dm);
  check('this morning, a line in a DM', l1.startsWith('Last night you dreamt'), l1);
  check('the words as written, said to be his', l1.includes('"he" is you') && !/\byou was\b/i.test(l1));
  check('the second turn too', line(dm).startsWith('Last night'));
  eq('not a third', line(dm), '');
  check('another DM has its own two', line(dm2).startsWith('Last night'));
  eq('once he has mentioned it, nowhere that day', line(dm2, [{ text: 'had the weirdest dream last night', fromMe: true }]), '');
  eq('…in any DM', line({ kind: 'dm', chatJid: '15550000003@s.whatsapp.net' }), '');
  eq('someone else saying it doesn\'t count, but it has been told', line(dm2, [{ text: 'dream on', fromMe: false }]), '');
  dreamWorker.__resetDreamLineForTest();
  eq('someone else saying the word doesn\'t stop it', line(dm, [{ text: 'dream on', fromMe: false }]).startsWith('Last night'), true);
  eq('not after about 14:00', line(dm2, [], at(0, 14, 1)), '');
  eq('not the next day', line(dm2, [], at(1, 9)), '');
  const row = { castId: 'cast:coworker-a', id: 1 };
  const close = (st) => { const n = { ...st, cast: new Map(st.cast) }; const c = n.cast.get(row.castId); n.cast.set(row.castId, { ...c, metrics: { ...c.metrics, closeness: 0.8 } }); return n; };
  const sheet = (side, st = close(s), first = true) => buildSheet(st, row, { tz: world.timezone, at: clock.now(), persona: {}, side, firstTurnToday: first }).sheet;
  // Finding 24.
  check('a neutral dream of someone close is on his side', /dream/.test(sheet('his').dreamt ?? ''), sheet('his').dreamt);
  check('…at most once, only if natural', /at most once, only if natural/.test(sheet('his').dreamt));
  check('not to someone he isn\'t close to', !('dreamt' in buildSheet({ ...s, cast: new Map([...s.cast].map(([k, c]) => [k, { ...c, metrics: { ...c.metrics, closeness: 0.2, passion: 0 } }])) }, row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his', firstTurnToday: true }).sheet));
  check('not on a later text of the thread that day', !('dreamt' in sheet('his', close(s), false)));
  check('…and the writer gets it', phoneRender(sheet('his')).includes('a dream:'));
  check('never the other side', !('dreamt' in sheet('cast')));
  check('never an explicit sheet', !('dreamt' in buildSheet(close(s), row, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his', register: 'explicit', firstTurnToday: true }).sheet));
  const scared = { ...s, story: { ...s.story, dream: { ...s.story.dream, tone: 'nightmare' } } };
  check('a nightmare stays to himself', !('dreamt' in sheet('his', close(scared))));
  const other = buildSheet(s, { castId: 'cast:flatmate', id: 2 }, { tz: world.timezone, at: clock.now(), persona: {}, side: 'his', firstTurnToday: true }).sheet;
  check('someone not in it: nothing', !('dreamt' in other));
  eq('the journal', bulletFor(ev, { state: s, tz: world.timezone }), 'He woke remembering an odd dream.');
  void dayStart;
}

section('a heavy stretch: no dream, and no text from one around it');
{
  const t = clock.now();
  const added = [];
  forceRecall();
  const h = appendEvent({ type: 'heavy.started', at: t, actor: 'engine', heavy: true, payload: { kind: 'loss', themeId: 'x', until: t + 3 * DAY } });
  story.__rebuildForTest();
  const sleepEv = eventsAfter(0, 500000).filter(e => e.type === 'sleep.started').at(-1);
  eq('no dream', dreamWorker.atDream(S(), { at: t + 8 * HOUR - 8 * HOUR, add: (e) => { added.push(e); return { id: 1, ...e }; }, sleepEventId: sleepEv.id, startedAt: t - 7 * HOUR }), null);
  eq('nothing added', added.length, 0);
  dreamWorker.__resetDreamLineForTest();
  eq('and this morning\'s dream, from before it, stays out of his replies', story.dreamLine(S(), clock.now(), { audience: { kind: 'dm', chatJid: 'x' } }), '');
  // Finding 5: the strongest thing of the day leads the dream, unless it's from around a heavy stretch. Same dream, three ways.
  const lead = (when, payload, heavyAt) => {
    const sc = appendEvent({ type: 'scene.played', at: when, actor: 'engine', causeId: eventsAfter(0, 500000).filter(e => e.type === 'activity.started').at(-1).id, payload: { outcome: 'badly', mode: 'full', placeId: 'place:cinema', castIds: ['cast:sibling'], activityEventId: 1, ...payload } });
    dreamWorker.configure({ heavyAt });
    const id = 900100 + sc.id;
    const ev2 = dreamWorker.atDream({ ...S(), story: { ...S().story, dream: null } }, { at: t, add: (e) => ({ id, ...e }), sleepEventId: sleepEv.id, startedAt: t - 7 * HOUR });
    const first = ev2 ? dreamStore.byEvent(id)?.plan?.scenes?.[0] : null;
    dreamStore.sweep((x) => x === id);
    return first;
  };
  // Each is later than the one before, so unfiltered it would lead (ties in charge go to the newest).
  eq('a plain bad evening leads the dream', lead(t - 9 * HOUR, {}, () => false)?.castId, 'cast:sibling');
  eq('a later one takes over: the control', lead(t - 8.8 * HOUR, { castIds: ['cast:coworker-b'], placeId: 'place:park' }, () => false)?.castId, 'cast:coworker-b');
  const flagged = lead(t - 8 * HOUR, { heavyWindow: true, castIds: ['cast:parent'], placeId: 'place:gym' }, () => false);
  eq('marked as from around a stretch: it doesn\'t lead', flagged?.castId, 'cast:coworker-b');
  const when = t - 7.6 * HOUR;   // newer than the control, in another hour from it and from his sleep start
  const inWindow = (st, x) => Math.floor(x / HOUR) === Math.floor(when / HOUR);
  const windowed = lead(when, { castIds: ['cast:flatmate'], placeId: 'place:restaurant' }, inWindow);
  eq('from inside a window, by its time alone: it doesn\'t lead', windowed?.castId, 'cast:coworker-b');
  void h;
  naturalRecall();
}

section('a rewind across it: the words go, and the mood');
{
  await stopLife();
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  const last = dreams().at(-1);
  await simulateHours(1);
  const first = eventsAfter(0, 500000).filter(e => e.type === 'vitals.checkpoint' && e.at < last.at).at(-1);
  const pv = await director.preview({ kind: 'rewind', toEventId: first.id, reason: 'test' });
  check('previews', !pv.refusals?.length, pv.refusals);
  await director.apply(pv.previewId, pv.fingerprint);
  await story.idle();
  await story.runDreamsNow();
  const row = dreamStore.byEvent(last.id);
  eq('its row is reverted, no words', [row.status, row.text], ['reverted', null]);
  check('the state forgot it, so no mood and no line', S().story?.dream?.eventId !== last.id, S().story?.dream);
  check('not listed', !dreamStore.listDreams().some(d => d.eventId === last.id));
}

section('finding 3: the Mind page really gets them, behind the story gate');
{
  const { default: Fastify } = await import('fastify');
  const routes = await import('../../src/dashboard/routes/arcs.js');
  const app = Fastify();
  const register = routes.registerArcsRoutes ?? routes.default ?? routes.arcsRoutes;
  await register(app);
  const ev = vivid();
  const r = await app.inject({ method: 'GET', url: '/api/arcs/dreams' });
  const body = JSON.parse(r.body);
  check('a stored dream appears', r.statusCode === 200 && body.enabled === true && body.dreams.some(d => d.text === dreamStore.byEvent(ev.id).text), body);
  const skills = await import('../../src/skills/skillRunner.js');
  skills.setSkillEnabled('arcs', false);
  const off = JSON.parse((await app.inject({ method: 'GET', url: '/api/arcs/dreams' })).body);
  eq('with arcs off: nothing', [off.enabled, off.dreams], [false, []]);
  skills.setSkillEnabled('arcs', true);
  await app.close();
}

section('downtime over a whole night: no dream back-dated');
{
  const n = dreams().length;
  await stopLife();
  clock.advance({ hours: 26 });
  forceRecall();
  ({ life } = await bootLife({ world, clock, callRole: cr }));
  story.__setDepsForTest(deps);
  forceRecall();
  dreamWorker.configure({ heavyAt: () => false });   // only the downtime rule can stop it here
  await simulateHours(0.25);
  await story.idle();
  const woke = eventsAfter(0, 500000).filter(e => e.type === 'woke').at(-1);
  check('he woke in the replay', woke && clock.now() - woke.at > 2 * HOUR, woke && (clock.now() - woke.at) / 3600);
  eq('and remembers nothing of it', dreams().length, n);
  naturalRecall();
}

section('someone who left stays out; a sim has none');
{
  const s = S();
  const gone = { ...s, story: { ...s.story, departed: { 'cast:flatmate': { name: 'Flatmate' } } } };
  const added = [];
  forceRecall();
  const sleepEv = eventsAfter(0, 500000).filter(e => e.type === 'sleep.started').at(-1);
  const wakeAt = clock.now();
  // Only the worker's view of who's there changes: he was with them that day.
  const quiet = { ...gone, story: { ...gone.story, dream: null } };
  dreamWorker.configure({ heavyAt: () => false });
  const ev = dreamWorker.atDream(quiet, { at: wakeAt, add: (e) => { added.push(e); return { id: 900001, ...e }; }, sleepEventId: sleepEv.id, startedAt: wakeAt - 7 * HOUR });
  check('a dream', !!ev);
  check('without them', !added[0].payload.castIds.includes('cast:flatmate'), added[0].payload.castIds);
  naturalRecall();
  dreamStore.sweep((id) => id === 900001);
  // Appended last: it folds, so he'd be "asleep" for the sections above.
  forceRecall();
  const chat = appendEvent({ type: 'sleep.started', at: clock.now(), actor: 'engine', originKind: 'group', originJid: '120363000000099001@g.us', payload: { until: clock.now() + HOUR } });
  eq('a night a chat shaped: none', dreamWorker.atDream(quiet, { at: wakeAt + 1, add: (e) => { added.push(e); return { id: 900002, ...e }; }, sleepEventId: chat.id, startedAt: wakeAt - 7 * HOUR }), null);
  story.__rebuildForTest();
  naturalRecall();
  const n = dreams().length;
  const last = lastEventId();
  await story.simulate({ now: clock.now(), hours: 36 });
  eq('a sim appends none', [dreams().length, lastEventId()], [n, last]);
}

section('guards');
{
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
  const importers = walk('src').filter(f => !f.includes('/story/dreams/') && /from '[^']*dreams\/(worker|store|plan)\.js'/.test(fs.readFileSync(f, 'utf8')));
  eq('only the story facade imports the dreams', importers, ['src/life/story/index.js']);
  const pulse = fs.readFileSync('src/life/pulse.js', 'utf8');
  check('finding 10, 23: the evening proposal leans', pulse.includes('r.weighted(leanedLeisure(items))'));
  const src = ['plan', 'worker', 'store'].map(f => fs.readFileSync(`src/life/story/dreams/${f}.js`, 'utf8')).join('\n');
  check('no chat or memory reads', !/memory\/(recall|messageStore|relationshipStore|peopleStore)|getRecentMessages/.test(src));
  check('logs carry codes only', !/log\(\{[^}]*\b(text|plan|names?)\b/.test(src));
  check('heavy events are filtered in what he dreams of', src.includes('e.heavy !== true') && src.includes('!e.subjectJid'));
}

section('thirty nights, from the top: about one to three a week, none repeating, in his own day');
{
  await stopLife();
  const fresh = await bootLife({ world, clock, callRole: cr });
  story.__setDepsForTest(deps);
  config.arcs.scenesEnabled = true;
  dreamWorker.configure({ heavyAt: (s, t) => false });
  dreamAnswer = () => 'not json';   // the templates: a stub's one answer would repeat by itself
  const before = dreams().length;
  const t0 = clock.now();
  await simulateDays(30, { stepMinutes: 30 });
  await story.idle();
  const rows = dreamStore.listDreams({ limit: 200 }).filter(d => d.at > t0);
  const perWeek = rows.length / 30 * 7;
  check('about one to three a week', perWeek >= 1 && perWeek <= 3.5, perWeek);
  eq('one event per row', dreams().length - before, rows.length);
  const texts = rows.map(d => d.text);
  eq('none repeating', new Set(texts).size, texts.length);
  const places = new Set(rows.flatMap(d => d.plan.scenes.map(x => x.place)));
  check('not all in one place', places.size >= 3, [...places]);
  check('only his own names', rows.every(d => !/@|whatsapp/.test(d.text)));
  void fresh;
}

await stopLife();
report();
