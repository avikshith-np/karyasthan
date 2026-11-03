// 010 T019 — on-demand narration (src/life/story/narrate.js, contracts/journal.md §4,
// research R18). Checks:
//   - an event's narration: one clerk call (caller life.narrate), fenced code-built
//     bullets from its cause chain (≤ 12), cached (UNIQUE kind+event) → the second
//     ask costs nothing; origins_json = the origins used;
//   - a chain crossing chats: a bullet from another chat becomes "(something from
//     another chat)" and its origin is not recorded;
//   - the thought: self facts only, cached for an hour;
//   - limits: per hour / per day from story_runs(kind 'narrate') → rate; the
//     clerk budget → refused; an invalid output (a URL) → refused, nothing cached;
//   - narration is outside the shared arcs clerk cap: 100 narrations don't skip a
//     journal night;
//   - a forget in a chat deletes the narrations that used it.
// unit: a realistic log from the 009 facade (stopped). Invented names; no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole,
  skipSimUnlessWired, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, listEvents, getEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { dateKey } from '../../src/life/clock.js';
import { getDb } from '../../src/memory/db.js';
import * as store from '../../src/life/story/store.js';
import * as narrate from '../../src/life/story/narrate.js';
import * as journal from '../../src/life/story/journal.js';
import * as hooks from '../../src/life/story/hooks.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
const tz = world.timezone;
await simulateHours(18.75);
await stopLife();
// The wired story facade (T024) journals the sim night on its own: start these checks from empty story tables.
for (const t of ['story_journal_parts', 'story_journal_nights', 'story_narrations', 'story_runs']) getDb().prepare(`DELETE FROM ${t}`).run();

let state = rebuild({ world });
const append = (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; };
const callRole = fakeCallRole({
  'life.narrate': (system, user, opts, i) => `It was a plain moment in the day, number ${i + 1}.`,
  'life.journal': () => 'A long day and a quiet evening.',
});
const deps = { callRole: callRole.fn, getState: () => state, now: () => clock.now(), timezone: () => tz, budgetOk: () => true };
narrate.__setDepsForTest(deps);
journal.__setDepsForTest(deps);
const codeOf = async (p) => { try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; } };

const selfEvents = listEvents({ types: ['activity.started'], limit: 500 }).filter(e => e.originKind === 'self');

section('one event: a call, then the cache');
{
  const ev = selfEvents[3];
  const r = await narrate.narrate({ eventId: ev.id });
  eq('text, origins, not cached', [typeof r.text, r.origins, r.cached], ['string', ['self'], false]);
  const calls = callRole.callsFor('life.narrate');
  eq('one clerk call', [calls.length, calls[0].role, calls[0].opts.maxTokens], [1, 'clerk', 200]);
  check('fenced input', calls[0].user.includes('<<<STORY_DATA') && calls[0].user.includes('<<<END_STORY_DATA>>>'));
  const again = await narrate.narrate({ eventId: ev.id });
  eq('second ask: cached, no call', [again.cached, again.text, callRole.callsFor('life.narrate').length], [true, r.text, 1]);
  eq('unknown event → not_found', await codeOf(narrate.narrate({ eventId: 10 ** 8 })), 'not_found:event');
  eq('bad id → invalid', await codeOf(narrate.narrate({ eventId: 'x' })), 'invalid:eventId');
}

