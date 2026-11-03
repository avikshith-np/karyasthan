// 014 sched — the Director's schedule edits (plan §A5.5–A5.10, review R6/R18/
// R30/R31/R34/R35/R36): `schedule` / `schedule.clear` plan one owner override
// (+ engine schedule expiries caused by it), every refusal reason, the conflict
// table (cancel / keep (splits the range) / reopen, outcome, CHAT_PLAN, story decisions keep-only,
// commitments keep-only, meetings dropped and listed), a schedule cancellation
// costs no trust, a goal reopens, revert only before it takes effect, a rewind
// removes it with its consequences, the projection (outside the fingerprint;
// timedOut), apply → the facade re-plans at once (R36) and the Day view shows it,
// a candidateId no preview resolved → expired_candidate (geo merged), the route shapes (venue data refused),
// GET /api/director/schedule's facade read. Example world, fake clock, stubbed
// models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateHours, HOUR,
} from './_helpers.js';
import { getEvent, eventsAfter, lastEventId, appendEvent, SCHEDULE_EVENT_TYPES, OWNER_ONLY_TYPES, CHAT_FORBIDDEN_TYPES } from '../../src/life/eventLog.js';
import { dateKey, resolveTimezone, zonedToUnix } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import * as story from '../../src/life/story/index.js';
import { innerStateLine } from '../../src/life/innerState.js';
import { actionProblem, scheduleProblem } from '../../src/dashboard/routes/director.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
// Events appended straight to the log (a chat outing's setup) reach the live projection on a re-boot.
const refold = async () => { await stopLife(); await bootLife({ world, clock }); };
const tz = resolveTimezone(world.timezone);
const S = () => life.getState();
const L = (mo, d, h, m = 0) => zonedToUnix(2026, mo, d, h, m, tz);
const OFFICE = world.self.job.officePlaceId;
const HOME = world.self.homePlaceId;
const since = (id) => eventsAfter(id, 50000);

function codeOfSync(fn) {
  try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
async function codeOf(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}

await simulateHours(7);              // Tue 27 Oct ~13:00: an office day, he is at work

section('catalogue: two owner-only, chat-forbidden types; the kinds');
{
  eq('SCHEDULE_EVENT_TYPES', [...SCHEDULE_EVENT_TYPES].sort(), ['schedule.override_cleared', 'schedule.override_set']);
  check('owner-only and chat-forbidden', [...SCHEDULE_EVENT_TYPES].every(t => OWNER_ONLY_TYPES.has(t) && CHAT_FORBIDDEN_TYPES.has(t)));
  check('ACTION_KINDS and PROMPT_ACTION_KINDS list both', ['schedule', 'schedule.clear'].every(k => director.ACTION_KINDS.includes(k) && director.PROMPT_ACTION_KINDS.includes(k)));
  let refused = false;
  try { appendEvent({ type: 'schedule.override_set', actor: 'chat', originKind: 'dm', originJid: '15550001111@s.whatsapp.net', payload: {} }); } catch { refused = true; }
  check('a chat can never append one', refused);
}

section('refusals');
{
  const plan = (a) => codeOfSync(() => director.plan({ kind: 'schedule', ...a }, S()));
  eq('day > 7 → too_far', plan({ day: 8, background: { activity: 'off', wholeDay: true } }), 'refused:too_far');
  eq('a range in the past → in_past', plan({ day: 0, ranges: [{ activity: 'home', from: '08:00', to: '09:00' }] }), 'refused:in_past');
  eq('out without a place → no_place', plan({ day: 0, ranges: [{ activity: 'out', from: '19:00', to: '20:00' }] }), 'refused:no_place');
  eq('out at the office → private_place', plan({ day: 0, ranges: [{ activity: 'out', placeId: OFFICE, from: '19:00', to: '20:00' }] }), 'refused:private_place');
  eq('out at home → private_place', plan({ day: 0, ranges: [{ activity: 'out', placeId: HOME, from: '19:00', to: '20:00' }] }), 'refused:private_place');
  // Integrated with 014 geo: the venue resolver answers, and a candidate id no preview resolved has expired.
  eq('a candidateId no preview resolved → expired_candidate (A5.9, geo merged)', plan({ day: 0, ranges: [{ activity: 'out', candidateId: 'cand_0001', from: '19:00', to: '20:00' }] }), 'refused:expired_candidate');
  eq('a range under 15 min → bad_range', plan({ day: 0, ranges: [{ activity: 'home', from: '19:00', to: '19:10' }] }), 'invalid:bad_range');
  eq('a JID in a label → jid_in_text', plan({ day: 1, ranges: [{ activity: 'home', from: '19:00', to: '20:00', label: 'see 15550001111@s.whatsapp.net' }] }), 'invalid:jid_in_text');
  eq('a sleep-in that doesn\'t cover the wake → bad_sleep', plan({ day: 1, ranges: [{ activity: 'sleep', from: '04:00', to: '06:00' }] }), 'invalid:bad_sleep');
  eq('nothing to do', plan({ day: 1 }), 'invalid:nothing');
  eq('remove a block that isn\'t there → nothing', plan({ day: 0, op: 'remove', blockKind: 'karaoke' }), 'refused:nothing');
  eq('schedule.clear of an unknown id → no_override', codeOfSync(() => director.plan({ kind: 'schedule.clear', overrideId: 999999 }, S())), 'refused:no_override');
}

section('route shapes (venue data never from the client, R18)');
{
  eq('a good one', actionProblem({ kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' }, ranges: [{ activity: 'out', placeId: 'place:cafe', from: '16:00', to: '18:00' }] }), null);
  eq('day and date both → bad_day', scheduleProblem({ kind: 'schedule', day: 0, date: '2026-10-27' }), 'bad_day');
  // geo's route check (venue data on any schedule action) answers first since the merge.
  eq('lat on a range → venue_data', actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'out', lat: 1, lon: 2, from: '16:00', to: '18:00' }] }), 'venue_data');
  eq('a venue object → venue_data', actionProblem({ kind: 'schedule', day: 0, ranges: [{ activity: 'out', venue: { name: 'x' }, from: '16:00', to: '18:00' }] }), 'venue_data');
  eq('four ranges → bad_ranges', actionProblem({ kind: 'schedule', day: 0, ranges: Array(4).fill({ activity: 'home', from: '16:00', to: '17:00' }) }), 'bad_ranges');
  eq('a bad resolution key', actionProblem({ kind: 'schedule', day: 0, background: { activity: 'off', wholeDay: true }, resolutions: { 'x:1': 'cancel' } }), 'bad_resolutions');
  eq('schedule.clear needs an id', actionProblem({ kind: 'schedule.clear' }), 'bad_overrideId');
}

