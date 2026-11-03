// 019 his phone — the owner's scenario (2026-11-01): "He is asleep and is woken by a notification
// on his phone: she has texted 'Hey. Are you awake?' — a late-night chat; she felt a spark."
// The Director kind `text` with from 'them', her exact words and a long chat: one apply adds the
// owner's wake.set {woken_up, via:'phone'} (he is asleep) + phone.text_set → her words verbatim
// (no model call) → he wakes → he answers → they go back and forth through the night (no 07:00
// wait for her while the chat is live, answers within minutes, up to LONG_EXCHANGE_MAX turns)
// → he goes back to sleep. Also: from them while he is awake (no wake, the clerk writes her
// opener), a short owner chat keeps EXCHANGE_MAX, an organic text still waits for her morning,
// the Day rows and CHANGES words, the public reader, and the Tell-the-story draft shape.
// Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole,
} from './_helpers.js';
import { getEvent, lastEventId, listEvents } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, dateKey } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
import { LONG_EXCHANGE_MAX, EXCHANGE_MAX, OWNER_REPLY_MIN } from '../../src/life/story/phone/worker.js';
import { config } from '../../src/utils/config.js';
import { __setWalletForTest } from '../../src/life/spending.js';
__setWalletForTest(false);

await setupScratchDb();

const ledger = [];
const usage = (prefix, since) => {
  const rows = new Map();
  for (const r of ledger) {
    if (r.at < since || !r.caller.startsWith(prefix)) continue;
    const x = rows.get(r.caller) ?? { caller: r.caller, calls: 0, costUsd: 0 };
    x.calls += 1; x.costUsd += r.cost;
    rows.set(r.caller, x);
  }
  return [...rows.values()];
};
// Each stub turn says something new (the phone validator drops a text that repeats the thread).
const WORDS = ['moon', 'chai', 'rain', 'song', 'stars', 'balcony', 'noodles', 'traffic', 'cricket', 'beach', 'movie', 'sunrise', 'coffee', 'jokes', 'dogs', 'mango'];
let turnNo = 0;
const fresh = () => `${WORDS[turnNo++ % WORDS.length]} ${turnNo}`;   // two words: no 3-word run, no sticky word
let his = () => ({ messages: [fresh()], tone: 'warm', topic: 'up late', end: false });
let theirs = () => ({ messages: [fresh()], tone: 'flirty', topic: 'up late', end: false });
let clockNow = () => 0;
const cr = fakeCallRole({
  'life.phone.his': (sys, user) => { ledger.push({ caller: 'life.phone.his', at: clockNow(), cost: 0.001 }); return JSON.stringify(his(user)); },
  'life.phone.mind': (sys, user) => { ledger.push({ caller: 'life.phone.mind', at: clockNow(), cost: 0.01 }); return JSON.stringify(his(user)); },
  'life.phone.cast': (sys, user) => { ledger.push({ caller: 'life.phone.cast', at: clockNow(), cost: 0.001 }); return JSON.stringify(theirs(user)); },
});
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
clockNow = () => clock.now();
story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: false }), knownNames: () => ['Quinn Marlow'],
  identity: async () => 'You are Kiran, a 28-year-old from the example town.' });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const her = 'cast:coworker-a';
const other = 'cast:coworker-b';
config.arcs.phoneOrganicPerDay = 0;   // no texts out of the blue mixing into the threads under test

async function drain() { await story.idle(); await story.runPhoneNow(); await story.idle(); }
// Through the story facade (as the route does): an apply with a wake settles the pulse at once.
async function applyAction(action) {
  const pv = await story.director.preview(action);
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  return { pv, res };
}
const at = (dayOffset, hh, mm = 0) => {
  const p = localParts(clock.now(), tz);
  return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * 86400;
};
async function untilTime(t) { while (clock.now() < t) await simulateHours(0.25); }
// The sim advances in whole ticks (15 min here): one step = one tick + the phone job.
async function step() { await simulateHours(0.25); await drain(); }
const hourOf = (t) => localParts(t, tz).hour + localParts(t, tz).minute / 60;

section('first job seeds the cursor');
{
  await simulateHours(0.5);
  await drain();
  check('cursor seeded', phoneStore.getCursor() !== null && phoneStore.getCursor() <= lastEventId());
}

