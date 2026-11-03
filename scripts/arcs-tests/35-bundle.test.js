// 015 Phase 2 — the bundle action (src/life/story/director.js planBundle,
// routes/director.js partsProblem; plan §P2.5, review #13/#26): ≤ 5 actions
// planned in sequence on the state the previous parts leave, concatenated with
// their refs renumbered and earlier parts' placeholder ids mapped back to refs
// (an unmapped one → bundle_forward_ref), ONE fingerprint and ONE transaction
// (a failure in any part leaves nothing), continuity re-run on the whole batch
// (so "with suggestions" shows whether the fix worked), excluded kinds refused
// with their index, per-part sources reported for the audit.
//
// unit + integration: a realistic log from the life facade (example world,
// timers off), then the Director on a local projection and appender. Invented,
// persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, getEvent } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { zonedToUnix, dateKey, dayStart, addDays, resolveTimezone } from '../../src/life/clock.js';
import * as director from '../../src/life/story/director.js';
import { actionProblem, partsProblem } from '../../src/dashboard/routes/director.js';
import { getDb } from '../../src/memory/db.js';
import { withDecisionLock } from '../../src/life/decisions.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(1);
await simulateHours(7);
await stopLife();

let state = rebuild({ world });
let failAt = null;
let appended = 0;
const append = (spec) => {
  appended += 1;
  if (failAt !== null && appended === failAt) throw new Error('forced append failure');
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append, knownNames: () => ['Quinlan Marsh'], seed: () => seed,
  setClaimStatus: () => {}, fit: () => null, onApplyFailed: () => { state = rebuild({ world }); },
});
const tz = resolveTimezone(world.timezone ?? config.timezone);
const now = () => clock.now();
const today = dayStart(now(), tz);
const tomorrow = addDays(today, 1, tz);
const at = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const count = () => getDb().prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
async function codeOf(fn) {
  try { await fn(); return null; } catch (e) { return `${e.code}:${e.reason}${Number.isInteger(e.part) ? `@${e.part}` : ''}`; }
}

section('sequential planning: part 2 uses the member part 1 creates');
{
  const action = { kind: 'bundle', actions: [
    { kind: 'scene', shape: 'new_cast', name: 'Avery Moss', relation: 'friend' },
    { kind: 'scene', shape: 'cast.beat', castId: 'cast:avery-moss', beatKind: 'hobby', text: 'started climbing', source: 'code' },
  ] };
  const p = director.plan(action, state, { now: now() });
  eq('two director.action parents + the two owner events', p.events.map(e => e.type),
    ['director.action', 'cast.created', 'director.action', 'cast.beat']);
  eq('refs renumbered in order', p.events.map(e => e.ref), ['$1', '$2', '$3', '$4']);
  check('each part keeps its own parent', p.events[1].causeRef === '$1' && p.events[3].causeRef === '$3');
  eq('the parts and their sources', p.parts, [{ kind: 'scene', source: 'hand' }, { kind: 'scene', source: 'code' }]);
  check('one fingerprint for the batch', typeof director.fingerprintOf(p.action, p, 1) === 'string');
  const before = count();
  const pv = await director.preview(action, { project: false });
  const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  eq('one apply appended all four', [res.eventIds.length, count() - before], [4, 4]);
  check('the beat landed on the new member', state.cast.has('cast:avery-moss') && state.story.castLife['cast:avery-moss']?.lastBeat?.kind === 'hobby');
  eq('apply reports the parts (audit)', res.parts, [{ kind: 'scene', source: 'hand' }, { kind: 'scene', source: 'code' }]);
  const parents = res.eventIds.map(getEvent).filter(e => e.type === 'director.action');
  eq('both parents carry the fingerprint', parents.map(e => e.payload.fingerprint), [pv.fingerprint, pv.fingerprint]);
}

