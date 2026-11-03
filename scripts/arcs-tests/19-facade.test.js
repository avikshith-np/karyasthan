// 010 T023/T024 — the story facade (src/life/story/index.js) wired into the life
// facade (src/life/index.js), contracts/story-api.md §1, §3.7, research R5, R22:
//   - registerHooks() runs in startLife() with the life skill OFF; a forget then still
//     withdraws a DM review and fences its journal part (DB-only, never booted);
//   - attach() on boot (pulse in place), pending withdrawals applied before the first
//     step; detach() on stop;
//   - every seam (canUseIn, block cause, plan cause, story fragment, cast overlay,
//     decision filter, storyItems) gives 009's default once `arcs` is flipped off at
//     runtime, and the story result when it is back on; worldOf / heavyGuardActive
//     stay state-derived (not skill-gated);
//   - with `arcs` off: no items, no reconciler enqueue, Director refused, reads `off`;
//     with life stopped: the same;
//   - onReplySent → onClaimFlagged; purgePerson → onRedacted; storyWeeklyPass;
//   - afterTick only enqueues: < 50 ms with a 5 s fake clerk pending.
// Scratch DB, fake clock, fake Jev and models, no network. Invented names.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, setSkills, fakeCallRole, fakeJevFixed,
  fakeClock, exampleWorld, seedPeople, blockNetwork, HOUR,
} from './_helpers.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { isExcludedId } from '../../src/life/projector.js';
import { dateKey } from '../../src/life/clock.js';
import { rngFor as rngForDefault } from '../../src/life/rng.js';
import { getDb } from '../../src/memory/db.js';
import * as innerState from '../../src/life/innerState.js';
import * as store from '../../src/life/story/store.js';
import * as hooks from '../../src/life/story/hooks.js';

const net = blockNetwork();
await setupScratchDb();
const world = await exampleWorld();
const story = await import('../../src/life/story/index.js');
const life = await import('../../src/life/index.js');
const DM = '15550001919@s.whatsapp.net';
const GX = '120363000000019001@g.us';
const GY = '120363000000019002@g.us';
await seedPeople([{ jid: DM, name: 'Avery Lindqvist' }]);

const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e?.code ?? 'error'; } };

