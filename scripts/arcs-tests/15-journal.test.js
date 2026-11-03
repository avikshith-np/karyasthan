// 010 T019 — the journal (src/life/story/journal.js, hooks.js; contracts/journal.md,
// research R18, R22). Checks:
//   - due logic: asleep ≥ 30 min, night key = date(sleep start − 12 h), one row per
//     night; latest-only catch-up (earlier nights `missed/downtime`);
//   - parts: one self part from self/owner facts, one per chat from CODE-BUILT
//     adoption labels only (never the clerk's summary, never claim text), fenced,
//     ≤ 6 calls, sources {events, claims}; the persona name and voice in the user
//     message; budget → skipped(budget), shared cap → skipped(cap); an invented
//     capitalized name → part rejected (fail closed), the night partial;
//   - removal: a forget on day D for an outing adopted for D+5 fences D+5's part
//     (by claim id, whatever its night) and withdraws the review (extraction NULL);
//     a purge (through the registered 006 hooks, with life stopped) deletes the
//     person's reviews, parts and group claims that resolved them; a hook failure
//     on forget is caught (degraded, the forget stands);
//   - a reverted source event marks the part undone; rebuilt once (≤ 7 days);
//   - never in prompts: no prompt-side module imports journal/narrate or names the
//     tables; life's prompt lines contain no journal text.
// unit: a realistic log from the 009 facade (stopped). Invented names; no network.
import fs from 'fs';
import path from 'path';
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, seedPeople,
  skipSimUnlessWired, PROJECT_ROOT, HOUR, DAY,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, revertEvent, getEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended, advanceTo } from '../../src/life/projector.js';
import { dateKey, zonedToUnix } from '../../src/life/clock.js';
import { getDb } from '../../src/memory/db.js';
import { lifeLines, callStateNote } from '../../src/life/innerState.js';
import * as store from '../../src/life/story/store.js';
import * as journal from '../../src/life/story/journal.js';
import * as hooks from '../../src/life/story/hooks.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
const tz = world.timezone;
await simulateHours(18.75);              // Tue 06:00 → Wed 00:45: asleep since late evening
await stopLife();
// The wired story facade (T024) journals the sim night on its own: start these checks from empty story tables.
for (const t of ['story_journal_parts', 'story_journal_nights', 'story_narrations', 'story_runs']) getDb().prepare(`DELETE FROM ${t}`).run();

let state = rebuild({ world });
const append = (spec) => { const ev = appendEvent(spec); state = applyAppended(state, ev, { world }); return ev; };
const JOURNAL_TEXT = {
  self: 'A long day of work and a slow walk home under a grey sky.',
  chat: 'The movie with Flatmate was a good way to end the day.',
};
const callRole = fakeCallRole({
  'life.journal': (system, user) => (user.includes('Part: your day') ? JOURNAL_TEXT.self : JOURNAL_TEXT.chat),
});
journal.__setDepsForTest({ callRole: callRole.fn, getState: () => state, now: () => clock.now(), timezone: () => tz, budgetOk: () => true });