section('forward refs: an earlier part\'s placeholder id → its $ref (review #26)');
{
  const base = Math.max(director.PREVIEW_ID_BASE, state.lastEventId);
  const from = now() + 6 * HOUR;
  const action = { kind: 'bundle', actions: [
    { kind: 'weather', weatherKind: 'rain', intensity: 0.6, from, to: from + 3 * HOUR },
    { kind: 'weather.end', windowId: base + 2 },      // part 1's weather.window_set (after its director.action)
  ] };
  const p = director.plan(action, state, { now: now() });
  const end = p.events.find(e => e.type === 'weather.window_ended');
  eq('the placeholder became a payload ref to part 1\'s event', [end?.payload?.windowId, end?.payloadRefs?.windowId], [undefined, '$2']);
  const pv = await director.preview(action, { project: false });
  const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  const set = res.eventIds.map(getEvent).find(e => e.type === 'weather.window_set');
  const ended = res.eventIds.map(getEvent).find(e => e.type === 'weather.window_ended');
  eq('applied: the end names the real window id', ended?.payload?.windowId, set?.id);
  const { renumberPart, refOfPlaceholder } = director.__bundleTest;
  eq('refOfPlaceholder: inside a part\'s range', refOfPlaceholder(1e12 + 3, [{ base: 1e12, count: 4, offset: 10 }]), '$13');
  eq('… outside every range → null', refOfPlaceholder(1e12 + 9, [{ base: 1e12, count: 4, offset: 10 }]), null);
  let fwd = null;
  try { renumberPart([{ ref: '$1', type: 'decision.committed', actor: 'owner', payload: { decisionId: 1e12 + 50 } }], 4, [{ base: 1e12, count: 4, offset: 0 }], 1); } catch (e) { fwd = `${e.code}:${e.reason}@${e.part}`; }
  eq('an unmapped placeholder → refused bundle_forward_ref (never a literal)', fwd, 'refused:bundle_forward_ref@1');
  let nested = null;
  try { renumberPart([{ ref: '$1', type: 'x', actor: 'owner', payload: { deep: { id: 1e12 + 1 } } }], 0, [{ base: 1e12, count: 4, offset: 0 }], 0); } catch (e) { nested = e.reason; }
  eq('a nested placeholder → bundle_forward_ref', nested, 'bundle_forward_ref');
  const ok = renumberPart([{ ref: '$1', type: 'x', actor: 'engine', causeId: 1e12 + 2, payload: { ids: [1e12 + 1, 1e12 + 3] } }], 4, [{ base: 1e12, count: 4, offset: 0 }], 1)[0];
  eq('causeId and id lists map too', [ok.causeRef, ok.payloadRefs?.ids, 'ids' in ok.payload], ['$2', ['$1', '$3'], false]);
}

section('one transaction: a failure in part 3 leaves nothing');
{
  const action = { kind: 'bundle', actions: [
    { kind: 'quick', button: 'tired' },
    { kind: 'scene', shape: 'cast.beat', castId: 'cast:flatmate', beatKind: 'status', text: 'reading a lot' },
    { kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'status', text: 'busy with exams' },
  ] };
  const pv = await director.preview(action, { project: false });
  const before = count();
  appended = 0;
  failAt = 5;                                   // the third part's director.action
  const code = await codeOf(() => director.apply(pv.previewId, pv.fingerprint, { by: 'tester' }));
  failAt = null;
  eq('apply → conflict apply_failed', code, 'conflict:apply_failed');
  eq('nothing written', count(), before);
  check('the projection was rebuilt (onApplyFailed): no part folded', !state.story.castLife['cast:flatmate']?.status?.includes?.('reading'));
}

section('continuity re-run on the whole batch: the added fix clears the clash');
{
  const pv0 = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:restaurant', startAt: at(today, 20, 0), minutes: 120, castIds: [], label: 'dinner A' }, { project: false });
  await director.apply(pv0.previewId, pv0.fingerprint, { by: 'tester' });
  // 2026-11-02: an outing over a plan cancels it by default — dinner A kept here (KEEP IT INSTEAD) to see the clash.
  const dinnerA = [...state.decisions.values()].find(d => d.options?.find(o => o.id === 'go')?.label === 'dinner A');
  const main = { kind: 'scene', shape: 'outing', placeId: 'place:cinema', startAt: at(today, 20, 30), minutes: 90, castIds: [],
    resolutions: { [`decision:${dinnerA?.id}`]: 'keep' } };
  const alone = director.plan(main, state, { now: now() });
  check('alone: two_places', alone.continuity.warnings.some(w => w.code === 'two_places'));
  const both = director.plan({ kind: 'bundle', actions: [main, { kind: 'quick', button: 'cancel_tonight', source: 'code' }] }, state, { now: now() });
  check('with CANCEL TONIGHT (the earlier dinner) in the same batch: no two_places', !both.continuity.warnings.some(w => w.code === 'two_places'));
  check('… and the cancelled dinner is an open thread', both.continuity.threads.some(t => t.fate === 'cancelled' && /dinner A/.test(t.label)));
}

