// 2026-11-02 pinned Director fixes:
// #4 the SCHEDULE form: a 15-minute stretch entered a few minutes ahead (live: HOME
//    17:15–17:30 at ~17:05) plans and applies; the route still refuses an empty time
//    (what the panel's presets used to leave behind: 400 bad_ranges), and two
//    stretches of one edit that overlap say so (ranges_overlap).
// #6 "chat-made" is a plan MADE in a chat (adopted, invitation, reply, real-person
//    subject, opened from a chat) — live: decision 245, his own routine brewpub
//    evening, got one lean caused by a group chat.trigger and vanished from PLAY GOD,
//    owner picks (chat_plan) and prompt drafts. A chat-nudged plan is his own for the
//    owner's controls; its lean still never reaches another chat's prompt.
// #7 an owner outing / visit set up over a plan he has: a conflict row (014's
//    shape) cancelled by default (decision.expired {owner_plan}, no trust cost,
//    REVERT THIS CHANGE brings it back), KEEP IT INSTEAD keeps both (overlaps_plan
//    warning; on the day the locked outing wins), a chat-made plan keep-only, parts
//    of the same bundle never conflict. Example world, fake clock, stubbed models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { appendEvent, listEvents } from '../../src/life/eventLog.js';
import { resolveTimezone, zonedToUnix } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import * as pending from '../../src/life/story/pending.js';
import * as continuity from '../../src/life/story/continuity.js';
import { buildCatalogue } from '../../src/life/story/prompt.js';
import { chatMadeDecision, outingConflicts } from '../../src/life/planEdits.js';
import { innerStateLine } from '../../src/life/innerState.js';
import { actionProblem } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
let { world, clock, life } = await bootLife();
const refold = async () => { await stopLife(); ({ life } = await bootLife({ world, clock })); };
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const L = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; } };
const warnings = (p) => p?.continuity?.warnings ?? [];
const GROUP = '120363000000000991@g.us';
const DM = '15550009911@s.whatsapp.net';
const lastAction = () => listEvents({ types: ['director.action'], limit: 5000 }).at(-1);

await simulateHours(11);   // Tue 27 Oct ~17:00 (an office day)

section('#4 a 15-minute stretch a few minutes ahead (HOME 17:15–17:30)');
{
  const a = { kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '17:15', to: '17:30' }] };
  eq('the route shape check passes', actionProblem(a), null);
  const p = director.plan(a, S());
  eq('the planner takes it: one override, 17:15–17:30 today', p.events.find(e => e.type === 'schedule.override_set')?.payload.ranges.map(r => [r.from, r.to]),
    [[L(10, 27, 17, 15), L(10, 27, 17, 30)]]);
  eq('no refusal', p.refusals, []);
  eq('an empty FROM (a preset\'s leftover in a time input) → route bad_ranges', actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: '', to: 'endOfDay' }] }), 'bad_ranges');
  eq('two stretches that overlap → ranges_overlap (not the shape code)',
    codeOf(() => director.plan({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: 'now', to: 'endOfDay' }, { activity: 'home', from: '17:15', to: '17:30' }] }, S())), 'invalid:ranges_overlap');
  eq('the presets\' symbolic values pass the route', [
    actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'home', from: 'now', to: 'endOfDay' }] }),
    actionProblem({ kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' } })], [null, null]);
  const pv = await director.preview(a, { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  const ov = Object.values(S().scheduleOverrides ?? {}).find(o => o.status === 'active');
  eq('applied: an active override with that stretch', ov?.ranges?.map(r => [r.from, r.to]), [[L(10, 27, 17, 15), L(10, 27, 17, 30)]]);
}

// His own routine evening tomorrow 20:00 with the flatmate, one lean caused by a group chat.trigger.
const FLAT = 'cast:flatmate';
const BREW_AT = L(10, 28, 20, 0);
const brewOptions = (at) => [{ id: 'go', label: 'Brewpub with a friend', go: true, kind: 'hangout' },
  { id: 'late', label: 'Join later', go: 'late', kind: 'hangout', minutes: 60, expiresAt: at + 90 * 60 }, { id: 'stay', label: 'Stay in', kind: 'rest' }];
const brew = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', payload: {
  kind: 'hangout', subject: { eventAt: BREW_AT, placeId: 'place:cafe', castIds: [FLAT], minutes: 90 },
  options: brewOptions(BREW_AT), opensAt: clock.now(), decideBy: BREW_AT - 2 * HOUR, ponrAt: BREW_AT - HOUR,
} });
const trig = appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'group', originJid: GROUP, causeId: brew.id, payload: { decisionId: brew.id, toward: 'go' } });
const lean = appendEvent({ type: 'decision.lean', at: clock.now(), actor: 'jev', causeId: trig.id, payload: { decisionId: brew.id, optionId: 'go', p: 0.8, probs: { go: 0.8, stay: 0.2 }, trigger: 'chat_mention' } });
await refold();

