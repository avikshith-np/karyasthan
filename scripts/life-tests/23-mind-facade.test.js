// 008 additions at the life facade (spec 008 research R26, tasks T026/T027): the
// mind's read-only exports availabilityNow / inPhoneCheckNow / embargoActive /
// overSelfMentionBudget with the engine stopped and running; the onTick fan-out
// (order, info, a throwing subscriber, unsubscribe); and purgePerson running the
// mind's purge (digests, no_learn, onPersonPurged hooks) and life's redactPerson in
// ONE transaction: both happen, and a throwing mind hook rolls both back before
// life rebuilds its in-memory projection. Scratch DB, fake clock, mocked Jev, no
// timers, no network.
import { setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { setRngSeed } from '../../src/life/rng.js';
import { appendEvent, getEvent, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { serializeState } from '../../src/life/projector.js';
import { availabilityAt, AVAILABILITY_STATES } from '../../src/life/availability.js';
import { startFromHeavy, lifeGuardNote } from '../../src/life/embargo.js';
import { setJev as setDecisionJev } from '../../src/life/decisions.js';
import { setJev as setClaimsJev, noteSelfMention, resetClaimCounters } from '../../src/life/claims.js';
import { pendingCount } from '../../src/life/queue.js';
import * as life from '../../src/life/index.js';

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(27, 6));
setClock(clock.fn);
setRngSeed(7);

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };
setDecisionJev(fakeJev(() => ({ pick: jevChoice('stay', { go: 0.3, stay: 0.7 }) })).fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('none', { none: 1 }) })).fn);

const DM = '15550000031@s.whatsapp.net';
const GROUP = '120363000000000031@g.us';
const sock = fakeSock();
const opts = {
  world, timers: false, isEnabled: () => true, seed: 7, getSock: () => sock,
  processMessage: async () => {}, isGroupMuted: () => false, isMember: () => true, sleep: async () => {},
};
const advance = async (hours) => {
  for (let i = 0; i < Math.round(hours * 4); i++) { clock.advance({ minutes: 15 }); await life.tick(); }
};

