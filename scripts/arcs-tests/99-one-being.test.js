// 020 §A, one being: plans compete by weight wherever they were made. planWeight / outranks /
// neverRethought; a promise rethought only on a sure non-fallback lean, once, and a rethought fitted
// plan leaves today (plan.made droppedFor); a chat nudge no longer recolours the commit (cause = the
// decision, nudged, self origin; the lean keeps the chat's origin); the owner may steer chat-made
// plans (the real-person guard stays); two locked plans in one window → the outranked one expires
// could_not_go, once; a committed interview takes him there and back; a fictional member gets one
// backing_out text. Example world, fake clock, stubbed models, no network. (Telling a real person:
// chat-influence-tests/21-back-out.)
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, fakeJev, jevChoice,
  seedPeople, seedGroups, setBot, HOUR,
} from './_helpers.js';
import { appendEvent, listEvents, getEvent, cascadeIds, lastEventId } from '../../src/life/eventLog.js';
import * as planEdits from '../../src/life/planEdits.js';
import { resolveTimezone, zonedToUnix, localParts, hhmm } from '../../src/life/clock.js';
import { planWeight, outranks, neverRethought, isLockedOuting, WEIGHT, PROMISE_REVERSE_P, __setOneBeingForTest } from '../../src/life/planWeight.js';
import { utilities, REVERSE_P } from '../../src/life/decisions.js';
import { outingInPlan } from '../../src/life/pulse.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { buildCatalogue } from '../../src/life/story/prompt.js';
import { earnedTrust } from '../../src/life/story/cast.js';
import { selfFacts } from '../../src/life/story/journal.js';
import { resolveAudience } from '../../src/memory/recall.js';
import * as phoneWorker from '../../src/life/story/phone/worker.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { textPlansAhead } from '../../src/life/story/phone/plans.js';
import { logger } from '../../src/utils/logger.js';
import fs from 'node:fs';
import { huntOfficePlaceId, INTERVIEW_MIN } from '../../src/life/story/career.js';
import { config } from '../../src/utils/config.js';

// ── The table (pure, before any engine runs) ─────────────────────────────────
const P = (extra) => ({ id: 1, status: 'committed', committed: { optionId: 'go', by: 'lean', at: 100 }, ...extra });
const by = (b, extra = {}) => P({ committed: { optionId: 'go', by: b, at: 100 }, ...extra });

section('planWeight / isLockedOuting / neverRethought');
{
  const rows = [
    ['an owner pick', by('owner'), WEIGHT.owner, true, true],
    ['a goal outing', by('goal'), WEIGHT.promise, true, true],
    ['agreed in texts', by('text'), WEIGHT.promise, true, false],
    ['an accepted invitation', by('reply'), WEIGHT.promise, true, false],
    ['an adopted claim', by('adopted', { adopted: true }), WEIGHT.promise, true, false],
    ['an adopted claim, any by', by('lean', { adopted: true }), WEIGHT.promise, true, false],
    ['an interview, his lean', by('early', { kind: 'career:interview' }), WEIGHT.promise, true, false],
    ['his lean', by('lean'), WEIGHT.wish, false, false],
    ['a draw', by('sample'), WEIGHT.wish, false, false],
    ['an early commit', by('early'), WEIGHT.wish, false, false],
  ];
  for (const [name, d, w, locked, never] of rows) {
    eq(`${name}: weight, locked, never rethought`, [planWeight(d), isLockedOuting(d), neverRethought(d)], [w, locked, never]);
  }
  eq('junk reads as a wish', [planWeight(null), planWeight({}), planWeight({ committed: {} })], [WEIGHT.wish, WEIGHT.wish, WEIGHT.wish]);
  eq('not locked: junk, open, a committed stay / late, closed',
    [isLockedOuting(null), isLockedOuting({ status: 'open', committed: { optionId: 'go', by: 'owner' } }),
      isLockedOuting({ status: 'committed', committed: { optionId: 'stay', by: 'owner' } }),
      isLockedOuting({ status: 'committed', committed: { optionId: 'late', by: 'reply' } }),
      isLockedOuting({ status: 'missed', committed: { optionId: 'go', by: 'owner' } })],
    [false, false, false, false, false]);
  check('an owner reversal makes a text plan the owner\'s', planWeight(by('owner', { adopted: true })) === WEIGHT.owner && neverRethought(by('owner', { adopted: true })));
  check('a promise takes a surer lean than a wish', PROMISE_REVERSE_P === 0.9 && PROMISE_REVERSE_P > REVERSE_P);
}

section('outranks');
{
  const o = (id, b, at, extra = {}) => ({ id, status: 'committed', committed: { optionId: 'go', by: b, at }, ...extra });
  check('owner over promise, however late', outranks(o(9, 'owner', 500), o(1, 'text', 100)));
  check('promise over wish', outranks(o(9, 'reply', 500), o(1, 'lean', 100)));
  check('a wish never over a promise', !outranks(o(1, 'lean', 100), o(9, 'text', 500)));
  check('equal weight: the earlier commitment', outranks(o(9, 'text', 100), o(1, 'text', 200)) && !outranks(o(1, 'text', 200), o(9, 'text', 100)));
  check('equal weight, same second: the lower id, and never both',
    outranks(o(1, 'text', 100), o(9, 'text', 100)) && !outranks(o(9, 'text', 100), o(1, 'text', 100)));
  check('a plan does not outrank itself', !outranks(o(1, 'text', 100), o(1, 'text', 100)));
  check('no commit time on equal weight: neither (no crash)', !outranks({ id: 1, committed: { by: 'text' } }, { id: 2, committed: { by: 'text' } }));
}

section('the pre-020 seam (goldens)');
{
  __setOneBeingForTest(false);
  eq('off: a reply and an interview are wishes', [planWeight(by('reply')), planWeight(by('early', { kind: 'career:interview' }))], [WEIGHT.wish, WEIGHT.wish]);
  check('off: text and adopted are locked again', neverRethought(by('text')) && neverRethought(by('lean', { adopted: true })));
  __setOneBeingForTest(true);
  check('back on', !neverRethought(by('text')) && planWeight(by('reply')) === WEIGHT.promise);
}

// ── The engine ───────────────────────────────────────────────────────────────
await setupScratchDb();
const WORDS = ['moon', 'chai', 'rain', 'song', 'stars', 'balcony', 'noodles', 'traffic', 'cricket', 'beach', 'dogs', 'mango'];
let n = 0;
let castLine = null;
let planAnswer = null;
let planFor = null;
const says = () => JSON.stringify({ messages: [castLine ?? `${WORDS[n++ % WORDS.length]} ${n}`], tone: 'warm', topic: 'chat', end: true });
const { CALLER_PLAN } = phoneWorker;
const OTHER_NEW = 'cast:quiet-kay';
const cr = fakeCallRole({
  'life.phone.his': says, 'life.phone.mind': says, 'life.phone.cast': says,
  [CALLER_PLAN]: (sys, user) => JSON.stringify((planFor && String(user).includes(`them: ${planFor}`) && planAnswer) || { agreed: false, kind: 'outing', placeHint: null, when: null, day: null, minutes: null, confidence: 0.1 }),
});
let probs = null;
const jev = fakeJev((req) => {
  const q = req?.questions?.pick;
  if (!q || !probs) return {};
  const ids = Object.keys(q.criteria || {});
  const p = Object.fromEntries(ids.filter(id => id in probs).map(id => [id, probs[id]]));
  const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? { pick: jevChoice(best, p) } : {};
});
await setBot();
const [FRIEND] = await seedPeople([{ jid: '7301@lid', name: 'Avery', pn: '15550007301@s.whatsapp.net' }], { at: Date.UTC(2026, 6, 1) / 1000 });
const [GROUP] = await seedGroups([{ jid: '120363000000880001@g.us', name: 'A test group', members: [FRIEND] }], { at: Date.UTC(2026, 6, 1) / 1000 });
const OTHER = '15550009911@s.whatsapp.net';
let { world, clock, life } = await bootLife({ jev, callRole: cr });
story.__setDepsForTest({ mindBudgetOk: async () => ({ ok: false }), getUsageByCaller: () => [], identity: async () => 'You are a test persona.' });
const refold = async () => { await stopLife(); ({ life } = await bootLife({ world, clock, jev, callRole: cr })); story.__setDepsForTest({ mindBudgetOk: async () => ({ ok: false }), getUsageByCaller: () => [], identity: async () => 'You are a test persona.' }); };
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const FLAT = 'cast:flatmate';
const MEMBER = 'cast:coworker-a';
const OTHER_MEMBER = 'cast:coworker-b';
const dec = (id) => S().decisions.get(id);
const live = (e) => !S().excluded?.has?.(e.id);
const evs = (type) => listEvents({ types: [type], limit: 20000 }).filter(live);
const about = (type, id) => evs(type).filter(e => e.payload?.decisionId === id);
const dropped = (id) => evs('plan.made').filter(e => e.payload?.droppedFor === id);
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; } };
const today = (h, m = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, m, tz); };

async function ticks(k = 1) { await simulateHours(k * 0.25); }
async function untilTime(t) { while (clock.now() < t) await ticks(); }
// The next day at 17:00 (each scenario gets its own evening).
async function nextEvening() {
  const t = today(17, 0);
  await untilTime(clock.now() < t - 0 ? t : t + 24 * HOUR);
  // This world falls ill now and then: a sick evening would break every promise set up in it.
  for (let i = 0; i < 6 && S().vitals?.sick === true; i++) await untilTime(today(17, 0) + 24 * HOUR);
}
const evening = (at, label) => [{ id: 'go', label, go: true, kind: 'hangout' },
  { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 45, expiresAt: at + 90 * 60 }, { id: 'stay', label: 'Stay in', kind: 'rest' }];

