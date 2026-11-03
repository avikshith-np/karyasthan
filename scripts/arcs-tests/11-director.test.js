// 010 T020 — the Director (src/life/story/director.js, contracts/director-api.md
// §3–§4, research R12): the closed action catalogue, quick buttons, scene shapes
// and their validation, preview → apply with a fingerprint (apply re-plans at the
// preview's clock: +30 s and +5 min still apply, a material event makes it stale,
// an old preview expires), causes and origins inside a batch (owner events under
// one director.action; a tray adoption / scene from a claim keeps the chat origin),
// heavy scenes (themeAllowed, precondition, the raw-log 90-day cap), heavy.end.
//
// unit: a realistic log from the 009 life facade (example world, two simulated
// days, timers off), then the facade is stopped and the Director runs on a local
// projection + appender (story/index.js and the facade wiring are later waves).
// Invented, persona-neutral names only; no network, no models.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, exampleArcSeed,
  skipSimUnlessWired, DAY, HOUR,
} from './_helpers.js';
import { config } from '../../src/utils/config.js';
import { appendEvent, getEvent, listEvents } from '../../src/life/eventLog.js';
import { rebuild, applyAppended } from '../../src/life/projector.js';
import { heavyGuardActive } from '../../src/life/story/reducer.js';
import * as store from '../../src/life/story/store.js';
import * as director from '../../src/life/story/director.js';

await setupScratchDb();
const booted = await bootLife();
const { world, clock } = booted;
await simulateDays(1);
await simulateHours(7);               // Wed 28 Oct, early afternoon: a work day (office days 2,3,4)
await stopLife();

let state = rebuild({ world });
const append = (spec) => {
  const ev = appendEvent(spec);
  state = applyAppended(state, ev, { world });
  return ev;
};
const KNOWN = ['Quinlan Marsh', 'Rowan Vale'];
const seed = await exampleArcSeed();
director.__setDepsForTest({
  now: () => clock.now(), getState: () => state, world, append,
  knownNames: () => KNOWN, seed: () => seed, setClaimStatus: () => {},
});

async function codeOf(p) {
  try { await p; return null; } catch (e) { return `${e.code}:${e.reason}`; }
}
function codeOfSync(fn) {
  try { fn(); return null; } catch (e) { return `${e.code}:${e.reason}`; }
}

section('catalogue');
eq('8 quick buttons', director.QUICK_BUTTONS.length, 8);
eq('9 scene shapes', director.SCENE_SHAPES.length, 9);
eq('unknown action kind → invalid', codeOfSync(() => director.plan({ kind: 'delete_everything' }, state)), 'invalid:bad_action');
eq('unknown button → invalid', codeOfSync(() => director.plan({ kind: 'quick', button: 'win_lottery' }, state)), 'invalid:bad_button');

section('quick: tired — preview then apply (SC-004)');
{
  const pv = await director.preview({ kind: 'quick', button: 'tired' });
  check('preview has id, fingerprint, expiry', typeof pv.previewId === 'string' && /^[0-9a-f]{64}$/.test(pv.fingerprint) && pv.expiresAt > clock.now());
  eq('events: director.action + vitals.nudged', pv.events.map(e => e.type), ['director.action', 'vitals.nudged']);
  eq('nudge is owner, caused by the action', [pv.events[1].actor, pv.events[1].causeRef], ['owner', '$1']);
  eq('nudge payload', pv.events[1].payload, { delta: { energy: -25 }, reason: 'quick' });
  check('diff shows energy going down', pv.diff.some(d => d.path === 'vitals.energy' && d.to < d.from), pv.diff);
  clock.advance({ seconds: 30 });
  const res = await director.apply(pv.previewId, pv.fingerprint, { by: 'tester' });
  check('apply ok (+30 s)', res.ok === true && res.eventIds.length === 2);
  const evs = res.eventIds.map(getEvent);
  eq('appended exactly what the preview listed', evs.map(e => [e.type, e.actor, e.payload.delta ?? null]),
    pv.events.map(e => [e.type, e.actor, e.payload.delta ?? null]));
  eq('stamped at the preview clock', evs.map(e => e.at), pv.events.map(e => e.at));
  eq('action payload carries the fingerprint and count', [evs[0].payload.fingerprint, evs[0].payload.count], [pv.fingerprint, 1]);
  eq('nudge origin owner, cause = the action', [evs[1].originKind, evs[1].causeId], ['owner', evs[0].id]);
  eq('a used preview is gone', await codeOf(director.apply(pv.previewId, pv.fingerprint)), 'expired:expired_preview');
}