let wakeEv; let askEv; let actionId;
section('asleep at 02:00: "Hey. Are you awake?" — her text, his wake, one apply');
{
  await untilTime(at(1, 2, 0));
  for (let i = 0; i < 8 && S().activity?.kind !== 'sleep'; i++) await simulateHours(0.25);
  check('he is asleep', S().activity?.kind === 'sleep', S().activity?.kind);
  const castCalls = cr.callsFor('life.phone.cast').length;
  const { pv, res } = await applyAction({ kind: 'text', castId: her, from: 'them', words: 'Hey. Are you awake?', gist: "can't sleep; she felt a spark at the cafe", chat: 'long' });
  check('the preview says she texts him, her words, and that it wakes him',
    pv.warnings?.some(w => /texts him: "Hey\. Are you awake\?"/.test(w)) && pv.warnings?.some(w => /the text wakes him/.test(w)) && pv.warnings?.some(w => /a long chat/.test(w)), pv.warnings);
  const evs = res.eventIds.map(getEvent);
  wakeEv = evs.find(e => e.type === 'wake.set');
  askEv = evs.find(e => e.type === 'phone.text_set');
  actionId = evs.find(e => e.type === 'director.action')?.id;
  eq('the wake: owner, woken up, via the phone, at the text', [wakeEv?.actor, wakeEv?.payload?.reason, wakeEv?.payload?.via, wakeEv?.payload?.at === askEv?.payload?.at], ['owner', 'woken_up', 'phone', true]);
  check('back to sleep planned about 90 min later', Number.isFinite(wakeEv?.payload?.until) && wakeEv.payload.until - wakeEv.payload.at <= 90 * 60 && wakeEv.payload.until - wakeEv.payload.at > 30 * 60, wakeEv?.payload);
  eq('the ask: from them, her exact words, a long chat', [askEv?.payload?.from, askEv?.payload?.words, askEv?.payload?.chat], ['them', 'Hey. Are you awake?', 'long']);
  // Live, nothing else runs the job before the next grid tick: the apply itself must (2026-11-01,
  // the owner's first try waited for the tick). No drain, no tick here — only the apply's kick.
  check('the apply runs the phone job itself (lastPhoneKick)', typeof res.phone === 'boolean' && res.phone === true && story.lastPhoneKick() !== null);
  await story.lastPhoneKick();
  await story.idle();
  check('her opener is live right after the apply, before any tick', phoneStore.threadOf(her, { live: true }).some(r => r.dir === 'in' && r.text === 'Hey. Are you awake?'));
  await drain();
  for (let i = 0; i < 6 && !phoneStore.threadOf(her, { live: true }).length; i++) await step();
  const first = phoneStore.threadOf(her, { live: true }).at(-1);
  eq('her opener is live: verbatim, from her, the owner\'s turn, no writer', [first?.dir, first?.text, first?.trigger, first?.tier], ['in', 'Hey. Are you awake?', 'owner', null]);
  eq('no model call for her words', cr.callsFor('life.phone.cast').length, castCalls);
  check('sent in the night (before 07:00)', hourOf(first?.at) < 7, hourOf(first?.at));
  const woke = listEvents({ types: ['woke'], from: askEv.at - 60, limit: 10 }).find(e => e.payload?.wakeSetId === wakeEv.id);
  check('he woke from it (an interrupted night)', woke?.payload?.interrupted === true, woke?.payload);
}

section('they chat through the night: he answers once up, she answers within minutes, no 07:00 wait');
{
  for (let i = 0; i < 24 && phoneStore.pendingFor(her).length; i++) await step();
  const rows = phoneStore.threadOf(her, { live: true }).reverse();   // oldest first
  // The sim's phone job runs once a 15-min tick (live: a timer runs each text at its own due time),
  // so here the chat moves a turn a tick and stops when he dozes off at the wake's end.
  check('a real back-and-forth (≥ 5 turns, ≤ the long cap)', rows.length >= 5 && rows.length <= LONG_EXCHANGE_MAX, rows.length);
  check('the turns alternate her → him → her …', rows.every((r, i) => r.dir === (i % 2 === 0 ? 'in' : 'out')), rows.map(r => r.dir));
  check('every turn in the night (before 07:00) — she stayed up for it', rows.every(r => hourOf(r.at) < 7), rows.map(r => hourOf(r.at).toFixed(2)));
  const gaps = rows.slice(1).map((r, i) => r.at - rows[i].at);
  // Due 1–6 min after the last turn; the sim runs the phone job once a 15-min tick → ≤ one tick + 6 min.
  check(`answers within minutes (due ≤ ${OWNER_REPLY_MIN[1]} min; written at the next tick)`, gaps.slice(1).every(g => g <= (15 + OWNER_REPLY_MIN[1]) * 60), gaps);
  const his1 = rows[1];
  const woke = listEvents({ types: ['woke'], from: askEv.at - 60, limit: 10 }).find(e => e.payload?.wakeSetId === wakeEv.id);
  check('his first answer comes after he woke', his1 && woke && his1.at >= woke.at, [his1?.at, woke?.at]);
  const hisUser = cr.callsFor('life.phone.his').at(-1)?.user ?? '';
  check('his writer sees how it started (the owner\'s note) and that it is a long chat', /felt a spark/.test(hisUser) && /long chat/.test(hisUser), hisUser.slice(-600));
  eq('nothing pending once the chat is over (a reply after he dozed off is dropped, never sent in the morning)', phoneStore.pendingFor(her).length, 0);
  for (let i = 0; i < 16 && S().activity?.kind !== 'sleep'; i++) await simulateHours(0.25);
  check('he goes back to sleep before morning', S().activity?.kind === 'sleep' && hourOf(clock.now()) < 9, [S().activity?.kind, hourOf(clock.now())]);
}

