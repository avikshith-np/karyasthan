// 020 D1: one "as of" reader for every writer's fact sheet (projector.asOf). A fold of the log
// up to one moment: equal to a full replay, across snapshot boundaries and back-dated rows; a
// null (never "now") when there is no such world; fresh after a revert, a rewind or a purge.
// Cheap enough per writer: the numbers print on 2,000+ events.

import { section, check, eq, report, setupScratchDb } from '../arcs-tests/_helpers.js';
import { bootLife, stopLife, simulateDays, exampleWorld } from '../arcs-tests/_helpers.js';

const { cleanup, db } = await setupScratchDb();
const world = await exampleWorld();
const booted = await bootLife({ world, skills: { life: true, arcs: false } });
const { clock } = booted;
const projector = await import('../../src/life/projector.js');
const eventLog = await import('../../src/life/eventLog.js');
const { asOf, stateBeforeEvent, serializeState, createInitialState, project, saveSnapshot, rebuild } = projector;
const genesisAt = clock.now();

await simulateDays(12);
// To 2,000+ events: more of a plain kind, written straight to the log, so a restart reads them; then more days, for snapshots past them.
for (; eventLog.lastEventId() < 2100;) eventLog.appendEvent({ type: 'meal', at: clock.now(), actor: 'engine', payload: { kind: 'snack' } });
await stopLife();
await bootLife({ world, clock, skills: { life: true, arcs: false } });
await simulateDays(2);

const head = () => eventLog.lastEventId();
const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const plain = (st) => JSON.stringify(serializeState(st));
/** The first place two states differ (a path), or null. */
function diffOf(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diffOf(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
}
const same = (name, got, want) => {
  const d = diffOf(serializeState(got), serializeState(want));
  check(name, d === null, d ?? '');
};

/** The reference: every event before the cut through project(), from an empty state. */
function replay(keep, excluded = new Set()) {
  let state = createInitialState(world);
  for (const id of excluded) state.excluded.add(id);
  let after = 0;
  for (;;) {
    const page = eventLog.eventsAfter(after, 2000);
    if (!page.length) break;
    for (const ev of page) if (keep(ev)) state = project(state, ev, world);
    after = page[page.length - 1].id;
  }
  return state;
}

section('asOf({eventId}) is a replay of everything before it, across snapshot boundaries');
{
  const total = head();
  check('a long enough log', total >= 2000, String(total));
  // A few snapshots at known places (the running engine writes some too).
  const snaps = () => db.prepare('SELECT upto_event_id AS id FROM world_snapshots ORDER BY id').all().map(r => r.id);
  check('the log has snapshots', snaps().length > 0, String(snaps().length));
  const around = snaps().slice(-3).flatMap(u => [u, u + 1, u + 2]);
  const ids = [...new Set([2, 3, Math.floor(total / 3), Math.floor(total / 2), total, ...around])].filter(i => i >= 2 && i <= total);
  for (const id of ids) {
    const got = asOf({ eventId: id }, { world });
    const want = replay(e => e.id < id);
    same(`id ${id}: equal to the replay`, got.state, want);
    eq(`id ${id}: upto`, got.upto, id - 1);
    eq(`id ${id}: the moment is that event's time`, got.at, eventLog.getEvent(id).at);
  }
  same('stateBeforeEvent is the same read', stateBeforeEvent(ids[2], { world }), asOf({ eventId: ids[2] }, { world }).state);
}

section('asOf({at}): every event dated by then, in id order, with back-dated rows');
{
  const total = head();
  const mid = eventLog.getEvent(Math.floor(total / 2)).at;
  const want = replay(e => e.at <= mid);
  same('at a mid-life time: equal to the filtered replay', asOf({ at: mid }, { world }).state, want);
  // A back-dated row: appended now, dated before `mid`, after events dated later (catch-up, chats, phone).
  const before = asOf({ at: mid }, { world });
  const back = eventLog.appendEvent({ type: 'meal', at: mid - 60, actor: 'engine', payload: { kind: 'snack' } });
  const after = asOf({ at: mid }, { world });
  check('the cut moved with the back-dated row', after.upto === back.id && before.upto !== back.id, `${before.upto} → ${after.upto}`);
  same('…and the fold includes it', after.state, replay(e => e.at <= mid));
  // The cut after it: a time just before `mid` must skip what's dated later and still see the row.
  const earlier = asOf({ at: mid - 30 }, { world });
  same('a later-dated row below the cut is skipped', earlier.state, replay(e => e.at <= mid - 30));
  eq('asOf({at}) names its moment', after.at, mid);
}

section('no such world: null, never "now"');
{
  eq('a time before genesis', asOf({ at: genesisAt - 86400 }, { world }), null);
  eq('the first event has nothing before it', asOf({ eventId: 1 }, { world }), null);
  for (const bad of [{ eventId: 0 }, { eventId: -3 }, { eventId: 1.5 }, { eventId: '7' }, { at: 'x' }, {}, null, undefined]) {
    eq(`a bad key ${JSON.stringify(bad)}`, asOf(bad, { world }), null);
  }
  const old = Math.floor(head() / 2);
  db.exec('CREATE TEMP TABLE keep_snaps AS SELECT * FROM world_snapshots');
  db.prepare('DELETE FROM world_snapshots').run();
  eq('a very old id with its snapshots pruned, past the fold cap: null', asOf({ eventId: old + 7 }, { world, maxEvents: 50 }), null);
  check('…and within the cap it folds from genesis', asOf({ eventId: old + 7 }, { world })?.upto === old + 6);
  db.exec('INSERT INTO world_snapshots SELECT * FROM keep_snaps; DROP TABLE keep_snaps');
  const beyond = asOf({ eventId: head() + 100 }, { world });
  eq('an id past the head: the world as it stands', beyond?.upto, head());
}

section('the caller owns its copy; the cache hands out clean ones');
{
  const id = Math.floor(head() / 2);
  const a = asOf({ eventId: id }, { world });
  const clean = plain(a.state);
  a.state.vitals.energy = -999;
  a.state.cast.clear();
  a.state.story.history = 'scribbled';
  eq('a scribble on one read never reaches the next', plain(asOf({ eventId: id }, { world }).state), clean);
}

section('undo: a revert, a rewind or a purge between two sheets is a fresh fold');
{
  const list = eventLog.listEvents({ types: ['activity.started'], order: 'desc', limit: 5 });
  const target = list[2];
  const later = eventLog.getEvent(head());
  const cut = { eventId: later.id };
  const before = asOf(cut, { world });
  check('the activity is in the fold', before.state.excluded.has(target.id) === false);
  const rev = eventLog.revertEvent(target.id, { reason: 'test' });
  const revId = rev.revertEventId;
  const after = asOf(cut, { world });
  check('after its revert the same key reads it excluded (the revert is applied, though its id is past the cut)', after.state.excluded.has(target.id), String(revId));
  const excludedRead = asOf({ eventId: target.id }, { world });
  check('an excluded event id: the world before it, flagged', excludedRead.targetExcluded === true && excludedRead.upto === target.id - 1);
  check('…an unexcluded one is not flagged', asOf({ eventId: head() }, { world }).targetExcluded === false);
  // A rewind range applies at once too.
  const span = list.slice(-1)[0];
  const preRewind = asOf({ eventId: head() }, { world });
  check('not yet in a rewind range', projector.isExcludedId(preRewind.state, span.id) === false);
  const rw = eventLog.appendEvent({ type: 'world.rewound', at: clock.now(), actor: 'owner', payload: { toEventId: span.id - 1, toAt: span.at, reason: 'x' } });
  check('a rewind between two sheets is seen by the next', projector.isExcludedId(asOf({ eventId: rw.id + 1 }, { world }).state, span.id) === true);
  eventLog.revertEvent(rw.id, { reason: 'undo' });

  // A purge rewrites rows in place; no event marks it.
  const jid = '15550001111@s.whatsapp.net';
  const sub = eventLog.appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: jid, subjectJid: jid, payload: { reason: 'test' } });
  const cutAfter = { eventId: sub.id + 1 };
  const seen = asOf(cutAfter, { world });
  check('the cut holds the row', seen.upto >= sub.id);
  eventLog.redactPerson(jid);
  const stats0 = projector.__asOfStats();
  asOf(cutAfter, { world });
  eq('a purge drops the cache (a fresh fold)', projector.__asOfStats().misses, stats0.misses + 1);
}

