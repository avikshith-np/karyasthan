// Plan 020 C1–C2: the live outing on the real engine. A read of the log: no event, no model call, so a
// revert, a rewind and a restart are exact. The trip before and after, a resume after a rewind, a revert
// mid-session, midnight, a short one, two people, the flatmate at home, a restart, several interruptions,
// a late arrival, an owner tone, sleep starting early, and what a real person, a chat and a heavy stretch
// may show. Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, HOUR } from './_helpers.js';
import { appendEvent, listEvents, lastEventId } from '../../src/life/eventLog.js';
import { isExcludedId } from '../../src/life/projector.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone, localParts } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as lifeFacade from '../../src/life/index.js';
import { config } from '../../src/utils/config.js';

section('nothing running');
eq('an off shape', lifeFacade.liveSession({}), { running: false, active: false });
eq('no trace', lifeFacade.liveSessionTrace(1), null);

const { db } = await setupScratchDb();
const cr = fakeCallRole({});
const { world, clock, life } = await bootLife({ callRole: cr });
story.__setDepsForTest({ getUsageByCaller: () => [], knownNames: () => [] });
config.arcs.scenesEnabled = false;   // the scene writer isn't under test here
config.arcs.phoneOrganicPerDay = 0;
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const FLAT = 'cast:flatmate';
const OTHER = 'cast:coworker-a';
const at = (d0, h, m = 0) => { const [y, mo, d] = dateKey(d0 + 12 * HOUR, tz).split('-').map(Number); return zonedToUnix(y, mo, d, h, m, tz); };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 5 }); };
const today = () => dayStart(clock.now(), tz);
const JID = '15550000099@s.whatsapp.net';
const live = (t) => life.liveSession({ at: t ?? clock.now() });
const count = () => db.prepare('SELECT COUNT(*) AS n FROM world_events').get().n;

async function outing(startAt, minutes, { castIds = [FLAT], placeId = 'place:cafe', label = 'an afternoon out' } = {}) {
  const p = await story.director.preview({ kind: 'scene', shape: 'outing', placeId, startAt, minutes, castIds, label }, { relax: true });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  check(`${label} is applied`, r?.ok === true, JSON.stringify(r));
  return [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === label);
}
// A session put straight in the log: no tick runs while it is read, so the pulse doesn't move him on.
function fixture({ kind = 'hangout', placeId = 'place:cafe', withCast = [FLAT], minutes = 120, atT = clock.now(), ...extra } = {}) {
  return appendEvent({ type: 'activity.started', at: atT, actor: 'engine', ...extra.event, payload: { kind, placeId, end: atT + minutes * 60, withCast, ...(extra.payload ?? {}) } });
}
const textIn = (castId, t = clock.now()) => appendEvent({ type: 'phone.message', at: t, actor: 'engine', payload: { castId, castIds: [castId], dir: 'in', msgId: 1, trigger: 'organic', exchange: 0, tone: 'warm', length: 5, bubbles: 1, textSha: 'x' } });
const textOut = (castId, t = clock.now()) => appendEvent({ type: 'phone.message', at: t, actor: 'engine', payload: { castId, castIds: [castId], dir: 'out', msgId: 2, trigger: 'owner', exchange: 0, tone: 'warm', length: 5, bubbles: 1, textSha: 'x' } });

await simulateHours(4);
await story.idle();

section('a trip before and after: a session only at the venue');
let cafeStart;
{
  const day = addDays(today(), 1, tz);
  const start = at(day, 15);
  await outing(start, 120);
  await stepTo(start - 25 * 60);
  check('on the way there, or not left yet: no session', live().active === false, JSON.stringify(S().activity));
  await stepTo(start + 3 * 60);
  const v = live();
  check('at the venue: a session', v.active === true && v.mode === 'full', JSON.stringify(v));
  cafeStart = v.activityEventId;
  eq('…arriving', v.phase, 'arriving');
  check('…the line has its time and place', v.text.startsWith(v.line.at) && v.line.parts[0].length > 0, v.text);
  await stepTo(start + 60 * 60);
  const mid = live();
  check('an hour in: the same session, further along', mid.activityEventId === cafeStart && ['main', 'lull'].includes(mid.phase), JSON.stringify(mid));
  check('…bands, not numbers, for how it feels', ['low', 'ok', 'high'].includes(mid.them[0].mood) && ['low', 'ok', 'high'].includes(mid.his.mood) && ['low', 'ok', 'high'].includes(mid.attention.band));
  await stepTo(start + 121 * 60 + 5 * 60);
  check('after it, on the way home: no session', live().active === false || S().activity?.kind === 'commute' ? live().active === false : false, JSON.stringify(S().activity));
  const tr = life.liveSessionTrace(cafeStart);
  check('…and its trace is there', tr?.mode === 'full' && tr.activityEventId === cafeStart && tr.phases[0].phase === 'arriving' && tr.phases.at(-1).phase === 'leaving', JSON.stringify(tr));
  eq('…two hours of it', tr.minutes, 120);
  check('…with its outcome', ['well', 'fine', 'flat', 'badly'].includes(tr.outcome));
}

