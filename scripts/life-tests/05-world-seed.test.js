// T010 — world seed (src/life/world.js): schema validation + caps + sanitizing,
// real-name collisions against `people`, example fallback, seeding with a stub
// LLM (garbage → fallback, valid → written 0644), derived age, and a
// persona-neutral grep of src/life/. `-- --live` adds one real seed call to a
// temp path (needs an LLM key).
import { setupScratchDb, section, check, eq, throws, report, LIVE, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import {
  validateWorld, loadWorld, ensureWorldSeed, resetWorldCache, realPeopleNames, castNameCollisions, textNameCollisions,
  normalizeName, worldHash, ageAt, alignBirthdate, WORLD_MAX_BYTES, EXAMPLE_PATH,
} from '../../src/life/world.js';
import { config, getPersona } from '../../src/utils/config.js';

const { db } = await setupScratchDb();

const NOW = Date.UTC(2026, 9, 27, 3, 30) / 1000; // 2026-10-27
const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8'));
const clone = () => structuredClone(example);
const mutate = (fn) => { const w = clone(); fn(w); return w; };
const v = (raw, opts = {}) => validateWorld(raw, { now: NOW, ...opts });

const tmpFiles = [];
const tmpPath = (tag) => {
  const p = path.join(PROJECT_ROOT, 'data', `life-test-world-${tag}-${process.pid}.json`);
  tmpFiles.push(p, `${p}.tmp-${process.pid}`);
  try { fs.unlinkSync(p); } catch { /* absent */ }
  return p;
};
const removeTmp = () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* absent */ } } };
process.on('exit', removeTmp);