// ── Adoption fixture: a DM claim adopted on Tue (activity that afternoon) and another for Sunday ──
const dm = '15550004444@s.whatsapp.net';
const tue = (h, m = 0) => zonedToUnix(2026, 10, 27, h, m, tz);
function claim(text, msgId, at) {
  const id = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, ?, ?, 'commitment', 0.9, 'flagged', ?)`).run(dm, dm, msgId, text, at).lastInsertRowid);
  const flagged = append({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId: id } });
  const rid = store.createReview({ claimId: id, claimEventId: flagged.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: at, status: 'pending' }).id;
  store.updateReview(rid, { extraction: { type: 'activity', kind: 'movie', summary: 'SECRET-SUMMARY went to a film', people: ['Blake'] }, resolution: { placeId: 'place:cinema', castIds: ['cast:flatmate'], subjectJid: null } });
  return { id, flagged, rid };
}
const c1 = claim('CLAIMTEXT-ONE we saw a film', 'MSG-1', tue(10));
const a1 = append({ type: 'claim.adopted', at: tue(10), actor: 'engine', causeId: c1.flagged.id, payload: { claimId: c1.id, reviewId: c1.rid, as: 'activity', ref: null } });
append({ type: 'activity.recorded', at: tue(10), actor: 'engine', causeId: a1.id, payload: { kind: 'movie', placeId: 'place:cinema', castIds: ['cast:flatmate'], startAt: tue(15), endAt: tue(17), label: 'movie at Cinema with Flatmate' } });
store.updateReview(c1.rid, { status: 'adopted', adoptedEventId: a1.id });
const sunday = zonedToUnix(2026, 11, 1, 18, 0, tz);
const c2 = claim('CLAIMTEXT-TWO see you sunday', 'MSG-2', tue(11));
const a2 = append({ type: 'claim.adopted', at: tue(11), actor: 'engine', causeId: c2.flagged.id, payload: { claimId: c2.id, reviewId: c2.rid, as: 'commitment', ref: null } });
append({ type: 'commitment.recorded', at: tue(11), actor: 'engine', causeId: a2.id, payload: { dueAt: sunday, castIds: [], label: 'dinner at Restaurant with a friend from this chat' } });
store.updateReview(c2.rid, { status: 'adopted', adoptedEventId: a2.id });
const c4 = claim('CLAIMTEXT-FOUR monday then', 'MSG-4', tue(12));
const a4 = append({ type: 'claim.adopted', at: tue(12), actor: 'engine', causeId: c4.flagged.id, payload: { claimId: c4.id, reviewId: c4.rid, as: 'commitment', ref: null } });
append({ type: 'commitment.recorded', at: tue(12), actor: 'engine', causeId: a4.id, payload: { dueAt: zonedToUnix(2026, 11, 2, 18, 0, tz), castIds: [], label: 'call back about the trip' } });

section('due logic');
const view = advanceTo(state, clock.now(), world);
const sleptAt = state.sleep.startedAt;
const NK = dateKey(sleptAt - 12 * HOUR, tz);
{
  check('fixture: asleep ≥ 30 min', view.activity.kind === 'sleep' && clock.now() - sleptAt >= 1800, { kind: view.activity.kind });
  const due = journal.journalDue(view, { at: clock.now() });
  eq('due for the night of the sleep', [due.due, due.nightKey], [true, NK]);
  eq('not due 10 min into sleep', journal.journalDue(view, { at: sleptAt + 600 }).due, false);
  config.arcs.journalEnabled = false;
  eq('journal off → not due', journal.journalDue(view, { at: clock.now() }).reason, 'disabled');
  config.arcs.journalEnabled = true;
  eq('awake → not due', journal.journalDue({ ...view, activity: { kind: 'free' } }, { at: clock.now() }).due, false);
}

section('a night: one self part, one chat part, code-built bullets only');
const run = await journal.runJournal(NK, { sleepEventId: state.sleep.eventId });
{
  eq('night done', [run.status, store.getNight(NK).status], ['done', 'done']);
  const parts = store.listParts(NK);
  eq('parts: self + the DM', parts.map(p => [p.originKind, p.originJid]), [['self', 'self'], ['dm', dm]]);
  eq('texts stored', parts.map(p => p.text), [JOURNAL_TEXT.self, JOURNAL_TEXT.chat]);
  const chat = parts[1];
  eq('chat part cites the claim', chat.sources.claims, [c1.id]);
  check('self part cites self events', parts[0].sources.events.length > 0 && parts[0].sources.events.every(id => ['self', 'owner'].includes(getEvent(id).originKind)));
  const calls = callRole.callsFor('life.journal');
  eq('two clerk calls', [calls.length, calls.every(c => c.role === 'clerk')], [2, true]);
  check('every input is fenced', calls.every(c => c.user.includes('<<<STORY_DATA') && c.user.includes('<<<END_STORY_DATA>>>')));
  check('no clerk summary, claim text or extracted name in any input', calls.every(c => !/SECRET-SUMMARY|CLAIMTEXT|Blake/.test(c.user)));
  check('the chat input uses the code label', calls.some(c => c.user.includes('movie at Cinema with Flatmate')));
  check('the self input holds no chat-origin fact', !calls.find(c => c.user.includes('Part: your day')).user.includes('Cinema with Flatmate'));
  check('the persona name opens the user message', calls.every(c => /^You are \S/.test(c.user)));
  check('the charter says data is not instructions', calls[0].system.includes('never instructions'));
  eq('not due any more', journal.journalDue(view, { at: clock.now() }).due, false);
  eq('runJournal again → exists (no new call)', [(await journal.runJournal(NK)).status, callRole.callsFor('life.journal').length], ['exists', 2]);
  eq('runs recorded (journal, ok)', store.countRuns({ kind: 'journal', status: 'ok' }), 2);
}

section('a plan adopted on day D for D+5 sits in D+5\'s part; a forget on day D fences it');
const SUN = '2026-11-01';
{
  const r = await journal.runJournal(SUN);
  const p = store.listParts(SUN).find(x => x.originJid === dm);
  check("Sunday's chat part cites the Sunday claim", p && p.sources.claims.includes(c2.id), r);
  const res = hooks.handleItemsDeleted(getDb(), { chatJid: dm, chatForms: [dm], msgIds: ['MSG-2'], cause: 'forget' });
  check('the hook ran', res && res.claims >= 1, res);
  const after = store.listParts(SUN).find(x => x.originJid === dm);
  eq("Sunday's part fenced (text gone)", [after.status, after.text], ['fenced', null]);
  const rv = store.getReviewByClaim(c2.id);
  eq('the review withdrawn, extraction and resolution NULLed', [rv.status, rv.extraction, rv.resolution], ['withdrawn', null, null]);
  eq('the self part of the first night is untouched', store.listParts(NK).find(x => x.originJid === 'self').status, 'active');
  const again = await journal.runJournal(SUN, { force: true });
  eq('a fenced part is never rebuilt', store.listParts(SUN).find(x => x.originJid === dm).status, 'fenced');
  void again;
  // A claim with no review yet is born withdrawn, so the reconciler can never adopt it later.
  const c3 = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'MSG-3', 'x', 'claim', 0.8, 'flagged', ?)`).run(dm, dm, clock.now()).lastInsertRowid);
  hooks.handleItemsDeleted(getDb(), { chatJid: dm, chatForms: [dm], msgIds: ['MSG-3'], cause: 'revoke', msgTs: clock.now() });
  eq('an unreviewed claim gets a withdrawn review', store.getReviewByClaim(c3)?.status, 'withdrawn');
}

