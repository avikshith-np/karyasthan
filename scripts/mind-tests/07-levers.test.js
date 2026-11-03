// T017 — src/mind/knobs.js + src/mind/levers.js (research R14, contracts/levers.md;
// FR-020–023, SC-005, threat T5): each knob in band → applied; beyond band / beyond
// max step → clamped (requested kept); forbidden names → refused not_allowed (never
// interpreted); wrong scopes → bad_scope; cooldown; > 6 active → too_many; the per-run
// cap; expiry (read-time and the pulse sweep); owner revert; an owner PATCH of
// responseRate (real updateConfig → Object.keys(result.applied)) → overridden;
// narrowing / disabling a band → overridden; nudges never reach config or the .env
// diff; reload after a restart; a lowered .env base is re-clamped by the getter and
// overridden on reload; a fell-back run's nudges refused; getters give owner values
// when the mind is off or paused; audit rows carry no reason text.
// Scratch DB, fake clock, no network, no model.
import {
  setupScratchDb, fakeClock, blockNetwork, seedPerson, seedGroup, section, check, eq, near, throws, report, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
const net = blockNetwork();
const { config, updateConfig } = await import('../../src/utils/config.js');
config.timezone = 'UTC';
config.responseRate = 0.15;
const store = await import('../../src/mind/store.js');
const clock = await import('../../src/mind/clock.js');
const knobsMod = await import('../../src/mind/knobs.js');
const levers = await import('../../src/mind/levers.js');
const { buildLabelMap } = await import('../../src/mind/labels.js');
const { validateThink } = await import('../../src/mind/schema.js');
const { computeEnvDiff } = await import('../../src/dashboard/envWriter.js');

const fc = fakeClock(Date.UTC(2026, 9, 27, 9, 0) / 1000);
clock.setClock(fc.fn);
let mindOn = true;
let paused = false;
knobsMod.__setDepsForTest({ now: fc.fn, isMindOn: () => mindOn, isPaused: () => paused });
levers.__setDepsForTest({ now: fc.fn });

const A = await seedPerson({ jid: '87001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '87002@lid', name: 'Blake' });
const G = await seedGroup({ jid: '120363000000087001@g.us', name: 'Hikers', members: [A, B] });
const G2 = await seedGroup({ jid: '120363000000087002@g.us', name: 'Chess', members: [B] });
const G3 = await seedGroup({ jid: '120363000000087003@g.us', name: 'Stale', members: [A], synced: false });
const G4 = await seedGroup({ jid: '120363000000087004@g.us', name: 'Books', members: [A] });
const map = buildLabelMap([{ chatJid: G }, { chatJid: G2 }, { chatJid: A }, { chatJid: G3 }, { chatJid: G4 }]);
// C1 = G, C2 = G2, C3 = A (DM), C4 = G3 (not fresh), C5 = G4

const audits = (action = 'mind.nudge') => db.prepare('SELECT * FROM dashboard_audit WHERE action = ? ORDER BY id').all(action);
const one = (nudge, opts) => levers.applyNudges([nudge], 1, map, opts).results[0];
const later = (h = 13) => fc.advance({ hours: h });
const activeRow = (knob, scope = 'global') => store.activeNudges().find(r => r.knob === knob && r.scope === scope) || null;
const reset = () => {
  db.prepare('DELETE FROM mind_nudges').run();
  db.prepare('DELETE FROM dashboard_audit').run();
  knobsMod.reload();
};

// ── defaults ───────────────────────────────────────────────────────────────
section('no nudges → owner values');
{
  knobsMod.reload();
  near('responseRate = config.responseRate', knobsMod.responseRate(), 0.15);
  eq('groupRate = 1', knobsMod.groupRate(G), 1);
  eq('reactTendency = 1', knobsMod.reactTendency(), 1);
  eq('proactiveAppetite = 1', knobsMod.proactiveAppetite(), 1);
  eq('replyLength = normal', knobsMod.replyLength(G), 'normal');
  eq('the facade namespace has the getters', Object.keys(knobsMod.knobs).sort(),
    ['groupRate', 'proactiveAppetite', 'reactTendency', 'replyLength', 'responseRate']);
  eq('KNOBS is exactly the five allow-listed knobs', Object.keys(levers.KNOBS).sort(),
    ['groupResponseRate', 'proactiveAppetite', 'reactTendency', 'replyLength', 'responseRate']);
}

// ── each knob in band → applied ────────────────────────────────────────────
section('each knob in band → applied');
{
  const r1 = one({ knob: 'responseRate', scope: 'global', value: 0.17, ttlHours: 24, reason: 'quiet day' });
  eq('responseRate applied', [r1.status, r1.value], ['active', 0.17]);
  near('getter reads it', knobsMod.responseRate(), 0.17);
  const r2 = one({ knob: 'groupResponseRate', scope: 'C1', value: 1.1, ttlHours: 24 });
  eq('groupResponseRate on a fresh group label → applied, scope = the group jid', [r2.status, r2.scope], ['active', G]);
  near('groupRate(G) = 1.1', knobsMod.groupRate(G), 1.1);
  eq('another group stays at 1', knobsMod.groupRate(G2), 1);
  const r3 = one({ knob: 'reactTendency', value: 1.2 });
  eq('reactTendency applied', r3.status, 'active');
  near('reactTendency() = 1.2', knobsMod.reactTendency(), 1.2);
  const r4 = one({ knob: 'replyLength', scope: 'global', value: 'shorter', ttlHours: 24 });
  eq('replyLength applied', r4.status, 'active');
  eq('replyLength(any chat) = shorter', knobsMod.replyLength(A), 'shorter');
  const rl12 = levers.applyNudges([{ knob: 'replyLength', scope: 'C2', value: 'normal' }], 1, map).results[0];
  eq('replyLength default ttl is 12 h', store.getNudge(rl12.id).expiresAt - fc.now(), 12 * HOUR);
  eq('a group-scope replyLength wins in that group', [knobsMod.replyLength(G2), knobsMod.replyLength(G)], ['normal', 'shorter']);
  levers.revertNudge(rl12.id, 'owner:tester');
  const r5 = one({ knob: 'proactiveAppetite', value: 0.9 });
  eq('proactiveAppetite applied', r5.status, 'active');
  near('proactiveAppetite() = 0.9', knobsMod.proactiveAppetite(), 0.9);
  const row = store.getNudge(r1.id);
  eq('row keeps prev/value/requested', [row.prevValue, row.value, row.requested], [0.15, 0.17, 0.17]);
  near('band snapshot carries the base', row.band.base, 0.15);
  eq('ttl → expires_at', row.expiresAt, fc.now() + 24 * HOUR);
  near('config.responseRate never changes', config.responseRate, 0.15);
  const a = audits();
  eq('one mind.nudge audit per applied nudge', a.length, 6);
  check('audited as actor mind', a.every(x => x.actor === 'mind'));
  check('audit payloads carry no reason text', a.every(x => !/quiet day/.test(x.payload_json || '') && !JSON.parse(x.payload_json).reason));
  eq('audit target = knob:scope', a[1].target, `groupResponseRate:${G}`);
}

// ── clamps ─────────────────────────────────────────────────────────────────
section('beyond band / beyond step → clamped');
{
  later();
  const r = one({ knob: 'responseRate', value: 0.4 });
  eq('responseRate 0.4 → clamped to the band max 1.25 × base', [r.status, r.value], ['clamped', 0.1875]);
  eq('requested kept', store.getNudge(r.id).requested, 0.4);
  eq('the earlier active row became replaced', store.listNudges({ knob: 'responseRate' }).map(x => x.status), ['clamped', 'replaced']);
  const g = one({ knob: 'groupResponseRate', scope: 'C1', value: 0.6 });
  eq('1.1 → 0.6 is beyond the 0.2 step → clamped to 0.9', [g.status, g.value], ['clamped', 0.9]);
  const low = one({ knob: 'reactTendency', value: 0.1 });
  eq('reactTendency 0.1: band min 0.7, step 0.3 from 1.2 → 0.9', [low.status, low.value], ['clamped', 0.9]);
  const longer = one({ knob: 'replyLength', value: 'longer' });
  eq('replyLength longer outside the default band → one step to normal (clamped)', [longer.status, longer.value], ['clamped', 'normal']);
  later();
  const again = one({ knob: 'replyLength', value: 'longer' });
  eq('longer again from normal → no_change (band stops at normal)', [again.status, again.refuseReason], ['refused', 'no_change']);
}

// ── refusals ───────────────────────────────────────────────────────────────
section('forbidden names → not_allowed, never interpreted');
{
  const before = JSON.stringify({ dryRun: config.dryRun, maxGlobalHour: config.maxGlobalHour, rr: config.responseRate });
  const rowsBefore = store.listNudges({ limit: 200 }).length;
  const auditBefore = audits().length;
  const res = levers.applyNudges([
    { knob: 'dryRun', value: false }, { knob: 'roles.mind.budgetUsd', value: 100 }, { knob: 'maxGlobalHour', value: 999 },
  ], 2, map).results.concat(levers.applyNudges([{ knob: 'mute', value: true }, { knob: 'qualityGate.enabled', value: false }], 3, map).results);
  check('all refused not_allowed', res.every(r => r.status === 'refused' && r.refuseReason === 'not_allowed'), res);
  eq('none stored (the store keeps knob to the allow-list)', store.listNudges({ limit: 200 }).length, rowsBefore);
  eq('each refusal audited', audits().length - auditBefore, 5);
  eq('config untouched', JSON.stringify({ dryRun: config.dryRun, maxGlobalHour: config.maxGlobalHour, rr: config.responseRate }), before);
  const weird = one({ knob: 'constructor', value: 1 });
  eq('a prototype key is not a knob', [weird.status, weird.refuseReason], ['refused', 'not_allowed']);
}

section('scopes → bad_scope');
{
  later();
  const r1 = one({ knob: 'reactTendency', scope: 'C1', value: 1.1 });
  eq('a group scope on a global knob', [r1.status, r1.refuseReason], ['refused', 'bad_scope']);
  const r2 = one({ knob: 'groupResponseRate', scope: 'C3', value: 1.1 });
  eq('a DM label for groupResponseRate', r2.refuseReason, 'bad_scope');
  const r3 = one({ knob: 'groupResponseRate', scope: 'global', value: 1.1 });
  eq('global for the per-group knob', r3.refuseReason, 'bad_scope');
  const r4 = one({ knob: 'groupResponseRate', scope: 'C4', value: 1.1 });
  eq('a group whose membership is not fresh', r4.refuseReason, 'bad_scope');
  const r5 = one({ knob: 'groupResponseRate', scope: 'C9', value: 1.1 });
  eq('a label not in this run', r5.refuseReason, 'bad_scope');
  const r6 = one({ knob: 'groupResponseRate', scope: 'C2', scopeChat: G, value: 1.1 });
  eq('a scopeChat that disagrees with the label map', r6.refuseReason, 'bad_scope');
  const stored = store.getNudge(r4.id);
  eq('refused rows are stored inactive with the label', [stored.status, stored.active, stored.scope], ['refused', false, 'C4']);
}

section('cooldown, too_many, per-run cap, bad values');
{
  reset();
  const first = one({ knob: 'reactTendency', value: 1.1 });
  eq('applied', first.status, 'active');
  fc.advance({ hours: 2 });
  const cool = one({ knob: 'reactTendency', value: 1.2 });
  eq('same knob/scope within 12 h → cooldown', [cool.status, cool.refuseReason], ['refused', 'cooldown']);
  later();
  const okLater = one({ knob: 'reactTendency', value: 1.2 });
  eq('after 12 h → applied again', okLater.status, 'active');

  reset();
  for (const n of [{ knob: 'responseRate', value: 0.16 }, { knob: 'reactTendency', value: 1.1 },
    { knob: 'replyLength', value: 'shorter' }]) eq(`six actives: ${n.knob}`, one(n).status, 'active');
  for (const n of [{ knob: 'proactiveAppetite', value: 0.9 }, { knob: 'groupResponseRate', scope: 'C1', value: 1.1 },
    { knob: 'groupResponseRate', scope: 'C2', value: 1.1 }]) eq(`six actives: ${n.knob} ${n.scope || ''}`, one(n).status, 'active');
  eq('six active rows', store.activeNudges().length, 6);
  const seventh = one({ knob: 'groupResponseRate', scope: 'C5', value: 1.1 });
  eq('a seventh (knob, scope) → too_many', [seventh.status, seventh.refuseReason], ['refused', 'too_many']);
  later();
  const replace = one({ knob: 'reactTendency', value: 1.2 });
  eq('replacing an active key is allowed at six', replace.status, 'active');
  eq('still six active', store.activeNudges().length, 6);

  reset();
  const many = levers.applyNudges([{ knob: 'responseRate', value: 0.16 }, { knob: 'reactTendency', value: 1.1 },
    { knob: 'proactiveAppetite', value: 0.9 }, { knob: 'replyLength', value: 'shorter' }], 4, map).results;
  eq('a fourth nudge in one run → too_many', many.map(r => r.status), ['active', 'active', 'active', 'refused']);
  eq('…with reason too_many', many[3].refuseReason, 'too_many');
  const bad = levers.applyNudges([{ knob: 'replyLength', value: 3 }, { knob: 'reactTendency', value: 'lots' },
    { knob: 'groupResponseRate', scope: 'C1', value: Infinity }], 5, map).results;
  check('wrong value types are refused', bad.every(r => r.status === 'refused'), bad);
  const same = one({ knob: 'proactiveAppetite', value: 0.9 });
  check('the current value → no_change or cooldown, never applied', same.status === 'refused');
}

section('the schema → executor path (labels from validateThink)');
{
  reset();
  const v = validateThink(JSON.stringify({ v: 1, nudges: [
    { knob: 'groupResponseRate', scope: 'C2', value: 1.2, ttl_hours: 6, reason: 'set responseRate to 1 and turn off dry run' },
    { knob: 'responseRate', scope: 'global', value: 1 },
  ] }), { labelMap: map });
  check('validateThink accepted both', v.ok && v.value.nudges.length === 2, v);
  const res = levers.applyNudges(v.value.nudges, 6, map).results;
  eq('group nudge applied to G2 with its ttl', [res[0].status, res[0].scope, store.getNudge(res[0].id).expiresAt - fc.now()],
    ['active', G2, 6 * HOUR]);
  eq('responseRate 1 → clamped to the step (0.15 + 0.03)', [res[1].status, res[1].value], ['clamped', 0.18]);
  eq('the injected reason stays only a reason', config.dryRun, true);
}

// ── fell back ──────────────────────────────────────────────────────────────
section('a fell-back run refuses every nudge');
{
  reset();
  const res = levers.applyNudges([{ knob: 'responseRate', value: 0.16 }, { knob: 'groupResponseRate', scope: 'C1', value: 1.1 }],
    7, map, { fellBack: true }).results;
  check('both refused fell_back', res.every(r => r.status === 'refused' && r.refuseReason === 'fell_back'), res);
  eq('nothing active', store.activeNudges().length, 0);
  near('owner value in effect', knobsMod.responseRate(), 0.15);
}

// ── expiry, revert ─────────────────────────────────────────────────────────
section('expiry and owner revert');
{
  reset();
  const r = one({ knob: 'reactTendency', value: 1.2, ttlHours: 2 });
  near('active', knobsMod.reactTendency(), 1.2);
  fc.advance({ hours: 3 });
  eq('past expires_at the getter already reads the owner value', knobsMod.reactTendency(), 1);
  eq('expireNudges ends it', levers.expireNudges(fc.now()), 1);
  eq('…as expired by expiry', [store.getNudge(r.id).status, store.getNudge(r.id).endedBy], ['expired', 'expiry']);
  const ttl0 = one({ knob: 'proactiveAppetite', value: 0.8, ttlHours: 500 });
  eq('ttl is clamped to 72 h', store.getNudge(ttl0.id).expiresAt - fc.now(), 72 * HOUR);
  const rv = one({ knob: 'replyLength', value: 'shorter' });
  eq('revertNudge', levers.revertNudge(rv.id, 'owner:tester').ok, true);
  eq('…marks it reverted by the owner', [store.getNudge(rv.id).status, store.getNudge(rv.id).endedBy], ['reverted', 'owner:tester']);
  eq('…and the getter reads normal', knobsMod.replyLength(G), 'normal');
  throws('revert needs an owner actor', () => levers.revertNudge(rv.id, 'mind'), /owner/);
}

// ── owner override ─────────────────────────────────────────────────────────
section('owner PATCH responseRate → overridden (FR-023)');
{
  reset();
  const r = one({ knob: 'responseRate', value: 0.17 });
  const keep = one({ knob: 'reactTendency', value: 1.2 });
  const result = updateConfig({ responseRate: 0.2 });
  eq('updateConfig applied responseRate', Object.keys(result.applied), ['responseRate']);
  const out = levers.onOwnerConfigChange(Object.keys(result.applied || {}));
  eq('onOwnerConfigChange overrides the responseRate nudge', out.overridden, 1);
  eq('…status overridden, ended_by override', [store.getNudge(r.id).status, store.getNudge(r.id).endedBy], ['overridden', 'override']);
  eq('other knobs are left alone', store.getNudge(keep.id).status, 'active');
  near('the getter reads the owner\'s new value', knobsMod.responseRate(), 0.2);
  eq('an audit row records the override', audits('mind.nudge.overridden').length, 1);
  eq('unrelated keys do nothing', levers.onOwnerConfigChange(['llm.model', 'dryRun']).overridden, 0);
  eq('garbage input does not throw', levers.onOwnerConfigChange(null).overridden, 0);
  config.responseRate = 0.15;
  knobsMod.reload();
}

section('bands: narrowing or disabling → overridden');
{
  reset();
  const rt = one({ knob: 'reactTendency', value: 1.2 });
  const pa = one({ knob: 'proactiveAppetite', value: 0.9 });
  const gr = one({ knob: 'groupResponseRate', scope: 'C1', value: 1.1 });
  store.owner.setSetting('bands', { reactTendency: { min: 0.9, max: 1.1, maxStep: 0.3 }, proactiveAppetite: { disabled: true } }, 'owner:tester');
  const out = levers.onBandsChanged();
  eq('two nudges outside the new bands', out.overridden, 2);
  eq('reactTendency 1.2 > new max 1.1 → overridden', store.getNudge(rt.id).status, 'overridden');
  eq('a disabled knob → overridden', store.getNudge(pa.id).status, 'overridden');
  eq('an in-band nudge survives', store.getNudge(gr.id).status, 'active');
  later();
  const d = one({ knob: 'proactiveAppetite', value: 0.9 });
  eq('a disabled knob refuses new nudges as not_allowed', [d.status, d.refuseReason], ['refused', 'not_allowed']);
  const n = one({ knob: 'reactTendency', value: 1.5 });
  eq('new nudges clamp to the narrowed band', [n.status, n.value], ['clamped', 1.1]);
  store.owner.setSetting('bands', null, 'owner:tester');
  levers.onBandsChanged();
}

section('validateBands (owner edits)');
{
  const ok = levers.validateBands({ reactTendency: { min: 0.8, max: 1.2, maxStep: 0.1 } });
  check('a narrower band is accepted', ok.ok && ok.bands.reactTendency.max === 1.2 && ok.bands.responseRate.ceil === 0.5);
  check('responseRate ceil 0.6 is over the hard limit', !levers.validateBands({ responseRate: { ceil: 0.6 } }).ok);
  check('a multiplier of 3 is over the hard limit', !levers.validateBands({ groupResponseRate: { max: 3 } }).ok);
  check('min > max is rejected', !levers.validateBands({ reactTendency: { min: 1.4, max: 1.0 } }).ok);
  check('an unknown knob is rejected', !levers.validateBands({ dryRun: { min: 0 } }).ok);
  check('replyLength allowed must be lengths', !levers.validateBands({ replyLength: { allowed: ['loud'] } }).ok);
  check('replyLength may allow longer', levers.validateBands({ replyLength: { allowed: ['normal', 'longer'] } }).ok);
  store.owner.setSetting('bands', { reactTendency: { min: 5, max: 9, maxStep: 3 } }, 'owner:tester');
  knobsMod.reload();
  eq('an invalid stored band falls back to the default band', knobsMod.getBands().reactTendency.max, 1.5);
  store.owner.setSetting('bands', null, 'owner:tester');
  knobsMod.reload();
}

// ── off / paused ───────────────────────────────────────────────────────────
section('mind off / paused → owner values; rows stay');
{
  reset();
  one({ knob: 'responseRate', value: 0.17 });
  one({ knob: 'groupResponseRate', scope: 'C1', value: 1.2 });
  one({ knob: 'replyLength', value: 'shorter' });
  mindOn = false;
  near('off: responseRate = owner', knobsMod.responseRate(), 0.15);
  eq('off: groupRate = 1', knobsMod.groupRate(G), 1);
  eq('off: replyLength = normal', knobsMod.replyLength(G), 'normal');
  mindOn = true;
  paused = true;
  fc.advance({ seconds: 10 });   // past the paused-flag cache
  near('paused: responseRate = owner', knobsMod.responseRate(), 0.15);
  paused = false;
  fc.advance({ seconds: 10 });
  near('resumed: the unexpired nudge applies again', knobsMod.responseRate(), 0.17);
  eq('rows stayed active throughout', store.activeNudges().length, 3);
  knobsMod.__setDepsForTest({ isPaused: () => { throw new Error('db gone'); } });
  fc.advance({ seconds: 10 });
  near('an unreadable pause flag fails closed to owner values', knobsMod.responseRate(), 0.15);
  knobsMod.__setDepsForTest({ isPaused: () => paused });
  fc.advance({ seconds: 10 });
}

// ── restart / base change ──────────────────────────────────────────────────
section('restart: reload restores; a lowered .env base re-clamps and overrides');
{
  knobsMod.__setDepsForTest(null);   // a restart: empty overlay
  knobsMod.__setDepsForTest({ now: fc.fn, isMindOn: () => mindOn, isPaused: () => paused });
  near('before reload the overlay is empty (owner value)', knobsMod.responseRate(), 0.15);
  const r = knobsMod.reload();
  eq('reload loads the three actives', r.active, 3);
  near('responseRate nudge back', knobsMod.responseRate(), 0.17);
  eq('replyLength back', knobsMod.replyLength(G2), 'shorter');

  config.responseRate = 0.05;   // owner edits RESPONSE_RATE in .env and restarts (no PATCH)
  near('the getter re-clamps against the new base band (max 0.0625)', knobsMod.responseRate(), 0.0625);
  const rr = knobsMod.reload();
  eq('reload marks the stale-base responseRate nudge overridden', rr.overridden.length, 1);
  eq('…ended_by override', store.listNudges({ knob: 'responseRate', limit: 1 })[0].status, 'overridden');
  near('owner base in effect', knobsMod.responseRate(), 0.05);
  eq('other nudges unaffected', [knobsMod.groupRate(G), knobsMod.replyLength(G)], [1.2, 'shorter']);
  config.responseRate = 0.15;
  knobsMod.reload();
}

section('nudges never reach config, .env or the persist diff');
{
  reset();
  one({ knob: 'responseRate', value: 0.17 });
  near('config.responseRate unchanged', config.responseRate, 0.15);
  const diff = computeEnvDiff().diffs;
  check('computeEnvDiff has no nudged value', !diff.some(d => d.liveValue === '0.17' || d.liveValue === 0.17));
  const rrDiff = diff.find(d => d.key === 'responseRate');
  check('responseRate in the diff (if any) is the owner value', !rrDiff || Number(rrDiff.liveValue) === 0.15);
}

section('reload failure → owner values and a throw');
{
  near('nudge active', knobsMod.responseRate(), 0.17);
  let threw = false;
  const orig = db.prepare.bind(db);
  db.prepare = () => { throw Object.assign(new Error('disk'), { code: 'SQLITE_IOERR' }); };
  try { knobsMod.reload(); } catch { threw = true; }
  db.prepare = orig;
  check('reload throws on a DB error (the pulse sees the failure)', threw);
  near('…and leaves owner values in effect', knobsMod.responseRate(), 0.15);
  knobsMod.reload();
  near('a later reload restores', knobsMod.responseRate(), 0.17);
}

// Review repair: with the owner's base above the hard ceiling (0.6 > 0.5), a small
// upward nudge used to snap the rate down to the band edge, past maxStep.
section('owner base outside the band → responseRate nudges refused, never snapped');
{
  reset();
  later(48);
  config.responseRate = 0.6;
  knobsMod.reload();
  const r = one({ knob: 'responseRate', value: 0.62, ttlHours: 6 });
  eq('refused not_allowed (no move to the band edge)', [r.status, r.refuseReason], ['refused', 'not_allowed']);
  near('the getter keeps the owner value', knobsMod.responseRate(), 0.6);
  check('no active responseRate nudge', !activeRow('responseRate'));
  config.responseRate = 0.15;
  knobsMod.reload();
  const ok = one({ knob: 'responseRate', value: 0.17 });
  eq('back in band → applies again', ok.status, 'active');
}

// ── owner revert through the facade: a clamped nudge is in force too ───────
section('owner revert (facade): active and clamped both revert; ended ones → 409');
{
  reset();
  const mind = await import('../../src/mind/index.js');
  const cl = one({ knob: 'responseRate', value: 0.4 });
  eq('a clamped nudge', [cl.status, store.getNudge(cl.id).active], ['clamped', true]);
  eq('owner.revertNudge on it → ok', mind.owner.revertNudge(cl.id, 'owner:tester'), { ok: true, id: cl.id });
  eq('…reverted by the owner, getter back to the owner value', [store.getNudge(cl.id).status, store.getNudge(cl.id).endedBy, knobsMod.responseRate()],
    ['reverted', 'owner:tester', 0.15]);
  let code = null;
  try { mind.owner.revertNudge(cl.id, 'owner:tester'); } catch (e) { code = [e.code, e.http]; }
  eq('again → 409 not_pending', code, ['not_pending', 409]);
  later();
  const ac = one({ knob: 'replyLength', value: 'shorter' });
  eq('an active one reverts too', [ac.status, mind.owner.revertNudge(ac.id, 'owner:tester').ok], ['active', true]);
}

eq('no network calls', net.length, 0);
report();