section('rest of the day off + a cafe 16:00–18:00: one preview, one apply, the projection (R34/R35)');
let overrideId;
{
  const action = { kind: 'schedule', day: 0, background: { activity: 'off', from: 'now', to: 'endOfDay' }, ranges: [{ activity: 'out', placeId: 'place:cafe', from: '16:00', to: '18:00' }] };
  const p = director.plan(action, S());
  eq('events: director.action + schedule.override_set (owner)', p.events.map(e => [e.type, e.actor]), [['director.action', 'owner'], ['schedule.override_set', 'owner']]);
  const ov = p.events[1].payload;
  eq('payload: date, the background from now to the planned sleep, the cafe range', [ov.date, ov.background.activity, ov.background.from, ov.background.to, ov.ranges[0].placeId],
    [dateKey(clock.now(), tz), 'off', clock.now(), S().plan.sleepAt, 'place:cafe']);
  const meetings = p.extra.conflicts.filter(r => r.type === 'meeting');
  check('meetings after now are listed as dropped', meetings.every(r => r.resolution === 'drop' && r.outcome === 'dropped' && r.choices.join() === 'drop'), p.extra.conflicts);
  check('warning: visible everywhere', p.warnings.includes(director.VISIBLE_EVERYWHERE));
  const pv = await director.preview(action);
  const proj = pv.extra?.projection;
  check('the projection has before / after rows', Array.isArray(proj?.before) && Array.isArray(proj?.after), proj);
  check('…after: no work at the office after now, a cafe stretch', proj && !proj.after.some(r => r.kind === 'work' && r.start >= clock.now() && r.start < L(10, 27, 23))
    && proj.after.some(r => r.kind === 'cafe' && r.fromOverride), proj?.after?.map(r => r.kind));
  check('…before: work at the office this afternoon', proj?.before?.some(r => r.kind === 'work' && r.placeId === OFFICE && r.start >= clock.now() - 3600));
  // The projection is display only: the fingerprint is the plan's.
  const pv2 = await director.preview(action);
  eq('two previews, one fingerprint (projection outside it)', pv2.fingerprint, pv.fingerprint);
  const before = lastEventId();
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  overrideId = res.eventIds.map(getEvent).find(e => e.type === 'schedule.override_set').id;
  eq('apply → the override (owner), schedule flag', [getEvent(overrideId).originKind, res.schedule], ['owner', true]);
  await story.lastScheduleKick();
  const made = since(before).filter(e => e.type === 'plan.made');
  eq('the facade re-planned at once (R36): one plan.made caused by the override, self', made.map(e => [e.causeId, e.originKind]), [[overrideId, 'self']]);
  check('the plan in force lists the override', S().plan.overrides.includes(overrideId));
  const day = await life.dayView({ date: dateKey(clock.now(), tz) });
  check('the Day view reflects it (a cafe stretch in today\'s rows ahead)', /"kind":"cafe"/.test(JSON.stringify(day)));
  await simulateHours(1);
  const trav = since(before).filter(e => e.type === 'travel.started');
  check('he went home from the office', trav.some(e => e.payload.from === OFFICE && e.payload.to === HOME));
}

