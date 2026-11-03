// Property tests (plan 020 §E5), one run: a fresh scratch DB, the real engine (example world,
// fake clock, stubbed models, no network), then an operation list (ops.js) applied in order,
// with the invariants checked as it goes. Run by run.js, one child at a time (the scratch
// DB is one file):
//
//   node scripts/property-tests/child.js '<json: { seed, ops, every }>'
//
// Its last line on stdout is JSON: { ok, failures: [{ check, op, detail }], notes, stats }.
// A refused Director action or revert (an error with a `code`) is the engine saying no, never a
// failure; anything else an operation throws is one ("op_threw"). Stops at the first failure,
// so run.js can shrink by it.
import { setupScratchDb, bootLife, simulateHours, fakeCallRole } from '../arcs-tests/_helpers.js';

const input = JSON.parse(process.argv[2] || '{}');
const OPS = Array.isArray(input.ops) ? input.ops : [];
const EVERY = Number(input.every) > 0 ? Number(input.every) : 4;   // replay check every N operations (and at the end)

const failures = [];
const notes = [];
const stats = { applied: 0, refused: {}, reverted: 0, rewound: 0, passedHours: 0, issues: 0 };
const issues = [];

// Stubbed writers: a scene in the shape the validator takes (no effects: valid for any outcome),
// a phone turn each way; everything else unscripted (null → the code fallback).
const sceneJson = () => JSON.stringify({
  narration: 'They met up and talked for a while about small things, and the time went quickly. Neither of them was in a hurry to go.',
  impressions: null, topics: ['small things'], highlight: 'the time went quickly', awkward: null, chemistry: 0.3,
  focus: 'P1', ending: 'nothing', effects: [],
});
const turn = (end) => JSON.stringify({ messages: ['hey, how is it going?'], tone: 'warm', topic: 'catching up', end });
const cr = fakeCallRole({
  'life.scene.mind': sceneJson, 'life.scene.clerk': sceneJson,
  'life.phone.his': () => turn(false), 'life.phone.mind': () => turn(false), 'life.phone.cast': () => turn(true),
});

await setupScratchDb();
const { logger } = await import('../../src/utils/logger.js');
for (const level of ['warn', 'error']) {
  const orig = logger[level].bind(logger);
  logger[level] = (obj, msg) => {
    const o = obj && typeof obj === 'object' ? obj : {};
    if (o.evt === 'issue' || /failed|threw|crash/i.test(String(msg ?? ''))) {
      issues.push({ level, msg: String(msg ?? '').slice(0, 120), where: o.where ?? null, err: String(o.err ?? '').slice(0, 160) });
    }
    return orig(obj, msg);
  };
}
const { world, clock, life } = await bootLife({ callRole: cr });
const story = await import('../../src/life/story/index.js');
story.__setDepsForTest({ getUsageByCaller: () => [], mindBudgetOk: async () => ({ ok: true }), knownNames: () => [] });
const eventLog = await import('../../src/life/eventLog.js');
const projector = await import('../../src/life/projector.js');
const { storyEquivalent } = await import('../../src/life/story/reducer.js');
const { zonedToUnix, localParts, resolveTimezone } = await import('../../src/life/clock.js');
const tz = resolveTimezone(world.timezone);

const S = () => life.getState();
const lastId = () => eventLog.lastEventId();
const fail = (check, op, detail) => { failures.push({ check, op, detail }); };
const isRefusal = (err) => typeof err?.code === 'string' && err.code.length > 0;
const settle = async () => { await life.tick(); await story.idle(); };

// ── invariants ──────────────────────────────────────────────────────────────────

// "The log stops growing when nothing's due": two ticks at the same moment append nothing the second time.
async function quiet(op) {
  await settle();
  const a = lastId();
  await settle();
  const b = lastId();
  if (b > a) fail('log_grows_when_idle', op, eventLog.eventsAfter(a, 20).map(e => e.type));
}

const entries = (m) => (m instanceof Map ? [...m.entries()] : m && typeof m === 'object' ? Object.entries(m) : [])
  .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0));