/** A plan opened and committed, the way each producer writes it (raw: the fold has to see it after refold). */
function planEv({ who = 'text', at, castIds = [MEMBER], place = 'place:cafe', label = 'Coffee', kind = 'hangout', subjectJid = null, payload = {}, options = null, optionId = 'go' }) {
  const now = clock.now();
  const sub = subjectJid ? { subjectJid } : {};
  const opened = appendEvent({ type: 'decision.opened', at: now, actor: 'engine', ...sub, payload: {
    kind, subject: { eventAt: at, placeId: place, castIds, minutes: 90 }, options: options ?? evening(at, label),
    opensAt: now, decideBy: at - 2 * HOUR, ponrAt: at - HOUR, ...payload,
  } });
  if (who) appendEvent({ type: 'decision.committed', at: now, actor: 'engine', causeId: opened.id, ...sub, payload: { decisionId: opened.id, optionId, p: 1, sampled: false, by: who } });
  return opened.id;
}
/** Owner news about a member: linked to every plan with them (new_info → a lean at the next tick). */
function news(castId = MEMBER) {
  life.appendOwnerBatch([{ type: 'cast.beat', at: clock.now(), payload: { castId, kind: 'news', text: 'some news' } }], { by: 'test' });
}
const noteLean = (id) => about('decision.lean', id).at(-1);

await simulateHours(11);   // Tue 27 Oct, ~17:00, at the office
// No heavy stretch here: it holds back his organic texts, and these scenarios run for weeks of his time.
{
  const pv = await director.preview({ kind: 'fate', category: 'heavy', mode: 'frozen' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
}

section('a promise: a sure Jev lean reverses it once and it leaves today');
{
  await untilTime(today(17, 0));
  const id = planEv({ who: 'text', at: today(20, 0), label: 'Coffee one' });
  await refold();
  await ticks();
  check('(setup) a text plan is locked and fitted', isLockedOuting(dec(id)) && outingInPlan(S().plan, dec(id)), JSON.stringify(dec(id)?.committed));
  jev.reset();
  probs = { go: 0.03, late: 0.02, stay: 0.95 };
  news();
  await ticks();
  const req = jev.calls.find(c => c.questions?.pick && c.state?.committed_to === 'go');
  eq('Jev saw gave_his_word, and the promised option pulls in its utility', [req?.state?.gave_his_word,
    req?.state?.options?.find(o => o.id === 'go')?.utility > req?.state?.options?.find(o => o.id === 'stay')?.utility], [true, true]);
  eq('the lean stands, from Jev, not a fallback', [noteLean(id)?.actor, noteLean(id)?.payload?.optionId, noteLean(id)?.payload?.p, noteLean(id)?.payload?.fallback], ['jev', 'stay', 0.95, undefined]);
  eq('decision.reversed go → stay, one', about('decision.reversed', id).map(e => [e.payload.from, e.payload.to]), [['go', 'stay']]);
  eq('committed stay, one reversal, still by text', [dec(id)?.committed?.optionId, dec(id)?.reversals, dec(id)?.committed?.by], ['stay', 1, 'text']);
  check('no longer locked', !isLockedOuting(dec(id)));
  await ticks(2);
  eq('one plan.made droppedFor it, caused by the reversal', dropped(id).map(e => e.causeId), [about('decision.reversed', id)[0].id]);
  check('no block of today carries it', !(S().plan.blocks ?? []).some(b => b.decisionId === id), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  const plan = S().plan;
  check('the rest of his day is intact (sleep and an evening meal stay)', plan.blocks.some(b => b.kind === 'sleep') && plan.blocks.some(b => ['dinner', 'eat-out'].includes(b.kind)), plan.blocks.map(b => b.kind).join(','));
  await ticks(3);
  eq('…no plan churn after it (still one droppedFor)', dropped(id).length, 1);
  eq('he never leaves for it', evs('travel.started').filter(e => e.at >= today(17, 0) && e.payload?.to === 'place:cafe').length, 0);

  section('a second sure lean on a broken promise does nothing');
  jev.reset();
  probs = { go: 0.97, late: 0.01, stay: 0.02 };
  news();
  await ticks();
  eq('no second reversal', [about('decision.reversed', id).length, dec(id)?.committed?.optionId, dec(id)?.reversals], [1, 'stay', 1]);
  check('…and no Jev spend on it (the lean could change nothing)', !jev.calls.some(c => c.state?.options?.some?.(o => o.label === 'Coffee one')), JSON.stringify(jev.calls.map(c => c.state?.options?.map?.(o => o.label))));
  // The word he gave was to go: nothing pulls him towards the option he broke it for.
  const u = utilities(dec(id), S(), world, { at: clock.now() });
  const uPlain = utilities({ ...dec(id), committed: { ...dec(id).committed, by: 'lean' } }, S(), world, { at: clock.now() });
  eq('no promise pull on a decline', u.stay, uPlain.stay);

  section('trust: he broke his word to them (daily pass)');
  const t = earnedTrust(S(), { at: clock.now(), days: 1, world });
  const mine = t.get(MEMBER);
  check('broke_promise on the member of a text plan', (mine?.why ?? []).includes('broke_promise'), JSON.stringify([...t]));
}

section('a promise: a lean of 0.85 does not reverse it');
{
  await nextEvening();
  probs = null;
  const id = planEv({ who: 'text', at: today(20, 0), label: 'Coffee two' });
  await refold();
  await ticks();
  probs = { go: 0.1, late: 0.05, stay: 0.85 };
  news();
  await ticks();
  eq('the lean is recorded at 0.85', [noteLean(id)?.payload?.optionId, noteLean(id)?.payload?.p], ['stay', 0.85]);
  eq('no reversal; still go, still in today', [about('decision.reversed', id).length, dec(id)?.committed?.optionId, outingInPlan(S().plan, dec(id))], [0, 'go', true]);
  probs = { go: 0.1, stay: 0.9 };
  news();
  await ticks();
  eq('exactly at the threshold (0.9) it does', [about('decision.reversed', id).length, dec(id)?.committed?.optionId], [1, 'stay']);
}

section('a promise: a code-fallback lean of 0.99 never breaks it; the same fallback on a wish does');
{
  await nextEvening();
  probs = null;
  // Costs that make staying far better even with the promise pull: softmax over U/0.5.
  const at = today(20, 0);
  const lopsided = [{ id: 'go', label: 'A hard coffee', go: true, kind: 'hangout', bias: -3 },
    { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 45, expiresAt: at + 90 * 60, bias: -3 }, { id: 'stay', label: 'Stay in', kind: 'rest', bias: 3 }];
  const id = planEv({ who: 'text', at, options: lopsided });
  const wish = planEv({ who: 'lean', at: at + 3 * HOUR, castIds: [OTHER_MEMBER], options: lopsided.map(o => (o.id === 'late' ? { ...o, expiresAt: at + 3 * HOUR + 90 * 60 } : o)), payload: { ponrAt: at + 2 * HOUR } });
  await refold();
  await ticks();
  jev.fail(new Error('down'));
  news(MEMBER);
  news(OTHER_MEMBER);
  await ticks();
  jev.recover();
  const l = noteLean(id);
  check('(not vacuous) a fallback lean, stay, p ≥ 0.9', l?.payload?.fallback && l.payload.optionId === 'stay' && l.payload.p >= 0.9, JSON.stringify(l?.payload));
  eq('the promise holds', [about('decision.reversed', id).length, dec(id)?.committed?.optionId], [0, 'go']);
  const w = noteLean(wish);
  check('(control) the wish\'s lean is a fallback too', w?.payload?.fallback && w.payload.optionId === 'stay' && w.payload.p >= 0.7, JSON.stringify(w?.payload));
  eq('…and the wish reverses on it, as before 020', dec(wish)?.committed?.optionId, 'stay');
}

section('owner and goal plans are never re-leaned; a wish reverses at 0.7');
{
  await nextEvening();
  probs = null;
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: today(20, 0), minutes: 60, castIds: [MEMBER], label: 'Owner movie' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
  const owner = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Owner movie');
  const goal = planEv({ who: 'goal', at: today(22, 0), label: 'Goal walk', place: 'place:park', payload: { ponrAt: today(21, 0) } });
  const wish = planEv({ who: 'lean', at: today(23, 30), label: 'Late snack', place: 'place:restaurant', castIds: [MEMBER], payload: { ponrAt: today(22, 30) } });
  await refold();
  await ticks();
  jev.reset();
  probs = { go: 0.01, late: 0.01, stay: 0.98 };
  news(MEMBER);
  await ticks();
  eq('no lean on the owner\'s plan', about('decision.lean', owner.id).filter(e => e.at > pv.previewAt).length, 0);
  eq('…still his owner go', [dec(owner.id)?.committed?.by, dec(owner.id)?.committed?.optionId], ['owner', 'go']);
  // A goal's cast is the same member: the beat is linked, the guard is what stops it.
  eq('no lean on the goal outing', about('decision.lean', goal).length, 0);
  check('no Jev question about either (no spend)', !jev.calls.some(c => c.state?.options?.some?.(o => ['Owner movie', 'Goal walk'].includes(o.label))), JSON.stringify(jev.calls.map(c => c.state?.options?.map?.(o => o.label))));
  eq('the wish took the lean and reversed', dec(wish)?.committed?.optionId, 'stay');
  // A chat mention of them does not reach them either.
  const before = jev.calls.length;
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'that Cinema movie, you coming?' }, resolveAudience({ chatJid: GROUP }));
  eq('a chat mention: no lean on the owner\'s plan, no Jev call', [about('chat.trigger', owner.id).length, jev.calls.length - before], [0, 0]);
  const wish2 = planEv({ who: 'lean', at: today(23, 45), label: 'Late tea', place: 'place:restaurant', castIds: [OTHER_MEMBER], payload: { ponrAt: today(22, 45) } });
  await refold();
  await ticks();
  probs = { go: 0.3, late: 0.05, stay: 0.65 };
  news(OTHER_MEMBER);
  await ticks();
  eq('a wish holds at 0.65', dec(wish2)?.committed?.optionId, 'go');
  probs = { go: 0.25, late: 0.05, stay: 0.7 };
  news(OTHER_MEMBER);
  await ticks();
  eq('…and reverses at 0.7', [dec(wish2)?.committed?.optionId, dec(wish2)?.reversals], ['stay', 1]);
  probs = { go: 0.9, late: 0.05, stay: 0.05 };
  news(OTHER_MEMBER);
  await ticks();
  eq('…and may come back (a wish is not limited to one)', [dec(wish2)?.committed?.optionId, dec(wish2)?.reversals], ['go', 2]);
}

section('a rethought fitted plan: reverting the reversal brings it back');
{
  await nextEvening();
  probs = null;
  const at = today(20, 0);
  const id = planEv({ who: 'text', at, label: 'Coffee revert' });
  await refold();
  await ticks();
  probs = { go: 0.03, late: 0.02, stay: 0.95 };
  news();
  await ticks(2);
  eq('(setup) dropped once', dropped(id).length, 1);
  probs = null;
  const rev = about('decision.reversed', id)[0];
  life.revertEvent(rev.id, { reason: 'test', by: 'owner' });
  eq('the reversal is out, and its drop with it', [S().excluded.has(rev.id), dropped(id).length, dec(id)?.committed?.optionId, dec(id)?.reversals], [true, 0, 'go', 0]);
  await ticks(2);
  check('back in today', outingInPlan(S().plan, dec(id)), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  eq('no new drop', dropped(id).length, 0);
  await untilTime(at + 5 * 60);
  check('he goes after all', evs('travel.started').some(e => e.payload?.to === 'place:cafe' && e.at >= today(17, 0)), JSON.stringify(evs('travel.started').slice(-3)));
  eq('no could_not_go', about('decision.expired', id).length, 0);
}

section('a fitted promise reversed to "late": he no longer leaves on time');
{
  await nextEvening();
  probs = null;
  const at = today(20, 0);
  const id = planEv({ who: 'text', at, label: 'Coffee late', payload: { ponrAt: at - 20 * 60 } });
  await refold();
  await ticks();
  check('(setup) fitted at its own time', S().plan.blocks.some(b => b.decisionId === id && b.kind !== 'commute' && b.start === at));
  probs = { go: 0.03, late: 0.95, stay: 0.02 };
  news();
  await ticks();
  eq('(setup) reversed to late', dec(id)?.committed?.optionId, 'late');
  probs = null;
  await untilTime(at + 10 * 60);
  const trips = evs('travel.started').filter(e => e.payload?.to === 'place:cafe' && e.at >= today(17, 0) && e.at <= at);
  eq('he did not set off for the original time', trips.length, 0);
  eq('the on-time fit left his day, once', dropped(id).length, 1);
  await untilTime(at + 60 * 60);
  const after = evs('travel.started').filter(e => e.payload?.to === 'place:cafe' && e.at > at);
  eq('he sets off for the late start, once', after.length, 1);
  check('…from its late departure on (ponr + half the window)', after[0]?.at >= at + 25 * 60 - 900, JSON.stringify(after.map(e => hhmm(e.at, tz))));
  eq('still one drop; no could_not_go', [dropped(id).length, about('decision.expired', id).length], [1, 0]);
}

// Decision 12 turned this one around: before it, a reversal could land here and he finished the trip only to turn back.
section('no rethink once he has set off (the fit left before its point of no return)');
{
  await nextEvening();
  probs = null;
  const at = today(20, 0);
  // ponrAt as a plan opened near the place has it (a short trip), later than the departure the fit chose.
  const id = planEv({ who: 'text', at, label: 'Coffee on the way', place: 'place:cinema', payload: { ponrAt: at - 60 } });
  await refold();
  await ticks();
  const dep = S().plan.blocks.find(b => b.decisionId === id && b.kind === 'commute');
  check('(setup) a trip fitted before it', !!dep, JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  await untilTime(dep.start + 60);
  check('(setup) he is on the road', !!S().position?.travel, JSON.stringify(S().position));
  check('(setup) before its point of no return', clock.now() < dec(id).ponrAt);
  jev.reset();
  probs = { go: 0.03, late: 0.02, stay: 0.95 };
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'hangout tonight, skip it maybe' }, resolveAudience({ chatJid: GROUP }));
  news();
  await ticks();
  probs = null;
  eq('still going: no chat.trigger, no lean, no reversal', [dec(id)?.committed?.optionId, about('chat.trigger', id).length, about('decision.reversed', id).length], ['go', 0, 0]);
  check('…and no Jev spend', !jev.calls.some(c => c.state?.options?.some?.(o => o.label === 'Coffee on the way')));
  await untilTime(at + 30 * 60);
  check('he is there', evs('activity.started').some(e => e.at >= at - 1800 && e.payload?.placeId === 'place:cinema' && e.payload?.kind === 'hangout'));
}

section('a reversal on the very tick he set off: the pulse comes back, no re-plan loop');
{
  await nextEvening();
  probs = null;
  const at = today(20, 0);
  const id = planEv({ who: 'text', at, label: 'Coffee departure', place: 'place:cinema', payload: { ponrAt: at - 60 } });
  await refold();
  await ticks();
  const dep = S().plan.blocks.find(b => b.decisionId === id && b.kind === 'commute');
  await untilTime(dep.start);
  if (clock.now() < dep.start + 1) await life.tick();
  check('(setup) on the road', !!S().position?.travel, JSON.stringify(S().position));
  eq('a pick now is refused: it already happened', codeOf(() => director.plan({ kind: 'decision.pick', decisionId: id, optionId: 'stay' }, S(), { relax: true })), 'refused:consequence_applied');
  // The engine can't reverse it any more either (hasSetOff); a raw reversal stands in for one already in a log.
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: dec(id).committed.eventId, payload: { decisionId: id, from: 'go', to: 'stay', p: 0.95 } });
  await refold();
  await ticks(2);
  check('…the pulse came back, the plan left his day at most once', dropped(id).length <= 1, String(dropped(id).length));
  await ticks(2);
  check('…and no re-plan of it after that', dropped(id).length <= 1, String(dropped(id).length));
}