section('#6 a routine plan a chat only nudged is still chat-touched for prompts');
{
  const d = S().decisions.get(brew.id);
  check('the lean carried the group\'s origin into the decision', (d?.origins ?? []).some(o => o.jid === GROUP), JSON.stringify(d?.origins));
  const other = { kind: 'dm', chatJid: DM, members: [DM] };
  check('…so another chat\'s inner-state line never shows that lean', !/Brewpub/.test(String(innerStateLine(S(), other) ?? '')), innerStateLine(S(), other));
  check('…but it was not made in a chat: every classifier agrees',
    !chatMadeDecision(d) && !pending.isChatDecision(d) && !continuity.decisionFromChat(d) && !director.decisionFromChat(d) && d.chatOpened !== true);
}

appendEvent({ type: 'decision.committed', at: clock.now(), actor: 'engine', causeId: lean.id, payload: { decisionId: brew.id, optionId: 'go', p: 0.8, sampled: false, by: 'lean' } });
await refold();

section('#6 the owner controls it like any plan of his');
{
  const d = S().decisions.get(brew.id);
  eq('committed go by his lean', [d?.status, d?.committed?.optionId, d?.committed?.by], ['committed', 'go', 'lean']);
  check('PLAY GOD lists it', (story.godView().decisions ?? []).some(x => x.id === brew.id), JSON.stringify(story.godView().decisions?.map(x => x.id)));
  eq('an owner pick is not refused chat_plan', codeOf(() => director.plan({ kind: 'decision.pick', decisionId: brew.id, optionId: 'stay' }, S(), { relax: true })), null);
  eq('…nor an outcome', codeOf(() => director.plan({ kind: 'outcome', decisionId: brew.id, outcome: 'well' }, S(), { relax: true })), null);
  const cat = buildCatalogue(S(), world, clock.now(), tz).model?.decisions ?? [];
  check('the prompt catalogue offers it for drafts', cat.some(x => x.id === brew.id), JSON.stringify(cat));
  const sched = director.plan({ kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '19:00', to: '23:00' }] }, S());
  const row = sched.extra.conflicts.find(r => r.id === brew.id);
  check('a schedule conflict row for it is not "from a chat"', row && !row.fromChat, JSON.stringify(row));
  check('…and the cancel line names it', warnings(sched).some(w => w.code === 'cancels_plan' && /Brewpub with a friend/.test(w.text) && !w.fromChat), JSON.stringify(warnings(sched)));
}

section('#6 plans made in a chat stay protected');
{
  const base = { status: 'committed', committed: { optionId: 'go', by: 'lean' }, origins: [{ kind: 'group', jid: GROUP }] };
  check('a nudge alone is not chat-made', !chatMadeDecision(base));
  for (const [what, extra] of [['adopted', { adopted: true }], ['a claim', { claimId: 7 }], ['an invitation', { invite: true }],
    ['his reply\'s commit', { committed: { optionId: 'go', by: 'reply' } }], ['a real-person subject', { subjectJid: DM }], ['opened from a chat', { chatOpened: true }]]) {
    const d = { ...base, ...extra };
    check(`${what} → chat-made (all classifiers)`, chatMadeDecision(d) && pending.isChatDecision(d) && continuity.decisionFromChat(d) && director.decisionFromChat(d));
  }
  // The fold marks a decision opened from a chat (no other marker) and leaves the rest alone.
  const t = appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'group', originJid: GROUP, payload: {} });
  const opened = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', causeId: t.id, payload: {
    kind: 'walk', subject: { eventAt: L(10, 30, 18), placeId: 'place:cafe', castIds: [], minutes: 60 },
    options: [{ id: 'go', label: 'A walk', go: true }, { id: 'stay', label: 'Stay in' }], opensAt: clock.now(), decideBy: L(10, 30, 17),
  } });
  await refold();
  eq('a decision.opened caused by a chat → chatOpened, chat-made', [S().decisions.get(opened.id)?.chatOpened, chatMadeDecision(S().decisions.get(opened.id))], [true, true]);
  eq('…his own routine one has no flag', S().decisions.get(brew.id)?.chatOpened, undefined);
  check('…and 020: PLAY GOD lists it, marked', (story.godView().decisions ?? []).find(x => x.id === opened.id)?.fromChat === true);
  appendEvent({ type: 'decision.expired', at: clock.now(), actor: 'engine', causeId: opened.id, payload: { decisionId: opened.id, reason: 'cancelled' } });
}