section('fingerprint: +5 min applies; a material event → stale; wrong fp → stale; old preview → expired');
{
  const pv = await director.preview({ kind: 'quick', button: 'energised' });
  clock.advance({ minutes: 5 });
  // A routine phone check in between is not material.
  append({ type: 'phone.check.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 120 } });
  const res = await director.apply(pv.previewId, pv.fingerprint);
  check('apply ok after 5 min and a phone check', res.ok === true);

  const pv2 = await director.preview({ kind: 'quick', button: 'tired' });
  eq('a forged fingerprint → stale', await codeOf(director.apply(pv2.previewId, 'f'.repeat(64))), 'stale:stale');
  append({ type: 'director.slider_set', at: clock.now(), actor: 'owner', payload: { slider: 'drama', value: 0.6 } });
  eq('a material event in between → stale', await codeOf(director.apply(pv2.previewId, pv2.fingerprint)), 'stale:stale');

  const pv3 = await director.preview({ kind: 'slider', name: 'drama', value: 0.7 });
  clock.advance({ minutes: 11 });
  eq('an 11-minute-old preview → expired', await codeOf(director.apply(pv3.previewId, pv3.fingerprint)), 'expired:expired_preview');
  eq('an unknown preview id → expired', await codeOf(director.apply('nope', pv3.fingerprint)), 'expired:expired_preview');
}

section('controls: fate, slider, pin, pause, reconciler mode, seed');
{
  const sl = await director.preview({ kind: 'slider', name: 'socialAppetite', value: 1.7 });
  eq('slider clamped to 0..1', sl.events[1].payload, { slider: 'socialAppetite', value: 1 });
  await director.apply(sl.previewId, sl.fingerprint);
  eq('slider folded', state.story.controls.sliders.socialAppetite, 1);
  eq('bad slider → invalid', codeOfSync(() => director.plan({ kind: 'slider', name: 'luck', value: 1 }, state)), 'invalid:bad_slider');

  // An open arc decision of the romance category, so freezing it expires the card.
  const now = clock.now();
  const open = append({
    type: 'decision.opened', at: now, actor: 'engine',
    payload: { kind: 'romance:step', subject: { eventAt: now + 3 * DAY, placeId: null, castIds: ['cast:flatmate'] }, opensAt: now,
      decideBy: now + 2 * DAY, ponrAt: now + 2 * DAY, mode: 'ask', category: 'romance', big: true,
      options: [{ id: 'step', label: 'Take the step', cost: {} }, { id: 'wait', label: 'Give it time', cost: {} }] },
  });
  const fz = await director.preview({ kind: 'fate', category: 'romance', mode: 'frozen' });
  eq('freeze: fate_set + the open arc decision expires (engine, frozen)',
    fz.events.map(e => [e.type, e.actor, e.payload.reason ?? null]),
    [['director.action', 'owner', null], ['director.fate_set', 'owner', null], ['decision.expired', 'engine', 'frozen']]);
  eq('the expiry is caused by the fate_set', fz.events[2].causeRef, '$2');
  const r = await director.apply(fz.previewId, fz.fingerprint);
  eq('decision closed as cancelled', state.decisions.get(open.id)?.status, 'cancelled');
  eq('expiry origin is self (owner cause → self, R3)', getEvent(r.eventIds[2]).originKind, 'self');
  eq('same fate again → refused nothing', codeOfSync(() => director.plan({ kind: 'fate', category: 'romance', mode: 'frozen' }, state)), 'refused:nothing');

  const pn = await director.preview({ kind: 'pin', pinKey: 'cast:flatmate' });
  await director.apply(pn.previewId, pn.fingerprint);
  check('pin folded', !!state.story.controls.pins['cast:flatmate']);
  eq('pin again → refused', codeOfSync(() => director.plan({ kind: 'pin', pinKey: 'cast:flatmate' }, state)), 'refused:nothing');
  eq('pin on an unknown cast → invalid', codeOfSync(() => director.plan({ kind: 'pin', pinKey: 'cast:nobody' }, state)), 'invalid:bad_pinKey');
  eq('cast.edit on a pinned member → a refusal, no events beyond the action',
    director.plan({ kind: 'cast.edit', castId: 'cast:flatmate', fields: { status: 'busy with a project' } }, state).refusals[0]?.reason, 'pinned');
  const pinnedPv = await director.preview({ kind: 'cast.edit', castId: 'cast:flatmate', fields: { status: 'busy with a project' } });
  eq('applying a fully refused preview → refused pinned', await codeOf(director.apply(pinnedPv.previewId, pinnedPv.fingerprint)), 'refused:pinned');
  const up = await director.preview({ kind: 'unpin', pinKey: 'cast:flatmate' });
  await director.apply(up.previewId, up.fingerprint);
  check('unpinned', !state.story.controls.pins['cast:flatmate']);

  const pa = await director.preview({ kind: 'pause', reason: 'a quiet week' });
  await director.apply(pa.previewId, pa.fingerprint);
  eq('paused', state.story.controls.paused, true);
  eq('pause reason with a jid → invalid', codeOfSync(() => director.plan({ kind: 'resume', reason: 'ask 15550001111@s.whatsapp.net' }, state)), 'invalid:jid_in_text');
  const re = await director.preview({ kind: 'resume' });
  await director.apply(re.previewId, re.fingerprint);
  eq('resumed', state.story.controls.paused, false);

  const rm = await director.preview({ kind: 'reconciler.mode', mode: 'review' });
  await director.apply(rm.previewId, rm.fingerprint);
  eq('reconciler mode folded', state.story.controls.reconcilerMode, 'review');
  eq('seed month 13 → invalid', codeOfSync(() => director.plan({ kind: 'seed.set', path: 'career.appraisalMonth', value: 13 }, state)), 'invalid:bad_value');
  eq('seed path not allow-listed → invalid', codeOfSync(() => director.plan({ kind: 'seed.set', path: 'heavy.themes', value: [] }, state)), 'invalid:bad_path');
  const ss = await director.preview({ kind: 'seed.set', path: 'career.appraisalMonth', value: 4 });
  await director.apply(ss.previewId, ss.fingerprint);
  eq('seed overlay folded', state.story.seedOverlay['career.appraisalMonth'], 4);
}

section('quick: free evening, rain, sick day, bad/good day, cancel tonight');
{
  const plan = state.plan;
  const work = (plan?.blocks ?? []).filter(b => b.kind === 'work' || b.kind === 'meeting');
  const workEnd = work.length ? Math.max(...work.map(b => b.end)) : null;
  check('fixture: a work day with work left', workEnd && workEnd > clock.now(), { workEnd, now: clock.now() });
  const fe = await director.preview({ kind: 'quick', button: 'free_evening' });
  const pm = fe.events.find(e => e.type === 'plan.made');
  const trimAt = Math.max(clock.now(), workEnd - 2 * HOUR);
  check('no work or meeting block runs past the trim point',
    pm.payload.blocks.every(b => !(['work', 'meeting'].includes(b.kind) && b.end > trimAt)), pm.payload.blocks.map(b => [b.kind, b.start, b.end]));
  check('the trimmed time became free', pm.payload.blocks.some(b => b.kind === 'free' && b.start === trimAt));
  eq('owner plan, work.late cleared', [pm.actor, pm.payload.workLate], ['owner', null]);
  await director.apply(fe.previewId, fe.fingerprint);
  eq('the projection runs the owner plan', state.plan.by, 'owner');
  eq('free evening after work is over → no work left',
    codeOfSync(() => director.plan({ kind: 'quick', button: 'free_evening' }, state, { now: workEnd + 60 })), 'refused:no_work_left');

  const rn = await director.preview({ kind: 'quick', button: 'rain' });
  const wc = rn.events[1];
  eq('rain: weather.changed rain until +3 h', [wc.type, wc.payload.rain, wc.payload.until - wc.at], ['weather.changed', true, 3 * HOUR]);
  await director.apply(rn.previewId, rn.fingerprint);
  eq('raining now', state.weather.rain, true);

  const bad = await director.preview({ kind: 'quick', button: 'bad_day_at_work' });
  eq('bad day: crunch + nudge', bad.events.slice(1).map(e => [e.type, e.payload.reason]), [['work.crunch', 'owner'], ['vitals.nudged', 'quick']]);
  const good = director.plan({ kind: 'quick', button: 'good_day_at_work' }, state);
  eq('good day nudge', good.events[1].payload.delta, { stress: -15, valence: 0.2, workPressure: -15 });

  const sk = await director.preview({ kind: 'quick', button: 'sick_day' });
  eq('sick day: 1 day, until a 04:00', [sk.events[1].type, sk.events[1].payload.days], ['sick.started', 1]);
  await director.apply(sk.previewId, sk.fingerprint);
  eq('already sick → refused', codeOfSync(() => director.plan({ kind: 'quick', button: 'sick_day' }, state)), 'refused:already_sick');

  eq('cancel tonight with no evening plan → refused nothing', codeOfSync(() => director.plan({ kind: 'quick', button: 'cancel_tonight' }, state)), 'refused:nothing');
  const now = clock.now();
  const eventAt = now + 4 * HOUR;
  const d = append({
    type: 'decision.opened', at: now, actor: 'engine',
    payload: { kind: 'movie', subject: { eventAt, placeId: 'place:cinema', castIds: ['cast:flatmate'] }, opensAt: now,
      decideBy: eventAt - HOUR, ponrAt: eventAt - 1800, mode: 'auto',
      options: [{ id: 'go', label: 'Go', cost: {}, expiresAt: eventAt - 1800 }, { id: 'late', label: 'Later', cost: {}, expiresAt: eventAt + 2 * HOUR }, { id: 'stay', label: 'Stay in', cost: {} }] },
  });
  append({ type: 'decision.committed', at: now, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, optionId: 'go', p: 0.9, by: 'early' } });
  const amended = append({ type: 'plan.made', at: now, actor: 'engine', causeId: d.id, payload: { ...state.plan, blocks: state.plan.blocks, amendedFor: d.id } });
  const ct = await director.preview({ kind: 'quick', button: 'cancel_tonight' });
  eq('cancel tonight: owner_cancelled + revert of the amended plan',
    ct.events.slice(1).map(e => [e.type, e.payload.reason, e.payload.targetId ?? null]),
    [['decision.expired', 'owner_cancelled', null], ['event.reverted', 'cancel_tonight', amended.id]]);
  await director.apply(ct.previewId, ct.fingerprint);
  eq('the committed outing is cancelled', state.decisions.get(d.id)?.status, 'cancelled');
  check('the amended plan is excluded', state.excluded.has(amended.id));
}

section('scenes: validation');
{
  const t0 = clock.now() + 26 * HOUR;
  eq('beat text with a jid → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'call @15550001111' }, state)), 'invalid:jid_in_text');
  eq('beat text naming a real person → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'met Quinlan at the shop' }, state)), 'invalid:real_person_name');
  // A zero-width character inside a name no longer splits it past the check.
  eq('beat text with a real name split by a zero-width space → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'met Quin\u200blan at the shop' }, state)), 'invalid:real_person_name');
  eq('…or a soft hyphen / ZWJ in a full name', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'met rowan va\u00adl\u200de at the shop' }, state)), 'invalid:real_person_name');
  eq('oversize text → invalid (not truncated)', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'x'.repeat(121) }, state)), 'invalid:too_long');
  eq('unknown cast → not_found', codeOfSync(() => director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:nobody', beatKind: 'news', text: 'hi' }, state)), 'not_found:cast');
  eq('outing in the past → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: [], startAt: clock.now() - 3600, minutes: 60 }, state)), 'invalid:bad_startAt');
  eq('outing minutes 5 → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: [], startAt: t0, minutes: 5 }, state)), 'invalid:bad_minutes');
  eq('new place far outside the region → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'new_place', name: 'Far Hut', placeKind: 'cafe', lat: 12.5, lon: 40 }, state)), 'invalid:region');
  eq('new cast with a real name → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'new_cast', name: 'Rowan Vale', relation: 'friend' }, state)), 'invalid:real_person_name');
  eq('new cast colliding with a cast name → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'new_cast', name: 'Flatmate Jones', relation: 'friend' }, state)), 'invalid:name_collision');
  eq('arc.stage skipping a stage → invalid', codeOfSync(() => {
    const ev = append({ type: 'arc.started', at: clock.now(), actor: 'engine', payload: { category: 'romance', kind: 'romance', castIds: ['cast:coworker-a'], stage: 'interested' } });
    director.plan({ kind: 'scene', shape: 'arc.stage', arcId: ev.id, to: 'dating' }, state);
  }), 'invalid:not_adjacent');
}

section('scenes: outing, visit, beat, new cast near a place');
{
  const t0 = clock.now() + 27 * HOUR;
  const out = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', castIds: ['cast:coworker-b'], startAt: t0, minutes: 90, label: 'Coffee catch-up' });
  eq('outing: opened + owner commit', out.events.slice(1).map(e => [e.type, e.actor]), [['decision.opened', 'owner'], ['decision.committed', 'owner']]);
  eq('outing options go/late/stay, social', [out.events[1].payload.options.map(o => o.id), out.events[1].payload.category], [['go', 'late', 'stay'], 'social']);
  check('warns: visible in every chat', out.warnings.includes(director.VISIBLE_EVERYWHERE));
  const r = await director.apply(out.previewId, out.fingerprint);
  const opened = getEvent(r.eventIds[1]);
  const d = state.decisions.get(opened.id);
  eq('decision committed by the owner (go)', [d?.status, d?.committed?.by, d?.committed?.optionId], ['committed', 'owner', 'go']);
  eq('commit payload names the decision', getEvent(r.eventIds[2]).payload.decisionId, opened.id);

  const vs = director.plan({ kind: 'scene', shape: 'visit', castIds: ['cast:parent'], startAt: t0 + 3 * HOUR, minutes: 120 }, state);
  eq('visit happens at home', vs.events[1].payload.subject.placeId, state.self.homePlaceId);

  const bt = await director.preview({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'trip', text: 'off on a short trip', until: clock.now() + 3 * DAY });
  await director.apply(bt.previewId, bt.fingerprint);
  eq('beat folded', state.story.castLife['cast:sibling']?.lastBeat?.kind, 'trip');

  const nc = await director.preview({ kind: 'scene', shape: 'new_cast', name: 'Emery Lark', relation: 'neighbour', pronouns: 'they/them' });
  eq('new cast id is a slug', nc.events[1].payload.id, 'cast:emery-lark');
  await director.apply(nc.previewId, nc.fingerprint);
  check('new cast exists', state.cast.has('cast:emery-lark'));
  const np = await director.preview({ kind: 'scene', shape: 'new_place', name: 'Corner Bakery', placeKind: 'cafe', near: 'place:cafe', offsetKm: 1 });
  await director.apply(np.previewId, np.fingerprint);
  check('new place exists near the cafe', state.places.has('place:corner-bakery'));
  const pe = await director.preview({ kind: 'place.edit', placeId: 'place:corner-bakery', name: 'The Corner Bakery' });
  await director.apply(pe.previewId, pe.fingerprint);
  eq('place renamed', state.places.get('place:corner-bakery')?.name, 'The Corner Bakery');
  const ch = await director.preview({ kind: 'cast.history', castId: 'cast:emery-lark', text: 'moved in next door last spring', dated: clock.now() - 200 * DAY });
  await director.apply(ch.previewId, ch.fingerprint);
  eq('history backdated', state.story.history['cast:emery-lark']?.[0]?.at, clock.now() - 200 * DAY);
}

section('a self-slice action survives a routine event between preview and apply');
{
  const romanceFrozen = state.story.controls.fate.romance === 'frozen';
  const cat = romanceFrozen ? 'social' : 'romance';
  const action = cat === 'romance'
    ? { kind: 'scene', shape: 'arc.start', category: 'romance', arcKind: 'romance', castIds: ['cast:emery-lark'] }
    : { kind: 'scene', shape: 'arc.start', category: 'social', fields: { kind: 'social' }, castIds: ['cast:emery-lark'] };
  const pv = await director.preview(action);
  clock.advance({ seconds: 45 });
  append({ type: 'phone.check.started', at: clock.now(), actor: 'engine', payload: { until: clock.now() + 60 } });
  const r = await director.apply(pv.previewId, pv.fingerprint);
  check(`arc.start (${cat}, slices incl. self) applies after a phone check`, r.ok === true);
  eq('a nested fields.kind works as the arc kind', director.plan({ kind: 'scene', shape: 'arc.start', category: 'social', fields: { kind: 'social' }, castIds: [] }, state).events[1]?.payload.kind, 'social');
}

section('apply is one transaction');
{
  const pv = await director.preview({ kind: 'quick', button: 'bad_day_at_work' });
  let failedHook = 0;
  let n = 0;
  const flaky = (spec) => { n += 1; if (n === 2) throw new Error('refused by the log'); return append(spec); };
  director.__setDepsForTest({ append: flaky, onApplyFailed: () => { failedHook += 1; state = rebuild({ world }); } });
  const before = listEvents({ order: 'desc', limit: 1, before: 10 ** 9 })[0].id;
  eq('a refusal half-way → conflict', await codeOf(director.apply(pv.previewId, pv.fingerprint)), 'conflict:apply_failed');
  eq('nothing of the batch stays in the log', listEvents({ order: 'desc', limit: 1, before: 10 ** 9 })[0].id, before);
  eq('the facade hook rebuilt the projection', [failedHook, state.lastEventId], [1, before]);
  director.__setDepsForTest({ append, onApplyFailed: null });
}

section('bookmarks');
{
  const bm = await director.preview({ kind: 'bookmark', name: 'before the trip' });
  await director.apply(bm.previewId, bm.fingerprint);
  const b = state.story.bookmarks.at(-1);
  eq('bookmark at the last event', b?.name, 'before the trip');
  const rm = await director.preview({ kind: 'bookmark.remove', bookmarkId: b.id });
  await director.apply(rm.previewId, rm.fingerprint);
  check('bookmark removed', !state.story.bookmarks.some(x => x.id === b.id));
  for (let i = 0; i < 30; i++) append({ type: 'director.bookmark', at: clock.now(), actor: 'owner', payload: { name: `b${i}`, eventId: state.lastEventId } });
  eq('31st bookmark → refused full', codeOfSync(() => director.plan({ kind: 'bookmark', name: 'one more' }, state)), 'refused:full');
}

section('heavy scene: forbidden theme, precondition, cap; heavy.end');
{
  eq('forbidden label → invalid forbidden_theme', codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'minor_accident', label: 'a funeral', durationDays: 3 }, state)), 'invalid:forbidden_theme');
  eq('job_loss (deferred) → invalid forbidden_theme', codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'job_loss', label: 'laid off', durationDays: 3 }, state)), 'invalid:forbidden_theme');
  eq('breakup while single → refused heavy_precondition', codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'breakup', label: 'it ended', durationDays: 5 }, state)), 'refused:heavy_precondition');
  eq('31 days → invalid', codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'pet_loss', label: 'a sad week', durationDays: 31 }, state)), 'invalid:bad_heavy');
  const hv = await director.preview({ kind: 'scene', shape: 'heavy', heavyKind: 'money_setback', label: 'an unexpected repair bill', durationDays: 5 });
  eq('heavy.started (owner, heavy) + its effect (engine)', hv.events.slice(1).map(e => [e.type, e.actor, !!e.heavy]),
    [['heavy.started', 'owner', true], ['money.spent', 'engine', false]]);
  eq('the effect is caused by heavy.started', hv.events[2].causeRef, hv.events[1].ref);
  const r = await director.apply(hv.previewId, hv.fingerprint);
  const started = getEvent(r.eventIds[1]);
  eq('stored heavy, origin owner', [started.heavy, started.originKind], [true, 'owner']);
  check('heavy guard active', heavyGuardActive(state, clock.now()));
  eq('a second heavy scene inside 90 days → refused heavy_cap',
    codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'pet_loss', label: 'a sad week', durationDays: 3 }, state)),
    'refused:heavy_active');
  const end = await director.preview({ kind: 'heavy.end', heavyId: started.id });
  eq('heavy.end: owner heavy.ended {reason:owner}', [end.events[1].type, end.events[1].payload.reason], ['heavy.ended', 'owner']);
  await director.apply(end.previewId, end.fingerprint);
  check('heavy guard off', !heavyGuardActive(state, clock.now()));
  eq('after the end, still inside 90 days → refused heavy_cap',
    codeOfSync(() => director.plan({ kind: 'scene', shape: 'heavy', heavyKind: 'pet_loss', label: 'a sad week', durationDays: 3 }, state)),
    'refused:heavy_cap');
  eq('heavy.end with none active → refused', codeOfSync(() => director.plan({ kind: 'heavy.end' }, state)), 'refused:no_heavy');
}

