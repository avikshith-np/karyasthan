// 020 D1: each sheet reads the world "as of" its own moment. Every section replays a wrong read
// found by the audit (docs/claude/as-of.md): his energy on a text from the last event hours ago;
// a scene's state read at write time for an outing not starting on the half hour; a resumed outing's
// "before" read after its own first part; rain gone by write time; "planned next" holding a plan made
// days after the outing; a job he lost; "on my way" to yesterday's plan; a journal losing a member who
// left, and a chat's plan once it's pruned; digests stating their age. Example world, fake clock,
// stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR, DAY,
} from './_helpers.js';
import { appendEvent, getEvent, lastEventId, listEvents, eventsAfter, revertEvent, redactPerson } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, hhmm, dayLabel } from '../../src/life/clock.js';
import { stateBeforeEvent, vitalsAt, isExcludedId, setOverlayGate } from '../../src/life/projector.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as sceneStore from '../../src/life/story/scenes/store.js';
import { contextFor, endOf } from '../../src/life/story/scenes/worker.js';
import { sessionOf } from '../../src/life/story/scenes/detect.js';
import { buildFactSheet } from '../../src/life/story/scenes/facts.js';
import { renderUser as sceneUser } from '../../src/life/story/scenes/charter.js';
import { whyCtxOf } from '../../src/life/story/phone/worker.js';
import { buildSheet } from '../../src/life/story/phone/facts.js';
import { jobWordsOf } from '../../src/life/story/reducer.js';
import { buildWeeklyInput } from '../../src/life/story/weekly.js';
import * as journal from '../../src/life/story/journal.js';
import * as narrate from '../../src/life/story/narrate.js';
import { config } from '../../src/utils/config.js';

await setupScratchDb();
config.arcs.phoneOrganicPerDay = 0;
const sceneJson = () => JSON.stringify({
  narration: 'They met and talked for a long while about small things. The street was quiet and the coffee was good. '
    + 'He laughed more than he had all week, and when it was time they said goodbye at the door and he walked home.',
  impressions: null, topics: ['small things'], highlight: 'laughing over coffee', awkward: null, chemistry: 0.4, focus: 'P1', ending: 'nothing', effects: [],
});
let turn = 0;
const WORDS = ['moon', 'chai', 'rain', 'song', 'stars', 'balcony', 'noodles', 'traffic', 'cricket', 'beach'];
const text = () => JSON.stringify({ messages: [`${WORDS[turn++ % WORDS.length]} ${turn}`], tone: 'warm', topic: 'small', end: true });
const seen = { cast: [], his: [], scene: [], journal: [] };
const cr = fakeCallRole({
  'life.scene.clerk': (s, u) => { seen.scene.push(u); return sceneJson(); },
  'life.scene.mind': (s, u) => { seen.scene.push(u); return sceneJson(); },
  'life.phone.cast': (s, u) => { seen.cast.push(u); return text(); },
  'life.phone.his': (s, u) => { seen.his.push(u); return text(); },
  'life.phone.mind': (s, u) => { seen.his.push(u); return text(); },
  'role:clerk': (s, u) => { seen.journal.push(u); return 'A plain day, nothing much to say about it.'; },
});
const deps = { getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [], identity: async () => 'You are Kiran.' };
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest(deps);
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const FRIEND = 'cast:coworker-a';
const at = (off, hh, mm = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + off * DAY; };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const inject = (d) => { const e = appendEvent({ actor: 'engine', ...d }); story.__rebuildForTest(); return e; };
async function drain() { await story.idle(); await story.runPhoneNow(); await story.idle(); await story.runScenesNow(); await story.idle(); }
async function applyAction(action, opts = {}) {
  const pv = await story.director.preview(action, { relax: true, ...opts });
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  return { pv, res };
}
async function outing(startAt, minutes = 90, extra = { castIds: [FRIEND] }) {
  const before = lastEventId();
  const { res } = await applyAction({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes, label: 'Catch-up', ...extra });
  check('the outing applied', res?.ok === true, JSON.stringify(res)?.slice(0, 200));
  const opened = eventsAfter(before, 500).find(e => e.type === 'decision.opened');
  return opened?.id ?? null;
}
const startOf = (decisionId, after) => {
  const sub = getEvent(decisionId)?.payload?.subject ?? {};
  return eventsAfter(after, 50000).find(e => e.type === 'activity.started' && e.payload?.placeId === sub.placeId && e.at >= sub.eventAt - 1800);
};
const band3 = (v, lo, hi) => (v < lo ? 'low' : v > hi ? 'high' : 'ok');