function dmClaim(at, { status = 'tray', text = 'see you at the cafe later' } = {}) {
  const id = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, ?, ?, 'commitment', 0.9, 'flagged', ?)`).run(DM, DM, `R-${at}-${Math.random()}`, text, at).lastInsertRowid);
  const rid = store.createReview({ claimId: id, chatJid: DM, originKind: 'dm', originJid: DM, createdAt: at, status }).id;
  return { id, rid };
}

// ── 1. life skill off: hooks registered, a forget still reaches the story tables ──
section('startLife with the life skill off: hooks registered, nothing attached');
{
  await setSkills({ life: false, arcs: true });
  const clock = fakeClock(Math.floor(Date.now() / 1000));
  const { setClock } = await import('../../src/life/clock.js');
  setClock(clock.fn);
  await life.startLife({ world, timers: false, isEnabled: () => false });
  check('hooks registered', hooks.hooksRegistered());
  eq('nothing attached, story off', [story.isAttached(), story.storyOn()], [false, false]);
  eq('reads answer off', [story.status().enabled, story.cards().length, story.castList().length], [false, 0, 0]);
  eq('Director refused (not running)', await codeOf(story.director.preview({ kind: 'quick', button: 'tired' })), 'not_running');
  eq('storyWeeklyPass is a no-op', (await life.storyWeeklyPass({ budgetOk: { ok: true } })).reason, 'disabled');

  const now = clock.now();
  const c = dmClaim(now - 60);
  const nk = dateKey(now - 12 * HOUR, world.timezone);
  store.putPart({ nightKey: nk, originKind: 'dm', originJid: DM, text: 'A coffee plan came up.', sources: { events: [], claims: [c.id] } });
  getDb().prepare(`INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, message_type, is_from_self, timestamp, metadata_json)
    VALUES ('F19-1', ?, ?, NULL, 'cafe later?', 'text', 0, ?, '{}')`).run(DM, DM, Math.floor(Date.now() / 1000) - 30);
  const { forgetRecent } = await import('../../src/memory/relationshipStore.js');
  const res = forgetRecent(DM, DM);
  eq('the forget fenced the DM line', res.fenced, 1);
  eq('the review is withdrawn (life never booted)', store.getReview(c.rid)?.status, 'withdrawn');
  eq('its journal part is fenced', store.listParts(nk).find(p => p.originJid === DM)?.status, 'fenced');
  await life.stopLife();
}

// ── 2. boot with arcs on: attach, then pending withdrawals before the first step ──
section('boot: attach + pending withdrawals applied before the first step');
let clock;
let adoptedId;
{
  const b = await bootLife({ jev: fakeJevFixed({ kind: { commitment: 0.9, claim: 0.05, none: 0.05 } }) });
  clock = b.clock;
  eq('attached and on', [story.isAttached(), story.storyOn()], [true, true]);
  await simulateHours(2);
  const at = clock.now();
  const c = dmClaim(at, { status: 'tray' });
  const flagged = appendEvent({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: DM, payload: { claimId: c.id, kind: 'commitment' } });
  const adopted = appendEvent({ type: 'claim.adopted', at, actor: 'engine', causeId: flagged.id, payload: { claimId: c.id, reviewId: c.rid, as: 'activity', ref: null } });
  adoptedId = adopted.id;
  store.updateReview(c.rid, { status: 'adopted', claimEventId: flagged.id, adoptedEventId: adopted.id });
  await life.stopLife();
  eq('detached on stop', story.isAttached(), false);
  store.withdrawReviews([c.id], { by: 'forget' });   // the DB-only half, as a hook would with life stopped
  await bootLife({ clock: fakeClock(clock.now()), jev: fakeJevFixed({ kind: { commitment: 0.9, claim: 0.05, none: 0.05 } }) });
  check('the adoption is out of the projection right after boot', isExcludedId(life.getState(), adoptedId));
  check('…through a claim.withdrawn + revert', !!getDb().prepare("SELECT 1 FROM world_events WHERE type = 'claim.withdrawn'").get());
}

// ── 3. runtime flip ──────────────────────────────────────────────────────────
section('seams: arcs flipped off at runtime → 009 defaults; back on → story');
{
  const s = life.getState();
  const plan = { eventId: 50, basePlanEventId: 40 };
  const heavyState = { ...s, story: { ...s.story, heavy: { ...s.story.heavy, active: { id: adoptedId, kind: 'pet_loss', until: s.at - 1 } } } };
  const guardState = { ...s, story: { ...s.story, heavy: { ...s.story.heavy, active: { id: adoptedId, kind: 'pet_loss', until: s.at + 5 * 86400 } } } };
  const careerState = { ...s, story: { ...s.story, career: { ...s.story.career, eventId: 99, title: 'Lead tester', officePlaceId: s.self?.officePlaceId ?? null } } };
  const arcDecision = { id: 1, category: 'romance' };
  const socialDecision = { id: 2, category: 'social' };
  story.__setDepsForTest({ canUseIn: () => true });

  const probe = () => ({
    block: story.blockCause(plan, { fromAmendment: false }),
    amended: story.blockCause(plan, { fromAmendment: true }),
    planCause: story.planCause(plan),
    items: story.items(heavyState, s.at + HOUR).map(i => i.label),
    keptArc: story.decisionKept(arcDecision),
    keptSocial: story.decisionKept(socialDecision),
    overlay: story.castOverlay(s, 'cast:flatmate', s.cast.get('cast:flatmate')),
    fragmentGroup: story.promptFragment(guardState, { kind: 'group', chatJid: GX }),
    crossChat: innerState.factAllowed({ originJid: GX, learnedAt: 1 }, { kind: 'group', chatJid: GY }),
    onClaim: story.onClaimFlagged({ claim: { id: 999999, chatJid: DM, originKind: 'dm', originJid: DM }, eventId: null }),
    world: story.worldOf(careerState, world) !== world,
    guard: story.heavyGuardActive(guardState, s.at),
  });
  const on = probe();
  eq('on: blocks of the base plan', [on.block, on.amended, on.planCause], [40, 50, 40]);
  check('on: the heavy end item is offered', on.items.includes('heavy:end'), on.items);
  eq('on: arc decisions filtered, social kept', [on.keptArc, on.keptSocial], [false, true]);
  check('on: the 006 rule (stubbed) is used', on.crossChat === true);
  eq('on: no heavy fragment for a group', on.fragmentGroup, '');
  check('on: state-derived overlay and guard', on.world && on.guard);
  store.deleteReviewsByClaims([999999]);

  await setSkills({ arcs: false });
  const off = probe();
  eq('off: storyOn false', story.storyOn(), false);
  eq('off: every block and plan cause is the plan itself', [off.block, off.amended, off.planCause], [50, 50, 50]);
  eq('off: no story items', off.items, []);
  eq('off: decision filter drops story-owned decisions (any category)', [off.keptArc, off.keptSocial], [false, false]);
  check('off: a 009 decision (no category) is kept', story.decisionKept({ id: 3 }) === true);
  eq('off: no cast overlay', off.overlay, {});
  eq('off: same-chat fallback', off.crossChat, false);
  eq('off: no reconciler enqueue', off.onClaim, null);
  check('off: overlay and guard stay (state-derived)', off.world && off.guard);
  eq('off: Director refused', await codeOf(story.director.preview({ kind: 'quick', button: 'tired' })), 'not_running');
  eq('off: reads answer off', [story.status().enabled, story.cards().length], [false, 0]);
  eq('off: storyWeeklyPass disabled', (await life.storyWeeklyPass({ budgetOk: { ok: true } })).reason, 'disabled');
  // Review regression: a forget/revoke withdrawal must reach the world with arcs off.
  {
    const at = clock.now();
    const c = dmClaim(at, { status: 'tray' });
    const flagged = appendEvent({ type: 'claim.flagged', at, actor: 'chat', originKind: 'dm', originJid: DM, payload: { claimId: c.id, kind: 'commitment' } });
    const ad = appendEvent({ type: 'claim.adopted', at, actor: 'engine', causeId: flagged.id, payload: { claimId: c.id, reviewId: c.rid, as: 'activity', ref: null } });
    store.updateReview(c.rid, { status: 'adopted', claimEventId: flagged.id, adoptedEventId: ad.id });
    store.withdrawReviews([c.id], { by: 'forget' });   // the hook's DB-only half
    await story.afterTick(life.getState(), { at: clock.now() });
    await story.idle();
    check('off: a pending withdrawal is applied at the next tick', isExcludedId(life.getState(), ad.id));
  }

  await setSkills({ arcs: true });
  const back = probe();
  eq('back on: base-plan causes again', [back.block, back.planCause], [40, 40]);
  store.deleteReviewsByClaims([999999]);
  story.__setDepsForTest({ canUseIn: null });
}

// ── 4. onReplySent → onClaimFlagged; storyWeeklyPass; purge → onRedacted ───
section('onReplySent → claim.flagged → a pending review');
{
  const before = store.countReviews({});
  const res = await life.onReplySent({ chatJid: DM, text: "I'll be at the gym tomorrow at 10, see you there", msgId: 'R19-1' });
  check('the reply was flagged', !!res?.flagged, res);
  eq('…and queued for the reconciler', store.countReviews({}), before + 1);
  const r = store.getReviewByClaim(res.flagged.id);
  check('the review points at the claim.flagged event', getEvent(r?.claimEventId)?.type === 'claim.flagged');
}

section('storyWeeklyPass from a fake 008 sleep');
{
  const r = await life.storyWeeklyPass({ nightKey: '2026-10-27', trigger: 'night', budgetOk: { ok: false, reason: 'budget' } });
  eq('gated by the budget object', [r.status, r.reason], ['skipped', 'budget']);
  const r2 = await life.storyWeeklyPass({ nightKey: '2026-10-27', trigger: 'night', budgetOk: true });
  eq('a bare true is not enough', [r2.status, r2.reason], ['skipped', 'budget']);
}

section('purgePerson → onRedacted (through the life facade)');
{
  const c = dmClaim(clock.now());
  check('fixture', !!store.getReview(c.rid));
  const { purgePerson } = await import('../../src/memory/relationshipStore.js');
  purgePerson(DM, 'test', 'tester');
  eq('their DM reviews are gone', store.listReviews({ originJid: DM, limit: 50 }).length, 0);
  check('the projection was rebuilt and still runs', life.getState()?.genesisAt != null);
}

// ── 4b. all-or-nothing story items ─────────────────────────────────────────
section('a story item that fails half-way is undone (reverted + rebuilt), then retired');
{
  // Every status roll says yes, so the daily pass writes beats before its marker.
  const zero = () => { const r = () => 0; r.int = (a) => a; r.float = (a) => a; return r; };
  story.__setDepsForTest({ rng: (date, purpose) => (String(purpose).startsWith('story:status:') ? zero() : rngForDefault(date, purpose)) });
  // The second boot runs on its own fake clock: drive a fresh one from the same instant, hand time back after.
  const { setClock } = await import('../../src/life/clock.js');
  const c = fakeClock(clock.now());
  setClock(c.fn);
  // Tick with `arcs` off (the pulse gets no story items) until tomorrow's daily item is due, then run it here.
  let item = null;
  for (let i = 0; i < 4 * 36 && !item; i++) {
    c.advance({ minutes: 15 });
    await setSkills({ arcs: false });
    await life.tick();
    await setSkills({ arcs: true });
    item = story.items(life.getState(), c.now()).find(it => it.label === 'daily') ?? null;
  }
  check('a daily item came due', !!item);
  const date = item?.id;
  const written = [];
  const dying = (spec) => {
    if (spec.type === 'story.daily_done') throw new Error('disk full');
    const e = appendEvent(spec);
    written.push(e);
    return e;
  };
  await item?.run(dying);                                 // the facade wrapper catches, undoes and retires
  const st = life.getState();
  check('the pass wrote events before its marker failed', written.length >= 1, written.map(e => e.type));
  check('every one of them is out of the (rebuilt) projection', written.length > 0 && written.every(e => isExcludedId(st, e.id)),
    written.filter(e => !isExcludedId(st, e.id)).map(e => e.type));
  const reverts = getDb().prepare("SELECT COUNT(*) AS n FROM world_events WHERE type = 'event.reverted' AND id > ?").get(written[0]?.id ?? 0).n;
  check('…through event.reverted rows', reverts >= 1, reverts);
  check('no marker for that date', st.story?.daily?.lastDate !== date, [st.story?.daily?.lastDate, date]);
  eq('the item is retired (not offered again in this process)', story.items(st, c.now()).filter(it => it.label === 'daily' && it.id === date).length, 0);
  await life.tick();
  eq('…and the pulse does not run it either', getDb().prepare("SELECT COUNT(*) AS n FROM world_events WHERE type = 'story.daily_done' AND json_extract(payload_json, '$.date') = ?").get(date).n, 0);
  story.__setDepsForTest({ rng: undefined });
  clock.advance({ minutes: (c.now() - clock.now()) / 60 });
  setClock(clock.fn);
}

// ── 5. afterTick only enqueues ─────────────────────────────────────────────
section('afterTick: enqueue only (a 5 s clerk is pending)');
{
  const slow = fakeCallRole({ 'life.claim.extract': () => new Promise((r) => { const t = setTimeout(() => r(null), 5000); t.unref?.(); }) });
  story.__setDepsForTest({ callRole: slow.fn });
  await seedPeople([{ jid: '15550001920@s.whatsapp.net', name: 'Blake Ostrander' }]);
  const dm2 = '15550001920@s.whatsapp.net';
  const id = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
    VALUES (?, 'dm', ?, 'R19-2', 'gym at 10', 'commitment', 0.9, 'flagged', ?)`).run(dm2, dm2, clock.now()).lastInsertRowid);
  const ptr = appendEvent({ type: 'claim.flagged', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: dm2, payload: { claimId: id, kind: 'commitment' } });
  story.onClaimFlagged({ claim: { id, chatJid: dm2, originKind: 'dm', originJid: dm2, createdAt: clock.now() }, eventId: ptr.id });
  await new Promise(r => setTimeout(r, 20));
  const view = life.getState();
  let worst = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await story.afterTick(view, { at: clock.now() + i * 60 });
    worst = Math.max(worst, performance.now() - t0);
  }
  check('afterTick returns in < 50 ms', worst < 50, `${worst.toFixed(1)} ms`);
  check('the clerk call is under way off the tick chain', slow.callsFor('life.claim.extract').length >= 1);
  await stopLife();
}

eq('no network', net.count, 0);
report();
process.exit(process.exitCode ?? 0);
