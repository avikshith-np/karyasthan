// Plan 020 §F1: thought vs deed. What he leaned to vs what he did, from the log: the true cause in
// code words, no storage, no model call, chat-origin items by code label only. Fixtures in the
// real event shapes, then a run on the engine: a draw against the lean and a chat-nudged evening.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, HOUR, DAY } from '../arcs-tests/_helpers.js';
import { buildThoughtDeed, ThoughtDeedError } from '../../src/life/thoughtDeed.js';
import { foldDecisions } from '../../src/life/decisionLog.js';
import { zonedToUnix, dateKey } from '../../src/life/clock.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { getDb } from '../../src/memory/db.js';

const tz = 'UTC';
const T = (d, h, m = 0) => zonedToUnix(2026, 11, d, h, m, tz);
const NOW = T(12, 12);
const DATE = '2026-11-10';
const JID = '15550000072@s.whatsapp.net';
const WORDS = 'meet me at the secret bar';

function world() {
  let id = 100;
  const events = [];
  const add = (type, at, payload = {}, extra = {}) => {
    const e = { id: id++, type, at, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: null, subjectJid: null, heavy: false, redacted: false, ...extra };
    events.push(e);
    return e;
  };
  const view = (date = DATE, at = NOW) => buildThoughtDeed({
    running: true, date, at, tz,
    read: (a, b, types) => events.filter(e => e.at >= a && e.at <= b && types.includes(e.type)).sort((x, y) => x.at - y.at || x.id - y.id),
    getEvent: (i) => events.find(e => e.id === i) ?? null,
  });
  return { add, view, events };
}
const opened = (w, { at = T(10, 9), eventAt = T(10, 19), placeId = 'place:cafe', kind = 'hangout', extra = {}, payload = {} } = {}) => w.add('decision.opened', at, {
  kind, subject: { eventAt, placeId, castIds: ['cast:ana'], endAt: eventAt + 7200 }, opensAt: at, decideBy: eventAt - 3600, ponrAt: eventAt - 1800,
  options: [{ id: 'go', go: true, label: 'Coffee with Ana', minutes: 120 }, { id: 'late', go: 'late', label: 'Join late' }, { id: 'stay', label: 'Stay in' }],
  ...payload,
}, extra);
const lean = (w, d, at, optionId, p, extra = {}, more = {}) => w.add('decision.lean', at, { decisionId: d.id, optionId, p, trigger: 'deadline_near', ...more }, { causeId: d.id, actor: 'jev', ...extra });
const commit = (w, d, at, optionId, by, more = {}, extra = {}) => w.add('decision.committed', at, { decisionId: d.id, optionId, p: 0.5, sampled: by === 'sample', by, ...more }, { causeId: d.id, ...extra });
const went = (w, at, placeId = 'place:cafe') => w.add('activity.started', at, { kind: 'hangout', placeId, end: at + 7200, withCast: ['cast:ana'] });

section('the line the owner asked for');
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'stay', 0.72);
  commit(w, d, T(10, 17), 'go', 'sample');
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('a draw against his lean', r.text, 'leaning stay (0.72)… went anyway (deadline draw)');
  eq('…flagged', [r.against, r.deed.cause, r.deed.went], [true, 'draw', true]);
  eq('…with its label', r.label, 'Coffee with Ana');
}
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'go', 0.81);
  commit(w, d, T(10, 16), 'go', 'early');
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('with his lean', [r.text, r.against], ['leaning go (0.81)… went (an early commit)', false]);
}
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'go', 0.55);
  commit(w, d, T(10, 17), 'stay', 'sample');
  const [r] = w.view().rows;
  eq('leaning go, drew stay', r.text, 'leaning go (0.55)… stayed anyway (deadline draw)');
}

section('no lean at all: an owner commit');
{
  const w = world();
  const d = opened(w);
  commit(w, d, T(10, 10), 'go', 'owner', {}, { actor: 'owner', originKind: 'owner' });
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('no lean, the owner', [r.text, r.against, r.leanCount, r.lastLean, r.deed.cause], ['no lean… went (the owner)', false, 0, null, 'owner']);
}