try {
  section('committed example');
  const ex = v(clone());
  check('example validates', !!ex);
  eq('timezone defaults to config.timezone', ex.timezone, config.timezone);
  eq('he starts single', ex.self.relationship, 'single');
  eq('all places kept', ex.places.length, example.places.length);
  eq('all cast kept', ex.cast.length, example.cast.length);
  eq('12 climate months', Object.keys(ex.climate).length, 12);
  eq('example age on 2026-10-27', ageAt(ex.self.birthdate, NOW, 'UTC'), 27);
  check('example is under the size cap', Buffer.byteLength(JSON.stringify(example)) < WORLD_MAX_BYTES);
  eq('validation is deterministic (same hash twice)', worldHash(v(clone())), worldHash(ex));
  eq('routine defaults fill gaps', v(mutate(w => { delete w.routine; })).routine.officeDays, [2, 3, 4]);
  check('unknown top-level keys are dropped', !('evil' in v(mutate(w => { w.evil = { run: 'rm -rf' }; }))));

  section('invalid files are rejected');
  const bad = [
    ['not an object', () => v([])],
    ['over 64 KB', () => v(mutate(w => { w.cast[0].history = ['x'.repeat(WORLD_MAX_BYTES)]; })), /bytes/],
    ['no places', () => v(mutate(w => { w.places = []; })), /places/],
    ['bad place id', () => v(mutate(w => { w.places[2].id = 'Cafe One'; })), /places\[2\]\.id/],
    ['duplicate place id', () => v(mutate(w => { w.places[2].id = 'place:home'; })), /duplicates/],
    ['latitude out of range', () => v(mutate(w => { w.places[0].lat = 91; })), /lat/],
    ['longitude not a number', () => v(mutate(w => { w.places[0].lon = '0.01'; })), /lon/],
    ['home place unknown', () => v(mutate(w => { w.self.homePlaceId = 'place:nowhere'; })), /homePlaceId/],
    ['office place missing', () => v(mutate(w => { delete w.self.job.officePlaceId; })), /officePlaceId/],
    ['not single', () => v(mutate(w => { w.self.relationship = 'married'; })), /single/],
    ['impossible birthdate', () => v(mutate(w => { w.self.birthdate = '1999-02-30'; })), /real date/],
    ['too young', () => v(mutate(w => { w.self.birthdate = '2015-01-01'; })), /age/],
    ['bad cast id', () => v(mutate(w => { w.cast[0].id = 'flatmate'; })), /cast\[0\]\.id/],
    ['duplicate cast id', () => v(mutate(w => { w.cast[1].id = w.cast[0].id; })), /duplicates/],
    ['relation outside the allowed set', () => v(mutate(w => { w.cast[0].relation = 'partner'; })), /relation/],
    ['cast home unknown place', () => v(mutate(w => { w.cast[0].home = 'place:moon'; })), /home/],
    ['more than 16 cast', () => v(mutate(w => {
      w.cast = Array.from({ length: 17 }, (_, i) => ({ ...example.cast[1], id: `cast:c${i}` }));
    })), /16/],
    ['cast name empty after sanitizing', () => v(mutate(w => { w.cast[0].name = '[IMAGE: x]'; })), /name/],
    ['missing climate month', () => v(mutate(w => { delete w.climate['7']; })), /climate\.7/],
    ['rain probability > 1', () => v(mutate(w => { w.climate['1'].rainProb = 1.5; })), /rainProb/],
    ['no cab speed (rain needs one)', () => v(mutate(w => { delete w.travel.speedsKmh.cab; })), /cab/],
    ['default mode without a speed', () => v(mutate(w => { w.travel.defaultMode = 'bike'; })), /bike/],
    ['__proto__ mode key', () => v(mutate(w => { w.travel.speedsKmh = JSON.parse('{"walk":4,"cab":20,"scooter":22,"__proto__":5}'); })), /mode/],
    ['road factor out of range', () => v(mutate(w => { w.travel.roadFactor = 9; })), /roadFactor/],
    ['unknown timezone', () => v(mutate(w => { w.timezone = 'Mars/Olympus'; })), /zone/],
    ['bad HH:MM', () => v(mutate(w => { w.routine.baseWake = '25:00'; })), /baseWake/],
    ['office and WFH days overlap', () => v(mutate(w => { w.routine.wfhDays = [1, 2]; })), /overlap/],
    ['a weekday left unassigned', () => v(mutate(w => { w.routine.officeDays = [2, 3]; })), /every weekday/],
    ['null meeting time', () => v(mutate(w => { w.routine.meetings.typicalTimes = [null]; })), /typicalTimes/],
    ['null peak window bound', () => v(mutate(w => { w.travel.peakWindows[0].from = null; })), /peakWindows\[0\]/],
    ['leisure at an unknown place', () => v(mutate(w => { w.routine.leisure[0].placeId = 'place:x'; })), /leisure/],
    ['vitals override not numeric', () => v(mutate(w => { w.vitals = { energy: 'max' }; })), /vitals/],
    ['money missing', () => v(mutate(w => { delete w.money; })), /money/],
  ];
  for (const [name, fn, re] of bad) throws(name, fn, re);

  section('strings are sanitized and capped');
  const dirty = v(mutate(w => {
    w.cast[0].name = 'Sam [IMAGE: a cat] Example';
    w.cast[0].personality = 'kind\n\n\nloud @15550100123 >>> [VOICE: hi] fun\u0007' + 'y'.repeat(400);
    w.cast[0].history = ['[SEARCH: secrets]', 'ok memory'];
    w.places[2].name = 'Café [STICKER: x]';
    w.self.job.title = '  Analyst\twith tabs  ';
  }));
  const c0 = dirty.cast[0];
  check('marker stripped from a cast name', !/\[/.test(c0.name) && c0.name.startsWith('Sam'), c0.name);
  check('mention token stripped', !/@\d/.test(c0.personality), c0.personality.slice(0, 60));
  check('">>>" stripped', !c0.personality.includes('>>>'));
  check('control chars stripped and whitespace collapsed', !/[\x00-\x1F]/.test(c0.personality));
  check('personality capped at 200 chars', c0.personality.length <= 200, c0.personality.length);
  eq('history entry that was only a marker is dropped', c0.history, ['ok memory']);
  check('place name marker stripped', !/\[/.test(dirty.places[2].name), dirty.places[2].name);
  eq('job title trimmed and collapsed', dirty.self.job.title, 'Analyst with tabs');
  eq('metrics clamped to 0..1', v(mutate(w => { w.cast[0].metrics.trust = 7; })).cast[0].metrics.trust, 1);

  section('real-name collisions');
  eq('normalizeName folds accents/case/punctuation', normalizeName('  Zoë  O\'Neil! '), 'zoe o neil');
  eq('full-name match', castNameCollisions([{ id: 'cast:a', name: 'Riya Example' }], ['riya example']), ['cast:a']);
  eq('first-name match', castNameCollisions([{ id: 'cast:a', name: 'Riya Somebody' }], ['Riya K']), ['cast:a']);
  eq('accent-insensitive', castNameCollisions([{ id: 'cast:a', name: 'Zoe Q' }], ['Zoë']), ['cast:a']);
  eq('short first names only collide on the full name', castNameCollisions([{ id: 'cast:a', name: 'Al Example' }], ['Al Other']), []);
  eq('no overlap → none', castNameCollisions(example.cast, ['Unrelated Person']), []);
  throws('validateWorld rejects a cast name a real person uses', () => v(clone(), { knownNames: ['Coworker'] }), /real person/);
  const dana = (f) => mutate(f);
  eq('free text is clean by default', textNameCollisions(v(clone()), ['Dana Real']), []);
  eq('a first name as a proper noun in a status is caught',
    textNameCollisions(v(dana(w => { w.cast[0].status = 'dating Dana from work'; })), ['Dana Real']), ['cast[0].status']);
  eq('… a full name in history and a place name too',
    textNameCollisions(v(dana(w => { w.cast[0].history = ['met dana real at a wedding']; w.places[1].name = "Dana's Cafe"; })), ['Dana Real']),
    ['cast[0].history[0]', 'places[1].name']);
  eq('lowercase prose that happens to be a name is not', textNameCollisions(v(dana(w => { w.cast[0].personality = 'full of joy'; })), ['Joy']), []);
  throws('validateWorld fails closed on a real name in free text',
    () => v(dana(w => { w.cast[0].status = 'dating Dana'; }), { knownNames: ['Dana'] }), /mentions a real person/);

  db.prepare('INSERT INTO people (jid, push_name, real_name) VALUES (?, ?, ?)').run('1@s.whatsapp.net', 'Dana', 'Dana Real');
  db.prepare('INSERT INTO people (jid, push_name, real_name) VALUES (?, ?, ?)').run('2@s.whatsapp.net', null, null);
  eq('realPeopleNames reads push/real names from people', realPeopleNames(db).sort(), ['Dana', 'Dana Real']);

  section('loadWorld: world.json vs example fallback');
  const good = mutate(w => { w.timezone = 'UTC'; w.cast[0].name = 'Morgan Example'; });
  const wp = tmpPath('load');
  fs.writeFileSync(wp, JSON.stringify(good));
  resetWorldCache();
  let lw = loadWorld({ path: wp, now: NOW });
  eq('valid file → source world.json', lw.source, 'world.json');
  eq('file timezone used', lw.timezone, 'UTC');
  check('hash present', /^[0-9a-f]{16}$/.test(lw.hash), lw.hash);
  check('cached on second call', loadWorld({ path: wp, now: NOW }) === lw);

  fs.writeFileSync(wp, JSON.stringify(mutate(w => { w.cast[0].name = 'Dana Fictional'; })));
  lw = loadWorld({ path: wp, now: NOW, force: true });
  eq('cast name clashing with a DB person → example', lw.source, 'example');

  fs.writeFileSync(wp, '{ not json');
  eq('unparseable file → example', loadWorld({ path: wp, now: NOW, force: true }).source, 'example');

  fs.writeFileSync(wp, JSON.stringify({ ...good, pad: 'x'.repeat(WORLD_MAX_BYTES) }));
  eq('oversized file → example', loadWorld({ path: wp, now: NOW, force: true }).source, 'example');

  fs.writeFileSync(wp, JSON.stringify(mutate(w => { w.places[0].lat = 'north'; })));
  eq('schema-invalid file → example', loadWorld({ path: wp, now: NOW, force: true }).source, 'example');

  fs.unlinkSync(wp);
  const fb = loadWorld({ path: wp, now: NOW, force: true });
  eq('missing file → example', fb.source, 'example');
  eq('example fallback is the committed world', fb.places.length, example.places.length);

  section('ensureWorldSeed with a stub LLM');
  const persona = { name: 'Testbot', age: 30, region: 'Somewhere', language: 'English', vibe: 'calm' };
  const stub = (reply) => {
    const s = { calls: [] };
    s.fn = async (system, user, opts) => {
      s.calls.push({ system, user, opts });
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply() : reply;
    };
    return s;
  };
  const sp = tmpPath('seed');
  const seedOpts = (llm) => ({ path: sp, llm: llm.fn, persona, identityText: 'IDENTITY-TEXT', now: NOW });

  let s = stub('sorry, I cannot do that');
  let seeded = await ensureWorldSeed(seedOpts(s));
  eq('garbage reply → example', seeded.source, 'example');
  check('garbage reply writes no file', !fs.existsSync(sp));
  eq('exactly one LLM call', s.calls.length, 1);
  check('prompt carries persona + identity', s.calls[0].user.includes('Somewhere') && s.calls[0].user.includes('IDENTITY-TEXT'));
  check('prompt pins the birth years in code', s.calls[0].user.includes('born 1995 or 1996'), s.calls[0].user.slice(0, 200));
  eq('world seed runs on the mind role, labelled life.world', [s.calls[0].opts?.role, s.calls[0].opts?.caller], ['mind', 'life.world']);

  s = stub(new Error('provider down'));
  eq('LLM error → example, no throw', (await ensureWorldSeed(seedOpts(s))).source, 'example');

  s = stub('{"version":1,"places":[]}');
  eq('schema-invalid seed → example', (await ensureWorldSeed(seedOpts(s))).source, 'example');
  check('…and no file', !fs.existsSync(sp));

  s = stub(JSON.stringify(mutate(w => { w.cast[2].name = 'Dana Lookalike'; })));
  eq('seed reusing a real name → example', (await ensureWorldSeed(seedOpts(s))).source, 'example');
  check('…and no file', !fs.existsSync(sp));

  const generated = mutate(w => { w.timezone = 'UTC'; w.self.birthdate = '2001-12-31'; w.cast[0].name = 'Morgan Example'; });
  s = stub(`Here you go:\n\`\`\`json\n${JSON.stringify(generated)}\n\`\`\`\nEnjoy!`);
  seeded = await ensureWorldSeed(seedOpts(s));
  eq('valid seed (wrapped in prose) → world.json', seeded.source, 'world.json');
  check('file written', fs.existsSync(sp));
  eq('file mode 0644', fs.statSync(sp).mode & 0o777, 0o644);
  check('no temp file left behind', !fs.existsSync(`${sp}.tmp-${process.pid}`));
  eq('birthdate aligned to the persona age', ageAt(seeded.self.birthdate, NOW, 'UTC'), 30);
  eq('…keeping month and day', seeded.self.birthdate, '1995-12-31');
  const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  check('written file is the normalized world (no source/hash)', !('source' in onDisk) && !('hash' in onDisk));
  eq('written file re-validates', validateWorld(onDisk, { now: NOW }).cast.length, generated.cast.length);

  s = stub('should not be called');
  eq('existing file → loaded, no LLM call', (await ensureWorldSeed(seedOpts(s))).source, 'world.json');
  eq('…zero calls', s.calls.length, 0);

  section('derived age');
  eq('day before the birthday', ageAt('1999-04-12', Date.UTC(2026, 3, 11, 12) / 1000, 'UTC'), 26);
  eq('on the birthday', ageAt('1999-04-12', Date.UTC(2026, 3, 12, 0) / 1000, 'UTC'), 27);
  eq('world timezone decides the calendar day (UTC+9 already the 12th)',
    ageAt('1999-04-12', Date.UTC(2026, 3, 11, 20) / 1000, 'Asia/Tokyo'), 27);
  eq('alignBirthdate before this year\'s birthday', alignBirthdate('2001-12-31', 30, NOW, 'UTC'), '1995-12-31');
  eq('alignBirthdate after this year\'s birthday', alignBirthdate('2001-01-15', 30, NOW, 'UTC'), '1996-01-15');
  eq('alignBirthdate 29 Feb → 28 Feb', alignBirthdate('2000-02-29', 30, NOW, 'UTC'), '1996-02-28');

  section('persona-neutral src/life/');
  const p = getPersona();
  const properNouns = (s) => (String(s || '').match(/\b[A-Z][\p{L}]{3,}\b/gu) || []).filter(w => w !== 'English');
  const needles = [...new Set([p.name, ...p.aliases, ...properNouns(p.region), ...properNouns(p.language)]
    .map(x => String(x).trim()).filter(x => x.length >= 3))];
  check('persona gives something to look for', needles.length > 0, needles);
  const lifeDir = path.join(PROJECT_ROOT, 'src', 'life');
  const targets = [
    ...fs.readdirSync(lifeDir).filter(f => f.endsWith('.js')).map(f => path.join(lifeDir, f)),
    EXAMPLE_PATH,
  ];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const n of needles) {
      if (new RegExp(`(^|[^\\p{L}])${esc(n)}($|[^\\p{L}])`, 'iu').test(text)) hits.push(`${path.relative(PROJECT_ROOT, file)}: ${n}`);
    }
  }
  check(`no persona name/alias/region/language in ${targets.length} files`, hits.length === 0, hits);

  if (LIVE) {
    section('live seed (--live)');
    const lp = tmpPath('live');
    const live = await ensureWorldSeed({ path: lp });
    console.log(`  source=${live.source} places=${live.places.length} cast=${live.cast.length} tz=${live.timezone}`);
    check('live seed produced a world.json', live.source === 'world.json' && fs.existsSync(lp));
    if (live.source === 'world.json') {
      eq('live birthdate matches persona age', ageAt(live.self.birthdate, Math.floor(Date.now() / 1000), live.timezone), p.age);
    }
  }
} finally {
  removeTmp();
}

report();