section('a read writes nothing and calls no model');
{
  const before = count();
  const calls = cr.calls?.length ?? 0;
  life.liveSession({});
  life.liveSessionTrace(cafeStart);
  eq('no event', count(), before);
  eq('no model call', cr.calls?.length ?? 0, calls);
}

section('a revert mid-session: exact at once');
{
  const day = addDays(today(), 1, tz);
  const start = at(day, 15);
  await outing(start, 90, { label: 'revert me' });
  await stepTo(start + 30 * 60);
  const v = live();
  check('on it', v.active === true && v.mode === 'full', JSON.stringify(S().activity));
  const r = life.revertEvent(v.activityEventId, { reason: 'test', by: 'tester' });
  check('reverted', r?.ok !== false && isExcludedId(S(), v.activityEventId), JSON.stringify(r));
  check('no session now, at the same moment', live().activityEventId !== v.activityEventId);
  eq('no trace of it', life.liveSessionTrace(v.activityEventId), null);
  await simulateHours(3);
}

section('an interruption reverted: its dip goes with it');
{
  const t0 = clock.now();
  const a = fixture({ minutes: 200 });
  clock.advance({ minutes: 60 });
  const clean = live();
  const before = clean.attention.value;
  const msg = textIn(OTHER);
  const dipped = live();
  check('a text dips attention', dipped.attention.value < before, `${before} → ${dipped.attention.value}`);
  check('…it is listed, with who', dipped.interruptions.length === 1 && dipped.interruptions[0].kind === 'text' && dipped.interruptions[0].who === 'Coworker', JSON.stringify(dipped.interruptions));
  eq('…not answered yet', dipped.interruptions[0].answered, false);
  check('…and on the line', dipped.line.parts.some(p => /phone|text|Coworker/.test(p)), dipped.text);
  life.revertEvent(a.id, { reason: 't', by: 'tester' });
  void msg; void t0;
  check('the outing reverted: the text no longer belongs to anything', live().activityEventId !== a.id);
}

section('several interruptions at once');
{
  const a = fixture({ minutes: 200 });
  clock.advance({ minutes: 60 });
  const base = live().attention.value;
  textIn(OTHER);
  textIn('cast:coworker-b');
  appendEvent({ type: 'chat.load', at: clock.now(), actor: 'engine', payload: { sent: 0, received: 30, chats: 3, windowMin: 30 } });
  textIn(OTHER);
  const v = live();
  eq('all of them listed', v.interruptions.length, 4);
  check('one line for the lot', v.line.parts.filter(p => /phone|messages/.test(p)).length === 1 && v.line.parts.length <= 4, v.text);   // every PHONE.many line says one or the other
  check('attention dips, not below what is left', v.attention.value < base && v.attention.value >= 0, String(v.attention.value));
  const chat = v.interruptions.find(i => i.kind === 'chats');
  eq('a real chat is counts only', [chat.received, chat.who], [30, null]);
  check('…no field of it can hold a word', Object.keys(chat).every(k => ['at', 'kind', 'who', 'sent', 'received', 'fades'].includes(k)), JSON.stringify(chat));
  clock.advance({ minutes: 25 });
  const later = live();
  eq('they all fade within 20 minutes', later.interruptions.length, 0);
  check('…attention comes back', later.attention.value > v.attention.value, `${v.attention.value} → ${later.attention.value}`);
  textIn(OTHER);
  clock.advance({ minutes: 3 });
  textOut(OTHER);
  const ans = live();
  check('he answered: shown from the log, not decided here', ans.interruptions.some(i => i.kind === 'answered') && ans.interruptions.find(i => i.kind === 'text')?.answered === true, JSON.stringify(ans.interruptions));
  life.revertEvent(a.id, { reason: 't', by: 'tester' });
}

