// T034 — privacy of life content in prompts (spec 009 FR-029, plan §R13) with
// 006's REAL audience rule: recall.resolveAudience builds every audience and
// recall.canUseIn decides (wired into innerState through setCanUseIn), on a
// scratch DB with real people, identities and group memberships.
//
// The pipeline path, through the facade only: a DM and a group message nudge
// two open decisions via perceiveChat(msg, audience) — as src/index.js does
// with the turn's resolveAudience({chatJid}) — and the inner-state line / cast
// cards / reply prompt (buildConversationContext with the `life` opt, as
// contextBuilder passes it) are read for many audiences:
//   - a DM-origin lean appears only in that DM (either of the person's jids),
//     never in another DM, a group the person is in, or a subset group;
//   - a group-origin lean follows the subset rule: its own group, a group whose
//     members are all members of it who joined before the lean, those members'
//     DMs; not with an outsider, a late joiner, an unknown person, or stale
//     membership;
//   - the dashboard audience sees everything; the same-chat fallback (what runs
//     until canUseIn is wired in production) is never looser than 006;
//   - perceiveChat refuses strangers, non-members and his own messages.
// Also: the example world never goes live (boot refused, nothing seeded, gate
// passes everything), and with life off the prompt and the gate are unchanged.
// Fake clock pinned to a fixed evening (Wed 28 Oct 2026, 21:30 in the world's
// zone): no cast is with him and no meeting is due, so every card below comes
// from a decision — at the wall clock he could be at lunch with Coworker A and
// her card would show everywhere (a self fact). 006 freshness still reads the
// wall clock (memberships are marked synced now). Mocked Jev; no network, no LLM.
import { setupScratchDb, fakeClock, fakeJev, fakeSock, jevChoice, section, check, eq, report } from './_helpers.js';
import { setClock, atLocal } from '../../src/life/clock.js';
import { appendEvent, eventsAfter, lastEventId } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { setCanUseIn } from '../../src/life/innerState.js';
import { createInitialState } from '../../src/life/projector.js';
import { setJev as setDecisionJev, resetDecisionCounters } from '../../src/life/decisions.js';
import { setJev as setClaimsJev } from '../../src/life/claims.js';
import * as life from '../../src/life/index.js';

const { db } = await setupScratchDb();
const { resolveAudience, canUseIn } = await import('../../src/memory/recall.js');
const membership = await import('../../src/memory/membership.js');
const groupStore = await import('../../src/memory/groupStore.js');
const identity = await import('../../src/memory/identity.js');
const { setSelfIdentity } = await import('../../src/utils/selfIdentity.js');
const { buildConversationContext } = await import('../../src/personality/systemPrompt.js');

let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is off in life tests'); };

const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const T = atLocal(Date.UTC(2026, 9, 28, 12, 0) / 1000, '21:30', createInitialState(world).world.timezone);
const clock = fakeClock(T);
setClock(clock.fn);
const DAY = 86400;

const decisionJev = fakeJev(() => ({ pick: jevChoice('go', { go: 0.75, skip: 0.25 }) }));
setDecisionJev(decisionJev.fn);
setClaimsJev(fakeJev(() => ({ kind: jevChoice('none', { none: 1 }) })).fn);