section('cost, on the log above');
{
  const total = head();
  // Cold from the newest snapshot before the cut; cold with no snapshot; warm.
  const snapBacked = db.prepare('SELECT upto_event_id AS id FROM world_snapshots ORDER BY id DESC LIMIT 1').get()?.id ?? total;
  const near = Math.min(total - 2, snapBacked + 60);
  rebuild({ world });
  const coldSnap = ms(() => asOf({ eventId: near }, { world }));
  const warm = ms(() => asOf({ eventId: near }, { world }));
  db.exec('CREATE TEMP TABLE keep_snaps AS SELECT * FROM world_snapshots');
  db.prepare('DELETE FROM world_snapshots').run();
  const coldNone = ms(() => asOf({ eventId: total - 1 }, { world }));
  db.exec('INSERT INTO world_snapshots SELECT * FROM keep_snaps; DROP TABLE keep_snaps');
  console.log(`  asOf on ${total} events: cold from a snapshot ${coldSnap.ms.toFixed(1)} ms, cold with none (full fold) ${coldNone.ms.toFixed(1)} ms, warm ${warm.ms.toFixed(1)} ms; state ${(plain(warm.r.state).length / 1024).toFixed(0)} KB`);
  check('warm is a clone away', warm.ms < 40, warm.ms.toFixed(1));
  check('cold from a snapshot is fine for a writer', coldSnap.ms < 500, coldSnap.ms.toFixed(1));
  check('even a full fold stays under a second or two', coldNone.ms < 4000, coldNone.ms.toFixed(1));
}

section('the LRU stays small');
{
  const t = head();
  for (let i = 0; i < 20; i++) asOf({ eventId: t - i * 3 }, { world, maxEvents: 20000 });
  check('at most 8 kept', projector.__asOfStats().size <= 8, String(projector.__asOfStats().size));
}

await stopLife();
cleanup();
report();
