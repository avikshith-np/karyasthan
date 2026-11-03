// Plan 020 D3: what he said he'd do. One read-only code view across decisions (with weights), invitations, adopted claims, goals and text plans; a text with no plan
// behind it is flagged from the plan step's ring; the writers' sheets see a chat's plan only as "busy"; the sweep's rule on a promise past its time.
// Fixtures in the real event shapes, then the real log. Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import { commitmentRows, commitmentLines, CHAT_WHAT, FRIEND } from '../../src/life/commitments.js';
import { promiseCue, promiseDayEnd, strongCue } from '../../src/life/story/phone/plans.js';
import { runRules, RULES } from '../../src/life/sweep.js';
import { appendEvent, listEvents, getEvent } from '../../src/life/eventLog.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone, weekday } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { buildSheet } from '../../src/life/story/phone/facts.js';
import { renderUser as phoneRender } from '../../src/life/story/phone/charter.js';
import { config } from '../../src/utils/config.js';

const tz = 'UTC';
const T = (d, h, m = 0) => zonedToUnix(2026, 11, d, h, m, tz);
const NOW = T(10, 12);
const STATE = {
  cast: new Map([['cast:a', { name: 'Asha Quill' }], ['cast:b', { name: 'Bina Moss' }]]),
  story: { departed: { 'cast:gone': { name: 'Gone Member' } } },
  goals: {},
};
let nid = 100;
const ev = (type, at, payload = {}, extra = {}) => ({ id: nid++, type, at, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: null, subjectJid: null, heavy: false, redacted: false, ...extra });
const opened = (at, eventAt, { castIds = ['cast:a'], placeId = 'place:cafe', label = 'Coffee with Asha', ...p } = {}, extra = {}) =>
  ev('decision.opened', at, { kind: 'hangout', subject: { eventAt, placeId, castIds }, options: [{ id: 'go', label, go: true }, { id: 'late', label: 'Late', go: 'late' }, { id: 'stay', label: 'Stay in' }], ...p }, extra);
const commit = (d, at, optionId = 'go', by = 'lean', extra = {}) => ev('decision.committed', at, { decisionId: d.id, optionId, by }, extra);
const rowsOf = (decisions = [], o = {}) => commitmentRows(STATE, { at: NOW, decisions, causeOf: () => null, ...o });
const ONLY = (rows) => { eq('one row', rows.length, 1); return rows[0]; };

section('nothing yet');
{
  eq('no rows', rowsOf(), []);
  eq('no lines', commitmentLines([], { castId: 'cast:a', at: NOW, tz }), []);
}

section('decisions, with their weights');
{
  const d = opened(T(9, 9), T(11, 19));
  const own = ONLY(rowsOf([d, commit(d, T(9, 10))]));
  eq('his own lean: a wish, on, in the owner\'s words', [own.weight, own.status, own.source, own.who, own.what, own.when], [1, 'on', 'decision', 'Asha Quill', 'Coffee with Asha', T(11, 19)]);
  const owner = ONLY(rowsOf([d, commit(d, T(9, 10), 'go', 'owner', { actor: 'owner' })]));
  eq('the owner\'s pick weighs most', [owner.weight, owner.by], [3, 'owner']);
  const text = ONLY(rowsOf([d, commit(d, T(9, 10), 'go', 'text')]));
  eq('agreed in texts: a promise, from texts', [text.weight, text.source], [2, 'text']);
  eq('only leaning: nothing said yet', rowsOf([d, ev('decision.lean', T(9, 10), { decisionId: d.id, probs: { go: 0.9 } })]), []);
  eq('he said no: no commitment', rowsOf([d, commit(d, T(9, 10), 'stay')]), []);
  const late = ONLY(rowsOf([d, commit(d, T(9, 10), 'late')]));
  eq('coming late: still on', late.status, 'on');
}