await simulateHours(2);
await drain();

section('a text at dawn: his state on the sheet is now, not when he fell asleep');
{
  // Set at 03:00 for 06:15: nothing folds in between, so the live projection's vitals stay at 03:00.
  await stepTo(at(1, 3, 0));
  check('he is asleep', S().activity?.kind === 'sleep', S().activity?.kind);
  seen.cast.length = 0;
  const dueAt = at(0, 6, 15);
  await applyAction({ kind: 'text', castId: FRIEND, from: 'them', wake: false, gist: 'asks how he slept', at: dueAt }, { relax: false });
  await stepTo(dueAt - 300);
  check('not yet', !seen.cast.length);
  clock.advance({ seconds: 300 });
  const live = story.__rawStateForTest();
  check('no event for hours (the projection hasn\'t moved)', clock.now() - live.at > 2 * HOUR, `${clock.now() - live.at}`);
  const trueNow = vitalsAt(live, clock.now(), world, { chatMood: false });
  check('hours of sleep moved his energy past a band', band3(live.vitals.energy, 35, 70) !== band3(trueNow.energy, 35, 70),
    `${live.vitals.energy.toFixed(0)} → ${trueNow.energy.toFixed(0)}`);
  await drain();
  const user = seen.cast[0] ?? '';
  check('the writer ran', !!user);
  const line = user.split('\n').find(l => l.startsWith('his state:'));
  check('the sheet reads his energy now', line?.includes(`energy ${band3(trueNow.energy, 35, 70)}`), `${line} vs ${trueNow.energy.toFixed(0)}`);
  check('the sheet says when it holds', user.includes(`as of: ${dayLabel(clock.now(), tz)} ${hhmm(clock.now(), tz)}`), user.split('\n').slice(0, 12).join(' | '));
}

section('"on my way": the plan of this trip, not an older one at the same place');
{
  const t = clock.now();
  const trip = inject({ type: 'travel.started', at: t, payload: { from: 'place:home', to: 'place:cafe', mode: 'walk', startAt: t, endAt: t + 600 } });
  const mk = (id, eventAt, castIds) => [id, { id, status: 'committed', subject: { placeId: 'place:cafe', eventAt, castIds } }];
  const s = { decisions: new Map([mk(10, t - DAY, [FRIEND]), mk(11, t + 1800, [FRIEND]), mk(12, t + 1200, ['cast:coworker-b'])]),
    places: S().places, self: S().self, story: S().story };
  const why = whyCtxOf(s, { trigger: 'on_my_way', triggerEventId: trip.id, castId: FRIEND }, tz);
  eq('this trip\'s plan with them', why.eventAt, hhmm(t + 1800, tz));
  story.__rebuildForTest();
}

let offGridEnd = null;
let offGridSession = null;
let startVitals = null;
section('an outing off the half hour: his state is the start\'s, never the state at write time');
{
  const start = at(1, 15, 47);
  const before = lastEventId();
  const did = await outing(start, 150);
  await stepTo(start + 40 * 60);
  const st = startOf(did, before);
  check('it started off the half hour', st && st.at % 1800 !== 0, st?.at);
  startVitals = vitalsAt(stateBeforeEvent(st.id, { world }), st.at, world);
  await stepTo(start + 3 * HOUR);
  const end = endOf(st.id);
  check('it ended', !!end);
  offGridEnd = end;
  offGridSession = sessionOf(st, end, S());
  const ctx = contextFor(S(), offGridSession);
  eq('the vitals on the sheet are the start\'s', [ctx.vitals.energy, ctx.vitals.stress], [startVitals.energy, startVitals.stress]);
  check('…and they aren\'t the state now', ctx.vitals.energy !== S().vitals.energy, `${ctx.vitals.energy} vs ${S().vitals.energy}`);
}