// ── People, identities, groups ────────────────────────────────────────────
setSelfIdentity({ id: '155500000999:3@s.whatsapp.net', lid: '99999@lid' });
const ALICE = '111@lid';
const ALICE_PN = '155500000111@s.whatsapp.net';
const BOB = '222@lid';
const CAROL = '333@lid';
const DAVE = '444@lid';
const EVE = '555@lid';
const X = '120363000000000101@g.us';   // Alice, Bob (long ago), Dave (joins after the lean)
const Y = '120363000000000102@g.us';   // Alice only — a subset of X
const Z = '120363000000000103@g.us';   // Alice + Carol (Carol is not in X)
const W = '120363000000000104@g.us';   // Alice + Dave (Dave is a late joiner of X)
for (const [jid, name] of [[X, 'X'], [Y, 'Y'], [Z, 'Z'], [W, 'W']]) {
  db.prepare('INSERT INTO groups (jid, name, joined_at) VALUES (?, ?, ?)').run(jid, name, T - 60 * DAY);
}
for (const [jid, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol'], [DAVE, 'Dave'], [EVE, 'Eve']]) {
  db.prepare('INSERT INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)').run(jid, name, T - 60 * DAY);
  db.prepare(`INSERT INTO person_identities (jid, person_jid, kind, source, seen_at) VALUES (?, ?, 'lid', 'sync', ?)`).run(jid, jid, T - 60 * DAY);
}
identity.recordIdentity(ALICE_PN, ALICE, 'sync');
for (const [g, p, j] of [
  [X, ALICE, T - 30 * DAY], [X, BOB, T - 30 * DAY], [X, DAVE, T + 600],
  [Y, ALICE, T - 30 * DAY], [Z, ALICE, T - 30 * DAY], [Z, CAROL, T - 30 * DAY],
  [W, ALICE, T - 30 * DAY], [W, DAVE, T - 30 * DAY],
]) groupStore.upsertMember(g, p, 'member', j);
const markFresh = () => { for (const g of [X, Y, Z, W]) membership.__markSyncedForTest(g); };
markFresh();

const aud = (chatJid) => resolveAudience({ chatJid });
const dash = { kind: 'dashboard' };
const sock = fakeSock();
const D1_LABEL = 'catch the late show';
const D2_LABEL = 'hit the gym after work';
const lineFor = (chatJid) => life.innerStateLine(chatJid === 'dashboard' ? dash : aud(chatJid));
const baseOpts = {
  timers: false, isEnabled: () => true, seed: 21, getSock: () => sock,
  processMessage: async () => {}, isGroupMuted: () => false, sleep: async () => {},
};

try {
  section('the example world never goes live');
  await life.startLife({ ...baseOpts, ensureWorld: async () => world });
  eq('ensureWorld → example: not running', [life.isLifeOn(), life.getState()], [false, null]);
  eq('… an alert reason for the dashboard', life.lifeStartIssue()?.reason, 'example_world');
  eq('… and nothing seeded (no genesis in the append-only log)', lastEventId(), 0);
  eq('… the gate passes everything', life.gateMessage({ id: 'm', groupJid: X }, { isGroup: true }).outcome, 'now');
  await life.startLife({ ...baseOpts, world, allowExampleWorld: false });
  eq('an explicit example world with allowExampleWorld:false → refused too', [life.isLifeOn(), lastEventId()], [false, 0]);
  await life.stopLife();
  eq('stopLife clears the issue', life.lifeStartIssue(), null);

  section('life off: prompt and gate unchanged');
  const trig = { id: 'T-1', groupJid: X, senderJid: BOB, senderName: 'Bob', content: 'gym later?', messageType: 'text' };
  const plain = buildConversationContext(X, trig, true, { audience: aud(X) }).text;
  const withLife = buildConversationContext(X, trig, true, { audience: aud(X), life: { sneak: false, availability: 'free', catchUp: null } }).text;
  eq('life opt with the engine stopped → identical prompt', withLife, plain);
  eq('facade lines are empty', [life.innerStateLine(aud(X)), life.castCards(aud(X), '', 3), life.timeLine()], ['', [], '']);
  eq('gate: now / life_off', life.gateMessage(trig, { isGroup: true }).reason, 'life_off');

  section('setup: two open decisions, then the real 006 rule');
  await life.startLife({ ...baseOpts, world });              // a caller-chosen world (tests, dry run) is allowed
  check('running on the passed world', life.isLifeOn() && life.lifeStartIssue() === null);
  await life.stopLife();
  const open = (kind, label, placeId, castId, inMin) => appendEvent({
    type: 'decision.opened', at: clock.now(), actor: 'engine', payload: {
      kind, subject: { eventAt: clock.now() + (inMin + 60) * 60, placeId, castIds: [castId] },
      decideBy: clock.now() + inMin * 60, ponrAt: clock.now() + (inMin + 30) * 60,
      options: [{ id: 'go', label, cost: { travelMin: 20, social: 1 } }, { id: 'skip', label: 'stay in' }],
    },
  });
  const d1 = open('movie', D1_LABEL, 'place:cinema', 'cast:flatmate', 20);
  const d2 = open('gym', D2_LABEL, 'place:gym', 'cast:coworker-a', 25);
  await life.startLife({ ...baseOpts, world });
  check('both decisions open in the projection', life.getState().decisions.get(d1.id)?.status === 'open'
    && life.getState().decisions.get(d2.id)?.status === 'open');
  const nowSt = life.getState();
  check('precondition: nobody with him and no meeting due (cards come from decisions only)',
    !(nowSt.activity?.withCast || []).length
    && !(nowSt.plan?.blocks || []).some(b => b.kind === 'meeting' && b.start > clock.now() && b.start - clock.now() <= 3 * 3600),
    nowSt.activity);
  setCanUseIn(canUseIn);

  // The pipeline's calls: perceiveChat(msg, context.audience) with resolveAudience({chatJid}).
  const before = lastEventId();
  await life.perceiveChat({ id: 'P-1', groupJid: ALICE, senderJid: ALICE, content: 'coming to the movie tonight?' }, aud(ALICE));
  await life.perceiveChat({ id: 'P-2', groupJid: X, senderJid: BOB, content: 'gym later? you in?' }, aud(X));
  const fresh = eventsAfter(before, 100);
  const trigs = fresh.filter(e => e.type === 'chat.trigger');
  eq('two chat triggers with their chat origins', trigs.map(e => [e.payload.decisionId, e.originKind, e.originJid]),
    [[d1.id, 'dm', ALICE], [d2.id, 'group', X]]);
  const leans = fresh.filter(e => e.type === 'decision.lean');
  eq('the leans inherit them', leans.map(e => [e.payload.decisionId, e.originKind, e.originJid]),
    [[d1.id, 'dm', ALICE], [d2.id, 'group', X]]);
  eq('decision origins accumulate in the projection',
    [life.getState().decisions.get(d1.id).origins, life.getState().decisions.get(d2.id).origins],
    [[{ kind: 'dm', jid: ALICE }], [{ kind: 'group', jid: X }]]);

  section('DM-origin lean: only in that DM');
  check('Alice\'s DM (LID chat) sees it', lineFor(ALICE).includes(D1_LABEL), lineFor(ALICE));
  check('… and under her phone-number jid (same person)', lineFor(ALICE_PN).includes(D1_LABEL), lineFor(ALICE_PN));
  for (const [name, chat] of [['Bob\'s DM', BOB], ['group X (Alice is in it)', X], ['group Y (Alice only)', Y], ['group Z', Z], ['Eve\'s DM', EVE]]) {
    check(`${name}: not visible`, !lineFor(chat).includes(D1_LABEL), lineFor(chat));
  }
  check('cast card for the DM decision (flatmate) only in that DM',
    life.castCards(aud(ALICE), '', 3).some(c => c.startsWith('Flatmate'))
    && [X, Y, BOB].every(c => !life.castCards(aud(c), '', 3).some(x => x.startsWith('Flatmate'))));

  section('group-origin lean: the subset rule');
  check('group X itself', lineFor(X).includes(D2_LABEL), lineFor(X));
  check('group Y (members ⊆ X, joined before the lean)', lineFor(Y).includes(D2_LABEL), lineFor(Y));
  check('Bob\'s DM (an X member since before)', lineFor(BOB).includes(D2_LABEL), lineFor(BOB));
  check('group Z (Carol is an outsider to X): hidden', !lineFor(Z).includes(D2_LABEL), lineFor(Z));
  check('group W (Dave joined X after the lean): hidden', !lineFor(W).includes(D2_LABEL), lineFor(W));
  check('Eve\'s DM (in no group): hidden', !lineFor(EVE).includes(D2_LABEL), lineFor(EVE));
  check('a stranger\'s DM: hidden', !lineFor('155500000000@s.whatsapp.net').includes(D2_LABEL));
  check('cast card for the group decision (Coworker A): X yes, Z no',
    life.castCards(aud(X), '', 3).some(c => c.includes('Coworker A'))
    && !life.castCards(aud(Z), '', 3).some(c => c.includes('Coworker A')));

  section('stale membership closes the subset path');
  membership.__resetMembershipForTest();
  check('Y no longer sees X\'s lean', !lineFor(Y).includes(D2_LABEL), lineFor(Y));
  check('… nor Bob\'s DM', !lineFor(BOB).includes(D2_LABEL), lineFor(BOB));
  check('X still sees its own', lineFor(X).includes(D2_LABEL), lineFor(X));
  markFresh();
  check('fresh again → Y sees it', lineFor(Y).includes(D2_LABEL));

  section('dashboard sees all');
  const st = life.getState();
  check('dashboard line shows the soonest lean (the DM one)', lineFor('dashboard').includes(D1_LABEL), lineFor('dashboard'));
  check('dashboard cards include both decisions\' cast', (() => {
    const cards = life.castCards(dash, '', 3);
    return cards.some(c => c.startsWith('Flatmate')) && cards.some(c => c.includes('Coworker A'));
  })(), life.castCards(dash, '', 3));
  check('the dashboard state carries both origins', st.decisions.get(d1.id).origins.length === 1 && st.decisions.get(d2.id).origins.length === 1);

  section('the reply prompt (systemPrompt via the turn\'s audience)');
  const lifeOpt = { sneak: false, availability: 'free', catchUp: null };
  const pX = buildConversationContext(X, trig, true, { audience: aud(X), life: lifeOpt }).text;
  const pDm = buildConversationContext(ALICE, { ...trig, groupJid: ALICE, senderJid: ALICE }, false, { audience: aud(ALICE), life: lifeOpt }).text;
  const pZ = buildConversationContext(Z, { ...trig, groupJid: Z }, true, { audience: aud(Z), life: lifeOpt }).text;
  check('X\'s prompt has its own lean, not the DM one', pX.includes(D2_LABEL) && !pX.includes(D1_LABEL));
  check('Alice\'s DM prompt has the DM lean', pDm.includes(D1_LABEL));
  check('Z\'s prompt has neither', !pZ.includes(D1_LABEL) && !pZ.includes(D2_LABEL));
  check('no life opt (dashboard force-respond) → no life lines',
    !buildConversationContext(X, trig, true, { audience: aud(X) }).text.includes(D2_LABEL));

  section('the same-chat fallback is never looser');
  setCanUseIn(null);
  check('fallback: X sees its own, Alice\'s DM its own', lineFor(X).includes(D2_LABEL) && lineFor(ALICE).includes(D1_LABEL));
  check('fallback: nothing crosses chats (Y, Bob\'s DM, X↛DM lean)',
    !lineFor(Y).includes(D2_LABEL) && !lineFor(BOB).includes(D2_LABEL) && !lineFor(X).includes(D1_LABEL));
  setCanUseIn(canUseIn);

  section('perceiveChat refuses who may not nudge');
  const n0 = lastEventId();
  resetDecisionCounters();
  clock.advance({ minutes: 10 });                             // past the per-decision chat cooldown
  await life.perceiveChat({ id: 'P-3', groupJid: '155500000000@s.whatsapp.net', senderJid: '155500000000@s.whatsapp.net', content: 'skip the movie' }, aud('155500000000@s.whatsapp.net'));
  await life.perceiveChat({ id: 'P-4', groupJid: X, senderJid: CAROL, content: 'skip the gym' }, aud(X));
  await life.perceiveChat({ id: 'P-5', groupJid: X, senderJid: ALICE, isFromSelf: true, content: 'skip the gym' }, aud(X));
  eq('a stranger DM, a non-member in X and his own message: no world events', lastEventId(), n0);
  await life.perceiveChat({ id: 'P-6', groupJid: X, senderJid: ALICE, content: 'skip the gym' }, aud(X));
  check('control: a member of X still nudges (so the refusals above are real)',
    eventsAfter(n0, 10).some(e => e.type === 'chat.trigger' && e.originJid === X), eventsAfter(n0, 10).map(e => e.type));

  section('life switched off: lines go, prompt back to plain');
  await life.stopLife();
  await life.startLife({ ...baseOpts, world, isEnabled: () => false });
  eq('isLifeOn false', life.isLifeOn(), false);
  eq('prompt with the life opt equals the plain prompt again',
    buildConversationContext(X, trig, true, { audience: aud(X), life: lifeOpt }).text,
    buildConversationContext(X, trig, true, { audience: aud(X) }).text);
  eq('zero network calls', fetches, 0);
} finally {
  await life.stopLife();
  setCanUseIn(null);
  setDecisionJev(null);
  setClaimsJev(null);
  setClock(null);
}
report();
