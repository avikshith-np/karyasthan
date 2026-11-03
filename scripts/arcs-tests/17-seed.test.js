// T018 — src/life/story/seed.js (research R19, data-model §4): validation with
// per-section failure, the committed example, loading (arcs.json → example on any
// problem), the owner overlay (effectiveSeed), and the generation gate: the attempt
// marker is written before the one mind call, any earlier attempt refuses an
// automatic call (a failed attempt then a restart → zero further calls), the
// `life.arcs.` caller cap and mindBudgetOk('sleep').ok (absent → fail closed) gate
// it, and the owner regenerate is 1/hour. Scratch DB, fake clock, stubbed models;
// the seed file goes to a temp path under data/ (deleted afterwards).
import fs from 'fs';
import path from 'path';
import { setupScratchDb, fakeClock, section, check, eq, report, exampleArcSeed, exampleWorld, fakeCallRole, blockNetwork,
  PROJECT_ROOT, LIVE, HOUR } from './_helpers.js';
import { setClock } from '../../src/life/clock.js';
import * as store from '../../src/life/story/store.js';
import * as seedMod from '../../src/life/story/seed.js';

await setupScratchDb();
blockNetwork();
const clock = fakeClock(Date.UTC(2026, 9, 30, 13, 10) / 1000);
setClock(clock.fn);
const world = await exampleWorld();
const example = await exampleArcSeed();
const TMP = path.join(PROJECT_ROOT, 'data', `arcs-seed-test-${process.pid}.json`);
const rm = () => { try { fs.unlinkSync(TMP); } catch { /* none */ } };
const okGate = async () => ({ ok: true, reason: null });
const noUsage = () => [];
const validSeed = () => JSON.stringify({ ...example, career: { ...example.career, appraisalMonth: 4, employers: [{ name: 'Northwind Fictional Ltd' }] } });