section('what became of it: kept, overdue, backed out, fell through; old ones drop');
{
  const d = opened(T(8, 9), T(9, 19));
  const c = commit(d, T(8, 10));
  const moved = ev('activity.started', T(9, 19), { kind: 'hangout', placeId: 'place:cafe', withCast: ['cast:a'], decisionId: d.id });
  eq('he went: kept', ONLY(rowsOf([d, c], { moves: [moved] })).status, 'kept');
  const over = ONLY(rowsOf([d, c]));
  eq('past its time, nothing happened: overdue, and go_happened speaks for one with a place', [over.status, over.covered], ['overdue', true]);
  const noPlace = opened(T(8, 9), T(9, 19), { placeId: null });
  eq('…with no place the sweep\'s new rule speaks', ONLY(rowsOf([noPlace, commit(noPlace, T(8, 10))])).covered, false);
  const rev = ev('decision.reversed', T(9, 12), { decisionId: d.id, to: 'stay' });
  eq('took it back: broken', ONLY(rowsOf([d, c, rev])).status, 'broken');
  const exp = ev('decision.expired', T(9, 12), { decisionId: d.id, reason: 'could_not_go' });
  const lapsed = ONLY(rowsOf([d, c, exp]));
  eq('expired: fell through, with its reason', [lapsed.status, lapsed.code], ['lapsed', 'could_not_go']);
  const old = opened(T(1, 9), T(2, 19));
  eq('closed over a week ago: gone', rowsOf([old, commit(old, T(1, 10)), ev('decision.expired', T(2, 12), { decisionId: old.id, reason: 'x' })]), []);
}

section('age (review 6): gone a week after its own time, kept or not, so a kept outing the moves\' read no longer reaches never reads "never came off"');
{
  const old = opened(T(1, 9), T(2, 19));
  eq('over a week old with no moves in the read: no row, not overdue', rowsOf([old, commit(old, T(1, 10))]), []);
  const six = opened(T(3, 9), T(4, 19));
  eq('six days: still overdue', ONLY(rowsOf([six, commit(six, T(3, 10))])).status, 'overdue');
  const inv = opened(T(1, 9), T(2, 20), { castIds: [], invite: { pointerId: 5 } }, { originKind: 'group', originJid: 'x@g.us' });
  eq('an invitation nobody settled, over a week old: gone', rowsOf([inv]), []);
  const ahead = opened(T(9, 9), T(30, 19));
  eq('a plan far ahead is untouched', ONLY(rowsOf([ahead, commit(ahead, T(9, 10))])).status, 'on');
}

section('invitations and adopted claims: "a friend", "a plan from a chat", never a label, place or JID');
{
  const i = opened(T(10, 9), T(10, 20), { castIds: [], label: 'a movie at Secret Cinema with Rowan', invite: { pointerId: 5 } }, { originKind: 'group', originJid: 'x@g.us', subjectJid: '15550001001@s.whatsapp.net' });
  const r = ONLY(rowsOf([i]));
  eq('open', [r.status, r.source, r.who, r.what, r.fromChat, r.weight], ['open', 'invitation', FRIEND, CHAT_WHAT, true, 2]);
  const dump = JSON.stringify(r);
  check('no label, no JID, no chat on the row', !/Secret Cinema|Rowan|whatsapp|g\.us/.test(dump), dump);
  eq('nobody settled it past its time: overdue', commitmentRows(STATE, { at: T(10, 21), decisions: [i] })[0].status, 'overdue');
  const a = opened(T(9, 9), T(11, 20), { castIds: ['cast:a'], label: 'Dinner he promised', adopted: true, claimId: 7 }, { originKind: 'dm', originJid: 'y@s.whatsapp.net' });
  const ar = ONLY(rowsOf([a, commit(a, T(9, 10), 'go', 'adopted')]));
  eq('adopted: from a chat, a promise, even with a cast member the row names nobody', [ar.source, ar.what, ar.who, ar.castIds, ar.weight], ['claim', CHAT_WHAT, FRIEND, [], 2]);
  const rec = ev('commitment.recorded', T(9, 9), { dueAt: T(11, 9), placeId: 'place:cafe', castIds: ['cast:a'], label: 'Secret promise' }, { originKind: 'dm', originJid: 'y@s.whatsapp.net' });
  const rr = ONLY(rowsOf([], { recorded: [rec] }));
  eq('a commitment he said in a chat', [rr.status, rr.source, rr.what, rr.who, rr.fromChat], ['on', 'claim', CHAT_WHAT, FRIEND, true]);
  const past = ev('commitment.recorded', T(9, 9), { dueAt: T(9, 20), placeId: 'place:cafe', castIds: [], label: 'x' }, { originKind: 'dm' });
  eq('past due, nothing near it: overdue, the sweep\'s to say', [ONLY(rowsOf([], { recorded: [past] })).status, ONLY(rowsOf([], { recorded: [past] })).covered], ['overdue', false]);
  const seen = ev('activity.started', T(9, 20), { placeId: 'place:cafe', withCast: [] });
  eq('he was there: kept', ONLY(rowsOf([], { recorded: [past], moves: [seen] })).status, 'kept');
  const none = ev('commitment.recorded', T(9, 9), { dueAt: T(9, 20), castIds: [], label: 'x' }, { originKind: 'dm' });
  const nr = ONLY(rowsOf([], { recorded: [none], moves: [seen] }));
  eq('no place, nobody: nothing to check it by, so never "kept", and flagged softly', [nr.status, nr.soft], ['overdue', true]);
}

