// Review repairs at the facade (src/life/index.js) and the phone: structural
// events can't be reverted; the timeline leaves reverted events out; who may
// nudge a decision (perceiveChat refuses fromMe, muted groups, strangers'
// DMs); redactPerson rebuilds the live projection; markSeenNow hands the
// chat's queue to the live turn instead of marking it answered; a check left
// open by a crashed process is closed at boot (and bounded meanwhile); turning
// life off while he's asleep still drains the queue once, and with no socket
// the drain is retried; while off, no Jev calls. Scratch DB, fake clock, fake
// socket, mocked Jev; no timers, no network.
import { setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, throws, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent, eventsAfter, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { serializeState } from '../../src/life/projector.js';
import { availabilityAt, inPhoneCheck, PHONE_CHECK_GRACE_SEC } from '../../src/life/availability.js';
import { setJev as setDecisionJev } from '../../src/life/decisions.js';
import { setJev as setClaimsJev } from '../../src/life/claims.js';
import { pendingCount, getItem } from '../../src/life/queue.js';
import { PROPOSAL_P } from '../../src/life/pulse.js';
import * as life from '../../src/life/index.js';

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(27, 6));       // Tue 27 Oct 06:00
setClock(clock.fn);
const MIN = 60;

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const decisionJev = fakeJev(() => ({ pick: jevChoice('stay', { go: 0.3, late: 0.2, stay: 0.5 }) }));
setDecisionJev(decisionJev.fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('none', { none: 1 }) })).fn);

// A seed under which Tuesday brings an evening invitation (a live decision to nudge).
let seed = null;
for (let s = 1; s < 500 && seed === null; s++) {
  setRngSeed(s);
  if (rngFor('2026-10-27', 'decision:evening')() < PROPOSAL_P * 0.8) seed = s;
}

const DM = '15550000001@s.whatsapp.net';        // shares a group with him
const STRANGER = '15550000009@s.whatsapp.net';  // shares none
const GROUP = '120363000000000001@g.us';
const MUTED = '120363000000000002@g.us';
const sock = fakeSock();
let sockUp = true;
const turns = [];
let enabled = true;
const opts = {
  world,
  timers: false,
  isEnabled: () => enabled,
  seed,
  getSock: () => (sockUp ? sock : null),
  processMessage: async (s, msg, ctx) => { turns.push({ msg, ctx }); },
  loadMessage: (item) => ({ id: item.msgId, groupJid: item.chatJid, senderJid: item.senderJid ?? item.chatJid, content: 'hey?' }),
  isGroupMuted: (jid) => jid === MUTED,
  isMember: () => true,
  sleep: async () => {},
};
const advance = async (hours) => {
  for (let i = 0; i < Math.round(hours * 4); i++) { clock.advance({ minutes: 15 }); await life.tick(); }
};
const evs = () => eventsAfter(0, 50000);

