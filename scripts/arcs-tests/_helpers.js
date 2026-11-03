// Shared helpers for the 010 story tests (scripts/arcs-tests/*.test.js).
//
// Import this module FIRST in a test file. It re-exports scripts/life-tests/_helpers.js,
// which on load points DB_PATH at a per-process scratch DB under data/, forces DRY_RUN
// and quiets the logger — all before anything imports src/utils/config.js. Only the
// life helpers are imported (mind-tests/_helpers.js also sets DB_PATH on load, which
// would make setupScratchDb refuse to run); the few mind fakes the story needs are
// copied here. Nothing here touches the network or a real model.
//
//   import { setupScratchDb, fakeClock, fakeCallRole, bootLife, simulateDays, check, report } from './_helpers.js';
//   const { db } = await setupScratchDb();       // the real 006 ladder, v11 included
//   const { life, clock } = await bootLife();     // example world, timers off, fake Jev
//   await simulateDays(3);
//   report();
//
// Every name here is invented and persona-neutral (the guard test checks it).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fakeClock, fakeJev, jevChoice, PROJECT_ROOT } from '../life-tests/_helpers.js';

export * from '../life-tests/_helpers.js';

export const DAY = 86400;
export const HOUR = 3600;
export const STORY_TABLES = Object.freeze(['story_claim_reviews', 'story_runs', 'story_proposals', 'story_journal_nights',
  'story_journal_parts', 'story_narrations', 'story_refusals', 'story_state']);

// Invented, persona-neutral names (the same set the mind tests use).
export const NAMES = Object.freeze(['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Gray', 'Harper']);

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── Model fakes ──────────────────────────────────────────────────────────────

/**
 * Stand-in for callRole(role, system, user, opts) → { text, provider, model, usage,
 * costUsd, fellBack, status }. `script` maps a caller label (opts.caller, e.g.
 * 'life.claim.extract') — or `role:<role>` as a fallback key — to a responder
 * (system, user, opts, index) returning a string (the text), an object (merged over
 * the ok result, e.g. { skipped:'budget', text:null }) or throwing (→ status 'error';
 * callRole itself never throws). Every call is recorded as { role, caller, system,
 * user, opts }; a caller with no script is recorded in `unscripted` (text null).
 */
export function fakeCallRole(script = {}) {
  const calls = [];
  const unscripted = [];
  const perCaller = new Map();
  async function fn(role, system, user, opts = {}) {
    const caller = opts?.caller || null;
    calls.push({ role, caller, system: structuredClone(system), user, opts: { ...opts } });
    const responder = (caller && script[caller]) || script[`role:${role}`];
    const base = { text: null, provider: 'fake', model: `fake-${role}`, usage: { ...EMPTY_USAGE }, costUsd: 0,
      fellBack: false, status: 'ok' };
    if (!responder) {
      unscripted.push({ role, caller });
      return { ...base, status: 'unscripted' };
    }
    const index = perCaller.get(caller) || 0;
    perCaller.set(caller, index + 1);
    try {
      const out = await responder(system, user, opts, index);
      if (out == null) return { ...base, text: null };
      if (typeof out === 'string') return { ...base, text: out };
      return { ...base, ...out };
    } catch (err) {
      return { ...base, text: null, status: 'error', lastError: err.message };
    }
  }
  return {
    fn,
    calls,
    unscripted,
    callsFor: (caller) => calls.filter(c => c.caller === caller),
    reset() { calls.length = 0; unscripted.length = 0; perCaller.clear(); },
  };
}

/**
 * An askJev stand-in that answers every question with fixed probabilities:
 *   - `probs` a flat map { optionId: p } → every `choice` question gets those
 *     probabilities restricted to its criteria (falling back to the whole map);
 *   - `probs` a map { questionKey: { optionId: p } | number } → per question (a number
 *     answers a `noul` question with that probability of yes);
 *   - `probs` null → empty answers (callers fall back to code costs).
 * Returns the fakeJev object (calls recorded in `.calls`; `.fail(err)` to throw).
 */
