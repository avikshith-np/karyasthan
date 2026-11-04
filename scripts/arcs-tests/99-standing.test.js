// Plan 020 D2: how things stand with each fictional member. Rebuilt at night only for who changed, caps and budget fail closed, old versions
// invalidated and never edited; revert, rewind and heavy windows; venue words, invented names and day words; the writers' sheets, their caps, the as-of read.
// Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { appendEvent, listEvents, lastEventId } from '../../src/life/eventLog.js';
import { dateKey, dayLabel, dayStart, addDays, zonedToUnix, resolveTimezone } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as store from '../../src/life/story/standing/store.js';
import * as worker from '../../src/life/story/standing/worker.js';
import { validateStanding, renderUser as standingUser, STANDING_CHARTER, CALLER } from '../../src/life/story/standing/charter.js';
import { linesFor, changedEnough, CAPS } from '../../src/life/story/standing/facts.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import * as phoneWorker from '../../src/life/story/phone/worker.js';
import { buildSheet } from '../../src/life/story/phone/facts.js';
import { renderUser as phoneRender, RENDER_MAX as PHONE_MAX } from '../../src/life/story/phone/charter.js';
import { renderUser as sceneRender, RENDER_MAX as SCENE_MAX } from '../../src/life/story/scenes/charter.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import * as sleep from '../../src/mind/sleep.js';
import { buildStanding } from '../../src/public/build.js';
import { config } from '../../src/utils/config.js';
import fs from 'fs';

await setupScratchDb();

// The helpers turn it off for every other suite, which counts its own model calls. Here it's on, as it ships.
config.arcs.standingEnabled = true;
check('it ships on: only the test helpers turn it off', /\['arcs\.standingEnabled', 'ARCS_STANDING_ENABLED', 'bool', true,/.test(fs.readFileSync('src/utils/config.js', 'utf8')));

const NOTE = 'They have been easy with each other lately. He trusts them, and the talks at the cafe have gone well.';
let answer = () => JSON.stringify({ standing: NOTE });
const sceneJson = () => JSON.stringify({
  narration: 'They sat for a long while at the cafe and talked about the week, the rain and an old plan to go away somewhere. By the second coffee the talk had gone easy and neither of them was looking at the time at all.',
  impressions: { him: [], them: [] }, topics: ['the week'], highlight: 'the second coffee', awkward: null, chemistry: 0.3, focus: 'P1', ending: 'plan_to_meet', effects: [],
});
const cr = fakeCallRole({
  [CALLER]: (...a) => answer(...a),
  'life.scene.mind': sceneJson, 'life.scene.clerk': sceneJson,
  'life.phone.his': () => JSON.stringify({ messages: ['how was the rest of your week'], tone: 'warm', topic: 'the week', end: false }),
  'life.phone.mind': () => JSON.stringify({ messages: ['how was the rest of your week'], tone: 'warm', topic: 'the week', end: false }),
  'life.phone.cast': () => JSON.stringify({ messages: ['long, good though'], tone: 'warm', topic: 'the week', end: true }),
  'life.phone.plan': () => JSON.stringify({ agreed: false, kind: 'outing', placeHint: null, when: null, day: null, minutes: null, confidence: 0.1 }),
});
const { life, clock, world } = await bootLife({ callRole: cr });
let usage = [];
let known = ['Rowan Vale', 'Rowan'];
story.__setDepsForTest({ getUsageByCaller: () => usage, mindBudgetOk: async () => ({ ok: false }), knownNames: () => known, identity: async () => 'You are an example.' });
config.arcs.phoneOrganicPerDay = 0;
config.arcs.standingMaxPerNight = 8;
const tz = resolveTimezone(world.timezone ?? config.timezone);
const FLAT = 'cast:flatmate';
const SIB = 'cast:sibling';
const pass = (o = {}) => story.standingPass({ nightKey: dateKey(clock.now(), tz), ...o });
const callsNow = () => cr.callsFor(CALLER).length;
const beat = (castId, text, at = clock.now()) => appendEvent({ type: 'cast.beat', at, actor: 'engine', payload: { castId, kind: 'news', text } });
const at = (day0, h, m = 0) => { const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number); return zonedToUnix(y, mo, d, h, m, tz); };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 15 }); };

await simulateHours(1);
await story.idle();

section('nothing yet: no call, no row, the sheets as they are');
{
  const r = await pass();
  eq('done with no candidates', [r.status, r.candidates], ['done', 0]);
  eq('no call', callsNow(), 0);
  eq('no version', store.allLive().length, 0);
  eq('no note for anyone', worker.view(FLAT).current, null);
  eq('the dashboard reads empty', worker.view(FLAT).versions, []);
}

section('someone with nothing recent: no call. Drift is not news, and one text can wait');
{
  appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'engine', payload: { castId: FLAT, delta: { closeness: 0.01 }, reason: 'daily' } });
  appendEvent({ type: 'relationship.changed', at: clock.now(), actor: 'engine', payload: { castId: FLAT, delta: { closeness: 0.05 }, reason: 'daily' } });
  const r = await pass();
  eq('daily drift, however big: no candidate', r.candidates, 0);
  eq('still no call', callsNow(), 0);
  const base = { tz, isOut: () => false, heavyChain: () => false, heavyWindows: [], folds: new Map(), venueNames: [], arcOf: () => null, sceneRow: () => null, textRow: (id) => ({ eventId: id, status: 'live', text: 'hey' }) };
  const one = linesFor([{ id: 5, type: 'phone.message', at: clock.now(), originKind: 'self', payload: { castId: FLAT, dir: 'in' } }], { ...base, castId: FLAT, name: 'F' });
  check('one text is not enough', !changedEnough(one));
  const two = linesFor([5, 6].map(id => ({ id, type: 'phone.message', at: clock.now(), originKind: 'self', payload: { castId: FLAT, dir: 'in' } })), { ...base, castId: FLAT, name: 'F' });
  check('two are', changedEnough(two));
}

