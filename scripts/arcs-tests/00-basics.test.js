// T026 — the 010 basics (quickstart §2 test 00; FR-002, FR-007, SC-011):
//
//   types     every 010 event type of data-model.md §2.2–2.6 is in EVENT_TYPES and
//             STORY_EVENT_TYPES is exactly that list (parsed from the doc, so the
//             check is not a copy of the code);
//   owner     OWNER_ONLY_TYPES is the data-model §2.1 set; each refuses the engine,
//             jev, mind and chat actors and is accepted from the owner; heavy.started
//             needs heavy:true and an engine/owner actor; no other 010 type may be
//             heavy; a non-owner event with a chat origin can't carry a story type;
//   config    the dashboard-mutable arcs keys reject out-of-range values (never
//             clamped), the .env-only caps aren't patchable, and at boot an out-of-
//             range .env value is clamped (ARCS_HEAVY_MIN_GAP_DAYS < 90 → 90);
//   persona   no persona name/alias anywhere (comments included) and no region,
//             language, voice or place/cast name from the install's world in
//             src/life/story/, the 010 dashboard pages, arcs.example.json or
//             scripts/arcs-tests/. Terms: getPersona(), persona.example.json, an
//             install's world.json when present, and ARCS_GUARD_PERSONA_FILE /
//             ARCS_GUARD_WORLD_FILE (another install's files, read only).
// Scratch DB, no network, no model.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { setupScratchDb, blockNetwork, section, check, eq, throws, report, PROJECT_ROOT, SCRATCH_DB_REL } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const { config, updateConfig, getPersona } = await import('../../src/utils/config.js');
const eventLog = await import('../../src/life/eventLog.js');
const { EVENT_TYPES, STORY_EVENT_TYPES, OWNER_ONLY_TYPES, CHAT_FORBIDDEN_TYPES, appendEvent } = eventLog;

const read = (p) => fs.readFileSync(p, 'utf-8');
const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');

// ── types ───────────────────────────────────────────────────────────────────

const DATA_MODEL = path.join(PROJECT_ROOT, 'specs', '010-relationships-arcs', 'data-model.md');
const docTypes = (() => {
  if (!fs.existsSync(DATA_MODEL)) return null;
  const md = read(DATA_MODEL);
  // §2.2–2.4 and §2.6 (§2.5 only extends 009's decision.* payloads).
  const part = (a, b) => md.slice(md.indexOf(a), md.indexOf(b));
  const body = part('### 2.2', '### 2.5') + part('### 2.6', '## 3.');
  const out = new Set();
  for (const line of body.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] || '';
    if (/\b009\b/.test(first)) continue;            // 009 types the doc only extends
    for (const m of first.matchAll(/`([a-z_]+\.[a-z_]+)`/g)) out.add(m[1]);
  }
  return out;
})();