section('tray adoption and a scene from a claim keep the chat origin');
{
  const dm = '15550002222@s.whatsapp.net';
  const now = clock.now();
  const { getDb } = await import('../../src/memory/db.js');
  const mkClaim = () => {
    const claimId = Number(getDb().prepare(`INSERT INTO life_claims (chat_jid, origin_kind, origin_jid, reply_msg_id, text, kind, p, status, created_at)
      VALUES (?, 'dm', ?, ?, 'ok see you at the cafe tomorrow', 'commitment', 0.9, 'flagged', ?)`).run(dm, dm, `MSG${now}${Math.random()}`, now).lastInsertRowid);
    const flagged = append({ type: 'claim.flagged', at: now, actor: 'chat', originKind: 'dm', originJid: dm, payload: { claimId } });
    const { id } = store.createReview({ claimId, claimEventId: flagged.id, chatJid: dm, originKind: 'dm', originJid: dm, createdAt: now, status: 'tray' });
    store.updateReview(id, {
      reason: 'review_mode',
      extraction: { type: 'plan', kind: 'coffee', summary: 'SECRET-SUMMARY coffee with a friend', people: [] },
      resolution: { placeId: 'place:cafe', castIds: ['cast:coworker-a'], subjectJid: dm, span: { start: now + 30 * HOUR, end: now + 31 * HOUR } },
    });
    return { claimId, reviewId: id, flaggedId: flagged.id };
  };
  const c1 = mkClaim();
  const ta = await director.preview({ kind: 'tray.adopt', reviewId: c1.reviewId });
  eq('adoption chain first, director.action last',
    ta.events.map(e => [e.type, e.actor]),
    [['claim.adopted', 'engine'], ['decision.opened', 'engine'], ['decision.lean', 'engine'], ['decision.committed', 'engine'], ['director.action', 'owner']]);
  eq('claim.adopted is caused by the claim pointer', ta.events[0].causeId, c1.flaggedId);
  check('no clerk summary in any descriptor', !JSON.stringify(ta.events).includes('SECRET-SUMMARY'));
  const r = await director.apply(ta.previewId, ta.fingerprint, { by: 'tester' });
  const evs = r.eventIds.map(getEvent);
  check('every adoption event carries the DM origin', evs.slice(0, 4).every(e => e.originKind === 'dm' && e.originJid === dm), evs.map(e => e.originKind));
  check('…and the resolved subject', evs.slice(0, 4).every(e => e.subjectJid === dm));
  eq('the action lists their ids', evs[4].payload.eventIds, r.eventIds.slice(0, 4));
  const rv = store.getReview(c1.reviewId);
  eq('review adopted, pointing at claim.adopted', [rv.status, rv.adoptedEventId], ['adopted', r.eventIds[0]]);
  const dec = state.decisions.get(r.eventIds[1]);
  eq('adopted decision committed by:adopted', [dec?.adopted, dec?.committed?.by], [true, 'adopted']);
  eq('adopting it again → conflict', codeOfSync(() => director.plan({ kind: 'tray.adopt', reviewId: c1.reviewId }, state)), 'conflict:review_state');

  const c2 = mkClaim();
  const draft = director.sceneDraftFromReview(c2.reviewId);
  eq('scene draft: structured ids only', Object.keys(draft).sort(), ['castIds', 'fromReviewId', 'kind', 'minutes', 'placeId', 'shape', 'startAt']);
  check('draft holds no claim/extraction text', !JSON.stringify(draft).match(/SECRET|cafe tomorrow/));
  const sc = await director.preview({ ...draft });
  check('scene from a claim warns it was built from a claim', sc.warnings.includes(director.FROM_CLAIM));
  const r2 = await director.apply(sc.previewId, sc.fingerprint);
  check('outing scene from a claim: engine events keep the DM origin', r2.eventIds.slice(0, 4).map(getEvent).every(e => e.originKind === 'dm'));

  const c3 = mkClaim();
  const bt = director.plan({ kind: 'scene', shape: 'cast.beat', castId: 'cast:sibling', beatKind: 'news', text: 'had good news', fromReviewId: c3.reviewId }, state);
  check('a non-outing scene from a claim warns: visible in every chat + built from a claim',
    bt.warnings.includes(director.VISIBLE_EVERYWHERE) && bt.warnings.includes(director.FROM_CLAIM));

  const c5 = mkClaim();
  // The owner's committed coffee outing (scenes section) occupies its window.
  const busy = [...state.decisions.values()].find(d => d.committed?.by === 'owner' && d.kind === 'hangout' && d.status === 'committed');
  const at = busy.subject.eventAt + 15 * 60;
  store.updateReview(c5.reviewId, { resolution: { placeId: 'place:park', castIds: [], subjectJid: null, span: { start: at, end: at + HOUR } } });
  const cf = director.plan({ kind: 'tray.adopt', reviewId: c5.reviewId }, state);
  eq('an adoption overlapping a committed plan → refused (calendar conflict), nothing appended',
    [cf.refusals[0]?.reason, cf.events.length], ['conflict', 0]);

  const c4 = mkClaim();
  store.updateReview(c4.reviewId, { extraction: { type: 'health', kind: 'sick', summary: 'x', people: [] } });
  eq('an out-of-scope type cannot be adopted', codeOfSync(() => director.plan({ kind: 'tray.adopt', reviewId: c4.reviewId }, state)), 'refused:out_of_scope');
}