section('a beat: one small clerk call, under its own caller; a version with evidence');
let first = null;
{
  const b = beat(FLAT, 'started a pottery class');
  const r = await pass();
  eq('one rebuilt', r.results, [{ castId: FLAT, outcome: 'written' }]);
  const c = cr.callsFor(CALLER)[0];
  eq('role and caller', [c.role, c.caller], ['clerk', 'mind.standing']);
  check('small', c.user.length < 2000 && c.opts.maxTokens <= 500, c.user.length);
  check('the beat is on its input, fenced', c.user.includes('started a pottery class') && c.user.includes('STORY_DATA'));
  check('says it is the first note', c.user.includes('first note'));
  check('the charter names the rules', STANDING_CHARTER.includes('600') && STANDING_CHARTER.includes('day words'));
  first = store.live(FLAT);
  eq('the text', first.text, NOTE);
  eq('live, open-ended', [first.status, first.validTo, first.supersedes], ['live', null, null]);
  eq('evidence: that event', store.evidenceOf([first.id]).get(first.id).map(e => e.eventId), [b.id]);
  eq('…nothing new, no second call', [(await pass()).candidates, callsNow()], [0, 1]);
}

section('something new: the previous note goes in, the old version closes, its text untouched');
{
  await simulateHours(1);
  const b2 = beat(FLAT, 'got a kitten');
  answer = () => JSON.stringify({ standing: 'They are still easy with each other, and there is a kitten now.' });
  await pass();
  const c = cr.callsFor(CALLER).at(-1);
  check('built on the previous note', c.user.includes('HOW THINGS STOOD') && c.user.includes(NOTE));
  check('only what is new', c.user.includes('got a kitten') && !c.user.includes('pottery'));
  const old = store.get(first.id);
  eq('the old one closed', old.status, 'superseded');
  check('…with its end, text unchanged', Number.isFinite(old.validTo) && old.text === NOTE);
  const cur = store.live(FLAT);
  eq('the new one supersedes it', cur.supersedes, first.id);
  eq('its evidence is its own', store.evidenceOf([cur.id]).get(cur.id).map(e => e.eventId), [b2.id]);
}

section('the as-of read: the note that held then, never a later one');
{
  const cur = store.live(FLAT);
  const s = life.getState();
  eq('at a time before any note: none', worker.noteAt(s, FLAT, first.validFrom - 1), null);
  if (first.validFrom < cur.validFrom) eq('between the two: the first', worker.noteAt(s, FLAT, cur.validFrom - 1)?.versionId, first.id);
  eq('now: the newest', worker.noteAt(s, FLAT, clock.now())?.versionId, cur.id);
}

section('validation: venues, invented names, day words, real names, length, shape, explicit');
{
  const ctx = { names: ['Asha Quill', 'the cafe', 'Bina'], knownNames: ['Rowan Vale'], castNames: ['Asha Quill', 'Bina Moss'], venueNames: [{ name: 'Blue Tokai', kind: 'cafe' }] };
  const v = (t) => validateStanding(JSON.stringify({ standing: t }), ctx);
  eq('a venue name → its kind word', v('They keep going to Blue Tokai and Asha likes it.').text, 'They keep going to a cafe and Asha likes it.');
  const inv = v('Asha told Gerald all about it.');
  eq('an invented name → a second try', [inv.ok, inv.reason, inv.retry, inv.word], [false, 'invented_name', true, 'gerald']);
  const dw = v('They met yesterday and it went well.');
  eq('a day word → a second try', [dw.ok, dw.reason, dw.retry], [false, 'day_word', true]);
  const real = v('They talked about Rowan Vale a lot.');
  eq('a real person → kept out, no second try', [real.ok, real.reason, real.retry], [false, 'real_name', false]);
  eq('an identifier', v('Ask 15550001001@s.whatsapp.net about it.').ok, false);
  eq('a link', v('See https://example.com for it.').ok, false);
  const long = 'They talk most days and it has been easy. '.repeat(30);
  const cut = v(long);
  check('over 600: cut at a sentence', cut.ok && cut.text.length <= 600 && cut.text.endsWith('.'), cut.text?.length);
  eq('not JSON', validateStanding('just words', ctx).reason, 'bad_json');
  eq('an extra key', validateStanding(JSON.stringify({ standing: 'Fine.', x: 1 }), ctx).reason, 'bad_shape');
  eq('empty', v('  ').ok, false);
  eq('names in the input are fine', v('Bina and Asha are close.').ok, true);
}

section('an invented name: one more try, then the old one stays');
{
  const before = store.live(FLAT);
  await simulateHours(1);
  const b = beat(FLAT, 'moved desks');
  let n = 0;
  answer = (_, user) => { n++; return n === 1 ? JSON.stringify({ standing: 'Things are good, and Gerald helped.' }) : JSON.stringify({ standing: 'Things are good.' }); };
  const r = await pass();
  eq('the second try lands', r.results[0].outcome, 'written');
  check('it was told why', /gerald/i.test(cr.callsFor(CALLER).at(-1).user));
  eq('two calls', n, 2);
  check('the new one supersedes', store.live(FLAT).supersedes === before.id && store.evidenceOf([store.live(FLAT).id]).get(store.live(FLAT).id)[0].eventId === b.id);
  await simulateHours(1);
  beat(FLAT, 'moved desks again');
  const keep = store.live(FLAT);
  n = 0;
  answer = () => { n++; return JSON.stringify({ standing: 'Things are good, and Gerald helped.' }); };
  const r2 = await pass();
  eq('twice: refused', r2.results[0].outcome, 'refused_invented_name');
  eq('…two calls only', n, 2);
  eq('…the old version stays live', store.live(FLAT).id, keep.id);
  n = 0;
  answer = () => { n++; return JSON.stringify({ standing: 'Rowan Vale came up a lot.' }); };
  const r3 = await pass();
  eq('a real name: refused at once', [r3.results[0].outcome, n], ['refused_real_name', 1]);
  eq('…the old version stays', store.live(FLAT).id, keep.id);
  answer = () => 'not json';
  eq('bad output: the old version stays', [(await pass()).results[0].outcome, store.live(FLAT).id], ['refused_bad_json', keep.id]);
  answer = () => { throw new Error('boom'); };
  eq('a failed call: the old version stays', [(await pass()).results[0].outcome, store.live(FLAT).id], ['model_failed', keep.id]);
  answer = () => JSON.stringify({ standing: NOTE });
}