export function fakeJevFixed(probs = null) {
  // Any object value → keyed per question; all numbers → one flat option map (choice
  // questions) whose entry under a noul question's key answers that question.
  const perQuestion = !!probs && Object.values(probs).some(v => v !== null && typeof v === 'object');
  return fakeJev((req) => {
    if (!probs) return {};
    const answers = {};
    for (const [key, question] of Object.entries(req?.questions || {})) {
      const noul = question?.type === 'noul';
      const spec = perQuestion || noul ? probs[key] : probs;
      if (spec == null) continue;
      if (noul || typeof spec === 'number') {
        const p = Math.min(1, Math.max(0, Number(typeof spec === 'number' ? spec : spec.yes) || 0));
        const choice = p >= 0.75 ? 'yes' : p >= 0.5 ? 'likely' : p >= 0.25 ? 'unlikely' : 'no';
        answers[key] = { choice, confidence: Math.max(p, 1 - p), probability: p, probabilities: { yes: p, no: 1 - p } };
        continue;
      }
      const ids = question?.criteria ? Object.keys(question.criteria) : Object.keys(spec);
      let restricted = Object.fromEntries(ids.filter(id => id in spec).map(id => [id, spec[id]]));
      if (!Object.keys(restricted).length) restricted = { ...spec };
      const best = Object.entries(restricted).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best) answers[key] = jevChoice(best, restricted);
    }
    return answers;
  });
}

/** fetch / sockets refused for the whole process; `blocked.count` counts the attempts. */
export const blocked = { count: 0 };
export function blockNetwork() {
  if (process.argv.includes('--live')) return blocked;   // `-- --live` is the opt-in paid run: its real calls must get out
  globalThis.fetch = async () => { blocked.count++; throw new Error('network is off in arcs tests'); };
  return blocked;
}

// ── Skills ───────────────────────────────────────────────────────────────────

let skillsLoaded = false;
/** Load the skill registry once and set the given skills on/off (default: life + arcs on). */
export async function setSkills(flags = { life: true, arcs: true }) {
  const skills = await import('../../src/skills/skillRunner.js');
  if (!skillsLoaded) { await skills.loadSkills(); skillsLoaded = true; }
  for (const [name, on] of Object.entries(flags)) skills.setSkillEnabled(name, !!on);
  return skills;
}

// ── Life boot + time ─────────────────────────────────────────────────────────

let booted = null;   // { life, clock, world, arcSeed, jev, callRole }
let currentArcSeed = null;

/** The arc seed the last bootLife() was given (for story modules' test seams), or null. */
export function testArcSeed() {
  return currentArcSeed;
}

/** The neutral example world (src/personality/world.example.json), loaded fresh. */
export async function exampleWorld() {
  const { loadWorld, EXAMPLE_PATH } = await import('../../src/life/world.js');
  return loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
}

/** The neutral example arc seed (src/personality/arcs.example.json), parsed. */
export async function exampleArcSeed() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'personality', 'arcs.example.json'), 'utf-8'));
}

/**
 * Start the 009 life facade the way 17-facade.test.js does it by hand: fake clock
 * (setClock), fake Jev on decisions and claims, network blocked, then
 * startLife({ world, timers:false, isEnabled, seed, … }) on the example world
 * (allowed because the world is passed explicitly). Call setupScratchDb() first.
 *
 * opts: world (default example), arcSeed (default arcs.example.json; handed to the
 * story layer's test seam when it exists), clock (default Tue 27 Oct 06:00 world
 * time), jev (an askJev fake; default fakeJevFixed(null)), callRole (a fakeCallRole;
 * default one with no script), skills (default { life:true, arcs:true }), seed (RNG,
 * default 42) and any other startLife option (getSock, processMessage, …).
 * → { life, clock, world, arcSeed, jev, callRole }
 */