section('what the owner sees: the Day rows, CHANGES, the thread, the public reader');
{
  const day = await life.dayView({ date: dateKey(askEv.at, tz) });
  const ticks = [...(day?.past?.ticks ?? [])];
  check('Day: "woken up by his phone" (the woke row carries via phone)', ticks.some(r => r.type === 'woke' && r.detail?.via === 'phone'));
  const texts = ticks.filter(r => r.type === 'phone.message');
  eq('Day: the first text row is hers, with her name', [texts[0]?.detail?.dir, texts[0]?.detail?.with?.[0]], ['in', S().cast.get(her)?.name]);
  const ch = story.godView().changes.find(c => c.id === actionId || c.actionEventId === actionId);
  check('CHANGES: she texts him, her words, a long chat, woken up by his phone',
    /texts him/.test(ch?.description ?? '') && /Hey\. Are you awake\?/.test(ch?.description ?? '') && /woken up by his phone/.test(ch?.description ?? ''), ch?.description);
  const th = story.phoneThread(her);
  eq('the thread opens with her text', [th.messages[0]?.dir, th.messages[0]?.text], ['in', 'Hey. Are you awake?']);
  const map = life.publicPhone(th.messages.map(m => m.eventId));
  eq('the public reader has every text', map.size, th.messages.length);
}

section('from them while he is awake: no wake, the clerk writes her opener; a short chat keeps its cap');
{
  await untilTime(at(0, 13, 0) > clock.now() ? at(0, 13, 0) : at(1, 13, 0));
  check('he is up', S().activity?.kind !== 'sleep', S().activity?.kind);
  const castCalls = cr.callsFor('life.phone.cast').length;
  theirs = () => ({ messages: ['lunch?'], tone: 'casual', topic: 'lunch', end: false });
  his = () => ({ messages: ['sure, 1:30?'], tone: 'casual', topic: 'lunch', end: false });
  const { pv, res } = await applyAction({ kind: 'text', castId: other, from: 'them', gist: 'asks him to lunch' });
  check('no wake when he is awake', !res.eventIds.map(getEvent).some(e => e.type === 'wake.set') && !pv.warnings?.some(w => /wakes him/.test(w)), pv.warnings);
  for (let i = 0; i < 48 && phoneStore.pendingFor(other).length + (phoneStore.threadOf(other, { live: true }).length ? 0 : 1); i++) await step();
  const rows = phoneStore.threadOf(other, { live: true }).reverse();
  eq('her opener from the clerk (dir in, owner turn, clerk tier)', [rows[0]?.dir, rows[0]?.trigger, rows[0]?.tier], ['in', 'owner', 'clerk']);
  check('the clerk was asked, as her, with the gist', cr.callsFor('life.phone.cast').length > castCalls && /asks him to lunch/.test(cr.callsFor('life.phone.cast')[castCalls]?.user ?? ''));
  check(`a short chat stops by EXCHANGE_MAX (${EXCHANGE_MAX})`, rows.length <= EXCHANGE_MAX, rows.length);
}

section('an organic text still waits for her morning');
{
  await untilTime(at(1, 1, 0));
  const id = phoneStore.insertPending({ castId: other, dir: 'in', trigger: 'cast_first', triggerEventId: null, exchange: 0, dueAt: clock.now(), createdAt: clock.now() });
  await drain();
  const row = phoneStore.getMessage(id);
  check('pending until after 07:00 local', row?.status === 'pending' && hourOf(row.dueAt) >= 7 && row.dueAt > clock.now(), [row?.status, row && hourOf(row.dueAt)]);
}