try {
  const { db } = await setupScratchDb();
  const at0 = clock.now() - 200 * 86400;
  db.prepare("INSERT INTO groups (jid, name) VALUES (?, 'g')").run(GROUP);
  db.prepare('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)').run(DM, 'p', at0);
  db.prepare("INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'pn', 'sync', ?)").run(DM, DM, at0);
  db.prepare('INSERT INTO group_members (group_jid, person_jid) VALUES (?, ?)').run(GROUP, DM);

  section('mind readers with the engine stopped');
  eq('availabilityNow → null', life.availabilityNow(), null);
  eq('inPhoneCheckNow → false', life.inPhoneCheckNow(), false);
  eq('embargoActive → false', life.embargoActive(), false);
  resetClaimCounters();
  eq('overSelfMentionBudget → false with no mentions', life.overSelfMentionBudget(GROUP), false);

  section('onTick fan-out');
  const seen = [];
  const offA = life.onTick((view, info) => { seen.push(['a', info?.at ?? null, !!view]); });
  const offBad = life.onTick(() => { throw new Error('subscriber bug'); });
  const offB = life.onTick((view, info) => { seen.push(['b', info?.at ?? null, !!view]); });
  await life.startLife(opts);
  const bootTicks = seen.length;
  await advance(0.5);
  const ticked = seen.slice(bootTicks);
  check('every tick reaches the subscribers in order, past a throwing one',
    ticked.length === 4 && ticked[0][0] === 'a' && ticked[1][0] === 'b' && ticked[2][0] === 'a' && ticked[3][0] === 'b', ticked);
  check('…with a view and the tick time', ticked.every(([, at, v]) => v && typeof at === 'number' && at <= clock.now()), ticked);
  offA(); offBad();
  const n = seen.length;
  await advance(0.25);
  eq('unsubscribed: only the remaining subscriber hears the next tick', seen.slice(n).map(s => s[0]), ['b']);
  offB();
  await advance(0.25);
  eq('…and none after its own unsubscribe', seen.length, n + 1);

  section('mind readers with the engine running');
  const st = life.getState();
  const want = availabilityAt(st, clock.now(), world);
  check('availabilityNow is a known state', AVAILABILITY_STATES.includes(life.availabilityNow()), life.availabilityNow());
  eq('…the same as availabilityAt(now)', life.availabilityNow(), want.state);
  eq('inPhoneCheckNow = availability onPhone', life.inPhoneCheckNow(), want.onPhone === true);
  eq('embargoActive matches lifeGuardNote (none)', [life.embargoActive(), life.lifeGuardNote()], [false, null]);
  for (let i = 0; i < 4; i++) noteSelfMention(GROUP, clock.now());
  eq('over the self-mention budget after 4 mentions (budget 3)', life.overSelfMentionBudget(GROUP), true);
  eq('…per chat', life.overSelfMentionBudget(DM), false);

  section('embargoActive after a heavy event');
  await life.stopLife();
  const heavy = appendEvent({ type: 'sick.started', at: clock.now(), actor: 'engine', heavy: true,
    payload: { what: 'a bad flu' } });
  for (const e of startFromHeavy(heavy, null, { hours: 24 }).events) appendEvent(e);
  await life.startLife(opts);
  eq('embargoActive → true', life.embargoActive(), true);
  check('…and lifeGuardNote says the same', life.lifeGuardNote() !== null
    && lifeGuardNote(life.getState().embargo, clock.now()) !== null);
  await advance(25);
  eq('the embargo ends on time', life.embargoActive(), false);

  section('purgePerson: mind purge and life redact in one transaction');
  const store = await import('../../src/mind/store.js');
  const rs = await import('../../src/memory/relationshipStore.js');
  const msg = (id, text) => db.prepare(`INSERT INTO messages (id, group_jid, sender_jid, content, message_type, is_from_self,
    timestamp, metadata_json) VALUES (?, ?, ?, ?, 'text', 0, ?, '{}')`).run(id, DM, DM, text, clock.now() - 600);
  msg('P1', 'about my week');
  const digestId = store.insertDigest({ chatJid: DM, originKind: 'dm', fromRowid: 0, toRowid: 1, periodStart: clock.now() - 3600,
    periodEnd: clock.now(), summary: 'a summary', tone: 'warm', evidence: [{ msgId: 'P1', ts: clock.now() - 600 }] });
  const trig = appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: DM,
    payload: { decisionId: 0 } });
  life.enqueueDeferred({ id: 'PQ1', groupJid: DM, senderJid: DM }, { isDm: true }, { remoteJid: DM, id: 'PQ1', fromMe: false });
  const digestExists = () => !!db.prepare('SELECT 1 FROM mind_digests WHERE id = ?').get(digestId);
  const redacted = () => getEvent(trig.id)?.redacted === true || getEvent(trig.id)?.redacted === 1
    || JSON.stringify(getEvent(trig.id)?.payload || {}).includes('redacted');
  const noLearn = () => db.prepare("SELECT no_learn FROM messages WHERE id = 'P1'").pluck().get();
  check('seeded: digest, DM-origin world event, queued DM', digestExists() && !redacted() && pendingCount(DM) === 1);

  // A throwing mind hook: nothing of either side may stick, and life's live projection
  // must not have been rebuilt from redacted rows (the mind side runs first).
  const stateBefore = JSON.stringify(serializeState(life.getState()));
  const lastBefore = lastEventId();
  const off = rs.onPersonPurged(() => { throw new Error('mind hook failed'); });
  let threw = null;
  try { rs.purgePerson(DM, 'test', 'owner:test'); } catch (err) { threw = err; }
  off();
  check('the purge throws', !!threw && /mind hook failed/.test(threw.message), threw?.message);
  check('rolled back: digest kept, event not redacted, queue kept, no_learn unset',
    digestExists() && !redacted() && pendingCount(DM) === 1 && !noLearn(), [digestExists(), redacted(), pendingCount(DM), noLearn()]);
  eq('…life\'s in-memory state untouched', JSON.stringify(serializeState(life.getState())), stateBefore);
  eq('…no events appended', lastEventId(), lastBefore);

  // Both run when nothing throws.
  const hookSaw = [];
  const off2 = rs.onPersonPurged((_db, person) => { hookSaw.push(person); });
  rs.purgePerson(DM, 'test', 'owner:test');
  off2();
  check('mind side: digest deleted, their lines no_learn, hook ran', !digestExists() && noLearn() === 1 && hookSaw.includes(DM),
    [digestExists(), noLearn(), hookSaw]);
  check('life side: DM-origin event redacted, queue dropped', redacted() && pendingCount(DM) === 0, [redacted(), pendingCount(DM)]);
  check('…and the live projection no longer names them', !JSON.stringify(serializeState(life.getState())).includes(DM));

  await life.stopLife();
  check('no network calls', fetches === 0, fetches);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
