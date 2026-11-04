// Public site (spec 013): the exporter's filter, scrubber, schema, opt-in, journal,
// votes, inert switch and import guards — offline. Example world, fake clock, mocked
// Jev, scratch DB under data/; R2 / the votes Worker are stubbed (fetch is blocked).
//
//   1. guards     src/public imports only the life facade (no mind/story/influence/brain),
//                 no SQL on 006 memory or story/influence tables; publicView.js is imported
//                 only by the life facade and imports only clock.js
//   2. scrubber   JIDs, @digits, phone runs, URLs, emails, real full names, capitalized real
//                 first names, group subjects → refused; persona/cast/opted-in names pass;
//                 dates and clock times are not phone numbers
//   3. schema     closed keys, caps, grid coordinates, size; offline doc
//   4. filter     chat-origin outings → "Out with a friend" (no kind, venue, chat, inviter);
//                 chat pointers absent; heavy events and their consequences absent; reverted
//                 events absent; home has no name or pin; no coordinate off the 0.01° grid;
//                 a planted real name in cast status / place name is dropped
//   5. canary     no real name, JID, phone, group name or message text anywhere in the JSON
//  15. the feed   plan 020's live, thoughts, dreams, mind: the filter, a canary over the four, what says less, malformed output
//   6. opt-in     display name shown → opt-out → "a friend" next export; purge deletes the row
//   7. export     uploads once per change; invalid / names unavailable → nothing uploaded;
//                 DRY_RUN → local file only; takedown uploads the offline doc
//   8. votes      only exported ids/options are kept; tallies never change a decision
//   9. inert      skill off → the timer does nothing (no file, no upload)
//  10. journal    publish refuses a real name; unpublish removes it from the next export
//  12. scenes     016 export contract: fictional cast only (a real person / unknown cast → none),
//                 heavy (flag or near an onset) → none, home / former home / unknown place → none,
//                 area only for a real venue ≥ 2 km from every home and outside a home cell,
//                 every venue name → its kind word, home names / region strings / real names drop
//                 the scene, caps (9 paras, 2400 chars, 5 topics × 40, 160), impressions only for a
//                 first meeting, ending enum, sceneId on its day row, v stays 1 + scenesSchema 1,
//                 closed schema, scenePublic=false → no key; through exportNow too
import fs from 'fs';
import path from 'path';
import {
  setupScratchDb, bootLife, simulateDays, simulateHours, fakeJevFixed, section, check, eq, report, HOUR, DAY, PROJECT_ROOT,
} from './arcs-tests/_helpers.js';

Object.assign(process.env, {
  LLM_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GLM_API_KEY: '', OPENROUTER_API_KEY: '', JEV_API_KEY: '',
  R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', PUBLIC_VOTES_URL: '', PUBLIC_VOTES_READ_TOKEN: '',
});

const { db } = await setupScratchDb();
const { appendEvent, revertEvent } = await import('../src/life/eventLog.js');
const { makeScrubber } = await import('../src/public/scrub.js');
const { validate, validateOffline, offlineDoc, SCHEMA } = await import('../src/public/schema.js');
const { snap } = await import('../src/public/build.js');
const { sign, r2Config } = await import('../src/public/r2.js');
const { votesConfig } = await import('../src/public/votes.js');
const { buildPublicRaw, classify } = await import('../src/life/publicView.js');
const store = await import('../src/public/store.js');
const pub = await import('../src/public/index.js');
const { purgePerson } = await import('../src/memory/relationshipStore.js');