section('Tell the story: the owner\'s wish drafts to text {from them, words, long}');
{
  const { validatePromptOutput } = await import('../../src/life/story/schema.js');
  const promptMod = await import('../../src/life/story/prompt.js');
  const cat = { today: dateKey(clock.now(), tz), castIds: new Set([her]), placeIds: new Set(), arcIds: new Set() };
  const out = validatePromptOutput(JSON.stringify({ actions: [{ action: { kind: 'text', castId: her, from: 'them', words: 'Hey. Are you awake?', gist: 'she felt a spark and wants to talk', chat: 'long' }, why: 'she texts him at night' }], cantDo: [] }), cat, promptMod.VOCAB);
  eq('the draft keeps who, the words and the length', out.drafts?.map(d => [d.action.from, d.action.words, d.action.chat]), [['them', 'Hey. Are you awake?', 'long']]);
  check('the card shows the gist and the words verbatim', promptMod.textsOf(out.drafts[0].action).some(t => t.field === 'words' && t.value === 'Hey. Are you awake?'));
  check('the charter teaches from / words / chat and says their text wakes him', /"from":"him"\|"them"/.test(promptMod.PROMPT_CHARTER) && /"chat":"short"\|"long"/.test(promptMod.PROMPT_CHARTER) && /wakes him/.test(promptMod.PROMPT_CHARTER));
  eq('the plan line', promptMod.planLineOf([{ index: 0, action: { kind: 'text', castId: her, from: 'them', gist: 'x', chat: 'long' } }], S(), clock.now(), tz), `${S().cast.get(her)?.name} texts him and they chat for a while.`);
}

section('the Director refuses a bad shape');
{
  const bad = async (a) => { try { await story.director.preview(a); return null; } catch (e) { return e.reason ?? e.code; } };
  eq('from must be him or them', await bad({ kind: 'text', castId: her, gist: 'x', from: 'her' }), 'bad_from');
  eq('chat must be short or long', await bad({ kind: 'text', castId: her, gist: 'x', chat: 'all night' }), 'bad_chat');
  eq('words without a gist are fine; neither is refused', await bad({ kind: 'text', castId: her }), 'bad_gist');
  eq('words with a JID are refused', await bad({ kind: 'text', castId: her, from: 'them', words: 'call 15550001111@s.whatsapp.net' }), 'words_jid_in_text');
}

section('live 2026-11-01: a text queued before the owner\'s chat joins it (no slow side exchange, no 07:00 wait)');
{
  await untilTime(at(2, 1, 30));
  for (let i = 0; i < 8 && S().activity?.kind !== 'sleep'; i++) await simulateHours(0.25);
  const t0 = clock.now();
  // The live shape: an after-scene text from him to her was already queued (he was asleep) when the
  // owner's "are you awake?" went out; the chat then ran through that row.
  config.arcs.phoneOrganicPerDay = 4;   // the queued after-scene text is allowed (live it was)
  const queued = phoneStore.insertPending({ castId: other, dir: 'out', trigger: 'after_scene', triggerEventId: null, exchange: 0, dueAt: clock.now() + 20 * 60, createdAt: clock.now() });
  theirs = () => ({ messages: ['haha same'], tone: 'flirty', topic: 'night', end: false });
  his = () => ({ messages: ['cant sleep either'], tone: 'flirty', topic: 'night', end: false });
  await applyAction({ kind: 'text', castId: other, from: 'them', words: 'u up?', gist: 'late night', chat: 'long' });
  await story.lastPhoneKick(); await story.idle();
  for (let i = 0; i < 10; i++) await step();
  const rows = phoneStore.threadOf(other, { live: true }).filter(r => r.at >= t0).reverse();
  const q = phoneStore.getMessage(queued);
  check('her opener first, then a back-and-forth (≥ 3 turns)', rows[0]?.text === 'u up?' && rows.length >= 3, rows.map(r => `${r.dir}:${r.trigger}`));
  check('every turn before 07:00 — the queued text did not start a slow exchange of its own', rows.every(r => hourOf(r.at) < 7), rows.map(r => hourOf(r.at).toFixed(2)));
  check('nothing of this thread is held for the morning', phoneStore.pendingFor(other).every(r => hourOf(r.dueAt) < 7 || r.dueAt < clock.now() + 3600), phoneStore.pendingFor(other).map(r => hourOf(r.dueAt)));
  check('the queued text went out inside the chat (or was answered as part of it)', q?.status === 'live' || q?.status === 'skipped', q?.status);
  config.arcs.phoneOrganicPerDay = 0;
  const fs = await import('node:fs');
  const w = fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8');
  check('the owner\'s own first text is always answered (p = 1); a long chat goes on until it ends or hits the cap (p = 1)',
    /row\.trigger === 'owner' && row\.exchange === 0 \? 1 :/.test(w) && /LONG_REPLY_P = 1;/.test(w));
}

