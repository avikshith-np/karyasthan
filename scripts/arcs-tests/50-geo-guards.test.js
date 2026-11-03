// 014 geo (plan §2, §4 arcs-tests/50): static and catalogue guards.
//   imports   no fetch( / http import / geo client import anywhere under
//             src/life/** outside src/life/geo/; src/life/geo/ imported only by
//             src/life/index.js (and src/index.js, which builds the one client);
//             src/dashboard/** imports no src/life/geo/ (R10); routes/places.js
//             imports only the life facade + the arcs route helpers
//   tests     no test file sets GEO_ENABLED or builds the client without a fetch (R11)
//   overlay   no bare worldOverlay( call outside reducer.js / story/index.js
//             (+ the reviewed pre-014 callers that now get places through it, R19)
//   types     GEO_TYPE_LIST owner-only and chat-forbidden; NEGATIVE ∪ NEUTRAL covers
//             EVENT_TYPES (R4)
//   route     actionProblem rejects client venue / lat / lon / routes / swaps (R18, T8)
//   config    the GEO keys are not dashboard-mutable; /api/status geo is booleans
import fs from 'fs';
import path from 'path';
import { section, check, eq, report, PROJECT_ROOT } from './_helpers.js';

const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(p, 'utf-8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SRC = path.join(PROJECT_ROOT, 'src');
const lifeFiles = walk(path.join(SRC, 'life'));
const allSrc = walk(SRC);

section('imports');
{
  const geoDir = 'src/life/geo/';
  const outside = lifeFiles.filter(f => !rel(f).startsWith(geoDir));
  check('found the life tree', outside.length > 30, outside.length);
  const fetchers = outside.filter(f => /\bfetch\s*\(/.test(code(read(f))) || /from\s+['"](?:node:)?https?['"]/.test(read(f)));
  eq('no fetch( / http import under src/life outside geo/', fetchers.map(rel), []);
  const importers = allSrc.filter(f => !rel(f).startsWith(geoDir) && /from\s+['"][^'"]*\/geo\/[a-z]+\.js['"]/.test(read(f)) && /life\/geo\/|\.\/geo\//.test(read(f)));
  eq('geo/ is imported only by the life facade and src/index.js', importers.map(rel).sort(), ['src/index.js', 'src/life/index.js']);
  const dash = walk(path.join(SRC, 'dashboard')).filter(f => /life\/geo\//.test(read(f)));
  eq('the dashboard imports no src/life/geo/', dash.map(rel), []);
  const placesRoute = read(path.join(SRC, 'dashboard/routes/places.js'));
  const imports = [...placesRoute.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]).sort();
  eq('routes/places.js imports the life facade, audit and the arcs helpers only', imports, ['../../life/index.js', '../audit.js', './arcs.js']);
  const geoFetch = walk(path.join(SRC, 'life/geo')).filter(f => /\bfetch\s*\(/.test(code(read(f))));
  eq('inside geo/ only client.js calls fetch', geoFetch.map(rel), ['src/life/geo/client.js']);
  const client = read(path.join(SRC, 'life/geo/client.js'));
  check('…and it has no default fetch (R11)', /if \(typeof fetch !== 'function'\) throw/.test(client) && !/fetch\s*=\s*globalThis\.fetch/.test(client));
}

section('tests never reach a real host (R11)');
{
  const tests = [...walk(path.join(PROJECT_ROOT, 'scripts')).filter(f => /\.test\.js$/.test(f))];
  check('found the test files', tests.length > 50, tests.length);
  eq('no test sets GEO_ENABLED', tests.filter(f => /process\.env\.GEO_ENABLED\s*=|GEO_ENABLED\s*:\s*['"]/.test(read(f))).map(rel), []);
  // A call is fine when its options name a fetch, or when it is the one deliberate
  // "throws without a fetch" check (inside a try on the same line).
  const bad = tests.filter(f => read(f).split('\n').some(l => /createGeoClient\s*\(\s*\{/.test(l) && !/\bfetch\b/.test(l) && !/try\s*\{/.test(l)
    && !/fetch/.test(read(f).slice(read(f).indexOf(l), read(f).indexOf(l) + 400).split('});')[0])));
  eq('every createGeoClient( in a test passes a fetch', bad.map(rel), []);
  const helpers = read(path.join(PROJECT_ROOT, 'scripts/life-tests/_helpers.js'));
  check('the shared helpers stub non-loopback fetch', /non-loopback fetch/.test(helpers));
}

section('one overlay seam (R19)');
{
  const ALLOWED = new Set(['src/life/story/reducer.js', 'src/life/story/index.js',
    // reviewed pre-014 callers: they reach the projected places THROUGH worldOverlay now
    'src/life/projector.js', 'src/life/story/career.js', 'src/life/story/heavy.js', 'src/life/story/weekly.js',
    'src/life/story/tomorrow.js', 'src/life/story/reconciler.js', 'src/life/story/director.js']);
  const callers = allSrc.filter(f => /\bworldOverlay\s*\(/.test(code(read(f)))).map(rel);
  eq('worldOverlay( only in the reviewed files', callers.filter(f => !ALLOWED.has(f)), []);
  check('reducer.worldOverlay composes worldWithPlaces', /export function worldOverlay\(state, worldIn\) \{[\s\S]{0,300}worldWithPlaces\(state, worldIn\)/.test(read(path.join(SRC, 'life/story/reducer.js'))));
}

section('event types');
{
  const eventLog = await import('../../src/life/eventLog.js');
  const places = await import('../../src/life/places.js');
  eq('GEO_TYPE_LIST', [...eventLog.GEO_EVENT_TYPES], ['route.recorded']);
  check('route.recorded is owner-only', eventLog.OWNER_ONLY_TYPES.has('route.recorded'));
  check('…and chat-forbidden', eventLog.CHAT_FORBIDDEN_TYPES.has('route.recorded'));
  const missing = [...eventLog.EVENT_TYPES].filter(t => !places.NEGATIVE_TYPES.has(t) && !places.NEUTRAL_TYPES.has(t));
  eq('every event type is classified negative or neutral (R4)', missing, []);
  const both = [...places.NEGATIVE_TYPES].filter(t => places.NEUTRAL_TYPES.has(t));
  eq('…and none is both', both, []);
  check('sched\'s types are pre-classified neutral by name', ['schedule.override_set', 'schedule.override_cleared'].every(t => places.NEUTRAL_TYPES.has(t)));
  const life = await import('../../src/life/index.js');
  check('route.recorded is not one of "his day" types (selfEventTypes)', !life.selfEventTypes().includes('route.recorded') && life.selfEventTypes().includes('meal'));
}

section('route shape (R18, T8)');
{
  const { actionProblem } = await import('../../src/dashboard/routes/director.js');
  const cid = 'cand:00000000-0000-4000-8000-000000000000';
  eq('a clean place.real', actionProblem({ kind: 'place.real', candidateId: cid, as: 'new' }), null);
  for (const extra of [{ lat: 1 }, { lon: 2 }, { venue: { ref: 'node/1' } }, { routes: [] }, { swaps: [] }, { resolved: {} }]) {
    eq(`client ${Object.keys(extra)[0]} rejected`, actionProblem({ kind: 'place.real', candidateId: cid, as: 'new', ...extra }), 'venue_data');
  }
  const { ACTION_KINDS } = await import('../../src/dashboard/routes/director.js');
  if (ACTION_KINDS.has('schedule')) {
    eq('…also nested in a schedule range', actionProblem({ kind: 'schedule', ranges: [{ activity: 'out', candidateId: cid, lat: 1 }] }), 'venue_data');
  } else {
    console.log('  SKIP schedule range venue data: the schedule kind lands with the sched branch (P.4)');
  }
  eq('bad candidate id', actionProblem({ kind: 'place.real', candidateId: 'x', as: 'new' }), 'bad_candidateId');
  eq('replace needs a place id', actionProblem({ kind: 'place.real', candidateId: cid, as: 'replace' }), 'bad_placeId');
  eq('realify needs a result id', actionProblem({ kind: 'places.realify', resultId: 'nope' }), 'bad_resultId');
}

section('config');
{
  const cfg = read(path.join(SRC, 'utils/config.js'));
  const mutable = cfg.slice(cfg.indexOf('const MUTABLE_KEYS = {'), cfg.indexOf('};', cfg.indexOf('const MUTABLE_KEYS = {')));
  check('found MUTABLE_KEYS', mutable.length > 100);
  check('no geo key is dashboard-mutable', !/geo\./i.test(mutable) && !/GEO_/.test(mutable));
  const status = read(path.join(SRC, 'dashboard/routes/status.js'));
  check('/api/status geo is booleans only', /nominatim: !!g\?\.hosts\?\.nominatim\?\.configured/.test(status) && !/nominatimUrl|contactEmail/.test(status));
}

report();