section('goals: the owner\'s, with what became of them; a fitted one is its decision\'s row');
{
  const s = { ...STATE, goals: {
    7: { id: 7, goalKind: 'meet', castId: 'cast:a', from: T(9, 0), to: T(12, 0), label: 'See Asha this week', status: 'open' },
    8: { id: 8, goalKind: 'call', castId: 'cast:b', from: T(9, 0), to: T(12, 0), label: null, status: 'fitted', fitted: { slotStart: T(10, 18) } },
    9: { id: 9, goalKind: 'meet', castId: 'cast:a', from: T(1, 0), to: T(9, 0), label: 'Old', status: 'open' },
    10: { id: 10, goalKind: 'outing', castId: null, from: T(1, 0), to: T(2, 0), label: 'Way back', status: 'done', closedAt: T(2, 0) },
    11: { id: 11, goalKind: 'meet', castId: 'cast:a', from: T(1, 0), to: T(12, 0), label: 'Called off', status: 'cancelled' },
    12: { id: 12, goalKind: 'meet', castId: 'cast:a', from: T(9, 0), to: T(12, 0), label: 'Fitted', status: 'fitted', fitted: { decisionId: 300 } },
  } };
  const d = opened(T(9, 9), T(11, 19), { goalId: 12 });
  const rows = commitmentRows(s, { at: NOW, decisions: [d, commit(d, T(9, 10), 'go', 'goal')] });
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  eq('open', [by['goal:7'].status, by['goal:7'].who, by['goal:7'].what, by['goal:7'].weight], ['open', 'Asha Quill', 'See Asha this week', 2]);
  eq('a fitted call, at its slot, in plain words', [by['goal:8'].status, by['goal:8'].when, by['goal:8'].what], ['on', T(10, 18), 'call them']);
  eq('run out and still open: overdue', by['goal:9'].status, 'overdue');
  eq('closed over a week ago, or cancelled: gone', [by['goal:10'], by['goal:11']], [undefined, undefined]);
  eq('fitted with a decision: one row, the decision\'s', [by['goal:12'], by[`decision:${d.id}`].source], [undefined, 'goal']);
}

section('a departed member: still named, so a promise to them reads true');
{
  const d = opened(T(9, 9), T(11, 19), { castIds: ['cast:gone'] });
  eq('named from the departed list', ONLY(rowsOf([d, commit(d, T(9, 10))])).who, 'Gone Member');
}