section('live 2026-11-01: the live writers get his home + languages and when they last met in person');
{
  const u = cr.callsFor('life.phone.his').at(-1)?.user ?? '';
  const c = cr.callsFor('life.phone.cast').at(-1)?.user ?? '';
  check('his languages ride on the live sheet (the worker passes the persona region / language)', /his languages: /.test(u) && /his home: /.test(u), u.slice(0, 500));
  check('the card carries "last saw each other in person" on both sides', /last saw each other in person: /.test(u) && /last saw each other in person: /.test(c));
  check('both live writers get his recent days and his plans (facts.js timelineLines / planLines via the worker)', /his recent days/.test(u) && /his plans/.test(u) && /his recent days/.test(c) && /his plans/.test(c));
}

section('owner 2026-11-01: an engaging chat at bedtime keeps him up (sleep pushed 30 min at a time)');
{
  const { activeChat } = await import('../../src/life/story/phone/worker.js');
  const t = clock.now();
  const mk = (dir, at) => { const id = phoneStore.insertPending({ castId: her, dir, trigger: 'reply', triggerEventId: null, exchange: 40 + Math.floor(at % 7), dueAt: at, createdAt: at });
    phoneStore.update(id, { status: 'live', at, eventId: lastEventId(), text: 'x' }); return id; };
  mk('in', t - 600); mk('out', t - 240);
  const chat = activeChat(t);
  check('two turns in the last minutes → an active chat (the most recent thread)', chat !== null && [her, other].includes(chat.castId), chat);
  const block = { kind: 'sleep', start: t, end: t + 8 * 3600 };
  const added = [];
  const pushed = story.phoneBeforeSleep(S(), t, block, (e) => { added.push(e); return { id: 1 }; });
  check('bedtime during it → sleep.delayed 30 min, reason phone, caused by the newest turn', pushed === true && added[0]?.type === 'sleep.delayed'
    && added[0].payload.reason === 'phone' && added[0].payload.until === t + 1800 && Number.isSafeInteger(added[0].causeId), added[0]);
  check('a quiet thread (no turn in 20 min) → no push', activeChat(t + 7200) === null && story.phoneBeforeSleep(S(), t + 7200, { kind: 'sleep', start: t + 7200, end: t + 8 * 3600 }, () => ({ id: 1 })) === false);
  check('never into his last hour of sleep', story.phoneBeforeSleep(S(), t, { kind: 'sleep', start: t, end: t + 3000 }, () => ({ id: 1 })) === false);
}

section('live 2026-11-02: one conversation per thread — a reply to an older turn is dropped (no double texts, no answering himself)');
{
  const t = clock.now();
  const e1 = lastEventId() - 1;
  const e2 = lastEventId();
  const live = (dir, at, eventId) => { const id = phoneStore.insertPending({ castId: other, dir, trigger: 'reply', triggerEventId: null, exchange: 45 + (at % 3), dueAt: at, createdAt: at });
    phoneStore.update(id, { status: 'live', at, eventId, text: `w${at}` }); return id; };
  live('out', t - 120, e1);   // his question
  live('in', t - 60, e2);     // then she spoke (another chain)
  const stale = phoneStore.insertPending({ castId: other, dir: 'in', trigger: 'reply', triggerEventId: e1, exchange: 47, dueAt: t - 1, createdAt: t - 100 });
  await story.runPhoneNow(); await story.idle();
  const row = phoneStore.getMessage(stale);
  eq('the reply to the older turn is dropped as superseded', [row?.status, row?.skipReason], ['skipped', 'superseded']);
}

section('live: a text due before the next tick runs at its own time (a timer; real clock only)');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/life/story/index.js', import.meta.url), 'utf8');
  check('the phone job arms the timer after its due turns, gated on the real clock, unref\'d, cleared on detach',
    /await phoneWorker\.processDue\(\);\s*armPhoneTimer\(\);/.test(src) && /if \(!isRealClock\(\) \|\| testDeps\.now\) return;/.test(src)
    && /phoneTimer\.unref\?\.\(\)/.test(src) && /if \(phoneTimer\) \{ clearTimeout\(phoneTimer\)/.test(src));
  check('attach arms the timer too, so texts due across a restart go out within seconds of boot', /loadCanUseIn\(\)\.catch\(\(\) => \{\}\);[\s\S]{0,300}try \{ armPhoneTimer\(\); \}/.test(src));
}

report();