section('a chat nudge right before the deadline: the commit stays his');
{
  await nextEvening();
  probs = { go: 0.6, late: 0.2, stay: 0.2 };
  const at = today(21, 0);
  const id = planEv({ who: null, at, kind: 'hangout', label: 'Brewpub', castIds: [FLAT], payload: { decideBy: today(17, 40), ponrAt: today(20, 0) } });
  await refold();
  await ticks();    // 17:15: the deadline's own lean
  clock.advance({ minutes: 15 });
  probs = { go: 0.7, late: 0.15, stay: 0.15 };
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'hangout tonight, you coming?' }, resolveAudience({ chatJid: GROUP }));
  const trig = about('chat.trigger', id).at(-1);
  const lean = noteLean(id);
  check('(setup) a chat.trigger and a lean by it', trig && lean?.payload?.trigger === 'chat_mention' && lean.causeId === trig.id, JSON.stringify(lean));
  eq('the lean keeps the chat\'s origin', [lean.originKind, lean.originJid], ['group', GROUP]);
  await ticks(2);
  const commit = about('decision.committed', id)[0];
  check('(setup) committed at the deadline, after the chat lean', dec(id)?.status === 'committed' && noteLean(id)?.id === lean.id, JSON.stringify({ c: commit?.payload, leanNow: noteLean(id)?.id, lean: lean.id }));
  eq('its cause is the decision, nudged, self origin', [commit.causeId, commit.payload.nudged, commit.originKind], [id, true, 'self']);
  check('the decision still lists the chat among its origins (the lean never reaches another chat)', dec(id).origins.some(o => o.jid === GROUP), JSON.stringify(dec(id).origins));
  // A nudged plan is his (§A3): keeping it counts with the person he made it with, as any plan of his.
  const dNow = dec(id);
  const kept = { ...S(), decisions: new Map([[id, { ...dNow, status: 'committed', committed: { ...dNow.committed, optionId: 'go' }, reversals: 0 }]]) };
  const keptClean = { ...kept, decisions: new Map([[id, { ...kept.decisions.get(id), origins: [] }]]) };
  check('(control) the same plan with no chat lean earns kept_plan', (earnedTrust(keptClean, { at: at + 2 * HOUR, days: 1, world }).get(FLAT)?.why ?? []).includes('kept_plan'));
  check('trust: a nudged plan he kept still earns kept_plan', (earnedTrust(kept, { at: at + 2 * HOUR, days: 1, world }).get(FLAT)?.why ?? []).includes('kept_plan'), JSON.stringify(dNow.origins));
  eq('…and it names its lean (the undo link)', commit.payload.leanEventId, lean.id);
  // Decisions 1, 6 (they replaced "the commit stays"): a revoked line takes back what it caused.
  const cIds = cascadeIds(trig.id);
  check('cascadeIds follows the link', cIds.includes(lean.id) && cIds.includes(commit.id), JSON.stringify(cIds));
  const rv = life.revertEvent(trig.id, { reason: 'test', by: 'owner' });
  check('(setup) the chat.trigger is out of the log', !!rv && S().excluded.has(trig.id) && S().excluded.has(lean.id), JSON.stringify(rv));
  eq('reverting the chat.trigger takes the commit it nudged, live', [dec(id)?.committed ?? null, S().excluded.has(commit.id)], [null, true]);
  await refold();
  eq('…and after a full replay', [dec(id)?.committed ?? null, S().excluded.has(commit.id)], [null, true]);
  check('…the chat\'s origin is gone with its lean', !(dec(id).origins ?? []).some(o => o.jid === GROUP), JSON.stringify(dec(id).origins));
}

