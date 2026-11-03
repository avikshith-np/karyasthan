// 019 his phone — the live path: the owner's "he texts …" (Director kind `text`) → the
// phone job queues the turn → his side is written (stubbed mouth with his identity core)
// → phone.message (engine, caused by the ask, codes only) + the row's words → the member
// answers (stubbed clerk) → a small step closer. Waiting while he is asleep, the caps,
// the heat ceiling (an explicit answer → no message), revert (the reply cascades, the words
// go), the owner's edit and REWRITE, the memory block in a chat, the public reader, the
// Day row detail, a chat-origin cause refused by the log, texts out of the blue rolled once
// a day, and the Tell-the-story draft. Example world, fake clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, fakeCallRole, HOUR,
} from './_helpers.js';
import { getEvent, eventsAfter, lastEventId, listEvents, appendEvent } from '../../src/life/eventLog.js';
import { resolveTimezone, localParts, zonedToUnix, dateKey } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as phoneStore from '../../src/life/story/phone/store.js';
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
let his = () => ({ messages: ['hey, you free sunday?', 'thinking that cafe near the station'], tone: 'warm', topic: 'sunday plans', end: false });
let theirs = () => ({ messages: ['yes! sunday works', 'see you there'], tone: 'excited', topic: 'sunday plans', end: true });
let clockNow = () => 0;
const systems = [];
const cr = fakeCallRole({
  'life.phone.his': (sys, user) => { systems.push(sys); ledger.push({ caller: 'life.phone.his', at: clockNow(), cost: 0.001 }); const o = his(user); return o === null ? null : JSON.stringify(o); },
  'life.phone.mind': (sys, user) => { systems.push(sys); ledger.push({ caller: 'life.phone.mind', at: clockNow(), cost: 0.01 }); const o = his(user); return o === null ? null : JSON.stringify(o); },
  'life.phone.cast': (sys, user) => { ledger.push({ caller: 'life.phone.cast', at: clockNow(), cost: 0.001 }); const o = theirs(user); return o === null ? null : JSON.stringify(o); },
});
const booted = await bootLife({ callRole: cr });
const { world, clock, life } = booted;
clockNow = () => clock.now();
story.__setDepsForTest({ getUsageByCaller: usage, mindBudgetOk: async () => ({ ok: false }), knownNames: () => ['Quinn Marlow'],
  identity: async () => 'You are Kiran, a 28-year-old from the example town.' });
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const flat = 'cast:flatmate';

async function drain() { await story.idle(); await story.runPhoneNow(); await story.idle(); }
async function applyAction(action) {
  const pv = await director.preview(action);
  const res = await director.apply(pv.previewId, pv.fingerprint);
  return { pv, res };
}
const at = (dayOffset, hh, mm = 0) => {
  const p = localParts(clock.now(), tz);
  return zonedToUnix(p.year, p.month, p.day, hh, mm, tz) + dayOffset * 86400;
};
async function untilTime(t) { while (clock.now() < t) await simulateHours(0.25); }
// Step 15 min at a time (running the phone job) until `pred` holds or `hours` pass.
async function until(pred, hours = 8) {
  for (let i = 0; i < hours * 4 && !pred(); i++) { await simulateHours(0.25); await drain(); }
  return pred();
}
// Texts out of the blue would mix into the threads under test: their cap is 0 until the roll section.
config.arcs.phoneOrganicPerDay = 0;
const messages = () => listEvents({ types: ['phone.message'], limit: 500 }).filter(e => !S().excluded?.has?.(e.id));

section('first job seeds the cursor: history never turns into texts');
{
  await simulateHours(0.5);
  await drain();
  check('cursor seeded', phoneStore.getCursor() !== null && phoneStore.getCursor() <= lastEventId());
  eq('no turns yet', phoneStore.countPending() + messages().length, 0);
}