// ── 1. guards ───────────────────────────────────────────────────────────────
section('1. import guards');
{
  const SRC = path.join(PROJECT_ROOT, 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const specs = (code) => [...code.matchAll(/(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2]);
  const pubFiles = walk(path.join(SRC, 'public'));
  check('src/public has its modules', pubFiles.length >= 7, pubFiles.length);
  const bad = [];
  for (const f of pubFiles) {
    for (const s of specs(fs.readFileSync(f, 'utf8'))) {
      const abs = s.startsWith('.') ? path.resolve(path.dirname(f), s) : s;
      const rel = abs.startsWith(SRC) ? path.relative(SRC, abs) : abs;
      if (rel.startsWith('life/') && rel !== 'life/index.js') bad.push(`${path.basename(f)} -> ${rel}`);
      if (/^(mind|brain|calls|instagram|whatsapp|personality)\//.test(rel)) bad.push(`${path.basename(f)} -> ${rel}`);
      if (/^memory\//.test(rel) && !['memory/db.js', 'memory/identity.js', 'memory/relationshipStore.js'].includes(rel)) bad.push(`${path.basename(f)} -> ${rel}`);
    }
  }
  eq('src/public imports only the life facade, db/identity/purge hook from memory, no mind/brain/story', bad, []);
  const SQL = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?(memories|nicknames|relationships|person_facets|slang|messages|messages_fts|story_\w+|chat_influence_\w+|mind_\w+|world_events|life_claims|llm_usage)\b/i;
  eq('src/public names no memory / message / story / influence / mind / log / ledger table in SQL', pubFiles.filter((f) => SQL.test(fs.readFileSync(f, 'utf8'))).map((f) => path.basename(f)), []);
  const all = walk(SRC);
  const importers = all.filter((f) => specs(fs.readFileSync(f, 'utf8')).some((s) => s.startsWith('.') && path.resolve(path.dirname(f), s) === path.join(SRC, 'life', 'publicView.js')));
  eq('publicView.js is imported by the life facade only', importers.map((f) => path.relative(SRC, f)), ['life/index.js']);
  // 018: + the wallet's pure helpers (labels, money of an event), which import only clock.js themselves.
  eq('publicView.js imports only clock.js and wallet.js', specs(fs.readFileSync(path.join(SRC, 'life', 'publicView.js'), 'utf8')), ['./clock.js', './wallet.js']);
  eq('wallet.js imports only clock.js', specs(fs.readFileSync(path.join(SRC, 'life', 'wallet.js'), 'utf8')), ['./clock.js']);
  const promptBuilders = ['personality/systemPrompt.js', 'brain/contextBuilder.js', 'life/innerState.js'];
  eq('no prompt builder imports src/public', promptBuilders.filter((f) => specs(fs.readFileSync(path.join(SRC, f), 'utf8')).some((s) => /public\//.test(s))), []);
  const logLines = pubFiles.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/log\.(?:info|warn|error)\(\{([^}]*)\}/g)].map((m) => m[1]));
  check('exporter log lines carry codes/sizes only (no doc, text, name, json, secret)', logLines.length > 0 && !logLines.some((l) => /\b(doc|text|json|name|secret|token|body)\b\s*[,:]/.test(l) || /\b(doc|json|body)\b\s*}?$/.test(l.trim())), logLines);
}

// ── 2. scrubber ─────────────────────────────────────────────────────────────
section('2. scrubber');
{
  const s = makeScrubber({
    knownNames: ['Priya Raman', 'Rahul', 'Al', 'Joy', 'Asha Pillai'],
    groupNames: ['Weekend crew', 'Gym'],
    allowNames: ['Karyasthan', 'Tessa Quill', 'Pri'],
  });
  const refused = {
    'priya raman went home': 'real_name', 'Lunch with Rahul': 'real_name', 'call 5550100123 now': 'phone',
    '+1 555 010 0123': 'phone', 'ping 155500000111@s.whatsapp.net': 'jid', 'hey @12345': 'jid', 'see https://x.io/a': 'url',
    'visit example.com': 'url', 'mail a@b.co': 'email', 'back from Weekend Crew': 'group_name', 'Joy is here': 'real_name',
    'Asha Pillai joined': 'real_name', 'zero​width Pri​ya Raman': null,
  };
  for (const [text, why] of Object.entries(refused)) {
    if (why) eq(`refused: ${JSON.stringify(text)}`, s.check(text), why);
  }
  check('a format character can\'t split a real full name', s.check('Pri​ya Raman came') === 'real_name');
  for (const ok of ['Karyasthan had lunch', 'Tessa Quill signed up for pottery', 'Tessa is at work', 'Out with Pri', 'pure joy',
    'Meeting 15:00–16:00 on 2026-10-30', 'went to the gym', 'Slept 7.2 hours', 'Q4 release review', 'c_212059170d']) {
    eq(`passes: ${JSON.stringify(ok)}`, s.check(ok), ok === 'c_212059170d' ? 'phone' : null);
  }
  eq('clean() drops a refused string', s.clean('Lunch with Rahul'), null);
  const s2 = makeScrubber({ knownNames: ['രാഹുൽ', 'Sanju Wick', 'Rahul Varnell'], allowNames: ['Karyasthan', 'Tessa Quill'] });
  for (const [t, why] of [['Met രാഹുൽ today', 'real_name'], ['Sanjunte birthday', 'real_name'], ['R a h u l Varnell', 'real_name'],
    ['dinner with r a h u l', 'real_name'], ['call ９８００００２３４５', 'phone'], ['Sanjeev came by', null], ['Tessa signed up', null]]) {
    eq(`review bypass: ${JSON.stringify(t)}`, s2.check(t), why);
  }
  const { guardKeys } = await import('../src/public/scrub.js');
  const salt = 'z'.repeat(32);
  const gk = guardKeys(salt, ['Dia Fernandes', 'Arun']);
  const g = makeScrubber({ knownNames: [], allowNames: ['Karyasthan'], guard: { salt, full: new Set(gk.full), first: new Set(gk.first) } });
  check('guard: a purged full name is refused in any case', g.check('dinner with dia fernandes') === 'real_name');
  check('guard: a purged first name is refused as a proper noun only', g.check('Arun came over') === 'real_name' && g.check('arun') === null);
  check('guard keys are salted hashes', gk.full.every((k) => /^[0-9a-f]{24}$/.test(k)) && guardKeys('other'.repeat(8), ['Arun']).first[0] !== gk.first[0]);
  eq('clean() trims and caps', s.clean('  Tessa   is out  ', 9), 'Tessa is');
}
{
  // Every word of a real name (batch 3 review), capitalized and whole-word: "K Ann", "Dr. Maris" and the
  // surname in "Rahul Varnell" were let through; a word of an allowed (cast / persona) or place name is exempt.
  const t = makeScrubber({ knownNames: ['K Ann', 'Dr. Maris', 'Rahul Varnell', 'Sunny Holt'], allowNames: ['Karyasthan', 'Maris Thorne'], placeNames: ['Varnell Stores'] });
  const t0 = makeScrubber({ knownNames: ['K Ann', 'Dr. Maris', 'Rahul Varnell'], allowNames: ['Karyasthan'] });
  for (const [text, why] of [['Ann said hi', 'real_name_token'], ['lunch with Ann today', 'real_name_token'], ['Holt came by', 'real_name_token'], ['Sunny came by', 'real_name'],
    ['Maris called', null], ['Varnell came by', null], ['ann', null], ['Annual review', null], ['a sunny afternoon', null], ['Rahul came', 'real_name']]) {
    eq(`tokens: ${JSON.stringify(text)}`, t.check(text), why);
  }
  eq('without the exemptions: "Maris" and "Varnell" are a real name\'s words', [t0.check('Maris called'), t0.check('Varnell came by')], ['real_name_token', 'real_name_token']);
  eq('clean() drops a string holding one', t.clean('lunch with Ann today'), null);
}

// ── 3. schema ───────────────────────────────────────────────────────────────
section('3. schema');
{
  const s = makeScrubber({});
  check('snap() lands on a 0.01° cell centre', snap(0.9352) === 0.935 && snap(0.6245) === 0.625 && snap(-0.001) === -0.005);
  const off = offlineDoc(1793348230);
  check('the offline doc validates', validateOffline(off).ok);
  check('the offline doc refuses extra keys', !validateOffline({ ...off, now: {} }).ok);
  check('validate() without a scrubber fails closed', !validate({}, null).ok);
  // 15 keys of 013 + 016's optional scenes / scenesSchema + 018's optional wallet / walletSchema + 019's phone / phoneSchema + 020's live, thoughts, dreams, mind, standing and their schemas.
  check('the schema is closed (an object spec lists its keys)', SCHEMA.t === 'obj' && Object.keys(SCHEMA.shape).length === 31
    && ['live', 'liveSchema', 'thoughts', 'thoughtsSchema', 'dreams', 'dreamsSchema', 'mind', 'mindSchema', 'standing', 'standingSchema'].every((k) => SCHEMA.shape[k]?.optional === true)
    && SCHEMA.shape.scenes.optional === true && SCHEMA.shape.scenesSchema.optional === true && SCHEMA.shape.v.v === 1
    && SCHEMA.shape.wallet.optional === true && SCHEMA.shape.walletSchema.optional === true
    && SCHEMA.shape.phone.optional === true && SCHEMA.shape.phoneSchema.optional === true);
  globalThis.__schemaScrubber = s;
}

// ── fixtures: a world with chat, heavy, revert and real-name traps ─────────
const G = '120363000000000013@g.us';
const P1 = '10000000000101@lid';
const P2 = '10000000000102@lid';
const P1_PN = '155500000101@s.whatsapp.net';
db.prepare("INSERT INTO groups (jid, name, joined_at, last_active) VALUES (?, 'Weekend crew', unixepoch(), unixepoch())").run(G);
db.prepare("INSERT INTO people (jid, phone, push_name, real_name) VALUES (?, '155500000101', 'Priya', 'Priya Raman')").run(P1);
db.prepare("INSERT INTO people (jid, phone, push_name) VALUES (?, '155500000102', 'Rahul')").run(P2);
db.prepare("INSERT INTO person_identities (jid, person_jid, source) VALUES (?, ?, 'test')").run(P1_PN, P1);
db.prepare("INSERT INTO messages (id, group_jid, sender_jid, content, is_from_self, timestamp) VALUES ('m-1', ?, ?, 'secret words about the cinema', 0, unixepoch())").run(G, P1);

const booted = await bootLife({ jev: fakeJevFixed({ go: 0.6, late: 0.1, stay: 0.3 }) });
const { life, clock, world } = booted;
await simulateDays(2);
await simulateHours(8);
await life.stopLife();
let ids = {};
{
  const { rebuild } = await import('../src/life/projector.js');
  const state = rebuild({ world });
  const home = state.self.homePlaceId;
  const places = [...state.places.values()];
  const venue = places.find((p) => p.id !== home && p.kind !== 'office') ?? places.find((p) => p.id !== home);
  const cast = [...state.cast.values()];
  const t = clock.now();
  // A chat pointer (actor chat) and a chat-origin outing with the inviter as subject.
  const ptr = appendEvent({ type: 'chat.trigger', actor: 'chat', at: t - 3 * HOUR, originKind: 'group', originJid: G, payload: { decisionId: null, toward: null } });
  const outing = appendEvent({ type: 'activity.started', actor: 'engine', at: t - 3 * HOUR + 60, causeId: ptr.id, subjectJid: P1,
    payload: { kind: 'movie', placeId: venue.id, end: t - HOUR, availability: 'busy', withCast: [], social: true } });
  appendEvent({ type: 'activity.ended', actor: 'engine', at: t - HOUR, causeId: outing.id, payload: { kind: 'movie', placeId: venue.id } });
  // Heavy: a heavy onset and a consequence caused by it.
  let heavyOk = true;
  try {
    const hv = appendEvent({ type: 'heavy.started', actor: 'engine', at: t - 50 * 60, heavy: true, payload: { kind: 'loss', castIds: [cast[0].id], themeId: 'x' } });
    appendEvent({ type: 'cast.beat', actor: 'engine', at: t - 49 * 60, causeId: hv.id, payload: { castId: cast[0].id, kind: 'news', text: 'HEAVYBEAT something terrible happened' } });
    ids.heavy = hv.id;
    // A romance arc that started before, ended BY the heavy onset (a breakup).
    const arc = appendEvent({ type: 'arc.started', actor: 'engine', at: t - 3 * DAY, payload: { category: 'romance', kind: 'crush', stage: 'interested', castIds: [cast[3].id] } });
    appendEvent({ type: 'arc.ended', actor: 'engine', at: t - 49 * 60 + 30, causeId: hv.id, payload: { arcId: arc.id, outcome: 'broken_up' } });
    ids.romanceArc = arc.id;
    appendEvent({ type: 'relationship.changed', actor: 'engine', at: t - 49 * 60 + 40, causeId: hv.id, payload: { castId: cast[0].id, delta: { tension: 0.3 }, reason: 'drift' } });
    ids.heavyCast = cast[0].id;
  } catch (err) { heavyOk = false; console.log('  (heavy fixture skipped:', err.message, ')'); }
  check('heavy fixture appended', heavyOk);
  // 018 wallet: a chat outing's spend (folded), a heavy setback (dropped), an owner income with
  // its own label (never public), a self spend at home (no place) and one at a venue.
  appendEvent({ type: 'money.spent', actor: 'engine', at: t - 2 * HOUR, causeId: outing.id, subjectJid: P1, payload: { amount: 350, for: 'outing', kind: 'movie', placeId: venue.id } });
  if (ids.heavy) appendEvent({ type: 'money.spent', actor: 'engine', at: t - 48 * 60, causeId: ids.heavy, payload: { amount: 4321, for: 'setback' } });
  appendEvent({ type: 'money.adjusted', actor: 'owner', at: t - 47 * 60, payload: { mode: 'income', amount: 2500, label: 'OWNERLABEL broke his FD' } });
  appendEvent({ type: 'money.spent', actor: 'engine', at: t - 46 * 60, payload: { amount: 260, for: 'outing', kind: 'hangout', placeId: home } });
  appendEvent({ type: 'money.spent', actor: 'engine', at: t - 45 * 60, payload: { amount: 480, for: 'outing', kind: 'cafe', placeId: venue.id, castIds: [cast[1].id] } });
  // A sick block now (P6: shown as rest, never as sickness).
  appendEvent({ type: 'activity.started', actor: 'engine', at: t - 5 * 60, payload: { kind: 'sick', placeId: home, end: t + 3 * HOUR, availability: 'busy', withCast: [], social: false } });
  // A self beat that gets reverted; a self beat that stays; a planted real name in a status and a place.
  const gone = appendEvent({ type: 'cast.beat', actor: 'mind', at: t - 40 * 60, payload: { castId: cast[1].id, kind: 'hobby', text: 'REVERTEDBEAT took up chess' } });
  revertEvent(gone.id, { reason: 'test', by: 'owner' });
  appendEvent({ type: 'cast.beat', actor: 'mind', at: t - 30 * 60, payload: { castId: cast[1].id, kind: 'hobby', text: 'KEPTBEAT took up the guitar' } });
  appendEvent({ type: 'cast.updated', actor: 'mind', at: t - 20 * 60, payload: { castId: cast[2].id, fields: { status: 'dating Priya Raman lately' }, reason: 'status_rotate' } });
  appendEvent({ type: 'place.created', actor: 'mind', at: t - 10 * 60, payload: { id: 'place:rahuls-den', name: 'Rahul flat party', kind: 'bar', lat: 0.91234, lon: 0.61234 } });
  ids = { ...ids, ptr: ptr.id, outing: outing.id, venueName: venue.name, homeName: places.find((p) => p.id === home)?.name, home: places.find((p) => p.id === home) };
}
await bootLife({ jev: fakeJevFixed({ go: 0.6, late: 0.1, stay: 0.3 }), clock });

// ── 4. filter ───────────────────────────────────────────────────────────────
section('4. the filter (life side + public side)');
const outDir = path.join(PROJECT_ROOT, 'data', `public-test-${process.pid}`);
const puts = [];
let putOk = true;
pub.__setDepsForTest({
  enabled: () => true,
  dryRun: () => false,
  outDir: () => outDir,
  put: async (key, body) => { puts.push({ key, body }); return putOk ? { ok: true, status: 200 } : { ok: false, reason: 'http', status: 500 }; },
  now: () => clock.now(),
  soonMs: null,
});
Object.assign(process.env, { R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, R2_BUCKET: 'karyasthan-public', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' });
let res = await pub.exportNow();
eq('first export ok', res.status, 'ok');
check('uploaded once', puts.length === 1 && puts[0].key === 'public.json', puts.length);
const doc = JSON.parse(puts[0]?.body || '{}');
const json = puts[0]?.body || '';
{
  const rows = [...doc.today.rows, ...doc.days.flatMap((d) => d.rows)];
  const outRows = rows.filter((r) => r.kind === 'out');
  check('the chat-origin outing is one "out" row', outRows.length === 1, outRows);
  eq('…labelled "Out with a friend", no place, with [friend]', outRows[0] && { label: outRows[0].label, placeId: outRows[0].placeId, with: outRows[0].with },
    { label: 'Out with a friend', placeId: null, with: ['friend'] });
  check('no row carries the outing\'s kind (movie)', !rows.some((r) => r.kind === 'movie'));
  check('the outing\'s venue is not named in any row', !rows.some((r) => r.label.includes(ids.venueName)));
  check('"now" never takes its place from the map position (a chat outing\'s venue)', doc.now.where.name !== ids.venueName
    && !JSON.stringify(doc.now).includes(ids.venueName));
  check('heavy onset and its consequence are absent', !json.includes('HEAVYBEAT'));
  check('a reverted beat is absent; a kept one present', !json.includes('REVERTEDBEAT') && json.includes('KEPTBEAT'));
  check('a cast status naming a real person is dropped', !json.includes('Priya'));
  check('a place named after a real person is dropped', !json.includes('Rahul flat party') && !json.includes('Rahul'));
  check('home has no name and no pin', !!ids.homeName && !json.includes(`"${ids.homeName}"`) && !doc.city.places.some((p) => p.name === ids.homeName)
    && !doc.city.places.some((p) => p.lat === ids.home.lat && p.lon === ids.home.lon)
    && !rows.some((r) => r.placeId && !doc.city.places.some((p) => p.id === r.placeId)));
  const coords = doc.city.places.flatMap((p) => [p.lat, p.lon]).filter((v) => v !== null);
  check('every coordinate is a 0.01° cell centre', coords.length > 0 && coords.every((v) => Math.abs(((v - 0.005) / 0.01) - Math.round((v - 0.005) / 0.01)) < 1e-6), coords.slice(0, 6));
  check('ids are salted hashes (no place:/cast: ids)', !/\b(place|cast):[a-z]/.test(json));
  const vv = doc.now.vitals;
  check('all vitals exported: body 0–100, mood −100…100, arousal, sleep debt in hours, money; never sickness', vv
    && ['energy', 'stress', 'hunger', 'social', 'workPressure', 'arousal'].every((k) => vv[k] === null || (Number.isInteger(vv[k]) && vv[k] >= 0 && vv[k] <= 100))
    && (vv.sleepDebtHours === null || (vv.sleepDebtHours >= 0 && vv.sleepDebtHours <= 20))
    && Number.isInteger(vv.mood) && vv.mood >= -100 && vv.mood <= 100 && Number.isInteger(vv.money)
    && Object.keys(vv).length === 9 && !/sick/i.test(JSON.stringify(doc.now)), vv);
  check('fiction label present', typeof doc.fiction === 'string' && /fictional AI character/.test(doc.fiction));
  // classify(): the life-side verdicts, directly.
  const okCtx = { isOut: () => false, heavyIn: () => false };
  eq('classify: self activity → ok', classify({ id: 1, type: 'activity.started', originKind: 'self' }, okCtx), 'ok');
  eq('classify: group activity → out', classify({ id: 2, type: 'activity.started', originKind: 'group' }, okCtx), 'out');
  eq('classify: self activity with a subject → out', classify({ id: 3, type: 'activity.started', originKind: 'self', subjectJid: P1 }, okCtx), 'out');
  eq('classify: group beat → drop', classify({ id: 4, type: 'cast.beat', originKind: 'group' }, okCtx), 'drop');
  eq('classify: redacted → drop', classify({ id: 5, type: 'activity.started', originKind: 'self', redacted: true }, okCtx), 'drop');
  eq('classify: heavy-caused → drop', classify({ id: 6, type: 'activity.started', originKind: 'self' }, { isOut: () => false, heavyIn: () => true }), 'drop');
  eq('classify: excluded → drop', classify({ id: 7, type: 'activity.started', originKind: 'owner' }, { isOut: () => true, heavyIn: () => false }), 'drop');
  eq('classify: owner sleep → ok', classify({ id: 8, type: 'sleep.started', originKind: 'owner' }, okCtx), 'ok');
  eq('classify: chat sleep → drop (never "out")', classify({ id: 9, type: 'sleep.started', originKind: 'dm' }, okCtx), 'drop');
}

// ── 5. canary ───────────────────────────────────────────────────────────────
section('5. canary: nothing private anywhere in the JSON');
{
  const forbidden = ['Priya', 'Raman', 'Rahul', 'Weekend crew', 'secret words', '@lid', '@g.us', '@s.whatsapp.net', '155500000101',
    '155500000102', '10000000000101', G.split('@')[0], 'chat.trigger', 'HEAVYBEAT', 'REVERTEDBEAT', 'movie', 'OWNERLABEL', '4321'];
  // A numeric token counts on its own only: the salted ids (random per scratch DB) are hex and may hold the digits.
  const hasToken = (body, f) => (/^\d+$/.test(f) ? new RegExp(`(?<![0-9a-f])${f}(?![0-9a-f])`).test(body) : body.includes(f));
  eq('no forbidden token in public.json', forbidden.filter((f) => hasToken(json, f)), []);
  // 018: wallet money fields are amounts, not phone-like runs (a balance can reach 7 digits).
  const MONEY_KEYS = ['balance', 'amount', 'monthIn', 'monthOut', 'in', 'out', 'outWithFriends', 'money'];
  check('no digits run of 7+ outside ids/times/amounts', !/(?<![\w.])\d{7,}(?![\d.])/.test(JSON.stringify(doc, (k, v) => (['at', 'end', 'since', 'until', 'generatedAt', 'from', 'to', 'closesAt', 'startedAt', 'endedAt', 'publishedAt', ...MONEY_KEYS].includes(k) || k in (doc.wallet?.byCategory ?? {}) ? 0 : v))));
}

// ── 5b. review fixes: heavy consequences, sick, second home, mood ─────────
section('5b. heavy consequences, sickness, every home');
{
  const lifeMod = await import('../src/life/index.js');
  const st = lifeMod.getState();
  const tensionNow = st.cast.get(ids.heavyCast)?.metrics?.tension;
  const castOut = doc.people.cast.find((c) => c.name && st.cast.get(ids.heavyCast)?.name?.startsWith(c.name.split(' ')[0]));
  check('a romance chapter ended by a heavy breakup is not shown', !doc.story.chapters.some((c) => c.kind === 'crush' || /romance/i.test(c.title)), doc.story.chapters.map((c) => c.title));
  check('a heavy-caused relationship change is not in the public numbers', castOut && Number.isFinite(tensionNow) && Math.abs(castOut.tension - Math.max(0, Math.round((tensionNow - 0.3) * 100) / 100)) < 0.011, { pub: castOut?.tension, state: tensionNow });
  check('a sick block shows as rest', doc.today.rows.some((r) => r.kind === 'rest') && !json.includes('"sick"') && !/\bsick\b/i.test(json), doc.today.rows.map((r) => r.kind));
  // Places in home's own 0.01° cell are listed but never pinned (the pins would point at it).
  const home = ids.home;
  const cellOf = (v) => Math.floor(v / 0.01);
  check('no pin in home\'s cell', !doc.city.places.some((p) => p.lat !== null && cellOf(p.lat) === cellOf(home.lat) && cellOf(p.lon) === cellOf(home.lon)));
  check('no home-like place at all (his home, the family home)', !doc.city.places.some((p) => /home/i.test(p.name) || p.kind === 'home'), doc.city.places.map((p) => p.name));
  check('the hard stretch is one fixed line', doc.story.hardStretchLine === null || doc.story.hardStretchLine === 'Going through a hard stretch.');
}

// ── 5c. 015 §1.8: every home — former (a god move), pending, kind home — is private ──
section('5c. every home he has, had or is moving to is private (015 god move)');
{
  const { buildPublicRaw, homeIdsOf } = await import('../src/life/publicView.js');
  const lifeMod = await import('../src/life/index.js');
  const st = lifeMod.getState();
  const places = new Map(st.places);
  places.set('place:old-flat', { id: 'place:old-flat', name: 'Riverside Flat', kind: 'apartment', lat: 0.31, lon: 0.31 });
  places.set('place:next-flat', { id: 'place:next-flat', name: 'Hilltop Flat', kind: 'apartment', lat: 0.42, lon: 0.42 });
  const moved = {
    ...st, places,
    self: { ...st.self, homeHistory: ['place:old-flat'] },
    story: { ...(st.story ?? {}), pending: { 9001: { type: 'self.moved', due: { at: clock.now() + 86400 }, payload: { homePlaceId: 'place:next-flat' } } } },
  };
  const ids5 = homeIdsOf(moved);
  check('homeIdsOf: current, former and pending homes', ids5.has(st.self.homePlaceId) && ids5.has('place:old-flat') && ids5.has('place:next-flat'));
  const raw = buildPublicRaw({ state: moved, world, at: clock.now(), tz: world.timezone ?? 'UTC', events: () => [], getEvent: () => null, isOut: () => false });
  const byId = new Map(raw.places.map((p) => [p.id, p]));
  check('a former home (no "home" in its name) is marked home in publicRaw', byId.get('place:old-flat')?.home === true);
  check('a pending move\'s new home is marked home too', byId.get('place:next-flat')?.home === true);
  check('…and a venue is not', raw.places.some((p) => p.home === false));
  // A place in a former / pending home's own 0.01° cell is listed but never pinned
  // (the pin would point at that home), like one in the current home's cell.
  places.set('place:corner', { id: 'place:corner', name: 'Corner Bakery', kind: 'cafe', lat: 0.3123, lon: 0.3134 });
  places.set('place:far', { id: 'place:far', name: 'Far Bakery', kind: 'cafe', lat: 0.3523, lon: 0.3534 });
  const rawC = buildPublicRaw({ state: { ...moved, places }, world, at: clock.now(), tz: world.timezone ?? 'UTC', events: () => [], getEvent: () => null, isOut: () => false });
  const { build } = await import('../src/public/build.js');
  const docC = build({ raw: rawC, scrubber: makeScrubber({ knownNames: [], groupNames: [], allowNames: [] }), salt: 'test-salt' });
  const pinOf = (name) => docC.city.places.find((p) => p.name === name);
  check('a place in a former home\'s cell is listed without a pin', pinOf('Corner Bakery') && pinOf('Corner Bakery').lat === null && pinOf('Corner Bakery').lon === null, JSON.stringify(pinOf('Corner Bakery')));
  check('…one in no home\'s cell keeps its pin', Number.isFinite(pinOf('Far Bakery')?.lat));
  const fired = buildPublicRaw({ state: st, world: { ...world, self: { ...world.self, job: null, employed: false } }, at: clock.now(), tz: world.timezone ?? 'UTC', events: () => [], getEvent: () => null, isOut: () => false });
  eq('self.job comes from the world it is given (the facade passes the overlay: a fired character has none)', fired.self.job, null);
}

// ── 6. opt-in ───────────────────────────────────────────────────────────────
section('6. opt-in per person');
{
  const row = pub.setOptIn(P1_PN, { optedIn: true, displayName: 'Pri' });
  check('opt-in keyed on the canonical person, random public id', row.personJid === P1 && /^f_[0-9a-f]{12}$/.test(row.publicId) && !row.publicId.includes('101'), row);
  res = await pub.exportNow();
  const d2 = JSON.parse(puts.at(-1).body);
  const out = [...d2.today.rows, ...d2.days.flatMap((d) => d.rows)].find((r) => r.kind === 'out');
  eq('opted in → "Out with Pri", with her public id', out && { label: out.label, with: out.with }, { label: 'Out with Pri', with: [row.publicId] });
  check('…and listed as a friend', d2.people.friends.some((f) => f.id === row.publicId && f.name === 'Pri'));
  check('…still no real name', !puts.at(-1).body.includes('Priya'));
  pub.setOptIn(P1, { optedIn: false });
  res = await pub.exportNow();
  const d3 = JSON.parse(puts.at(-1).body);
  const out3 = [...d3.today.rows, ...d3.days.flatMap((d) => d.rows)].find((r) => r.kind === 'out');
  eq('opted out → "a friend" at the next export', out3?.label, 'Out with a friend');
  check('…and gone from friends', !d3.people.friends.length && !puts.at(-1).body.includes('"Pri"'));
  check('a display name with digits/symbols is cleaned', store.cleanDisplayName('Pri 123 <b>') === 'Pri b');
  check('an unknown person is refused', (() => { try { pub.setOptIn('19999999999@s.whatsapp.net', { optedIn: true }); return false; } catch (e) { return e.code === 'unknown_person'; } })());
  pub.startPublic({ setIntervalFn: () => ({ unref() {} }) });   // boot: registers the purge hook
  pub.setOptIn(P2, { optedIn: true, displayName: 'Rahul' });
  purgePerson(P2, 'test', 'owner');
  check('purgePerson deletes the opt-in row (006 hook)', !store.getPerson(P2));
}

// ── 7. export behaviour ─────────────────────────────────────────────────────
section('7. export: change detection, failures, DRY_RUN, takedown');
{
  const before = puts.length;
  res = await pub.exportNow();
  check('a purged person\'s name stays refused (salted name guard)', !puts.at(-1).body.includes('Rahul'));
  check('the guard stores keys, never names', !JSON.stringify(store.getState('nameGuard')).includes('ahul'));
  check('unchanged content → no new upload', res.status === 'unchanged' && puts.length === before, res);
  check('the local file is written (0600)', fs.existsSync(path.join(outDir, 'public.json')) && (fs.statSync(path.join(outDir, 'public.json')).mode & 0o777) === 0o600);
  pub.__setDepsForTest({ knownNames: () => { throw new Error('db'); } });
  clock.advance?.(10 * 60);
  res = await pub.exportNow();
  check('names unavailable → nothing built or uploaded', res.status === 'names_unavailable' && puts.length === before, res);
  pub.__setDepsForTest({ knownNames: () => store.knownPeopleNames() });
  // The event log outgrew publicRaw's read guard → a clear status, not 'life_off', and no upload.
  const life1 = (await import('../src/life/index.js')).publicRaw;
  pub.__setDepsForTest({ publicRaw: () => { const e = new Error('life: event read over 2000 pages'); e.code = 'history_too_large'; throw e; } });
  res = await pub.exportNow();
  const stTooLarge = pub.status();
  check('history too large → status history_too_large (not life_off), nothing uploaded',
    res.status === 'history_too_large' && stTooLarge.last.status === 'history_too_large' && stTooLarge.lastIssue?.code === 'history_too_large' && puts.length === before, { res, last: stTooLarge.last, issue: stTooLarge.lastIssue });
  eq('…a journal publish says so too', pub.publishJournal('2026-10-01', 'a quiet day').reason, 'history_too_large');
  pub.__setDepsForTest({ publicRaw: () => null });
  eq('life not running is still life_off', (await pub.exportNow()).status, 'life_off');
  pub.__setDepsForTest({ publicRaw: (o) => life1(o) });
  // A build that fails the schema (a planted unknown key) → no upload.
  const life0 = (await import('../src/life/index.js')).publicRaw;
  pub.__setDepsForTest({ publicRaw: (o) => { const r = life0(o); r.places.push({ id: 'place:x', name: 'Bad\u0007Place', kind: 'cafe', lat: 1, lon: 1 }); return r; } });
  res = await pub.exportNow();
  check('a control character is dropped by the builder, the export stays valid', res.status === 'ok' || res.status === 'unchanged', res);
  pub.__setDepsForTest({ publicRaw: (o) => life0(o) });
  pub.__setDepsForTest({ dryRun: () => true });
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  res = await pub.exportNow();
  check('DRY_RUN → built, local file, no upload', res.status === 'ok' && res.uploaded === false && puts.length === before);
  pub.__setDepsForTest({ dryRun: () => false });
  putOk = false;
  res = await pub.exportNow();   // Pri's opt-in (built under DRY_RUN) is new content for R2
  check('an upload failure is reported, nothing thrown', res.uploaded === false && pub.status().last.uploadStatus.startsWith('http'));
  putOk = true;
  clock.advance?.(60);
  res = await pub.exportNow();
  check('a failed upload of changed content is retried at the next tick (not the 30-min heartbeat)', res.uploaded === true && puts.at(-1).body.includes('"Pri"'), res);
  pub.setOptIn(P1, { optedIn: false });
  res = await pub.exportNow();
  check('…and content back to what is live is uploaded again too', res.uploaded === true && !puts.at(-1).body.includes('"Pri"'), res);
  const n = puts.length;
  const td = await pub.takedown();
  const last = JSON.parse(puts.at(-1).body);
  check('takedown uploads the offline document', td.ok && puts.length === n + 1 && last.offline === true && Object.keys(last).length === 4);
  process.env.R2_SECRET_ACCESS_KEY = 'SECRETVALUE123';
  process.env.R2_ACCESS_KEY_ID = 'KEYIDVALUE456';
  const stj = JSON.stringify(pub.status());
  check('status() exposes no credential', !stj.includes('SECRETVALUE123') && !stj.includes('KEYIDVALUE456') && !/R2_SECRET/i.test(stj), stj);
  eq('r2Config refuses a non-R2 endpoint', r2Config({ R2_ENDPOINT: 'https://evil.example.com', R2_BUCKET: 'b-1', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }).reason, 'bad_endpoint');
  eq('r2Config refuses http', r2Config({ R2_ENDPOINT: `http://${'a'.repeat(32)}.r2.cloudflarestorage.com`, R2_BUCKET: 'b-1', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }).reason, 'bad_endpoint');
  const h = sign({ method: 'PUT', host: 'h', path: '/b/public.json', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', keyId: 'AK', secret: 'S1', amzDate: '20261030T000000Z' });
  const h2 = sign({ method: 'PUT', host: 'h', path: '/b/public.json', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', keyId: 'AK', secret: 'S2', amzDate: '20261030T000000Z' });
  check('SigV4: scope + signed headers, signature depends on the secret, secret never in headers',
    /^AWS4-HMAC-SHA256 Credential=AK\/20261030\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(h.authorization)
    && h.authorization !== h2.authorization && !JSON.stringify(h).includes('S1'));
}

// ── 8. votes ────────────────────────────────────────────────────────────────
section('8. votes: suggestions only');
{
  eq('votesConfig refuses http / short token', [votesConfig({ PUBLIC_VOTES_URL: 'http://x.workers.dev', PUBLIC_VOTES_READ_TOKEN: 'x'.repeat(30) }).reason,
    votesConfig({ PUBLIC_VOTES_URL: 'https://x.workers.dev', PUBLIC_VOTES_READ_TOKEN: 'short' }).reason], ['bad_url', 'no_token']);
  // Open an Ask-me decision so a vote is exported.
  const lifeMod = await import('../src/life/index.js');
  const st = lifeMod.getState();
  const decisions = [...(st?.decisions?.values?.() || [])];
  const raw = lifeMod.publicRaw();
  check('raw votes only from open cards (none open in this fixture is fine)', Array.isArray(raw.votes));
  // Feed a fake exported id map through the puller: only known ids/options are stored.
  Object.assign(process.env, { PUBLIC_VOTES_URL: 'https://votes.example.workers.dev', PUBLIC_VOTES_READ_TOKEN: 't'.repeat(32) });
  const { publicDecisionId } = await import('../src/public/build.js');
  const fakeRaw = (o) => { const r = lifeMod.publicRaw(o); r.votes = [{ decisionId: 4242, kind: 'outing', category: 'social', question: 'Should he go to the gig?', eventAt: clock.now() + DAY, decideBy: clock.now() + 12 * HOUR, placeId: null, castIds: [], options: [{ id: 'go', label: 'Go' }, { id: 'stay', label: 'Stay in' }] }]; return r; };
  const pid = publicDecisionId(store.salt(), 4242);
  pub.__setDepsForTest({ publicRaw: fakeRaw, pull: async () => ({ ok: true, tallies: { [pid]: { go: 7, stay: 3, hack: 99 }, d_ffffffffff: { go: 1 } } }) });
  clock.advance?.(10 * 60);
  res = await pub.exportNow();
  const dv = JSON.parse(puts.at(-1).body);
  check('the vote is exported with a salted id and code options', dv.votes.length === 1 && dv.votes[0].id === pid && dv.votes[0].options.length === 2);
  const v = pub.votesFor(4242);
  check('only exported options are stored (go 7, stay 3; "hack" and the unknown id dropped)', v.total === 10 && v.options.length === 2 && v.options[0].optionId === 'go', v);
  const after = [...(lifeMod.getState()?.decisions?.values?.() || [])];
  check('tallies change no decision', JSON.stringify(after.map((d) => [d.id, d.status, d.committed?.optionId ?? null])) === JSON.stringify(decisions.map((d) => [d.id, d.status, d.committed?.optionId ?? null])));
  // Every option refused (ids failing the code-id rule) → that vote is skipped, the export still builds.
  pub.__setDepsForTest({ publicRaw: (o) => { const r = fakeRaw(o); r.votes[0].options = [{ id: 'GO!', label: 'Go' }, { id: '??', label: 'Stay in' }]; return r; } });
  clock.advance?.(10 * 60);
  res = await pub.exportNow();
  check('a vote whose options are all refused is dropped, not a build failure', (res.status === 'ok' || res.status === 'unchanged') && JSON.parse(puts.at(-1).body).votes.length === 0, res);
  pub.__setDepsForTest({ publicRaw: (o) => lifeMod.publicRaw(o) });
  const cardsSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'life', 'publicView.js'), 'utf8');
  check('votes skip invitations, adopted and heavy decisions', /d\.invite \|\| d\.adopted \|\| d\.category === 'heavy'/.test(cardsSrc));
}

// ── 9. inert ────────────────────────────────────────────────────────────────
section('9. inert while the skill is off');
{
  store.setState('mustRefresh', null);   // section 6's opt-out request (its own path is tested in 11)
  pub.__resetForTest();
  let tickFn = null;
  pub.__setDepsForTest({ enabled: () => false });
  pub.startPublic({ setIntervalFn: (fn) => { tickFn = fn; return { unref() {} }; } });
  const n = puts.length;
  fs.rmSync(outDir, { recursive: true, force: true });
  tickFn?.();
  await new Promise((r) => setTimeout(r, 50));
  check('a timer tick with the skill off exports nothing (no upload, no file)', typeof tickFn === 'function' && puts.length === n && !fs.existsSync(outDir));
  check('the skill ships off (PUBLIC_SITE_ENABLED defaults to false in code)', /\['publicSite\.enabled', 'PUBLIC_SITE_ENABLED', 'bool', false,/.test(fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'utils', 'config.js'), 'utf8')));
  pub.stopPublic();
  pub.__setDepsForTest({ enabled: () => true });
}

// ── 10. journal ─────────────────────────────────────────────────────────────
section('10. journal publish');
{
  eq('publish refuses a night during/near a hard stretch', pub.publishJournal('2026-10-29', 'A slow day.').reason, 'hard_stretch');
  const lifeJ = (await import('../src/life/index.js')).publicRaw;
  pub.__setDepsForTest({ publicRaw: (o) => { const r = lifeJ(o); return { ...r, heavyAt: [], now: { ...r.now, hardStretch: false } }; } });
  eq('publish refuses a real name', pub.publishJournal('2026-10-29', 'Had dinner with Priya Raman.').reason, 'real_name');
  eq('publish refuses a bad night', pub.publishJournal('yesterday', 'x').reason, 'bad_night');
  check('publish accepts a clean self part', pub.publishJournal('2026-10-29', 'A slow day. Walked to the cafe and read.').ok);
  clock.advance?.(10 * 60);
  res = await pub.exportNow();
  const dj = JSON.parse(puts.at(-1).body);
  check('the published night is on the site', dj.journal.length === 1 && dj.journal[0].night === '2026-10-29');
  pub.unpublishJournal('2026-10-29');
  res = await pub.exportNow();
  check('unpublish removes it at the next export', JSON.parse(puts.at(-1).body).journal.length === 0);
  // 014 §8: a real venue's name never reaches published prose — its kind word does, at
  // publish and again at every export (a night stored before the venue was added).
  const lifeV = await import('../src/life/index.js');
  const P0 = [...lifeV.getState().places.values()].find((p) => p.kind !== 'home');
  lifeV.appendOwnerBatch([{ type: 'place.created', actor: 'owner', at: clock.now(), payload: {
    id: 'place:v0a1b2c3d', name: 'Blue Lagoon Cafe', kind: 'cafe', lat: P0.lat + 0.004, lon: P0.lon + 0.004, venue: { src: 'osm', ref: 'node/9', area: 'Old Town' } } }]);
  check('publish of a night naming a venue is accepted', pub.publishJournal('2026-10-29', 'Dinner at Blue Lagoon Cafe was bad. The food was stale and overpriced.').ok);
  store.putJournal('2026-10-28', 'Coffee at blue lagoon cafe, slow service.', 'owner');
  clock.advance?.(10 * 60);
  res = await pub.exportNow();
  const jv = JSON.parse(puts.at(-1).body).journal;
  const textV = jv.map((j) => j.text).join(' | ');
  check('the exported journal names no venue', jv.length === 2 && !/blue lagoon/i.test(textV), textV);
  check('…it says its kind instead', /Dinner at a cafe was bad/.test(textV) && /Coffee at a cafe/.test(textV), textV);
  pub.unpublishJournal('2026-10-29');
  pub.unpublishJournal('2026-10-28');
  res = await pub.exportNow();
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'dashboard', 'routes', 'arcs.js'), 'utf8');
  check('the publish route takes only the self part', /originKind === 'self' && p\?\.status === 'active'/.test(src));
}

// ── 11. privacy refresh: opt-out, purge, unpublish reach the live site ──
section('11. privacy refresh');
{
  const lifeR = (await import('../src/life/index.js')).publicRaw;
  pub.__setDepsForTest({ publicRaw: (o) => lifeR(o), enabled: () => true, dryRun: () => false, knownNames: () => store.knownPeopleNames() });
  putOk = true;
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  clock.advance?.(10 * 60);
  await pub.exportNow();
  check('shown before', puts.at(-1).body.includes('"Pri"'));
  pub.setOptIn(P1, { optedIn: false });
  check('an opt-out raises a durable refresh request', pub.status().privacyRefreshPending === true);
  let r = await pub.runPrivacyRefresh();
  check('skill on → exported at once, the name gone', r.status === 'exported' && !puts.at(-1).body.includes('"Pri"') && pub.status().privacyRefreshPending === false, r);
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  pub.__setDepsForTest({ enabled: () => false });
  pub.setOptIn(P1, { optedIn: false });
  r = await pub.runPrivacyRefresh();
  check('skill off → the site is taken offline (nothing new published)', r.status === 'offline' && JSON.parse(puts.at(-1).body).offline === true, r);
  pub.__setDepsForTest({ enabled: () => true });
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  pub.setOptIn(P1, { optedIn: false });
  putOk = false;
  r = await pub.runPrivacyRefresh();
  check('upload failing → takedown attempted, request kept for the next tick', r.status === 'failed' && pub.status().privacyRefreshPending === true, r);
  putOk = true;
  r = await pub.runPrivacyRefresh();
  check('…and the retry succeeds', r.status === 'exported' && pub.status().privacyRefreshPending === false, r);
  const P3 = '10000000000103@lid';
  db.prepare("INSERT INTO people (jid, push_name) VALUES (?, 'Meenu')").run(P3);
  pub.setOptIn(P3, { optedIn: true, displayName: 'Meenu' });
  await pub.runPrivacyRefresh();
  purgePerson(P3, 'test', 'owner');
  check('purging a shown person raises the refresh request (in the purge transaction)', pub.status().privacyRefreshPending === true);
  r = await pub.runPrivacyRefresh();
  check('…and the export after it has no trace of them', r.status === 'exported' && !puts.at(-1).body.includes('Meenu'), r);
  // An opt-out while an export is uploading: the refresh waits for it and exports again —
  // never 'busy' → takedown, and the older (named) document never lands last.
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  await pub.runPrivacyRefresh();
  clock.advance?.(10 * 60);
  let releasePut;
  const gate = new Promise((res) => { releasePut = res; });
  const realPut = async (key, body) => { puts.push({ key, body }); return { ok: true, status: 200 }; };
  pub.__setDepsForTest({ put: async (key, body) => { await gate; return realPut(key, body); } });
  const slow = pub.exportNow();
  pub.setOptIn(P1, { optedIn: false });
  const refresh = pub.runPrivacyRefresh();
  pub.__setDepsForTest({ put: realPut });
  releasePut();
  await slow;
  r = await refresh;
  check('a refresh racing an export → exported after it (not offline), the name gone from the last upload',
    r.status === 'exported' && JSON.parse(puts.at(-1).body).offline !== true && !puts.at(-1).body.includes('"Pri"') && pub.status().privacyRefreshPending === false, r);
  // A second request (B) while refresh A's own export is uploading: A must not clear B.
  // B is either served before A's run returns or still pending for the next one.
  const P4 = '10000000000104@lid';
  db.prepare("INSERT INTO people (jid, push_name) VALUES (?, 'Rahim')").run(P4);
  pub.setOptIn(P1, { optedIn: true, displayName: 'Pri' });
  pub.setOptIn(P4, { optedIn: true, displayName: 'Rah' });
  await pub.runPrivacyRefresh();
  clock.advance?.(10 * 60);
  await pub.exportNow({ force: true });
  check('refresh B setup: both shown', puts.at(-1).body.includes('"Pri"') && puts.at(-1).body.includes('"Rah"'));
  let releaseA;
  const gateA = new Promise((res) => { releaseA = res; });
  pub.__setDepsForTest({ put: async (key, body) => { await gateA; return realPut(key, body); } });
  pub.setOptIn(P1, { optedIn: false });                   // request A
  const refreshA = pub.runPrivacyRefresh();               // builds now (Rah still in), waits on the upload
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  pub.setOptIn(P4, { optedIn: false });                   // request B, mid-upload
  const joined = pub.runPrivacyRefresh();                 // the timer's call joins the run in flight
  pub.__setDepsForTest({ put: realPut });
  releaseA();
  r = await refreshA;
  await joined;
  check('a request arriving mid-upload is never cleared unserved',
    pub.status().privacyRefreshPending === true || !puts.at(-1).body.includes('"Rah"'), { r, pending: pub.status().privacyRefreshPending });
  if (pub.status().privacyRefreshPending) await pub.runPrivacyRefresh();
  check('…and B reaches the live site (Rah gone, nothing pending)',
    !puts.at(-1).body.includes('"Rah"') && !puts.at(-1).body.includes('"Pri"') && pub.status().privacyRefreshPending === false);
}

// ── 12. scenes (spec 016, export-contract.md) ───────────────────────────────
section('12. scenes (016 export contract)');
{
  const { build, distKm } = await import('../src/public/build.js');
  const { validateScene, SCENE_ENDINGS } = await import('../src/public/schema.js');
  const T = 1_800_000_000 - (1_800_000_000 % 86400) + 20 * 3600;   // 20:00 UTC
  const today0 = T - 20 * 3600;
  const HOME = { id: 'place:home', name: 'Rosewood Flat', kind: 'home', lat: 0.97, lon: 0.59, home: true };
  const OLD = { id: 'place:old', name: 'Old Digs', kind: 'home', lat: 1.01, lon: 0.62, home: true };
  const FAR = { id: 'place:vfar', name: 'Filter & Foam', kind: 'cafe', lat: 0.99, lon: 0.62, home: false, venue: true, area: 'Greenfield' };
  const NEAR = { id: 'place:vnear', name: 'Corner Grill', kind: 'restaurant', lat: 0.975, lon: 0.595, home: false, venue: true, area: 'Hillside' };
  const CELL = { id: 'place:vcell', name: 'Doorstep Diner', kind: 'restaurant', lat: 0.9705, lon: 0.5905, home: false, venue: true, area: 'Hillside' };
  const BYOLD = { id: 'place:vold', name: 'Lakeview Bar', kind: 'bar', lat: 1.012, lon: 0.622, home: false, venue: true, area: 'Northside' };
  const PARK = { id: 'place:park', name: 'Lakeside Park', kind: 'park', lat: 0.95, lon: 0.65, home: false };
  const CAST = [{ id: 'cast:asha', name: 'Asha Varnell' }, { id: 'cast:ravi', name: 'Ravi Das' }];
  const persona = { name: 'Kiran', displayName: 'Kiran', region: 'Testville, Northshire' };
  const scrubber = makeScrubber({ knownNames: ['Priya Raman'], allowNames: ['Kiran', 'Asha Varnell', 'Ravi Das'] });
  const venueWords = (t) => [FAR, NEAR, CELL, BYOLD].reduce((x, p) => x.split(p.name).join(p.kind === 'cafe' ? 'a cafe' : p.kind === 'bar' ? 'a bar' : 'a restaurant'), t);
  const raw = (scenes, over = {}) => ({
    at: T, tz: 'UTC', from: today0 - 3 * DAY, today0, heavyAt: [], heavyWindowSec: 31 * DAY,
    self: { homePlaceId: HOME.id, birthdate: null },
    now: {}, next: [], arcs: [], votes: [], stats: { sleeps: [], rainyDays: [], plansKept: 0, plansBailed: 0 },
    places: [HOME, OLD, FAR, NEAR, CELL, BYOLD, PARK], cast: CAST.map((c) => ({ ...c, metrics: {}, series: [] })),
    rows: [{ at: T - 4 * HOUR, end: T - 2 * HOUR, kind: 'eat-out', placeId: FAR.id, castIds: ['cast:asha'] },
      { at: T - 30 * HOUR, end: T - 28 * HOUR, kind: 'walk', placeId: PARK.id, castIds: ['cast:ravi'] }],
    ...over, scenes,
  });
  const base = {
    sceneEventId: 101, activityEventId: 100, at: T - 4 * HOUR, end: T - 2 * HOUR, kind: 'eat-out', placeId: FAR.id,
    castIds: ['cast:asha'], firstMeet: ['cast:asha'], ending: 'swapped_numbers', mode: 'full', originKind: 'self',
    text: 'They met at Filter & Foam after the rain.\n\nThey argued about books and laughed a lot.',
    topics: ['books', 'the rain'], highlight: 'The mix-up at Filter & Foam.', awkward: 'He forgot her name once.',
    impressions: { him: [{ castId: 'cast:asha', text: 'Funny and easy to talk to.' }], them: [{ castId: 'cast:asha', text: 'Kind, a bit shy at first.' }] },
  };
  const mk = (list, over = {}, opts = {}) => build({ raw: raw(list, over), persona, scrubber, salt: 's'.repeat(32), venueWords, scenes: list, ...opts });
  const one = (sc, over, opts) => mk([{ ...base, ...sc }], over, opts).scenes ?? null;

  const d0 = mk([base]);
  const sc = d0.scenes?.[0];
  check('a fictional first meeting at a far venue is exported', d0.scenes?.length === 1 && /^s_[0-9a-f]{10}$/.test(sc.id), d0.scenes);
  check('…v stays 1, scenesSchema 1 beside it, the whole doc validates', d0.v === 1 && d0.scenesSchema === 1 && validate(d0, scrubber).ok, validate(d0, scrubber).errors);
  eq('…closed keys of a scene', Object.keys(sc).sort(), ['area', 'at', 'awkward', 'end', 'ending', 'firstMeet', 'highlight', 'id', 'impressions', 'kind', 'paras', 'placeId', 'topics', 'with'].sort());
  check('…no chemistry / outcome / effects / model / tone / title exported', !/chemistry|outcome|effects|model|provider|tone|title|cost/.test(JSON.stringify(sc)));
  check('…with + firstMeet are public cast ids, kind is the activity code', sc.with.length === 1 && /^c_/.test(sc.with[0]) && sc.firstMeet[0] === sc.with[0] && sc.kind === 'eat-out');
  check('…area for a real venue ≥ 2 km from every home', sc.area === 'Greenfield' && distKm(FAR.lat, FAR.lon, HOME.lat, HOME.lon) >= 2);
  check('…paras split on paragraph breaks; every venue name → its kind word (a negative moment never names it)',
    sc.paras.length === 2 && !JSON.stringify(sc).includes('Filter & Foam') && sc.paras[0].includes('a cafe') && sc.highlight.includes('a cafe'));
  eq('…impressions for a first meeting', sc.impressions, { him: 'Funny and easy to talk to.', them: 'Kind, a bit shy at first.' });
  check('…the day row carries its sceneId', [...d0.today.rows, ...d0.days.flatMap((x) => x.rows)].some((r) => r.kind === 'eat-out' && r.sceneId === sc.id));
  check('…the scene id is stable across a regenerated version (keyed by the outing)', one({ sceneEventId: 202 })?.[0]?.id === sc.id);
  check('…an awkward line at a named venue keeps the business out', one({ awkward: 'The waiter at Corner Grill spilled coffee on him.' })[0].awkward === 'The waiter at a restaurant spilled coffee on him.');

  // Real people, origin, mode
  eq('a real-person subject → no scene', one({ subjectJid: P1 }), []);
  eq('a cast id the export doesn\'t know (not fictional cast) → no scene', one({ castIds: ['cast:asha', 'cast:ghost'] }), []);
  eq('nobody with him → no scene', one({ castIds: [], firstMeet: [] }), []);
  eq('a narration-only (chat-origin) scene → none', one({ mode: 'narration_only' }), []);
  eq('a self-only (real person) scene → none', one({ mode: 'self_only' }), []);
  eq('a chat origin → none', one({ originKind: 'group' }), []);
  // Heavy
  eq('a heavy scene → none', one({ heavy: true }), []);
  eq('a scene near a heavy onset → none', one({}, { heavyAt: [T - DAY] }), []);
  eq('a hard stretch now → none', one({}, { now: { hardStretch: true } }), []);
  // Home
  eq('at home → none', one({ placeId: HOME.id }), []);
  eq('at a former home → none', one({ placeId: OLD.id }), []);
  eq('at an unknown place (could be a home) → none', one({ placeId: 'place:nowhere' }), []);
  check('no place → exported with placeId null, area null', one({ placeId: null })[0]?.placeId === null && one({ placeId: null })[0]?.area === null);
  // Area
  check('a venue < 2 km from home → area null (scene kept)', one({ placeId: NEAR.id })[0]?.area === null && distKm(NEAR.lat, NEAR.lon, HOME.lat, HOME.lon) < 2);
  check('a venue in a home\'s 0.01° cell → area null', one({ placeId: CELL.id })[0]?.area === null);
  check('a venue < 2 km from a FORMER home → area null', one({ placeId: BYOLD.id })[0]?.area === null);
  check('a generic (not real-venue) place → area null', one({ placeId: PARK.id })[0]?.area === null);
  check('a home without coordinates → no area anywhere (fail closed)', mk([base], { places: [{ ...HOME, lat: null, lon: null }, FAR] }).scenes[0]?.area === null);
  check('an area naming the region → area null', mk([base], { places: [HOME, { ...FAR, area: 'Northshire East' }] }).scenes[0]?.area === null);
  // Text rules
  eq('a home name in the text → none', one({ text: 'Back at Rosewood Flat they talked.' }), []);
  eq('a region string in the text → none', one({ text: 'The best cafe in Testville, he said.' }), []);
  eq('a real person\'s name in the text → none (scrubber)', one({ text: 'Priya Raman joined them later.' }), []);
  eq('a phone number in a paragraph → none', one({ text: 'Call 98765 43210 she said.' }), []);
  check('a refused highlight → null, scene kept', one({ highlight: 'Priya Raman waved.' })[0]?.highlight === null);
  check('a refused topic is dropped, the rest kept', JSON.stringify(one({ topics: ['books', 'Priya Raman', 'cats'] })[0]?.topics) === '["books","cats"]');
  eq('no venue rule available → no scenes (never raw text)', mk([base], {}, { venueWords: null }).scenes, []);
  eq('empty text → none', one({ text: '  ' }), []);
  // Caps
  const long = Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1} ${'and they walked on '.repeat(12)}`.trim()).join('\n\n');
  const longDoc = mk([{ ...base, text: long }]);
  const c1 = longDoc.scenes?.[0];
  check('a long narration exports (9 paragraphs, over 1200, at most 2400) and v stays 1',
    longDoc.v === 1 && c1 && c1.paras.length === 9 && c1.paras.join('').length > 1200 && c1.paras.join('').length <= 2400, c1 && [c1.paras.length, c1.paras.join('').length]);
  const c2 = one({ topics: Array.from({ length: 8 }, (_, i) => `topic ${i} ${'x'.repeat(60)}`), highlight: 'h'.repeat(400), awkward: null })[0];
  check('≤ 5 topics × 40, highlight ≤ 160, awkward null', c2.topics.length === 5 && c2.topics.every((t) => t.length <= 40) && c2.highlight.length <= 160 && c2.awkward === null);
  check('≤ 30 scenes, newest first', (() => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...base, sceneEventId: 1000 + i, activityEventId: 2000 + i, at: T - (i + 3) * HOUR, end: T - (i + 2) * HOUR }));
    const out = mk(many).scenes;
    return out.length === 30 && out.every((x, i) => i === 0 || out[i - 1].at >= x.at);
  })());
  // Impressions, ending, window
  check('not a first meeting → impressions null', one({ firstMeet: [] })[0]?.impressions === null);
  check('firstMeet keeps only members who are with him', JSON.stringify(one({ firstMeet: ['cast:asha', 'cast:ravi'] })[0]?.firstMeet) === JSON.stringify([sc.with[0]]));
  check('impressions as plain strings are taken too; one side missing → null',
    one({ impressions: { him: 'A good evening.', them: 'Nice guy.' } })[0]?.impressions?.them === 'Nice guy.' && one({ impressions: { him: 'A good evening.', them: null } })[0]?.impressions === null);
  check('every ending of the enum is accepted', SCENE_ENDINGS.every((e) => one({ ending: e })[0]?.ending === e));
  eq('an unknown ending → none', one({ ending: 'eloped' }), []);
  eq('a scene that ended before the export window → none', one({ at: today0 - 5 * DAY, end: today0 - 5 * DAY + HOUR }), []);
  // Schema
  check('scenes: null → no scenes / scenesSchema keys (the old document)', (() => { const d = mk(null); return !('scenes' in d) && !('scenesSchema' in d) && validate(d, scrubber).ok; })());
  check('the schema refuses an unknown key in a scene', !validate({ ...d0, scenes: [{ ...sc, chemistry: 0.7 }] }, scrubber).ok);
  check('the schema refuses paras over 2400 together, > 9 paras, a bad id, scenesSchema without scenes, firstMeet outside with',
    validateScene({ ...sc, paras: ['a'.repeat(1300), 'b'.repeat(1300)] }, scrubber).length > 0
    && validateScene({ ...sc, paras: ['c'.repeat(2000)] }, scrubber).length === 0
    && validateScene({ ...sc, paras: Array(10).fill('A short line.') }, scrubber).length > 0
    && validateScene({ ...sc, id: 'scene_1' }, scrubber).length > 0
    && !validate((() => { const d = { ...d0 }; delete d.scenes; return d; })(), scrubber).ok
    && validateScene({ ...sc, firstMeet: ['c_0000000000'] }, scrubber).length > 0);
  check('a day row with a bad sceneId fails validation', !validate({ ...d0, today: { ...d0.today, rows: [{ ...d0.today.rows[0] ?? { at: T, end: null, kind: 'work', label: 'Working', placeId: null, with: [] }, sceneId: 'x' }] } }, scrubber).ok);

  // Through the exporter: publicRaw + publicScenes stubs over the real life view.
  const lifeR = (await import('../src/life/index.js')).publicRaw;
  {
    const r0 = lifeR({});
    check('the real life view: raw.scenes is a list, every place says venue / area, spans keep their event id (internal)',
      Array.isArray(r0?.scenes) && r0.places.every((p) => typeof p.venue === 'boolean' && 'area' in p)
      && r0.rows.filter((x) => !('type' in x) && x.kind !== 'sleep' && x.kind !== 'commute' && x.kind !== 'out').every((x) => Number.isSafeInteger(x.eventId)), { scenes: r0?.scenes, place: r0?.places?.[0] });
  }
  let rawSeen = null;
  let keepHeavy = false;
  pub.__setDepsForTest({
    enabled: () => true, dryRun: () => false,
    publicRaw: (o) => {
      const r = lifeR(o);
      if (!r) return r;
      const fic = r.cast[0];
      const venue = r.places.find((p) => !p.home && Number.isFinite(p.lat));
      rawSeen = { fic, venue };
      // The fixture's heavy onset (section 4) is hours old: cleared here to test the plumbing
      // (the pure cases above cover heavy), kept for the check right after.
      const heavy = keepHeavy ? {} : { heavyAt: [], now: { ...r.now, hardStretch: false } };
      return { ...r, ...heavy, scenes: [
        { sceneEventId: 9001, activityEventId: 9000, at: r.at - 3 * HOUR, end: r.at - 2 * HOUR, kind: 'eat-out', placeId: venue?.id ?? null, castIds: [fic.id], firstMeet: [], ending: 'plan_to_meet', mode: 'full', originKind: 'self' },
        { sceneEventId: 9003, activityEventId: 9002, at: r.at - 5 * HOUR, end: r.at - 4 * HOUR, kind: 'eat-out', placeId: null, castIds: [fic.id], firstMeet: [], ending: 'nothing', mode: 'full', originKind: 'self', subjectJid: P1 },
      ] };
    },
    publicScenes: (idsIn) => idsIn.map((id) => ({ sceneEventId: id, text: 'A slow dinner, lots of talk.', topics: ['work'], highlight: 'Dessert.', awkward: null, impressions: null })),
  });
  clock.advance?.(10 * 60);
  let r12 = await pub.exportNow({ force: true });
  let d12 = JSON.parse(puts.at(-1).body);
  check('exportNow: the document with scenes validates and uploads', (r12.status === 'ok' || r12.status === 'unchanged') && d12.v === 1 && d12.scenesSchema === 1, r12);
  check('exportNow: the fictional scene is there, the real-person one is not', d12.scenes?.length === 1 && d12.scenes[0].ending === 'plan_to_meet' && !/(?<![0-9a-f])9002(?![0-9a-f])/.test(puts.at(-1).body), d12.scenes);
  keepHeavy = true;
  clock.advance?.(10 * 60);
  await pub.exportNow({ force: true });
  check('exportNow: the same scene a few hours after a heavy onset → not published', Array.isArray(JSON.parse(puts.at(-1).body).scenes) && JSON.parse(puts.at(-1).body).scenes.length === 0);
  keepHeavy = false;
  pub.__setDepsForTest({ scenesOn: () => false });
  clock.advance?.(10 * 60);
  await pub.exportNow({ force: true });
  d12 = JSON.parse(puts.at(-1).body);
  check('arcs.scenePublic=false → no scenes key', !('scenes' in d12) && !('scenesSchema' in d12));
  pub.__setDepsForTest({ scenesOn: () => true, publicScenes: () => { throw new Error('boom'); } });
  clock.advance?.(10 * 60);
  r12 = await pub.exportNow({ force: true });
  d12 = JSON.parse(puts.at(-1).body);
  check('a failed scene-text read → the export still goes out, without scenes', (r12.status === 'ok' || r12.status === 'unchanged') && !('scenes' in d12), r12);
  pub.__setDepsForTest({ publicRaw: (o) => lifeR(o), publicScenes: () => null });
  clock.advance?.(10 * 60);
  await pub.exportNow({ force: true });
  check('no raw scene view (engine without 016) → the 013 document, no scenes key', !('scenes' in JSON.parse(puts.at(-1).body)));
}

// ── 13. wallet (spec 018) ───────────────────────────────────────────────────
section('13. wallet (018: an optional key beside v 1)');
{
  const { build } = await import('../src/public/build.js');
  const lifeW = (await import('../src/life/index.js')).publicRaw;
  pub.__setDepsForTest({ publicRaw: (o) => lifeW(o), publicScenes: () => null });
  clock.advance?.(10 * 60);
  const r13 = await pub.exportNow({ force: true });
  check('the export with a wallet goes out', r13.status === 'ok' || r13.status === 'unchanged', r13);
  const body = puts.at(-1).body;
  const d = JSON.parse(body);
  eq('v stays 1 beside wallet, walletSchema 1', [d.v, d.walletSchema, typeof d.wallet], [1, 1, 'object']);
  const items = d.wallet.days.flatMap((x) => x.items);
  check('a chat outing\'s spend is folded: that day\'s outWithFriends, no item of it', d.wallet.days.some((x) => x.outWithFriends === 350)
    && !items.some((it) => it.amount === 350), d.wallet.days.map((x) => x.outWithFriends));
  check('…and it counts in the month as "out"', (d.wallet.byCategory.out ?? 0) >= 350);
  check('a heavy setback is dropped (no item, no setback category)', !items.some((it) => it.amount === 4321) && !('setback' in d.wallet.byCategory) && !/(?<![0-9a-f])4321(?![0-9a-f])/.test(body));
  const inc = items.find((it) => it.category === 'income');
  eq('an owner income: the code word, never the owner\'s label', [inc?.label, inc?.amount, body.includes('OWNERLABEL')], ['Income', 2500, false]);
  check('a spend at home has no place', items.find((it) => it.amount === 260)?.placeId === null);
  const atVenue = items.find((it) => it.amount === 480);
  check('a spend at a venue points at an exported place', !!atVenue?.placeId && d.city.places.some((p) => p.id === atVenue.placeId));
  check('every item place is an exported place', items.every((it) => it.placeId === null || d.city.places.some((p) => p.id === it.placeId)));
  const castNames = [...(await import('../src/life/index.js')).getState().cast.values()].map((c) => c.name.split(' ')[0]);
  check('labels are code words: no cast or real names', items.every((it) => /^[A-Z][a-z]+(?: [a-z]+)*(?:-[a-z]+)?$/.test(it.label)
    && !castNames.some((n) => it.label.includes(n)) && !/Priya|Rahul/.test(it.label)), items.map((it) => it.label));
  check('item ids are salted w_ hashes', items.length > 0 && items.every((it) => /^w_[0-9a-f]{10}$/.test(it.id)));
  check('days: the window newest first, every day', d.wallet.days.length >= 3 && d.wallet.days.every((x, i) => i === 0 || d.wallet.days[i - 1].date > x.date));
  eq('day totals add up (out = items out + outWithFriends)', d.wallet.days.every((x) => x.out === x.items.filter((it) => it.dir === 'out').reduce((a, it) => a + it.amount, 0) + x.outWithFriends
    && x.in === x.items.filter((it) => it.dir === 'in').reduce((a, it) => a + it.amount, 0)), true);
  eq('balance = now.vitals.money', d.wallet.balance, d.now.vitals.money);
  {
    const rawS = lifeW({ days: 14 });
    const day0 = rawS.wallet.since;   // his world's genesis: its local day is the oldest one kept
    const docS = build({ raw: rawS, persona: { name: 'Kiran' }, scrubber: makeScrubber({ knownNames: [], groupNames: [], allowNames: ['Kiran'] }), salt: 'w'.repeat(32) });
    const keysS = docS.wallet.days.map((x) => x.date);
    rawS.wallet.since = null;
    const keysAll = build({ raw: rawS, persona: { name: 'Kiran' }, scrubber: makeScrubber({ knownNames: [], groupNames: [], allowNames: ['Kiran'] }), salt: 'w'.repeat(32) }).wallet.days.map((x) => x.date);
    const dk = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: rawS.timezone ?? world.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
    check('no empty days from before his world began (genesis day kept)', Number.isFinite(day0) && keysS.at(-1) === dk(day0)
      && keysS.every((k) => k >= dk(day0)) && keysAll.length >= keysS.length, { keysS, keysAll: keysAll.length });
  }

  check('salary: amount, payday, next date', d.wallet.salary && d.wallet.salary.payday === world.money.payday && /^\d{4}-\d{2}-\d{2}$/.test(d.wallet.salary.nextDate));
  // Old raws (an engine without 018) build the 016 document unchanged: no wallet keys.
  const raw0 = lifeW({ days: 14 });
  delete raw0.wallet;
  const doc0 = build({ raw: raw0, persona: { name: 'Kiran' }, scrubber: makeScrubber({ knownNames: [], groupNames: [], allowNames: ['Kiran'] }), salt: 'w'.repeat(32) });
  check('no raw wallet → no wallet / walletSchema keys, and it validates', !('wallet' in doc0) && !('walletSchema' in doc0)
    && validate(doc0, makeScrubber({ knownNames: [], allowNames: ['Kiran'] })).ok, validate(doc0, makeScrubber({ knownNames: [], allowNames: ['Kiran'] })).errors);
  const sc = makeScrubber({ knownNames: [], allowNames: ['Kiran'] });
  check('walletSchema without wallet is refused', validate({ ...doc0, walletSchema: 1 }, sc).errors.includes('$.walletSchema:without_wallet'));
  check('a wallet with v 2 is refused (v stays 1)', !validate({ ...d, v: 2 }, sc).ok);
  const bad = structuredClone(d);
  bad.wallet.byCategory.setback = 10;
  check('a setback category is refused by the schema', validate(bad, sc).errors.some((e) => e.startsWith('$.wallet.byCategory.setback')));
  const bad2 = structuredClone(d);
  if (bad2.wallet.days[0]) bad2.wallet.days[0].items.push({ id: 'w_0123456789', at: d.generatedAt, dir: 'out', amount: 10, category: 'food', label: 'Lunch with Rahul', placeId: null });
  check('a wallet label is scrubbed like every string', validate(bad2, makeScrubber({ knownNames: ['Rahul'], allowNames: ['Kiran'] })).errors.some((e) => /wallet.*real_name/.test(e)));
}


// ── 14. phone (spec 019) ────────────────────────────────────────────────────
section('14. phone (019: his texts with the fictional cast, an optional key beside v 1)');
{
  const { build } = await import('../src/public/build.js');
  const lifeP = await import('../src/life/index.js');
  const { rebuild } = await import('../src/life/projector.js');
  const castNow = [...rebuild({ world }).cast.values()];
  const A = castNow[1];
  const B = castNow[2];
  const t = clock.now();
  // Until this branch meets the engine half of 019, the log's catalogue lacks the type: the
  // test lets the reader know it (the merged engine registers it for real).
  const { EVENT_TYPES } = await import('../src/life/eventLog.js');
  const knewPhone = EVENT_TYPES.has('phone.message');
  {
    const rawBefore = (await import('../src/life/index.js')).publicRaw({ days: 14 });
    check('an engine without the phone type: raw.phone is empty, the export goes on', knewPhone || (Array.isArray(rawBefore?.phone) && rawBefore.phone.length === 0));
  }
  if (!knewPhone) EVENT_TYPES.add('phone.message');
  // phone.message rows written straight into the log (the type is the engine fork's; the
  // export reads it by its type string): ids, times and directions only — the texts come
  // from publicPhone, never from the log.
  const ins = db.prepare(`INSERT INTO world_events (at, type, actor, cause_id, payload_json, origin_kind, origin_jid, subject_jid, heavy, redacted)
    VALUES (?, 'phone.message', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const msg = (dt, castId, dir, o = {}) => Number(ins.run(t - dt, o.actor ?? 'mind', o.cause ?? null,
    JSON.stringify({ threadId: castId, dir, msgId: `x${dt}`, length: 12, textSha: 'a'.repeat(16), trigger: 'test' }),
    o.origin ?? 'self', o.originJid ?? 'self', o.subject ?? null, o.heavy ? 1 : 0, o.redacted ? 1 : 0).lastInsertRowid);
  const M = {
    out1: msg(400, A.id, 'out'), in1: msg(390, A.id, 'in'), venue: msg(380, A.id, 'out'), realName: msg(370, A.id, 'in'),
    reverted: msg(360, A.id, 'out'), chat: msg(350, A.id, 'out', { origin: 'group', originJid: G }), subject: msg(340, A.id, 'out', { subject: P1 }),
    stranger: msg(330, 'cast:not-in-his-life', 'out'), heavyChain: ids.heavy ? msg(320, A.id, 'out', { cause: ids.heavy, actor: 'engine' }) : null,
    heavyRow: msg(310, A.id, 'in', { heavy: true }), redacted: msg(305, A.id, 'out', { redacted: true }), home: msg(302, A.id, 'out'),
    out2: msg(300, B.id, 'out', { actor: 'owner', origin: 'owner' }),
  };
  const TEXT = {
    [M.out1]: 'free tonight?', [M.in1]: 'maybe! after 8', [M.venue]: 'meet at Bean Bar Northside?', [M.realName]: 'saw Priya Raman at the market',
    [M.reverted]: 'REVERTEDTEXT', [M.chat]: 'CHATTEXT', [M.subject]: 'SUBJECTTEXT', [M.stranger]: 'STRANGERTEXT', [M.heavyRow]: 'HEAVYROWTEXT',
    [M.redacted]: 'REDACTEDTEXT', [M.home]: `come over to ${ids.homeName ?? 'Home'}`, [M.out2]: 'happy birthday da 🎂',
  };
  if (M.heavyChain) TEXT[M.heavyChain] = 'HEAVYCHAINTEXT';
  delete TEXT[M.reverted];   // publicPhone gives live rows only: a reverted message has no text
  TEXT[M.reverted] = undefined;
  let asked = [];
  const stub = (list) => { asked = list.slice(); return new Map(list.filter((id) => typeof TEXT[id] === 'string').map((id) => [id, TEXT[id]])); };
  const venueStub = (x) => String(x).replace(/Bean Bar Northside/g, 'a bar');

  const rawP = lifeP.publicRaw({ days: 14 });
  const listed = new Set((rawP.phone || []).map((r) => r.eventId));
  check('raw.phone: ids, cast, times and directions only — no text, no payload', Array.isArray(rawP.phone)
    && rawP.phone.every((r) => Object.keys(r).sort().join() === 'at,castId,dir,eventId'));
  check('raw.phone: self / owner texts with his cast are listed', [M.out1, M.in1, M.venue, M.realName, M.reverted, M.home, M.out2].every((id) => listed.has(id)), [...listed]);
  check('raw.phone: a chat-origin, a real-person subject, a stranger thread, a heavy row / chain and a redacted row never are',
    [M.chat, M.subject, M.stranger, M.heavyRow, M.redacted, M.heavyChain].filter(Boolean).every((id) => !listed.has(id)));

  // The fixture's heavy onset (t − 50 min) holds every text of the window back: first that,
  // then the same raw without it for the positive cases.
  pub.__setDepsForTest({ publicRaw: () => structuredClone(rawP), publicPhone: stub, venueWords: venueStub });
  clock.advance?.(60);
  await pub.exportNow({ force: true });
  const dH = JSON.parse(puts.at(-1).body);
  check('near a heavy onset / in a hard stretch: no message goes out (phone key, no threads)', dH.v === 1 && dH.phoneSchema === 1 && Array.isArray(dH.phone?.threads) && dH.phone.threads.length === 0, dH.phone);
  const calm = { ...structuredClone(rawP), heavyAt: [], now: { ...structuredClone(rawP.now), hardStretch: false } };
  pub.__setDepsForTest({ publicRaw: () => structuredClone(calm) });
  clock.advance?.(60);
  const r14 = await pub.exportNow({ force: true });
  check('the export with a phone goes out', r14.status === 'ok' || r14.status === 'unchanged', r14);
  const body = puts.at(-1).body;
  const d = JSON.parse(body);
  eq('v stays 1 beside phone, phoneSchema 1', [d.v, d.phoneSchema, Array.isArray(d.phone?.threads)], [1, 1, true]);
  check('publicPhone is asked only for listed messages', asked.length > 0 && asked.every((id) => listed.has(id)) && !asked.includes(M.chat) && !asked.includes(M.subject));
  const castPub = new Map(d.people.cast.map((c) => [c.id, c.name]));
  const all = d.phone.threads.flatMap((th) => th.messages.map((m) => ({ ...m, thread: th.id })));
  check('every thread is a cast member of the document, named as there', d.phone.threads.length === 2 && d.phone.threads.every((th) => castPub.get(th.id) === th.name));
  const texts = all.map((m) => m.text);
  check('his and their texts go out, owner-told too', ['free tonight?', 'maybe! after 8', 'happy birthday da 🎂'].every((x) => texts.includes(x)), texts);
  check('a venue name becomes its kind word', texts.includes('meet at a bar?') && !body.includes('Bean Bar'));
  check('a text with a real name is dropped (not the thread)', !body.includes('Priya') && !texts.some((x) => /market/.test(x)));
  check('a text naming his home is dropped', !texts.some((x) => /come over/.test(x)));
  check('reverted, chat, subject, stranger, heavy and redacted texts never appear',
    !/REVERTEDTEXT|CHATTEXT|SUBJECTTEXT|STRANGERTEXT|HEAVYROWTEXT|HEAVYCHAINTEXT|REDACTEDTEXT/.test(body));
  check('ids are salted m_ hashes, directions in/out', all.every((m) => /^m_[0-9a-f]{10}$/.test(m.id) && (m.dir === 'in' || m.dir === 'out')));
  check('a thread: messages oldest → newest, lastAt its newest, threads newest first',
    d.phone.threads.every((th) => th.messages.every((m, i) => i === 0 || m.at >= th.messages[i - 1].at) && th.lastAt === th.messages.at(-1).at)
    && d.phone.threads.every((th, i) => i === 0 || th.lastAt <= d.phone.threads[i - 1].lastAt));

  // Caps: ≤ 60 per thread (newest kept), straight through the builder.
  const sc = makeScrubber({ knownNames: ['Priya Raman'], allowNames: ['Kiran', ...castNow.map((c) => c.name)] });
  const many = Array.from({ length: 75 }, (_, i) => ({ eventId: 900000 + i, castId: A.id, at: t - 1000 + i, dir: i % 2 ? 'in' : 'out', text: `message number ${i}` }));
  const docM = build({ raw: calm, persona: { name: 'Kiran' }, scrubber: sc, salt: 'p'.repeat(32), venueWords: venueStub, phone: many });
  const thM = docM.phone.threads[0];
  check('≤ 60 messages a thread, the newest kept', thM.messages.length === 60 && thM.messages.at(-1).text === 'message number 74' && thM.messages[0].text === 'message number 15');
  check('the capped document validates', validate(docM, sc).ok, validate(docM, sc).errors.slice(0, 5));
  const docNoVenue = build({ raw: calm, persona: { name: 'Kiran' }, scrubber: sc, salt: 'p'.repeat(32), venueWords: null, phone: many });
  check('no venue rule → no text at all (an empty phone)', docNoVenue.phone.threads.length === 0);

  // No phone key: an engine without 019 (no raw), or no publicPhone / a failed read.
  const rawNo = structuredClone(calm);
  delete rawNo.phone;
  check('no raw phone → no phone / phoneSchema keys', pub.phoneRows(rawNo) === null
    && !('phone' in build({ raw: rawNo, persona: { name: 'Kiran' }, scrubber: sc, salt: 'p'.repeat(32), venueWords: venueStub, phone: pub.phoneRows(rawNo) })));
  pub.__setDepsForTest({ publicPhone: () => null });
  check('publicPhone absent → no phone key', pub.phoneRows(calm) === null);
  pub.__setDepsForTest({ publicPhone: () => { throw new Error('read failed'); } });
  check('a failed text read → no phone key (the export goes on)', pub.phoneRows(calm) === null);

  // Schema: closed keys, phoneSchema ⇔ phone, threads of this document's cast, v stays 1.
  const vs = makeScrubber({ knownNames: ['Priya Raman'], allowNames: ['Kiran', ...castNow.map((c) => c.name)] });
  const ok = validate(d, vs);
  check('the document validates', ok.ok, ok.errors.slice(0, 5));
  const noPhone = structuredClone(d); delete noPhone.phone;
  check('phoneSchema without phone is refused', validate(noPhone, vs).errors.includes('$.phoneSchema:without_phone'));
  check('a phone with v 2 is refused (v stays 1)', !validate({ ...d, v: 2 }, vs).ok);
  const extra = structuredClone(d); extra.phone.threads[0].messages[0].jid = 'x';
  check('an extra key on a message is refused', validate(extra, vs).errors.some((e) => /messages\[0\]\.jid:unknown_key/.test(e)));
  const stranger = structuredClone(d); stranger.phone.threads[0].id = 'c_0123456789';
  check('a thread that is not a cast member of the document is refused', validate(stranger, vs).errors.some((e) => /id:not_cast/.test(e)));
  const leak = structuredClone(d); leak.phone.threads[0].messages[0].text = 'lunch with Priya Raman';
  check('a phone text is scrubbed like every string', validate(leak, vs).errors.some((e) => /phone.*real_name/.test(e)));
  const order = structuredClone(d); order.phone.threads[0].messages.reverse();
  check('messages out of order are refused', order.phone.threads[0].messages.length < 2 || validate(order, vs).errors.some((e) => /messages:order|lastAt:mismatch/.test(e)));

  // A sample for the site (public-site builds the PHONE view against it), when asked for one.
  if (process.env.PUBLIC_PHONE_SAMPLE) try {
    fs.writeFileSync(process.env.PUBLIC_PHONE_SAMPLE,
      JSON.stringify({ v: d.v, phoneSchema: d.phoneSchema, people: { cast: d.people.cast.filter((c) => d.phone.threads.some((th) => th.id === c.id)).map((c) => ({ id: c.id, name: c.name })) }, phone: d.phone }, null, 2));
  } catch { /* sample only */ }
  pub.__setDepsForTest({ publicRaw: (o) => lifeP.publicRaw(o), publicPhone: () => null, venueWords: (x) => lifeP.venueKindWords(x) });
  if (!knewPhone) EVENT_TYPES.delete('phone.message');
}
// ── 15. the feed (plan 020): live, thoughts, dreams, mind ─────────────────────
section('15. the feed (plan 020: optional keys beside v 1, each with its own schema number)');
{
  const lifeP = await import('../src/life/index.js');
  const { rebuild } = await import('../src/life/projector.js');
  const { insertThought } = await import('../src/life/thoughtStore.js');
  const { makeScrubber: mk } = await import('../src/public/scrub.js');
  const castNow = [...rebuild({ world }).cast.values()];
  const A = castNow[1];
  const t = clock.now();
  const ins = db.prepare(`INSERT INTO world_events (at, type, actor, cause_id, payload_json, origin_kind, origin_jid, subject_jid, heavy, redacted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const put = (type, dt, payload, o = {}) => Number(ins.run(t - dt, type, 'engine', o.cause ?? null, JSON.stringify(payload), o.origin ?? 'self', o.originJid ?? 'self', o.subject ?? null, o.heavy ? 1 : 0, o.redacted ? 1 : 0).lastInsertRowid);
  const dream = (dt, o = {}) => put('dream.had', dt, { recall: o.recall ?? 'fragment', tone: o.tone ?? 'flat', castIds: o.castIds ?? [A.id], placeIds: o.placeIds ?? ['place:cafe', 'place:home'] }, o);
  const D = {
    own: dream(500), vivid: dream(490, { recall: 'vivid', tone: 'nightmare' }), chat: dream(480, { origin: 'group', originJid: G }), subject: dream(470, { subject: P1 }),
    heavy: dream(460, { heavy: true }), chain: ids.heavy ? dream(455, { cause: ids.heavy }) : null, redacted: dream(450, { redacted: true }),
    departed: dream(445, { castIds: ['cast:gone-now'] }), named: dream(440), long: dream(435), noWords: dream(430),
  };
  const DW = {
    [D.own]: 'Coworker turned up in a dream, at a cafe, saying nothing useful.', [D.vivid]: 'He was at Bean Bar Northside and the way out kept moving away from him.',
    [D.chat]: 'DREAMCHATTEXT', [D.subject]: 'DREAMSUBJECTTEXT', [D.heavy]: 'DREAMHEAVYTEXT', [D.redacted]: 'DREAMREDACTEDTEXT', [D.departed]: 'DREAMDEPARTEDTEXT',
    [D.named]: 'He dreamt about Priya Raman at the market.', [D.long]: `${'A very long fragment that goes on. '.repeat(10)}`,
  };
  if (D.chain) DW[D.chain] = 'DREAMCHAINTEXT';
  const words = (id) => ({ text: DW[id], night: '2026-10-30' });
  const ownEv = put('work.late', 700, { minutes: 30 });
  const chatEv = put('work.late', 690, { minutes: 30 }, { origin: 'group', originJid: G });
  const heavyEv = put('work.late', 680, { minutes: 30 }, { heavy: true });
  const th = (dt, text, o = {}) => insertThought({ at: t - dt, family: o.family ?? 'reaction', text, originKind: o.origin ?? 'self', originJid: o.originJid ?? null, evidence: o.evidence ?? [], dedupeKey: `feed:${dt}`, cause: o.cause ?? 'drove-it' }, t);
  th(400, 'ugh, rain', { evidence: [ownEv] });
  th(390, 'THOUGHTCHATTEXT', { origin: 'group', originJid: G });
  th(380, 'THOUGHTWORDLESSTEXT', { family: 'wordless' });
  th(370, 'THOUGHTCHATEVIDENCE', { evidence: [chatEv] });
  th(360, 'THOUGHTHEAVYEVIDENCE', { evidence: [heavyEv] });
  th(350, 'THOUGHTGONEEVIDENCE', { evidence: [99999999] });
  th(340, 'lunch with Priya Raman again');
  th(330, 'that coffee at Bean Bar Northside');

  const rawP = lifeP.publicRaw({ days: 14 });
  const listedD = new Set((rawP.dreams || []).map((r) => r.eventId));
  check('raw.dreams: codes only, no words', Array.isArray(rawP.dreams) && rawP.dreams.every((r) => Object.keys(r).sort().join() === 'at,castIds,eventId,placeIds,recall,tone'));
  check('raw.dreams: his own are listed', [D.own, D.vivid, D.named].every((id) => listedD.has(id)));
  check('raw.dreams: a chat\'s, a real person\'s, a heavy row or chain and a redacted one never are', [D.chat, D.subject, D.heavy, D.chain, D.redacted].filter(Boolean).every((id) => !listedD.has(id)));
  check('raw.thoughts: ids and times only', Array.isArray(rawP.thoughts) && rawP.thoughts.every((r) => Object.keys(r).sort().join() === 'at,id'));
  const thoughtText = lifeP.publicThoughts(rawP.thoughts.map((x) => x.id));
  const listedT = [...thoughtText.values()];
  check('raw.thoughts: his own are listed', listedT.includes('ugh, rain'));
  check('raw.thoughts: a chat\'s, a private or heavy session\'s, one resting on a chat, a heavy event or a missing one never are', !listedT.some((x) => /^THOUGHT/.test(x)), listedT);

  const venueStub = (x) => String(x).replace(/Bean Bar Northside/g, 'a bar');
  const calm = { ...structuredClone(rawP), heavyAt: [], now: { ...structuredClone(rawP.now), hardStretch: false } };
  const LIVE = { startAt: t - 1800, until: t + 1800, placeId: 'place:cafe', castIds: [A.id], phase: 'main', line: 'talking about their work lately', beats: [
    { at: t - 900, text: 'talking about their work lately' }, { at: t - 600, text: 'a text from Priya Raman; he left it' }, { at: t - 300, text: 'his phone buzzed' }] };
  const MIND = [
    { topic: 'place:cafe', label: 'a cafe', kind: 'interest', value: 0.81, trend: 'up', why: 'it went well', since: t - 86400 },
    { topic: 'kind:gym', label: 'gym', kind: 'interest', value: 0.2, trend: 'flat', why: 'time spent on it', since: t - 86400 },
    { topic: 'fixed:work', label: 'work', kind: 'opinion', value: -0.42, trend: 'down', why: 'a crunch at work', since: t - 86400 },
    { topic: 'cast:someone', label: 'Coworker', kind: 'opinion', value: 0.9, trend: 'up', why: 'it went well', since: t },
    { topic: 'kind:x', label: 'lunch with Priya Raman', kind: 'interest', value: 0.9, trend: 'up', why: 'it went well', since: t },
    { topic: 'kind:y', label: 'y', kind: 'interest', value: 0.9, trend: 'up', why: 'with Priya Raman', since: t },
    { topic: 'kind:z', label: 'z', kind: 'interest', value: 0.9, trend: 'up', why: 'it went well', since: t, subjectJid: P1 },
  ];
  const B = castNow.find((c) => c.id !== A.id);
  const STANDING = [
    { castId: A.id, text: 42, validFrom: t },
    { castId: A.id, text: 'STANDINGNOTIME', validFrom: Number.NaN },
    { castId: A.id, text: 'They have been meeting at Bean Bar Northside most weeks, and it is easy between them.', validFrom: t - 3 * 86400 },
    { castId: A.id, text: 'STANDINGDUPLICATE', validFrom: t - 86400 },
    { castId: B.id, text: 'Things cooled after he backed out twice.', validFrom: t - 2 * 86400 },
    { castId: 'cast:not-in-his-life', text: 'STANDINGNOTCAST', validFrom: t },
    { castId: P1, text: 'STANDINGREALPERSON', validFrom: t },
    { text: 'STANDINGNOID', validFrom: t },
  ];
  let live = LIVE;
  let mind = MIND;
  let standing = STANDING;
  const useDeps = (raw) => pub.__setDepsForTest({
    publicRaw: () => structuredClone(raw), venueWords: venueStub, publicLive: () => { if (live === 'throw') throw new Error('read'); return live; },
    publicThoughts: (ids2) => lifeP.publicThoughts(ids2),
    publicDreams: (ids2) => new Map(ids2.filter((id) => typeof DW[id] === 'string').map((id) => [id, words(id)])),
    publicMind: () => { if (mind === 'throw') throw new Error('read'); return mind; },
    publicStanding: () => { if (standing === 'throw') throw new Error('read'); return standing; },
  });
  const exportDoc = async (raw = calm) => { useDeps(raw); clock.advance?.(60); const r = await pub.exportNow({ force: true }); return { r, body: puts.at(-1).body, d: JSON.parse(puts.at(-1).body) }; };

  const { r: r15, body, d } = await exportDoc();
  check('the export with all four goes out', r15.status === 'ok' || r15.status === 'unchanged', r15);
  eq('v stays 1, each key with its own number', [d.v, d.liveSchema, d.thoughtsSchema, d.dreamsSchema, d.mindSchema, d.standingSchema], [1, 1, 1, 1, 1, 1]);

  const castPub = new Set(d.people.cast.map((c) => c.id));
  const placePub = new Set(d.city.places.map((p) => p.id));
  check('live: fictional cast, a real place, a phase, a code-built line', d.live.with.length === 1 && castPub.has(d.live.with[0]) && placePub.has(d.live.placeId) && d.live.phase === 'main' && d.live.line === 'talking about their work lately', d.live);
  eq('live: the beat that names a real person is dropped, the rest kept', d.live.beats.map((b) => b.text), ['talking about their work lately', 'his phone buzzed']);

  check('thoughts: his own, the kind is stream', d.thoughts.some((x) => x.text === 'ugh, rain') && d.thoughts.every((x) => x.kind === 'stream' && /^t_[0-9a-f]{10}$/.test(x.id)));
  check('thoughts: newest first, ≤ 40', d.thoughts.length <= 40 && d.thoughts.every((x, i) => i === 0 || x.at <= d.thoughts[i - 1].at));
  check('thoughts: a venue name becomes its kind word', d.thoughts.some((x) => x.text === 'that coffee at a bar'));
  check('thoughts: one naming a real person is dropped', !d.thoughts.some((x) => /lunch with/.test(x.text)));
  check('thoughts: never what drove them', !body.includes('drove') && d.thoughts.every((x) => Object.keys(x).sort().join() === 'at,id,kind,text'));

  const dr = d.dreams;
  eq('dreams: a fragment and a vivid one, nothing else (a name, a departed member, too long, no words)', dr.map((x) => [x.recall, x.tone]).sort(), [['fragment', 'neutral'], ['vivid', 'nightmare']]);
  check('dreams: a venue name becomes its kind word', dr.some((x) => x.text.includes('at a bar')) && !body.includes('Bean Bar'));
  check('dreams: cast and places of this document, home never', dr.every((x) => x.with.every((c) => castPub.has(c)) && x.placeIds.every((p) => placePub.has(p))) && dr[0].placeIds.length === 1);
  check('dreams: salted dr_ ids, a night', dr.every((x) => /^dr_[0-9a-f]{10}$/.test(x.id) && x.night === '2026-10-30'));

  eq('mind: interests strongest first, no cast, nothing a real person shaped, no real name', d.mind.interests.map((x) => x.topic), ['a cafe', 'gym']);
  eq('mind: opinions', d.mind.opinions.map((x) => [x.topic, x.stance, x.trend]), [['work', -0.42, 'down']]);
  eq('mind: flat reads as steady', d.mind.interests[1].trend, 'steady');
  check('mind: the code-built why', d.mind.interests[0].why === 'it went well');

  const pubOf = (c) => d.people.cast.find((x) => x.name === c.name)?.id;
  eq('standing: one row per member of this document, no name, venue words; malformed, a duplicate, someone not in his cast and a real person dropped',
    d.standing.people.map((r) => [r.id, r.text, r.since]),
    [[pubOf(A), 'They have been meeting at a bar most weeks, and it is easy between them.', t - 3 * 86400], [pubOf(B), 'Things cooled after he backed out twice.', t - 2 * 86400]]);
  check('standing: every row is id, text, since', d.standing.people.every((r) => Object.keys(r).sort().join() === 'id,since,text'));

  const forbidden = ['STANDINGNOTIME', 'STANDINGDUPLICATE', 'STANDINGNOTCAST', 'STANDINGREALPERSON', 'STANDINGNOID', 'Priya', 'Raman', G.split('@')[0], '@g.us', '@lid', P1.split('@')[0], 'DREAMCHATTEXT', 'DREAMSUBJECTTEXT', 'DREAMHEAVYTEXT', 'DREAMCHAINTEXT', 'DREAMREDACTEDTEXT', 'DREAMDEPARTEDTEXT', 'THOUGHTCHATTEXT', 'THOUGHTWORDLESSTEXT', 'THOUGHTCHATEVIDENCE', 'THOUGHTHEAVYEVIDENCE', 'THOUGHTGONEEVIDENCE', 'cast:', 'place:'];
  eq('canary: nothing private in any of the five', forbidden.filter((f) => body.includes(f)), []);

  // A sample for the site (public-site builds its views against it).
  if (process.env.FEED_SAMPLE) {
    const used = new Set([...d.live.with, ...d.dreams.flatMap((x) => x.with), ...d.standing.people.map((x) => x.id)]);
    fs.writeFileSync(process.env.FEED_SAMPLE, JSON.stringify({ v: d.v, people: { cast: d.people.cast.filter((c) => used.has(c.id)) }, live: d.live, liveSchema: d.liveSchema, thoughts: d.thoughts, thoughtsSchema: d.thoughtsSchema, dreams: d.dreams, dreamsSchema: d.dreamsSchema, mind: d.mind, mindSchema: d.mindSchema, standing: d.standing, standingSchema: d.standingSchema }, null, 2));
  }

  section('15b. live: the cases that say less');
  live = null;
  const none = (await exportDoc()).d;
  check('not out with anyone: live is null, its number beside it', none.live === null && none.liveSchema === 1);
  live = { private: true };
  const priv = await exportDoc();
  eq('a private session: "out", and nothing more', { ...priv.d.live, at: 0 }, { at: 0, startAt: null, until: null, placeId: null, with: [], phase: null, line: 'out', beats: [] });
  live = { ...LIVE, castIds: ['cast:not-in-his-life'] };
  eq('someone not in his cast: null', (await exportDoc()).d.live, null);
  live = { ...LIVE, castIds: [] };
  eq('no one with him: null', (await exportDoc()).d.live, null);
  live = { ...LIVE, line: 'lunch with Priya Raman' };
  eq('a line the scrubber refuses: null, the document goes out', (await exportDoc()).d.live, null);
  live = { ...LIVE, line: 'out' };
  eq('a real line can\'t pass as the private word', (await exportDoc()).d.live, null);
  live = { ...LIVE, placeId: world.self?.homePlaceId ?? 'place:home' };
  eq('at his place: no place id', (await exportDoc()).d.live.placeId, null);
  live = 'throw';
  check('a failed read: no live key, the export goes on', !('live' in (await exportDoc()).d));
  live = LIVE;
  mind = 'throw';
  check('a failed read: no mind key, the export goes on', !('mind' in (await exportDoc()).d));
  mind = null;
  check('no mind to ask: no mind key', !('mind' in (await exportDoc()).d));
  mind = [];
  check('nothing to say: no mind key', !('mind' in (await exportDoc()).d));
  mind = MIND;

  section('15b2. standing: the cases that say less');
  standing = undefined;
  check('no standing to ask: no standing key', !('standing' in (await exportDoc()).d));
  standing = 'throw';
  const st = await exportDoc();
  check('a failed read: no standing key, the export goes on', (st.r.status === 'ok' || st.r.status === 'unchanged') && !('standing' in st.d) && !('standingSchema' in st.d));
  standing = [];
  check('nothing to say: no standing key', !('standing' in (await exportDoc()).d));
  standing = [{ castId: A.id, text: 'Lunch with Priya Raman again, and she was fine.', validFrom: t }];
  const sr = await exportDoc();
  check('a note naming a real person: dropped, no key, never in the document', !('standing' in sr.d) && !sr.body.includes('Priya'));
  standing = [{ castId: A.id, text: 'Not much since the move.', validFrom: t }, { castId: B.id, text: 'STANDINGNEARHEAVY', validFrom: t - 39 * 86400 }];
  const sh = await exportDoc({ ...structuredClone(calm), heavyAt: [t - 40 * 86400] });
  eq('a note written near a heavy onset is dropped, the rest kept', sh.d.standing?.people.map((r) => r.text), ['Not much since the move.']);
  standing = STANDING;

  section('15c. a heavy window: nothing');
  const hard = { ...structuredClone(rawP), heavyAt: [], now: { ...structuredClone(rawP.now), hardStretch: true } };
  const dh = (await exportDoc(hard)).d;
  check('a hard stretch: no live, no thoughts, no dreams, no mind, no standing', dh.live === null && dh.thoughts.length === 0 && dh.dreams.length === 0 && !('mind' in dh) && !('standing' in dh), [dh.live, dh.thoughts?.length, dh.dreams?.length]);
  const onset = { ...structuredClone(calm), heavyAt: [t - 86400] };   // the rows below all fall within a day of it
  const dn = (await exportDoc(onset)).d;
  check('near an onset: the same', dn.live === null && dn.thoughts.length === 0 && dn.dreams.length === 0 && !('mind' in dn) && !('standing' in dn));
  live = { private: true };
  eq('…a private session too', (await exportDoc(hard)).d.live, null);
  live = LIVE;

  section('15d. malformed output is refused');
  const vs = mk({ knownNames: ['Priya Raman'], allowNames: ['Kiran', ...castNow.map((c) => c.name)] });
  const bad = (mut) => { const x = structuredClone(d); mut(x); return validate(x, vs); };
  check('the good document validates', validate(d, vs).ok, validate(d, vs).errors);
  const refuse = (what, mut, re) => { const v = bad(mut); check(what, !v.ok && (!re || v.errors.some((e) => re.test(e))), v.errors); };
  refuse('liveSchema without live', (x) => { delete x.live; }, /liveSchema:without_live/);
  refuse('thoughts without its number', (x) => { delete x.thoughtsSchema; }, /thoughtsSchema:without_thoughts/);
  refuse('dreamsSchema 2', (x) => { x.dreamsSchema = 2; });
  refuse('v 2', (x) => { x.v = 2; });
  refuse('an extra key on live', (x) => { x.live.jid = 'x'; }, /live\.jid:unknown_key/);
  refuse('live with someone not in the document', (x) => { x.live.with = ['c_0123456789']; }, /live\.with\[0\]:not_cast/);
  refuse('live with no one', (x) => { x.live.with = []; }, /live\.with:empty/);
  refuse('live with too many', (x) => { x.live.with = Array(5).fill(x.live.with[0]); });
  refuse('live at a place not in the document', (x) => { x.live.placeId = 'p_0123456789'; }, /live\.placeId:not_place/);
  refuse('a bad phase', (x) => { x.live.phase = 'dancing'; });
  refuse('a long line', (x) => { x.live.line = 'x'.repeat(161); });
  refuse('a live line naming a real person', (x) => { x.live.line = 'lunch with Priya Raman'; }, /real_name/);
  refuse('too many beats', (x) => { x.live.beats = Array(7).fill(x.live.beats[0]); });
  refuse('beats out of order', (x) => { x.live.beats = [...x.live.beats].reverse(); }, /live\.beats:order/);
  refuse('a private line with a place', (x) => { x.live = { ...x.live, line: 'out', startAt: null, until: null, phase: null, with: [], beats: [] }; }, /private_has_more/);
  refuse('a private line with someone', (x) => { x.live = { ...x.live, line: 'out', placeId: null, startAt: null, until: null, phase: null, beats: [] }; }, /private_has_more/);
  refuse('a private line with its time', (x) => { x.live = { ...x.live, line: 'out', placeId: null, until: null, phase: null, with: [], beats: [] }; }, /private_has_more/);
  refuse('a thought with a drove field', (x) => { x.thoughts[0].drove = 'x'; }, /drove:unknown_key/);
  refuse('a thought of another kind (real is F3)', (x) => { x.thoughts[0].kind = 'real'; });
  refuse('a long thought', (x) => { x.thoughts[0].text = 'x'.repeat(81); });
  refuse('41 thoughts', (x) => { x.thoughts = Array.from({ length: 41 }, () => x.thoughts[0]); });
  refuse('a thought naming a real person', (x) => { x.thoughts[0].text = 'lunch with Priya Raman'; }, /real_name/);
  refuse('duplicate thought ids', (x) => { x.thoughts = [x.thoughts[0], x.thoughts[0]]; }, /duplicate/);
  refuse('a dream of another tone', (x) => { x.dreams[0].tone = 'good'; });
  refuse('a fragment too long', (x) => { const f = x.dreams.find((y) => y.recall === 'fragment'); f.text = 'x'.repeat(161); }, /fragment_too_long/);
  refuse('a dream with someone not in the document', (x) => { x.dreams[0].with = ['c_0123456789']; }, /not_cast/);
  refuse('a dream at a place not in the document', (x) => { x.dreams[0].placeIds = ['p_0123456789']; }, /not_place/);
  refuse('15 dreams', (x) => { x.dreams = Array.from({ length: 15 }, () => x.dreams[0]); });
  refuse('a mind value out of range', (x) => { x.mind.interests[0].value = 1.5; });
  refuse('an opinion out of range', (x) => { x.mind.opinions[0].stance = -1.5; });
  refuse('a bad trend', (x) => { x.mind.interests[0].trend = 'flat'; });
  refuse('13 interests', (x) => { x.mind.interests = Array(13).fill(x.mind.interests[0]); });
  refuse('a why naming a real person', (x) => { x.mind.interests[0].why = 'lunch with Priya Raman'; }, /real_name/);
  refuse('an extra key on an interest', (x) => { x.mind.interests[0].origin = 'self'; }, /origin:unknown_key/);
  refuse('standing without its number', (x) => { delete x.standingSchema; }, /standingSchema:without_standing/);
  refuse('standingSchema 2', (x) => { x.standingSchema = 2; });
  refuse('a standing row for someone not in the document', (x) => { x.standing.people[0].id = 'c_0123456789'; }, /standing\.people\[0\]\.id:not_cast/);
  refuse('two standing rows for one member', (x) => { x.standing.people[1].id = x.standing.people[0].id; }, /duplicate/);
  refuse('a standing row with a name', (x) => { x.standing.people[0].name = 'x'; }, /name:unknown_key/);
  refuse('a long standing note', (x) => { x.standing.people[0].text = 'x'.repeat(601); });
  refuse('41 standing rows', (x) => { x.standing.people = Array(41).fill(x.standing.people[0]); });
  refuse('a standing note naming a real person', (x) => { x.standing.people[0].text = 'lunch with Priya Raman'; }, /real_name/);

  pub.__setDepsForTest({ publicRaw: (o) => lifeP.publicRaw(o), publicLive: () => lifeP.publicLive(), publicThoughts: (x) => lifeP.publicThoughts(x), publicDreams: (x) => lifeP.publicDreams(x), publicMind: () => lifeP.publicMind(), publicStanding: () => lifeP.publicStanding(), venueWords: (x) => lifeP.venueKindWords(x) });
}
// ── 16. a real name's lone word ───────────────────────────────────────────────
section('16. a real name\'s every word: dropped where free text holds it, soft where code built it');
{
  const lifeT = await import('../src/life/index.js');
  const { build } = await import('../src/public/build.js');
  const sc = makeScrubber({ knownNames: ['Priya Raman', 'Rahul Varnell', 'K Ann'], allowNames: ['Karyasthan'] });
  const raw = structuredClone(lifeT.publicRaw({ days: 14 }));
  const c0 = raw.cast?.[0];
  check('(setup) a cast member to plant in', !!c0);
  if (c0) c0.status = 'went for a run with Varnell';
  const d = build({ raw, persona: { name: 'Karyasthan' }, scrubber: sc, salt: 't'.repeat(32) });
  const v = validate(d, sc);
  check('the export still validates', v.ok, v.errors);
  check('the status holding a real surname is dropped', !JSON.stringify(d).includes('Varnell'));
  const coded = structuredClone(d);
  const row = coded.today?.rows?.[0] ?? coded.days?.flatMap((x) => x.rows ?? [])[0];
  if (row) row.label = 'Lunch with Ann';
  const vc = validate(coded, sc);
  check('a lone word in a code-built string is soft: listed, never a failed export', !row || (vc.ok && vc.soft.some((x) => /real_name_token/.test(x))), JSON.stringify(vc).slice(0, 300));
  if (row) row.label = 'Lunch with Rahul Varnell';
  check('a whole real name still fails it', !row || !validate(coded, sc).ok);
}

fs.rmSync(outDir, { recursive: true, force: true });
await life.stopLife();
report();
