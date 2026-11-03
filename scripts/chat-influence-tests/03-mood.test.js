// 012 mood (plan §P1.2): per-event and total clamps, the 30-min half-life,
// same-sender damping (LID and PN forms are one sender), base vitals untouched
// (mood.chat is non-integrating; the overlay lives only in views), every view
// agrees (advanceTo / vitalsAt / sharedView, also at at == state.at) and
// moodScale 0 means no blip at all.
import { setupScratchDb, bootInfluence, say, eventsOf, section, check, eq, near, report } from './_helpers.js';

await setupScratchDb();
const mood = await import('../../src/life/influence/mood.js');
const projector = await import('../../src/life/projector.js');
const { eventsAfter } = await import('../../src/life/eventLog.js');

section('bounds (pure)');
let worst = { v: 0, s: 0, soc: 0 };
for (const a of mood.AFFECTS) for (const i of mood.INTENSITIES) for (const scale of [0, 0.5, 1, 7]) {
  const d = mood.deltaFor(a, i, { scale, damp: 1 });
  worst = { v: Math.max(worst.v, Math.abs(d.valence)), s: Math.max(worst.s, Math.abs(d.stress)), soc: Math.max(worst.soc, Math.abs(d.social)) };
}
check('per event: |valence| ≤ 0.06, |stress| ≤ 4, |social| ≤ 3 (scale > 1 is clamped to 1)', worst.v <= 0.06 && worst.s <= 4 && worst.soc <= 3, worst);
eq('unknown affect → no delta', mood.deltaFor('stab', 'high'), null);
const many = Array.from({ length: 30 }, (_, i) => ({ at: 1000 + i, dv: -0.06, ds: 4, dsoc: -3 }));
const tot = mood.overlayAt(many, 1030);
check('the whole overlay is clamped (valence ≥ −0.15, stress ≤ +10, social ≥ −6)', tot.valence === -0.15 && tot.stress === 10 && tot.social === -6, tot);
const up = mood.overlayAt(Array.from({ length: 30 }, (_, i) => ({ at: 1000 + i, dv: 0.06, ds: -2, dsoc: 3 })), 1030);
check('…both ways (valence ≤ +0.15, stress ≥ −5, social ≤ +6)', up.valence === 0.15 && up.stress === -5 && up.social === 6, up);
near('half-life: half left after 30 min', mood.decay(0, 1800), 0.5);
check('…more than 93 % gone after 2 h', 1 - mood.decay(0, 7200) > 0.93);
eq('…nothing from a future blip', mood.decay(100, 50), 0);
eq('damping: 1, ½, then ¼', [0, 1, 2, 5].map(mood.dampFor), [1, 0.5, 0.25, 0.25]);

section('damping through the facade');
const t = await bootInfluence();
const s0 = await eventsOf(['mood.chat']);
void s0;
for (const [sender, id] of [[t.A, 'D1'], [t.A, 'D2'], ['15550007201@s.whatsapp.net', 'D3']]) {
  await say(t, { chat: t.GROUP, sender, text: 'you absolute clown, again', id, mentioned: ['10000000000@s.whatsapp.net'] });
  t.clock.advance({ minutes: 5 });
}
let blips = await eventsOf(['mood.chat']);
eq('same sender within an hour: 1 → ½ → ¼ (the PN form is the same person)', blips.map(e => e.payload.damp), [1, 0.5, 0.25]);
eq('…all with that one canonical subject', [...new Set(blips.map(e => e.subjectJid))], [t.A]);
eq('…deltas scaled by the damping', blips.map(e => e.payload.delta.valence), [-0.04, -0.02, -0.01]);
await say(t, { chat: t.GROUP, sender: t.B, text: 'you absolute clown, honestly', id: 'D4', mentioned: ['10000000000@s.whatsapp.net'] });
eq('another sender is not damped', (await eventsOf(['mood.chat'])).at(-1).payload.damp, 1);
t.clock.advance({ minutes: 61 });
await say(t, { chat: t.GROUP, sender: t.A, text: 'you absolute clown, an hour on', id: 'D5', mentioned: ['10000000000@s.whatsapp.net'] });
eq('…and the first sender is full strength again after an hour', (await eventsOf(['mood.chat'])).at(-1).payload.damp, 1);