section('the owner asks: "he texts the flatmate about Sunday" → his text, her answer');
let first; let reply;
{
  await untilTime(at(1, 18, 0));
  const { pv, res } = await applyAction({ kind: 'text', castId: flat, gist: 'ask if they are free on Sunday for coffee', tone: 'warm' });
  check('the preview says he texts them, in his own words', pv.warnings?.some(w => /he texts Flatmate/.test(w)), pv.warnings);
  const ask = res.eventIds.map(getEvent).find(e => e.type === 'phone.text_set');
  eq('one owner phone.text_set with the gist', [ask?.actor, ask?.payload?.castId, ask?.payload?.tone], ['owner', flat, 'warm']);
  await drain();
  check('written when he is free (he may be on his way somewhere first)', await until(() => phoneStore.threadOf(flat, { live: true }).length > 0));
  const rows = phoneStore.threadOf(flat, { live: true });
  first = rows[0];
  eq('one live turn from him', [rows.length, first?.dir, first?.trigger, first?.tier], [1, 'out', 'owner', 'mouth']);
  const ev = getEvent(first?.eventId);
  eq('phone.message: engine, caused by the ask, self origin', [ev?.type, ev?.actor, ev?.causeId, ev?.originKind], ['phone.message', 'engine', ask.id, 'self']);
  check('codes only in the log (no words), a sha of the text', typeof ev?.payload?.textSha === 'string' && !JSON.stringify(ev.payload).includes('sunday'));
  eq('the words in the row, one bubble per line', first?.text, 'hey, you free sunday?\nthinking that cafe near the station');
  check('his writer had his identity core + the phone charter', systems.at(-1)?.startsWith('You are Kiran') && /Texting from your own phone/.test(systems.at(-1)));
  check('the mind was not used (its gate said no) → the mouth', cr.callsFor('life.phone.mind').length === 0 && cr.callsFor('life.phone.his').length === 1);
  const user = cr.callsFor('life.phone.his')[0]?.user ?? '';
  check('the sheet carries the gist fenced, the member by name, no JIDs', /ask if they are free on Sunday/.test(user) && /Flatmate/.test(user) && !/@s\.whatsapp\.net/.test(user));
  const pend = phoneStore.pendingFor(flat);
  eq('her answer is queued (owner ask → almost always)', pend.map(r => [r.dir, r.trigger, r.exchange, r.triggerEventId]), [['in', 'reply', 1, first.eventId]]);
  await until(() => phoneStore.threadOf(flat, { live: true }).length > 1, 4);
  reply = phoneStore.threadOf(flat, { live: true })[0];
  eq('her answer is live, caused by his text', [reply?.dir, getEvent(reply?.eventId)?.causeId], ['in', first.eventId]);
  check('the clerk wrote it, with the thread so far in the sheet', /hey, you free sunday\?/.test(cr.callsFor('life.phone.cast')[0]?.user ?? ''));
  const eff = listEvents({ types: ['relationship.changed'], limit: 50 }).filter(e => e.causeId === reply.eventId);
  eq('the exchange: one small step closer (reason phone)', eff.map(e => [e.payload.castId, e.payload.delta.closeness, e.payload.reason]), [[flat, 0.01, 'phone']]);
  eq('"end" → no further answer queued', phoneStore.pendingFor(flat).length, 0);
}

section('the operator view: threads, a thread, the Day detail');
{
  const threads = story.phoneThreads();
  const t = threads.find(x => x.castId === flat);
  eq('the flatmate thread first, 2 texts, her last', [threads[0]?.castId, t?.count, t?.last?.dir], [flat, 2, 'in']);
  check('every active member is listed (no texts → last null)', threads.length === S().cast.size && threads.filter(x => x.count === 0).every(x => x.last === null));
  const th = story.phoneThread(flat);
  eq('oldest → newest, live, the newest regenerable only', th.messages.map(m => [m.dir, m.status, m.regenerable, m.revertible]),
    [['out', 'live', false, true], ['in', 'live', true, true]]);
  eq('unknown member → null', story.phoneThread('cast:nobody'), null);
  const page = story.phoneThread(flat, { before: th.messages[1].at, beforeId: th.messages[1].id });
  eq('paging by time + id', page.messages.map(m => m.id), [th.messages[0].id]);
  const day = await life.dayView({ date: dateKey(clock.now(), tz) });
  const rows = [...(day?.past?.ticks ?? [])].filter(r => r.type === 'phone.message');
  eq('Life · Day rows carry with + dir', rows.map(r => [r.detail?.with?.[0], r.detail?.dir]), [['Flatmate (example)', 'out'], ['Flatmate (example)', 'in']]);
}

section('his memory in a chat: the words, fenced; nothing while imitating; the public reader');
{
  const dm = { chatJid: '15550001111@s.whatsapp.net', kind: 'dm', members: ['15550001111@s.whatsapp.net'] };
  const lines = life.phoneLines(dm);
  eq('one block', lines.length, 1);
  check('fenced, both sides, ≤ 480', lines[0]?.includes('<<<PHONE_NOTES') && /you → Flatmate: hey, you free sunday\?/.test(lines[0]) && /Flatmate → you: yes! sunday works/.test(lines[0]) && lines[0].length <= 488, lines[0]);
  eq('nothing while imitating', life.phoneLines(dm, { imitating: true }), []);
  const map = life.publicPhone([first.eventId, reply.eventId, 999999]);
  eq('public reader: both live texts', [map.size, map.get(first.eventId)?.startsWith('hey')], [2, true]);
}