// A plan made in a chat (an invitation's inviter as subject) tomorrow 21:00.
const CHAT_AT = L(10, 28, 21, 0);
const chatPlan = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', subjectJid: DM, payload: {
  kind: 'movie', subject: { eventAt: CHAT_AT, placeId: 'place:cinema', castIds: [], minutes: 60 },
  options: [{ id: 'go', label: 'Movie night', go: true, kind: 'movie' }, { id: 'stay', label: 'Stay in', kind: 'rest' }],
  opensAt: clock.now(), decideBy: CHAT_AT - 2 * HOUR,
} });
appendEvent({ type: 'decision.committed', at: clock.now(), actor: 'engine', causeId: chatPlan.id, subjectJid: DM, payload: { decisionId: chatPlan.id, optionId: 'go', p: 1, sampled: false, by: 'lean' } });
await refold();

const outing = (startAt, label, extra = {}) => ({ kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt, minutes: 60, castIds: [], label, ...extra });

section('#7 an owner outing over his plan: cancelled by default');
{
  const a = outing(L(10, 28, 20, 30), 'Owner movie');
  const p = director.plan(a, S(), { relax: true });
  const row = p.extra?.conflicts?.find(r => r.id === brew.id);
  eq('a conflict row: decision, cancel by default, both choices, cancelled', [row?.type, row?.resolution, row?.choices, row?.outcome], ['decision', 'cancel', ['cancel', 'keep'], 'cancelled']);
  const exp = p.events.find(e => e.type === 'decision.expired' && e.payload.decisionId === brew.id);
  const opened = p.events.find(e => e.type === 'decision.opened');
  eq('an engine decision.expired {owner_plan} caused by the new outing', [exp?.actor, exp?.payload.reason, exp?.causeRef], ['engine', 'owner_plan', opened?.ref]);
  const w = warnings(p).find(x => x.code === 'cancels_plan');
  check('a HIGH "this cancels" warning naming it, with its keep key', w?.severity === 'high' && /Brewpub with a friend/.test(w.text) && w.keep?.[0] === `decision:${brew.id}`, JSON.stringify(warnings(p)));
  const chatRow = p.extra?.conflicts?.find(r => r.id === chatPlan.id);
  eq('020: the chat-made movie in the window: cancel by default, marked from a chat', [chatRow?.choices, chatRow?.outcome, chatRow?.fromChat, p.events.some(e => e.type === 'decision.expired' && e.payload.decisionId === chatPlan.id)],
    [['cancel', 'keep'], 'cancelled', true, true]);
  check('no subject jid in the rows', !JSON.stringify(p.extra).includes(DM));
  const pk = director.plan(outing(L(10, 28, 20, 30), 'Owner movie', { resolutions: { [`decision:${chatPlan.id}`]: 'keep' } }), S(), { relax: true });
  check('kept: its overlap line says "a plan from a chat", never its label', warnings(pk).some(x => x.code === 'overlaps_plan' && x.fromChat && /a plan from a chat/.test(x.text) && !/Movie night/.test(x.text)), JSON.stringify(warnings(p)));
  eq('an outing at another time: no rows', director.plan(outing(L(10, 28, 15, 0), 'Matinee'), S(), { relax: true }).extra?.conflicts ?? [], []);
}

section('#7 KEEP IT INSTEAD: both stay committed, a warning');
{
  const a = outing(L(10, 28, 20, 30), 'Owner movie', { resolutions: { [`decision:${brew.id}`]: 'keep', [`decision:${chatPlan.id}`]: 'keep' } });
  eq('the route takes the resolutions on a scene', actionProblem(a), null);
  eq('…and refuses a bad one', actionProblem({ ...a, resolutions: { 'x:1': 'keep' } }), 'bad_resolutions');
  const p = director.plan(a, S(), { relax: true });
  const row = p.extra?.conflicts?.find(r => r.id === brew.id);
  eq('the row is kept', [row?.resolution, row?.outcome], ['keep', 'kept']);
  check('no decision.expired at all', !p.events.some(e => e.type === 'decision.expired'));
  check('an overlaps_plan warning (warn) naming it', warnings(p).some(x => x.code === 'overlaps_plan' && x.severity === 'warn' && !x.fromChat && /Brewpub with a friend/.test(x.text)), JSON.stringify(warnings(p)));
  check('no cancels_plan', !warnings(p).some(x => x.code === 'cancels_plan'));
}