try {
  section('validateArcSeed');
  {
    const v = seedMod.validateArcSeed(example, { world, knownNames: [] });
    check('the committed example validates', v.ok);
    eq('every section present', seedMod.SECTIONS.map(s => v.seed[s] !== null), [true, true, true, true, true]);
    eq('appraisal month null → listed as missing (appraisal arc inert)', v.missing, ['career.appraisalMonth']);
    eq('officeAreas.near must be an existing place', seedMod.validateArcSeed(example, { world: null }).seed.career.officeAreas, []);
    const famBad = seedMod.validateArcSeed({ ...example, family: { callCadenceDays: [40, 2] } }, { world });
    check('an invalid family section → family null + missing, others intact', famBad.seed.family === null && famBad.missing.includes('family')
      && famBad.seed.career !== null && famBad.seed.heavy !== null);
    const heavy = seedMod.validateArcSeed({ ...example, heavy: { themes: [
      { id: 'grief', kind: 'family_illness', label: 'a death in the family' },
      { id: 'jl', kind: 'job_loss', label: 'laid off' },
      { id: 'x', kind: 'self_harm', label: 'x' },
      { id: 'ok-one', kind: 'pet_loss', label: 'the old cat', durationDays: [2, 9] },
      { id: 'too-long', kind: 'minor_accident', label: 'a fall', durationDays: [2, 45] },
    ] } }, { world });
    eq('forbidden label / kind refused, job_loss deferred, > 30 days refused', heavy.seed.heavy.themes.map(t => t.id), ['ok-one']);
    check('job_loss noted in missing', heavy.missing.includes('heavy.job_loss'));
    const names = seedMod.validateArcSeed({ ...example, career: { ...example.career, employers: [{ name: 'Avery Holdings' }, { name: 'Quiet Fictional Co' }] } },
      { world, knownNames: ['Avery Stone'] });
    eq('an employer naming a real person is dropped', names.seed.career.employers.map(e => e.name), ['Quiet Fictional Co']);
    const statusName = seedMod.validateArcSeed({ ...example, castStatus: { friend: ['out with Avery', 'busy'] } }, { world, knownNames: ['Avery'] });
    eq('a status line naming a real person is dropped', statusName.seed.castStatus.friend, ['busy']);
    const clamp = seedMod.validateArcSeed({ ...example, career: { ...example.career, salaryChangePct: { min: -30, max: 90 }, noticeDays: 999 } }, { world });
    eq('salaryChangePct clamped to -5..20, bad noticeDays → 30', [clamp.seed.career.salaryChangePct, clamp.seed.career.noticeDays], [{ min: -5, max: 20 }, 30]);
    const unk = seedMod.validateArcSeed({ ...example, evil: 1, romance: { meetVia: ['hobby', 'dating_app'] } }, { world });
    check('unknown keys and enum values dropped', unk.dropped.some(d => d.path === 'evil') && unk.seed.romance.meetVia.join() === 'hobby');
    eq('not an object → ok:false, every section missing', seedMod.validateArcSeed('nope').missing.length, 5);
    eq('over 32 KB → oversize', seedMod.validateArcSeed({ ...example, pad: 'x'.repeat(40_000) }).error, 'oversize');
    const majors = seedMod.validateArcSeed({ ...example, family: { ...example.family,
      majorDecisions: [{ id: 'm1', label: 'move closer', themeId: 'nope', fromAge: 20, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] } }, { world });
    eq('a major decision on an unknown theme is dropped', majors.seed.family.majorDecisions, []);
  }

  section('loadArcSeed / effectiveSeed');
  {
    rm();
    const ex = seedMod.loadArcSeed({ path: TMP, world, force: true });
    eq('no arcs.json → the example', ex.source, 'example');
    fs.writeFileSync(TMP, validSeed());
    const own = seedMod.loadArcSeed({ path: TMP, world, knownNames: [], force: true });
    eq('a valid arcs.json → loaded', [own.source, own.career.appraisalMonth], ['arcs.json', 4]);
    fs.writeFileSync(TMP, '{ not json');
    eq('broken arcs.json → the example', seedMod.loadArcSeed({ path: TMP, world, force: true }).source, 'example');
    fs.writeFileSync(TMP, JSON.stringify({ ...example, pad: 'x'.repeat(40_000) }));
    eq('oversized arcs.json → the example', seedMod.loadArcSeed({ path: TMP, world, force: true }).source, 'example');
    rm();
    const base = seedMod.loadArcSeed({ path: TMP, world, force: true });
    const state = { story: { seedOverlay: { 'career.appraisalMonth': 6, 'career.noticeDays': 500, 'family.callCadenceDays': [2, 4], 'evil.path': 1 } } };
    const eff = seedMod.effectiveSeed(state, base);
    eq('overlay applied (allow-listed, re-validated)', [eff.career.appraisalMonth, eff.career.noticeDays, eff.family.callCadenceDays], [6, 30, [2, 4]]);
    eq('the base seed is not mutated', base.career.appraisalMonth, null);
    const inert = seedMod.effectiveSeed(state, { ...base, family: null });
    eq('a null family section stays inert under an override', inert.family, null);
    seedMod.__setSeedForTest({ ...example, version: 1 });
    eq('the test seam overrides getArcSeed()', seedMod.getArcSeed().source, 'test');
    seedMod.__setSeedForTest(undefined);
  }

  section('ensureArcSeed: generation and the attempt gate');
  {
    rm();
    store.patchState({ seed: null });
    const cr = fakeCallRole({ 'life.arcs.seed': () => ({ text: `Here you go:\n${validSeed()}`, costUsd: 0.1, model: 'fake-mind' }) });
    const res = await seedMod.ensureArcSeed({ path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [],
      persona: { name: 'Testname', voiceDescriptor: 'calm' }, identityText: 'An ordinary person.' });
    eq('generated', res.status, 'generated');
    eq('one mind call, caller life.arcs.seed, maxTokens 6000', cr.calls.map(c => [c.role, c.caller, c.opts.maxTokens]), [['mind', 'life.arcs.seed', 6000]]);
    check('persona goes in the user message, never the system prompt', cr.calls[0].user.includes('Testname') && !String(cr.calls[0].system).includes('Testname'));
    check('file written 0644', fs.existsSync(TMP) && (fs.statSync(TMP).mode & 0o777) === 0o644);
    eq('story_state.seed = generated', store.getState('seed').source, 'generated');
    eq('the run is recorded (seed, ok)', [store.lastRun({ kind: 'seed' }).status, store.lastRun({ kind: 'seed' }).caller], ['ok', 'life.arcs.seed']);
    const again = await seedMod.ensureArcSeed({ path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [] });
    eq('arcs.json present → loaded, no call', [again.status, cr.calls.length], ['loaded', 1]);
  }

  section('a failed attempt, then a restart → zero further calls');
  {
    rm();
    store.patchState({ seed: null });
    const cr = fakeCallRole({ 'life.arcs.seed': () => 'not json at all' });
    const opts = { path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [] };
    const r1 = await seedMod.ensureArcSeed(opts);
    eq('invalid output → example with a reason', [r1.status, r1.reason, store.getState('seed').source], ['example', 'invalid', 'example']);
    check('the attempt time was recorded', Number.isInteger(store.getState('seed').attemptedAt));
    for (let i = 0; i < 3; i++) await seedMod.ensureArcSeed(opts);   // boots / pm2 restarts
    eq('three restarts → still exactly one call', cr.calls.length, 1);
    check('no arcs.json written', !fs.existsSync(TMP));
  }

  section('gates before the call');
  {
    const cases = [
      ['no mindBudgetOk wired → fail closed', { mindBudgetOk: undefined }, 'budget'],
      ['mindBudgetOk {ok:false}', { mindBudgetOk: async () => ({ ok: false, reason: 'budget' }) }, 'budget'],
      ['a truthy object without ok:true', { mindBudgetOk: async () => ({ reason: null, spentUsd: 0 }) }, 'budget'],
      ['unpriced', { mindBudgetOk: async () => ({ ok: false, reason: 'unpriced' }) }, 'unpriced'],
      ['caller cap ($1.20 ≥ $1 month-to-date)', { getUsageByCaller: () => [{ caller: 'life.arcs.weekly', costUsd: 1.2 }] }, 'caller_cap'],
      ['usage read failure → fail closed', { getUsageByCaller: () => { throw new Error('db'); } }, 'caller_cap'],
    ];
    for (const [name, over, reason] of cases) {
      rm();
      store.patchState({ seed: null });
      const cr = fakeCallRole({ 'life.arcs.seed': () => validSeed() });
      const r = await seedMod.ensureArcSeed({ path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [], ...over });
      eq(`${name} → no call, example (${reason})`, [cr.calls.length, r.status, r.reason, store.getState('seed').source], [0, 'example', reason, 'example']);
      const r2 = await seedMod.ensureArcSeed({ path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [] });
      eq(`${name}: a later boot with the gate open still makes no call`, [cr.calls.length, r2.reason], [0, 'attempted']);
    }
    rm();
    store.patchState({ seed: null });
    const budget = fakeCallRole({ 'life.arcs.seed': () => ({ text: null, skipped: 'budget', status: 'budget' }) });
    const rb = await seedMod.ensureArcSeed({ path: TMP, world, callRole: budget.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [] });
    eq('callRole skipped (role over budget) → example, run skipped', [rb.status, rb.reason, store.lastRun({ kind: 'seed' }).status], ['example', 'budget', 'skipped']);
    const realName = fakeCallRole({ 'life.arcs.seed': () => JSON.stringify({ ...example, castStatus: { any: ['seeing Avery again'] } }) });
    rm();
    store.patchState({ seed: null });
    await seedMod.ensureArcSeed({ path: TMP, world, callRole: realName.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: ['Avery'] });
    const written = JSON.parse(fs.readFileSync(TMP, 'utf-8'));
    eq('a real name in generated text never reaches the file', written.castStatus.any, []);
  }

  section('owner regenerate (1/hour, same gates)');
  {
    const cr = fakeCallRole({ 'life.arcs.seed': () => validSeed() });
    const opts = { path: TMP, world, callRole: cr.fn, mindBudgetOk: okGate, getUsageByCaller: noUsage, knownNames: [] };
    clock.advance({ minutes: 90 });
    const r1 = await seedMod.regenerateArcSeed(opts);
    eq('regenerate runs once the hour has passed (no attempt-marker check)', [r1.status, cr.calls.length], ['generated', 1]);
    const r2 = await seedMod.regenerateArcSeed(opts);
    eq('a second regenerate inside the hour → refused (rate), no call', [r2.status, r2.reason, cr.calls.length], ['refused', 'rate', 1]);
    clock.advance({ minutes: 61 });
    const r3 = await seedMod.regenerateArcSeed({ ...opts, mindBudgetOk: async () => ({ ok: false, reason: 'budget' }) });
    eq('regenerate is gated by mindBudgetOk too', [r3.status, r3.reason, cr.calls.length], ['refused', 'budget', 1]);
  }

  section('live (opt-in)');
  if (!LIVE) console.log('  SKIP live: run with -- --live (needs a mind-role key; one paid call)');
  else {
    rm();
    store.patchState({ seed: null });
    const { realPeopleNames } = await import('../../src/life/world.js');
    const r = await seedMod.ensureArcSeed({ path: TMP, world, mindBudgetOk: okGate, knownNames: realPeopleNames() });
    check('a real seed generates and validates', r.status === 'generated', r.reason);
  }
} catch (err) {
  check('no unexpected exception', false, err?.stack || String(err));
} finally {
  rm();
  try { fs.unlinkSync(`${TMP}.tmp-${process.pid}`); } catch { /* none */ }
}

report();