export async function bootLife({ world, arcSeed, clock, jev, callRole, skills = { life: true, arcs: true }, seed = 42,
  ...startOpts } = {}) {
  const { setClock, zonedToUnix } = await import('../../src/life/clock.js');
  const w = world ?? await exampleWorld();
  const c = clock ?? fakeClock(zonedToUnix(2026, 10, 27, 6, 0, w.timezone));
  setClock(c.fn);
  blockNetwork();
  const j = jev ?? fakeJevFixed(null);
  const cr = callRole ?? fakeCallRole({});
  const { setJev: setDecisionJev } = await import('../../src/life/decisions.js');
  const { setJev: setClaimsJev } = await import('../../src/life/claims.js');
  setDecisionJev(j.fn);
  setClaimsJev(j.fn);
  await setSkills(skills);
  currentArcSeed = arcSeed === undefined ? await exampleArcSeed() : arcSeed;
  // Story-layer test seam, when the facade exists (wave 1b+): inject the clock, models and seed.
  const story = await importIfExists('../../src/life/story/index.js');
  if (typeof story?.__setDepsForTest === 'function') {
    story.__setDepsForTest({ now: c.fn, callRole: cr.fn, askJev: j.fn });
  }
  const seedMod = await importIfExists('../../src/life/story/seed.js');
  if (typeof seedMod?.__setSeedForTest === 'function') seedMod.__setSeedForTest(currentArcSeed);
  const life = await import('../../src/life/index.js');
  const lifeOn = skills.life !== false;
  await life.startLife({
    world: w,
    timers: false,
    isEnabled: () => lifeOn,
    seed,
    isGroupMuted: () => false,
    isMember: () => true,
    sleep: async () => {},
    ...startOpts,
  });
  booted = { life, clock: c, world: w, arcSeed: currentArcSeed, jev: j, callRole: cr };
  return booted;
}

/** Stop the life facade started by bootLife (idempotent). */
export async function stopLife() {
  if (!booted) return;
  try { await booted.life.stopLife(); } finally { booted = null; }
}

/**
 * Advance the fake clock `n` days in `stepMinutes` steps, ticking the life facade
 * after each step (the pulse folds everything due). → the facade's getState() view
 * stepMinutes is capped at 1440: a gap longer than LIFE_CATCHUP_HOURS (72 h) would make
 * the pulse re-anchor at "now" instead of replaying the days in between.
 */
export async function simulateDays(n, { stepMinutes = 15, onStep = null } = {}) {
  if (!booted) throw new Error('simulateDays: call bootLife() first');
  if (!(stepMinutes > 0 && stepMinutes <= 1440)) throw new Error('simulateDays: stepMinutes must be in (0, 1440]');
  const steps = Math.round((n * 1440) / stepMinutes);
  for (let i = 0; i < steps; i++) {
    booted.clock.advance({ minutes: stepMinutes });
    await booted.life.tick();
    if (onStep) await onStep(i, booted.clock.now());
  }
  return booted.life.getState();
}

/** Advance `hours` hours (same stepping as simulateDays). */
export async function simulateHours(hours, opts = {}) {
  return simulateDays(hours / 24, opts);
}

/**
 * The projection folded from scratch up to and including `eventId` (for
 * storyEquivalent and rewind checks): a fresh createInitialState, the exclusions
 * known at that point (reverts whose own id ≤ eventId, through cascadeIds, and —
 * once eventLog.listRewinds exists — rewound ranges recorded at or before it), then
 * every event with id ≤ eventId through projector.project in id order.
 */
export async function foldAt(eventId, { world } = {}) {
  const projector = await import('../../src/life/projector.js');
  const eventLog = await import('../../src/life/eventLog.js');
  const w = world ?? booted?.world ?? await exampleWorld();
  let state = projector.createInitialState(w);
  for (const r of eventLog.listReverts()) {
    if (r.revertId > eventId) continue;
    for (const id of eventLog.cascadeIds(r.targetId)) state.excluded.add(id);
  }
  if (typeof eventLog.listRewinds === 'function' && Array.isArray(state.excludedRanges)) {
    for (const rw of eventLog.listRewinds()) {
      if (rw.rewindId <= eventId && !state.excludedRanges.some(x => x.from === rw.from && x.to === rw.to)) {
        state.excludedRanges.push({ from: rw.from, to: rw.to });
      }
    }
  }
  let after = 0;
  for (;;) {
    const page = eventLog.eventsAfter(after, 2000).filter(e => e.id <= eventId);
    if (!page.length) break;
    for (const ev of page) state = projector.project(state, ev, w);
    after = page[page.length - 1].id;
    if (after >= eventId) break;
  }
  return state;
}

/**
 * True (and prints `SKIP sim: facade not wired`) until T024 wires the story into the
 * life facade (src/life/index.js exports storyWeeklyPass). Usage:
 *   if (!(await skipSimUnlessWired())) { …sim section… }
 */
export async function skipSimUnlessWired() {
  const life = await import('../../src/life/index.js');
  if (typeof life.storyWeeklyPass === 'function') return false;
  console.log('  SKIP sim: facade not wired');
  return true;
}