// What a replay must reproduce exactly. Vitals are left out on purpose: the live projection
// integrates them between events on every tick (009), so live ≠ replay there by design.
function shapeOf(s) {
  const { age, ...self } = s?.self ?? {};
  return JSON.stringify({
    lastEventId: s?.lastEventId ?? null, story: s?.story ?? null, self, cast: entries(s?.cast), places: entries(s?.places),
    decisions: entries(s?.decisions), embargo: s?.embargo ?? null, plan: s?.plan ?? null,
  }, (k, v) => (v instanceof Set ? [...v].sort() : v instanceof Map ? entries(v) : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
}
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return path || '(root)';
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
function replayCheck(op) {
  const world0 = world;
  const full = projector.rebuild({ world: world0, useSnapshot: false });
  const snap = projector.rebuild({ world: world0 });
  if (!storyEquivalent(full, snap)) fail('snapshot_vs_replay', op, 'a rebuild from the snapshot differs from a full replay');
  const live = shapeOf(S());
  const rep = shapeOf(full);
  if (live !== rep) fail('live_vs_replay', op, firstDiff(JSON.parse(live), JSON.parse(rep)));
}
function logChecks(op) {
  const all = [];
  for (let after = 0; ;) { const page = eventLog.eventsAfter(after, 2000); all.push(...page); if (page.length < 2000) break; after = page[page.length - 1].id; }
  const byId = new Map(all.map(e => [e.id, e]));
  let prev = 0;
  for (const e of all) {
    if (!(e.id > prev)) fail('ids_increasing', op, { id: e.id, prev });
    prev = e.id;
    if (e.causeId) {
      const c = byId.get(e.causeId);
      if (!c) fail('cause_missing', op, { id: e.id, type: e.type, causeId: e.causeId });
      else if (c.id >= e.id) fail('cause_after_effect', op, { id: e.id, type: e.type, causeId: c.id });
      else if (e.at + 1 < c.at) fail('dated_before_cause', op, { id: e.id, type: e.type, at: e.at, cause: c.type, causeAt: c.at });
    }
  }
  // Ids an entity keeps for life: a created cast id, place id, schedule override or goal is never minted twice.
  const seen = new Map();
  for (const e of all) {
    const key = e.type === 'cast.created' ? `cast:${e.payload?.id}` : e.type === 'place.created' ? `place:${e.payload?.id}`
      : e.type === 'schedule.override_set' ? `override:${e.payload?.id ?? e.payload?.overrideId}` : e.type === 'goal.set' ? `goal:${e.payload?.goalId ?? e.payload?.id}` : null;
    if (!key || /:undefined$|:null$/.test(key)) continue;
    if (seen.has(key)) fail('id_reused', op, { key, first: seen.get(key), again: e.id });
    else seen.set(key, e.id);
  }
}
function sweepCheck(op) {
  const res = life.runSweepNow();
  if (res?.ok === false) { notes.push({ op, sweep: res.code }); return; }
  for (const f of res.findings ?? []) {
    if (f.severity === 'high') fail(`sweep:${f.rule}`, op, { text: f.text, eventIds: f.eventIds });
    else notes.push({ op, sweep: f.rule, severity: f.severity, text: f.text, eventIds: f.eventIds });
  }
  for (const e of res.ruleErrors ?? []) fail('sweep_rule_error', op, e);
}

// ── operations ──────────────────────────────────────────────────────────────────

const applied = [];        // { actionEventId, action }
const attendIds = [];      // case-only attend decisions: { id, eventAt }
const reverted = [];       // actions whose change was reverted (for reapply)
const runStart = lastId();
const t5 = (t) => Math.round(t / 300) * 300;

async function directorApply(action, i) {
  const pv = await story.director.preview(action);
  const res = await story.director.apply(pv.previewId, pv.fingerprint);
  if (res?.ok && res.actionEventId) { applied.push({ actionEventId: res.actionEventId, action }); stats.applied++; }
  return res;
}

function actionOf(op, i) {
  const now = clock.now();
  switch (op.t) {
    case 'outing': return { kind: 'scene', shape: 'outing', placeId: op.place, startAt: t5(now + op.inMin * 60), minutes: op.minutes, castIds: op.cast, label: `Plan ${i}` };
    case 'schedule': return { kind: 'schedule', day: op.day, ranges: [{ activity: op.activity, from: op.from, to: op.to, ...(op.place ? { placeId: op.place } : {}) }] };
    case 'text': return { kind: 'text', castId: op.cast, gist: 'ask how their day is going' };
    case 'money': return { kind: 'money', mode: op.mode, amount: op.amount };
    case 'wake': return { kind: 'wake', reason: 'cant_sleep' };
    default: return null;
  }
}

async function runOp(op, i) {
  // --self-test only: a planted fault (an event dated two hours before its cause), so the checks
  // and the shrinker can be shown to catch one.
  // Case-only (never generated): a family occasion committed to 'attend' — an option the pulse never moves
  // him for — so a later rewind's rule can be checked against it (batch 3 review 35).
  if (op.t === 'attend') {
    const t = clock.now();
    const eventAt = t5(t + (op.inMin ?? 360) * 60);
    const opened = eventLog.appendEvent({ type: 'decision.opened', at: t, actor: 'engine', payload: {
      kind: 'family:gathering', category: 'family', big: true, mode: 'ask', opensAt: t, decideBy: eventAt - 3600,
      options: [{ id: 'attend', label: 'Go to the family lunch', cost: {} }, { id: 'call', label: 'Call instead', cost: {} }, { id: 'skip', label: 'Skip it', cost: {} }],
      subject: { eventAt, placeId: 'place:family-home', castIds: ['cast:parent'] } } });
    eventLog.appendEvent({ type: 'decision.committed', at: t + 60, actor: 'owner', payload: { decisionId: opened.id, optionId: 'attend', p: 1, sampled: false, by: 'owner' } });
    story.__rebuildForTest();
    attendIds.push({ id: opened.id, eventAt });
    return;
  }
  if (op.t === 'plant') {
    if (input.selfTest !== true) return;
    const cause = eventLog.eventsAfter(lastId() - 1, 1)[0];
    eventLog.appendEvent({ type: 'vitals.checkpoint', at: cause.at - 7200, actor: 'engine', causeId: cause.id,
      payload: { date: '2026-10-27', vitals: S().vitals } });
    story.__rebuildForTest();   // fold it into the live state, as a real append would be
    return;
  }
  if (op.t === 'pass') { await simulateHours(op.h, { stepMinutes: 15 }); stats.passedHours += op.h; return; }
  if (op.t === 'revert') {
    const live = applied.filter(a => !projector.isExcludedId(S(), a.actionEventId));
    if (!live.length) return;
    const a = live[Math.min(live.length - 1, Math.floor(op.pick * live.length))];
    const p = life.revertChangePreview(a.actionEventId);
    life.revertChange(a.actionEventId, { fingerprint: p.fingerprint });
    reverted.push(a.action); stats.reverted++;
    return;
  }
  if (op.t === 'reapply') {
    const action = reverted.pop();
    if (!action) return;
    const res = await directorApply(action, i);
    if (res?.ok) replayCheck(i);   // revert + re-apply stays consistent
    return;
  }
  if (op.t === 'rewind') {
    const last = lastId();
    if (last - runStart < 20) return;
    const to = Math.floor(last - (last - runStart) * op.back);
    await directorApply({ kind: 'rewind', toEventId: to, reason: 'property test' }, i);
    stats.rewound++;
    return;
  }
  const action = actionOf(op, i);
  if (action) await directorApply(action, i);
}

// ── the run ─────────────────────────────────────────────────────────────────────

await simulateHours(4, { stepMinutes: 15 });   // past genesis and the first plan
let i = 0;
for (; i < OPS.length && !failures.length; i++) {
  const op = OPS[i];
  const before = issues.length;
  try { await runOp(op, i); }
  catch (err) {
    if (isRefusal(err)) stats.refused[err.code] = (stats.refused[err.code] ?? 0) + 1;
    else fail('op_threw', i, `${op.t}: ${err?.name}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (failures.length) break;
  try { await quiet(i); } catch (err) { fail('tick_threw', i, `${err?.name}: ${String(err?.message).slice(0, 200)}`); }
  if (issues.length > before) {
    stats.issues += issues.length - before;
    for (const x of issues.slice(before)) if (x.level === 'error' || /TypeError|ReferenceError|RangeError/.test(x.err)) fail('engine_error_logged', i, x);
  }
  if (!failures.length && (i % EVERY === EVERY - 1 || i === OPS.length - 1)) {
    try { replayCheck(i); logChecks(i); } catch (err) { fail('check_threw', i, `${err?.name}: ${String(err?.message).slice(0, 200)}`); }
  }
}
// An occasion he committed to attend is never cancelled by a rewind whose target lies after its window.
for (const a of attendIds) {
  const rw = eventLog.eventsAfter(a.id, 200000).filter(e => e.type === 'decision.expired' && e.payload?.decisionId === a.id
    && e.payload?.reason === 'rewound' && !projector.isExcludedId(S(), e.id));
  if (rw.length) fail('attend_rewound', OPS.length - 1, { decisionId: a.id, eventAt: a.eventAt, expiredAt: rw[0].at });
}
if (!failures.length) { try { sweepCheck(OPS.length - 1); } catch (err) { fail('sweep_threw', OPS.length - 1, `${err?.name}: ${String(err?.message).slice(0, 200)}`); } }
// --trace <decisionId> (run.js): the decision's own events and what the log holds around its time.
let trace = null;
if (Number.isSafeInteger(input.trace)) {
  const all = [];
  for (let after = 0; ;) { const page = eventLog.eventsAfter(after, 2000); all.push(...page); if (page.length < 2000) break; after = page[page.length - 1].id; }
  const d = all.find(e => e.id === input.trace);
  const at = d?.payload?.subject?.eventAt ?? d?.at ?? 0;
  const out = (e) => projector.isExcludedId(S(), e.id);
  const brief = (e) => ({ id: e.id, at: e.at, t: new Date(e.at * 1000).toISOString().slice(5, 16), type: e.type, actor: e.actor, cause: e.causeId,
    out: out(e) || undefined, p: JSON.stringify(e.payload).slice(0, 160) });
  trace = {
    decision: all.filter(e => e.id === input.trace || e.payload?.decisionId === input.trace || e.causeId === input.trace).map(brief),
    around: all.filter(e => Math.abs(e.at - at) < 3 * 3600 && /activity|travel|plan.made|sleep|woke|rewound|reverted|schedule|decision.expired/.test(e.type)).map(brief),
    undo: all.filter(e => /event.reverted|world.rewound/.test(e.type)).map(brief),
  };
}
stats.events = lastId();
stats.ran = i;
stats.warnings = issues.filter(x => x.level === 'warn').slice(0, 5);
try { await life.stopLife(); } catch { /* best effort */ }
process.stdout.write(`\n${JSON.stringify({ ok: !failures.length, failures, notes: notes.slice(0, 20), stats, ...(trace ? { trace } : {}) })}\n`);
process.exit(0);