section('a part that touches a decision takes the pulse chain + decision lock, like its single form');
{
  let exclusive = 0;
  director.__setDepsForTest({ pulse: { exclusive: (fn) => { exclusive += 1; return fn(); }, rebase: () => {} } });
  const action = { kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, { kind: 'health', change: 'sick', days: 2, when: { inMinutes: 1200 } }] };
  const pv = await director.preview(action, { project: false, relax: true });
  let release;
  const held = withDecisionLock(() => new Promise((r) => { release = r; }));   // a pulse step mid-decision
  const before = count();
  let done = false;
  const applying = director.apply(pv.previewId, pv.fingerprint, { by: 'tester' }).then((r) => { done = true; return r; });
  await new Promise(r => setTimeout(r, 30));
  check('while the decision lock is held: the bundle waits, nothing appended', !done && count() === before);
  release();
  await held;
  const res = await applying;
  check('released: the bundle landed', res.ok === true && count() > before);
  eq('…inside pulse.exclusive', exclusive, 1);
  exclusive = 0;
  const pv2 = await director.preview({ kind: 'bundle', actions: [{ kind: 'quick', button: 'energised' }] }, { project: false, relax: true });
  await director.apply(pv2.previewId, pv2.fingerprint, { by: 'tester' });
  eq('a bundle of unlocked kinds runs without it', exclusive, 0);
  const { needsLocks } = director.__bundleTest;
  check('a retcon with a locked part locks; one without does not',
    needsLocks({ kind: 'retcon', to: { eventId: 1 }, actions: [{ kind: 'decision.pick', decisionId: 1, optionId: 'go' }] })
    && !needsLocks({ kind: 'retcon', to: { eventId: 1 }, actions: [{ kind: 'mood', preset: 'calm' }] }));
  director.__setDepsForTest({ pulse: null });
}

section('excluded kinds and shapes (planner and route)');
{
  for (const k of ['bundle', 'rewind', 'retcon', 'tray.adopt', 'proposal.approve', 'bookmark', 'bookmark.remove']) {
    const part = { kind: k };
    eq(`planner: a ${k} part → invalid bad_kind @1`, await codeOf(() => director.plan({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, part] }, state, { now: now() })),
      'invalid:bad_kind@1');
    eq(`route: a ${k} part → bad_kind with index 1`, partsProblem({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, part] }), { error: 'bad_kind', part: 1 });
  }
  eq('planner: six parts → bad_actions', await codeOf(() => director.plan({ kind: 'bundle', actions: Array(6).fill({ kind: 'quick', button: 'tired' }) }, state, { now: now() })), 'invalid:bad_actions');
  eq('route: no parts → bad_actions', actionProblem({ kind: 'bundle', actions: [] }), 'bad_actions');
  eq('route: a part with a bad shape → its own reason', partsProblem({ kind: 'bundle', actions: [{ kind: 'quick', button: 'nope' }] }), { error: 'bad_button', part: 0 });
  eq('route: a bad source', partsProblem({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired', source: 'model' }] }), { error: 'bad_source', part: 0 });
  eq('route: a well-formed bundle passes', actionProblem({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired', source: 'continuity' }] }), null);
  eq('planner: a scene from a tray claim can\'t ride (post step)', await codeOf(() => director.plan({ kind: 'bundle', actions: [{ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt: now() + 5 * HOUR, minutes: 60, fromReviewId: 3 }] }, state, { now: now() })),
    'invalid:bad_part@0');
  eq('planner: a part refusal keeps its index', await codeOf(() => director.plan({ kind: 'bundle', actions: [{ kind: 'quick', button: 'tired' }, { kind: 'goal.cancel', goalId: 99999 }] }, state, { now: now() })),
    'refused:no_goal@1');
  check('bundle is not prompt-draftable', !director.PROMPT_ACTION_KINDS.includes('bundle') && !director.PROMPT_ACTION_KINDS.includes('retcon'));
}

report();