section('the cue: "see you Friday" and friends, as code words');
{
  for (const [text, want] of [
    ['see you Friday', { cue: 'see you', day: 'friday' }], ['ok see ya on fri', { cue: 'see you', day: 'fri' }], ['see u tomorrow!', { cue: 'see you', day: 'tomorrow' }],
    ['ok see you tonight', { cue: 'see you', day: 'tonight' }], ['see you at 8', { cue: 'see you then', day: null }], ['on my way', { cue: 'on my way', day: null }],
    ['I\'ll be there saturday', { cue: 'be there', day: 'saturday' }], ['coming over tomorrow', { cue: 'coming over', day: 'tomorrow' }],
    ['see you soon', null], ['how was friday', null], ['haha ok', null], ['', null], [null, null],
  ]) eq(`${JSON.stringify(text)}`, promiseCue(text), want);
  eq('the sweep\'s strong cue is what it was', [strongCue('see you Friday'), strongCue('on my way')], [null, 'on my way']);
  const mon = T(9, 10);   // Monday 9 Nov 2026
  eq('that really is a Monday', weekday(mon, tz), 1);
  eq('Friday: the coming one, to its end', promiseDayEnd('friday', mon, tz), T(13, 23, 59) + 59);
  eq('a Monday\'s "see you Monday": the next one', promiseDayEnd('monday', mon, tz), T(16, 23, 59) + 59);
  eq('tomorrow', promiseDayEnd('tomorrow', mon, tz), T(10, 23, 59) + 59);
  eq('tonight', promiseDayEnd('tonight', mon, tz), T(9, 23, 59) + 59);
  eq('no day', promiseDayEnd(null, mon, tz), null);
  // Review 9: "next".
  eq('"see you next Friday" says so', promiseCue('see you next Friday'), { cue: 'see you', day: 'friday', next: true });
  eq('"be there next sat"', promiseCue("I'll be there next saturday"), { cue: 'be there', day: 'saturday', next: true });
  eq('"this Friday" doesn\'t', promiseCue('see you this Friday'), { cue: 'see you', day: 'friday' });
  const nxt = { next: true };
  eq('next Friday, said on a Monday: next week\'s', promiseDayEnd('friday', mon, tz, nxt), T(20, 23, 59) + 59);
  eq('…said on a Thursday: a week and a day', promiseDayEnd('friday', T(12, 10), tz, nxt), T(20, 23, 59) + 59);
  eq('…said on a Friday: a week on', promiseDayEnd('friday', T(13, 10), tz, nxt), T(20, 23, 59) + 59);
  eq('…said on a Saturday: the coming one is already next week', promiseDayEnd('friday', T(14, 10), tz, nxt), T(20, 23, 59) + 59);
}