section('types: the 010 catalogue');
{
  check('data-model.md is readable (specs/ symlink present)', !!docTypes, DATA_MODEL);
  if (docTypes) {
    check(`the doc lists the 010 types (${docTypes.size} found, ≥ 35)`, docTypes.size >= 35, docTypes.size);
    const missing = [...docTypes].filter(t => !EVENT_TYPES.has(t));
    eq('every 010 type of data-model §2.2–2.6 is in EVENT_TYPES', missing, []);
    eq('STORY_EVENT_TYPES = the data-model list (nothing more, nothing less)',
      [...STORY_EVENT_TYPES].sort(), [...docTypes].sort());
  }
  const OWNER_DOC = ['director.action', 'director.fate_set', 'director.slider_set', 'director.pin_set', 'director.pin_cleared',
    'director.paused', 'director.resumed', 'director.bookmark', 'director.bookmark_removed', 'director.seed_set',
    'director.reconciler_mode', 'world.rewound', 'heavy.vetoed'];
  // 011 (story prompt plan §1.2) adds four owner-only types: its weather windows and goals.
  const OWNER_011 = ['weather.window_set', 'weather.window_ended', 'goal.set', 'goal.cancelled'];
  // 014 geo adds its own owner-only list (GEO_EVENT_TYPES; asserted in 50-geo-guards), 014 sched its
  // two schedule overrides; 015 (Director as god plan §1.2) adds its eight owner god types.
  const OWNER_015 = ['outcome.set', 'career.set', 'self.moved', 'money.adjusted', 'vitals.planned', 'sick.planned', 'cast.departed', 'cast.returned'];
  // 016 (scene play-outs plan §1.3): the owner's tone hint and the REGENERATE record.
  const OWNER_016 = ['scene.tone_set', 'scene.regenerated'];
  // Wake him ("can't sleep") adds its owner-only wake.set (WAKE_EVENT_TYPES).
  // 019: the owner's "he texts …" (phone.text_set); the text itself (phone.message) is the engine's.
  eq('OWNER_ONLY_TYPES = data-model §2.1 ∪ the 011 four ∪ the 014 geo + sched lists ∪ the 015 eight ∪ the 016 two ∪ wake.set ∪ phone.text_set', [...OWNER_ONLY_TYPES].sort(),
    [...OWNER_DOC, ...OWNER_011, ...eventLog.GEO_EVENT_TYPES, ...eventLog.SCHEDULE_EVENT_TYPES, ...OWNER_015, ...OWNER_016, ...eventLog.WAKE_EVENT_TYPES, 'phone.text_set'].sort());
  check('019: both phone types chat-forbidden (exact entries), phone.check.* still chat-reachable', CHAT_FORBIDDEN_TYPES.has('phone.message') && CHAT_FORBIDDEN_TYPES.has('phone.text_set')
    && !CHAT_FORBIDDEN_TYPES.has('phone.check.started') && !CHAT_FORBIDDEN_TYPES.has('phone.check.ended'));
  eq('019: the phone list', [...eventLog.PHONE_EVENT_TYPES].sort(), ['phone.message', 'phone.text_set']);
  check('wake.set is owner-only and chat-forbidden', OWNER_ONLY_TYPES.has('wake.set') && CHAT_FORBIDDEN_TYPES.has('wake.set'));
  check('…while sleep.started / woke stay chat-reachable (a chat-adopted outing re-plans his night)', !CHAT_FORBIDDEN_TYPES.has('sleep.started') && !CHAT_FORBIDDEN_TYPES.has('woke'));
  check('every owner-only type is in the catalogue', [...OWNER_ONLY_TYPES].every(t => EVENT_TYPES.has(t)));
  // The 009 catalogue is untouched (37 types at a73cb7f) and still accepted.
  for (const t of ['genesis', 'plan.made', 'decision.opened', 'decision.committed', 'claim.flagged', 'event.reverted', 'sick.started']) {
    check(`009 type ${t} is still in the catalogue`, EVENT_TYPES.has(t));
  }
  // 012 (chat influence) adds its own list; the 009 and 010 parts are unchanged.
  const { INFLUENCE_EVENT_TYPES, STEER_EVENT_TYPES, GOD_EVENT_TYPES } = await import('../../src/life/eventLog.js');
  // 011 adds its own list too (STEER_EVENT_TYPES); 010's doc is not touched. 014 adds geo + sched lists, 015 GOD_EVENT_TYPES.
  eq('the catalogue is 009 (37) + the 010 list + the 012 list + the 011 list + the 014 geo + sched lists + the 015 list + the 016 list + wake + the 018 wallet + the 019 phone + 020 dreams', EVENT_TYPES.size,
    37 + STORY_EVENT_TYPES.size + INFLUENCE_EVENT_TYPES.size + STEER_EVENT_TYPES.size + eventLog.GEO_EVENT_TYPES.size
      + eventLog.SCHEDULE_EVENT_TYPES.size + GOD_EVENT_TYPES.size + eventLog.SCENE_EVENT_TYPES.size + eventLog.WAKE_EVENT_TYPES.size
      + eventLog.WALLET_EVENT_TYPES.size + eventLog.PHONE_EVENT_TYPES.size + eventLog.DREAM_EVENT_TYPES.size);
  eq('the 016 list', [...eventLog.SCENE_EVENT_TYPES].sort(), ['scene.followup', 'scene.followup_lapsed', 'scene.played', 'scene.regenerated', 'scene.tone_set']);
  check('…scene.followup* chat-forbidden, scene.played not', CHAT_FORBIDDEN_TYPES.has('scene.followup') && CHAT_FORBIDDEN_TYPES.has('scene.followup_lapsed')
    && !CHAT_FORBIDDEN_TYPES.has('scene.played'));
  check('…the 016 list and wake.set are disjoint', [...eventLog.SCENE_EVENT_TYPES].every(t => !eventLog.WAKE_EVENT_TYPES.has(t)));
  check('…the 015 list overlaps none of the others', [...GOD_EVENT_TYPES].every(t => !STORY_EVENT_TYPES.has(t)
    && !INFLUENCE_EVENT_TYPES.has(t) && !STEER_EVENT_TYPES.has(t)));
  check('…no 015 type is director.*', [...GOD_EVENT_TYPES].every(t => !t.startsWith('director.')));
  check('…the 010 and 012 lists do not overlap', [...INFLUENCE_EVENT_TYPES].every(t => !STORY_EVENT_TYPES.has(t)));
  check('…the 011 list overlaps neither', [...STEER_EVENT_TYPES].every(t => !STORY_EVENT_TYPES.has(t) && !INFLUENCE_EVENT_TYPES.has(t)));
  check('…no 011 type is director.* (a rewind removes them with their consequences)', [...STEER_EVENT_TYPES].every(t => !t.startsWith('director.')));
}