section('a real chat\'s mood doesn\'t move a scene\'s state or its roll (review 11)');
{
  const st = getEvent(offGridSession.activityEventId);
  const plain = contextFor(S(), offGridSession).vitals;
  const beforeStart = stateBeforeEvent(st.id, { world });
  // A mood moment and a morning's dream just before the start, with the overlay open as chat-influence's mood toggle opens it.
  beforeStart.chatMood = [{ at: st.at - 12 * 60, eventId: 1, pointerId: 1, dv: -0.06, ds: 4, dsoc: -3, affect: 'annoyed', originJid: null, subjectJid: null }];
  beforeStart.story = { ...beforeStart.story, dream: { at: st.at - HOUR, until: st.at + HOUR, dv: 0.2, ds: -5 } };
  setOverlayGate(() => true);
  const open = vitalsAt(beforeStart, st.at, world);
  check('the overlay would move him (the wrong read)', open.mood.valence !== plain.mood.valence || open.stress !== plain.stress, `${open.mood.valence} vs ${plain.mood.valence}`);
  const ctx = contextFor(S(), offGridSession, { before: beforeStart });
  eq('the sheet has the base numbers', [ctx.vitals.mood.valence, ctx.vitals.stress, ctx.vitals.socialBattery], [plain.mood.valence, plain.stress, plain.socialBattery]);
  setOverlayGate(null);
}

section('a plan made after the outing isn\'t what was "planned next"');
{
  // Known at the end: kept (99-scene-around). Made a day later: not on a rewrite.
  const did = await outing(at(1, 18, 0), 60);
  check('a later plan with them is committed now', S().decisions.get(did)?.status === 'committed');
  const ctx = contextFor(S(), offGridSession);
  check('not on the sheet of the earlier outing', !(ctx.plansAfter ?? []).some(l => l.includes('Catch-up')), ctx.plansAfter);
  const pc = await story.director.preview({ kind: 'outcome', decisionId: did, outcome: 'cancelled' }, { relax: true });
  await story.director.apply(pc.previewId, pc.fingerprint);
  await drain();
}

section('rain that had stopped by write time was still rain at the start');
{
  const start = at(1, 11, 7);
  const before = lastEventId();
  const did = await outing(start, 120);
  await stepTo(start - 20 * 60);
  inject({ type: 'weather.changed', at: clock.now(), payload: { rain: true, condition: 'thunderstorm', tempC: 19, from: clock.now(), until: start + 40 * 60 } });
  await stepTo(start + 45 * 60);
  const st = startOf(did, before);
  check('it started', !!st);
  await stepTo(start + 90 * 60);
  inject({ type: 'weather.changed', at: clock.now(), payload: { rain: false, condition: 'clear', tempC: 25, from: clock.now(), until: clock.now() + HOUR } });
  await stepTo(start + 2.5 * HOUR);
  const end = endOf(st.id);
  const ctx = contextFor(S(), sessionOf(st, end, S()));
  eq('the sheet\'s weather is the start\'s', ctx.weather?.condition, 'thunderstorm');
  await drain();
}

