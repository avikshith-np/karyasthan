// 020 §A2/§A3, final review 11, 12, 13, 14: a chat's plan stays a chat's and a chat's line can be taken
// back. An owner's pick on a chat-made plan: the activity row itself keeps the chat's origin (the site's
// `out` row, no journal bullet, a narration-only scene, a minimal live session), as with no pick. A real
// revoke or forget (not a direct revert) takes back a nudge's chat.trigger, its lean and the commit; a purge
// redacts a DM-nudged commit too. Intentions resting on a revoked line leave the mind's self-state, so their
// thoughts don't come back. A date far from now reads as bad_date. Example world, fake clock, stubbed models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, fakeCallRole, fakeJev, jevChoice,
  seedPeople, seedGroups, setBot, HOUR,
} from './_helpers.js';
import { appendEvent, listEvents, getEvent } from '../../src/life/eventLog.js';
import { resolveTimezone, zonedToUnix, localParts } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { selfFacts } from '../../src/life/story/journal.js';
import { sessionOf } from '../../src/life/story/scenes/detect.js';
import { resolveAudience } from '../../src/memory/recall.js';
import * as relStore from '../../src/memory/relationshipStore.js';
import { storeMessage } from '../../src/memory/messageStore.js';
import * as mindStore from '../../src/mind/store.js';
import { openIntentions } from '../../src/mind/index.js';
import * as mindHooks from '../../src/mind/hooks.js';
import { config } from '../../src/utils/config.js';

const { db } = await setupScratchDb();
config.arcs.scenesEnabled = false;
config.arcs.phoneOrganicPerDay = 0;
let probs = null;
const jev = fakeJev((req) => {
  const q = req?.questions?.pick;
  if (!q || !probs) return {};
  const ids = Object.keys(q.criteria || {});
  const p = Object.fromEntries(ids.filter(id => id in probs).map(id => [id, probs[id]]));
  const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? { pick: jevChoice(best, p) } : {};
});
const cr = fakeCallRole({});
await setBot();
const [FRIEND, DM_FRIEND] = await seedPeople([{ jid: '7301@lid', name: 'Avery', pn: '15550007301@s.whatsapp.net' }, { jid: '7302@lid', name: 'Blake', pn: '15550007302@s.whatsapp.net' }], { at: Date.UTC(2026, 6, 1) / 1000 });
const [GROUP] = await seedGroups([{ jid: '120363000000880001@g.us', name: 'A test group', members: [FRIEND, DM_FRIEND] }], { at: Date.UTC(2026, 6, 1) / 1000 });
const deps = { mindBudgetOk: async () => ({ ok: false }), getUsageByCaller: () => [], knownNames: () => [] };
let { world, clock, life } = await bootLife({ jev, callRole: cr });
story.__setDepsForTest(deps);
mindHooks.registerHooks();
const refold = async () => { await stopLife(); ({ life } = await bootLife({ world, clock, jev, callRole: cr })); story.__setDepsForTest(deps); };
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const dec = (id) => S().decisions.get(id);
const live = (e) => !S().excluded?.has?.(e.id);
const about = (type, id) => listEvents({ types: [type], limit: 500, order: 'desc' }).filter(live).filter(e => e.payload?.decisionId === id);
const today = (h, m = 0) => { const p = localParts(clock.now(), tz); return zonedToUnix(p.year, p.month, p.day, h, m, tz); };
const ticks = (k = 1) => simulateHours(k * 0.25);
async function untilTime(t) { while (clock.now() < t) await ticks(); }
async function nextEvening() {
  const t = today(17, 0);
  await untilTime(clock.now() < t ? t : t + 24 * HOUR);
  for (let i = 0; i < 6 && S().vitals?.sick === true; i++) await untilTime(today(17, 0) + 24 * HOUR);
}
const evening = (at, label) => [{ id: 'go', label, go: true, kind: 'hangout' },
  { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 45, expiresAt: at + 90 * 60 }, { id: 'stay', label: 'Stay in', kind: 'rest' }];