// ── owner-only + actor rules ────────────────────────────────────────────────

const G = '120363000000000101@g.us';
section('owner: OWNER_ONLY_TYPES refuse every other actor');
{
  const base = appendEvent({ type: 'genesis', actor: 'engine', at: 1_800_000_000, payload: { worldHash: 'x', source: 'example', timezone: 'UTC' } });
  check('a genesis to hang causes on', !!base?.id);
  for (const type of OWNER_ONLY_TYPES) {
    for (const actor of ['engine', 'jev', 'mind', 'chat']) {
      throws(`${type} refused for actor ${actor}`, () => appendEvent({
        type, actor, at: 1_800_000_100, payload: {}, ...(actor === 'chat' ? { originKind: 'group', originJid: G } : {}),
      }), /owner|chat cannot|chat origin/);
    }
    const ev = (() => { try { return appendEvent({ type, actor: 'owner', at: 1_800_000_200, payload: {} }); } catch (err) { return err; } })();
    check(`${type} accepted from the owner (origin owner)`, ev?.id > 0 && ev.originKind === 'owner', ev?.message);
  }
}

section('owner: an owner relationship change (earned trust, Director cast.metrics) comes from the owner only');
{
  for (const actor of ['engine', 'jev', 'mind']) {
    throws(`relationship.changed reason 'owner' refused for actor ${actor}`, () => appendEvent({
      type: 'relationship.changed', actor, at: 1_800_000_250, payload: { castId: 'cast:x', delta: { trust: 0.1 }, reason: 'owner' },
    }), /owner relationship change/);
  }
  const own = appendEvent({ type: 'relationship.changed', actor: 'owner', at: 1_800_000_250, payload: { castId: 'cast:x', delta: { trust: 0.1 }, reason: 'owner' } });
  check('… accepted from the owner (origin owner)', own?.id > 0 && own.originKind === 'owner');
  const eng = appendEvent({ type: 'relationship.changed', actor: 'engine', at: 1_800_000_250, payload: { castId: 'cast:x', delta: { trust: -0.02 }, reason: 'declined', trustWhy: ['declined'] } });
  check('an engine trust change with an earned-trust reason is accepted', eng?.id > 0 && eng.originKind === 'self');
}