section('a chat nudge: an early commit and a reversal');
{
  await nextEvening();
  probs = { go: 0.5, late: 0.25, stay: 0.25 };
  const id = planEv({ who: null, at: today(21, 30), kind: 'picnic', place: 'place:park', label: 'Picnic', castIds: [FLAT], payload: { decideBy: today(20, 0), ponrAt: today(20, 30) } });
  await refold();
  await ticks();
  probs = { go: 0.92, late: 0.04, stay: 0.04 };
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'picnic later, you coming?' }, resolveAudience({ chatJid: GROUP }));
  const c = about('decision.committed', id)[0];
  eq('early commit on a chat lean: by early, cause the decision, nudged, self', [c?.payload?.by, c?.causeId, c?.payload?.nudged, c?.originKind], ['early', id, true, 'self']);
  clock.advance({ minutes: 16 });
  await life.tick();
  probs = { go: 0.04, late: 0.04, stay: 0.92 };
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'skip the picnic later?' }, resolveAudience({ chatJid: GROUP }));
  const r = about('decision.reversed', id)[0];
  eq('a reversal on a chat lean: cause the decision, nudged, self', [r?.causeId, r?.payload?.nudged, r?.originKind], [id, true, 'self']);
  // Its lean goes → the reversal goes; the earlier commit stands.
  const rLean = getEvent(r.payload.leanEventId);
  life.revertEvent(rLean.causeId, { reason: 'test', by: 'owner' });
  eq('revoking the line behind the reversal undoes the reversal only', [dec(id)?.committed?.optionId, dec(id)?.reversals, S().excluded.has(r.id), S().excluded.has(c.id)], ['go', 0, true, false]);
  // (A plan made in a chat keeps the plain cause, and a revoke takes it: chat-influence-tests/16-hooks-p2.)
  // A lean that isn't a chat's: no mark.
  const id2 = planEv({ who: null, at: today(23, 30), kind: 'hangout', place: 'place:cafe', label: 'Plain', castIds: [OTHER_MEMBER], payload: { decideBy: today(22, 0), ponrAt: today(22, 30) } });
  await refold();
  probs = { go: 0.95, late: 0.03, stay: 0.02 };
  news(OTHER_MEMBER);
  await ticks();
  const c2 = about('decision.committed', id2)[0];
  eq('a lean from news: caused by that lean, no nudged', [c2?.causeId, c2?.payload?.nudged], [noteLean(id2)?.id, undefined]);
}

section('the owner on chat-made plans; the real-person guard');
{
  await nextEvening();
  probs = null;
  const solo = planEv({ who: 'adopted', at: today(20, 0), label: 'Movie from a chat', place: 'place:cinema', castIds: [MEMBER], payload: { adopted: true, claimId: 91, category: 'social' } });
  const real = planEv({ who: 'reply', at: today(21, 30), label: 'A movie with a friend', place: 'place:cinema', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(20, 30) } });
  await refold();
  const pick = (decisionId, optionId) => codeOf(() => director.plan({ kind: 'decision.pick', decisionId, optionId }, S(), { relax: true }));
  eq('pick: both allowed', [pick(solo, 'stay'), pick(real, 'stay')], [null, null]);
  const outcome = (decisionId, o) => codeOf(() => director.plan({ kind: 'outcome', decisionId, outcome: o }, S(), { relax: true }));
  eq('cancel: both allowed', [outcome(solo, 'cancelled'), outcome(real, 'cancelled')], [null, null]);
  eq('outcome well: a chat plan yes, a real person\'s refused', [outcome(solo, 'well'), outcome(real, 'well'), outcome(real, 'badly')], [null, 'refused:real_person', 'refused:real_person']);
  const tone = (decisionId) => codeOf(() => director.plan({ kind: 'scene.tone', decisionId, tone: 'a good night', outcome: 'well' }, S(), { relax: true }));
  eq('tone: a chat plan yes, a real person\'s refused', [tone(solo), tone(real)], [null, 'refused:real_person']);
  const gv = story.godView();
  const row = (id) => (gv.decisions ?? []).find(x => x.id === id);
  eq('PLAY GOD lists them, marked', [row(solo)?.fromChat, row(solo)?.realPerson, row(real)?.fromChat, row(real)?.realPerson], [true, false, true, true]);
  eq('…toneable as the planner says', [row(solo)?.toneable, row(real)?.toneable], [true, false]);
  const J = JSON.stringify(gv);
  check('no JID in godView (either form)', !J.includes(OTHER) && !/@s\.whatsapp\.net|@lid|@g\.us/.test(J));
  const cat = buildCatalogue(S(), world, clock.now(), tz);
  const decs = cat.model?.decisions ?? [];
  eq('the prompt catalogue carries both, marked', [decs.find(x => x.id === solo)?.fromChat, decs.find(x => x.id === real)?.fromChat], [true, true]);
  const CJ = JSON.stringify(cat);
  check('no JID, no label in the catalogue\'s decisions', !/@s\.whatsapp\.net|@lid|@g\.us/.test(CJ) && !JSON.stringify(decs).includes('Movie from a chat'), JSON.stringify(decs));
  eq('…a real person only as a mark', [decs.find(x => x.id === solo)?.realPerson, decs.find(x => x.id === real)?.realPerson], [undefined, true]);

  section('a real person\'s plan stays out of the journal\'s self part (it is what the site can get)');
  const pv = await director.preview({ kind: 'decision.pick', decisionId: real, optionId: 'stay' }, { relax: true, project: false });
  check('its pick says nothing about every chat', !pv.warnings.includes(director.VISIBLE_EVERYWHERE), JSON.stringify(pv.warnings));
  await director.apply(pv.previewId, pv.fingerprint);
  eq('an applied pick on a real person\'s plan: the owner\'s now', [dec(real)?.committed?.optionId, dec(real)?.committed?.by], ['stay', 'owner']);
  const rev = about('decision.reversed', real);
  eq('…its event carries the subject', rev.map(e => e.subjectJid), [OTHER]);
  const dayEvents = listEvents({ limit: 20000 }).filter(e => e.at >= clock.now() - 6 * HOUR);
  const facts = selfFacts(dayEvents, { excluded: (i) => S().excluded?.has?.(i), tz });
  check('no bullet of it in the self part', !facts.events.some(i => { const e = getEvent(i); return e?.payload?.decisionId === real || e?.subjectJid; }), JSON.stringify(facts.bullets));
  // A plan made in a chat with no real person in it: nor that.
  const pvs = await director.preview({ kind: 'decision.pick', decisionId: solo, optionId: 'late' }, { relax: true, project: false });
  await director.apply(pvs.previewId, pvs.fingerprint);
  const again = selfFacts(listEvents({ limit: 20000 }).filter(e => e.at >= clock.now() - 6 * HOUR), { excluded: (i) => S().excluded?.has?.(i), tz });
  check('…nor a chat-made plan\'s', !again.events.some(i => getEvent(i)?.payload?.decisionId === solo), JSON.stringify(again.bullets));
  const pv2 = await director.preview({ kind: 'outcome', decisionId: solo, outcome: 'cancelled' }, { relax: true, project: false });
  await director.apply(pv2.previewId, pv2.fingerprint);
  await untilTime(today(19, 0));   // the cancel lands half an hour before its point of no return
  eq('an applied cancel of a chat plan: closed fell_through', [dec(solo)?.status, about('decision.expired', solo).map(e => e.payload.reason)], ['cancelled', ['fell_through']]);
}

section('the warning says what is true: who hears, per case');
{
  await nextEvening();
  probs = null;
  const real = planEv({ who: 'reply', at: today(21, 0), label: 'A friend\'s plan', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(20, 0), invite: true } });
  await refold();
  const planOf = (a) => director.plan(a, S(), { relax: true });
  const high = (p) => (p.continuity?.warnings ?? []).filter(w => w.code === 'messages_real_person');
  // Off, or it wouldn't really go out (the probe says no): no HIGH, "nobody is told".
  director.__setDepsForTest({ willTellBackOut: () => false });
  const quiet = planOf({ kind: 'outcome', decisionId: real, outcome: 'cancelled' });
  eq('nobody hears: no HIGH', high(quiet).length, 0);
  check('…"nobody is told"', quiet.warnings.includes(director.CHAT_PLAN) && !quiet.warnings.includes(director.CHAT_PLAN_TOLD), JSON.stringify(quiet.warnings));
  director.__setDepsForTest({ willTellBackOut: (d, { to }) => d.id === real && (to === null || to === 'stay') });
  const told = planOf({ kind: 'outcome', decisionId: real, outcome: 'cancelled' });
  check('a cancel that tells them: HIGH, in plain words', high(told).length === 1 && /WhatsApp message/.test(high(told)[0].text), JSON.stringify(told.continuity?.warnings));
  check('…and the line says so', told.warnings.includes(director.CHAT_PLAN_TOLD));
  const pick = planOf({ kind: 'decision.pick', decisionId: real, optionId: 'stay' });
  eq('a pick that tells them: HIGH', high(pick).length, 1);
  eq('a pick that doesn\'t (go → late here): none', high(planOf({ kind: 'decision.pick', decisionId: real, optionId: 'late' })).length, 0);
  // KEEP on an overlapping plan: he can only make one, and says who loses.
  const keep = planOf({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: today(21, 0), minutes: 60, castIds: [], label: 'Over it', resolutions: { [`decision:${real}`]: 'keep' } });
  const ov = (keep.continuity?.warnings ?? []).find(w => w.code === 'overlaps_plan');
  check('the kept plan falls through, and he tells them', /can only make one/.test(ov?.text) && /that plan falls through, and he tells them/.test(ov?.text), JSON.stringify(ov));
  director.__setDepsForTest({ willTellBackOut: () => false });
  const keep2 = planOf({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: today(21, 0), minutes: 60, castIds: [], label: 'Over it', resolutions: { [`decision:${real}`]: 'keep' } });
  const ov2 = (keep2.continuity?.warnings ?? []).find(w => w.code === 'overlaps_plan');
  check('…and says nothing about telling when nobody hears', /falls through/.test(ov2?.text) && !/tells them/.test(ov2?.text), JSON.stringify(ov2));
  director.__setDepsForTest({ willTellBackOut: null });
}