section('budget stops: the old version stays, no call');
{
  const keep = store.live(FLAT);
  const n = callsNow();
  eq('the mind budget object', (await pass({ budgetOk: { ok: false, reason: 'global_cap' } })).reason, 'budget');
  usage = [{ caller: CALLER, calls: 1, costUsd: 5 }];
  eq('the month cap', (await pass()).results[0].outcome, 'budget');
  usage = [{ caller: CALLER, calls: 100, costUsd: 0 }];
  eq('the day cap', (await pass()).results[0].outcome, 'day_cap');
  usage = [];
  story.__setDepsForTest({ getUsageByCaller: () => { throw new Error('ledger'); } });
  eq('ledger unreadable: fails closed', (await pass()).results[0].outcome, 'ledger');
  story.__setDepsForTest({ getUsageByCaller: () => usage });
  eq('the mind clerk cap', (await pass({ clerkLeft: () => false })).results[0].outcome, 'clerk_cap');
  story.__setDepsForTest({ knownNames: () => { throw new Error('names'); } });
  eq('real names unreadable: fails closed', (await pass()).reason, 'names_unavailable');
  story.__setDepsForTest({ knownNames: () => known });
  eq('a role over budget (skipped)', (await pass({ call: async () => ({ ok: false, skipped: true }) })).results[0].outcome, 'skipped');
  eq('no call and the old version through all of it', [callsNow(), store.live(FLAT).id], [n, keep.id]);
  config.arcs.standingEnabled = false;
  eq('switched off', (await pass()).reason, 'disabled');
  eq('…and the sheets read nothing', worker.noteAt(life.getState(), FLAT, clock.now()), null);
  config.arcs.standingEnabled = true;
}

section('first night across the whole cast: the caps share it out over nights');
{
  for (const c of life.getState().cast.values()) beat(c.id, 'had some news');
  config.arcs.standingMaxPerNight = 4;
  const before = callsNow();
  const r = await pass();
  const written = r.results.filter(x => x.outcome === 'written').map(x => x.castId);
  eq('four tonight', written.length, 4);
  eq('the rest wait', r.results.filter(x => x.outcome === 'night_cap').length, r.candidates - 4);
  eq('four calls', callsNow() - before, 4);
  await simulateHours(24);
  const r2 = await pass();
  check('tomorrow the rest', r2.results.filter(x => x.outcome === 'written').length >= r.candidates - 4, r2.results);
  const rr = life.getState();
  check('all of them have a note now', [...rr.cast.keys()].every(id => store.live(id)), store.allLive().length);
  config.arcs.standingMaxPerNight = 8;
}

section('revert: a version whose evidence left is invalidated at once for the writers, and rebuilt at night');
{
  const b1 = beat(SIB, 'passed the exam');
  await pass();
  const v1 = store.live(SIB);
  await simulateHours(1);
  const b2 = beat(SIB, 'found a flat');
  await pass();
  const v2 = store.live(SIB);
  check('built on the last', v2.supersedes === v1.id);
  const res = life.revertEvent(b2.id, { reason: 'test' });
  check('the owner reverted it', Number.isSafeInteger(res.revertEventId), JSON.stringify(res));
  const s = life.getState();
  eq('the sheet reads none at once, before any sweep', worker.noteAt(s, SIB, clock.now()), null);
  check('the site rows drop it at once too', !story.publicStanding().some(x => x.castId === SIB), story.publicStanding().map(x => x.castId));
  worker.sweep(s);
  const gone = store.get(v2.id);
  eq('invalidated', [gone.status, gone.invalidReason], ['invalidated', 'evidence_gone']);
  check('its text kept, never edited', gone.text === v2.text && Number.isFinite(gone.validTo));
  eq('no live row', store.live(SIB), null);
  const n = callsNow();
  const r = await pass();
  eq('nothing else new: what stood before stands again, with no call', [r.results.find(x => x.castId === SIB)?.outcome, callsNow()], ['restored', n]);
  const back = store.live(SIB);
  eq('…word for word', [back.text, back.supersedes], [v1.text, v1.id]);
  eq('readable again', worker.noteAt(life.getState(), SIB, clock.now())?.versionId, back.id);
  eq('…and the site has the one that stands', story.publicStanding().find(x => x.castId === SIB)?.text, v1.text);
  void b1;
}

section('evidence gone deep in the chain: everything built on it goes, and it rebuilds from what is clean');
{
  const CO = 'cast:coworker-a';
  const v0 = store.live(CO);
  await simulateHours(1);
  const b1 = beat(CO, 'got promoted');
  await pass();
  const v1 = store.live(CO);
  await simulateHours(1);
  beat(CO, 'bought a bike');
  await pass();
  const v2 = store.live(CO);
  life.revertEvent(b1.id, { reason: 'test' });
  worker.sweep(life.getState());
  eq('the one that read it', store.get(v1.id).status, 'invalidated');
  eq('the one built on it', [store.get(v2.id).status, store.get(v2.id).invalidReason], ['invalidated', 'built_on_gone']);
  answer = () => JSON.stringify({ standing: 'A bike came up, and they get along.' });
  await pass();
  const v3 = store.live(CO);
  const u = cr.callsFor(CALLER).at(-1).user;
  check('rebuilt from the last clean version', store.get(v3.supersedes).supersedes === v0.id && store.get(v3.supersedes).text === v0.text && u.includes(v0.text));
  check('…with what is still in his life, not what left', u.includes('bought a bike') && !u.includes('got promoted'));
  answer = () => JSON.stringify({ standing: NOTE });
}

section('a rewind across a rebuild');
{
  const CO = 'cast:coworker-b';
  const v0 = store.live(CO);
  await simulateHours(2);
  const lastBefore = listEvents({ types: ['activity.started', 'activity.ended', 'plan.made'], order: 'desc', limit: 1 })[0]?.id;
  await simulateHours(2);
  beat(CO, 'quit smoking');
  await pass();
  const v1 = store.live(CO);
  check('rebuilt after the rewind point', v1.id !== v0.id && v1.asOfEventId > lastBefore);
  const pv = await story.director.preview({ kind: 'rewind', toEventId: lastBefore, reason: 'test' });
  check('the rewind previews', !pv.refusals?.length, JSON.stringify(pv.refusals));
  const ap = await story.director.apply(pv.previewId, pv.fingerprint);
  check('…and applies', ap?.ok === true, JSON.stringify(ap));
  const s = life.getState();
  eq('the rebuilt one reads as gone at once', worker.noteAt(s, CO, clock.now()), null);
  worker.sweep(s);
  eq('invalidated, as rewound', [store.get(v1.id).status, store.get(v1.id).invalidReason], ['invalidated', 'rewound']);
  const n = callsNow();
  const r = await pass();
  eq('what stood before stands, no call: the beat went with the rewind', [r.results.find(x => x.castId === CO)?.outcome, callsNow()], ['restored', n]);
  eq('…with the old words', store.live(CO).text, v0.text);
  check('nothing past the rewind is its evidence', store.evidenceOf([store.live(CO).id]).get(store.live(CO).id).length === 0);
}