section('owner: heavy and chat-origin rules');
{
  for (const actor of ['jev', 'mind', 'chat']) {
    throws(`heavy.started refused for actor ${actor}`, () => appendEvent({
      type: 'heavy.started', actor, heavy: true, at: 1_800_000_300, payload: { kind: 'minor_accident' },
      ...(actor === 'chat' ? { originKind: 'group', originJid: G } : {}),
    }));
  }
  throws('heavy.started must be heavy:true', () => appendEvent({ type: 'heavy.started', actor: 'engine', at: 1_800_000_300, payload: {} }), /must be heavy/);
  const ok = appendEvent({ type: 'heavy.started', actor: 'engine', heavy: true, at: 1_800_000_300, payload: { kind: 'minor_accident' } });
  check('heavy.started from the engine with heavy:true is accepted', ok?.id > 0 && ok.heavy === true);
  const notHeavy = [...STORY_EVENT_TYPES].filter(t => t !== 'heavy.started' && !OWNER_ONLY_TYPES.has(t)).filter(t => {
    try { appendEvent({ type: t, actor: 'engine', heavy: true, at: 1_800_000_400, payload: {} }); return true; } catch { return false; }
  });
  eq('no other 010 type can be appended heavy:true', notHeavy, []);
  const chatAllowed = [...STORY_EVENT_TYPES].filter(t => CHAT_FORBIDDEN_TYPES.has(t)).filter(t => {
    try { appendEvent({ type: t, actor: 'engine', at: 1_800_000_500, originKind: 'group', originJid: G, payload: {} }); return true; } catch { return false; }
  });
  eq('no chat-forbidden 010 type is accepted with a chat origin (engine actor)', chatAllowed, []);
  const fam = ['career.', 'family.', 'heavy.', 'arc.', 'story.', 'cast.', 'place.'];
  const notForbidden = [...STORY_EVENT_TYPES].filter(t => fam.some(p => t.startsWith(p)) || t === 'relationship.changed' || t === 'vitals.nudged')
    .filter(t => !CHAT_FORBIDDEN_TYPES.has(t));
  eq('every story family type is in CHAT_FORBIDDEN_TYPES', notForbidden, []);
  for (const t of ['claim.adopted', 'activity.recorded', 'commitment.recorded', 'claim.withdrawn']) {
    throws(`${t} needs a cause`, () => appendEvent({ type: t, actor: 'engine', at: 1_800_000_600, payload: {} }), /cause/);
    throws(`${t} refused for actor mind`, () => appendEvent({ type: t, actor: 'mind', causeId: 1, at: 1_800_000_600, payload: {} }), /engine/);
  }
}

// ── config bounds ───────────────────────────────────────────────────────────