section('the owner edits and rewrites the newest turn');
{
  const r = story.phoneEdit(reply.id, 'yes!! sunday works\nsee you at 11');
  eq('edit saved (no event)', [r.ok, phoneStore.getMessage(reply.id).editedText], [true, 'yes!! sunday works\nsee you at 11']);
  let e1 = null; try { story.phoneEdit(reply.id, 'ok Quinn Marlow will come too'); } catch (e) { e1 = e; }
  eq('a real name is refused (StoryError invalid real_name)', [e1?.code, e1?.reason], ['invalid', 'real_name']);
  let e2 = null; try { story.phoneEdit(reply.id, 'send me nudes'); } catch (e) { e2 = e; }
  eq('an explicit edit is refused', [e2?.code, e2?.reason], ['invalid', 'explicit']);
  let e3 = null; try { await story.phoneRegenerate(first.id); } catch (e) { e3 = e; }
  eq('only the newest turn can be rewritten', [e3?.code, e3?.reason], ['refused', 'not_newest']);
  theirs = () => ({ messages: ['sunday is perfect'], tone: 'warm', topic: 'sunday', end: true });
  const before = reply.eventId;
  const rw = await story.phoneRegenerate(reply.id);
  check('rewrite → a new live turn', rw.ok === true && phoneStore.getMessage(rw.id)?.status === 'live');
  eq('the old one superseded, its event reverted', [phoneStore.getMessage(reply.id).status, S().excluded?.has?.(before)], ['superseded', true]);
  eq('the new one hangs off the same cause (his text)', getEvent(rw.eventId)?.causeId, first.eventId);
  reply = phoneStore.getMessage(rw.id);
}

section('revert his text: her answer cascades, the words go');
{
  const res = await life.revertEvent(first.eventId, { reason: 'test', by: 'owner' });
  check('reverted', !!res);
  await drain();
  eq('both rows reverted, words NULLed', [phoneStore.getMessage(first.id).status, phoneStore.getMessage(first.id).text, phoneStore.getMessage(reply.id).status, phoneStore.getMessage(reply.id).text],
    ['reverted', null, 'reverted', null]);
  eq('no live texts left in the thread', phoneStore.threadOf(flat, { live: true }).length, 0);
  eq('memory empty again', life.phoneLines({ chatJid: 'x@s.whatsapp.net', kind: 'dm' }), []);
}

section('asleep: his turn waits for him to be up');
{
  await untilTime(at(1, 23, 30));
  // Make sure he is asleep: run until the projection says so.
  for (let i = 0; i < 16 && S().activity?.kind !== 'sleep'; i++) await simulateHours(0.25);
  check('he is asleep', S().activity?.kind === 'sleep');
  his = () => ({ messages: ['morning! sorry, fell asleep'], tone: 'casual', topic: 'sorry', end: true });
  await applyAction({ kind: 'text', castId: 'cast:coworker-a', gist: 'say good morning' });
  await drain();
  const row = phoneStore.pendingFor('cast:coworker-a')[0];
  check('still pending, due later (he is asleep)', row && row.dueAt > clock.now() && row.tries >= 1, row);
  for (let i = 0; i < 48 && !phoneStore.threadOf('cast:coworker-a', { live: true }).length; i++) { await simulateHours(0.25); await drain(); }
  const sent = phoneStore.threadOf('cast:coworker-a', { live: true })[0];
  check('written once he is up', !!sent && S().activity?.kind !== 'sleep');
}

section('the heat ceiling: an explicit answer → no message');
{
  his = () => ({ messages: ['come over, I want sex'], tone: 'flirty', topic: 'tonight', end: false });
  const n0 = messages().length;
  await applyAction({ kind: 'text', castId: 'cast:coworker-b', gist: 'flirt a little' });
  await until(() => phoneStore.pendingFor('cast:coworker-b').length === 0, 12);
  const rows = phoneStore.threadOf('cast:coworker-b', { limit: 10 });
  eq('no live turn, no new phone.message', [rows.filter(r => r.status === 'live').length, messages().length], [0, n0]);
  const skipped = phoneStore.pendingFor('cast:coworker-b').length === 0;
  check('the row was skipped (invalid:explicit)', skipped);
  his = () => ({ messages: ["can't stop thinking about last night 😏"], tone: 'flirty', topic: 'last night', end: true });
}

