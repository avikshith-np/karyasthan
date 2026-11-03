// Plan 020 F3: real thoughts. When salience adds up, one small call in his voice says what he told himself; the code's true cause is
// the second column. The model is never told the lean or the draw. The sheet has no chat word and no real name; a real person's or a
// chat's plan is "plans with a friend". Day and $ caps fail closed, a failure leaves the code stream. A private session and a heavy stretch
// get none. It changes nothing in his life, it goes with its evidence, and the site never sees it. Example world, fake clock, stubbed models.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR } from './_helpers.js';
import { appendEvent, lastEventId } from '../../src/life/eventLog.js';
import * as story from '../../src/life/story/index.js';
import * as facade from '../../src/life/index.js';
import * as real from '../../src/life/story/thoughts/real.js';
import * as worker from '../../src/life/story/thoughts/worker.js';
import { PLAN_WITH_A_FRIEND } from '../../src/life/thoughtPhrases.js';
import { deleteFromChat, insertThought, isRealThought, thoughtsBetween } from '../../src/life/thoughtStore.js';
import { dateKey, localParts, resolveTimezone } from '../../src/life/clock.js';
import { getDb } from '../../src/memory/db.js';
import { config } from '../../src/utils/config.js';

const GROUP = '120363000000000099@g.us';
const REAL = '15550000042@s.whatsapp.net';
const CHAT_WORD = 'Pizza-Secret-Words';
const REPLY = (t) => JSON.stringify({ thought: t });

section('the check: closed JSON, length, names, identifiers, nothing sexual, no sim words');
{
  const ctx = { names: ['Robin'], knownNames: ['Odile Holt'], castNames: ['Robin Vale', 'Mira Shah'], venueNames: [{ name: 'Cafe Mocha', kind: 'cafe' }], earlier: ['too tired anyway'] };
  const v = (o, c = ctx) => real.validateThought(typeof o === 'string' ? o : JSON.stringify(o), c);
  const ok = (t) => v({ thought: t });
  eq('a clipped thought', ok('fine, needed the air anyway').text, 'fine, needed the air anyway');
  eq('a name it was given', ok('Robin would have sulked if I bailed').ok, true);
  eq('two lines', ok('fine.\nneeded the air').ok, true);
  eq('a day of the week', ok('should have gone on Friday instead').ok, true);
  eq('an ordinary opener', ok('Everyone said it would be quick').ok, true);
  eq('an extra key', v({ thought: 'fine, whatever', why: 'x' }).reason, 'bad_key');
  eq('no JSON', v('fine, whatever').reason, 'json_no_object');
  eq('no thought', v({ thought: '' }).reason, 'empty');
  eq('not a string', v({ thought: 5 }).reason, 'empty');
  eq('too short', ok('ok').reason, 'short');
  eq('too long', ok('x'.repeat(161)).reason, 'too_long');
  eq('three lines', ok('one thing\nanother thing\na third').reason, 'too_many_lines');
  eq('a marker', ok('[SEARCH: why am I tired]').reason, 'marker');
  eq('a hashtag', ok('so tired #mondays').reason, 'not_a_thought');
  eq('an emoji', ok('so tired today 😩').reason, 'not_a_thought');
  eq('a JID', ok('call 15550000042@s.whatsapp.net back').reason, 'identifier');
  eq('a URL', ok('saw it on https://example.com').reason, 'url');
  eq('a phone number', ok('should call 5550002345 back').reason, 'identifier');
  eq('a real full name', ok('Odile Holt was right').reason, 'real_name');
  eq('a real first name, any case', ok('odile was right about it').reason, 'real_name');
  eq('an invented name mid-sentence', ok('told myself Priya would understand').reason, 'invented_name');
  eq('an invented name at the start', ok('Priya said it would be fine').reason, 'invented_name');
  eq('a member not on the sheet', ok('mira would laugh at this').reason, 'other_member');
  eq('explicit', ok('feeling horny today').reason, 'explicit');
  eq('suggestive', ok('kept thinking about her lips').reason, 'suggestive');
  eq('harm', ok('might as well kill myself').reason, 'harm');
  eq('a sim word: the draw', ok('the draw went against me').reason, 'meta');
  eq('a sim word: draw came', ok('that draw came up wrong').reason, 'meta');
  eq('a sim word: the owner', ok('the owner picked this for me').reason, 'meta');
  eq('a sim word: leaning stay', ok('I was leaning stay all along').reason, 'meta');
  eq('draw the curtains', ok('should draw the curtains and sleep').ok, true);
  eq('drawing', ok('used to like drawing, once').ok, true);
  eq("the flat's owner", ok("the flat's owner can wait a day").ok, true);
  eq('the owner of a place', ok('the owner of that place knows me now').ok, true);
  eq('leaning towards', ok('was leaning towards staying in anyway').ok, true);
  eq('"as an AI"', ok('as an AI I do not feel').reason, 'meta');
  eq('said already', ok('Too tired, anyway!').reason, 'repeat');
  eq('a venue becomes its kind word', ok('Cafe Mocha was too loud anyway').text.includes('Cafe Mocha'), false);
}

section('the right column reads as the cause, whatever the codes');
{
  const d = real.droveWords({ moment: 'against_lean', lean: 'stay', p: 0.72, did: 'go', by: 'draw', state: { energy: 41, social: 20, stress: 33, rain: true } });
  check('the lean, the draw, the state', /leaning stay \(72%\)/.test(d) && /draw/.test(d) && /energy 41/.test(d) && /rain/.test(d), d);
  check('the owner', /owner picked/i.test(real.droveWords({ moment: 'against_lean', lean: 'go', p: 0.6, did: 'stay', by: 'owner' })));
  check('a chat-adopted plan says so, no words', /chat/.test(real.droveWords({ moment: 'choice', did: 'go', by: 'adopted' })));
  check('an outing the draw made bad', /draw came up badly/.test(real.droveWords({ moment: 'outing_badly', outcome: 'badly', outcomeBy: 'code' })));
  check('…or the owner', /owner set/i.test(real.droveWords({ moment: 'outing_badly', outcome: 'badly', outcomeBy: 'owner' })));
  check('a swing with a chat in it: a code word', /a roast in a chat/.test(real.droveWords({ moment: 'mood_swing', from: 0.2, to: -0.1, minutes: 120, drivers: ['chat:roast'] })));
  check('a swing with nothing behind it says so', /drifted/.test(real.droveWords({ moment: 'mood_swing', from: 0.2, to: -0.1, minutes: 120, drivers: [] })));
  for (const m of Object.keys(real.WEIGHTS)) check(`${m}: some words`, real.droveWords({ moment: m }).length > 5);
  eq('no codes', real.droveWords(null), '—');
}