section('a budget stop after an undo: what stood before stands again, with no call');
{
  const CO = 'cast:coworker-b';
  const v0 = store.live(CO);
  await simulateHours(1);
  const b = beat(CO, 'took up running');
  await pass();
  await simulateHours(1);
  const v1 = store.live(CO);
  beat(CO, 'ran a race');
  life.revertEvent(b.id, { reason: 'test' });
  worker.sweep(life.getState());
  eq('undone', store.get(v1.id).status, 'invalidated');
  const n = callsNow();
  const r = await pass({ budgetOk: { ok: false } });
  eq('stopped', r.reason, 'budget');
  eq('…with the clean one back and no call', [store.live(CO).text, callsNow()], [v0.text, n]);
  // Review 10: old words on a new row. The label says how old the words are.
  await simulateHours(30);
  const note = worker.noteAt(life.getState(), CO, clock.now());
  check('as of its real as-of, not the new row', note.asOfAt < note.validFrom && note.asOfAt <= v0.validFrom, note);
  eq('…on his side of the phone', phoneWorker.memoryFor(life.getState(), CO, clock.now(), tz, 'his').standing.asOf, dayLabel(note.asOfAt, tz));
  const lastNote = buildFactSheet(life.getState(), { mode: 'full', kind: 'hangout', placeId: 'place:cafe', castIds: [CO], startAt: clock.now() - HOUR, endAt: clock.now(), minutes: 60, activityEventId: lastEventId() },
    { tz, place: 'the cafe', persona: { displayName: 'Him' }, outcome: { value: 'well' }, vitals: {}, standing: { [CO]: note } });
  eq('…and on a scene\'s', lastNote.sheet.people[0].standing.asOf, dayLabel(note.asOfAt, tz));
  check('the labels differ from the row\'s day', dayLabel(note.asOfAt, tz) !== dayLabel(clock.now(), tz));
  check('…and the newer beat still to come', r.results.some(x => x.castId === CO && x.outcome === 'restored'));
  await pass();
  check('the next night builds on it, the new beat in, the undone one out', cr.callsFor(CALLER).at(-1).user.includes('ran a race') && !cr.callsFor(CALLER).at(-1).user.includes('took up running'));
}