section('a hook failure on forget is caught: degraded, audited, the forget stands');
{
  const bad = { transaction: () => () => { throw new Error('boom'); } };
  const r = hooks.handleItemsDeleted(bad, { chatJid: dm, chatForms: [dm], msgIds: [], cause: 'forget' });
  eq('returns null', r, null);
  check('degraded', hooks.isDegraded() && store.getState('degraded')?.where === 'hooks');
  hooks.clearDegraded();
  check('cleared', !hooks.isDegraded() && store.getState('degraded') === null);
  eq('purge cause is left to onRedacted', hooks.handleItemsDeleted(getDb(), { chatJid: dm, chatForms: [dm], msgIds: [], cause: 'purge' }), null);
}

section('catch-up: only the latest night is written, earlier ones are missed');
{
  store.upsertNight('2026-10-20', { status: 'done' });
  const r = await journal.runJournal('2026-10-24');
  eq('the three nights in between are missed (downtime)', ['2026-10-21', '2026-10-22', '2026-10-23'].map(k => [store.getNight(k)?.status, store.getNight(k)?.reason]),
    [['missed', 'downtime'], ['missed', 'downtime'], ['missed', 'downtime']]);
  check('the latest night ran', ['done', 'skipped', 'partial'].includes(r.status));
}

section('budget and the shared cap skip a night (not retried)');
{
  journal.__setDepsForTest({ budgetOk: () => false });
  const n0 = callRole.calls.length;
  const r = await journal.runJournal('2026-11-02');
  eq('over the clerk budget → skipped(budget)', [r.status, r.reason, store.getNight('2026-11-02').status], ['skipped', 'budget', 'skipped']);
  eq('a skipped night is not due again', journal.journalDue({ ...view, sleep: { ...view.sleep, startedAt: zonedToUnix(2026, 11, 2, 23, 0, tz) } },
    { at: zonedToUnix(2026, 11, 3, 1, 0, tz) }).due, false);
  journal.__setDepsForTest({ budgetOk: () => true });
  const old = config.arcs.clerkMaxPerDay;
  config.arcs.clerkMaxPerDay = 0;
  const r2 = await journal.runJournal(NK, { force: true });
  eq('shared cap reached → skipped(cap)', [r2.status, r2.reason], ['skipped', 'cap']);
  eq('…and an owner regenerate never downgrades a done night', store.getNight(NK).status, 'done');
  config.arcs.clerkMaxPerDay = old;
  eq('no calls for either', callRole.calls.length, n0);
}