section('fallback leans');
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'stay', 0.6, { actor: 'engine' }, { fallback: 'jev_error' });
  commit(w, d, T(10, 17), 'stay', 'sample');
  const [r] = w.view().rows;
  eq('kept as a code on the lean', [r.leans[0].fallback, r.leans[0].by], ['jev_error', 'engine']);
  eq('…and the line reads the same', r.text, 'leaning stay (0.60)… stayed (deadline draw)');
}

section('several reversals');
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 12), 'go', 0.85);
  commit(w, d, T(10, 12), 'go', 'early');
  lean(w, d, T(10, 13), 'stay', 0.9);
  w.add('decision.reversed', T(10, 13), { decisionId: d.id, from: 'go', to: 'stay', p: 0.9 });
  lean(w, d, T(10, 15), 'go', 0.9);
  w.add('decision.reversed', T(10, 15), { decisionId: d.id, from: 'stay', to: 'go', p: 0.9 });
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('two reversals, in order', r.deed.reversals.map(x => [x.from, x.to]), [['go', 'stay'], ['stay', 'go']]);
  eq('…in the line', r.text, 'leaning go (0.90)… went, changed his mind 2 times (an early commit)');
  eq('…every lean kept', r.leans.map(l => l.optionId), ['go', 'stay', 'go']);
  eq('…status', r.deed.status, 'reversed');
}
{
  const w = world();
  const d = opened(w);
  commit(w, d, T(10, 10), 'go', 'owner', {}, { actor: 'owner', originKind: 'owner' });
  w.add('decision.reversed', T(10, 11), { decisionId: d.id, from: 'go', to: 'stay', p: 0.9 });
  const f = foldDecisions(w.events).get(d.id);
  eq('an engine reversal can\'t move an owner pick (as the projector folds it)', [f.reversals.length, f.final.optionId], [0, 'go']);
}

section('an expired decision');
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'go', 0.7);
  commit(w, d, T(10, 17), 'go', 'sample');
  w.add('decision.expired', T(10, 18), { decisionId: d.id, reason: 'could_not_go' });
  const [r] = w.view().rows;
  eq('committed, then couldn\'t', [r.text, r.deed.status, r.deed.cause, r.deed.went], ["leaning go (0.70)… expired: he couldn't make it", 'expired', 'could_not_go', null]);
}
{
  const w = world();
  const d = opened(w);
  w.add('decision.expired', T(10, 18), { decisionId: d.id, reason: 'some_new_reason' });
  const [r] = w.view().rows;
  eq('a reason this file has never heard of, in words', r.text, 'no lean… expired: some new reason');
}
{
  const w = world();
  const d = opened(w, { eventAt: T(13, 19), at: T(10, 9) });
  lean(w, d, T(10, 16), 'go', 0.4);
  const [r] = w.view().rows;
  eq('still open', [r.text, r.deed.status, r.against], ['leaning go (0.40)… still open', 'open', false]);
}
{
  const w = world();
  const d = opened(w, { eventAt: T(13, 19), at: T(10, 9) });
  lean(w, d, T(10, 16), 'go', 0.9);
  commit(w, d, T(10, 16), 'go', 'early');
  const row = w.view().rows[0];
  eq('committed, the outing still ahead: says so, never "never went"', [row.text, row.deed.went], ['leaning go (0.90)… chose go, still ahead (an early commit)', null]);
}
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'go', 0.9);
  commit(w, d, T(10, 16), 'go', 'early');
  const row = w.view().rows[0];
  eq('committed, the time long past, nothing logged', [row.text, row.deed.went], ['leaning go (0.90)… chose go but never went (an early commit)', false]);
}

{
  const w = world();
  const d = opened(w, { placeId: null });
  lean(w, d, T(10, 16), 'go', 0.9);
  commit(w, d, T(10, 16), 'go', 'early');
  const row = w.view().rows[0];
  eq('a go with no place, long past: the pulse never moves him for it, so never "never went"', [row.text, row.deed.went], ['leaning go (0.90)… chose go (an early commit)', null]);
}