section('scheduleView; revert only before it takes effect');
{
  const v = life.scheduleView();
  const row = v.overrides.find(o => o.id === overrideId);
  eq('the panel row: active, off + cafe, not revertible (it started)', [row?.status, row?.background?.activity, row?.ranges?.[0]?.activity, row?.revertible], ['active', 'off', 'out', false]);
  let refused = null;
  try { life.revertEvent(overrideId, { reason: 'x' }); } catch (e) { refused = e.message; }
  check('revert refused (use CLEAR)', /cannot be reverted/.test(refused ?? ''), refused);
}

section('a future override: revert is allowed and cascades');
{
  const action = { kind: 'schedule', day: 1, background: { activity: 'work_home', wholeDay: true } };
  const pv = await director.preview(action);
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  const id = res.eventIds.map(getEvent).find(e => e.type === 'schedule.override_set').id;
  await story.lastScheduleKick();
  check('revertible (tomorrow)', life.scheduleView().overrides.find(o => o.id === id)?.revertible === true);
  life.revertEvent(id, { reason: 'test' });
  check('gone from the projection', !S().scheduleOverrides?.[id]);
}

section('conflicts: a chat-made evening outing in a range (R6/R30)');
{
  // An evening decision committed from a DM, at 20:30 tomorrow.
  const DM = '15550001111@s.whatsapp.net';
  const at = L(10, 28, 20, 30);
  const flatmate = 'cast:flatmate';
  const trustBefore = S().cast.get(flatmate).metrics.trust;
  const d = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', subjectJid: DM, payload: {
    kind: 'movie', subject: { eventAt: at, placeId: 'place:cinema', castIds: [flatmate], minutes: 60 },
    options: [{ id: 'go', label: 'Go to the cinema', go: true, kind: 'movie' }, { id: 'late', label: 'Join later', go: 'late', kind: 'movie', minutes: 30 }, { id: 'stay', label: 'Stay in', kind: 'rest' }],
    opensAt: clock.now(), decideBy: at - 2 * HOUR, ponrAt: at - HOUR,
  } });
  appendEvent({ type: 'chat.trigger', at: clock.now(), actor: 'chat', originKind: 'dm', originJid: DM, causeId: d.id, payload: { decisionId: d.id, toward: 'go' } });
  await refold();
  const action = { kind: 'schedule', day: 1, ranges: [{ activity: 'home', from: '19:00', to: '23:00' }] };
  const p = director.plan(action, S());
  const row = p.extra.conflicts.find(r => r.id === d.id);
  eq('the row: decision, cancel by default, choices, outcome, from a chat', [row?.type, row?.resolution, row?.choices, row?.outcome, row?.fromChat], ['decision', 'cancel', ['cancel', 'keep'], 'cancelled', true]);
  check('no subject jid in the preview rows', !JSON.stringify(p.extra).includes(DM));
  check('CHAT_PLAN + no-trust warnings', p.warnings.includes(director.CHAT_PLAN) && p.warnings.includes(director.SCHEDULE_FREE));
  const exp = p.events.find(e => e.type === 'decision.expired');
  eq('an engine decision.expired {schedule, subjectJid} caused by the override', [exp?.actor, exp?.payload.reason, exp?.payload.subjectJid, exp?.causeRef, exp?.payloadRefs?.overrideId],
    ['engine', 'schedule', DM, p.events[1].ref, p.events[1].ref]);
  // sched-fixes: keep with the outing inside the range splits the range around it (was conflict_split).
  const keep = director.plan({ ...action, resolutions: { [`decision:${d.id}`]: 'keep' } }, S());
  eq('keep with the outing inside the range → the range split around it', keep.events.find(e => e.type === 'schedule.override_set')?.payload.ranges.map(r => [r.from, r.to]),
    [[L(10, 28, 19), at], [at + 2 * HOUR, L(10, 28, 23)]]);
  check('…no expiry, a keeps_plan warning', !keep.events.some(e => e.type === 'decision.expired') && (keep.continuity?.warnings ?? []).some(w => w.code === 'keeps_plan'));
  check('the default cancel is a HIGH cancels_plan warning with its keep key', (p.continuity?.warnings ?? []).some(w => w.code === 'cancels_plan' && w.severity === 'high' && w.keep?.[0] === `decision:${d.id}`),
    JSON.stringify(p.continuity?.warnings));
  const pv = await director.preview(action);
  await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  eq('the decision is cancelled', S().decisions.get(d.id)?.status, 'cancelled');
  eq('a schedule cancellation costs no trust (R30)', S().cast.get(flatmate).metrics.trust, trustBefore);
  const groupAud = { kind: 'group', chatJid: '120363000000000001@g.us', members: [] };
  check('no inviter label in another chat\'s inner-state line (R6)', !String(innerStateLine(S(), groupAud) ?? '').includes(DM));
}