section('a chain crossing chats');
const dm = '15550005555@s.whatsapp.net';
let dmEvent;
let ownerEvent;
{
  const at = clock.now();
  const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'MSG-N', 'we walked by the lake', 'claim', 0.9, 'flagged', ?)`).run(dm, dm, at).lastInsertRowid);
  const flagged = append({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId } });
  const adopted = append({ type: 'claim.adopted', at, actor: 'engine', causeId: flagged.id, payload: { claimId, reviewId: 1, as: 'activity', ref: null } });
  dmEvent = append({ type: 'activity.recorded', at, actor: 'engine', causeId: adopted.id, payload: { kind: 'walk', castIds: [], startAt: at - 2 * HOUR, endAt: at - HOUR, label: 'walk in the park with a friend from this chat' } });
  ownerEvent = append({ type: 'director.action', at, actor: 'owner', causeId: dmEvent.id, payload: { kind: 'test', previewAt: at, count: 0 } });
  const own = await narrate.narrate({ eventId: dmEvent.id });
  eq('the DM event keeps its own origin', own.origins, [dm]);
  const last = callRole.callsFor('life.narrate').at(-1);
  check('…and its code label', last.user.includes('walk in the park'));
  check('no claim text in the input', !last.user.includes('lake'));
  const mixed = await narrate.narrate({ eventId: ownerEvent.id });
  const u = callRole.callsFor('life.narrate').at(-1).user;
  check('another chat\'s bullets become "(something from another chat)"', u.includes(narrate.OTHER_CHAT) && !u.includes('walk in the park'));
  eq('origins: only what was used', mixed.origins, ['owner']);
}

section('the thought: self facts, cached for an hour');
{
  const n0 = callRole.callsFor('life.narrate').length;
  const t = await narrate.narrate({ thought: true });
  eq('origins self', [t.origins, t.cached], [['self'], false]);
  check('input built from his own day', callRole.callsFor('life.narrate').at(-1).user.includes('<<<STORY_DATA'));
  eq('cached within the hour', (await narrate.narrate({ thought: true })).cached, true);
  clock.advance({ minutes: 61 });
  eq('expired after an hour → a new call', [(await narrate.narrate({ thought: true })).cached, callRole.callsFor('life.narrate').length], [false, n0 + 2]);
}

section('limits, budget, invalid output');
{
  const old = { h: config.arcs.narrateMaxPerHour, d: config.arcs.narrateMaxPerDay };
  config.arcs.narrateMaxPerHour = narrate.narrationsUsed().hour + 1;
  await narrate.narrate({ eventId: selfEvents[5].id });
  eq('over the hourly cap → rate', await codeOf(narrate.narrate({ eventId: selfEvents[6].id })), 'rate:cap_hour');
  check('a cached narration is still served', (await narrate.narrate({ eventId: selfEvents[5].id })).cached);
  config.arcs.narrateMaxPerHour = 200;
  config.arcs.narrateMaxPerDay = narrate.narrationsUsed().day;
  eq('over the daily cap → rate', await codeOf(narrate.narrate({ eventId: selfEvents[6].id })), 'rate:cap_day');
  config.arcs.narrateMaxPerDay = 200;
  narrate.__setDepsForTest({ budgetOk: () => false });
  eq('clerk over budget → refused budget', await codeOf(narrate.narrate({ eventId: selfEvents[6].id })), 'refused:budget');
  narrate.__setDepsForTest({ budgetOk: () => true, callRole: fakeCallRole({ 'life.narrate': () => 'read more at https://example.org' }).fn });
  eq('a URL in the output → refused invalid_output', await codeOf(narrate.narrate({ eventId: selfEvents[6].id })), 'refused:invalid_output');
  eq('…and nothing cached', store.getEventNarration(selfEvents[6].id), null);
  narrate.__setDepsForTest({ callRole: callRole.fn });
  Object.assign(config.arcs, { narrateMaxPerHour: old.h, narrateMaxPerDay: old.d });
}

section('100 narrations do not skip a journal night (narration is outside the shared cap)');
{
  Object.assign(config.arcs, { narrateMaxPerHour: 200, narrateMaxPerDay: 200, clerkMaxPerDay: 3 });
  const shared0 = store.countRuns({ kind: ['extract', 'journal'] });
  for (let i = 0; i < 60; i++) append({ type: 'cast.beat', at: clock.now(), actor: 'engine', payload: { castId: 'cast:sibling', kind: 'hobby', text: `practised a new hobby ${i}` } });
  const events = listEvents({ limit: 500, before: state.lastEventId + 1, order: 'desc' });
  let done = 0;
  for (const ev of events) {
    if (done >= 100) break;
    const r = await narrate.narrate({ eventId: ev.id }).catch(() => null);
    if (r && !r.cached) done += 1;
  }
  eq('100 fresh narrations', done, 100);
  eq('the shared clerk counter did not move', store.countRuns({ kind: ['extract', 'journal'] }), shared0);
  const nk = dateKey(state.sleep.startedAt - 12 * HOUR, tz);
  const r = await journal.runJournal(nk);
  check('the journal night still runs (not skipped for the cap)', r.status === 'done' || r.status === 'partial', r);
  config.arcs.clerkMaxPerDay = 80;
}

section('a forget in a chat deletes its narrations');
{
  check('fixture: a narration with the DM origin', store.getEventNarration(dmEvent.id) !== null);
  hooks.__setDepsForTest({ now: () => clock.now(), timezone: () => tz });
  hooks.handleItemsDeleted(getDb(), { chatJid: dm, chatForms: [dm], msgIds: [], cause: 'forget' });
  eq('deleted', store.getEventNarration(dmEvent.id), null);
  check('a self narration stays', store.getEventNarration(selfEvents[3].id) !== null);
}

if (!(await skipSimUnlessWired())) {
  section('sim: narration through the story facade');
  const story = await import('../../src/life/story/index.js');
  check('the story facade exposes narrate', typeof story.narrate === 'function');
}

void getEvent;
report();