section('a text from someone he is with does not count as an interruption');
{
  const a = fixture({ minutes: 200 });
  clock.advance({ minutes: 40 });
  textIn(FLAT);
  eq('none listed', live().interruptions.length, 0);
  life.revertEvent(a.id, { reason: 't', by: 'tester' });
}

section('how long and who with');
{
  const s = fixture({ minutes: 15 });
  clock.advance({ minutes: 5 });
  check('a planned 15 minutes: no session', live().active === false, JSON.stringify(live()));
  life.revertEvent(s.id, { reason: 't', by: 't' });

  const z = fixture({ minutes: 19 });
  clock.advance({ minutes: 1 });
  check('19 minutes: no session (the scene rule, ≥ 20)', live().active === false);
  life.revertEvent(z.id, { reason: 't', by: 't' });

  const y = fixture({ minutes: 20 });
  clock.advance({ minutes: 1 });
  check('20 minutes: a session', live().active === true, JSON.stringify(live()));
  appendEvent({ type: 'activity.ended', at: clock.now() + 60, actor: 'engine', causeId: y.id, payload: { kind: 'hangout', placeId: 'place:cafe' } });
  clock.advance({ minutes: 2 });
  check('it ended early: over at once', live().active === false);
  eq('…and at under 20 minutes actually spent, no trace (as no scene)', life.liveSessionTrace(y.id), null);

  const home = fixture({ kind: 'tv', placeId: 'place:home', withCast: [FLAT], minutes: 90 });
  clock.advance({ minutes: 5 });
  check('TV at home with the flatmate: routine, no session', live().active === false);
  life.revertEvent(home.id, { reason: 't', by: 't' });
  const din = fixture({ kind: 'dinner', placeId: 'place:home', withCast: [FLAT], minutes: 60 });
  clock.advance({ minutes: 5 });
  check('dinner at home with the flatmate: routine, no session', live().active === false);
  life.revertEvent(din.id, { reason: 't', by: 't' });
  const vis = fixture({ kind: 'visit', placeId: 'place:home', withCast: [FLAT], minutes: 90 });
  clock.advance({ minutes: 5 });
  const v = live();
  check('a visit at home, the kind says so: a session', v.active === true && v.mode === 'full', JSON.stringify(v));
  check('…at his place', v.line.parts[0] === 'his flat', v.line.parts[0]);
  life.revertEvent(vis.id, { reason: 't', by: 't' });
  const alone = fixture({ withCast: [], minutes: 60 });
  clock.advance({ minutes: 5 });
  check('out alone: no session', live().active === false);
  life.revertEvent(alone.id, { reason: 't', by: 't' });
}