section('a text with no plan: flagged from the ring');
{
  const P = (over = {}) => ({ eventId: 500, castId: 'cast:a', at: T(9, 10), cue: 'see you', dayAt: T(13, 23, 59) + 59, ...over });
  const ring = (c = 'too_soon', o = 'refused', extra = {}) => ({ since: T(1, 0), entries: [{ id: 500, o, c, at: T(9, 10) }], ...extra });
  const r = ONLY(rowsOf([], { promises: [P()], ring: ring() }));
  eq('flagged, with what the step said', [r.status, r.flag, r.code, r.who, r.source, r.when], ['no_plan', true, 'too_soon', 'Asha Quill', 'text', T(13, 23, 59) + 59]);
  check('the words aren\'t on it, only the cue', r.what.includes('see you') && !r.what.includes('Friday'));
  eq('the step never looked', ONLY(rowsOf([], { promises: [P()], ring: { since: T(1, 0), entries: [] } })).code, 'never_looked');
  eq('older than the ring: it can\'t say', ONLY(rowsOf([], { promises: [P()], ring: { since: T(10, 0), entries: [] } })).code, 'unknown');
  eq('no ring at all', ONLY(rowsOf([], { promises: [P()], ring: null })).code, 'unknown');
  eq('the step failed', ONLY(rowsOf([], { promises: [P()], ring: ring('model_failed', 'nothing') })).code, 'model_failed');
  const d = opened(T(9, 9), T(13, 19));
  // Review 9: the phone sheet read "nothing is set" beside a plan with them in "his plans".
  const ahead = opened(T(9, 9), T(13, 15));
  eq('no day named, a plan with them four days on: no flag', rowsOf([ahead, commit(ahead, T(9, 11))], { promises: [P({ dayAt: null })], ring: ring() }).filter(x => x.flag), []);
  const far = opened(T(9, 9), T(17, 15));
  eq('…past the phone\'s week: the flag stands', rowsOf([far, commit(far, T(9, 11))], { promises: [P({ dayAt: null })], ring: ring() }).filter(x => x.flag).length, 1);
  const fell = opened(T(9, 9), T(13, 15));
  eq('a plan that fell through doesn\'t answer it', rowsOf([fell, commit(fell, T(9, 11)), ev('decision.expired', T(9, 13), { decisionId: fell.id, reason: 'could_not_go' })], { promises: [P()], ring: ring() }).filter(x => x.flag).length, 1);
  eq('a plan with them that day: no flag', rowsOf([d, commit(d, T(9, 11))], { promises: [P()], ring: ring('applied', 'applied') }).filter(x => x.flag), []);
  const late = opened(T(9, 9), T(12, 19), { castIds: ['cast:b'] });
  eq('someone else\'s plan doesn\'t answer it', rowsOf([late, commit(late, T(9, 11))], { promises: [P()], ring: ring() }).filter(x => x.flag).length, 1);
  const stay = opened(T(9, 9), T(13, 19));
  eq('a plan he said no to doesn\'t answer it', rowsOf([stay, commit(stay, T(9, 11), 'stay')], { promises: [P()], ring: ring() }).filter(x => x.flag).length, 1);
  const seen = ev('activity.started', T(9, 18), { placeId: 'place:cafe', withCast: ['cast:a'] });
  eq('they met since: no flag', rowsOf([], { promises: [P()], ring: ring(), moves: [seen] }), []);
  const after = commitmentRows(STATE, { at: T(14, 9), promises: [P()], ring: ring() });
  eq('its day has passed: overdue, not covered, the sweep\'s', [after[0].status, after[0].covered, after[0].flag], ['overdue', false, true]);
  eq('no day and a week old: gone', rowsOf([], { promises: [P({ dayAt: null, at: T(1, 10) })], ring: ring() }), []);
  const two = rowsOf([], { promises: [P(), P({ eventId: 501, at: T(9, 12) })], ring: ring() });
  eq('one row a person, the newest', [two.length, two[0].eventIds], [1, [501]]);
}

section('the order: what needs looking at first');
{
  const on = opened(T(9, 9), T(11, 19));
  const soon = opened(T(9, 9), T(10, 19), { castIds: ['cast:b'] });
  const over = opened(T(8, 9), T(9, 19), { placeId: null, castIds: ['cast:b'] });
  const rows = rowsOf([on, commit(on, T(9, 10)), soon, commit(soon, T(9, 10)), over, commit(over, T(8, 10))], { promises: [{ eventId: 500, castId: 'cast:gone', at: T(9, 10), cue: 'see you', dayAt: null }] });
  eq('overdue, no plan, then on, soonest first', rows.map(r => r.status), ['overdue', 'no_plan', 'on', 'on']);
  check('soonest first', rows[2].when < rows[3].when);
}