section('the salience adds up: one big moment, or small ones; fresh; routine adds but is never the thought');
{
  const big = { key: 'a', salience: real.WEIGHTS.against_lean, at: 1000 };
  const small = { key: 'b', salience: real.WEIGHTS.soaked, at: 900 };
  eq('one big moment is enough', real.chooseMoment([big], { at: 1100 })?.key, 'a');
  eq('a small one alone is not', real.chooseMoment([small], { at: 1100 }), null);
  const many = Array.from({ length: 4 }, (_, i) => ({ key: `s${i}`, salience: 2, at: 1000 + i }));
  eq('small ones add up', real.chooseMoment(many, { at: 1100 })?.key, 's0');
  eq('never about something old', real.chooseMoment([{ ...big, at: 1000 - real.FRESH_SEC }], { at: 1100 }), null);
  eq('one that has had its tries is left out', real.chooseMoment([big, { key: 'd', salience: 8, at: 1000 }], { at: 1100, spentOn: new Set(['a']) })?.key, 'd');
  eq('…and its weight doesn\'t carry a small one over', real.chooseMoment([big, { key: 'd', salience: 2, at: 1000 }], { at: 1100, spentOn: new Set(['a']) }), null);
  eq('no padding left', [real.behindPace, real.PACE_NEED, real.WEIGHTS.meeting_done, real.WEIGHTS.habit, real.WEIGHTS.home_again], [undefined, undefined, undefined, undefined, undefined]);
  const routine = ['woke_tired', 'salary', 'rent', 'text', 'woke'].map((moment, i) => ({ key: moment, moment, salience: real.WEIGHTS[moment], at: 1000 + i }));
  check('routine alone adds up', routine.reduce((a, m) => a + m.salience, 0) >= real.THRESHOLD);
  eq('…and still isn\'t a thought', real.chooseMoment(routine, { at: 1100 }), null);
  eq('it can tip something else over', real.chooseMoment([...routine, { key: 'y', moment: 'soaked', salience: real.WEIGHTS.soaked, at: 900 }], { at: 1100 })?.key, 'y');
  const c = { at: 1000, s: { cast: new Map(), decisions: new Map(), self: { homePlaceId: 'home' } } };
  eq('a meeting ending, getting home, the gym: no moments', real.momentsOf([
    { id: 1, type: 'activity.ended', at: 900, payload: { kind: 'meeting' } }, { id: 2, type: 'travel.arrived', at: 900, payload: { to: 'home' } }, { id: 3, type: 'activity.started', at: 900, payload: { kind: 'gym' } },
  ], c).length, 0);
  check('none of those events are even read', !['activity.ended', 'activity.started', 'travel.arrived'].some(t => real.MOMENT_TYPES.includes(t)));
  const own = [{ originKind: 'self' }];
  const chat = [{ originKind: 'group' }];
  const plan = { moment: 'soaked', fromChat: false };
  eq('a day with a thought of his own: something to look back on', real.hasDayToLookBack([], own), true);
  eq('a day with a moment', real.hasDayToLookBack([plan], []), true);
  eq('nothing at all: nothing', real.hasDayToLookBack([], []), false);
  eq('only routine: nothing', real.hasDayToLookBack([{ moment: 'woke', fromChat: false }, { moment: 'salary', fromChat: false }], []), false);
  eq('only a chat\'s: nothing', real.hasDayToLookBack([{ moment: 'chat_mark', fromChat: true }], chat), false);
  eq('a swing', real.swingOf([{ at: 0, valence: 0.3 }, { at: 3600, valence: 0 }], 3600)?.d < 0, true);
  eq('no swing', real.swingOf([{ at: 0, valence: 0.1 }, { at: 3600, valence: 0.05 }], 3600), null);
  eq('too long ago', real.swingOf([{ at: 0, valence: 0.8 }, { at: real.SWING_WINDOW_SEC + 60, valence: 0 }], real.SWING_WINDOW_SEC + 60), null);
}

section('a scene the model may not think about');
{
  const ctx = { at: 1000, s: { cast: new Map([['c1', { name: 'Robin Vale' }]]), decisions: new Map() }, hhmm: () => '20:00', isPrivate: () => false };
  const scene = (p, extra = {}) => ({ id: 7, type: 'scene.played', at: 900, payload: { outcome: 'badly', mode: 'full', castIds: ['c1'], activityEventId: 5, ...p }, ...extra });
  eq('an outing gone badly', real.momentsOf([scene({})], ctx)[0]?.moment, 'outing_badly');
  eq('a private session: none', real.momentsOf([scene({})], { ...ctx, isPrivate: () => true }).length, 0);
  eq('unknown whether it was: none', real.momentsOf([scene({})], { ...ctx, isPrivate: undefined }).length, 0);
  eq('an intimate scene: none', real.momentsOf([scene({ heat: 'explicit' })], ctx).length, 0);
  eq('a suggestive one: none', real.momentsOf([scene({ heat: 'suggestive' })], ctx).length, 0);
  eq('a real person: none', real.momentsOf([scene({}, { subjectJid: REAL })], ctx).length, 0);
  eq('near a heavy stretch: none', real.momentsOf([scene({ heavyWindow: true })], ctx).length, 0);
  const chat = real.momentsOf([scene({}, { originKind: 'group', originJid: GROUP })], ctx)[0];
  check('a chat\'s outing: no name, a friend', chat.title === 'an outing with a friend' && !/Robin/.test(chat.fact) && chat.origin.jid === GROUP, chat.fact);
}