section('preview tomorrow through the Director (no writes)');
{
  const before = listEvents({ order: 'desc', limit: 1, before: state.lastEventId + 1 })[0]?.id;
  const t = await director.previewTomorrow();
  eq('24 h window', t.to - t.from, 24 * HOUR);
  check('planned blocks', Array.isArray(t.planned) && t.planned.length > 0);
  eq('notes', t.notes, ['no model calls', 'nothing written']);
  eq('nothing appended', listEvents({ order: 'desc', limit: 1, before: 10 ** 9 })[0]?.id, before);
}

section('not running');
{
  director.__setDepsForTest({ getState: () => null });
  eq('preview with no projection → not_running', await codeOf(director.preview({ kind: 'quick', button: 'tired' })), 'not_running:null');
  director.__setDepsForTest({ getState: () => state });
}

if (!(await skipSimUnlessWired())) {
  // Through the wired facade (T024): the story facade's Director on the live engine.
  section('sim: a quick button through the life facade');
  director.__setDepsForTest(null);
  await setupScratchDb();
  const sim = await bootLife();
  await simulateHours(6);
  const story = await import('../../src/life/story/index.js');
  const energy0 = sim.life.getState().vitals.energy;
  const p = await story.director.preview({ kind: 'quick', button: 'tired' });
  sim.clock.advance({ seconds: 30 });
  const r = await story.director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('applied through the facade', r.ok === true && r.eventIds.length === 2);
  eq('the nudge is an owner event under the action', [getEvent(r.eventIds[1]).originKind, getEvent(r.eventIds[1]).causeId], ['owner', r.actionEventId]);
  check('the live projection folded it', sim.life.getState().vitals.energy < energy0);
  await stopLife();
}

void config; void DAY;
report();