section('config: dashboard-mutable arcs keys reject out-of-range values');
{
  const before = structuredClone(config.arcs);
  const OUT = {
    'arcs.extractMaxPerHour': [21, -1], 'arcs.extractMaxPerDay': [121], 'arcs.trayHours': [11, 169], 'arcs.clerkMaxPerDay': [201],
    'arcs.jevMaxPerDay': [41], 'arcs.mindBudgetUsd': [3.01, -0.5], 'arcs.bigLeadHours': [23, 169], 'arcs.rewindDays': [0, 31],
    'arcs.narrateMaxPerHour': [41], 'arcs.narrateMaxPerDay': [201],
    // 011: the Director prompt's day cap and its own $ sub-cap
    'arcs.promptMaxPerDay': [61, -1], 'arcs.promptBudgetUsd': [3.01, -0.1],
  };
  for (const [k, vals] of Object.entries(OUT)) {
    for (const v of vals) {
      const r = updateConfig({ [k]: v });
      check(`${k}=${v} rejected (not clamped)`, !(k in r.applied) && /out of range \(allowed /.test(r.rejected[k] || ''), r);
    }
  }
  eq('…and config.arcs is unchanged', config.arcs, before);
  const good = updateConfig({ 'arcs.extractMaxPerHour': 5, 'arcs.bigLeadHours': 48, 'arcs.weeklyEffort': 'medium', 'arcs.journalEnabled': false });
  eq('in-range values apply', good.applied, { 'arcs.extractMaxPerHour': 5, 'arcs.bigLeadHours': 48, 'arcs.weeklyEffort': 'medium', 'arcs.journalEnabled': false });
  const effort = updateConfig({ 'arcs.weeklyEffort': 'max' });
  check('weeklyEffort accepts only ""|low|medium|high (max rejected)', !!effort.rejected['arcs.weeklyEffort']);
  for (const k of ['arcs.enabled', 'arcs.reconcilerMode', 'arcs.bookmarksMax', 'arcs.heavyMinGapDays', 'arcs.castMax',
    'arcs.newCastPer90d', 'arcs.beatsPerWeek', 'arcs.journalMaxChars', 'arcs.journalMaxCalls']) {
    const r = updateConfig({ [k]: k === 'arcs.enabled' ? true : k === 'arcs.reconcilerMode' ? 'off' : 1 });
    check(`${k} is .env-only / the skill (not allow-listed)`, r.rejected[k] === 'not allow-listed', r);
  }
  updateConfig({ 'arcs.extractMaxPerHour': before.extractMaxPerHour, 'arcs.bigLeadHours': before.bigLeadHours,
    'arcs.weeklyEffort': before.weeklyEffort, 'arcs.journalEnabled': before.journalEnabled });
  eq('restored', config.arcs, before);
  eq('arcs ships off (ARCS_ENABLED boot default false)', config.arcs.enabled, false);
  eq('011: prompt defaults (20/day, $0.5 sub-cap)', [config.arcs.promptMaxPerDay, config.arcs.promptBudgetUsd], [20, 0.5]);
  const p = updateConfig({ 'arcs.promptMaxPerDay': 0, 'arcs.promptBudgetUsd': 1.5 });
  eq('011: prompt keys are dashboard-mutable (0 turns the prompt off)', p.applied, { 'arcs.promptMaxPerDay': 0, 'arcs.promptBudgetUsd': 1.5 });
  updateConfig({ 'arcs.promptMaxPerDay': before.promptMaxPerDay, 'arcs.promptBudgetUsd': before.promptBudgetUsd });
  eq('…restored', config.arcs, before);
}

section('config: .env values at boot (a child process per env)');
{
  const boot = (env) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { config } = await import('./src/utils/config.js'); process.stdout.write('\\n@@ARCS@@' + JSON.stringify(config.arcs));"], {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH: SCRATCH_DB_REL, DRY_RUN: 'true', LOG_LEVEL: 'silent', ...env },
    });
    const at = String(r.stdout || '').lastIndexOf('@@ARCS@@');
    try { return { arcs: JSON.parse(r.stdout.slice(at + 8)), stderr: `${r.stderr}${r.stdout.slice(0, Math.max(0, at))}` }; }
    catch { return { arcs: null, stderr: `${r.stderr}${r.stdout}` }; }
  };
  const d = boot({});
  check('defaults load', !!d.arcs, d.stderr);
  eq('defaults: heavy gap 90, cast max 24, rewind 14 d, big lead 24 h, reconciler auto',
    [d.arcs?.heavyMinGapDays, d.arcs?.castMax, d.arcs?.rewindDays, d.arcs?.bigLeadHours, d.arcs?.reconcilerMode], [90, 24, 14, 24, 'auto']);
  const low = boot({ ARCS_HEAVY_MIN_GAP_DAYS: '30' });
  eq('ARCS_HEAVY_MIN_GAP_DAYS=30 → clamped up to 90', low.arcs?.heavyMinGapDays, 90);
  check('…with a warning', /ARCS_HEAVY_MIN_GAP_DAYS/.test(low.stderr || ''), low.stderr);
  eq('ARCS_HEAVY_MIN_GAP_DAYS=400 → kept (it can be raised)', boot({ ARCS_HEAVY_MIN_GAP_DAYS: '400' }).arcs?.heavyMinGapDays, 400);
  eq('ARCS_EXTRACT_MAX_PER_HOUR=99 → 20 (the .env range is a hard cap)', boot({ ARCS_EXTRACT_MAX_PER_HOUR: '99' }).arcs?.extractMaxPerHour, 20);
  eq('ARCS_CAST_MAX=500 → 24', boot({ ARCS_CAST_MAX: '500' }).arcs?.castMax, 24);
  eq('ARCS_JOURNAL_MAX_CHARS=5000 → 1200', boot({ ARCS_JOURNAL_MAX_CHARS: '5000' }).arcs?.journalMaxChars, 1200);
  eq('ARCS_NEW_CAST_PER_90D=9 → 2', boot({ ARCS_NEW_CAST_PER_90D: '9' }).arcs?.newCastPer90d, 2);
  eq('ARCS_RECONCILER_MODE=bogus → auto', boot({ ARCS_RECONCILER_MODE: 'bogus' }).arcs?.reconcilerMode, 'auto');
  eq('ARCS_ENABLED=yes → false (bool only)', boot({ ARCS_ENABLED: 'yes' }).arcs?.enabled, false);
}