section('the sheet reads true');
{
  const s = { cast: new Map([['c1', { name: 'Robin Vale' }]]), decisions: new Map(), activity: { kind: 'work', withCast: ['c1', 'c1'] }, places: new Map(), self: {} };
  const base = { s, at: 7200, parts: { weekday: 'Monday' }, hhmm: () => '10:00', v: { mood: { valence: 0.5 } } };
  const lines = (m, o = {}) => real.sheetOf({ fact: 'You just got back from seeing Robin. It went badly.', at: 7100, key: 'k', ...m }, { ...base, ...o }).join('\n');
  check('a name once', (lines({}).match(/Robin,?/g) ?? []).length === 2 && /with Robin\./.test(lines({})), lines({}));
  check('his mood doesn\'t argue with a bad outing', !/good mood/.test(lines({ moment: 'outing_badly' })), lines({ moment: 'outing_badly' }));
  check('…nor a low one with a good one', !/\blow\b/.test(real.sheetOf({ moment: 'outing_well', fact: 'x', at: 7100, key: 'k' }, { ...base, v: { mood: { valence: -0.5 } } }).join('\n')));
  check('fresh reads "just"', /You just got back/.test(lines({})));
  const old = lines({ at: 7200 - 2 * HOUR });
  check('hours later it doesn\'t', !/\bjust\b/.test(old) && /A while ago/.test(old), old);
  check('fine when there\'s nothing to say', /how you are: okay\./.test(real.sheetOf({ moment: 'crunch', fact: 'x', at: 7100, key: 'k' }, { ...base, v: {} }).join('\n')));
}

section('the words for a plan of a chat are the stream\'s');
eq('"plans with a friend"', real.FRIEND_PLAN, PLAN_WITH_A_FRIEND);

// ── on the engine ──
const calls = [];
let said = 0;
const plain = () => REPLY(`needed the air, that was all ${said++}`);
let reply = plain;
const cr = fakeCallRole({ 'life.thought.real': (sys, user, opts, i) => { calls.push({ sys, user, opts }); return reply(sys, user, i); } });
const deps = () => ({ getUsageByCaller: () => [], knownNames: () => ['Odile Holt'], roleBudgetOk: () => true });
async function boot(opts = {}) {
  await setupScratchDb();
  const b = await bootLife({ callRole: cr, ...opts });
  story.__setDepsForTest(deps());
  config.arcs.scenesEnabled = false;
  config.arcs.phoneOrganicPerDay = 0;
  config.arcs.realThoughtsEnabled = true;
  config.arcs.realThoughtMaxPerDay = 8;
  config.arcs.realThoughtBudgetUsd = 1;
  worker.__resetForTest();
  calls.length = 0;
  return b;
}
const realRows = () => getDb().prepare("SELECT * FROM story_thoughts WHERE dedupe_key LIKE 'real:%' ORDER BY at, id").all();
const streamRows = () => getDb().prepare("SELECT count(*) n FROM story_thoughts WHERE dedupe_key IS NULL OR dedupe_key NOT LIKE 'real:%'").get().n;
const logHash = () => createHash('sha256').update(JSON.stringify(getDb().prepare('SELECT type, at, actor, cause_id, payload_json FROM world_events ORDER BY id').all())).digest('hex');
const pump = async (hours) => { for (let i = 0; i < hours * 4; i++) { await simulateHours(0.25); await story.runRealThoughtsNow(); } };

let clock;
let world;
const S = () => facade.getState();
const opts = (at, label = 'Coffee with Robin') => [{ id: 'go', go: true, label, minutes: 90, kind: 'cafe' }, { id: 'late', go: 'late', label: 'Join late', expiresAt: at + 90 * 60 }, { id: 'stay', label: 'Stay in', kind: 'rest' }];

section('it ships off');
{
  await setupScratchDb();
  eq('the default', config.arcs.realThoughtsEnabled, false);
}

section('it changes nothing: the same run, with and without, writes the same log and the same stream');
{
  // A quiet life may hold no moment in 3 days, so the same choice goes into both runs.
  ({ clock } = await boot());
  config.arcs.realThoughtsEnabled = false;
  await pump(30);
  against({});
  await pump(42);
  const without = logHash();
  const streamWithout = streamRows();
  eq('none with it off', realRows().length, 0);
  eq('no call with it off', calls.length, 0);
  await stopLife();
  ({ clock } = await boot());
  await pump(30);
  against({});
  await pump(42);
  check('some with it on', realRows().length >= 1, String(realRows().length));
  eq('the log is byte for byte the same', logHash(), without);
  eq('the code stream is the same', streamRows(), streamWithout);
  await stopLife();
}