section('the dashboard says the same');
{
  const god = await import('../../src/dashboard/public/js/pages/life-director-god.js');
  const dom = await import('../../src/dashboard/public/js/core/dom.js');
  const row = (extra) => dom.renderToString(god.decisionRow({ id: 5, kind: 'movie', status: 'committed', eventAt: clock.now(), options: [{ id: 'go', label: 'Go' }], ...extra }, false));
  const real = row({ fromChat: true, realPerson: true });
  check('a real person\'s plan is marked, and offers only CANCELLED', /REAL PERSON/.test(real) && />CANCELLED</.test(real) && !/>WELL</.test(real) && !/>BADLY</.test(real), real);
  const chat = row({ fromChat: true, realPerson: false });
  check('a chat plan is marked, and keeps WELL / BADLY', /FROM A CHAT/.test(chat) && !/REAL PERSON/.test(chat) && />WELL</.test(chat), chat);
  check('his own: no mark', !/FROM A CHAT|REAL PERSON/.test(row({})));
  const guide = fs.readFileSync(new URL('../../src/dashboard/public/js/guides/life-director.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../../src/dashboard/public/js/pages/life-director-god.js', import.meta.url), 'utf8');
  for (const stale of ['Nothing here makes him message anyone', 'Plans made in a chat are not listed', 'plans he made in a chat (privacy', 'a plan made in a chat is kept']) {
    check(`guide: no more "${stale}"`, !guide.includes(stale));
  }
  check('page: no more "protected and never listed"', !page.includes('never listed here'));
}

section('two locked plans in one window: the outranked one could not go, once');
{
  await nextEvening();
  probs = null;
  const first = planEv({ who: 'text', at: today(20, 0), label: 'First promise' });
  clock.advance({ seconds: 30 });
  const second = planEv({ who: 'text', at: today(20, 30), label: 'Second promise', place: 'place:restaurant', castIds: [OTHER_MEMBER] });
  await refold();
  await ticks();
  check('the earlier commitment holds its time', outingInPlan(S().plan, dec(first)), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  check('(setup) the later one is outranked, not fitted', !outingInPlan(S().plan, dec(second)));
  eq('still committed before its point of no return', dec(second)?.status, 'committed');
  await untilTime(today(19, 45));
  eq('at its point of no return: could_not_go', [dec(second)?.status, about('decision.expired', second).map(e => e.payload.reason)], ['missed', ['could_not_go']]);
  await untilTime(today(20, 15));
  eq('…once', about('decision.expired', second).length, 1);
  eq('the holder is untouched', [dec(first)?.status, about('decision.expired', first).length], ['committed', 0]);
}

section('owner over promise, whoever committed first and whichever id is lower');
{
  await nextEvening();
  probs = null;
  const text = planEv({ who: 'text', at: today(20, 0), label: 'Text promise', place: 'place:restaurant' });
  await refold();
  await ticks();
  check('(setup) the promise is fitted', outingInPlan(S().plan, dec(text)));
  const owner = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: today(20, 0), minutes: 60, castIds: [], label: 'Owner over it',
    resolutions: { [`decision:${text}`]: 'keep' } }, { relax: true, project: false });
  await director.apply(owner.previewId, owner.fingerprint);
  await ticks();
  const mine = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Owner over it');
  check('the owner\'s outing is in the plan', outingInPlan(S().plan, mine), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  await untilTime(today(19, 45));
  eq('the kept promise could not go, once', [dec(text)?.status, about('decision.expired', text).map(e => e.payload.reason)], ['missed', ['could_not_go']]);
  eq('the owner\'s stands', mine?.status, 'committed');
}

section('a wish against a promise: the promise holds even when the wish has the lower id');
{
  await nextEvening();
  probs = null;
  const wish = planEv({ who: 'lean', at: today(20, 0), label: 'A wish', place: 'place:restaurant', castIds: [OTHER_MEMBER] });
  const prom = planEv({ who: 'text', at: today(20, 0), label: 'A promise', place: 'place:cinema' });
  await refold();
  await ticks();
  check('the promise is in the plan', outingInPlan(S().plan, dec(prom)));
  await untilTime(today(19, 30));
  eq('the wish could not go at its point of no return', [dec(wish)?.status, about('decision.expired', wish).map(e => e.payload.reason)], ['missed', ['could_not_go']]);
  eq('…the promise stands', dec(prom)?.status, 'committed');
}

// ── Interviews ───────────────────────────────────────────────────────────────
// Options as career.interviewSpec writes them (go|skip, never go/late/stay).
// subject.minutes = INTERVIEW_MIN as interviewSpec writes it (planEv's default is 90: overridden below).
const interviewOptions = [
  { id: 'go', label: 'Go to the interview', go: true, kind: 'meeting', minutes: INTERVIEW_MIN, stress: 6 },
  { id: 'skip', label: 'Skip it', kind: 'rest', minutes: 0 },
];
async function nextOfficeDay() {
  for (let i = 0; i < 8; i++) {
    const lp = localParts(clock.now(), tz);
    await simulateHours(24 - (lp.hour + lp.minute / 60 - 8.5));   // → ~08:30 the next day
    if (S().plan?.dayType === 'office') return;
  }
  throw new Error('no office day');
}
// A second office-kind place (huntOfficePlaceId's pick; the example world has only his own).
{
  const off = world.places.find(p => p.id === 'place:office');
  life.appendOwnerBatch([{ type: 'place.created', at: clock.now(), payload: { id: 'place:other-office', name: 'Other office', kind: 'office', lat: off.lat + 0.02, lon: off.lon + 0.02 } }], { by: 'test' });
}

section('an interview committed during work hours: he goes and comes back');
{
  await nextOfficeDay();
  probs = null;
  const at = today(14, 0);
  check('(setup) the hunt interviews at the other office', huntOfficePlaceId(S()) === 'place:other-office', huntOfficePlaceId(S()));
  const id = planEv({ who: 'early', at, kind: 'career:interview', castIds: [], place: 'place:other-office', options: interviewOptions,
    payload: { category: 'career', decideBy: today(9, 0), ponrAt: today(13, 15), subject: { eventAt: at, placeId: 'place:other-office', castIds: [], minutes: INTERVIEW_MIN } } });
  await refold();
  await ticks();
  check('(setup) an interview go is locked', isLockedOuting(dec(id)));
  check('fitted into today as soon as committed', outingInPlan(S().plan, dec(id)), JSON.stringify(S().plan.blocks.map(b => [b.kind, b.decisionId])));
  const blocks = S().plan.blocks;
  const out = blocks.find(b => b.decisionId === id && b.kind !== 'commute');
  eq('its block starts at the interview, at its place', [out?.start, out?.placeId], [at, 'place:other-office']);
  const after = blocks.filter(b => b.start >= (out?.end ?? 0));
  check('work comes back after it', after.some(b => b.kind === 'work'), after.map(b => b.kind).join(','));
  eq('…and it runs its own length (career.INTERVIEW_MIN), when the career step counts it over', out ? (out.end - out.start) / 60 : null, INTERVIEW_MIN);
  eq('busy during it: he doesn\'t answer chats mid-interview', out?.availability, 'busy');
  const spentBefore = evs('money.spent').length;
  await untilTime(today(17, 0));
  const trips = evs('travel.started').filter(e => e.at >= today(9, 0));
  check('he travelled there', trips.some(e => e.payload?.to === 'place:other-office'), JSON.stringify(trips.map(e => e.payload?.to)));
  check('…and back to the office', trips.some(e => e.payload?.to === 'place:office' && e.at > at), JSON.stringify(trips.map(e => [e.payload?.to, hhmm(e.at, tz)])));
  const started = evs('activity.started').filter(e => e.at >= at && e.at < at + 3 * HOUR).map(e => e.payload?.kind);
  check('he worked again after it', started.includes('work'), started.join(','));
  eq('no could_not_go', about('decision.expired', id).length, 0);
  eq('still committed: the career step can read how it went', dec(id)?.status, 'committed');
  const spends = evs('money.spent').slice(spentBefore).filter(e => e.at >= at && e.at <= at + 3 * HOUR && e.payload?.for === 'outing');
  eq('no outing spend for a job interview', spends.map(e => e.payload?.for), []);
}

section('an interview with no place of its own (a world with one office): the hunt still moves');
{
  await nextOfficeDay();
  probs = null;
  const at = today(14, 0);
  // career.interviewSpec: placeId = huntOfficePlaceId(s), null while there is no other office
  // (decisions.deadlines then has no trip: ponrAt = the interview's own time).
  const id = planEv({ who: 'early', at, kind: 'career:interview', castIds: [], place: null, options: interviewOptions,
    payload: { category: 'career', decideBy: today(9, 0), ponrAt: at } });
  await refold();
  await untilTime(at + 2 * HOUR);
  eq('no could_not_go: it stays committed, so career.consequence can read it', [dec(id)?.status, about('decision.expired', id).map(e => e.payload.reason)], ['committed', []]);
}