await simulateHours(11);
{
  const pv = await director.preview({ kind: 'fate', category: 'heavy', mode: 'frozen' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
}

/** A plan adopted from a group's claim, cause chain and all: a chat's own origin. */
function adoptedPlan({ at, label = 'Coffee with a coworker' }) {
  const now = clock.now();
  const flag = appendEvent({ type: 'claim.flagged', at: now, actor: 'chat', originKind: 'group', originJid: GROUP, payload: { claimId: 91, p: 0.9 } });
  const opened = appendEvent({ type: 'decision.opened', at: now, actor: 'engine', causeId: flag.id, payload: {
    kind: 'hangout', subject: { eventAt: at, placeId: 'place:cafe', castIds: ['cast:coworker-a'], minutes: 90 }, options: evening(at, label),
    opensAt: now, decideBy: at - 2 * HOUR, ponrAt: at - HOUR, adopted: true, claimId: 91, category: 'social',
  } });
  appendEvent({ type: 'decision.committed', at: now, actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, optionId: 'go', p: 1, sampled: false, by: 'adopted' } });
  return opened.id;
}
const startOf = (id, t0) => {
  const rows = listEvents({ types: ['activity.started'], from: t0, limit: 500 }).filter(live);
  return rows.find(e => (e.payload?.withCast ?? []).includes('cast:coworker-a') && e.payload?.placeId === 'place:cafe');
};
const facts = (t0) => selfFacts(listEvents({ from: t0, limit: 500 }).filter(live), { excluded: (i) => S().excluded?.has?.(i), tz }).bullets;

async function playOut(pick) {
  await nextEvening();
  const t0 = clock.now();
  const at = today(20, 0);
  const id = adoptedPlan({ at });
  await refold();
  if (pick) {
    for (const optionId of pick) {
      const pv = await director.preview({ kind: 'decision.pick', decisionId: id, optionId }, { relax: true, project: false });
      await director.apply(pv.previewId, pv.fingerprint);
    }
  }
  await untilTime(at + 20 * 60);
  const a = startOf(id, t0);
  check('(setup) he went', !!a, listEvents({ types: ['activity.started'], from: t0, limit: 50 }).map(e => e.payload?.kind));
  const raw = life.publicRaw({ days: 2 });
  const row = (raw.spans ?? raw.rows ?? []).find(r => r.eventId === a?.id) ?? (raw.spans ?? raw.rows ?? []).find(r => r.at === a?.at);
  const sess = a ? sessionOf(a, { id: a.id + 1, at: a.at + 3600 }, S()) : null;
  const live2 = life.liveSession({});
  await untilTime(at + 2.5 * HOUR);
  return { id, a, row, sess, live: live2, facts: facts(t0), spends: listEvents({ types: ['money.spent'], from: t0, limit: 200 }).filter(live).filter(e => e.causeId === a?.id) };
}

section('finding 11: control, a chat\'s plan with no pick');
const control = await playOut(null);
eq('the activity row is the chat\'s', [control.a?.originKind, control.a?.originJid], ['group', GROUP]);
eq('the site: an area-only "out" row', [control.row?.kind, control.row?.areaOnly, control.row?.castIds], ['out', true, []]);
check('no journal line', !control.facts.some(b => /hangout|caf/i.test(b)), control.facts);
eq('the scene: narration only', [control.sess?.mode, control.sess?.originKind], ['narration_only', 'group']);

section('finding 11: an owner\'s pick changes none of that');
for (const [name, pick] of [['go → late', ['late']], ['stay, then go', ['stay', 'go']]]) {
  const r = await playOut(pick);
  eq(`${name}: committed by the owner`, dec(r.id)?.committed?.by, 'owner');
  eq(`${name}: the activity row is still the chat's`, [r.a?.originKind, r.a?.originJid], ['group', GROUP]);
  eq(`${name}: the site: an area-only "out" row`, [r.row?.kind, r.row?.areaOnly, r.row?.castIds], ['out', true, []]);
  check(`${name}: no journal line`, !r.facts.some(b => /hangout|caf/i.test(b)), r.facts);
  eq(`${name}: the scene: narration only`, [r.sess?.mode, r.sess?.originKind], ['narration_only', 'group']);
  check(`${name}: the spend keeps it too`, r.spends.every(e => e.originKind === 'group'), r.spends.map(e => e.originKind));
  // Its cause is still the plan: an undo cascades as for any plan.
  eq(`${name}: caused by the plan that fits the pick`, getEvent(r.a?.causeId)?.type, 'plan.made');
}

section('finding 11: his own plan is unchanged by this');
{
  await nextEvening();
  const t0 = clock.now();
  const at = today(20, 0);
  const now = clock.now();
  const opened = appendEvent({ type: 'decision.opened', at: now, actor: 'engine', payload: {
    kind: 'hangout', subject: { eventAt: at, placeId: 'place:cafe', castIds: ['cast:coworker-a'], minutes: 90 }, options: evening(at, 'Coffee'), opensAt: now, decideBy: at - 2 * HOUR, ponrAt: at - HOUR } });
  await refold();
  const pv = await director.preview({ kind: 'decision.pick', decisionId: opened.id, optionId: 'go' }, { relax: true, project: false });
  await director.apply(pv.previewId, pv.fingerprint);
  await untilTime(at + 20 * 60);
  const a = startOf(opened.id, t0);
  eq('a pick on his own plan: self origin', a?.originKind, 'self');
  await untilTime(at + 2.5 * HOUR);
}

section('finding 12: a real revoke takes back a nudge (not a direct revert)');
const say = (id, content, chat = GROUP, sender = FRIEND, timestamp = clock.now()) => {
  const msg = { id, groupJid: chat, senderJid: sender, senderName: 'Avery', content, messageType: 'text', timestamp, metadata: { mentionedJids: [] }, isFromSelf: false };
  storeMessage(msg);
  return msg;
};
function nudgeable(label = 'Picnic') {
  const at = today(21, 30);
  const now = clock.now();
  return appendEvent({ type: 'decision.opened', at: now, actor: 'engine', payload: {
    kind: 'picnic', subject: { eventAt: at, placeId: 'place:park', castIds: ['cast:flatmate'], minutes: 90 }, options: evening(at, label), opensAt: now, decideBy: today(20, 0), ponrAt: today(20, 30) } }).id;
}
{
  await nextEvening();
  probs = { go: 0.5, late: 0.25, stay: 0.25 };
  const id = nudgeable();
  await refold();
  await ticks();
  probs = { go: 0.92, late: 0.04, stay: 0.04 };
  const msg = say('NUDGE1', 'picnic later, you coming?');
  await life.perceiveChat(msg, resolveAudience({ chatJid: GROUP }));
  const c = about('decision.committed', id)[0];
  eq('(setup) a nudged commit, self origin', [c?.payload?.nudged, c?.originKind], [true, 'self']);
  const trig = about('chat.trigger', id)[0];
  eq('the trigger names the line', trig?.payload?.msgId, 'NUDGE1');
  check('the group is among its origins', dec(id).origins.some(o => o.jid === GROUP));
  relStore.onMessageRevoked('NUDGE1', GROUP);
  await new Promise(r => setImmediate(r));
  check('revoked: the trigger, the lean, the commit are out', S().excluded.has(trig.id) && S().excluded.has(c.id), { t: S().excluded.has(trig.id), c: S().excluded.has(c.id) });
  eq('the plan is open again, the chat gone from it', [dec(id)?.status, dec(id)?.committed ?? null, dec(id).origins.some(o => o.jid === GROUP)], ['open', null, false]);
  await refold();
  eq('…after a full replay', [dec(id)?.status, dec(id)?.committed ?? null], ['open', null]);
  // Another line in that chat touches nothing.
  probs = { go: 0.92, late: 0.04, stay: 0.04 };
  clock.advance({ minutes: 16 });
  await life.tick();
  const m2 = say('NUDGE2', 'picnic later then?');
  await life.perceiveChat(m2, resolveAudience({ chatJid: GROUP }));
  const c2 = about('decision.committed', id)[0];
  check('(setup) nudged again', c2?.payload?.nudged === true);
  say('OTHERLINE', 'unrelated');
  relStore.onMessageRevoked('OTHERLINE', GROUP);
  await new Promise(r => setImmediate(r));
  eq('an unrelated revoke undoes nothing', [dec(id)?.status, S().excluded.has(c2.id)], ['committed', false]);
  // An edit does the same as a revoke.
  relStore.onMessageEdited('NUDGE2', 'no picnic at all', GROUP);
  await new Promise(r => setImmediate(r));
  check('an edited line: taken back', S().excluded.has(c2.id), dec(id)?.status);
  probs = null;
}

section('finding 12: a forget in a DM, and a purge');
{
  await nextEvening();
  probs = { go: 0.5, late: 0.25, stay: 0.25 };
  const id = nudgeable('DM picnic');
  await refold();
  await ticks();
  probs = { go: 0.92, late: 0.04, stay: 0.04 };
  // (forgetRecent counts on the real clock.)
  const msg = say('DMNUDGE', 'picnic later, you coming?', DM_FRIEND, DM_FRIEND, Math.floor(Date.now() / 1000));
  await life.perceiveChat(msg, resolveAudience({ chatJid: DM_FRIEND }));
  const c = about('decision.committed', id)[0];
  check('(setup) a nudge from a DM', c?.payload?.nudged === true && dec(id).origins.some(o => o.jid === DM_FRIEND), c?.payload);
  relStore.forgetRecent(DM_FRIEND, DM_FRIEND);
  await new Promise(r => setImmediate(r));
  check('forgotten: the commit it nudged is out', S().excluded.has(c.id));
  eq('…open again', dec(id)?.status, 'open');

  await nextEvening();
  probs = { go: 0.5, late: 0.25, stay: 0.25 };
  const id2 = nudgeable('Another picnic');
  await refold();
  await ticks();
  probs = { go: 0.92, late: 0.04, stay: 0.04 };
  const m2 = say('DMNUDGE2', 'picnic later, you coming?', DM_FRIEND, DM_FRIEND);
  await life.perceiveChat(m2, resolveAudience({ chatJid: DM_FRIEND }));
  const c2 = about('decision.committed', id2)[0];
  check('(setup) a second DM nudge', c2?.payload?.nudged === true, c2?.payload);
  life.redactPerson([DM_FRIEND]);
  const row = getEvent(c2.id);
  eq('purge: the nudged commit is blanked with its lean', [row.redacted, JSON.stringify(row.payload).includes('decisionId')], [true, false]);
  check('…nothing of them left on the plan', !(dec(id2)?.origins ?? []).some(o => o.jid === DM_FRIEND));
  probs = null;
}

section('finding 13: an intention resting on a revoked line stays gone');
{
  const t = clock.now();
  say('INTENT', 'can you get back to me?');
  const from = mindStore.insertElement({ kind: 'intention', intentionKind: 'follow_up', createdAt: t, expiresAt: t + 24 * HOUR, origins: [{ originJid: GROUP, originKind: 'group', minLearnedAt: t }] });
  const older = mindStore.insertElement({ kind: 'intention', intentionKind: 'wind_down', createdAt: t - 6 * HOUR, expiresAt: t + 12 * HOUR, origins: [{ originJid: GROUP, originKind: 'group', minLearnedAt: t - 6 * HOUR }] });
  const own = mindStore.insertElement({ kind: 'intention', intentionKind: 'check_in', createdAt: t, expiresAt: t + 24 * HOUR, origins: [] });
  check('(setup) all three open', [from, older, own].every(id => openIntentions(t).some(i => i.id === id)));
  relStore.onMessageRevoked('INTENT', GROUP);
  const open = openIntentions(t).map(i => i.id);
  check('the one from that moment on is gone', !open.includes(from), open);
  check('…an older one, which never saw the line, stays', open.includes(older), open);
  check('…his own stays', open.includes(own), open);
  mindStore.setElementStatus([older, own], 'expired');
}

section('finding 14: a date far from now is a bad date, not a crash');
{
  for (const date of ['1960-01-01', '1969-12-31', '1970-01-01', '9999-12-31', '2000-01-05']) {
    let code = null;
    try { life.thoughtDeed({ date }); } catch (err) { code = err?.code ?? err?.message; }
    eq(date, code, 'bad_date');
  }
  check('today still reads', Array.isArray(life.thoughtDeed({}).rows));
}

await stopLife();
void db;
report();
process.exit(0);