({ clock, world } = await boot());
const tz = resolveTimezone(world.timezone ?? config.timezone);
const settleAwake = async () => { // well into a waking morning, nothing behind him
  await sim(26);
  while (localParts(clock.now(), tz).hour !== 10) await sim(0.25);
};
// Time passes with the tick's own job off, so each section runs one pass by hand.
const sim = async (h) => {
  config.arcs.realThoughtsEnabled = false;
  await simulateHours(h);
  await story.runRealThoughtsNow();
  config.arcs.realThoughtsEnabled = true;
  worker.__resetForTest();
};
const fresh = async () => {
  await sim(1);
  calls.length = 0;
};
// A revertible thing to rest on: an outing gone badly.
function badOuting() {
  const at = clock.now();
  const castIds = [...S().cast.keys()].slice(0, 1);
  worker.configure({ isPrivateActivity: () => false });
  const act = getDb().prepare("SELECT MAX(id) AS id FROM world_events WHERE type = 'activity.started'").get().id;
  const e = appendEvent({ type: 'scene.played', at, actor: 'engine', causeId: act, payload: { sceneId: 1, version: 1, activityEventId: act, startAt: at - HOUR, endedAt: at, kind: 'cafe', castIds, mode: 'full', tier: 'code', outcome: 'badly', outcomeBy: 'code', ending: 'nothing', chemistry: 0.2, firstMeet: [], fallback: true, heavyWindow: false, textSha: 'x' } });
  story.__rebuildForTest();
  return e;
}
function against({ at = clock.now(), chat = false, subject = null, category = undefined, kind = 'cafe', lean = 'stay', p = 0.72, did = 'go' } = {}) {
  const eventAt = at + 4 * HOUR;
  const castIds = [...S().cast.keys()].slice(0, 1);
  const flag = chat ? appendEvent({ type: 'claim.flagged', at, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { claimId: 91, p: 0.9, text: CHAT_WORD } }) : null;
  const opened = appendEvent({ type: 'decision.opened', at, actor: 'engine', ...(flag ? { causeId: flag.id } : {}), ...(subject ? { subjectJid: subject } : {}), payload: {
    kind, subject: { eventAt, placeId: [...S().places.keys()].find(id => S().places.get(id).kind === 'cafe') ?? null, castIds, endAt: eventAt + 7200, ...(subject ? { subjectJid: subject } : {}) },
    opensAt: at, decideBy: eventAt - HOUR, ponrAt: eventAt - 1800, options: opts(eventAt, chat ? `${CHAT_WORD} dinner` : undefined), ...(category ? { category } : {}), ...(chat ? { adopted: true, claimId: 91 } : {}),
  } });
  appendEvent({ type: 'decision.lean', at, actor: 'jev', causeId: opened.id, payload: { decisionId: opened.id, optionId: lean, p, trigger: 'deadline_near' } });
  const c = appendEvent({ type: 'decision.committed', at, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, optionId: did, p: 0.28, sampled: true, by: 'sample' } });
  story.__rebuildForTest();
  return { id: opened.id, commit: c.id };
}