section('#7 outingConflicts units: goal → reopen, story / under way → keep-only');
{
  const T0 = 1_800_000_000;
  const mk = (id, extra) => ({ id, status: 'committed', committed: { optionId: 'go', by: 'lean' }, subject: { eventAt: T0 + 3600 },
    options: [{ id: 'go', label: `plan ${id}` }], ...extra });
  const st = { decisions: new Map([[1, mk(1, { goalId: 4 })], [2, mk(2, { category: 'career', kind: 'career:interview' })],
    [3, mk(3, { ponrAt: T0 - 60 })], [4, mk(4, {})], [5, mk(5, { status: 'open' })]]) };
  const rows = outingConflicts(st, { from: T0 + 1800, to: T0 + 5400 }, { now: T0 });
  const by = Object.fromEntries(rows.map(r => [r.id, [r.type, r.choices.join('|'), r.resolution]]));
  eq('rows by id', by, { 1: ['goal', 'reopen|keep', 'reopen'], 2: ['decision', 'keep', 'keep'], 3: ['decision', 'keep', 'keep'],
    4: ['decision', 'cancel|keep', 'cancel'], 5: ['decision', 'cancel|keep', 'cancel'] });
  eq('a resolution picks keep; an unknown choice falls back to the default', outingConflicts(st, { from: T0 + 1800, to: T0 + 5400 },
    { now: T0, resolutions: { 'decision:4': 'keep', 'decision:5': 'reopen' } }).filter(r => r.id >= 4).map(r => r.resolution), ['keep', 'cancel']);
  eq('a window apart from every plan: no row', outingConflicts(st, { from: T0 - 7200, to: T0 - 3600 }, { now: T0 }), []);
}

section('#7 two owner outings in one bundle never conflict with each other');
{
  const p = director.plan({ kind: 'bundle', actions: [outing(L(10, 29, 19, 0), 'First'), outing(L(10, 29, 19, 30), 'Second')] }, S(), { relax: true });
  check('no decision.expired in the batch', !p.events.some(e => e.type === 'decision.expired'), JSON.stringify(p.events.map(e => e.type)));
}

section('#7 apply the default: cancelled, no trust cost, REVERT THIS CHANGE brings it back');
{
  const trustBefore = S().cast.get(FLAT).metrics.trust;
  const pv = await director.preview(outing(L(10, 28, 20, 30), 'Owner movie'), { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  eq('his brewpub plan is cancelled', S().decisions.get(brew.id)?.status, 'cancelled');
  eq('020: the chat-made plan is cancelled too (he tells them)', S().decisions.get(chatPlan.id)?.status, 'cancelled');
  const act = lastAction();
  check('CHANGES says what it cancelled', /cancelled: Brewpub with a friend/.test(String(story.godView().changes?.find(c => c.id === act.id)?.description ?? '')),
    JSON.stringify(story.godView().changes?.find(c => c.id === act.id)));
  await simulateHours(1);
  eq('no trust lost with the flatmate', S().cast.get(FLAT).metrics.trust >= trustBefore, true);
  const rp = life.revertChangePreview(act.id);
  check('REVERT THIS CHANGE: no refusals', (rp.refusals ?? []).length === 0, JSON.stringify(rp.refusals));
  life.revertChange(act.id, { fingerprint: rp.fingerprint });
  eq('…his plan is committed again', S().decisions.get(brew.id)?.status, 'committed');
}

section('#7 keep: on the day the owner\'s (locked) outing wins');
{
  const pv = await director.preview(outing(L(10, 28, 20, 30), 'Owner movie 2', { resolutions: { [`decision:${brew.id}`]: 'keep' } }), { relax: true });
  await director.apply(pv.previewId, pv.fingerprint);
  const mine = [...S().decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'Owner movie 2');
  eq('both committed after apply', [S().decisions.get(brew.id)?.status, mine?.status], ['committed', 'committed']);
  await simulateHours(Math.ceil((L(10, 28, 22, 0) - clock.now()) / HOUR));
  const brewEnd = listEvents({ types: ['decision.expired'], limit: 5000 }).filter(e => e.payload?.decisionId === brew.id).map(e => e.payload.reason);
  check('his routine plan could not go (locked wins), the owner\'s outing happened',
    brewEnd.includes('could_not_go') && listEvents({ types: ['activity.started'], limit: 5000 }).some(e => e.payload?.decisionId === mine?.id || (e.at >= L(10, 28, 20, 0) && e.payload?.placeId === 'place:cinema')),
    JSON.stringify({ brewEnd, status: S().decisions.get(brew.id)?.status }));
}

await stopLife();
report();
