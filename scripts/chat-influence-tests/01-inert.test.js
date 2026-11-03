// 012 ships inert. Golden fixtures recorded once from the step-0 base (before any
// 012 code: the live tree with the Day page, 9b1e957 and 6a73027 merged) by
// _golden.js: 7 days of the 009 engine and 3 days with the arcs story on, chat
// messages through perceiveChat, sent replies through onReplySent, prompt lines
// every 3 h, the gate, the final reply prompts, every event (minus recorded_at),
// the snapshots and the final serialized state. The new code with the skill off,
// and with the skill on but every area off, must reproduce them byte for byte —
// comparing two runs of the new code would hide any shared-path change.
//
// Re-recorded 2026-10-31 from `_golden.js <variant> off` (the example persona: no
// persona.json / identity.md in the tree) for the vitals rebalance (vitals.js
// "Rebalance" note): 009's own rates changed, so the base itself moved. The
// pre-012 proof held up to 7b1bfc7; from here `off` and `areas-off` must keep
// matching this record, so 012's chat.load (and every other area) stays inert.
//
// Then, in this process: with the skill off (or life off) a candidate message
// makes no Jev call and appends nothing; skill on → a blip moves the view; skill
// off again → the overlay is ignored at once.
import { setupScratchDb, bootInfluence, say, eventsOf, perceiveCalls, setSkills, stopEngine, startEngine, section, check, eq, report, PROJECT_ROOT } from './_helpers.js';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCRATCH = path.join(PROJECT_ROOT, 'data');
// The offset these fixtures were recorded in: a record of every event and hour holds only in its own zone.
// Moved 2026-11-03 from a named zone at this offset: run in that zone the code still matched the old record
// exactly, and only the four hashes that hold the zone's name changed (events, the first day, snapshots, state).
const GOLDEN_ZONE = '+05:30';

section('golden: the new code with chat influence off reproduces the pre-012 base');
for (const variant of ['life', 'arcs']) {
  const fixture = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts/chat-influence-tests/fixtures', `golden-${variant}.json`), 'utf-8'));
  for (const mode of ['off', 'areas-off']) {
    const out = path.join(SCRATCH, `ci-golden-${variant}-${mode}-${process.pid}.json`);
    const res = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts/chat-influence-tests/_golden.js'), variant, mode, out],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, TEST_TIMEZONE: GOLDEN_ZONE } });
    let got = null;
    try { got = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch { got = null; }
    try { fs.unlinkSync(out); } catch { /* absent */ }
    if (!check(`[${variant}/${mode}] the run finished`, res.status === 0 && !!got, (res.stderr || '').slice(-400))) continue;
    eq(`[${variant}/${mode}] event types and counts`, got.types, fixture.types);
    eq(`[${variant}/${mode}] every event (hash)`, got.eventsHash, fixture.eventsHash);
    const days = Object.keys(fixture.dayHashes).filter(d => got.dayHashes[d] !== fixture.dayHashes[d]);
    eq(`[${variant}/${mode}] …per day`, days, []);
    eq(`[${variant}/${mode}] snapshots (hash)`, [got.snapshotCount, got.snapshotsHash], [fixture.snapshotCount, fixture.snapshotsHash]);
    eq(`[${variant}/${mode}] final serialized state (hash + keys)`, [got.stateHash, got.stateKeys], [fixture.stateHash, fixture.stateKeys]);
    eq(`[${variant}/${mode}] prompt lines every 3 h`, got.lines, fixture.lines);
    eq(`[${variant}/${mode}] gate outcomes`, got.gates, fixture.gates);
    eq(`[${variant}/${mode}] chat triggers + claims`, [got.perceive, got.replies], [fixture.perceive, fixture.replies]);
    eq(`[${variant}/${mode}] reply prompts`, got.prompts, fixture.prompts);
    eq(`[${variant}/${mode}] Jev calls (no life.chat.perceive)`, [got.jevCalls, got.jevCallers], [fixture.jevCalls, fixture.jevCallers]);
  }
}

section('in process: off means nothing happens');
await setupScratchDb();
const t = await bootInfluence({ skills: { 'chat-influence': false } });
const DM = t.A;
await say(t, { chat: DM, sender: t.A, text: 'you are an absolute legend, honestly' });
await say(t, { chat: t.GROUP, sender: t.B, text: 'mate you are hopeless lol', mentioned: ['10000000000@s.whatsapp.net'] });
eq('skill off: no perception call, no event', [perceiveCalls(t).length, (await eventsOf(['chat.perceived', 'mood.chat'])).length], [0, 0]);
eq('…and no row', t.db.prepare('SELECT COUNT(*) AS n FROM chat_influence_items').get().n, 0);
eq('…and the facade reports every area off', t.influence.influenceOn('mood') || t.influence.influenceOn('sleep') || t.influence.influenceOn('work'), false);

await setSkills({ 'chat-influence': true });
await stopEngine(t);
await say(t, { chat: DM, sender: t.A, text: 'you are an absolute legend, honestly' });
eq('life off (skill on): still nothing', [perceiveCalls(t).length, (await eventsOf(['chat.perceived'])).length], [0, 0]);
eq('…and nothing is attached', t.influence.influenceOn('mood'), false);

await startEngine(t);
const before = t.life.getState();
await say(t, { chat: DM, sender: t.A, text: 'you are an absolute legend, honestly' });
const on = t.life.getState();
check('skill on: one perception, one blip', perceiveCalls(t).length === 1 && (await eventsOf(['mood.chat'])).length === 1);
check('…the view carries the overlay (and its base)', !!on.vitalsBase && on.vitals.stress !== before.vitals.stress);
await setSkills({ 'chat-influence': false });
const off = t.life.getState();
check('skill off again: the overlay is ignored at once', !('vitalsBase' in off) && off.vitals.stress === on.vitalsBase.stress
  && off.vitals.mood.valence === on.vitalsBase.mood.valence);
eq('…and the reason line is gone', /legend|chuffed/.test(t.life.innerStateLine({ chatJid: DM, kind: 'dm', sameChat: [DM], members: new Set([DM]) })), false);

report();