section('an interview: the job-hunt path through a real commit (a skip is no promise)');
{
  await nextOfficeDay();
  probs = null;
  const at = today(15, 0);
  const id = planEv({ who: 'sample', optionId: 'skip', at, kind: 'career:interview', castIds: [], place: 'place:other-office', options: interviewOptions,
    payload: { category: 'career', decideBy: today(9, 0), ponrAt: today(14, 15) } });
  await refold();
  await ticks();
  jev.reset();
  probs = { go: 0.75, skip: 0.25 };
  appendEvent({ type: 'decision.lean', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, optionId: 'skip', p: 0.6, probs: { go: 0.4, skip: 0.6 }, trigger: 'new_info' } });
  appendEvent({ type: 'place.updated', at: clock.now(), actor: 'owner', payload: { id: 'place:other-office', name: 'Other office', prev: {} } });
  await refold();
  await ticks();
  const req = jev.calls.find(c => c.state?.committed_to === 'skip');
  if (req) eq('a committed skip is no word he gave: no gave_his_word', req.state.gave_his_word, undefined);
  const uSkip = utilities(dec(id), S(), world, { at: clock.now() });
  const uPlain = utilities({ ...dec(id), kind: 'x' }, S(), world, { at: clock.now() });
  eq('…and no promise pull on it', uSkip.skip, uPlain.skip);
  probs = null;
}

section('an interview he skipped: nothing moves');
{
  await nextOfficeDay();
  probs = null;
  const at = today(14, 0);
  const id = planEv({ who: 'early', optionId: 'skip', at, kind: 'career:interview', castIds: [], place: 'place:other-office', options: interviewOptions,
    payload: { category: 'career', decideBy: today(9, 0), ponrAt: today(13, 15) } });
  await refold();
  const before = evs('plan.made').length;
  await untilTime(today(15, 0));
  check('not locked', !isLockedOuting(dec(id)));
  eq('no plan change for it', evs('plan.made').slice(before).filter(e => e.payload?.amendedFor === id || e.payload?.droppedFor === id).length, 0);
  eq('no trip, no block, no expiry', [evs('travel.started').filter(e => e.at >= today(9, 0) && e.payload?.to === 'place:other-office').length,
    (S().plan.blocks ?? []).some(b => b.decisionId === id), about('decision.expired', id).length], [0, false, 0]);
  eq('a committed skip reads as skip', dec(id)?.committed?.optionId, 'skip');
}

// ── backing_out texts ────────────────────────────────────────────────────────
const backing = (castId = null) => evs('phone.message').filter(e => e.payload?.trigger === 'backing_out' && (!castId || e.payload?.castId === castId));
// A throw here stops his whole phone (scan runs before everything else in the job): counted, and the section reads on.
const jobErrors = [];
async function drain() { await story.idle(); try { await story.runPhoneNow(); } catch (e) { jobErrors.push(e.message); } await story.idle(); }
const phoneTicks = async (k) => { for (let i = 0; i < k; i++) { await ticks(); await drain(); } };

const backingFor = (id) => backing().filter(e => getEvent(e.causeId)?.payload?.decisionId === id);
const nextDayOf = async (type) => {
  for (let i = 0; i < 8; i++) {
    const lp = localParts(clock.now(), tz);
    await simulateHours(24 - (lp.hour + lp.minute / 60 - 8.5));
    if (S().plan?.dayType === type) return;
  }
  throw new Error(`no ${type} day`);
};

section('the heavier plan\'s trip home holds no time: a plan right after it still happens');
{
  await nextDayOf('wfh');
  probs = null;
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: today(14, 0), minutes: 120, castIds: [], label: 'Owner cafe' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
  await ticks();
  const owner = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Owner cafe');
  check('(setup) a trip home stamped with the owner\'s plan', S().plan.blocks.some(b => b.decisionId === owner.id && b.kind === 'commute' && b.to !== 'place:cafe'), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
  const text = planEv({ who: 'text', at: today(16, 10), label: 'Right after', place: 'place:restaurant', payload: { ponrAt: today(15, 55) } });
  await refold();
  await untilTime(today(16, 45));
  eq('no could_not_go for the plan after it', [dec(text)?.status, about('decision.expired', text).length], ['committed', 0]);
  const started = evs('activity.started').filter(e => e.at >= today(13, 0)).map(e => e.payload?.placeId);
  check('he is at both', started.includes('place:cafe') && started.includes('place:restaurant'), JSON.stringify(started));
}

section('deploy: an outing the old engine amended is not fitted again; nothing is back-dated');
{
  await nextEvening();
  probs = null;
  __setOneBeingForTest(false);
  const at = today(19, 30);
  const reply = planEv({ who: 'reply', at, castIds: [], place: 'place:cafe', subjectJid: OTHER, label: 'Old reply', payload: { ponrAt: today(18, 45) } });
  await refold();
  await untilTime(today(19, 45));
  const old = S().plan.blocks.filter(b => b.fromAmendment && b.placeId === 'place:cafe' && b.start >= today(18, 0));
  check('(setup) the old engine amended it, with no stamp', old.length > 0 && old.every(b => !b.decisionId), JSON.stringify(old));
  // And one the old engine had not reached yet: committed before the deploy, its point of no return ahead.
  const ahead = planEv({ who: 'reply', at: today(22, 30), castIds: [], place: 'place:restaurant', subjectJid: OTHER, label: 'Old reply later', payload: { ponrAt: today(22, 0) } });
  __setOneBeingForTest(true);
  const head = lastEventId();
  const t0 = clock.now();
  await refold();
  await ticks();
  const after = listEvents({ after: head, limit: 500, order: 'asc' });
  eq('the first ticks: nothing dated before now', after.filter(e => e.at < t0).map(e => [e.type, e.at]), []);
  eq('it stays committed, no expiry', [dec(reply)?.status, about('decision.expired', reply).length], ['committed', 0]);
  eq('…no fit of it', after.filter(e => e.type === 'plan.made' && e.causeId === dec(reply).committed.eventId).length, 0);
  check('…still there', S().position?.placeId === 'place:cafe' || S().activity?.placeId === 'place:cafe', JSON.stringify(S().activity));
  const fit = after.filter(e => e.type === 'plan.made' && e.causeId === dec(ahead)?.committed?.eventId);
  check('the plan still ahead is fitted, dated now', fit.length === 1 && fit[0].at >= t0, JSON.stringify(fit.map(e => e.at - t0)));
}

section('trust: broke_promise for an invitation and an adopted plan; a nudge wipes nothing');
{
  const at = clock.now();
  const base = { id: 7001, status: 'committed', reversals: 1, origins: [], options: [{ id: 'go' }, { id: 'stay' }], subject: { eventAt: at + HOUR, castIds: [MEMBER] } };
  const why = (d) => earnedTrust({ ...S(), decisions: new Map([[d.id, d]]) }, { at: at + 60, days: 1, world }).get(MEMBER)?.why ?? [];
  const stay = (by) => ({ optionId: 'stay', by, at });
  check('an accepted invitation', why({ ...base, invite: true, inviteAnswer: 'yes', committed: stay('reply') }).includes('broke_promise'));
  check('an adopted plan', why({ ...base, adopted: true, committed: stay('adopted') }).includes('broke_promise'));
  check('a text plan a chat nudged', why({ ...base, origins: [{ kind: 'group', jid: GROUP }], committed: stay('text') }).includes('broke_promise'));
  check('the owner\'s own call on an adopted plan costs nothing', !why({ ...base, adopted: true, committed: stay('owner') }).includes('broke_promise'));
  eq('keeping a chat-made plan earns nothing (only breaking it counts)', why({ ...base, reversals: 0, adopted: true, subject: { eventAt: at - 3 * HOUR, castIds: [MEMBER] }, committed: { optionId: 'go', by: 'adopted', at: at - 5 * HOUR } }).filter(w => w === 'kept_plan'), []);
}

section('a chat lean on a promise only when the line pushes against it');
{
  await nextEvening();
  probs = null;
  const at = today(21, 0);
  const id = planEv({ who: 'text', at, payload: { ponrAt: today(20, 30) }, options: [
    { id: 'go', label: 'Pushed', go: true, kind: 'hangout', cost: { social: 3, travelMin: 15 } },
    { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 45, expiresAt: at + 90 * 60, cost: { social: 2, travelMin: 15 } },
    { id: 'stay', label: 'Stay in', kind: 'rest' }] });
  await refold();
  await ticks();
  jev.reset();
  probs = { go: 0.03, late: 0.02, stay: 0.95 };
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'hangout tonight, you coming?' }, resolveAudience({ chatJid: GROUP }));
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'how was that hangout' }, resolveAudience({ chatJid: GROUP }));
  eq('towards what he promised, or no side: no trigger, no Jev', [about('chat.trigger', id).length, jev.calls.filter(c => c.state?.committed_to === 'go').length], [0, 0]);
  await life.perceiveChat({ groupJid: GROUP, senderJid: FRIEND, content: 'skip the hangout tonight' }, resolveAudience({ chatJid: GROUP }));
  probs = null;
  eq('against it: a lean, and a sure one reverses', [about('chat.trigger', id).length, dec(id)?.committed?.optionId], [1, 'stay']);
}