section('a resumed outing: the "before" is before its first part, not its resumption');
{
  // A new member; time together credited in the first part; a rewind resumes the block later.
  const start = at(1, 15, 0);
  const before = lastEventId();
  await outing(start, 150, { newCast: { name: 'Tamsin Reed', relation: 'friend' } });
  const id = eventsAfter(before, 500).find(e => e.type === 'cast.created')?.payload?.id;
  check('a new member', !!id);
  await stepTo(start + 5 * 60);
  inject({ type: 'relationship.changed', at: clock.now(), payload: { castId: id, delta: { togetherMin: 5, closeness: 0.02 }, reason: 'shared_time' } });
  inject({ type: 'cast.history_added', at: clock.now(), payload: { castId: id, text: 'hangout together', dated: start } });
  await stepTo(start + 60 * 60);
  const did = [...S().decisions.values()].find(d => d.subject?.castIds?.includes?.(id))?.id;
  const pc = await story.director.preview({ kind: 'outcome', decisionId: did, outcome: 'cancelled' }, { relax: true });
  await story.director.apply(pc.previewId, pc.fingerprint);
  await stepTo(start + 140 * 60);
  const pr = await director.preview({ kind: 'rewind', at: start + 10 * 60, reason: 'undo the walkout' });
  await director.apply(pr.previewId, pr.fingerprint, { by: 'tester' });
  await stepTo(start + 175 * 60);
  await drain();
  const played = listEvents({ types: ['scene.played'], order: 'desc', limit: 20 }).filter(e => !isExcludedId(S(), e.id) && (e.payload?.castIds ?? []).includes(id));
  check('one scene for the whole outing', played.length === 1, played.length);
  const row = played[0] ? sceneStore.getByEvent(played[0].id) : null;
  check('the resumed part started after the credit', played[0] && getEvent(played[0].payload.activityEventId).at > start + 60 * 60);
  eq('a first meeting: read from before its first part', row?.sheet?.people?.[0]?.firstMeet, true);
  const name = S().cast.get(id)?.name;
  check('it was told as one', !!name && (row?.sheet?.time?.minutes ?? 0) >= 140, row?.sheet?.time);
  // Rewound to the middle of it, he's still there: the outing resumes, so its plan didn't go. The rewind's step for an outing
  // rewound away (property tests) isn't for this one, and neither is the pulse's could_not_go (it has a live start).
  const closed = listEvents({ types: ['decision.expired'], order: 'asc', limit: 500 }).filter(e => e.payload?.decisionId === did && !isExcludedId(S(), e.id));
  eq('its plan never expires', closed.map(e => e.payload?.reason), []);
  eq('it stays committed', S().decisions.get(did)?.status ?? 'pruned', 'committed');
  // D1 read the anchor from the session's record, batch 2's fix from the log's chain: one first start, both ways.
  const facade = await import('../../src/life/index.js');
  const resumedStart = played[0]?.payload?.activityEventId;
  const firstStart = facade.liveEarlierStarts(resumedStart).at(-1);
  check('it has a first start before the resumed one', Number.isSafeInteger(firstStart) && firstStart < resumedStart, firstStart);
  eq('the record and the log\'s chain name the same first start', facade.liveSessionTrace(resumedStart)?.activityEventId, firstStart);
  const firstAt = getEvent(firstStart)?.at;
  eq('…and the sheet\'s facts hold at its time', row?.sheet?.asOf, `${dayLabel(firstAt, tz)} ${hhmm(firstAt, tz)}`);
  check('the scene sheet says when its facts hold', !!row?.sheet?.asOf && seen.scene.some(u => u.includes(`as of (people, his state, the weather): ${row.sheet.asOf}`)), row?.sheet?.asOf);
}