section('output validation (fail closed)');
{
  const v = journal.validateJournalText;
  eq('a URL → rejected', v('see https://example.org today', { names: [] }).reason, 'identifier');
  eq('a JID → rejected', v('wrote to 15550001111@s.whatsapp.net', { names: [] }).reason, 'identifier');
  eq('@digits → rejected', v('ping @15550001111 later', { names: [] }).reason, 'identifier');
  eq('two invented names → invented_name', v('Met Zorblax and Quimby at the park.', { names: ['09:00 walk at Park'] }).reason, 'invented_name');
  check('names from the bullets are fine', v('Flatmate and I watched a film at Cinema.', { names: ['15:00 movie at Cinema with Flatmate'] }).ok);
  eq('capped', v('word '.repeat(300), { max: 240, rawMax: 5000 }).text.length <= 240, true);
  eq('raw size limit before parsing', v('x'.repeat(1600)).reason, 'too_long');
  const cr = fakeCallRole({ 'life.journal': () => 'Met Zorblax and Quimby at the park today.' });
  journal.__setDepsForTest({ callRole: cr.fn });
  const textsBefore = store.listParts(NK).map(p => p.text);
  const r = await journal.runJournal(NK, { force: true });
  eq('invented-name parts are dropped: partial, nothing written', [r.status, r.parts], ['partial', 0]);
  eq('the stored parts are unchanged', store.listParts(NK).map(p => p.text), textsBefore);
  store.upsertNight('2026-11-04', { status: 'done' });
  append({ type: 'claim.adopted', at: tue(13), actor: 'engine', causeId: c4.flagged.id, payload: { claimId: c4.id, reviewId: c4.rid, as: 'activity', ref: null } });
  const a5 = state.lastEventId;
  append({ type: 'activity.recorded', at: tue(13), actor: 'engine', causeId: a5, payload: { kind: 'walk', castIds: [], startAt: zonedToUnix(2026, 11, 5, 9, 0, tz), endAt: zonedToUnix(2026, 11, 5, 10, 0, tz), label: 'walk in the park' } });
  const r3 = await journal.runJournal('2026-11-05');
  eq('a fresh night whose only part is invented → partial (fail closed, not retried as failed)', [r3.status, store.getNight('2026-11-05').status], ['partial', 'partial']);
  eq('no part stored for it', store.listParts('2026-11-05').length, 0);
  eq('the run is recorded invalid', store.countRuns({ kind: 'journal', status: 'invalid' }) >= 1, true);
  journal.__setDepsForTest({ callRole: callRole.fn });
}

section('undone: a reverted source event marks the part undone; rebuilt once');
{
  const self = store.listParts(NK).find(p => p.originJid === 'self');
  const target = self.sources.events.map(getEvent).find(e => ['activity.started', 'meal', 'work.late'].includes(e.type));
  revertEvent(target.id, { reason: 'test' });
  state = rebuild({ world });
  const n0 = callRole.callsFor('life.journal').length;
  const r = await journal.rebuildUndone();
  check('one part undone and rebuilt', r.undone >= 1 && r.rebuilt >= 1, r);
  const now = store.listParts(NK).find(p => p.originJid === 'self');
  eq('the rebuilt part is active and no longer cites the reverted event', [now.status, now.sources.events.includes(target.id)], ['active', false]);
  eq('one more clerk call', callRole.callsFor('life.journal').length, n0 + 1);
  const t2 = now.sources.events.map(getEvent).find(e => e.type === 'activity.started' || e.type === 'travel.started');
  revertEvent(t2.id, { reason: 'again' });
  state = rebuild({ world });
  const r2 = await journal.rebuildUndone();
  eq('a second revert: undone again, not rebuilt (once)', [r2.rebuilt, store.listParts(NK).find(p => p.originJid === 'self').status], [0, 'undone']);
}