section('a story decision is keep-only (R31)');
{
  const at = L(10, 29, 15);
  const d = appendEvent({ type: 'decision.opened', at: clock.now(), actor: 'engine', payload: {
    kind: 'career:interview', category: 'career', subject: { eventAt: at, minutes: 30 },
    options: [{ id: 'go', label: 'Go to the interview' }, { id: 'skip', label: 'Skip it' }], opensAt: clock.now(), decideBy: at - HOUR,
  } });
  await refold();
  const r = codeOfSync(() => director.plan({ kind: 'schedule', day: 2, ranges: [{ activity: 'gym', from: '14:00', to: '18:00' }] }, S()));
  eq('a range over it → conflict_story', r, 'refused:conflict_story');
  // Its window is 15:00 + its own length (020: career.INTERVIEW_MIN, the projector keeps no subject minutes).
  const p = director.plan({ kind: 'schedule', day: 2, ranges: [{ activity: 'gym', from: '15:30', to: '19:00' }] }, S());
  const row = p.extra.conflicts.find(x => x.id === d.id);
  eq('at its edge: kept, the range clipped to start after it', [row?.resolution, row?.choices, p.events[1].payload.ranges[0].from], ['keep', ['keep'], L(10, 29, 16)]);
  check('never a decision.expired for it', !p.events.some(e => e.type === 'decision.expired' && e.payload.decisionId === d.id));
}

section('overlap and full');
{
  const r = director.plan({ kind: 'schedule', day: 1, ranges: [{ activity: 'gym', from: '20:00', to: '21:00' }] }, S());
  eq('overlapping another override on the date → refusal overlap naming it', [r.refusals[0]?.reason, r.events.length], ['overlap', 0]);
}

section('schedule.clear');
{
  const ids = Object.values(S().scheduleOverrides).filter(o => o.status === 'active' && o.date === '2026-10-28').map(o => o.id);
  const p = director.plan({ kind: 'schedule.clear', overrideId: ids[0] }, S());
  eq('one owner schedule.override_cleared {overrideId, from: now}', p.events.slice(1).map(e => [e.type, e.actor, e.payload.overrideId, e.payload.from]),
    [['schedule.override_cleared', 'owner', ids[0], clock.now()]]);
  const pv = await director.preview({ kind: 'schedule.clear', overrideId: ids[0] });
  await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  eq('cleared', S().scheduleOverrides[ids[0]].status, 'cleared');
}

section('rewind past an override removes it with its re-plan');
{
  const mark = lastEventId();
  const pv = await director.preview({ kind: 'schedule', day: 3, ranges: [{ activity: 'home', from: '21:00', to: '22:00' }] });
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  await story.lastScheduleKick();
  const id = res.eventIds.map(getEvent).find(e => e.type === 'schedule.override_set').id;
  const rw = await director.preview({ kind: 'rewind', toEventId: mark });
  await director.apply(rw.previewId, rw.fingerprint);
  check('the override is out of the projection', !S().scheduleOverrides?.[id]);
}

section('the projection times out cleanly (R35)');
{
  const { simulate } = await import('../../src/life/story/tomorrow.js');
  const { rebuild } = await import('../../src/life/projector.js');
  const base = rebuild({ world });
  const out = await simulate(base, world, { now: clock.now(), hours: 36, deadlineMs: 0 });
  eq('deadlineMs 0 → timedOut after the first chunk', out.timedOut, true);
  const full = await simulate(base, world, { now: clock.now(), hours: 4 });
  check('without a deadline: no timedOut key', !('timedOut' in full));
}

report();