section('a real outing and real texts: the words go in as words, venues as kind words, explicit words never');
let outing = null;
{
  const day = addDays(dayStart(clock.now(), tz), 1, tz);
  const startAt = at(day, 15, 0);
  // The shared past, dated long before any note (review 8), and news that the outing will overtake.
  const hp = await story.director.preview({ kind: 'cast.history', castId: FLAT, text: 'She lent him the deposit for his flat', dated: clock.now() - 200 * DAY }, { relax: true });
  check('a history line', (await story.director.apply(hp.previewId, hp.fingerprint))?.ok === true);
  beat(FLAT, 'planning the coffee');
  const p = await story.director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes: 90, castIds: [FLAT], label: 'coffee catch-up' }, { relax: true });
  const a = await story.director.apply(p.previewId, p.fingerprint);
  check('the outing is applied', a?.ok === true, JSON.stringify(a));
  await stepTo(startAt + 95 * 60);
  await story.idle(); await story.runScenesNow(); await story.idle();
  outing = listEvents({ types: ['scene.played'], from: startAt, limit: 10 })[0];
  check('its scene played', !!outing);
  const sceneCall = cr.calls.filter(c => c.caller?.startsWith('life.scene')).at(-1);
  check('the scene sheet carried the note that held when it began', sceneCall.user.includes('How things stood with P1') && sceneCall.user.includes(store.asOf(FLAT, startAt)?.text ?? '§'));
  check('with a note, the shared past is still on the scene\'s sheet: the note never read it', sceneCall.user.includes('deposit for his flat'), sceneCall.user.slice(0, 800));
  answer = () => JSON.stringify({ standing: 'Coffee went well and they said they would meet again.' });
  const pre = store.live(FLAT);
  beat(FLAT, 'a lasting new job');
  await pass();
  const u = cr.callsFor(CALLER).at(-1).user;
  check('a beat from before they last met is marked on the input', /planning the coffee \(before they last met\)/.test(u), u.slice(-500));
  check('…one since is not', u.includes('a lasting new job') && !/a lasting new job \(before/.test(u));
  check('…and the charter says what the mark means', /"before they last met" is over by now, unless it's a lasting change/.test(STANDING_CHARTER));
  check('the scene is on the input, in its words', u.includes('the second coffee') && u.includes('they said they would meet again'));
  check('evidence names it, as a scene', store.evidenceOf([store.live(FLAT).id]).get(store.live(FLAT).id).some(e => e.eventId === outing.id && e.source === 'scene'));
  check('built on the last one', store.live(FLAT).supersedes === pre.id);
  // The scene's as-of: a version written after the outing is not what it read.
  check('the as-of at its start is not the new one', store.asOf(FLAT, startAt)?.id !== store.live(FLAT).id);
  answer = () => JSON.stringify({ standing: NOTE });
}

section('an owner edit of the words behind a note: rebuilt the next night');
{
  const row = sceneStore.getByEvent(outing.id);
  const v = store.live(FLAT);
  story.sceneEditText(row.id, 'They sat in the cafe and nothing much was said, which suited them both.');
  worker.sweep(life.getState(), { deep: true });
  eq('invalidated', [store.get(v.id).status, store.get(v.id).invalidReason], ['invalidated', 'words_changed']);
  await pass();
  check('rebuilt, reading the edited words', cr.callsFor(CALLER).at(-1).user.includes('nothing much was said'));
}

section('explicit words never reach the clerk; a chat, a real person and a chat-made plan never count');
{
  const base = { tz, isOut: () => false, heavyChain: () => false, heavyWindows: [], folds: new Map(), venueNames: [{ name: 'Blue Tokai', kind: 'cafe' }], arcOf: () => null };
  const words = 'they had sex on the sofa';
  const texts = linesFor([{ id: 9, type: 'phone.message', at: clock.now(), originKind: 'self', payload: { castId: FLAT, dir: 'out' } }],
    { ...base, castId: FLAT, name: 'F', sceneRow: () => null, textRow: () => ({ status: 'live', text: words }) });
  check('an explicit text: a frame, no words', texts.lines.length === 1 && !texts.lines[0].text.includes('sex') && texts.lines[0].text.includes('private'), texts.lines);
  const scene = linesFor([{ id: 10, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { castIds: [FLAT], mode: 'full', outcome: 'well', heat: 'explicit' } }],
    { ...base, castId: FLAT, name: 'F', sceneRow: () => ({ status: 'done', text: 'A long and private night.', detail: { highlight: 'private' } }), textRow: () => null });
  check('an explicit scene: the frame only', scene.lines.length === 1 && !scene.lines[0].text.includes('A long and private night'), scene.lines);
  const reg = linesFor([{ id: 12, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { castIds: [FLAT], mode: 'full', outcome: 'well', heat: 'suggestive' } }],
    { ...base, castId: FLAT, name: 'F', sceneRow: () => ({ status: 'done', text: 'A long and quiet night.', sheet: { register: 'explicit' }, detail: {} }), textRow: () => null });
  check('a scene on the explicit register, whatever its heat word: the frame only', reg.lines.length === 1 && !reg.lines[0].text.includes('quiet night'), reg.lines);
  const venue = linesFor([{ id: 11, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { castIds: [FLAT], mode: 'full', outcome: 'well' } }],
    { ...base, castId: FLAT, name: 'F', sceneRow: () => ({ status: 'done', text: 'They went to Blue Tokai.', detail: {} }), textRow: () => null });
  check('a venue in a scene: its kind word', !venue.lines[0].text.includes('Blue Tokai') && venue.lines[0].text.includes('a cafe'), venue.lines);
  const others = [
    { id: 20, type: 'cast.beat', at: clock.now(), originKind: 'group', payload: { castId: FLAT, kind: 'news', text: 'from a chat' } },
    { id: 21, type: 'cast.beat', at: clock.now(), originKind: 'self', subjectJid: '1@s.whatsapp.net', payload: { castId: FLAT, kind: 'news', text: 'real person' } },
    { id: 22, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { castIds: [FLAT], mode: 'narration_only' } },
    { id: 23, type: 'scene.played', at: clock.now(), originKind: 'self', payload: { castIds: [FLAT], mode: 'full', heavyWindow: true } },
    { id: 24, type: 'cast.beat', at: clock.now(), originKind: 'self', heavy: true, payload: { castId: FLAT, kind: 'news', text: 'heavy' } },
    { id: 25, type: 'cast.beat', at: clock.now(), originKind: 'self', redacted: true, payload: { castId: FLAT, kind: 'news', text: 'redacted' } },
  ];
  eq('a chat, a real person, a chat outing, a heavy window, heavy, redacted: nothing', linesFor(others, { ...base, castId: FLAT, name: 'F', sceneRow: () => ({ status: 'done', text: 'x' }), textRow: () => null }).lines, []);
  const opened = { id: 30, type: 'decision.opened', at: clock.now(), originKind: 'self', payload: { invite: { pointerId: 1 }, subject: { castIds: [FLAT] }, options: [{ id: 'go', label: 'x' }] } };
  const commit = { id: 31, type: 'decision.committed', at: clock.now(), actor: 'engine', originKind: 'self', payload: { decisionId: 30, optionId: 'go', by: 'reply' } };
  const folds = new Map([[30, { id: 30, opened, commit, reversals: [], leans: [], final: { optionId: 'go', ev: commit } }]]);
  eq('a chat-made plan: nothing', linesFor([commit], { ...base, folds, castId: FLAT, name: 'F', sceneRow: () => null, textRow: () => null }).lines, []);
}

const siteRows = story.publicStanding();
let heavyAt = 0;
section('private turns (review 1, 12): the register decides, not a one-language word list. The markers stand in for words it would miss');
{
  const MARK = 'PLACEHOLDER-MIXED-SPEECH-ONE';
  const base = { tz, isOut: () => false, heavyChain: () => false, heavyWindows: [], folds: new Map(), venueNames: [], arcOf: () => null, sceneRow: () => null, textRow: () => ({ status: 'live', text: MARK }), castId: FLAT, name: 'F' };
  const lineOf = (payload) => linesFor([{ id: 60, type: 'phone.message', at: clock.now(), originKind: 'self', payload: { castId: FLAT, dir: 'out', ...payload } }], base).lines[0].text;
  for (const [label, p] of [
    ['the explicit register, a warm tone', { register: 'explicit', heat: 'suggestive', tone: 'warm' }],
    ['a naughty tone', { register: 'suggestive', heat: 'suggestive', tone: 'naughty' }],
    ['explicit heat', { register: 'tame', heat: 'explicit', tone: 'warm' }],
    ['an old row: no register, heat suggestive', { heat: 'suggestive', tone: 'warm' }],
  ]) {
    const l = lineOf(p);
    check(`${label}: private`, l.includes('(private)') && !l.includes(MARK), l);
  }
  for (const [label, p] of [
    ['a flirty text on the tame register', { register: 'tame', heat: 'suggestive', tone: 'flirty' }],
    ['a teasing one on the suggestive register', { register: 'suggestive', heat: 'suggestive', tone: 'teasing' }],
    ['an old row with no heat at all', { tone: 'warm' }],
  ]) check(`${label}: readable`, lineOf(p).includes(MARK));
  const ctx = { names: ['Asha Quill'], knownNames: [], castNames: ['Asha Quill'], venueNames: [] };
  const words = 'first placeholder second placeholder third placeholder fourth placeholder';
  const v = (t, privateWords = [words]) => validateStanding(JSON.stringify({ standing: t }), { ...ctx, privateWords });
  const echo = v('He keeps saying second placeholder third placeholder to Asha.');
  eq('the note repeating a private turn: refused, no second try', [echo.ok, echo.reason, echo.retry], [false, 'private_words', false]);
  check('…the words aren\'t handed back', !JSON.stringify(echo).includes('third'));
  eq('one word in common is nothing', v('He and Asha are second to none.').ok, true);
  eq('a short private turn, whole', v(`He keeps saying ${MARK} to Asha.`, [MARK]).reason, 'private_words');
  eq('a short ordinary one can\'t block a note', v('Yes, they are close.', ['yes']).ok, true);
  eq('no private turns: as before', v('They are close.', []).ok, true);
  // On the real pass: a stored turn on the explicit register, a clerk that echoes it.
  const SEC = 'cast:coworker-a';
  const keep = store.live(SEC);
  await simulateHours(1);
  const turn = (text, payload) => {
    const e = appendEvent({ type: 'phone.message', at: clock.now(), actor: 'engine', payload: { castId: SEC, castIds: [SEC], dir: 'out', msgId: 1, trigger: 'owner', exchange: 0, tone: 'warm', length: 1, bubbles: 1, textSha: 'x', ...payload } });
    const id = phoneStore.insertPending({ castId: SEC, dir: 'out', trigger: 'owner', triggerEventId: e.id, exchange: 0, dueAt: clock.now(), createdAt: clock.now() });
    phoneStore.update(id, { status: 'live', eventId: e.id, text, at: clock.now() });
    return e;
  };
  turn(`${MARK} one two three`, { register: 'explicit', heat: 'suggestive' });
  turn('how was the rest of your week', { register: 'tame', heat: 'tame' });
  answer = () => JSON.stringify({ standing: `They text a lot and he keeps saying ${MARK} one two to them.` });
  const r = await pass();
  const u = cr.callsFor(CALLER).at(-1).user;
  check('the clerk reads the tame one, not the other', u.includes('how was the rest') && !u.includes(MARK) && u.includes('(private)'), u.slice(-400));
  eq('an echo all the same: refused, the old version stays', [r.results.find(x => x.castId === SEC)?.outcome, store.live(SEC)?.id], ['refused_private_words', keep?.id]);
  answer = () => JSON.stringify({ standing: NOTE });
}

section('a base that goes while the clerk is thinking (review 7): no version on it, and old ones heal');
{
  const CO = 'cast:sibling';
  await simulateHours(1);
  const b0 = beat(CO, 'failed an exam');
  answer = () => JSON.stringify({ standing: 'They are fine.' });
  await pass();
  const v1 = store.live(CO);
  await simulateHours(1);
  beat(CO, 'retook it');
  answer = () => {
    life.revertEvent(b0.id, { reason: 'test' });
    worker.sweep(life.getState());
    return JSON.stringify({ standing: 'They are fine, and the exam is behind them.' });
  };
  const r = await pass();
  eq('the result is dropped', r.results.find(x => x.castId === CO)?.outcome, 'stale');
  eq('nothing was built on it', store.live(CO), null);
  eq('the base went', store.get(v1.id).status, 'invalidated');
  answer = () => JSON.stringify({ standing: 'Things are good.' });
  const n = cr.callsFor(CALLER).length;
  await pass();
  const again = cr.callsFor(CALLER).slice(n).at(-1)?.user ?? '';
  const live = store.live(CO);
  check('the next night writes a note the sheets can read', live && worker.noteAt(life.getState(), CO, clock.now())?.versionId === live.id, live);
  check('…from what is still in his life', again.includes('retook it') && !again.includes('failed an exam'), again.slice(-300));
  // A row an earlier build left behind: live on an invalidated version.
  const poison = store.addVersion({ castId: 'cast:coworker-b', text: 'Written on a version that had gone.', asOfEventId: lastEventId(), at: clock.now(), supersedes: v1.id, evidence: [] });
  worker.sweep(life.getState());
  eq('a poisoned row heals at the sweep', [store.get(poison).status, store.get(poison).invalidReason], ['invalidated', 'built_on_gone']);
  answer = () => JSON.stringify({ standing: NOTE });
}

section('heavy windows: what falls in one leaves, and a note resting on it goes');
{
  const base = { tz, isOut: () => false, heavyChain: () => false, folds: new Map(), venueNames: [], arcOf: () => null, sceneRow: () => null, textRow: () => null, castId: FLAT, name: 'F' };
  const b = { id: 40, type: 'cast.beat', at: 1000, originKind: 'self', payload: { castId: FLAT, kind: 'news', text: 'x' } };
  eq('inside a window: out', linesFor([b], { ...base, heavyWindows: [{ from: 900, to: 1100 }] }).lines.length, 0);
  eq('outside: in', linesFor([b], { ...base, heavyWindows: [{ from: 1001, to: 1100 }] }).lines.length, 1);
  eq('a heavy cause chain: out', linesFor([b], { ...base, heavyWindows: [], heavyChain: () => true }).lines.length, 0);
  const CO = 'cast:manager';
  await simulateHours(1);
  beat(CO, 'came back from leave');
  await pass();
  const v = store.live(CO);
  heavyAt = clock.now() + 3600;
  const h = appendEvent({ type: 'heavy.started', at: heavyAt, actor: 'engine', heavy: true, payload: { kind: 'loss', themeId: 'x', until: clock.now() + 3 * DAY } });
  await simulateHours(2);
  await story.idle();
  worker.sweep(life.getState());
  eq('a note written from days just before an onset goes', [store.get(v.id).status, store.get(v.id).invalidReason], ['invalidated', 'heavy_window']);
  void h;
}

section('a departed member: no call; their note stays to read, and no sheet gets it');
{
  const id = 'cast:parent';
  beat(id, 'came to visit');
  await pass();
  const v = store.live(id);
  check('has a note', !!v);
  const p = await story.director.preview({ kind: 'cast.depart', castId: id, how: 'moved_away' }, { relax: true });
  const a = await story.director.apply(p.previewId, p.fingerprint);
  check('they left', a?.ok === true, JSON.stringify(a ?? p.refusals));
  beat(id, 'sent a postcard');
  const n = callsNow();
  const r = await pass();
  check('no call for them', !r.results.some(x => x.castId === id) && callsNow() >= n, r.results);
  eq('the note unread by the sheets', worker.noteAt(life.getState(), id, clock.now()), null);
  eq('the dashboard still has it', worker.view(id).current?.id, v.id);
  eq('not on the site rows', story.publicStanding().some(x => x.castId === id), false);
}

section('a long-running romance: the call stays the same size, the note stays capped');
{
  const lines = [];
  const events = [];
  let id = 1000;
  for (let d = 0; d < 180; d++) {
    const t = clock.now() - (180 - d) * DAY;
    events.push({ id: id++, type: 'phone.message', at: t, originKind: 'self', payload: { castId: FLAT, dir: 'out' } });
    events.push({ id: id++, type: 'phone.message', at: t + 60, originKind: 'self', payload: { castId: FLAT, dir: 'in' } });
    if (d % 3 === 0) events.push({ id: id++, type: 'scene.played', at: t + 3600, originKind: 'self', payload: { castIds: [FLAT], mode: 'full', outcome: 'well', ending: 'stayed_late' } });
    if (d % 7 === 0) events.push({ id: id++, type: 'cast.beat', at: t + 7200, originKind: 'self', payload: { castId: FLAT, kind: 'news', text: 'x'.repeat(200) } });
    if (d % 30 === 0) events.push({ id: id++, type: 'arc.stage', at: t + 9000, originKind: 'self', payload: { arcId: 1, to: 'dating' } });
  }
  const r = linesFor(events, { tz, isOut: () => false, heavyChain: () => false, heavyWindows: [], folds: new Map(), venueNames: [], arcOf: () => ({ category: 'romance', castIds: [FLAT] }), castId: FLAT, name: 'F',
    sceneRow: () => ({ status: 'done', text: 'y '.repeat(1200), detail: { highlight: 'z' } }), textRow: () => ({ status: 'live', text: 'w '.repeat(300) }) });
  eq('each source held to its cap', [r.counts.text, r.counts.scene, r.counts.beat, r.counts.arc], [CAPS.text, CAPS.scene, CAPS.beat, CAPS.arc]);
  eq('the newest kept', r.lines.at(-1).eventId >= events.at(-1).id - 3, true);
  check('the rest counted, not read', r.earlier > 300, r.earlier);
  lines.push(...r.lines.map(l => l.text));
  const user = standingUser({ him: 'Him', them: { name: 'F', relation: 'friend', closeness: 'high', trust: 'high', tension: 'low', romance: 'dating' }, base: 'n '.repeat(300), lines });
  check('the user message stays small', user.length < 8192, user.length);
  check('nothing cut from its ending', user.endsWith('Write the note now as the JSON object.'));
}

section('the writers: the note replaces the history lines up to its as-of; a newer line still shows; caps hold');
{
  const s = life.getState();
  const row = { castId: FLAT, trigger: 'reply', dir: 'out' };
  const ctx = { tz, at: clock.now(), side: 'his', trigger: 'reply', persona: { displayName: 'Him' }, thread: [], beats: ['old beat one', 'old beat two'] };
  const without = phoneRender(buildSheet(s, row, ctx).sheet);
  const withNote = buildSheet(s, row, { ...ctx, standing: { text: 'They are good.', asOf: 'Mon 2 Nov' }, beatsAfter: ['a newer beat'] }).sheet;
  const out = phoneRender(withNote);
  check('no note: the history as before', without.includes('old beat one') && !without.includes('How things stand'));
  check('with a note: it reads', out.includes('How things stand between them') && out.includes('They are good.') && out.includes('Mon 2 Nov'));
  check('…the history it covers is gone', !out.includes('old beat one'));
  check('…what is newer stays', out.includes('a newer beat'));
  check('the note wins nothing over the sheet', out.includes('the fact sheet and the thread are newer and win'));
  const full600 = 'n'.repeat(600);
  const big = buildSheet(s, row, { ...ctx, standing: { text: full600, asOf: 'Mon 2 Nov' }, commitments: ['l'.repeat(160), 'l'.repeat(160)] }).sheet;
  check('a full 600-character note isn\'t cut by the fact line cap', phoneRender(big).includes(full600));
  const heavyThread = Array.from({ length: 60 }, (_, i) => ({ who: 'him', when: 'Mon 2 Nov 10:00', text: `t${i} `.repeat(70) }));
  const longOut = phoneRender({ ...big, thread: heavyThread, recent: Array(10).fill('r'.repeat(220)), plans: Array(6).fill('p'.repeat(220)) });
  check('over the cap: inside it, ending intact', Buffer.byteLength(longOut) <= PHONE_MAX && longOut.endsWith('Write the texts now as the JSON object.'), Buffer.byteLength(longOut));
  // A scene sheet.
  const session = { mode: 'full', kind: 'hangout', placeId: 'place:cafe', castIds: [FLAT, SIB, 'cast:coworker-a'], startAt: clock.now() - 3600, endAt: clock.now(), minutes: 60, activityEventId: lastEventId() };
  const sctx = { tz, place: 'the cafe', persona: { displayName: 'Him' }, outcome: { value: 'well' }, vitals: {},
    history: { [FLAT]: ['an old line'] }, beats: { [FLAT]: ['news'] } };
  const plain = sceneRender(buildFactSheet(s, session, sctx).sheet);
  const noted = buildFactSheet(s, session, { ...sctx, standing: { [FLAT]: { text: 'They are good, and Sibling knows.', validFrom: clock.now() - DAY, asOfEventId: 1 } }, historyAfter: { [FLAT]: ['a newer line'] }, beatsAfter: { [FLAT]: [] }, commitments: { [FLAT]: ['he and F sounded like they\'d meet, but nothing is set'] } });
  const nout = sceneRender(noted.sheet);
  check('a scene with no note: the history', plain.includes('an old line') && !plain.includes('How things stood'));
  check('a scene with one: the note, and only what is newer', nout.includes('How things stood with P1') && !nout.includes('an old line') && nout.includes('a newer line'));
  check('…and his promise with them', nout.includes('nothing is set'));
  const explicit = sceneRender({ ...noted.sheet, register: 'explicit' });
  check('an explicit sheet stays as it was: no note, the history as before', !explicit.includes('How things stood') && explicit.includes('an old line') && !explicit.includes('nothing is set'));
  const maxed = buildFactSheet(s, session, { ...sctx, standing: Object.fromEntries(session.castIds.map(id => [id, { text: 'n'.repeat(600), validFrom: clock.now() - DAY, asOfEventId: 1 }])) }).sheet;
  maxed.trace = { lines: Array(24).fill('l'.repeat(120)) };
  maxed.afterwards = Array(4).fill('a'.repeat(200));
  maxed.phoneDuring = Array(5).fill('p'.repeat(100));
  const mout = sceneRender(maxed);
  check('a scene over the cap: the notes go, ending intact', Buffer.byteLength(sceneRender({ ...maxed, people: maxed.people.map(({ standing, ...p }) => p) })) <= SCENE_MAX
    && Buffer.byteLength(mout) <= SCENE_MAX && mout.endsWith('Write the scene now as the JSON object.'), Buffer.byteLength(mout));
}

section('his side of the phone only: with a note stored, the cast side is byte-equal to no note at all');
{
  const SEC = 'cast:sibling';
  const SECRET = 'He trusts them less since the plan fell through, and there is more tension than they would guess.';
  const t0 = clock.now();
  const s = life.getState();
  // The real sheet builder, fed by the worker's own reader.
  const sheetOf = (side) => {
    const m = phoneWorker.memoryFor(life.getState(), SEC, clock.now(), tz, side);
    return phoneRender(buildSheet(life.getState(), { castId: SEC, trigger: 'reply', dir: side === 'his' ? 'out' : 'in' },
      { ...m, tz, at: clock.now(), side, trigger: 'reply', persona: { displayName: 'Him' }, thread: [], beats: ['a beat it would cover'] }).sheet);
  };
  const live0 = store.live(SEC);
  if (live0) store.invalidate(live0.id, 'test', t0);
  const noNoteCast = sheetOf('cast');
  const noNoteHis = sheetOf('his');
  store.addVersion({ castId: SEC, text: SECRET, asOfEventId: lastEventId(), at: t0 - HOUR, evidence: [] });
  eq('the reader gives the cast side nothing', phoneWorker.memoryFor(life.getState(), SEC, clock.now(), tz, 'cast').standing, undefined);
  eq('the cast sheet: byte-equal', sheetOf('cast'), noNoteCast);
  check('…its lately untouched', noNoteCast.includes('a beat it would cover'));
  const his = sheetOf('his');
  check('his side has it', his !== noNoteHis && his.includes(SECRET) && his.includes('How things stand between them'));
  check('…and it replaces what it covers', !his.includes('a beat it would cover'));
  // Even handed a note directly, the builder keeps it from the cast side.
  const forced = phoneRender(buildSheet(s, { castId: SEC, trigger: 'reply', dir: 'in' }, { tz, at: clock.now(), side: 'cast', trigger: 'reply', persona: { displayName: 'Him' }, thread: [], beats: ['a beat it would cover'], standing: { text: SECRET, asOf: 'Mon 2 Nov' }, beatsAfter: [] }).sheet);
  eq('the builder refuses it too', forced, noNoteCast);
  // The whole prompt, on the live path: the same turn written twice by the real worker, note or none.
  const p = await story.director.preview({ kind: 'text', castId: SEC, gist: 'how was the rest of your week', at: 'now', chat: 'short' }, { relax: true });
  await story.director.apply(p.previewId, p.fingerprint);
  for (let i = 0; i < 4; i++) { await story.idle(); await story.runPhoneNow(); await story.idle(); await simulateHours(0.25); }
  const hisCall = cr.calls.filter(c => c.caller === 'life.phone.his' || c.caller === 'life.phone.mind').at(-1);
  check('his writer read the note', hisCall?.user.includes(SECRET), hisCall?.caller);
  const newest = phoneStore.threadOf(SEC, { live: true, limit: 1 })[0];
  eq('the newest turn is theirs', newest?.dir, 'in');
  const castUser = () => cr.calls.filter(c => c.caller === 'life.phone.cast').at(-1)?.user;
  check('their writer did not', castUser() && !castUser().includes(SECRET) && !castUser().includes('How things stand'));
  // A rewrite's trigger differs from the original's, so both sides of the comparison are rewrites of a rewrite.
  const rewrite = async () => { await story.phoneRegenerate(phoneStore.threadOf(SEC, { live: true, limit: 1 })[0].id); await story.idle(); };
  await rewrite();
  await rewrite();
  const withNote = castUser();
  const cur = store.live(SEC);
  store.invalidate(cur.id, 'test', clock.now());
  await rewrite();
  eq('the same turn, note or no note: the prompt is byte-equal', castUser(), withNote);
}

section('the mind\'s sleep step runs it, on the clerk, counted, and it never changes the night');
{
  let got = null;
  sleep.__setDepsForTest({ now: clock.fn, isMindOn: () => true, candidateChats: () => [], chatsWithEpisodes: () => [], budgetOk: async () => ({ ok: true }), clerkBudgetLeft: () => true,
    stanceUpdate: async () => {}, callRole: cr.fn, selfModel: async () => null,
    life: async () => ({ storyStandingPass: async (o) => { got = o; return o.call('sys', 'usr', { castId: FLAT, attempt: 0 }); }, isLifeOn: () => false }) });
  const r = await sleep.runSleep('2031-01-01', 'owner');
  check('the night finished', ['done', 'partial'].includes(r.status), JSON.stringify(r));
  check('it was handed the budget, the clerk cap and a call', got?.budgetOk?.ok === true && typeof got?.clerkLeft === 'function' && typeof got?.call === 'function');
  eq('the night key', got?.nightKey, '2031-01-01');
  check('role and caller on that call', cr.calls.at(-1).role === 'clerk' && cr.calls.at(-1).caller === 'mind.standing');
  sleep.__setDepsForTest({ life: async () => ({ storyStandingPass: async () => { throw new Error('boom'); }, isLifeOn: () => false }) });
  const r2 = await sleep.runSleep('2031-01-02', 'owner');
  check('a failure there leaves the night alone', ['done', 'partial'].includes(r2.status), JSON.stringify(r2));
  sleep.__setDepsForTest(null);
}

section('the site: the rows the exporter reads');
{
  check('rows for fictional members, before the heavy stretch began', siteRows.length > 0 && siteRows.every(r => r.castId.startsWith('cast:') && typeof r.text === 'string' && Number.isFinite(r.validFrom)), siteRows.length);
  eq('nothing while a note was written inside a heavy window', story.publicStanding().filter(r => worker.view(r.castId).current?.validFrom >= heavyAt - 2 * DAY).length, 0);
  const scrubber = { clean: (t) => t, check: (t) => (t.includes('Secret') ? 'x' : null) };
  const castById = new Map([['cast:a', { id: 'c_1', name: 'A' }]]);
  const raw = { places: [{ id: 'p', name: 'Greenfield House', home: true }], from: 0, at: 1e10 };
  const out = buildStanding({ rows: [
    { castId: 'cast:a', text: 'They went to Blue Tokai.', validFrom: 1000 },
    { castId: 'cast:b', text: 'not in the document', validFrom: 1000 },
    { castId: 'cast:a', text: 'Near Greenfield House again.', validFrom: 1000 },
    { castId: 'cast:a', text: 'A Secret thing.', validFrom: 1000 },
  ], raw, persona: {}, scrubber, venueWords: (t) => t.replace('Blue Tokai', 'a cafe'), castById, tz });
  eq('venue words, the home check, the scrubber; only people in the document; no name (the site has it by id)', out.people, [{ id: 'c_1', text: 'They went to a cafe.', since: 1000 }]);
  eq('no venue rule: no text at all', buildStanding({ rows: [], raw, persona: {}, scrubber, venueWords: null, castById, tz }).people, []);
}

section('no event appended by any of it');
{
  const types = listEvents({ order: 'desc', limit: 500 }).map(e => e.type);
  check('no standing event type exists', !types.some(t => t.startsWith('standing')));
  void phoneStore;
}

report();