// ── persona and region guard ────────────────────────────────────────────────

section('persona: no persona, region or world names in the 010 surface');
{
  const readJson = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
  const personas = [];
  try { personas.push(getPersona()); } catch { /* the example below */ }
  personas.push(readJson(path.join(PROJECT_ROOT, 'src/personality/persona.example.json')));
  if (process.env.ARCS_GUARD_PERSONA_FILE) {
    const p = readJson(process.env.ARCS_GUARD_PERSONA_FILE);
    check('ARCS_GUARD_PERSONA_FILE is readable JSON', !!p, process.env.ARCS_GUARD_PERSONA_FILE);
    if (p) personas.push(p);
  }
  const worlds = [];
  const installWorld = path.join(PROJECT_ROOT, 'src/personality/world.json');
  if (fs.existsSync(installWorld)) worlds.push(readJson(installWorld));
  if (process.env.ARCS_GUARD_WORLD_FILE) {
    const w = readJson(process.env.ARCS_GUARD_WORLD_FILE);
    check('ARCS_GUARD_WORLD_FILE is readable JSON', !!w, process.env.ARCS_GUARD_WORLD_FILE);
    if (w) worlds.push(w);
  }

  // Generic words (place kinds, everyday nouns) are not identifying: only the rest of a
  // world's place/cast/employer names count. The example world's own words are generic too.
  const GENERIC = new Set(`home flat office cafe café corner neighbourhood neighborhood gym supermarket grocery store shop lake park
    walking track meals place restaurant bar brewpub pub mall multiplex cinema theatre theater badminton courts court sports
    family house the and of in at near new old main city town street road station club centre center hall`.split(/\s+/).filter(Boolean));
  const ex = readJson(path.join(PROJECT_ROOT, 'src/personality/world.example.json')) || {};
  const words = (s) => String(s ?? '').match(/[\p{L}][\p{L}'’-]*/gu) || [];
  for (const s of [...(ex.places || []).map(p => p.name), ...(ex.cast || []).map(c => c.name), ...(ex.places || []).map(p => p.kind)]) {
    for (const w of words(s)) GENERIC.add(w.toLowerCase());
  }

  // The project's own name (package.json) is also the default persona name.
  const names = new Set([readJson(path.join(PROJECT_ROOT, 'package.json'))?.name].filter(Boolean));
  const phrases = new Set();
  const regionWords = new Set();
  for (const p of personas.filter(Boolean)) {
    for (const k of ['name', 'displayName']) if (typeof p[k] === 'string' && p[k].trim()) names.add(p[k].trim());
    for (const a of Array.isArray(p.aliases) ? p.aliases : []) if (typeof a === 'string' && a.trim()) names.add(a.trim());
    for (const k of ['region', 'language', 'voiceDescriptor', 'vibe']) {
      if (typeof p[k] !== 'string' || !p[k].trim()) continue;
      phrases.add(p[k].trim());
      // Region/language/voice words that are proper nouns (capitalised, not generic) count on their own.
      if (k !== 'vibe') for (const w of words(p[k])) if (/^\p{Lu}/u.test(w) && w.length >= 4 && !GENERIC.has(w.toLowerCase())) regionWords.add(w);
    }
  }
  const worldTerms = new Set();
  for (const w of worlds.filter(Boolean)) {
    const strings = [
      ...(w.places || []).map(p => p?.name), ...(w.cast || []).map(c => c?.name),
      w.self?.job?.employerName, w.region, w.city,
    ];
    for (const s of strings) for (const t of words(s)) if (t.length >= 3 && !GENERIC.has(t.toLowerCase())) worldTerms.add(t);
  }
  check('persona terms loaded (names + phrases)', names.size >= 2 && phrases.size >= 2, { names: names.size, phrases: phrases.size });
  if (!worlds.length) console.log('    (no world.json here: set ARCS_GUARD_WORLD_FILE=<install>/src/personality/world.json to check one)');
  if (!process.env.ARCS_GUARD_PERSONA_FILE) console.log('    (set ARCS_GUARD_PERSONA_FILE=<install>/src/personality/persona.json to check a real persona too)');

  const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|json)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const PAGES = ['life-cast', 'life-cast-member', 'life-story', 'life-pending', 'life-journal', 'life-director']
    .map(n => path.join(PROJECT_ROOT, 'src/dashboard/public/js/pages', `${n}.js`));
  const files = [
    ...walk(path.join(PROJECT_ROOT, 'src/life/story')),
    ...PAGES.filter(p => fs.existsSync(p)),
    path.join(PROJECT_ROOT, 'src/personality/arcs.example.json'),
    ...walk(path.join(PROJECT_ROOT, 'scripts/arcs-tests')),
  ].filter(p => fs.existsSync(p));
  const storyCount = files.filter(p => rel(p).startsWith('src/life/story/')).length;
  check(`the scan sees the 010 surface (${files.length} files: ≥ 20 story modules, the pages, the seed, the tests)`,
    storyCount >= 20 && PAGES.filter(p => files.includes(p)).length >= 5 && files.some(p => p.endsWith('arcs.example.json'))
      && files.filter(p => rel(p).startsWith('scripts/arcs-tests/')).length >= 20, { storyCount, files: files.length });

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (t) => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(t)}($|[^\\p{L}\\p{N}_])`, 'iu');
  const hits = (terms, label) => files.flatMap(f => {
    const src = read(f);
    return [...terms].filter(t => word(t).test(src)).map(t => `${rel(f)}: ${label} #${[...terms].indexOf(t)}`);
  });
  eq('no persona name or alias (comments included)', hits(names, 'name'), []);
  eq('no persona region/language/voice/vibe phrase', hits(phrases, 'phrase'), []);
  eq('no proper noun from the persona region/language/voice', hits(regionWords, 'region word'), []);
  eq('no place, cast or employer name from an install world', hits(worldTerms, 'world term'), []);
  check('the persona/world guard is exercised with real terms when files are given',
    !process.env.ARCS_GUARD_WORLD_FILE || worldTerms.size >= 3, { worldTerms: worldTerms.size });
}

eq('no network attempts', net.count, 0);
report();