section('sick through a promise: it falls through; an owner plan and a goal stay');
{
  await nextEvening();
  probs = null;
  const text = planEv({ who: 'text', at: today(20, 30), label: 'Promise coffee', payload: { ponrAt: today(20, 0) } });
  const goal = planEv({ who: 'goal', at: today(21, 30), label: 'Goal stroll', place: 'place:park', castIds: [], payload: { ponrAt: today(21, 0) } });
  const late = planEv({ who: 'reply', optionId: 'late', at: today(22, 0), label: 'Late promise', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(21, 30) } });
  await refold();
  const own = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: today(23, 40), minutes: 60, castIds: [], label: 'Owner film' }, { relax: true, project: false });
  await director.apply(own.previewId, own.fingerprint);
  const mine = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Owner film');
  const pv = await director.preview({ kind: 'quick', button: 'sick_day' }, { relax: true, project: false });
  check('the preview lists the promises it breaks', pv.warnings.some(w => /Promise coffee at .* falls through/.test(w)) && pv.warnings.some(w => /Late promise at .* falls through/.test(w)), JSON.stringify(pv.warnings));
  check('…with a continuity warning', (pv.continuity?.warnings ?? []).some(w => w.code === 'sick_promises'), JSON.stringify(pv.continuity?.warnings));
  check('…not the owner\'s plan or the goal', !pv.warnings.some(w => /Owner film|Goal stroll/.test(w)));
  const pvH = await director.preview({ kind: 'health', change: 'sick', days: 1 }, { relax: true, project: false });
  check('(health too)', pvH.warnings.some(w => /Promise coffee/.test(w)), JSON.stringify(pvH.warnings));
  await director.apply(pv.previewId, pv.fingerprint);
  await ticks(2);
  eq('the promises: could_not_go', [[dec(text)?.status, about('decision.expired', text).map(e => e.payload.reason)], [dec(late)?.status, about('decision.expired', late).map(e => e.payload.reason)]],
    [['missed', ['could_not_go']], ['missed', ['could_not_go']]]);
  eq('the owner plan and the goal stand', [dec(mine.id)?.status, dec(goal)?.status], ['committed', 'committed']);
  check('no block of today carries a broken promise', !(S().plan.blocks ?? []).some(b => [text, late].includes(b.decisionId)), JSON.stringify(S().plan.blocks.filter(b => b.decisionId)));
}

section('a schedule range over a late promise defaults to keep, like a go');
{
  await nextEvening();
  probs = null;
  const go = planEv({ who: 'reply', at: today(20, 0), label: 'Said yes', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(19, 30) } });
  const late = planEv({ who: 'reply', optionId: 'late', at: today(22, 0), label: 'Said late', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(21, 30) } });
  await refold();
  const { rows } = planEdits.conflictsOf(S(), { ranges: [{ activity: 'home', from: today(19, 0), to: today(23, 30) }] }, { now: clock.now(), tz, plan: S().plan });
  const row = (id) => rows.find(r => r.id === id);
  eq('both keep, both marked', [row(go)?.resolution, row(late)?.resolution, row(go)?.locked, row(late)?.locked], ['keep', 'keep', true, true]);
}