section('on a fictional person\'s sheet');
{
  const invite = { key: 'x', status: 'open', fromChat: true, castIds: [], who: FRIEND, what: CHAT_WHAT, when: NOW + 3 * HOUR };
  const later = { ...invite, when: NOW + 40 * HOUR };
  const flagged = { status: 'no_plan', flag: true, fromChat: false, castIds: ['cast:a'], who: 'Asha Quill', what: 'said', when: T(13, 23) };
  const goal = { status: 'open', fromChat: false, castIds: ['cast:a'], who: 'Asha Quill', what: 'See Asha this week', when: T(12, 0) };
  const broken = { status: 'broken', fromChat: false, castIds: ['cast:a'], who: 'Asha Quill', what: 'Coffee', when: T(9, 19) };
  const over = { status: 'overdue', fromChat: false, castIds: ['cast:a'], who: 'Asha Quill', what: 'Coffee', when: T(9, 19) };
  const other = { ...flagged, castIds: ['cast:b'], who: 'Bina Moss' };
  const his = commitmentLines([invite, later, flagged, goal, broken, over, other], { castId: 'cast:a', side: 'his', at: NOW, tz });
  check('a chat\'s plan: at most "maybe busy", and soon', his.some(l => l.endsWith('maybe busy (other plans)')) && his.filter(l => l.includes('busy')).length === 1, his);
  check('no chat words at all', !his.some(l => l.includes(CHAT_WHAT) || l.includes(FRIEND)), his);
  check('a promise with them', his.some(l => l.includes('sounded like') && l.includes('Asha Quill')));
  check('never someone else\'s', !his.some(l => l.includes('Bina')), his);
  eq('four at most', his.length, 4);
  const cast = commitmentLines([flagged, goal, broken, over], { castId: 'cast:a', side: 'cast', at: NOW, tz });
  check('their side: what they\'d know, not what he means to do or backed out of', !cast.some(l => l.includes('means to') || l.includes('backed out')) && cast.some(l => l.includes('sounded like')) && cast.some(l => l.includes('never came off')), cast);
  eq('a scene: no chat line', commitmentLines([invite], { castId: 'cast:a', side: 'scene', at: NOW, tz }), []);
  eq('what\'s on is "his plans"\' to say', commitmentLines([{ status: 'on', fromChat: false, castIds: ['cast:a'], who: 'A', what: 'x', when: NOW + HOUR }], { castId: 'cast:a', at: NOW, tz }), []);
}

section('the sweep\'s rule');
{
  check('it is on the list', RULES.includes('open_promise'));
  const run = (rows) => runRules({ from: T(1, 0), to: NOW, tz, read: () => [], getEvent: () => null, isOut: () => false, overduePromises: () => rows });
  const row = { key: 'claim:5', status: 'overdue', covered: false, flag: false, when: T(9, 20), what: CHAT_WHAT, who: FRIEND, eventIds: [5] };
  const f = run([row]).findings.filter(x => x.rule === 'open_promise');
  eq('a promise past its time', [f.length, f[0].severity, f[0].eventIds], [1, 'warn', [5]]);
  check('plain words, a chat\'s plan unnamed', f[0].text.includes(CHAT_WHAT) && f[0].text.includes('nothing came of it'), f[0].text);
  const flag = run([{ ...row, key: 'text:6', flag: true, what: 'x', who: 'Asha Quill', eventIds: [6] }]).findings.filter(x => x.rule === 'open_promise');
  eq('a text whose day passed: info', flag[0].severity, 'info');
  eq('nothing to check it by: info', run([{ ...row, soft: true }]).findings.find(x => x.rule === 'open_promise').severity, 'info');
  eq('covered by go_happened: not said twice', run([{ ...row, covered: true }]).findings.filter(x => x.rule === 'open_promise'), []);
  eq('not overdue', run([{ ...row, status: 'on' }]).findings.filter(x => x.rule === 'open_promise'), []);
  eq('outside the window', run([{ ...row, when: T(11, 0) }]).findings.filter(x => x.rule === 'open_promise'), []);
  eq('no reader wired (the dry run)', runRules({ from: T(1, 0), to: NOW, tz, read: () => [], getEvent: () => null, isOut: () => false }).findings.filter(x => x.rule === 'open_promise'), []);
}

// ── the real log ─────────────────────────────────────────────────────────────

await setupScratchDb();
const cr = fakeCallRole({ 'life.phone.plan': () => JSON.stringify({ agreed: false, kind: 'outing', placeHint: null, when: null, day: null, minutes: null, confidence: 0.1 }) });
const { life, clock, world } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: false }), knownNames: () => [], identity: async () => 'You are an example.' });
config.arcs.phoneOrganicPerDay = 0;
const ltz = resolveTimezone(world.timezone ?? config.timezone);
const FLAT = 'cast:flatmate';
const at = (day0, h, m = 0) => { const [y, mo, d] = dateKey(day0 + 12 * HOUR, ltz).split('-').map(Number); return zonedToUnix(y, mo, d, h, m, ltz); };
await simulateHours(1);
await story.idle();