section('chat-origin items: code labels only');
{
  const w = world();
  const trig = w.add('chat.trigger', T(10, 14), { trigger: 'chat_mention' }, { actor: 'chat', originKind: 'group', originJid: '1203@g.us' });
  const d = opened(w);
  lean(w, d, T(10, 14), 'go', 0.65, { causeId: trig.id, originKind: 'group', originJid: '1203@g.us' }, { trigger: 'chat_mention' });
  commit(w, d, T(10, 17), 'go', 'sample');
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('his own plan a chat nudged keeps its label, the lean is marked', [r.fromChat, r.chatNudged, r.leans[0].fromChat, r.label], [false, true, true, 'Coffee with Ana']);
  check('…no chat id anywhere', !JSON.stringify(r).includes('1203@g.us'));
}
{
  const w = world();
  const d = opened(w, { extra: { originKind: 'dm', originJid: JID, subjectJid: JID }, payload: { adopted: true, claimId: 7, options: [{ id: 'go', go: true, label: WORDS }, { id: 'stay', label: 'x' }] } });
  commit(w, d, T(10, 10), 'go', 'adopted', {}, { originKind: 'dm', originJid: JID, subjectJid: JID });
  const [r] = w.view().rows;
  eq('a plan made in a chat: only the code label', [r.label, r.fromChat, r.deed.cause], ['a plan from a chat', true, 'adopted']);
  const all = JSON.stringify(w.view());
  check('…no words from it', !all.includes(WORDS));
  check('…no JID', !all.includes(JID));
}
{
  const w = world();
  const d = opened(w, { payload: { invite: { pointerId: 3, maxReversals: 1 } }, extra: { originKind: 'group', originJid: '1203@g.us', subjectJid: JID } });
  lean(w, d, T(10, 12), 'late', 0.5);
  commit(w, d, T(10, 13), 'stay', 'reply', {}, { subjectJid: JID });
  const [r] = w.view().rows;
  eq('his reply to an invitation', [r.deed.cause, r.label, r.text], ['reply', 'a plan from a chat', 'leaning late (0.50)… stayed anyway (his reply to an invitation)']);
  check('…no JID', !JSON.stringify(r).includes(JID));
}
{
  const w = world();
  const d = opened(w);
  lean(w, d, T(10, 16), 'stay', 0.6);
  commit(w, d, T(10, 17), 'go', 'sample', { nudged: true });
  went(w, T(10, 19));
  const [r] = w.view().rows;
  eq('feat/one-being: a nudged commit (cause = the decision) reads as nudged', [r.chatNudged, r.deed.nudged, r.text], [true, true, 'leaning stay (0.60)… went anyway (deadline draw, nudged by a chat)']);
}

section('every commit cause in code words');
for (const [by, code, words] of [
  ['sample', 'draw', 'deadline draw'], ['lean', 'lean', 'the lean at the deadline'], ['early', 'early', 'an early commit'], ['adopted', 'adopted', 'adopted from a chat'],
  ['text', 'text', 'agreed in texts'], ['reply', 'reply', 'his reply to an invitation'], ['goal', 'goal', "a goal's outing"],
]) {
  const w = world();
  const d = opened(w);
  commit(w, d, T(10, 10), 'go', by);
  const [r] = w.view().rows;
  check(`${by} → ${code}`, r.deed.cause === code && r.deed.causeWords === words, JSON.stringify(r.deed));
}
{
  const w = world();
  const d = opened(w);
  w.add('decision.committed', T(10, 10), { decisionId: d.id, optionId: 'go', p: 0.9, sampled: false });
  const w2 = world();
  const d2 = opened(w2);
  w2.add('decision.committed', T(10, 10), { decisionId: d2.id, optionId: 'go', p: 0.9, sampled: true });
  eq('a 009 row with no `by`', [w.view().rows[0].deed.cause, w2.view().rows[0].deed.cause], ['early', 'draw']);
}

