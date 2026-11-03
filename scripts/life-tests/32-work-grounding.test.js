// Work grounding (a live reply invented "a US client, manager David, Mark and
// Sarah" for his 3pm meeting, then asked "which <name>?" about a real
// coworker). His meetings carry who is in them — routine.js rolls 1–3 of the
// work cast per date and meeting, the manager in some but not all, and they
// are not company (no shared time, social drain or decision news); plans from
// before still fold. The inner line names the attendees (now, and "a meeting
// at HH:MM with …"); work talk, or a question about his day while he's at work,
// pulls the work cast into the cards (manager first); names and relation words
// match with a short suffix ("managerum", "flatmateinte") while short terms
// stay whole words; every new phrase and card keeps the audience rule; and the
// reply prompt grounds the cast (new header + the no-invented-names rule) only
// when life lines are there — byte-identical with life off. Scratch DB, fake
// clock, example world; no network, no LLM.
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, setupScratchDb, fakeClock, section, check, eq, report } from './_helpers.js';
import { setClock, atLocal, hhmm } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { loadWorld, validateWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended, project } from '../../src/life/projector.js';
import { planDay, checkPlan } from '../../src/life/routine.js';
import * as vitals from '../../src/life/vitals.js';
import { detectTriggers } from '../../src/life/decisions.js';
import { noteSelfMention, resetClaimCounters } from '../../src/life/claims.js';
import { config } from '../../src/utils/config.js';
import { innerStateLine, castCards, setBlockOrigin, setCanUseIn } from '../../src/life/innerState.js';

await setupScratchDb();
setRngSeed('work-grounding');
const { integrate } = vitals;
const companyOf = vitals.companyOf ?? (() => null); // a namespace read, so the file still runs (and fails) without it
const { buildConversationContext, buildSystemParts } = await import('../../src/personality/systemPrompt.js');
const life = await import('../../src/life/index.js');

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const TZ = createInitialState(world).world.timezone;
const T0 = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '13:00', TZ); // Wed 28 Oct (an office day), 13:00 local
const clock = fakeClock(T0);
setClock(clock.fn);
const MIN = 60;
const H = 3600;
const at = (min) => T0 + min * MIN;
const GROUP_X = '120363000000000001@g.us';
const GROUP_Y = '120363000000000002@g.us';
const ALICE = '15550000001@s.whatsapp.net';
const audX = { chatJid: GROUP_X, kind: 'group', members: new Set([ALICE]) };
const audY = { chatJid: GROUP_Y, kind: 'group', members: new Set([ALICE]) };
const dash = { kind: 'dashboard' };
const MANAGER = 'cast:manager';
const CO_A = 'cast:coworker-a';
const CO_B = 'cast:coworker-b';
const WORK = new Set([MANAGER, CO_A, CO_B]);
const has = (s, w) => s.toLowerCase().includes(w.toLowerCase());
const cardFor = (cards, prefix) => cards.some(c => c.startsWith(prefix));