section('the journal: who left, what was pruned');
{
  const t = clock.now();
  const state = { cast: new Map(), places: new Map(), story: { departed: { 'cast:gone': { name: 'Rowan Hale' } } }, decisions: new Map() };
  const b = journal.bulletFor({ id: 1, type: 'activity.started', at: t, payload: { kind: 'hangout', withCast: ['cast:gone'] }, originKind: 'self' }, { state, tz });
  check('a member who left since is still named', b?.includes('with Rowan'), b);

  // A plan made with a real person: the owner's commit is self-origin but not publishable. Once pruned from the
  // live projection, a later rebuild of the night read it as his own.
  const p = localParts(t, tz);
  const nk = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const opened = inject({ type: 'decision.opened', at: t, actor: 'owner', subjectJid: '15550001234@s.whatsapp.net', payload: {
    kind: 'hangout', category: 'social', mode: 'auto', decideBy: t + HOUR, ponrAt: t + 2 * HOUR, options: [{ id: 'go', label: 'Marked private plan', cost: {}, expiresAt: t + 2 * HOUR }, { id: 'stay', label: 'Stay in', cost: {} }],
    subject: { eventAt: t + 3 * HOUR, endAt: t + 4 * HOUR, placeId: 'place:cafe', castIds: [] } } });
  const committed = inject({ type: 'decision.committed', at: t + 60, actor: 'owner', payload: { decisionId: opened.id, optionId: 'go', by: 'owner' } });
  const live = story.__rawStateForTest();
  check('the decision is folded and chat-made', typeof live.decisions.get(opened.id)?.subjectJid === 'string', live.decisions.get(opened.id)?.subjectJid);
  const pruned = { ...live, decisions: new Map([...live.decisions].filter(([id]) => id !== opened.id)) };
  const win = journal.dayWindow(nk, tz);
  const direct = journal.selfFacts([committed], { state: pruned, tz, excluded: () => false, decisionAt: journal.nightDecisions(win, clock.now()) });
  eq('pruned since: read as of the night, it stays out of the self part', direct.bullets, []);
  // Batch 3 review 13: the as-of read has no answer (no base, read error, pruned at the cap). The log as written decides.
  const noAnswer = { state: pruned, tz, excluded: () => false, decisionAt: () => null };
  eq('no as-of answer: a real person\'s plan stays out', journal.selfFacts([committed], noAnswer).bullets, []);
  const open = (extra, label) => inject({ type: 'decision.opened', at: t, actor: 'engine', ...extra, payload: {
    kind: 'hangout', category: 'social', mode: 'auto', decideBy: t + HOUR, ponrAt: t + 2 * HOUR, options: [{ id: 'go', label, cost: {}, expiresAt: t + 2 * HOUR }, { id: 'stay', label: 'Stay in', cost: {} }],
    subject: { eventAt: t + 3 * HOUR, endAt: t + 4 * HOUR, placeId: 'place:cafe', castIds: [] } } });
  const commit = (id, by, extra = {}) => inject({ type: 'decision.committed', at: t + 60, actor: 'engine', ...extra, payload: { decisionId: id, optionId: 'go', by } });
  const without = () => ({ ...noAnswer, state: { ...live, decisions: new Map() } });
  const own = open({}, 'His own plan');
  const ownCommit = commit(own.id, 'early');
  eq('…his own plan, pruned, keeps its bullet', journal.selfFacts([ownCommit], without()).bullets.length, 1);
  const pointer = inject({ type: 'chat.trigger', at: t, actor: 'chat', originKind: 'group', originJid: '120363000000880009@g.us', payload: { reason: 'test' } });
  const chatOpened = open({ causeId: pointer.id }, 'Opened in a chat');
  check('…(its origin is the chat\'s)', chatOpened.originKind === 'group', chatOpened.originKind);
  const ownerOnChat = commit(chatOpened.id, 'owner', { actor: 'owner' });
  eq('…one opened in a chat stays out', journal.selfFacts([ownerOnChat], without()).bullets, []);
  const answered = open({}, 'Answered in a reply');
  const reply = commit(answered.id, 'reply');
  const lean = inject({ type: 'decision.lean', at: t + 120, actor: 'engine', payload: { decisionId: answered.id, optionId: 'go', p: 0.9, probs: { go: 0.9, stay: 0.1 }, trigger: 'new_info' } });
  eq('…one his reply committed stays out, from another of its events too', journal.selfFacts([lean, reply], { ...without(), events: [] }).bullets, []);
  const revoked = open({}, 'A revoked reply');
  const revokedCommit = commit(revoked.id, 'reply');
  const ownAgain = commit(revoked.id, 'early');
  eq('…a reply since undone no longer counts', journal.selfFacts([ownAgain], { ...without(), excluded: (id) => id === revokedCommit.id }).bullets.length, 1);
  eq('…an opened row that can\'t be read counts as a chat\'s', journal.selfFacts([ownCommit], { ...without(), getEvent: () => null }).bullets, []);
  eq('…so does a read that fails', journal.selfFacts([ownCommit], { ...without(), getEvent: () => { throw new Error('x'); } }).bullets, []);
  eq('…or a redacted opened row', journal.selfFacts([ownCommit], { ...without(), getEvent: () => ({ type: 'decision.opened', redacted: true, payload: { redacted: true } }) }).bullets, []);
  // A purge wipes a later commit's payload: it can't say whose it was, so a pruned plan opened before it fails closed.
  const purged = '15550004321@s.whatsapp.net';
  commit(answered.id, 'early', { subjectJid: purged });
  redactPerson(purged);
  story.__rebuildForTest();
  eq('…and a redacted commit after it', journal.selfFacts([ownCommit], without()).bullets, []);
  const chat = journal.nightDecisions(win, clock.now())(opened.id);
  check('the night\'s read has the decision', chat?.id === opened.id);
}