section('backing_out: a fictional member gets one text');
{
  await nextEvening();
  await drain();   // the scan's cursor is at the log head from here
  probs = null;
  const id = planEv({ who: 'text', at: today(21, 0), label: 'Coffee phone', payload: { ponrAt: today(20, 0) } });
  await refold();
  await ticks();
  probs = { go: 0.03, late: 0.02, stay: 0.95 };
  news();
  await ticks();
  probs = null;
  eq('(setup) reversed', dec(id)?.committed?.optionId, 'stay');
  cr.reset();
  await phoneTicks(6);
  eq('the phone job did not fail on the new trigger', [...new Set(jobErrors)], []);
  const t = backingFor(id);
  eq('one turn, his side, to them', t.map(e => [e.payload.dir, e.payload.castId]), [['out', MEMBER]]);
  eq('…caused by the reversal', t[0]?.causeId, about('decision.reversed', id)[0].id);
  check('the sheet says why', cr.callsFor('life.phone.his').some(c => /can't make the plan/.test(String(c.user))), String(cr.callsFor('life.phone.his').at(-1)?.user).slice(0, 400));
  await phoneTicks(4);
  eq('still one', backingFor(id).length, 1);
  // One failed scan stops everything after it in the job: the phone must still work for anyone else.
  const ask = await director.preview({ kind: 'text', castId: 'cast:parent', gist: 'how are things', at: 'now' }, { relax: true, project: false });
  await director.apply(ask.previewId, ask.fingerprint);
  await phoneTicks(2);
  check('after a back-out, an owner\'s text to someone else still goes out', evs('phone.message').some(e => e.payload?.castId === 'cast:parent' && e.payload?.trigger === 'owner'), JSON.stringify([...new Set(jobErrors)]));
}

section('backing_out: could_not_go tells them too; the flatmate, a real person, a past outing get none');
{
  await nextEvening();
  await drain();
  probs = null;
  const plain = planEv({ who: 'text', at: today(21, 0), label: 'Plain', castIds: ['cast:sibling'], payload: { ponrAt: today(20, 0) } });
  const flat = planEv({ who: 'text', at: today(21, 15), label: 'With flatmate', castIds: [FLAT], payload: { ponrAt: today(20, 15) } });
  const real = planEv({ who: 'reply', at: today(21, 30), label: 'With a friend', castIds: [], subjectJid: OTHER, payload: { ponrAt: today(20, 30) } });
  const realWithCast = planEv({ who: 'reply', at: today(21, 40), label: 'With a friend and a coworker', castIds: [MEMBER], subjectJid: OTHER, payload: { ponrAt: today(20, 40) } });
  const past = planEv({ who: 'text', at: today(16, 0), label: 'Earlier', castIds: [MEMBER], payload: { ponrAt: today(15, 0), decideBy: today(14, 0) } });
  const notGoing = planEv({ who: 'lean', optionId: 'stay', at: today(21, 50), label: 'Stayed in', castIds: [MEMBER], payload: { ponrAt: today(20, 50) } });
  const now = clock.now();
  for (const id of [plain, flat, past, notGoing]) appendEvent({ type: 'decision.expired', at: now, actor: 'engine', causeId: id, payload: { decisionId: id, reason: 'could_not_go' } });
  for (const id of [real, realWithCast]) appendEvent({ type: 'decision.expired', at: now, actor: 'engine', causeId: id, subjectJid: OTHER, payload: { decisionId: id, reason: 'could_not_go' } });
  await refold();
  // He may be at the gym or on the road for a while (his side waits); the plan is at 21:00.
  for (let i = 0; i < 14 && !backingFor(plain).length; i++) await phoneTicks(1);
  eq('could_not_go: one turn to the plain plan\'s member, caused by the expiry', backingFor(plain).map(e => [e.payload.dir, getEvent(e.causeId)?.type]), [['out', 'decision.expired']]);
  eq('none for the flatmate', backingFor(flat).length, 0);
  eq('none for a real person\'s plan, with or without a cast member', [backingFor(real).length, backingFor(realWithCast).length], [0, 0]);
  eq('none for an outing already past', backingFor(past).length, 0);
  eq('none for a plan he had already said no to', backingFor(notGoing).length, 0);
}

section('backing_out: a departed member');
{
  await nextEvening();
  await drain();
  const pv = await director.preview({ kind: 'cast.depart', castId: OTHER_MEMBER, how: 'moved_away' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
  check('(setup) departed', !S().cast.has(OTHER_MEMBER));
  await drain();
  const both = planEv({ who: 'text', at: today(21, 0), label: 'Group coffee', castIds: [OTHER_MEMBER, MEMBER], payload: { ponrAt: today(20, 0) } });
  appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: both, payload: { decisionId: both, reason: 'could_not_go' } });
  await refold();
  await phoneTicks(6);
  eq('the one who left gets none, the one still here gets one', backingFor(both).map(e => e.payload.castId), [MEMBER]);
}

section('backing_out: the trigger list');
{
  const src = fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function turnsFor('), src.indexOf('/** Cursor scan'));
  const pushed = [...body.matchAll(/, '([a-z_]+)', (?:ev\.at|finite)/g)].map(m => m[1]);
  check('(not vacuous) turnsFor queues several triggers', pushed.length >= 7, JSON.stringify(pushed));
  eq('every trigger turnsFor can queue is listed', [...new Set(pushed)].sort(), [...phoneWorker.TURN_TRIGGERS].sort());
  check('…and the store allows each', phoneWorker.TURN_TRIGGERS.every(t => phoneStore.TRIGGERS.includes(t)));
}

section('backing_out: one bad row is skipped, it never wedges the phone');
{
  await nextEvening();
  await drain();
  const id = planEv({ who: 'text', at: today(21, 0), label: 'Bad row', castIds: [MEMBER], payload: { ponrAt: today(20, 0) } });
  const ev = appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, reason: 'could_not_go' } });
  await refold();
  const warnings = [];
  const realWarn = logger.warn;
  logger.warn = (o, m) => { warnings.push(o); return realWarn.call(logger, o, m); };
  phoneWorker.scan({ insert: () => { throw new TypeError('phone store: bad trigger'); } });
  logger.warn = realWarn;
  check('the cursor moved past it', phoneStore.getCursor() >= ev.id, String(phoneStore.getCursor()));
  check('…with a warning (codes only)', warnings.some(w => w.where === 'arcs.phone.scan' && w.err === 'TypeError'), JSON.stringify(warnings));
}

section('backing_out: go ↔ late is not backing out');
{
  await nextEvening();
  await drain();
  const id = planEv({ who: 'text', at: today(21, 0), label: 'Running late', castIds: [MEMBER], payload: { ponrAt: today(20, 0) } });
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, from: 'go', to: 'late', p: 0.95 } });
  await refold();
  await phoneTicks(4);
  eq('no text for go → late', backingFor(id).map(e => [getEvent(e.causeId)?.type, getEvent(e.causeId)?.payload, hhmm(e.at, tz), hhmm(getEvent(e.causeId)?.at, tz)]), []);
  const id2 = planEv({ who: 'lean', optionId: 'late', at: today(21, 30), label: 'Comes after all', castIds: [MEMBER], payload: { ponrAt: today(20, 30) } });
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: id2, payload: { decisionId: id2, from: 'late', to: 'go', p: 0.95 } });
  await refold();
  await phoneTicks(2);
  eq('none for late → go', backingFor(id2).length, 0);
}

section('backing_out: never for a plan made in a chat (no text, nothing on the site)');
{
  await nextEvening();
  await drain();
  const id = planEv({ who: 'adopted', at: today(21, 0), label: 'Dinner from a chat', castIds: [MEMBER], payload: { adopted: true, claimId: 77, category: 'social', ponrAt: today(20, 0) } });
  appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, reason: 'owner_cancelled' } });
  await refold();
  await phoneTicks(4);
  eq('no back-out text for it', backingFor(id).length, 0);
  eq('…none even queued', phoneStore.pendingFor(MEMBER).filter(r => r.trigger === 'backing_out' && getEvent(r.triggerEventId)?.payload?.decisionId === id).length, 0);
}

section('backing_out: the plan came back before he sent it → nothing');
{
  await nextEvening();
  await drain();
  const id = planEv({ who: 'text', at: today(21, 0), label: 'Back on', castIds: [MEMBER], payload: { ponrAt: today(20, 0) } });
  const rev = appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, from: 'go', to: 'stay', p: 0.95 } });
  await refold();
  phoneWorker.scan();
  const row = phoneStore.pendingFor(MEMBER).find(r => r.trigger === 'backing_out' && r.triggerEventId === rev.id);
  check('(setup) a turn is waiting', !!row);
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, from: 'stay', to: 'go', p: 0.95 } });
  await refold();
  const r = await phoneWorker.runTurn(row);
  eq('re-checked at send time: skipped', [r.status, r.reason], ['skipped', 'changed']);
  eq('no text', backingFor(id).length, 0);
}

section('backing_out: only someone who knows about it');
{
  await nextEvening();
  await drain();
  // A plain wish plan with someone he has no thread with: "can't make it" would come out of nowhere.
  const hasThread = (c) => !!phoneStore.lastLive(c);
  const parent = 'cast:parent';
  life.appendOwnerBatch([{ type: 'cast.created', at: clock.now(), payload: { id: OTHER_NEW, name: 'Quiet Kay', relation: 'friend', metrics: { closeness: 0.3, trust: 0.5, tension: 0 } } }], { by: 'test' });
  check('(setup) a thread with one, none with the other', hasThread(parent) && !hasThread(OTHER_NEW), JSON.stringify([hasThread(parent), hasThread(OTHER_NEW)]));
  const wish = (castIds, label, h) => planEv({ who: 'lean', at: today(h, 0), label, castIds, payload: { ponrAt: today(h - 1, 0) } });
  const a = wish([OTHER_NEW], 'No thread', 21);
  const b = wish([parent], 'With a thread', 22);
  for (const id of [a, b]) appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, reason: 'could_not_go' } });
  await refold();
  for (let i = 0; i < 14 && !backingFor(b).length; i++) await phoneTicks(1);
  eq('a wish plan, no thread: none', backingFor(a).length, 0);
  eq('a wish plan, an existing thread: one', backingFor(b).map(e => e.payload.castId), [parent]);
  // A member the owner just wrote in, with a thread by now, but this was to be their first meeting.
  await nextEvening();
  await drain();
  life.appendOwnerBatch([{ type: 'cast.created', at: clock.now(), payload: { id: 'cast:new-face', name: 'Newface', relation: 'friend', metrics: { closeness: 0.3, trust: 0.5, tension: 0 } } }], { by: 'test' });
  const ask = await director.preview({ kind: 'text', castId: 'cast:new-face', gist: 'nice to meet you soon', at: 'now' }, { relax: true, project: false });
  await director.apply(ask.previewId, ask.fingerprint);
  for (let i = 0; i < 12 && !phoneStore.lastLive('cast:new-face'); i++) await phoneTicks(1);
  check('(setup) a thread with the new member', !!phoneStore.lastLive('cast:new-face'));
  const first = wish(['cast:new-face'], 'First meeting', 22);
  appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: first, payload: { decisionId: first, reason: 'could_not_go' } });
  await refold();
  await phoneTicks(4);
  eq('a first meeting: none', backingFor(first).length, 0);
}

section('a backed-out text plan no longer blocks a new plan with them');
{
  await nextEvening();
  await drain();
  const id = planEv({ who: 'text', at: today(21, 0), label: 'Backed out', castIds: [MEMBER], payload: { ponrAt: today(20, 0) } });
  appendEvent({ type: 'decision.reversed', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, from: 'go', to: 'stay', p: 0.95 } });
  await refold();
  eq('textPlansAhead no longer counts it', textPlansAhead({ decisions: new Map([[id, dec(id)]]) }, clock.now()), 0);
  await phoneTicks(2);
  cr.reset();
  castLine = 'sure, see you tomorrow at 8 then';
  planAnswer = { agreed: true, kind: 'outing', placeHint: 'dinner', when: '20:00', day: 'tomorrow', minutes: 90, confidence: 0.95 };
  planFor = String(S().cast.get(MEMBER).name).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0];
  const ask = await director.preview({ kind: 'text', castId: MEMBER, words: 'sure, dinner tomorrow at 8 then, see you', at: 'now' }, { relax: true, project: false });
  await director.apply(ask.previewId, ask.fingerprint);
  const newPlans = () => [...S().decisions.values()].filter(d => d.id > id && d.status === 'committed' && d.committed?.by === 'text' && d.committed.optionId === 'go' && (d.subject?.castIds ?? []).includes(MEMBER));
  for (let i = 0; i < 12 && !newPlans().length; i++) await phoneTicks(1);
  await story.idle();
  castLine = null;
  planAnswer = null;
  check('the clerk was asked: "already_planned" no longer stops it', cr.callsFor(CALLER_PLAN).length >= 1, String(cr.callsFor(CALLER_PLAN).length));
  eq('…and a new plan with them exists', newPlans().length, 1);
}

section('backing_out: a text held back while he is with someone never goes out after the plan\'s time');
{
  await nextDayOf('wfh');
  await drain();
  probs = null;
  // With the flatmate 14:30 to 17:00: one stream of attention holds his own texts until they part.
  const pv = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:park', startAt: today(14, 30), minutes: 150, castIds: [FLAT], label: 'Long walk' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
  await untilTime(today(15, 0));
  check('(setup) he is with the flatmate', (S().activity?.withCast ?? []).includes(FLAT), JSON.stringify(S().activity));
  const at = today(16, 0);
  const id = planEv({ who: 'text', at, label: 'Short coffee', castIds: [MEMBER], payload: { ponrAt: today(15, 45), decideBy: today(15, 0) } });
  appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: id, payload: { decisionId: id, reason: 'could_not_go' } });
  await refold();
  await drain();
  await phoneTicks(28);   // → 22:00 (the gym, a trip: his side keeps waiting)
  eq('no "can\'t make it" after the plan was over', backingFor(id).filter(e => e.at >= at).map(e => hhmm(e.at, tz)), []);
}

await stopLife();
void config;
section('one rule for two plans: only the heavier plan\'s outing holds the time');
{
  const { outranked } = await import('../../src/life/pulse.js');
  const T = 1793500000;
  const owner = { id: 1, status: 'committed', committed: { optionId: 'go', by: 'owner', at: T }, subject: { placeId: 'p:a', eventAt: T + 7200 } };
  const promise = { id: 2, status: 'committed', committed: { optionId: 'go', by: 'text', at: T }, subject: { placeId: 'p:b', eventAt: T + 3600 }, options: [{ id: 'late', expiresAt: T + 5400 }] };
  const st = { decisions: new Map([[1, owner], [2, promise]]) };
  const blocks = (arr) => ({ blocks: arr });
  check('overlapping only his way to the heavier plan: not outranked (the fit trims it)',
    outranked(st, blocks([{ decisionId: 1, kind: 'commute', to: 'p:a', start: T + 5000, end: T + 7200 }, { decisionId: 1, kind: 'hangout', start: T + 7200, end: T + 9000 }]), promise) === null);
  check('overlapping the heavier outing itself: outranked',
    outranked(st, blocks([{ decisionId: 1, kind: 'hangout', start: T + 5000, end: T + 9000 }]), promise)?.id === 1);
}

section('chatting with the person he promised is no news about the plan');
{
  const { detectTriggers } = await import('../../src/life/decisions.js');
  const T = 1793500000;
  const d = { id: 2, status: 'committed', committed: { optionId: 'go', by: 'text', at: T }, ponrAt: T + 9000, reversals: 0, lean: { eventId: 5, at: T, state: {} }, subject: { castIds: ['cast:x'], eventAt: T + 9000 }, options: [{ id: 'go' }, { id: 'stay' }] };
  const state = { vitals: {}, decisions: new Map([[2, d]]) };
  const w = { timezone: 'UTC' };
  const ev = (id, type, payload) => ({ id, type, at: T + 60, payload, causeId: null });
  eq('a text with them: no trigger', detectTriggers(d, state, { at: T + 60, newEvents: [ev(6, 'phone.message', { castId: 'cast:x' })], world: w }).filter(t => t.trigger === 'new_info'), []);
  eq('a metric nudge: no trigger', detectTriggers(d, state, { at: T + 60, newEvents: [ev(7, 'relationship.changed', { castId: 'cast:x' })], world: w }).filter(t => t.trigger === 'new_info'), []);
  check('their real news still is', detectTriggers(d, state, { at: T + 60, newEvents: [ev(8, 'cast.beat', { castId: 'cast:x' })], world: w }).some(t => t.trigger === 'new_info'));
}

report();