section('purge with life stopped, through the registered 006 hooks');
{
  hooks.__setDepsForTest(null);
  hooks.__setDepsForTest({ now: () => clock.now(), timezone: () => tz });
  check('registered', await hooks.registerHooks() && hooks.hooksRegistered());
  check('idempotent', await hooks.registerHooks());
  const [person] = await seedPeople([{ jid: dm, name: 'Avery Quill' }]);
  // A group claim whose resolution names the person.
  const gjid = '120363000000099999@g.us';
  const gc = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'group', ?, 'MSG-G', 'meeting them at the cafe', 'commitment', 0.9, 'flagged', ?)`).run(gjid, gjid, clock.now()).lastInsertRowid);
  const gr = store.createReview({ claimId: gc, chatJid: gjid, originKind: 'group', originJid: gjid, createdAt: clock.now(), status: 'tray' }).id;
  store.updateReview(gr, { resolution: { placeId: 'place:cafe', castIds: [], subjectJid: person } });
  store.putPart({ nightKey: '2026-10-29', originKind: 'group', originJid: gjid, text: 'A coffee plan came up.', sources: { events: [], claims: [gc] } });
  const before = store.listReviews({ originJid: dm, limit: 50 }).length;
  check('fixture: the person has reviews and parts', before > 0 && store.listParts(NK).some(p => p.originJid === dm));
  const { purgePerson } = await import('../../src/memory/relationshipStore.js');
  purgePerson(person, 'test', 'tester');
  eq('their DM reviews are gone', store.listReviews({ originJid: dm, limit: 50 }).length, 0);
  check('their DM parts are gone', !store.listParts(NK).some(p => p.originJid === dm) && !store.listParts(SUN).some(p => p.originJid === dm));
  eq('the group review that resolved them is gone', store.getReview(gr), null);
  eq('…with its life_claims row', getDb().prepare('SELECT COUNT(*) AS n FROM life_claims WHERE id = ?').get(gc).n, 0);
  eq('…and the part citing it', store.listParts('2026-10-29').length, 0);
  check('the self part stays', store.listParts(NK).some(p => p.originJid === 'self'));
  const again = hooks.onRedacted([person]);
  eq('onRedacted is idempotent', again.reviews + again.groupReviews + again.parts, 0);
}

section('never in prompts');
{
  const roots = ['src/personality', 'src/brain', 'src/calls', 'src/instagram', 'src/mind', 'src/whatsapp'];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        if (/story\/(journal|narrate)\.js|story_journal_parts|story_narrations/.test(s)) offenders.push(path.relative(PROJECT_ROOT, p));
      }
    }
  };
  for (const r of roots) walk(path.join(PROJECT_ROOT, r));
  eq('no prompt-side module imports journal/narrate or names their tables', offenders, []);
  const texts = Object.values(JOURNAL_TEXT);
  const lines = [null, { kind: 'group', chatJid: '120363000000011111@g.us' }, { kind: 'dm', chatJid: dm }]
    .map(aud => JSON.stringify(lifeLines(state, clock.now(), aud, { world })) + (callStateNote(state, clock.now(), aud) || ''));
  check("life's prompt lines carry no journal text", lines.every(l => texts.every(t => !l.includes(t.slice(0, 20)))));
}

if (!(await skipSimUnlessWired())) {
  section('sim: the journal through the life facade');
  const story = await import('../../src/life/story/index.js');
  check('the story facade exposes journal readers', typeof story.journalNights === 'function');
}

void DAY;
report();