try {
  section('meeting attendees in the plan (routine.js)');
  const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/world.example.json'), 'utf-8'));
  const w = validateWorld({ ...example, timezone: 'UTC' }, { now: Date.UTC(2026, 9, 28) / 1000 });
  const calm = { vitals: { sleepDebt: 0, workPressure: 40, energy: 70, socialBattery: 60, stress: 30 } };
  const noWork = { ...w, cast: w.cast.filter(c => c.relation !== 'manager' && c.relation !== 'coworker') };
  const meetings = [];
  let workdays = 0;
  for (let d = 0; d < 70; d++) {
    const day = Date.UTC(2026, 9, 26 + d, 6, 0) / 1000;
    const p = planDay(calm, day, w);
    if (p.dayType !== 'office' && p.dayType !== 'wfh') continue;
    workdays++;
    const ms = p.blocks.filter(b => b.kind === 'meeting');
    meetings.push(...ms);
    const again = planDay(calm, day, w);
    if (JSON.stringify(again) !== JSON.stringify(p)) check(`${p.date}: the same day plans the same way`, false);
    const bare = planDay(calm, day, noWork);
    const times = (x) => x.blocks.filter(b => b.kind === 'meeting').map(b => [b.start, b.end]);
    if (JSON.stringify(times(bare)) !== JSON.stringify(times(p))) check(`${p.date}: attendees never move the meetings`, false, [times(bare), times(p)]);
    if (bare.blocks.some(b => b.kind === 'meeting' && 'withCast' in b)) check(`${p.date}: no work cast → no withCast`, false);
    if (checkPlan(p, w).length) check(`${p.date}: plan is sound`, false, checkPlan(p, w));
  }
  check(`${workdays} work days, ${meetings.length} meetings`, workdays >= 40 && meetings.length >= workdays);
  check('every meeting has 1–3 attendees, all work cast, no repeats',
    meetings.every(b => Array.isArray(b.withCast) && b.withCast.length >= 1 && b.withCast.length <= 3
      && b.withCast.every(id => WORK.has(id)) && new Set(b.withCast).size === b.withCast.length),
    meetings.map(b => b.withCast));
  check('… not social, still "meeting" availability', meetings.every(b => b.social !== true && b.availability === 'meeting'));
  check('… the manager listed first when there', meetings.every(b => !(b.withCast || []).includes(MANAGER) || b.withCast[0] === MANAGER));
  const withBoss = meetings.filter(b => (b.withCast || []).includes(MANAGER)).length;
  check(`the manager sits in on some meetings, not all (${withBoss}/${meetings.length})`,
    withBoss > meetings.length * 0.2 && withBoss < meetings.length * 0.8);
  check('… and some meetings are bigger than one person', meetings.some(b => (b.withCast || []).length >= 2));
  const lunch = planDay(calm, Date.UTC(2026, 9, 28, 6, 0) / 1000, w).blocks.find(b => b.kind === 'lunch');
  eq('office lunch unchanged (two coworkers, social)', [lunch?.withCast, lunch?.social], [[CO_A, CO_B], true]);

  section('old plans still fold');
  const old = {
    date: '2026-10-28', dayType: 'office', wakeAt: at(-330), lateBy: 0, sleepAt: at(630), nextWakeAt: at(1110), workLate: null, skipped: [],
    blocks: [
      { kind: 'work', placeId: 'place:office', start: at(-330), end: at(120), availability: 'light' },
      { kind: 'meeting', placeId: 'place:office', start: at(120), end: at(165), availability: 'meeting' },
      { kind: 'work', placeId: 'place:office', start: at(165), end: at(630), availability: 'light' },
      { kind: 'sleep', placeId: 'place:home', start: at(630), end: at(1110), availability: 'asleep' },
    ],
  };
  let folded = createInitialState(world);
  folded = project(folded, { id: 1, at: at(-330), type: 'plan.made', actor: 'engine', causeId: null, payload: old,
    originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false }, world);
  const oldMeeting = folded.plan?.blocks?.find(b => b.kind === 'meeting');
  eq('a pre-attendee meeting folds with withCast []', [oldMeeting?.start, oldMeeting?.withCast], [at(120), []]);
  folded = project(folded, { id: 2, at: at(120), type: 'activity.started', actor: 'engine', causeId: 1,
    payload: { kind: 'meeting', placeId: 'place:office', end: at(165), availability: 'meeting', withCast: [], social: false },
    originKind: 'self', originJid: 'self', subjectJid: null, heavy: false, redacted: false }, world);
  eq('… and its activity too', folded.activity.withCast, []);
  eq('… no shared-time session opened', Object.keys(folded.story?.together ?? {}), []);

  section('attendees are not company');
  const meetingAct = { kind: 'meeting', placeId: 'place:office', withCast: [CO_A], social: false };
  eq('companyOf(meeting with attendees) → []', companyOf(meetingAct), []);
  eq('companyOf(lunch with coworkers) → them', companyOf({ kind: 'lunch', withCast: [CO_A] }), [CO_A]);
  eq('companyOf(a meeting marked social) → them', companyOf({ ...meetingAct, social: true }), [CO_A]);
  const v0 = { energy: 70, stress: 30, hunger: 30, socialBattery: 60, sleepDebt: 0, workPressure: 40, mood: { valence: 0.1, arousal: 0.4 } };
  eq('vitals in a meeting: attendees change nothing (no social drain)',
    integrate(v0, meetingAct, 45, world, { hour: 15 }), integrate(v0, { kind: 'meeting', placeId: 'place:office' }, 45, world, { hour: 15 }));
  check('control: a social lunch does drain', integrate(v0, { kind: 'lunch', withCast: [CO_A], social: true }, 45, world, { hour: 13 }).socialBattery
    < integrate(v0, { kind: 'lunch' }, 45, world, { hour: 13 }).socialBattery);
  const gymWithA = { id: 50, status: 'open', kind: 'gym', subject: { castIds: [CO_A] }, options: [{ id: 'go' }, { id: 'skip' }], opensAt: at(0), decideBy: at(600) };
  const started = (id, payload) => ({ id, at: at(1), type: 'activity.started', payload, originKind: 'self', originJid: 'self' });
  eq('a meeting with her is no news for a decision about her',
    detectTriggers(gymWithA, { vitals: {} }, { at: at(1), newEvents: [started(51, meetingAct)], world }).map(t => t.trigger), []);
  eq('control: lunch with her is', detectTriggers(gymWithA, { vitals: {} }, { at: at(1), newEvents: [started(52, { kind: 'lunch', withCast: [CO_A], social: true })], world })
    .map(t => t.trigger), ['new_info']);

  // ── A projection on real events (default origin lookup) ─────────────────
  let live = createInitialState(world);
  const add = (spec) => {
    const ev = appendEvent(spec);
    live = applyAppended(live, ev, { world });
    return ev;
  };
  const genesis = add({ type: 'genesis', at: T0 - 6 * H, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0 - 6 * H, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) add({ type: 'cast.created', at: T0 - 6 * H, actor: 'engine', causeId: genesis.id, payload: c });

  section('the inner line names the attendees');
  const plan = add({ type: 'plan.made', at: T0 - 5 * H, actor: 'engine', payload: {
    date: '2026-10-28', dayType: 'office', wakeAt: T0 - 5 * H, lateBy: 0, sleepAt: at(630), nextWakeAt: at(1110), workLate: null, skipped: [],
    blocks: [
      { kind: 'work', placeId: 'place:office', start: T0 - 5 * H, end: at(30), availability: 'light' },
      { kind: 'meeting', placeId: 'place:office', start: at(30), end: at(75), availability: 'meeting', withCast: [CO_A, CO_B], social: false },
      { kind: 'work', placeId: 'place:office', start: at(75), end: at(120), availability: 'light' },
      { kind: 'meeting', placeId: 'place:office', start: at(120), end: at(165), availability: 'meeting', withCast: [CO_A], social: false },
      { kind: 'work', placeId: 'place:office', start: at(165), end: at(630), availability: 'light' },
      { kind: 'sleep', placeId: 'place:home', start: at(630), end: at(1110), availability: 'asleep' },
    ] } });
  add({ type: 'activity.started', at: at(0), actor: 'engine', causeId: plan.id,
    payload: { kind: 'work', placeId: 'place:office', end: at(30), availability: 'light' } });
  let line = innerStateLine(live, at(5), audX);
  check('next: "a meeting at 13:30 with Coworker A … and Coworker B …"',
    line.includes(`a meeting at ${hhmm(at(30), TZ)} with Coworker A (example) and Coworker B (example)`), line);
  const inMeeting = add({ type: 'activity.started', at: at(30), actor: 'engine', causeId: plan.id,
    payload: { kind: 'meeting', placeId: 'place:office', end: at(75), availability: 'meeting', withCast: [CO_A, CO_B], social: false } });
  line = innerStateLine(live, at(40), audX);
  check('now: "in a meeting with Coworker A … and Coworker B … till 14:15"',
    has(line, `in a meeting with Coworker A (example) and Coworker B (example) till ${hhmm(at(75), TZ)}`), line);
  check('≤ 240 chars', line.length <= 240, line);
  eq('the current meeting\'s attendees get cards without being named', castCards(live, at(40), audX, '').map(c => c.slice(0, 10)).sort(),
    ['Coworker C', 'Coworker C']);
  check('… and never shared time with them', !(live.story?.together?.[CO_A]?.openSince));

  section('a planned day: routine → plan → line');
  {
    const day = planDay(live, T0, world);
    const first = day.blocks.find(b => b.kind === 'meeting');
    check('today\'s routine plan has a meeting with attendees', !!first && (first.withCast || []).length >= 1, day.blocks.map(b => b.kind));
    const s = structuredClone(live);
    s.plan = { ...day, eventId: plan.id };
    s.activity = { kind: 'work', placeId: world.self.job.officePlaceId, startAt: first.start - 30 * MIN, endAt: first.start, availability: 'light', withCast: [], social: false, eventId: plan.id };
    const names = (first?.withCast || []).map(id => world.cast.find(c => c.id === id).name);
    const l = innerStateLine(s, first.start - 20 * MIN, audX);
    check('the line names every attendee of the next meeting', names.length > 0 && names.every(n => l.includes(n)) && l.includes(`a meeting at ${hhmm(first.start, TZ)} with`), [names, l]);
  }

  section('work talk pulls in the work cast');
  add({ type: 'activity.ended', at: at(75), actor: 'engine', payload: { kind: 'meeting' } });
  add({ type: 'activity.started', at: at(75), actor: 'engine', causeId: plan.id,
    payload: { kind: 'work', placeId: 'place:office', end: at(120), availability: 'light' } });
  // The live bug: the 15:00-style meeting is with Coworker A only, and someone asks who it's with.
  let cards = castCards(live, at(80), audX, 'who is the 14:00 meeting with?');
  check('"who is the meeting with?" → the manager card too (manager not invited)', cardFor(cards, 'Manager'), cards);
  check('… and the attendee', cards.some(c => c.includes('Coworker A')), cards);
  check('… at most 3', cards.length <= 3, cards);
  cards = castCards(live, at(80), audX, '');
  eq('nothing said: only the next meeting\'s attendee', cards.map(c => c.slice(0, 20)), ['Coworker Coworker A ']);
  const evening = structuredClone(live);
  evening.plan = { ...evening.plan, blocks: [] };
  evening.activity = { kind: 'tv', placeId: 'place:home', startAt: at(400), endAt: at(500), availability: 'free', withCast: [], social: false, eventId: null };
  cards = castCards(evening, at(410), audX, 'how was the office today?');
  check('"how was the office" (at home) → manager first', cards.length >= 1 && cards[0].startsWith('Manager'), cards);
  check('… then coworkers', cards.length === 3 && cards.slice(1).every(c => c.startsWith('Coworker')), cards);
  cards = castCards(evening, at(410), audX, 'any colleagues coming tonight?');
  check('"colleagues" → the work cast', cardFor(cards, 'Manager') && cards.some(c => c.includes('Coworker A')), cards);
  eq('"what are you up to today?" at home → no work cards', castCards(evening, at(410), audX, 'what are you up to today?'), []);
  cards = castCards(live, at(80), audX, 'what are you up to today?');
  check('… at the office → the manager card', cardFor(cards, 'Manager'), cards);
  eq('"workout later?" is not work', castCards(evening, at(410), audX, 'workout later?'), []);
  eq('his own work talk does not pull them in', castCards(evening, at(410), audX, [{ text: 'office was long', fromMe: true }]), []);

  section('suffix-tolerant names and relation words');
  cards = castCards(evening, at(410), audX, 'managerum vannille?');
  check('"managerum" → the manager', cards[0]?.startsWith('Manager'), cards);
  check('"managerinte" → the manager', castCards(evening, at(410), audX, 'managerinte mood engane?')[0]?.startsWith('Manager'));
  eq('"flatmateinte" → the flatmate', castCards(evening, at(410), audX, 'flatmateinte birthday eppozha').map(c => c.slice(0, 8)), ['Flatmate']);
  check('"roommates" → the flatmate', cardFor(castCards(evening, at(410), audX, 'roommates ok?'), 'Flatmate'));
  check('"brotherinte" → the sibling (he/him)', castCards(evening, at(410), audX, 'brotherinte exam?').some(c => c.includes('Sibling')));
  eq('"momentum" stays clear of "mom"', castCards(evening, at(410), audX, 'good momentum this week'), []);
  check('… while "mom" still matches', castCards(evening, at(410), audX, 'call your mom').some(c => c.includes('Parent')));
  eq('"broke" stays clear of "bro"', castCards(evening, at(410), audX, 'I am broke'), []);
  eq('a term must start a word ("flatmate" inside "xflatmate")', castCards(evening, at(410), audX, 'xflatmate'), []);
  eq('limit still 3', castCards(evening, at(410), audX, 'managerum, flatmateinte, brotherinte, mom, office').length, 3);

  section('audience: every new phrase and card');
  // The 14:00 meeting is a block of a plan amended from group X.
  const trig = add({ type: 'chat.trigger', at: at(76), actor: 'chat', originKind: 'group', originJid: GROUP_X, payload: { kind: 'plan' } });
  setBlockOrigin((p, b) => (b.kind === 'meeting' && b.start === at(120) ? trig.id : p.eventId));
  check('X: the chat-origin meeting names its attendee', innerStateLine(live, at(80), audX).includes('with Coworker A'), innerStateLine(live, at(80), audX));
  check('Y: no attendee, no meeting', !has(innerStateLine(live, at(80), audY), 'meeting'), innerStateLine(live, at(80), audY));
  eq('Y: no attendee card when nobody named them', castCards(live, at(80), audY, ''), []);
  check('dashboard: sees it', innerStateLine(live, at(80), dash).includes('with Coworker A'));
  setBlockOrigin(null);
  // A meeting he's in that a chat in X caused.
  const s2 = structuredClone(live);
  s2.activity = { kind: 'meeting', placeId: 'place:office', startAt: at(80), endAt: at(110), availability: 'meeting', withCast: [MANAGER], social: false, eventId: trig.id };
  s2.availability = { state: 'meeting', since: at(80), until: at(110), onPhone: false, eventId: trig.id };
  check('X: "in a meeting with Manager …"', has(innerStateLine(s2, at(90), audX), 'in a meeting with Manager (example)'), innerStateLine(s2, at(90), audX));
  check('Y: tone only, no names', !has(innerStateLine(s2, at(90), audY), 'Manager'), innerStateLine(s2, at(90), audY));
  eq('Y: no attendee card', castCards(s2, at(90), audY, ''), []);
  eq('Y: "up to today?" — the chat-caused meeting does not count as "at work"', castCards(s2, at(90), audY, 'what are you up to today?'), []);
  check('X: the attendee card', cardFor(castCards(s2, at(90), audX, ''), 'Manager'));
  setCanUseIn((item, aud) => item.originJid === GROUP_X && aud.chatJid === GROUP_Y);
  check('an injected canUseIn (X → Y) lets Y see the attendee', innerStateLine(s2, at(90), audY).includes('Manager (example)')
    && cardFor(castCards(s2, at(90), audY, ''), 'Manager'));
  setCanUseIn(null);
  resetClaimCounters();
  for (let i = 0; i <= config.life.selfMentionBudget; i++) noteSelfMention(GROUP_X, at(80));
  cards = castCards(live, at(80), audX, 'who is the meeting with?');
  eq('over the self-mention budget: no work or attendee cards', cards, []);
  resetClaimCounters();
  const emb = structuredClone(live);
  emb.embargo = { until: at(600), eventId: 1, heavyEventId: 1, startedAt: at(70) };
  eq('embargo: no work or attendee cards', castCards(emb, at(80), audX, 'how is work?'), []);
  eq('embargo: someone naming the manager still gets that card', castCards(emb, at(80), audX, 'managerum?').map(c => c.slice(0, 7)), ['Manager']);

  section('the reply prompt grounds the cast');
  const tr = { id: 'G-1', groupJid: GROUP_X, senderJid: ALICE, senderName: 'Alice', content: 'who is the meeting with?', messageType: 'text' };
  const plain = buildConversationContext(GROUP_X, tr, true, { audience: audX }).text;
  const lines = { time: 'Now: Wed 28 Oct, 14:20.', inner: 'At the office, at the desk; a meeting at 15:00 with Coworker A (example).', cards: ['Coworker Coworker A (example) (she/her): organised'] };
  const grounded = buildConversationContext(GROUP_X, tr, true, { audience: audX, life: { availability: 'light', lines } }).text;
  check('new header', grounded.includes("People in your life (they aren't in this chat):\n- Coworker Coworker A"), grounded.slice(-1500));
  check('old header gone', !grounded.includes('People from your own life'));
  check('the grounding rule', grounded.includes('These are the only coworkers, manager, flatmate and family you have')
    && grounded.includes('never make anyone up'));
  check('… once, after the cards and before the situation note',
    grounded.split('never invent other names').length === 2
    && grounded.indexOf('- Coworker Coworker A') < grounded.indexOf('These are the only')
    && grounded.indexOf('These are the only') < grounded.indexOf('This is just your situation right now'));
  const innerOnly = buildConversationContext(GROUP_X, tr, true, { audience: audX, life: { availability: 'light', lines: { ...lines, cards: [] } } }).text;
  check('an inner line alone also gets the rule (no header)', innerOnly.includes('These are the only coworkers') && !innerOnly.includes('People in your life'));
  const timeOnly = buildConversationContext(GROUP_X, tr, true, { audience: audX, life: { availability: 'light', lines: { time: lines.time, inner: '', cards: [] } } }).text;
  check('only a time line → no header, no rule', !timeOnly.includes('These are the only') && !timeOnly.includes('People in your life'));
  check('no life opt → no rule', !plain.includes('These are the only') && !plain.includes('People in your life'));
  const { core, profile } = buildSystemParts(GROUP_X, true, null, { audience: audX, track: false });
  check('the rule and header live in the per-turn text, never the cached core',
    !`${core}\n${profile}`.includes('These are the only') && !`${core}\n${profile}`.includes('People in your life'));
  eq('life off (engine not running): byte-identical prompt', life.isLifeOn(), false);
  eq('… with the life opt', buildConversationContext(GROUP_X, tr, true, { audience: audX, life: { availability: 'light' } }).text, plain);
  eq('zero network calls', fetches, 0);
} finally {
  setBlockOrigin(null);
  setCanUseIn(null);
  setClock(null);
}
report();