section('base vitals untouched; every view agrees');
const world = t.world;
const live = projector.rebuild({ world });
const all = eventsAfter(0, 100000);
let plain = projector.createInitialState(world);
for (const ev of all) if (ev.type !== 'mood.chat' && ev.type !== 'chat.perceived') plain = projector.project(plain, ev, world);
eq('the projection\'s own vitals equal a fold without any blip', live.vitals, plain.vitals);
eq('…and its time anchor (blips never move s.at)', live.at, plain.at);
check('the blips are kept as overlay entries', Array.isArray(live.chatMood) && live.chatMood.length >= 3);
const at = t.clock.now();
const view = projector.advanceTo(live, at, world);
const baseView = projector.advanceTo(live, at, world, { chatMood: false });
const ov = mood.overlayAt(live.chatMood, at);
check('advanceTo adds the decayed overlay', !!ov && Math.abs(view.vitals.mood.valence - Math.max(-1, baseView.vitals.mood.valence + ov.valence)) < 1e-9
  && Math.abs(view.vitals.stress - Math.min(100, Math.max(0, baseView.vitals.stress + ov.stress))) < 1e-9, { view: view.vitals.mood, base: baseView.vitals.mood, ov });
eq('…keeps the base vitals beside it', view.vitalsBase, baseView.vitals);
eq('vitalsAt(at) = advanceTo(at).vitals with blips present', projector.vitalsAt(live, at, world), view.vitals);
const atS = projector.advanceTo(live, live.at, world);
const ovS = mood.overlayAt(live.chatMood, live.at);
check('…also at at == state.at (no integration, overlay still on)', !!ovS && atS.vitals.mood.valence !== live.vitals.mood.valence
  && JSON.stringify(projector.vitalsAt(live, live.at, world)) === JSON.stringify(atS.vitals));
const shared = projector.sharedView(live, at, world);
eq('sharedView agrees', [shared.vitals, shared.vitalsBase], [view.vitals, view.vitalsBase]);
const { jevState } = await import('../../src/life/decisions.js');
const d = { kind: 'movie', subject: {}, options: [], status: 'open' };
check('jevState.mood reflects the overlay', jevState(d, view, at, {}).mood !== jevState(d, baseView, at, {}).mood);
check('serializeState never stores the overlay or the base copy', !('vitalsBase' in projector.serializeState(view)));

section('moodScale');
t.config.chatInfluence.moodScale = 0;
const n0 = (await eventsOf(['mood.chat'])).length;
await say(t, { chat: t.GROUP, sender: t.C, text: 'you absolute clown, scale zero', id: 'Z1', mentioned: ['10000000000@s.whatsapp.net'] });
eq('moodScale 0 → no blip (no pointer either)', [(await eventsOf(['mood.chat'])).length - n0,
  (await eventsOf(['chat.perceived'])).filter(e => e.payload.msgId === 'Z1').length], [0, 0]);
t.config.chatInfluence.moodScale = 0.5;
await say(t, { chat: t.GROUP, sender: t.C, text: 'you absolute clown, half scale', id: 'Z2', mentioned: ['10000000000@s.whatsapp.net'] });
eq('moodScale 0.5 halves it', (await eventsOf(['mood.chat'])).at(-1).payload.delta.valence, -0.02);
t.config.chatInfluence.moodScale = 1;

section('area off');
t.config.chatInfluence.mood = false;
check('mood off → the overlay closes for every view', !('vitalsBase' in t.life.getState()));
const calls0 = t.jev.calls.length;
await say(t, { chat: t.GROUP, sender: t.C, text: 'you absolute clown, mood off', id: 'Z3', mentioned: ['10000000000@s.whatsapp.net'] });
eq('…and no perception is asked (nothing would consume it)', t.jev.calls.length - calls0, 0);
t.config.chatInfluence.mood = true;

report();
