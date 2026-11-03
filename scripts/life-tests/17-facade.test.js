// T022 — the facade (src/life/index.js): start on an empty log → genesis +
// places + cast; ticks move the day; the C1 readers (gate, prompt lines,
// schedule) answer from the projection; a deferred DM is drained by an owner
// "check phone now" through the injected processMessage; a sent reply with a
// claim leaves an inert chat-origin pointer; revert rebuilds; timeline/map
// shapes; restart → the same state; the skill off → one final drain, then the
// gate passes everything; off at boot → nothing seeded. Scratch DB, fake
// clock, fake socket, mocked Jev; no timers, no network.
import { setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report } from './_helpers.js';
import { setClock, zonedToUnix } from '../../src/life/clock.js';
import { eventsAfter, lastEventId, appendEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { serializeState } from '../../src/life/projector.js';
import { setJev as setDecisionJev } from '../../src/life/decisions.js';
import { setJev as setClaimsJev, listClaims } from '../../src/life/claims.js';
import { pendingCount } from '../../src/life/queue.js';
import * as life from '../../src/life/index.js';

const { db } = await setupScratchDb();
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const tz = world.timezone;
const local = (day, h, m = 0) => zonedToUnix(2026, 10, day, h, m, tz);
const clock = fakeClock(local(27, 6));       // Tue 27 Oct 06:00
setClock(clock.fn);

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const decisionJev = fakeJev(() => ({ pick: jevChoice('stay', { go: 0.2, late: 0.1, stay: 0.7 }) }));
setDecisionJev(decisionJev.fn);
const claimsJev = fakeJev(() => ({ kind: jevChoice('commitment', { none: 0.05, claim: 0.05, commitment: 0.9 }) }));
setClaimsJev(claimsJev.fn);

const DM = '15550000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const sock = fakeSock();
const turns = [];
let enabled = true;
const opts = {
  world,
  timers: false,
  isEnabled: () => enabled,
  seed: 42,
  getSock: () => sock,
  processMessage: async (s, msg, ctx) => { turns.push({ msg, ctx }); },
  loadMessage: (item) => ({ id: item.msgId, groupJid: item.chatJid, senderJid: item.senderJid ?? item.chatJid, content: 'hey, you there?' }),
  isGroupMuted: () => false,
  isMember: () => true,
  sleep: async () => {},
};
const advance = async (hours) => {
  for (let i = 0; i < hours * 4; i++) { clock.advance({ minutes: 15 }); await life.tick(); }
};

try {
  section('start on an empty log');
  eq('nothing before start', [life.isLifeOn(), life.getState(), lastEventId()], [false, null, 0]);
  await life.startLife(opts);
  const types = eventsAfter(0, 1000).map(e => e.type);
  eq('genesis first', types[0], 'genesis');
  eq('one place.created per place', types.filter(t => t === 'place.created').length, world.places.length);
  eq('one cast.created per cast member', types.filter(t => t === 'cast.created').length, world.cast.length);
  await advance(0.25);
  const first = eventsAfter(0, 1000).find(e => e.type === 'sleep.started');
  check('the first tick finds him asleep at 06:00 (dated at genesis)', !!first && first.at === local(27, 6));
  const s0 = life.getState();
  check('isLifeOn', life.isLifeOn() === true);
  eq('getState is a view of the projection', [s0.view, s0.world.source, s0.places.size, s0.cast.size],
    [true, 'example', world.places.length, world.cast.length]);
  s0.vitals.energy = -999;
  check('… and a copy (mutating it changes nothing)', life.getState().vitals.energy !== -999);

  section('ticks move the day');
  await advance(6);   // → 12:00
  const s1 = life.getState();
  check('awake and planned by noon', s1.activity.kind !== 'sleep' && s1.plan?.date === '2026-10-27', s1.activity.kind);
  eq('Tuesday is an office day', s1.plan.dayType, 'office');
  check('isAwakeAt: noon yes, 03:00 tomorrow no', life.isAwakeAt(local(27, 12)) === true && life.isAwakeAt(local(28, 3)) === false);
  const windows = life.freeWindows(local(27, 0));
  check('freeWindows: a list of {from,to}', Array.isArray(windows) && windows.every(w => w.to > w.from));

  section('readers');
  check('timeLine', /^Now: Tue 27 Oct, 12:15\.$/.test(life.timeLine()), life.timeLine());
  const inner = life.innerStateLine({ chatJid: GROUP });
  check('innerStateLine ≤ 240 chars', typeof inner === 'string' && inner.length > 0 && inner.length <= 240, inner);
  const cards = life.castCards({ chatJid: GROUP }, 'lunch with the coworkers?', 3);
  check('castCards ≤ 3 strings', Array.isArray(cards) && cards.length <= 3 && cards.every(c => typeof c === 'string'));
  check('callStateNote is one line', typeof life.callStateNote(DM) === 'string' && life.callStateNote(DM).length <= 160);
  eq('no embargo → no guard note', life.lifeGuardNote(), null);
  eq('catchUpNote', life.catchUpNote(DM, { awayMin: 50, newCount: 3 }),
    'You were away ~50 min; 3 new messages since you last looked; reply once, covering what needs you.');
  const g = life.gateMessage({ id: 'MSG1', groupJid: DM }, { isDm: true });
  check('gateMessage returns an outcome from the matrix', ['now', 'sneak', 'defer'].includes(g.outcome) && typeof g.scoreFactor === 'number', g);
  eq('gate: catch-up turns pass', life.gateMessage({ id: 'MSG2', groupJid: DM }, { isDm: true, catchUp: {} }).outcome, 'now');

  section('deferred DM → drained at an owner phone check');
  const row = life.enqueueDeferred({ id: 'MSGDEF1', groupJid: DM, senderJid: DM }, { isDm: true }, { remoteJid: DM, id: 'MSGDEF1', fromMe: false });
  check('queued', !!row && row.status === 'pending' && pendingCount(DM) === 1);
  eq('idempotent', life.enqueueDeferred({ id: 'MSGDEF1', groupJid: DM }, { isDm: true }, { remoteJid: DM, id: 'MSGDEF1' })?.id, row.id);
  const checked = await life.checkPhoneNow({ by: 'owner' });
  eq('one catch-up turn', [checked.drained, turns.length], [1, 1]);
  eq('an awake check is not read only', checked.readOnly, false);
  check('… with ctx.catchUp and the last queued message', turns[0]?.ctx?.catchUp?.newCount === 1 && turns[0].msg.id === 'MSGDEF1');
  check('… read first (blue ticks)', sock.reads.some(keys => keys.some(k => k.id === 'MSGDEF1')));
  const checkEvs = eventsAfter(0, 5000).filter(e => e.type.startsWith('phone.check'));
  eq('owner check events', checkEvs.map(e => [e.type, e.actor]), [['phone.check.started', 'owner'], ['phone.check.ended', 'owner']]);
  eq('queue drained', pendingCount(DM), 0);

  section('hooks');
  eq('perceiveChat without a live decision does nothing', await life.perceiveChat({ groupJid: GROUP, content: 'movie tonight?' }, { chatJid: GROUP }), null);
  const n1 = lastEventId();
  const res = await life.onReplySent({ chatJid: GROUP, text: "I'm going to the gym tomorrow evening", msgId: 'R1' });
  check('a sent claim is flagged (mocked Jev)', !!res?.flagged && listClaims({ status: 'flagged' }).length === 1, res);
  const ptr = eventsAfter(n1, 10).find(e => e.type === 'claim.flagged');
  eq('… and leaves an inert pointer with the chat\'s origin', [ptr?.actor, ptr?.originKind, ptr?.originJid, ptr?.payload.claimId],
    ['chat', 'group', GROUP, res.flagged.id]);
  eq('… which changes nothing else in his life', eventsAfter(n1, 10).map(e => e.type), ['claim.flagged']);
  eq('a reply with no claim cue never reaches Jev', [(await life.onReplySent({ chatJid: GROUP, text: 'haha nice' }))?.skipped, claimsJev.calls.length], ['prefilter', 1]);
  // An imitated reply (another member's voice) and a DRY_RUN reply (sent to nobody) are no claims.
  const n2 = lastEventId();
  eq('an imitating reply → no claim (no Jev, row or pointer)', [await life.onReplySent({ chatJid: GROUP, text: "I'm going to the gym tomorrow at 6", msgId: 'R2', imitating: true }),
    claimsJev.calls.length, listClaims({}).length, lastEventId()], [null, 1, 1, n2]);
  eq('a DRY_RUN reply → no claim (no Jev, row or pointer)', [await life.onReplySent({ chatJid: GROUP, text: "I'm going to the gym tomorrow at 6", msgId: 'R3', dryRun: true }),
    claimsJev.calls.length, listClaims({}).length, lastEventId()], [null, 1, 1, n2]);
  check('dismissClaim', life.dismissClaim(res.flagged.id) === true && listClaims({ status: 'flagged' }).length === 0);

  section('owner revert + explain');
  const meal = eventsAfter(0, 5000).filter(e => e.type === 'meal').pop();
  const hungerBefore = life.getState().vitals.hunger;
  const rv = life.revertEvent(meal.id, { reason: 'test', by: 'owner' });
  check('revert appended', Number.isInteger(rv.revertEventId) && rv.already === false);
  check('the projection was rebuilt without the meal', life.getState().vitals.hunger > hungerBefore, { before: hungerBefore, after: life.getState().vitals.hunger });
  eq('reverting again returns the same revert', life.revertEvent(meal.id).revertEventId, rv.revertEventId);
  const chain = life.explain(meal.id).map(e => e.type);
  eq('explain(meal) ends in the activity that served it', chain.slice(-2), ['activity.started', 'meal']);

  section('timeline + map');
  const tl = life.timeline({ from: local(27, 0), to: local(27, 12) });
  check('planned blocks', tl.planned.length > 3 && tl.planned.every(b => b.end > b.start));
  check('actual spans', tl.actual.length > 3 && tl.actual.every(a => a.end >= a.start));
  check('cause links inside the window', tl.links.length > 0 && tl.links.every(l => l.from < l.to));
  const map = life.mapData();
  eq('map places', map.places.length, world.places.length);
  check('today\'s trip to the office', map.trips.some(t => t.to === 'place:office' && t.endAt > t.startAt));
  // ARRIVED is the logged arrival (the travel.arrived its start caused), not the plan.
  const arrivedEvs = eventsAfter(0, 5000).filter(e => e.type === 'travel.arrived');
  check('trips carry the actual arrival from the log', map.trips.some(t => Number.isFinite(t.arrivedAt))
    && map.trips.filter(t => Number.isFinite(t.arrivedAt)).every(t => arrivedEvs.some(a => a.at === t.arrivedAt
      && (a.causeId === t.eventId || a.causeId == null) && a.at >= t.startAt)));
  check('a position', Number.isFinite(map.position.lat) && Number.isFinite(map.position.lon));

  section('restart → same state');
  const before = JSON.stringify(serializeState(life.getState()));
  const idsBefore = lastEventId();
  await life.stopLife();
  eq('stopped', [life.isLifeOn(), life.getState()], [false, null]);
  check('a snapshot was saved on stop', db.prepare('SELECT COUNT(*) AS n FROM world_snapshots').get().n > 0);
  await life.startLife(opts);
  eq('no new events on a restart at the same time', lastEventId(), idsBefore);
  eq('the same state after restart (snapshot + replay)', JSON.stringify(serializeState(life.getState())), before);
  await advance(1);
  check('and it keeps ticking', lastEventId() >= idsBefore);

  section('switched off at runtime');
  life.enqueueDeferred({ id: 'MSGDEF2', groupJid: DM, senderJid: DM }, { isDm: true }, { remoteJid: DM, id: 'MSGDEF2' });
  enabled = false;
  sock.reset();
  clock.advance({ minutes: 15 });
  await life.tick();
  eq('the next tick drains what was queued once', [turns.length, pendingCount(DM)], [2, 0]);
  check('… and presence goes back to available', sock.presence.some(p => p.type === 'available'));
  eq('isLifeOn false; the gate passes everything', [life.isLifeOn(), life.gateMessage({ id: 'X' }, { isDm: true }).outcome], [false, 'now']);
  eq('hooks are inert while off', await life.onReplySent({ chatJid: GROUP, text: "I'm going home" }), null);
  await life.stopLife();

  section('off at boot');
  await setupScratchDb();
  enabled = false;
  await life.startLife(opts);
  eq('nothing seeded, nothing started', [life.getState(), lastEventId()], [null, 0]);
  await life.stopLife();

  section('paged event reads (eventsBetween)');
  {
    const { db: db2 } = await setupScratchDb();
    const T = local(27, 9);
    db2.transaction(() => {
      appendEvent({ type: 'meal', at: T - 60, actor: 'engine' });
      for (let i = 0; i < 1201; i++) appendEvent({ type: 'meal', at: T, actor: 'engine' });   // > 2 pages in one second
      appendEvent({ type: 'meal', at: T + 60, actor: 'engine' });
    })();
    const all = life.__eventsBetweenForTest(T - 3600, T + 3600, ['meal']);
    eq('a run of > 1 page at one second is read whole, then past it', [all.length, all[0].at, all.at(-1).at], [1203, T - 60, T + 60]);
    eq('the windowed read stops quietly at its page guard', life.__eventsBetweenForTest(T - 3600, T + 3600, ['meal'], { maxPages: 2 }).length, 501);
    let threw = null;
    try { life.__eventsBetweenForTest(T - 3600, T + 3600, ['meal'], { maxPages: 2, strict: true }); } catch (err) { threw = err; }
    check('a strict read (public view) throws at its page guard instead of truncating', !!threw);
    eq('…with code history_too_large (the public exporter\'s status)', threw?.code, 'history_too_large');
  }

  check('no network calls', fetches === 0, fetches);
} catch (err) {
  check('test body threw', false, err?.stack || String(err));
}
report();