section('narration: only what still stands, and how he feels now');
{
  const before = lastEventId();
  await simulateHours(1);
  const e = inject({ type: 'work.crunch', at: clock.now(), payload: { amount: 1, reason: 'deadline' } });
  let got = narrate.thoughtInputs({});
  check('a live event is a line', got.lines.some(l => l.includes('crunch')), got.lines);
  revertEvent(e.id, { reason: 'test' });
  story.__rebuildForTest();
  got = narrate.thoughtInputs({});
  check('a reverted one isn\'t', !got.lines.some(l => l.includes('crunch')), got.lines);
  void before;
}

section('out of work: the sheets say so');
{
  const { res } = await applyAction({ kind: 'career', change: 'fire' });
  check('fired', res?.ok === true);
  await simulateHours(0.5);
  await drain();
  const start = at(1, 11, 30);
  const before = lastEventId();
  const did = await outing(start, 90);
  await stepTo(start + 2 * HOUR);
  const st = startOf(did, before);
  const ctx = contextFor(S(), sessionOf(st, endOf(st.id), S()));
  eq('the scene sheet', ctx.jobTitle, 'between jobs');
  const built = buildFactSheet(ctx.before, sessionOf(st, endOf(st.id), S()), ctx);
  check('…reads it', sceneUser(built.sheet).includes('between jobs'), sceneUser(built.sheet).split('\n')[1]);
  seen.his.length = 0;
  await applyAction({ kind: 'text', castId: FRIEND, gist: 'says hi', at: 'now' }, { relax: false });
  await drain();
  const user = seen.his[0] ?? '';
  check('the text sheet too', user.split('\n').find(l => l.startsWith('him:'))?.includes('between jobs'), user.split('\n')[1]);
  const weekly = buildWeeklyInput(S(), null, { at: clock.now(), world });
  eq('the weekly pass too', weekly?.input?.you?.job?.title ?? weekly?.you?.job?.title, 'between jobs');
}

section('an explicit sheet stays as it was; the words as they read');
{
  const row = { castId: FRIEND, dir: 'out', trigger: 'owner' };
  const t = clock.now();
  const plain = buildSheet(S(), row, { tz, at: t, side: 'his', trigger: 'owner', jobTitle: 'between jobs' }).sheet;
  const explicit = buildSheet(S(), row, { tz, at: t, side: 'his', trigger: 'owner', register: 'explicit' }).sheet;
  check('a plain text sheet has the line', typeof plain.asOf === 'string');
  check('an explicit one doesn\'t', !('asOf' in explicit));
  eq('jobWordsOf: in work', jobWordsOf({ story: { career: { employed: true, title: 'Analyst' } } }, null), 'Analyst');
  eq('jobWordsOf: no career slice, the world', jobWordsOf({}, { self: { job: { title: 'Clerk' } } }), 'Clerk');
  if (process.env.AS_OF_SHOW) {
    console.log('--- text sheet\n' + (seen.his[0] ?? '').slice(0, 900));
    console.log('--- scene sheet\n' + (seen.scene[0] ?? '').slice(0, 700));
  }
}

report();