try {
  const { db } = await setupScratchDb();
  db.prepare("INSERT INTO groups (jid, name) VALUES (?, 'g')").run(GROUP);
  db.prepare("INSERT INTO people (jid, push_name) VALUES (?, 'p')").run(DM);
  db.prepare('INSERT INTO group_members (group_jid, person_jid) VALUES (?, ?)').run(GROUP, DM);

  section('setup');
  check('found a seed with a Tuesday invitation', seed !== null, seed);
  await life.startLife(opts);
  await advance(12);                                  // → 18:00

  section('revert: structural events are refused, content events allowed');
  const plan = evs().find(e => e.type === 'plan.made' && !e.payload.amendedFor);
  const woke = evs().find(e => e.type === 'woke');
  throws('the day\'s plan cannot be reverted (the pulse would re-derive it)', () => life.revertEvent(plan.id), /cannot be reverted/);
  throws('nor a wake', () => life.revertEvent(woke.id), /cannot be reverted/);
  check('REVERTIBLE_TYPES lists the content events', life.REVERTIBLE_TYPES.has('activity.started') && !life.REVERTIBLE_TYPES.has('plan.made')
    && !life.REVERTIBLE_TYPES.has('decision.committed'));
  const act = evs().filter(e => e.type === 'activity.started' && e.at >= local(27, 9)).find(e => e.payload.kind !== 'sleep');
  life.revertEvent(act.id, { reason: 'test' });
  const tl = life.timeline({ from: local(27, 6), to: local(27, 18) });
  check('the timeline leaves the reverted activity out', tl.actual.every(a => a.eventId !== act.id));
  check('… and lists orphaned ids', Array.isArray(tl.orphaned));

  section('perceiveChat: who may nudge a decision');
  const live = () => [...life.getState().decisions.values()].find(x => x.status === 'open');
  while (!live() && clock.now() < local(27, 21)) await advance(0.25);
  const d = live();
  check('a live decision to nudge', !!d, [...life.getState().decisions.values()].map(x => x.status));
  if (d) {
    const placeName = life.getState().places.get(d.subject.placeId)?.name ?? d.kind;
    const text = `${placeName} tonight? let's go`;
    const n0 = lastEventId();
    const triggers = () => eventsAfter(n0, 1000).filter(e => e.type === 'chat.trigger');
    await life.perceiveChat({ groupJid: GROUP, senderJid: DM, content: text, isFromSelf: true }, { chatJid: GROUP });
    await life.perceiveChat({ groupJid: MUTED, senderJid: DM, content: text }, { chatJid: MUTED });
    await life.perceiveChat({ groupJid: STRANGER, senderJid: STRANGER, content: text }, { chatJid: STRANGER });
    eq('his own message, a muted group and a stranger\'s DM nudge nothing', triggers().length, 0);
    await life.perceiveChat({ groupJid: DM, senderJid: DM, content: text }, { chatJid: DM });
    const t = triggers();
    eq('a DM from someone he shares a group with does', t.map(e => [e.originKind, e.originJid]), [['dm', DM]]);

    section('redactPerson rebuilds the live projection');
    check('before: her DM is in the decision\'s origins', JSON.stringify(serializeState(life.getState())).includes(DM));
    const res = life.redactPerson(DM);
    check('events were redacted', res.events >= 1, res);
    check('after: nothing of her stays in the in-memory state', !JSON.stringify(serializeState(life.getState())).includes(DM));
    const id0 = lastEventId();
    await advance(1);
    check('… and he keeps living (the pulse ticks on)', lastEventId() > id0);
  }

  section('markSeenNow hands the chat\'s queue to the live turn');
  life.enqueueDeferred({ id: 'Q1', groupJid: DM, senderJid: DM }, { isDm: true }, { remoteJid: DM, id: 'Q1', fromMe: false });
  const seen = await life.markSeenNow(sock, DM, { remoteJid: DM, id: 'LIVE1', fromMe: false });
  check('read now, but the queued row is not marked answered', seen.read >= 2 && pendingCount(DM) === 1, seen);
  check('… its catch-up goes with the live turn', seen.catchUp?.itemIds?.length === 1 && seen.catchUp.triggerIds[0] === 'Q1');
  eq('settled after the reply', [life.settleCatchUp(seen.catchUp), pendingCount(DM)], [1, 0]);

  section('a check left open by a crash');
  const at0 = clock.now();
  const st = { phone: { checkStartedAt: at0, checkUntil: at0 + 3 * MIN }, availability: { state: 'meeting', since: at0, until: at0 + 3600 }, activity: { kind: 'meeting' } };
  check('on the phone during the check', inPhoneCheck(st, at0 + MIN) === true);
  check('not once its end + grace has passed', inPhoneCheck(st, at0 + 3 * MIN + PHONE_CHECK_GRACE_SEC + 1) === false);
  check('… so the gate sees the meeting again', availabilityAt(st, at0 + 30 * MIN, world).onPhone === false);
  await life.stopLife();
  const crashAt = clock.now();
  appendEvent({ type: 'phone.check.started', at: crashAt, actor: 'engine', payload: { until: crashAt + 2 * MIN, reason: 'scheduled' } });
  clock.advance({ hours: 12 });                       // down across the next morning's wake
  const beforeBoot = lastEventId();
  await life.startLife(opts);
  const booted = eventsAfter(beforeBoot, 50000);
  const rec = booted.filter(e => e.type === 'phone.check.ended').pop();
  eq('boot closes it (recovered)', rec?.payload.reason, 'recovered');
  eq('… and he is off the phone', life.getState().availability.onPhone, false);
  check('the downtime was still caught up (a wake dated inside the gap)',
    booted.some(e => e.type === 'woke' && e.at > crashAt && e.at < clock.now()), booted.map(e => e.type).slice(0, 12));
  eq('… the recovery comes after the catch-up, not before it', booted.findIndex(e => e === rec) > booted.findIndex(e => e.type === 'woke'), true);

  section('life off while asleep: one forced drain; no socket → retried');
  // Into the night: he is asleep.
  while (life.getState().activity.kind !== 'sleep') await advance(0.25);
  const night = life.enqueueDeferred({ id: 'N1', groupJid: DM, senderJid: DM }, { isDm: true }, { remoteJid: DM, id: 'N1', fromMe: false });
  turns.length = 0;
  sockUp = false;
  enabled = false;
  const jevBefore = decisionJev.calls.length;
  const evBefore = lastEventId();
  await advance(0.25);
  eq('no socket: the drain waits, the item stays pending', [turns.length, getItem(night.id).status], [0, 'pending']);
  sockUp = true;
  await advance(0.25);
  eq('next tick: drained once, even though he is asleep', [turns.length, getItem(night.id).status], [1, 'drained']);
  check('… with a catch-up context', !!turns[0]?.ctx?.catchUp);
  await advance(12);
  eq('while off: no Jev calls from the pulse', decisionJev.calls.length, jevBefore);
  check('… and no new invitations', !eventsAfter(evBefore, 50000).some(e => e.type === 'decision.opened'));
  await life.stopLife();

  check('no network calls', fetches === 0, fetches);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