// A story module that a later wave adds: null while the file itself is absent; any
// other failure (including a missing import inside it) propagates.
async function importIfExists(rel) {
  const target = fileURLToPath(new URL(rel, import.meta.url));
  if (!fs.existsSync(target)) return null;
  return import(rel);
}

// ── Seeds: people, groups, membership (invented names) ───────────────────────

let seq = 0;
async function dbh() {
  const { getDb } = await import('../../src/memory/db.js');
  return getDb();
}

/** The bot's own identity, so isSelfJid / mentions resolve. */
export async function setBot({ pn = '10000000000:1@s.whatsapp.net', lid = '10000000000:1@lid' } = {}) {
  const { setSelfIdentity } = await import('../../src/utils/selfIdentity.js');
  setSelfIdentity({ id: pn, lid });
  return { pn: pn.replace(/:\d+(?=@)/, ''), lid: lid.replace(/:\d+(?=@)/, '') };
}

/**
 * People with canonical LID ids, an optional PN form bound to each, and a push name.
 * `people` = [{ jid?, name, pn? }] or names. → canonical jids, in order.
 */
export async function seedPeople(people = [], { at = Math.floor(Date.now() / 1000) - 200 * DAY } = {}) {
  const db = await dbh();
  const out = [];
  for (const p of people) {
    const spec = typeof p === 'string' ? { name: p } : p;
    const id = spec.jid || `${7000 + (++seq)}@lid`;
    db.prepare(`INSERT OR IGNORE INTO people (jid, push_name, first_seen) VALUES (?, ?, ?)`).run(id, spec.name ?? null, at);
    db.prepare(`INSERT OR IGNORE INTO person_identities (jid, person_jid, kind, source, seen_at)
      VALUES (?, ?, ?, 'sync', ?)`).run(id, id, id.endsWith('@lid') ? 'lid' : 'pn', at);
    if (spec.pn) {
      const { recordIdentity } = await import('../../src/memory/identity.js');
      recordIdentity(spec.pn, id, 'sync');
    }
    out.push(id);
  }
  return out;
}

/**
 * Groups (`groups` = [{ jid?, name, members: [jid | {jid, joinedAt}] }]), each with its
 * members and marked freshly synced. → group jids, in order.
 */
export async function seedGroups(groups = [], { at = Math.floor(Date.now() / 1000) - 100 * DAY, synced = true } = {}) {
  const db = await dbh();
  const out = [];
  for (const g of groups) {
    const jid = g.jid || `1203630000001${String(++seq).padStart(5, '0')}@g.us`;
    db.prepare(`INSERT OR IGNORE INTO groups (jid, name, joined_at) VALUES (?, ?, ?)`).run(jid, g.name ?? 'Group', at);
    await seedMembership(jid, g.members ?? [], { at, synced });
    out.push(jid);
  }
  return out;
}

/** Add members to a group (`members` = [jid | {jid, joinedAt}]) and mark it freshly synced. */
export async function seedMembership(groupJid, members = [], { at = Math.floor(Date.now() / 1000) - 100 * DAY, synced = true } = {}) {
  const groupStore = await import('../../src/memory/groupStore.js');
  for (const m of members) {
    const pj = typeof m === 'string' ? m : m.jid;
    groupStore.upsertMember(groupJid, pj, 'member', typeof m === 'string' ? at : (m.joinedAt ?? at));
  }
  if (synced) {
    const membership = await import('../../src/memory/membership.js');
    membership.__markSyncedForTest(groupJid);
  }
}

/** The fixture audience of fixtures/claims.json, seeded: its people, groups and the DM person. */
export async function seedClaimAudience(audience) {
  const people = [
    ...audience.group.members,
    { ...audience.dm.person },
    ...audience.elsewhere.members,
  ];
  await seedPeople(people);
  await seedGroups([
    { jid: audience.group.chatJid, name: 'Fixture group', members: audience.group.members.map(m => m.jid) },
    { jid: audience.elsewhere.chatJid, name: 'Another group', members: audience.elsewhere.members.map(m => m.jid) },
  ]);
  return audience;
}

/** The claims fixture (scripts/arcs-tests/fixtures/claims.json), parsed. */
export async function loadClaimsFixture() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'arcs-tests', 'fixtures', 'claims.json'), 'utf-8'));
}