section('the real log: an owner outing is on; its revert takes it off at once. Nothing stored, nothing appended');
let action = null;
{
  const before = listEvents({ order: 'desc', limit: 1 })[0].id;
  eq('a fresh life: no rows', life.commitmentsView().rows, []);
  const startAt = at(addDays(dayStart(clock.now(), ltz), 1, ltz), 15, 0);
  const p = await story.director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes: 90, castIds: [FLAT], label: 'coffee catch-up' }, { relax: true });
  const a = await story.director.apply(p.previewId, p.fingerprint);
  check('applied', a?.ok === true, JSON.stringify(a));
  action = a;
  const v = life.commitmentsView();
  eq('running', [v.running, v.counts.on], [true, 1]);
  const r = v.rows[0];
  eq('on, the owner\'s weight, in his own words', [r.status, r.weight, r.who.includes('Flatmate'), r.what, r.when, r.fromChat], ['on', 3, true, 'coffee catch-up', startAt, false]);
  check('no JID anywhere', !JSON.stringify(v).includes('whatsapp'));
  const added = listEvents({ after: before, limit: 500 }).length;
  life.commitmentsView();
  eq('reading it appends nothing', listEvents({ after: before, limit: 500 }).length, added);
  const prev = life.revertChangePreview(listEvents({ types: ['director.action'], order: 'desc', limit: 1 })[0].id);
  const rv = life.revertChange(prev.actionEventId, { fingerprint: prev.fingerprint });
  check('reverted', rv?.reverted?.length > 0, JSON.stringify(rv));
  eq('gone at once', life.commitmentsView().rows, []);
}

section('the real log: a text saying "see you Friday" with no plan, on his view and on the sheet');
{
  const SIB = 'cast:sibling';   // someone who doesn't live with him
  const turn = (text, dir = 'out') => {
    const e = appendEvent({ type: 'phone.message', at: clock.now(), actor: 'engine', payload: { castId: SIB, castIds: [SIB], dir, msgId: 1, trigger: 'owner', exchange: 0, tone: 'warm', length: 1, bubbles: 1, textSha: 'x' } });
    const id = phoneStore.insertPending({ castId: SIB, dir, trigger: 'owner', triggerEventId: e.id, exchange: 0, dueAt: clock.now(), createdAt: clock.now() });
    phoneStore.update(id, { status: 'live', eventId: e.id, text, at: clock.now() });
    return e;
  };
  const e = turn('ok see you Friday');
  phoneStore.notePlanOutcome({ eventId: e.id, outcome: 'refused', code: 'too_soon', at: clock.now() });
  const v = life.commitmentsView();
  const row = v.rows.find(r => r.flag);
  check('flagged', !!row, JSON.stringify(v.rows));
  eq('what the plan step said', [row.status, row.code], ['no_plan', 'too_soon']);
  check('…its day is the coming Friday', row.when > clock.now() && weekday(row.when, ltz) === 5, row.when);
  check('the words stay off it', !JSON.stringify(row).includes('ok see you'));
  const lines = commitmentLines(v.rows, { castId: SIB, side: 'his', at: clock.now(), tz: ltz });
  const s = life.getState();
  const sheet = buildSheet(s, { castId: SIB, trigger: 'reply', dir: 'out' }, { tz: ltz, at: clock.now(), side: 'his', trigger: 'reply', persona: { displayName: 'Him' }, thread: [], commitments: lines }).sheet;
  const out = phoneRender(sheet);
  check('on the sheet under his commitments', out.includes('his commitments') && out.includes('sounded like they\'d meet'), out.slice(0, 300));
  eq('no sheet line without a commitment', phoneRender(buildSheet(s, { castId: SIB, trigger: 'reply', dir: 'out' }, { tz: ltz, at: clock.now(), side: 'his', trigger: 'reply', persona: { displayName: 'Him' }, thread: [] }).sheet).includes('his commitments'), false);
  // Past its day: the sweep says so.
  await simulateHours(8 * 24);
  const all = life.runSweepNow().findings.filter(f => f.rule === 'open_promise');
  check('its day came and went: the sweep flags it (info)', all.some(f => f.severity === 'info' && f.eventIds.includes(e.id)), JSON.stringify(all));
  void getEvent;
}

report();