section('caps: a day cap of 0 turns the phone off; the per-member cap');
{
  config.arcs.phoneMaxPerDay = 0;
  await applyAction({ kind: 'text', castId: 'cast:sibling', gist: 'say hi' });
  for (let i = 0; i < 4; i++) { await drain(); await simulateHours(0.25); }
  eq('nothing written with the cap at 0', phoneStore.threadOf('cast:sibling', { live: true }).length, 0);
  config.arcs.phoneMaxPerDay = 40;
  config.arcs.phonePerCastDay = 0;
  await applyAction({ kind: 'text', castId: 'cast:sibling', gist: 'say hi again' });
  for (let i = 0; i < 4; i++) { await drain(); await simulateHours(0.25); }
  eq('per-member cap 0 → skipped', phoneStore.threadOf('cast:sibling', { live: true }).length, 0);
  config.arcs.phonePerCastDay = 12;
}

section('the log refuses a text caused by a chat, about a real person, or from anyone but the engine');
{
  const ptr = appendEvent({ type: 'chat.trigger', actor: 'chat', at: clock.now(), originKind: 'dm', originJid: '15550001111@s.whatsapp.net', payload: { kind: 'test' } });
  const tries = [
    () => appendEvent({ type: 'phone.message', actor: 'engine', at: clock.now(), causeId: ptr.id, payload: { castId: flat, dir: 'out' } }),
    () => appendEvent({ type: 'phone.message', actor: 'engine', at: clock.now(), subjectJid: '15550001111@s.whatsapp.net', payload: { castId: flat, dir: 'out' } }),
    () => appendEvent({ type: 'phone.message', actor: 'mind', at: clock.now(), payload: { castId: flat, dir: 'out' } }),
    () => appendEvent({ type: 'phone.text_set', actor: 'engine', at: clock.now(), payload: { castId: flat, gist: 'x' } }),
  ];
  eq('all four refused', tries.map(f => { try { f(); return 'ok'; } catch { return 'refused'; } }), ['refused', 'refused', 'refused', 'refused']);
}

section('texts out of the blue: rolled once a local day');
{
  config.arcs.phoneOrganicPerDay = 4;
  const before = phoneStore.getRolledDate();
  await untilTime(at(1, 10, 0));
  await drain();
  const d = phoneStore.getRolledDate();
  check('rolled for today after 09:00', d === dateKey(clock.now(), tz) && d !== before, [before, d]);
  const n = phoneStore.countPending();
  await drain();
  eq('a second job the same day rolls nothing new', phoneStore.countPending() <= n, true);
}

section('Tell the story: a "text" draft is free text (never batchable) with a plain phrase');
{
  const { validatePromptOutput } = await import('../../src/life/story/schema.js');
  const promptMod = await import('../../src/life/story/prompt.js');
  const cat = { today: dateKey(clock.now(), tz), castIds: new Set([flat]), placeIds: new Set(), arcIds: new Set() };
  const out = validatePromptOutput(JSON.stringify({ actions: [{ action: { kind: 'text', castId: flat, gist: 'ask about Sunday', tone: 'flirty', at: '20:00' }, why: 'he asks' }], cantDo: [] }), cat, promptMod.VOCAB);
  eq('one text draft', out.drafts?.map(d => [d.action.kind, d.action.castId, d.action.tone, d.action.at]), [['text', flat, 'flirty', '20:00']]);
  const bad = validatePromptOutput(JSON.stringify({ actions: [{ action: { kind: 'text', castId: 'cast:nobody', gist: 'x' }, why: 'y' }], cantDo: [] }), cat, promptMod.VOCAB);
  eq('an unknown member is dropped', bad.dropped?.map(d => d.reason), ['unknown_cast']);
  eq('never in APPLY ALL (free text)', promptMod.batchableOf({ kind: 'text', castId: flat, gist: 'x' }).reviewReason, 'free_text');
  check('the charter lists the kind and allows a naughty tone only for an eligible adult', promptMod.PROMPT_CHARTER.includes('"kind":"text"') && /naughty/.test(promptMod.PROMPT_CHARTER) && /never family/.test(promptMod.PROMPT_CHARTER));
  eq('the plan line', promptMod.planLineOf([{ index: 0, action: { kind: 'text', castId: flat, gist: 'x' } }], S(), clock.now(), tz), 'He texts Flatmate (example).');
}

report();