section('a choice against his lean: the model is told what he did, never the lean or the draw');
{
  await settleAwake();
  await fresh();
  const d = against({});
  const r = await story.runRealThoughtsNow();
  eq('written', r.status, 'written');
  eq('one call', calls.length, 1);
  eq('role mouth, caller life.thought.real', cr.callsFor('life.thought.real').at(-1).role, 'mouth');
  const { sys, user, opts: o } = calls.at(-1);
  check('his identity + the charter', typeof sys.core === 'string' && sys.core.length > 100 && sys.profile === real.THOUGHT_CHARTER);
  check('small', o.maxTokens <= 200);
  check('what he did is on the sheet', /You've decided to go/.test(user), user);
  check('no lean, no probability, no draw, no option ids', !/\blean|0\.72|72%|\bdraw|\bsample|probab|deadline|stay\b/i.test(user), user);
  const row = realRows().at(-1);
  const codes = JSON.parse(row.codes_json);
  eq('kind real, in its codes', codes.kind, 'real');
  eq('the moment', codes.moment, 'against_lean');
  eq('the true cause', [codes.lean, codes.p, codes.did, codes.by], ['stay', 0.72, 'go', 'draw']);
  eq('cause_code', row.cause_code, 'against_lean:draw');
  eq('a family the table allows', row.family, 'excuse');
  check('it rests on the decision, the lean and the commit', JSON.parse(row.evidence_event_ids).includes(d.id) && JSON.parse(row.evidence_event_ids).includes(d.commit));
  const v = facade.thoughtsView({});
  const card = v.real.find(x => x.id === row.id);
  check('two columns on the read', /needed the air/.test(card?.told ?? '') && /leaning stay \(72%\)/.test(card?.drove ?? ''), JSON.stringify(card));
  eq('it differs', card.differs, true);
  check('not in the stream', !v.thoughts.some(t => t.id === row.id));
  // The stream's own excuse for this choice gives way on the read.
  insertThought({ at: clock.now(), family: 'excuse', text: 'needed it anyway', dedupeKey: `excuse:excuse:${d.id}`, evidence: [d.id], asOf: lastEventId(), cause: 'against_lean:draw' }, clock.now());
  check('one moment, one thought', !facade.thoughtsView({}).thoughts.some(t => t.text === 'needed it anyway'));
}

section('a restart or a second pass: nothing twice, and a gap');
{
  const n = realRows().length;
  const c = calls.length;
  const r = await story.runRealThoughtsNow();
  eq('too soon after the last', r.status, 'gap');
  eq('no call', calls.length, c);
  eq('no row', realRows().length, n);
  await sim(1);
  const again = await story.runRealThoughtsNow();
  check('what\'s spent stays spent', again.status === 'quiet' || realRows().filter(x => x.dedupe_key === realRows().at(-1).dedupe_key).length === 1, again.status);
}

section('a revert: gone from the read at once, swept at the next tick');
{
  await fresh();
  worker.__resetForTest();
  const e = badOuting();
  const r = await story.runRealThoughtsNow();
  eq('an outing gone badly', [r.status, r.moment], ['written', 'outing_badly']);
  check('its sheet says so, in plain words', /It went badly/.test(calls.at(-1).user), calls.at(-1).user);
  const row = realRows().at(-1);
  check('there', facade.thoughtsView({}).real.some(x => x.id === row.id));
  check('the code says who made it so', /draw came up badly/.test(facade.thoughtsView({}).real[0].drove));
  facade.revertEvent(e.id, { reason: 't', by: 'tester' });
  check('gone from the read', !facade.thoughtsView({}).real.some(x => x.id === row.id));
  await sim(0.5);
  check('swept from the table', !realRows().some(x => x.id === row.id));
}

section('what it rested on goes during the call: nothing stored');
{
  await fresh();
  worker.__resetForTest();
  const e = badOuting();
  reply = () => { facade.revertEvent(e.id, { reason: 't', by: 'tester' }); return REPLY('this should never land'); };
  const r = await story.runRealThoughtsNow();
  reply = plain;
  eq('dropped', [r.status, r.reason], ['failed', 'evidence_gone']);
  check('no row', !realRows().some(x => x.text === 'this should never land'));
}

section('a plan a chat made: "plans with a friend", no word and no name, and it goes with the chat');
{
  await fresh();
  const d = against({ chat: true });
  const r = await story.runRealThoughtsNow();
  eq('written', r.status, 'written');
  const { user } = calls.at(-1);
  check('plans with a friend', user.includes(PLAN_WITH_A_FRIEND), user);
  check('no chat word', !user.includes(CHAT_WORD) && !/Pizza/i.test(user), user);
  const line = user.split('\n').find(l => l.startsWith("what's on your mind"));
  check('the plan names no one', ![...S().cast.values()].some(c => line.includes(c.name.split(/\s+/)[0])), line);
  check('no JID', !user.includes(GROUP));
  const row = realRows().at(-1);
  eq('the chat is its origin', [row.origin_kind, row.origin_jid], ['group', GROUP]);
  check('the title too', JSON.parse(row.codes_json).title === PLAN_WITH_A_FRIEND);
  const card = facade.thoughtsView({}).real.find(x => x.id === row.id);
  eq('marked from a chat', card.fromChat, true);
  check('the read has no JID and no chat word', !JSON.stringify(facade.thoughtsView({})).includes(GROUP) && !JSON.stringify(facade.thoughtsView({})).includes(CHAT_WORD));
  deleteFromChat([GROUP], row.at - 10);
  check('a forget in that chat takes it', !realRows().some(x => x.id === row.id));
  void d;
}

section('a real person\'s plan: the same');
{
  await fresh();
  against({ subject: REAL });
  const r = await story.runRealThoughtsNow();
  eq('written', r.status, 'written');
  check('plans with a friend, no number', calls.at(-1).user.includes(PLAN_WITH_A_FRIEND) && !calls.at(-1).user.includes('15550000042'), calls.at(-1).user);
}

section('a big swing with a chat behind it: the sheet has a feeling, the second column a code, and it goes with the chat');
{
  await fresh();
  const t = clock.now();
  worker.noteTick({ vitals: { mood: { valence: 0.35 } } }, { at: t - HOUR });
  worker.noteTick({ vitals: { mood: { valence: 0.05 } } }, { at: t });
  const p = appendEvent({ type: 'chat.perceived', at: t, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { kind: 'affect', affect: 'roast', intensity: 'high', p: 0.9, msgId: 'M1' } });
  story.__rebuildForTest();
  const r = await story.runRealThoughtsNow();
  eq('written', [r.status, r.moment], ['written', 'mood_swing']);
  const { user } = calls.at(-1);
  check('his mood, in words', /your mood has dropped/.test(user), user);
  check('no chat id, no message', !user.includes(GROUP) && !user.includes('M1') && !/roast/.test(user), user);
  const row = realRows().at(-1);
  eq('the chat is its origin', [row.origin_kind, row.origin_jid], ['group', GROUP]);
  check('its pointer is evidence', JSON.parse(row.evidence_event_ids).includes(p.id));
  check('the true cause, a code', /a roast in a chat/.test(facade.thoughtsView({}).real[0].drove), facade.thoughtsView({}).real[0].drove);
  facade.revertEvent(p.id, { reason: 'revoked', by: 'tester' });
  check('a revoked message takes it', !facade.thoughtsView({}).real.some(x => x.id === row.id));
}

section('a chat\'s mark, small: a feeling and its origin, adding up with the rest');
{
  await fresh();
  const t = clock.now();
  const p = appendEvent({ type: 'chat.perceived', at: t, actor: 'chat', originKind: 'dm', originJid: REAL, payload: { kind: 'affect', affect: 'praise', intensity: 'low', p: 0.9, msgId: 'M2' } });
  story.__rebuildForTest();
  const ms = real.momentsOf([p], { s: S(), at: t, hhmm: () => '10:00' });
  check('one moment, no words of it', ms[0]?.moment === 'chat_mark' && /in a chat/.test(ms[0].fact) && !ms[0].fact.includes('M2'), JSON.stringify(ms[0]));
  eq('its origin', ms[0].origin, { kind: 'dm', jid: REAL });
  eq('not enough alone', real.chooseMoment(ms, { at: t }), null);
}

section('a story decision');
{
  await fresh();
  against({ kind: 'career:interview', category: 'career', lean: 'go', p: 0.8, did: 'go' });
  const r = await story.runRealThoughtsNow();
  eq('written', [r.status, r.moment], ['written', 'story_choice']);
  check('the code knows it held', /leaning go \(80%\), and it held/.test(facade.thoughtsView({}).real[0].drove), facade.thoughtsView({}).real[0].drove);
}

section('heavy, an embargo, a pause, a private session, sleep: no call');
{
  await fresh();
  against({});
  const pass = async (conf) => { if (conf) worker.configure(conf); const r = await story.runRealThoughtsNow(); story.__setDepsForTest({}); return r.status; };
  eq('a heavy window', await pass({ heavyAt: () => true }), 'heavy');
  eq('a private session', await pass({ isPrivateNow: () => true }), 'private');
  eq('a private check that fails', await pass({ isPrivateNow: () => { throw new Error('x'); } }), 'private');
  eq('an embargo', await pass({ getState: () => ({ ...S(), embargo: { until: clock.now() + 3600 } }) }), 'heavy');
  eq('the Director paused', await pass({ getState: () => ({ ...S(), story: { ...S().story, controls: { ...(S().story?.controls ?? {}), paused: true } } }) }), 'paused');
  eq('no call', calls.length, 0);
  for (let i = 0; i < 200 && S().activity?.kind !== 'sleep'; i++) await sim(0.25);
  against({ at: clock.now() });
  eq('asleep', await pass(), 'asleep');
  eq('no call asleep', calls.length, 0);
}

section('the caps: every one fails closed');
{
  while (localParts(clock.now(), tz).hour !== 11) await sim(0.25);
  await fresh();
  const tryOne = async () => { await sim(1); against({}); const c = calls.length; const r = await story.runRealThoughtsNow(); return { r, called: calls.length > c }; };
  config.arcs.realThoughtMaxPerDay = 0;
  let t = await tryOne();
  eq('cap 0: off', [t.r.reason, t.called], ['off', false]);
  config.arcs.realThoughtMaxPerDay = 8;
  config.arcs.realThoughtBudgetUsd = 0;
  t = await tryOne();
  eq('$ cap 0: off', [t.r.reason, t.called], ['off', false]);
  config.arcs.realThoughtBudgetUsd = 1;
  story.__setDepsForTest({ getUsageByCaller: () => { throw new Error('locked'); } });
  t = await tryOne();
  eq('the ledger unreadable', [t.r.reason, t.called], ['ledger', false]);
  story.__setDepsForTest({ getUsageByCaller: () => [{ caller: real.CALLER, calls: 8, costUsd: 0 }] });
  t = await tryOne();
  eq('the day\'s calls used', [t.r.reason, t.called], ['day_cap', false]);
  story.__setDepsForTest({ getUsageByCaller: (p, since) => [{ caller: real.CALLER, calls: 0, costUsd: since < clock.now() - 86400 * 0 ? 1 : 0 }] });
  t = await tryOne();
  eq('the month\'s $ used', [t.r.reason, t.called], ['budget', false]);
  story.__setDepsForTest({ getUsageByCaller: () => [], roleBudgetOk: () => false });
  t = await tryOne();
  eq('the mouth over budget: a thought isn\'t chat', [t.r.reason, t.called], ['budget', false]);
  story.__setDepsForTest({ roleBudgetOk: () => { throw new Error('x'); } });
  t = await tryOne();
  eq('…and when that can\'t be read', [t.r.reason, t.called], ['budget', false]);
  story.__setDepsForTest({ roleBudgetOk: () => true, knownNames: () => { throw new Error('x'); } });
  t = await tryOne();
  eq('real names unreadable', [t.r.reason, t.called], ['names', false]);
  story.__setDepsForTest(deps());
}

section('a failed call leaves the code stream, and isn\'t retried at once');
{
  await fresh();
  for (const [name, fn, reason] of [
    ['an error', () => { throw new Error('down'); }, 'model_failed'],
    ['not JSON', () => 'just words, sorry', 'json_no_object'],
    ['an invented name', () => REPLY('told myself Priya would understand'), 'invented_name'],
    ['a real name', () => REPLY('odile was right about it'), 'real_name'],
    ['something sexual', () => REPLY('kept thinking about her lips'), 'suggestive'],
    ['a sim word', () => REPLY('the draw went against me'), 'meta'],
  ]) {
    await sim(1);
    against({});
    reply = fn;
    const n = realRows().length;
    const r = await story.runRealThoughtsNow();
    eq(`${name}: no row`, [r.reason, realRows().length], [reason, n]);
    const again = await story.runRealThoughtsNow();
    eq(`${name}: not retried at once`, again.status, 'gap');
  }
  reply = plain;
}

section('a refusal doesn\'t lose the moment: one more try later that day, inside the gap and the caps');
{
  await stopLife();
  ({ clock, world } = await boot());
  while (localParts(clock.now(), tz).hour !== 10) await sim(0.25);
  await fresh();
  const adv = async (h) => { config.arcs.realThoughtsEnabled = false; await simulateHours(h); await story.runRealThoughtsNow(); config.arcs.realThoughtsEnabled = true; };
  against({});
  reply = () => REPLY('told myself Priya would understand');
  const first = await story.runRealThoughtsNow();
  eq('refused', [first.status, first.reason], ['failed', 'invented_name']);
  eq('a call used', calls.length, 1);
  eq('not at once', (await story.runRealThoughtsNow()).status, 'gap');
  await adv(0.5);
  eq('not in half an hour: the 45-minute gap', (await story.runRealThoughtsNow()).status, 'gap');
  await adv(0.5);
  reply = plain;
  const second = await story.runRealThoughtsNow();
  eq('the same moment, written on its second try', [second.status, second.moment], ['written', 'against_lean']);
  eq('two calls', calls.length, 2);

  await adv(1);
  against({});
  reply = () => 'junk';
  eq('a second moment, refused', (await story.runRealThoughtsNow()).reason, 'json_no_object');
  await adv(1);
  eq('refused again', (await story.runRealThoughtsNow()).reason, 'json_no_object');
  const n = calls.length;
  await adv(1);
  eq('two tries is all it gets', (await story.runRealThoughtsNow()).status, 'quiet');
  eq('no third call', calls.length, n);

  // The caps hold over the retry.
  await adv(1);
  against({});
  eq('a third moment, refused', (await story.runRealThoughtsNow()).reason, 'json_no_object');
  await adv(1);
  const was = config.arcs.realThoughtMaxPerDay;
  config.arcs.realThoughtMaxPerDay = 1;
  const c = calls.length;
  eq('the day cap stops the retry', (await story.runRealThoughtsNow()).reason, 'day_cap');
  eq('no call', calls.length, c);
  config.arcs.realThoughtMaxPerDay = was;
  reply = plain;
}

section('summing up the day: an evening with something to look back on, once');
{
  await stopLife();
  ({ clock, world } = await boot());
  while (localParts(clock.now(), tz).hour !== 17) await sim(0.25);
  await fresh();
  const mine = against({});
  eq('a thought of his own earlier', (await story.runRealThoughtsNow()).status, 'written');
  const told = JSON.parse(JSON.stringify(realRows().at(-1).text));
  // A chat's thought, today: it may not reach the sheet, and it may not be repeated.
  const t = clock.now();
  insertThought({ at: t - 10, family: 'excuse', text: 'a chat stung, whatever', originKind: 'group', originJid: GROUP, codes: { kind: 'real', moment: 'chat_mark' }, evidence: [], asOf: lastEventId(), dedupeKey: 'real:chat_mark:test' }, t);
  while (localParts(clock.now(), tz).hour !== 21) await sim(0.25);
  await sim(0.25);
  const r = await story.runRealThoughtsNow();
  eq('he sums it up', [r.status, r.moment], ['written', 'day_end']);
  const { user } = calls.at(-1);
  check('the day\'s nearly over', /The day's nearly over/.test(user), user);
  check('with what he already told himself', user.includes(told), user);
  check('a chat\'s thought stays off the sheet', !user.includes('a chat stung'), user);
  check('no evidence: only a rewind takes it', realRows().at(-1).evidence_event_ids === '[]');
  check('its column doesn\'t pretend', /Nothing did: it's the hour/.test(facade.thoughtsView({}).real[0].drove), facade.thoughtsView({}).real[0].drove);
  await sim(1);
  const again = await story.runRealThoughtsNow();
  check('once a day', again.status !== 'written' || again.moment !== 'day_end', JSON.stringify(again));
  eq('one row', realRows().filter(x => x.dedupe_key.startsWith('real:day_end:') && x.dedupe_key.endsWith(dateKey(clock.now(), tz))).length, 1);
  void mine;
}

section('batch 3 review 27: the check allows who the sheet names, nobody else');
{
  const cast = ['Tobin Ashgrove', 'Priya Shah', 'Robin Vale'];
  const lines = ['now: Tuesday 21:15, at a restaurant, with Tobin.', "also lately: You've decided to go: coffee with Priya at a cafe, at 00:00.", 'how you are: okay.'];
  eq('every first name on the sheet', real.namesOnSheet(lines, cast), ['Tobin', 'Priya']);
  eq('an earlier line counts', real.namesOnSheet(['you\'ve already told yourself today: "robin again"'], cast), ['Robin']);
  eq('a whole word only', real.namesOnSheet(['Robinson Crusoe, arjunite'], cast), []);
  const allowed = (t) => real.validateThought(JSON.stringify({ thought: t }), { names: real.namesOnSheet(lines, cast), knownNames: [], castNames: cast }).ok;
  check('the company on the sheet', allowed('Tobin is being weird'));
  check('the plan on the sheet', allowed('dinner with Priya was fine.'));
  check('any case', allowed('priya will get over it, she always does.'));
  eq('someone not on it', real.validateThought(JSON.stringify({ thought: 'robin would laugh at this' }), { names: real.namesOnSheet(lines, cast), knownNames: [], castNames: cast }).reason, 'other_member');
}

section('batch 3 review 28: the sheet tells what the stream says');
{
  const places = new Map([['p1', { kind: 'cafe' }], ['r1', { kind: 'restaurant' }], ['h1', { kind: 'home' }]]);
  const cast = new Map([['c1', { name: 'Priya Shah' }], ['c2', { name: 'Tobin Ashgrove' }]]);
  const deed = ({ went, placeId = 'p1', eventAt = 900, position = {}, at = 1000 }) => {
    const d = { id: 5, kind: 'cafe', subject: { eventAt, placeId, castIds: ['c1'] }, options: [{ id: 'go', go: true, label: 'x' }], origins: [] };
    const s = { cast, places, self: { homePlaceId: 'h1' }, decisions: new Map([[5, d]]), position };
    const row = { id: 5, against: false, lastLean: null, deed: { status: 'committed', optionId: 'go', went, cause: 'draw', reversals: [] } };
    return real.momentsOf([{ id: 7, type: 'decision.committed', at: 950, payload: { decisionId: 5, optionId: 'go' } }], { s, at, hhmm: () => '20:00', deedRow: () => row })[0].fact;
  };
  check('past its time, still travelling there: on his way', /^You're on your way to coffee with Priya/.test(deed({ went: true, position: { travel: { to: 'p1' } } })), deed({ went: true, position: { travel: { to: 'p1' } } }));
  check('arrived: he went', /^You went: coffee with Priya/.test(deed({ went: true, position: { placeId: 'p1' } })));
  check('left, heading elsewhere: he went', /^You went/.test(deed({ went: true, position: { travel: { to: 'h1' } } })));
  check('pending, nothing logged yet: on his way', /^You're on your way to/.test(deed({ went: null })), deed({ went: null }));
  check('a go with no place: only said so', /^You said you'd go: coffee with Priya\./.test(deed({ went: null, placeId: null })), deed({ went: null, placeId: null }));
  check('never went stays', /never went/.test(deed({ went: false })));
  check('ahead stays', /^You've decided to go/.test(deed({ went: null, eventAt: 2000 })));
  const nowLine = (activity, position = {}) => real.sheetOf({ moment: 'crunch', fact: 'x', at: 7100, key: 'k' }, { s: { cast, places, self: { homePlaceId: 'h1' }, activity, position }, at: 7200, parts: { weekday: 'Tuesday' }, hhmm: () => '21:15', v: {} })[0];
  for (const kind of ['eat-out', 'cafe', 'movie', 'drinks', 'visit', 'walk', 'hangout', 'party', 'date']) {
    eq(`${kind}: the place and who`, nowLine({ kind, placeId: 'r1', withCast: ['c2'] }), 'now: Tuesday 21:15, at a restaurant, with Tobin.');
  }
  eq('free time is not doing much', nowLine({ kind: 'free', placeId: 'h1' }), 'now: Tuesday 21:15, not doing much, at your place.');
  eq('an unknown kind with no place or company', nowLine({ kind: 'something' }), 'now: Tuesday 21:15, not doing much.');
  eq('a known kind keeps its word', nowLine({ kind: 'dinner', placeId: 'r1' }), 'now: Tuesday 21:15, having dinner, at a restaurant.');
}

section('batch 3 review 30: every word of a real name, in any case');
{
  const ctx = { names: [], knownNames: ['K Ann', 'Dr. Maris', 'Rahul Varnell', 'Brin🌸', 'मारी'], castNames: [] };
  const v = (t, c = ctx) => real.validateThought(JSON.stringify({ thought: t }), c).reason;
  eq('a name that isn\'t first', v('ann was right about it, again.'), 'real_name');
  eq('after a title', v('maris would say so, probably'), 'real_name');
  eq('a surname', v('varnell can wait until monday'), 'real_name');
  eq('an emoji in the name', v('brin would say so, probably'), 'real_name');
  eq('an Indian script', v('मारी would say so, probably'), 'real_name');
  eq('a short word of a name is no match', v('dr who, honestly, still good'), undefined);
  eq('part of a word is no match', v('banu is not a name here, fine'), undefined);
}

section('batch 3 review 32: nothing about harming anyone or himself');
{
  const v = (t) => real.validateThought(JSON.stringify({ thought: t }), { names: [], knownNames: [], castNames: [] }).reason;
  for (const t of ['i want to end my life.', 'might end this life soon', 'i wish i were dead honestly.', 'wish i was dead, some days', 'i just want to die.', 'i could strangle him, seriously.', 'should just punch him in the face.', 'could punch them all', 'tortured by this, a corpse by friday']) eq(t, v(t), 'harm');
  for (const t of ['the throat is sore again', 'one more shot of coffee', 'punching above my weight here', 'this deadline, honestly', 'had a good life this week']) eq(`ordinary: ${t}`, v(t), undefined);
}

section('a real thought that names the company on its sheet is kept');
{
  await stopLife();
  ({ clock, world } = await boot());
  while (localParts(clock.now(), tz).hour !== 10) await sim(0.25);
  await fresh();
  against({});
  const planned = S().decisions.get(Math.max(...S().decisions.keys())).subject.castIds[0];
  const other = [...S().cast.values()].find(c => c.id !== planned && !c.name.startsWith(S().cast.get(planned).name.split(/\s+/)[0]));
  const first = other.name.split(/\s+/)[0];
  worker.configure({ getState: () => ({ ...S(), activity: { ...S().activity, withCast: [other.id] } }) });
  reply = () => REPLY(`${first} is being weird about it`);
  const r = await story.runRealThoughtsNow();
  reply = plain;
  story.__setDepsForTest({});
  check('the company is on the sheet', calls.at(-1).user.includes(`with ${first}`), calls.at(-1).user);
  eq('written, not refused', [r.status, r.reason], ['written', undefined]);
}

section('the site never sees it');
{
  await fresh();
  against({});
  await story.runRealThoughtsNow();
  const row = realRows().at(-1);
  check('there is one', !!row);
  // A stream row beside it is the control: the feed does read this window, and leaves only the real one out.
  const t = clock.now() - 60;
  insertThought({ at: t, family: 'reaction', text: 'a stream thought', dedupeKey: 'test:control', asOf: lastEventId() }, t);
  const control = getDb().prepare("SELECT id FROM story_thoughts WHERE dedupe_key = 'test:control'").get().id;
  const raw = facade.publicRaw();
  check('the stream row is in the feed', raw.thoughts?.some(x => x.id === control), JSON.stringify(raw.thoughts?.slice?.(0, 2)));
  eq('…and its words join', facade.publicThoughts([control]).get(control), 'a stream thought');
  check('the real one isn\'t', !raw.thoughts.some(x => x.id === row.id));
  eq('its words never join', facade.publicThoughts([row.id]).size, 0);
  const pv = fs.readFileSync('src/public/index.js', 'utf8') + fs.readFileSync('src/public/build.js', 'utf8');
  check('the site has no told / drove', !/\bdrove\b|\btold\b/.test(pv));
}

section('the two ways to tell a real thought agree');
{
  // The facade reads codes.kind (isRealThought); the weekly review's tier and realThoughtsBetween read the dedupe key. Written by one insert today.
  await fresh();
  against({});
  await story.runRealThoughtsNow();
  const real = realRows().at(-1);
  check('there is one', !!real);
  const t = clock.now() - 60;
  insertThought({ at: t, family: 'excuse', text: 'a stream excuse', dedupeKey: 'excuse:excuse:7', asOf: lastEventId() }, t);
  const byKey = (row) => /^real:/.test(String(row.dedupe_key ?? ''));
  const raw = getDb().prepare('SELECT * FROM story_thoughts').all();
  const rows = thoughtsBetween(0, clock.now() + 3600, 2000);
  const decoded = (id) => rows.find(r => r.id === id);
  const excuse = raw.find(r => r.dedupe_key === 'excuse:excuse:7');
  eq('a real thought: both yes', [isRealThought(decoded(real.id)), byKey(real)], [true, true]);
  eq('a stream excuse (same family): both no', [excuse.family, isRealThought(decoded(excuse.id)), byKey(excuse)], ['excuse', false, false]);
  check('every row: the two agree', raw.length === rows.length && raw.every(r => isRealThought(decoded(r.id)) === byKey(r)));
}

section('live only: a simulation never gets here');
{
  await fresh();
  const c = calls.length;
  await facade.dayView({});
  eq('the Day projection makes no call', calls.length, c);
}

section('guards');
{
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p); } return out; };
  const files = walk('src');
  eq('only the story facade imports them', files.filter(f => /from '[^']*thoughts\/(real|worker)\.js'/.test(fs.readFileSync(f, 'utf8'))).map(f => f.replace(/\\/g, '/')).sort(), ['src/life/story/index.js']);
  const src = fs.readFileSync('src/life/story/thoughts/worker.js', 'utf8') + fs.readFileSync('src/life/story/thoughts/real.js', 'utf8');
  check('no event, no send, no chat reads', !/appendEvent|\bappend\(|sendText|messageStore|getRecentMessages|\bmessages\b/.test(src));
  check('nothing reads them back into a decision or a prompt', !/realThought|isRealThought/i.test(fs.readFileSync('src/life/decisions.js', 'utf8') + fs.readFileSync('src/life/pulse.js', 'utf8') + fs.readFileSync('src/personality/systemPrompt.js', 'utf8') + fs.readFileSync('src/brain/contextBuilder.js', 'utf8') + fs.readFileSync('src/life/innerState.js', 'utf8')));
  check('codes only in its logs: no text', /const log = \(moment, status, code = null\)/.test(src) && !/log\([^)]*(text|user|res\.)/.test(src));
  check('no persona words in the charter', !/malayalam|manglish/i.test(real.THOUGHT_CHARTER));
  check('nothing sexual in the code\'s words', !/kiss|naked|lips|horny/i.test(Object.values(real).filter(v => typeof v === 'string').join(' ')));
}

await stopLife();
report();
process.exit(0);