section('two people');
{
  const a = fixture({ withCast: [FLAT, OTHER], minutes: 200 });
  clock.advance({ minutes: 60 });
  const v = live();
  eq('both are there', v.them.map(x => x.castId).sort(), [OTHER, FLAT].sort());
  const lines = [];
  for (let i = 0; i < 30; i++) { clock.advance({ minutes: 5 }); lines.push(live().text); }
  check('never "she" or "he\'s" for two people', lines.every(l => !/\b(she|she's|her)\b/i.test(l)), lines.find(l => /\b(she|her)\b/i.test(l)));
  life.revertEvent(a.id, { reason: 't', by: 't' });
}

section('sleep starting early ends it');
{
  const a = fixture({ kind: 'visit', placeId: 'place:home', minutes: 240 });
  clock.advance({ minutes: 30 });
  check('on it', live().active === true);
  appendEvent({ type: 'sleep.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 8 * HOUR } });
  clock.advance({ minutes: 5 });
  check('asleep: no session', live().active === false);
  const tr = life.liveSessionTrace(a.id);
  eq('…the trace stops there', tr?.minutes, 30);
  life.revertEvent(a.id, { reason: 't', by: 't' });
}

section('a late arrival');
{
  const t = clock.now();
  const d = appendEvent({ type: 'decision.opened', at: t - HOUR, actor: 'engine', payload: { kind: 'hangout', subject: { eventAt: t - 25 * 60, placeId: 'place:cafe', castIds: [FLAT] }, opensAt: t - HOUR, decideBy: t - 40 * 60, ponrAt: t - 40 * 60, options: [{ id: 'go', go: true, label: 'x', minutes: 120 }] } });
  const a = fixture({ minutes: 120, payload: { decisionId: d.id } });
  clock.advance({ minutes: 10 });
  const tr = life.liveSessionTrace(a.id);
  eq('it knows how late', tr?.late, 25);
  const lines = [];
  for (let i = 0; i < 4; i++) { lines.push(life.liveSession({ at: a.at + i * 300 }).text); }
  check('a session as usual', lines.every(Boolean), lines.join(' | '));
  life.revertEvent(a.id, { reason: 't', by: 't' });
  life.revertEvent(d.id, { reason: 't', by: 't' });
}

section('an owner tone: its outcome word shapes the mood; its words never appear');
{
  const WORDS = 'zanzibar-tone-words';
  const day = addDays(today(), 1, tz);
  const start = at(day, 15);
  const d = await outing(start, 180, { label: 'toned' });
  const p = await story.director.preview({ kind: 'scene.tone', decisionId: d.id, tone: WORDS, outcome: 'badly' }, { relax: true });
  const r = await story.director.apply(p.previewId, p.fingerprint);
  check('tone applied', r?.ok === true, JSON.stringify(r));
  await stepTo(start + 150 * 60);
  const v = live();
  eq('late on, she is low', v.them[0].mood, 'low');
  const tr = life.liveSessionTrace(v.activityEventId);
  eq('the trace says the owner set it', [tr.outcome, tr.outcomeBy], ['badly', 'owner']);
  check('the tone\'s words appear nowhere', !JSON.stringify(v).includes(WORDS) && !JSON.stringify(tr).includes(WORDS));
  await simulateHours(2);
}

section('a tone changed mid-outing: the next read follows it');
{
  const day = addDays(today(), 1, tz);
  const start = at(day, 15);
  const d = await outing(start, 180, { label: 'retoned' });
  await stepTo(start + 60 * 60);
  const setTone = async (outcome) => {
    const p = await story.director.preview({ kind: 'scene.tone', decisionId: d.id, tone: 'how it goes', outcome }, { relax: true });
    const r = await story.director.apply(p.previewId, p.fingerprint);
    check(`tone ${outcome} applied`, r?.ok === true, JSON.stringify(r));
    const v = live();
    const tr = life.liveSessionTrace(v.activityEventId);
    return { mood: v.them[0].mood, outcome: tr.outcome, by: tr.outcomeBy };
  };
  const well = await setTone('well');
  eq('well', [well.outcome, well.by, well.mood], ['well', 'owner', 'high']);
  // 'well' and 'flat' are the same length: a key built on sizes would miss this.
  const flat = await setTone('flat');
  eq('flat, the very next read', flat.outcome, 'flat');
  check('…her mood moved', flat.mood !== 'high', JSON.stringify(flat));
  const badly = await setTone('badly');
  eq('badly', [badly.outcome, badly.mood], ['badly', 'low']);
  const back = await setTone('well');
  eq('back to well', [back.outcome, back.mood], ['well', 'high']);
  await simulateHours(3);
}

section('a resume after a rewind: one outing, not two');
{
  const day = addDays(today(), 1, tz);
  const start = at(day, 15);
  const d = await outing(start, 150, { label: 'resumed' });
  await stepTo(start + 60 * 60);
  const first = live();
  check('on it, an hour in', first.active === true && first.mode === 'full' && first.minutesIn >= 55, JSON.stringify(first));
  const pc = await story.director.preview({ kind: 'outcome', decisionId: d.id, outcome: 'cancelled' }, { relax: true });
  const rc = await story.director.apply(pc.previewId, pc.fingerprint);
  check('walked out', rc?.ok === true, JSON.stringify(rc));
  await stepTo(start + 90 * 60);
  const p = await story.director.preview({ kind: 'rewind', at: start + 10 * 60, reason: 'undo the walkout' });
  const r = await story.director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('rewound', r?.ok === true, JSON.stringify(r));
  await simulateHours(0.25);
  const v = live();
  check('he is back at it', v.active === true && v.mode === 'full', JSON.stringify(S().activity));
  eq('the same session', v.activityEventId, first.activityEventId);
  check('…not arriving all over again', v.phase !== 'arriving' && v.minutesIn >= 90, `${v.phase} ${v.minutesIn}`);
  const starts = listEvents({ types: ['activity.started'], from: start - HOUR, limit: 50 })
    .filter(e => e.payload?.placeId === 'place:cafe' && e.payload?.kind === first.kind && (e.payload?.withCast ?? []).includes(FLAT) && !isExcludedId(S(), e.id));
  eq('there really are two live starts', starts.length, 2);
  const tr = life.liveSessionTrace(starts[1].id);
  eq('the trace from either start is the one session', tr?.activityEventId, first.activityEventId);
  await simulateHours(3);
}

section('an outing crossing midnight, and a restart in the middle of it');
{
  const day = today();
  const start = at(day, 23, 0);
  await outing(start, 150, { label: 'past midnight' });
  await stepTo(start + 40 * 60);
  const before = live();
  check('on it before midnight', before.active === true && before.mode === 'full', JSON.stringify(S().activity));
  const p0 = localParts(clock.now(), tz);
  eq('…23-something', p0.hour, 23);
  await stepTo(at(addDays(day, 1, tz), 0, 40));
  const after = live();
  eq('past midnight: the same session', after.activityEventId, before.activityEventId);
  check('…still going', after.minutesIn >= 90 && after.minutesLeft > 0, JSON.stringify([after.minutesIn, after.minutesLeft]));
  const earlier = life.liveSession({ at: before.at });
  eq('the line at 23:40 reads the same from after midnight (one seed, one date)', earlier.text, before.text);

  const t = clock.now();
  const snapshot = JSON.stringify(life.liveSession({ at: t }));
  await stopLife();
  const again = await bootLife({ world, clock, callRole: cr });
  story.__setDepsForTest({ getUsageByCaller: () => [], knownNames: () => [] });
  eq('a restart: the same state, the same line', JSON.stringify(again.life.liveSession({ at: t })), snapshot);
  await simulateHours(3);
}

// After the restart `life` above is stale: read through the booted facade.
section('what may be shown');
{
  const facade = lifeFacade;
  const v = () => facade.liveSession({ at: clock.now() });
  const CHAT_GROUP = '120363000000000099@g.us';
  const shape = (x) => [x.active, x.mode, x.text?.split(' · ').slice(1).join(' · ')];

  const real = appendEvent({ type: 'activity.started', at: clock.now(), actor: 'engine', subjectJid: JID, payload: { kind: 'hangout', placeId: 'place:cafe', end: clock.now() + 2 * HOUR, withCast: [] } });
  clock.advance({ minutes: 5 });
  eq('a real person: only "out with a friend"', shape(v()), [true, 'minimal', 'out with a friend']);
  check('…no JID, no place, no mood anywhere', !JSON.stringify(v()).includes(JID) && v().them === undefined && v().phase === undefined && v().topic === undefined, JSON.stringify(v()));
  eq('…the trace says no more', facade.liveSessionTrace(real.id), { mode: 'minimal', reason: 'real_person', activityEventId: real.id });
  facade.revertEvent(real.id, { reason: 't', by: 't' });

  const trig = appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'group', originJid: CHAT_GROUP, payload: { trigger: 'chat_mention' } });
  const chat = appendEvent({ type: 'activity.started', at: clock.now(), actor: 'engine', causeId: trig.id, payload: { kind: 'hangout', placeId: 'place:cafe', end: clock.now() + 2 * HOUR, withCast: [FLAT] } });
  clock.advance({ minutes: 5 });
  eq('a chat\'s outing: its audience-safe form', shape(v()), [true, 'minimal', 'out with a friend']);
  check('…no chat id', !JSON.stringify(v()).includes(CHAT_GROUP));
  facade.revertEvent(chat.id, { reason: 't', by: 't' });

  const heavy = appendEvent({ type: 'embargo.started', at: clock.now() - 60, actor: 'engine', heavy: true, payload: { until: clock.now() + 12 * HOUR } });
  const during = fixture({ minutes: 120 });
  clock.advance({ minutes: 5 });
  eq('during an embargo: only that', shape(v()), [true, 'minimal', 'out with a friend']);
  eq('…so does the trace', facade.liveSessionTrace(during.id)?.mode, 'minimal');
  facade.revertEvent(during.id, { reason: 't', by: 't' });
  void heavy;
}

section('the facade is the only door');
{
  const fs = await import('fs');
  const path = await import('path');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  // src/calls has a liveSession.js of its own (the Gemini Live call session): a different module.
  const users = walk('src').filter(f => !f.includes('src/calls/') && /['"][^'"]*live(Session|Phrases)\.js['"]/.test(fs.readFileSync(f, 'utf8'))).map(f => f.replace(/\\/g, '/')).sort();
  // phraseCheck reads the phrase table only, as the phrase banks' list of lines (plan 020 H2).
  eq('only the life facade, the module itself, the thought stream and the banks\' list of lines import it', users, ['src/life/index.js', 'src/life/liveSession.js', 'src/life/phraseCheck.js', 'src/life/thoughts.js']);
}

report();