section('a decision spanning two local days');
{
  const w = world();
  const d = opened(w, { at: T(9, 22), eventAt: T(10, 19) });
  lean(w, d, T(9, 23), 'stay', 0.55);
  lean(w, d, T(10, 16), 'stay', 0.72);
  commit(w, d, T(10, 17), 'go', 'sample');
  went(w, T(10, 19));
  const mon = w.view('2026-11-09').rows;
  const tue = w.view('2026-11-10').rows;
  eq('it shows on both days', [mon.length, tue.length, mon[0]?.id, tue[0]?.id], [1, 1, d.id, d.id]);
  eq('…marked', [mon[0].spansDays, tue[0].spansDays], [true, true]);
  eq('…the same whole story on each', mon[0].text, tue[0].text);
  eq('…with both days\' leans', tue[0].leanCount, 2);
  eq('a day it never touched: nothing', w.view('2026-11-08').rows.length, 0);
  eq('the day after, nothing', w.view('2026-11-11').rows.length, 0);
}
{
  const w = world();
  const d = opened(w, { at: T(9, 22), eventAt: T(10, 23, 30) });
  commit(w, d, T(9, 23), 'go', 'sample');
  w.add('activity.started', T(10, 23, 40), { kind: 'hangout', placeId: 'place:cafe', end: T(11, 1), withCast: [] });
  eq('an outing that runs past midnight: went, on the day it began', w.view('2026-11-10').rows[0].deed.went, true);
  eq('its day is the day of its time, even with nothing logged that day but the outing', w.view('2026-11-10').rows.length, 1);
}

section('bad input, off, empty');
{
  const w = world();
  for (const bad of ['nope', '2026-13-01', '2026-02-31']) {
    let code = null;
    try { w.view(bad); } catch (err) { code = err instanceof ThoughtDeedError ? err.code : 'other'; }
    eq(`${bad} is refused`, code, 'bad_date');
  }
  eq('an empty log', w.view().rows, []);
  const off = buildThoughtDeed({ running: false, date: null, at: NOW, tz, read: () => [] });
  eq('not running: the off shape', [off.running, off.rows, off.date], [false, [], dateKey(NOW, tz)]);
  const lots = world();
  const d = opened(lots);
  for (let i = 0; i < 30; i++) lean(lots, d, T(10, 10) + i * 60, i % 2 ? 'go' : 'stay', 0.5);
  const [r] = lots.view().rows;
  eq('many leans: the newest shown, the count kept', [r.leans.length, r.leanCount], [12, 30]);
}

section('on the engine: a draw against his lean, a chat-nudged evening');
{
  await setupScratchDb();
  const { world: lw, clock, life } = await bootLife();
  const ltz = lw.timezone;
  await simulateDays(25);
  let rows = [];
  for (let i = 0; i <= 25; i++) rows.push(...life.thoughtDeed({ date: dateKey(clock.now() - i * DAY, ltz) }).rows);
  check('he decided things', rows.length > 3, String(rows.length));
  const against = rows.find(r => r.against && r.deed.cause === 'draw');
  check('a draw went against his lean', !!against, JSON.stringify(rows.slice(0, 3)));
  check('…and the line says so', /anyway \(deadline draw\)/.test(against?.text ?? ''), against?.text);

  // A chat nudges tonight's plan: the lean is marked, in code; nothing of the chat is in the view.
  const GROUP = '120363000000000072@g.us';
  const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
  const at = clock.now();
  const plan = appendEvent({
    type: 'decision.opened', at, actor: 'engine',
    payload: { kind: 'hangout', subject: { eventAt: at + 6 * HOUR, placeId: 'place:cafe', castIds: [] }, opensAt: at, decideBy: at + 5 * HOUR, ponrAt: at + 5 * HOUR, options: [{ id: 'go', go: true, label: 'Tonight at the cafe' }, { id: 'stay', label: 'Stay in' }] },
  });
  const trig = appendEvent({ type: 'chat.trigger', at, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { decisionId: plan.id, trigger: 'chat_mention' } });
  appendEvent({ type: 'decision.lean', at, actor: 'jev', causeId: trig.id, payload: { decisionId: plan.id, optionId: 'go', p: 0.6, trigger: 'chat_mention' } });
  const row = life.thoughtDeed({}).rows.find(r => r.id === plan.id);
  check('a chat-nudged lean is marked', row?.chatNudged === true && row?.leans[0].fromChat === true, JSON.stringify(row));
  check('…his own plan keeps its label', row?.fromChat === false && row?.label === 'Tonight at the cafe', JSON.stringify(row));
  check('…no chat id in the view', !JSON.stringify(life.thoughtDeed({})).includes(GROUP));
  const before = count();
  life.thoughtDeed({});
  eq('reading it writes nothing', count(), before);
  await stopLife();
}
report();
