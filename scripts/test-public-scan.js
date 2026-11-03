// Offline: scripts/public-scan.js on a scratch repo with invented sources. Hits by label, nothing
// that matched is ever printed, ranges and pre-push see what the tree no longer has, and every way
// it can't check is an error. Exits non-zero if a check fails.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'scripts/public-scan.js');
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  if (!ok) failures += 1;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-scan-'));
const repo = path.join(dir, 'repo');
const sources = path.join(dir, 'sources');
const words = path.join(dir, 'words.txt');
fs.mkdirSync(repo);
fs.mkdirSync(sources);

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', repo, ...args], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
function commit(files, message = 'a change') {
  for (const [p, text] of Object.entries(files)) {
    const f = path.join(repo, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (text === null) fs.rmSync(f);
    else fs.writeFileSync(f, text);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}
function scan(args = [], { input, src = sources, wordsFile = words } = {}) {
  const r = spawnSync(process.execPath, [SCAN, '--repo', repo, '--sources', src, '--words', wordsFile, ...args], { encoding: 'utf-8', input });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Everything secret here is invented, and each is checked to stay out of the output. Those with a
// shape are put together here, or this file would be a hit when the scan reads this repo.
const PERSON = 'Zorbalina';
const PLACE = 'Quindarrow';
const REGION = 'Vexshire';
const EMPLOYER = 'Halcyonix';
const STORY_LINE = 'once fixed the boiler with a spoon at dawn';
const PRIVATE = 'Trelawnyx Moor';
const KEY = `sk-ant-${'a1B2'.repeat(10)}`;
const GOOGLE_KEY = `AIza${'x9Y8'.repeat(9)}`;
const EMAIL = ['someone.real', 'mailhost.net'].join('@');
const TAILSCALE = ['100', '101', '102', '103'].join('.');
const LAN = ['192', '168', '29', '140'].join('.');
const PUBLIC_IP = ['81', '2', '69', '160'].join('.');
const IPV6 = ['2a00', '1450', '4001', '81b', '', '200e'].join(':');
const PHONE = ['99', '7123', '456782'].join('');
const SPACED_PHONE = ['+99', '71234', '56782'].join(' ');
const HOME = ['', 'home', 'realuser'].join('/');
const R2 = `${'ab12'.repeat(8)}.r2.cloudflarestorage.com`;
const SECRETS = [PERSON, PLACE, REGION, EMPLOYER, STORY_LINE, PRIVATE, KEY, GOOGLE_KEY, EMAIL, TAILSCALE, LAN, PUBLIC_IP, IPV6, PHONE, SPACED_PHONE, HOME, R2, '48.123', '11.987'];
const leaks = (out) => SECRETS.filter(s => out.toLowerCase().includes(s.toLowerCase()));

fs.writeFileSync(path.join(sources, 'persona.json'), JSON.stringify({ name: PERSON, aliases: [PERSON.toLowerCase()], region: `Port ${REGION}`, language: 'Klingon', vibe: 'dry' }));
fs.writeFileSync(path.join(sources, 'world.json'), JSON.stringify({
  self: { job: { employerName: EMPLOYER } },
  places: [{ name: `${PLACE} Cafe`, lat: 48.1234, lon: 11.9876 }, { name: 'Cafe', lat: 0.01, lon: 0.02 }, { name: 'Green Corner Cafe', lat: 0.03, lon: 0.04 }],
  cast: [{ name: 'Mo', history: [STORY_LINE, 'short line'] }],
}));
fs.writeFileSync(path.join(sources, 'arcs.json'), JSON.stringify({ career: { employers: [{ name: 'Example Co' }] } }));
fs.writeFileSync(words, `# a comment\n${PRIVATE}\n`);

git('init', '-q', '-b', 'main');
commit({
  'package.json': JSON.stringify({ name: 'scratchproject', author: 'x' }),
  'src/app.js': [
    "// a plain file with a cafe, Klingon and the scratchproject",
    "const jid = '15550001111@s.whatsapp.net', group = '120363000000000301@g.us', lid = '111122223333444@lid';",
    "const when = 1793300000, ms = 1793300000123, cgnat = '100.64.0.0/10', fake = '+1 555 000 1234', count = 1234567890;",
    "const local = ['127.0.0.1', '::1', '::', '192.0.2.7', '198.51.100.7', '203.0.113.7', '2001:db8::7', 'a::before', '12:30:45'];",
    "const mail = 'noreply@example.com', home = '/home/user', re = /home/i.test('x'), slash = 'career/home/departure';",
    'const short = "Mo";',
  ].join('\n'),
  'package-lock.json': `{"integrity":"${KEY}"}`,
  'src/vendor/lib.js': `// ${EMAIL}`,
  'logo.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(KEY)]),
}, 'the start');
const start = git('rev-parse', 'HEAD');

console.log('clean');
{
  const r = scan(['HEAD']);
  check('a clean tree exits 0', r.code === 0 && /✓ clean/.test(r.out), r);
  check('it says which sources it read', /words from: persona, world, arcs/.test(r.out), r.out);
  check('the short word, the language, ids, timestamps, the lockfile, vendored code and a binary pass', !/name|phone|email|api-key|ip-address|home-path/.test(r.out.split('✓')[0]), r.out);
}

console.log('each hit by its label; nothing that matched is printed');
for (const [label, text, want] of [
  ['a persona name', `hello ${PERSON}!`, 'name'],
  ['a name in another case', `hello ${PERSON.toUpperCase()}`, 'name'],
  ['a place word', `at ${PLACE}`, 'name'],
  ['a phrase of generic words is not a name', null, null],
  ['a region word', `from ${REGION}`, 'name'],
  ['an employer', `works at ${EMPLOYER}`, 'name'],
  ['a line of the story', `it said ${STORY_LINE} once`, 'story'],
  ['a private word', `the ${PRIVATE} thing`, 'private-word'],
  ['a latitude', 'const lat = 48.123;', 'coordinate'],
  ['a longitude, more digits', 'const lon = 11.98765;', 'coordinate'],
  ['an API key', `const k = '${KEY}';`, 'api-key'],
  ['a Google key', `const k = '${GOOGLE_KEY}';`, 'api-key'],
  ['an email', `mail ${EMAIL}`, 'email'],
  ['a Tailscale address', `bind = ${TAILSCALE}:5060`, 'ip-address'],
  ['a home network address', `host = ${LAN}`, 'ip-address'],
  ['a public address', `server ${PUBLIC_IP}/32`, 'ip-address'],
  ['an IPv6 address', `server [${IPV6}]:443`, 'ip-address'],
  ['a phone', `call ${PHONE}`, 'phone'],
  ['a phone as a JID', `'${PHONE}@s.whatsapp.net'`, 'phone'],
  ['a spaced phone', `call ${SPACED_PHONE} now`, 'phone'],
  ['a home path', `read ${HOME}/project/x`, 'home-path'],
  ['an R2 account', `https://${R2}`, 'r2-account'],
]) {
  if (text === null) {
    commit({ 'src/hit.js': 'at the Green Corner Cafe' }, 'generic');
    check(label, scan(['HEAD']).code === 0, scan(['HEAD']));
    continue;
  }
  commit({ 'src/hit.js': text }, 'a hit');
  const r = scan(['HEAD']);
  check(`${label} → exit 1, ${want}`, r.code === 1 && new RegExp(`^${want}\\s+src/hit\\.js\\s+\\d+(?:\\s+from .*)?$`, 'm').test(r.out), r);
  check(`${label}: not in the output`, leaks(r.out).length === 0, leaks(r.out));
}
commit({ 'src/hit.js': null }, 'gone');

console.log('a part of a word is not a hit');
{
  commit({ 'src/near.js': `const a = 'x${PERSON}'; const b = '${PERSON}s'; const c = 148.123;` }, 'near');
  check('embedded words and a longer number pass', scan(['HEAD']).code === 0, scan(['HEAD']));
  commit({ 'src/near.js': null }, 'gone');
}

console.log('a path');
{
  commit({ [`src/${PERSON}.js`]: 'nothing here' }, 'a name in a path');
  const r = scan(['HEAD']);
  check('a name in a path is a hit', r.code === 1 && /name \(in a path\)/.test(r.out), r);
  check('and the path is not printed', leaks(r.out).length === 0, leaks(r.out));
  commit({ [`src/${PERSON}.js`]: null }, 'gone');
}

console.log('the private-words file');
{
  commit({ 'src/x.js': `hello ${PERSON}` }, 'x');
  fs.writeFileSync(words, `${PRIVATE}\n!${PERSON}\n`);
  check('"!word" says a source word is ordinary here', scan(['HEAD']).code === 0, scan(['HEAD']));
  fs.writeFileSync(words, `${PRIVATE}\n`);
  commit({ 'src/x.js': null }, 'gone');
  const noFile = scan(['HEAD'], { wordsFile: path.join(dir, 'nope.txt') });
  check('no private-words file is fine', noFile.code === 0, noFile);
}

console.log('a range sees what the tree no longer has');
{
  const before = git('rev-parse', 'HEAD');
  commit({ 'src/secret.js': `k = '${KEY}'` }, 'added');
  const after = commit({ 'src/secret.js': null }, 'removed');
  check('the tree at HEAD is clean', scan([after]).code === 0, scan([after]));
  const r = scan([`${before}..${after}`]);
  check('the range finds the removed blob', r.code === 1 && /^api-key\s+src\/secret\.js/m.test(r.out), r);
  check('not in the output', leaks(r.out).length === 0, leaks(r.out));
  check('--all finds it too', /^api-key\s+src\/secret\.js/m.test(scan(['--all']).out));
  const m1 = git('rev-parse', 'HEAD');
  const m2 = commit({}, `the fix for ${PERSON}, thanks ${EMAIL}`);
  const msg = scan([`${m1}..${m2}`]);
  check('a commit message is checked', msg.code === 1 && /^name\s+commit message /m.test(msg.out) && /^email\s+commit message /m.test(msg.out), msg);
  check('not in the output', leaks(msg.out).length === 0, leaks(msg.out));
  check('an author identity is a note, not a hit', /author\/committer email/.test(msg.out) && !msg.out.includes('test@example.com'), msg.out);
}

console.log('pre-push');
{
  const zero = '0'.repeat(40);
  const clean1 = git('rev-parse', 'HEAD');
  const clean2 = commit({ 'src/ok.js': 'fine' }, 'fine');
  const line = (local, remote) => `refs/heads/main ${local} refs/heads/main ${remote}\n`;
  check('a clean update passes', scan(['--pre-push'], { input: line(clean2, clean1) }).code === 0, scan(['--pre-push'], { input: line(clean2, clean1) }));
  check('a deleted ref adds nothing', scan(['--pre-push'], { input: `(delete) ${zero} refs/heads/x ${clean2}\n` }).code === 0);
  check('nothing to push adds nothing', scan(['--pre-push'], { input: '' }).code === 0);
  const bad = commit({ 'src/bad.js': `mail ${EMAIL}` }, 'bad');
  const up = scan(['--pre-push'], { input: line(bad, clean2) });
  check('a hit in the push fails it', up.code === 1 && /^email\s+src\/bad\.js/m.test(up.out), up);
  const fresh = scan(['--pre-push'], { input: line(bad, zero) });
  check('a new branch: everything no remote has', fresh.code === 1 && /^email\s+src\/bad\.js/m.test(fresh.out), fresh);
  check('not in the output', leaks(up.out + fresh.out).length === 0, leaks(up.out));
  commit({ 'src/bad.js': null }, 'gone');
}

console.log('--db: a real migrated schema, opened read only');
{
  // Inside the project: src/memory/db.js refuses a path outside it.
  const dbFile = path.join(ROOT, 'data', `test-public-scan-${process.pid}.db`);
  process.env.DB_PATH = dbFile;
  process.env.LOG_LEVEL = 'silent';
  const { runMigrations, getDb, closeDb } = await import('../src/memory/db.js');
  runMigrations();
  const db = getDb();
  const CONTACT = 'Oswinelda Prunk';
  const NICK = 'Bramblethorn';
  const SENDER = 'Fenwickstaff';
  const GROUP = 'The Weekend Quokkas';
  const CAST = 'Ignatia Velloway';
  const pn = ['99', '7123', '456781'].join('');
  const lid = ['7031', '5551', '9988', '227'].join('');
  const gid = ['1203', '6301', '1122', '2334', '4'].join('');
  const spaced = ['+99', '71234', '56781'].join(' ');
  const MSG = 'did you see the lanterns over the old quarry last night';
  const MULTI = 'first short line\nthis second line is the long private one here';
  const STORY = 'they argued about the blue kettle until it got light out';
  const MEMORY = 'keeps a spare key under the third flowerpot on the left';
  db.prepare('INSERT INTO people (jid, phone, push_name, real_name) VALUES (?, ?, ?, ?)').run(`${pn}@s.whatsapp.net`, pn, SENDER, CONTACT);
  db.prepare("INSERT INTO person_identities (jid, person_jid, kind) VALUES (?, ?, 'lid')").run(`${lid}@lid`, `${pn}@s.whatsapp.net`);
  db.prepare('INSERT INTO groups (jid, name) VALUES (?, ?)').run(`${gid}@g.us`, GROUP);
  db.prepare("INSERT INTO nicknames (person_jid, nickname, origin_kind, origin_jid) VALUES (?, ?, 'group', ?)").run(`${pn}@s.whatsapp.net`, NICK, `${gid}@g.us`);
  const insertMsg = db.prepare("INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, timestamp) VALUES (?, ?, ?, ?, ?, 1793300000)");
  insertMsg.run('m1', `${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER, MSG);
  insertMsg.run('m2', `${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER, MULTI);
  insertMsg.run('m3', `${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER, 'short one');
  const BOT_LINE = 'send me a thirty second voice note reading this out';
  const BOT_JID = '10000000000999@s.whatsapp.net';
  db.prepare("INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, is_from_self, timestamp) VALUES ('m4', ?, ?, 'Bot', ?, 1, 1793300000)").run(`${gid}@g.us`, `10000000000999:5@s.whatsapp.net`, BOT_LINE);
  db.prepare("INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, quoted_content, quoted_participant, timestamp) VALUES ('m5', ?, ?, ?, 'ok', ?, ?, 1793300000)").run(`${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER, BOT_LINE, BOT_JID);
  const QUOTED = 'the person who wrote this one is quoted by another';
  db.prepare("INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, quoted_content, quoted_participant, timestamp) VALUES ('m6', ?, ?, ?, 'ok', ?, ?, 1793300000)").run(`${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER, QUOTED, `${lid}@lid`);
  const ins = db.prepare('INSERT INTO messages (id, group_jid, sender_jid, sender_name, content, quoted_content, message_type, is_from_self, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1793300000)');
  const person = [`${gid}@g.us`, `${pn}@s.whatsapp.net`, SENDER];
  const TEMPLATE = 'try again from the top when you are ready to start';
  const PLACEHOLDER = '[a placeholder standing in for a recording]';
  const TYPED = '[someone typed this whole line inside brackets]';
  const ECHO = 'the bot said this and a person also wrote it down';
  const TWICE = 'this very same line was written in two separate rows';
  ins.run('n1', `${gid}@g.us`, BOT_JID, 'Bot', TEMPLATE, null, 'text', 1);
  ins.run('n2', ...person, 'ok', TEMPLATE, 'text', 0);   // quoted, with no author on the quote
  ins.run('n3', ...person, PLACEHOLDER, null, 'audio', 0);
  ins.run('n4', ...person, TYPED, null, 'text', 0);
  ins.run('n5', `${gid}@g.us`, BOT_JID, 'Bot', ECHO, null, 'text', 1);
  ins.run('n6', ...person, ECHO, null, 'text', 0);
  ins.run('n7', ...person, TWICE, null, 'text', 0);
  ins.run('n8', ...person, TWICE, null, 'text', 0);
  const rowOf = (id) => db.prepare('SELECT rowid AS r FROM messages WHERE id = ?').get(id).r;
  const TWICE_A = rowOf('n7');
  const TWICE_B = rowOf('n8');
  db.prepare("INSERT INTO story_messages (cast_id, dir, status, trigger, due_at, created_at, text) VALUES ('cast:x', 'out', 'live', 'owner', 1, 1, ?)").run(STORY);
  db.prepare("INSERT INTO memories (category, content, origin_kind, origin_jid) VALUES ('fact', ?, 'group', ?)").run(MEMORY, `${gid}@g.us`);
  db.prepare("INSERT INTO world_events (at, recorded_at, type, actor, payload_json) VALUES (1, 1, 'cast.created', 'owner', ?)").run(JSON.stringify({ id: 'cast:v', name: CAST }));
  db.prepare("INSERT INTO world_events (at, recorded_at, type, actor, payload_json) VALUES (1, 1, 'place.created', 'owner', ?)").run(JSON.stringify({ id: 'place:v', name: 'Cafe', lat: 33.4567, lon: -44.5678 }));
  closeDb();
  const before = fs.readFileSync(dbFile);
  const DB_SECRETS = [TEMPLATE, TYPED, ECHO, TWICE, PLACEHOLDER, CONTACT, 'Oswinelda', 'Prunk', NICK, SENDER, GROUP, CAST, 'Ignatia', pn, lid, gid, spaced, MSG, STORY, MEMORY, 'second line', '33.45', '44.56', '2a00', 'lanterns', 'kettle', 'flowerpot'];
  const dbLeaks = (out) => DB_SECRETS.filter(s => out.toLowerCase().includes(s.toLowerCase()));
  const withDb = (args = ['HEAD']) => scan([...args, '--db', dbFile]);

  const clean = withDb();
  check('nothing of it in the tree: exit 0', clean.code === 0, clean);
  check('it says what it read, in counts', /^db: 1 contacts, 1 groups, \d+ ids, 6 message lines, 2 memory and story lines, 2 cast and places; 3 of the bot's own messages not read$/m.test(clean.out), clean.out);
  for (const [label, text, want, from] of [
    ['a contact\'s whole name', `by ${CONTACT} himself`, 'contact-name', 'people#'],
    ['one word of it, lower case', 'hello oswinelda', 'contact-name', 'people#'],
    ['a push name', `from ${SENDER}`, 'contact-name', 'people#'],
    ['a nickname', `call him ${NICK}`, 'contact-name', 'nicknames#'],
    ['a group name', `posted in "${GROUP}" today`, 'group-name', 'groups#'],
    ['a group name in another case and spacing', `the weekend   quokkas`, 'group-name', 'groups#'],
    ['a phone in a JID', `'${pn}@s.whatsapp.net'`, 'contact-id', 'people#'],
    ['a phone, bare', `n = ${pn};`, 'contact-id', 'people#'],
    ['a phone, spaced', `call ${spaced} now`, 'contact-id', 'people#'],
    ['a phone without its country code', `call ${pn.slice(2)} now`, 'contact-id', 'people#'],
    ['a LID', `lid: '${lid}@lid'`, 'contact-id', 'person_identities#'],
    ['a group JID', `jid: '${gid}@g.us'`, 'group-id', 'groups#'],
    ['a message line, whole', MSG, 'message-text', 'messages#'],
    ['a message line in a quoted string', `content: '${MSG}',`, 'message-text', 'messages#'],
    ['a message line in another case', MSG.toUpperCase(), 'message-text', 'messages#'],
    ['the long line of a message of two', '// this second line is the long private one here', 'message-text', 'messages#'],
    ['a person\'s line quoted by someone', QUOTED, 'message-text', 'messages#'],
    ['a typed line in brackets', TYPED, 'message-text', 'messages#'],
    ['a line both the bot and a person wrote', ECHO, 'message-text', 'messages#'],
    ['a story line', `"${STORY}"`, 'story-text', 'story_messages#'],
    ['a memory', `- ${MEMORY}`, 'memory-text', 'memories#'],
    ['a cast member from the log', `with ${CAST}`, 'story-name', 'world_events#'],
    ['a place\'s latitude from the log', 'lat: 33.456,', 'coordinate', 'world_events#'],
    ['a negative longitude from the log', 'lon: -44.56,', 'coordinate', 'world_events#'],
  ]) {
    commit({ 'src/hit.js': text }, 'a hit');
    const r = withDb();
    check(`${label} → ${want}, from ${from}N`, r.code === 1 && new RegExp(`^${want}\\s+src/hit\\.js\\s+\\d+\\s+from ${from}\\d+`, 'm').test(r.out), r);
    check(`${label}: not in the output`, dbLeaks(r.out).length === 0, dbLeaks(r.out));
  }
  commit({ 'src/hit.js': null }, 'gone');
  for (const [label, text] of [
    ['the bot\'s own line', `reply('${BOT_LINE}')`],
    ['a bot line quoted with no author on the quote', `reply('${TEMPLATE}')`],
    ['a media message that is only a placeholder', PLACEHOLDER],
    ['a line under 25 characters', 'short one'],
    ['a piece of a message line, not the line', 'the lanterns over the old quarry'],
    ['a line one word off', MSG.replace('lanterns', 'lamps')],
  ]) {
    commit({ 'src/near.js': text }, 'near');
    check(`${label} is no hit`, withDb().code === 0, withDb());
  }
  commit({ 'src/near.js': null }, 'gone');
  commit({ 'src/two.js': `by ${CONTACT} and ${GROUP}` }, 'two rows');
  const looked = withDb();
  check('it ends with the rows to look up, each once, and nothing of them', /^rows to look up: groups#\d+, people#\d+$/m.test(looked.out) && dbLeaks(looked.out).length === 0, looked.out);
  commit({ 'src/two.js': null }, 'gone');
  commit({}, `thanks ${CONTACT}: ${MSG}`);
  const msgHit = withDb([`${git('rev-parse', 'HEAD~1')}..HEAD`]);
  check('a commit message is checked against it', msgHit.code === 1 && /^contact-name\s+commit message/m.test(msgHit.out) && /^message-text\s+commit message/m.test(msgHit.out), msgHit);
  check('not in the output', dbLeaks(msgHit.out).length === 0, dbLeaks(msgHit.out));

  commit({ 'src/row.js': TWICE }, 'a line in two rows');
  fs.writeFileSync(words, `${PRIVATE}\n!row:messages#${TWICE_A}\n`);
  const oneOut = withDb();
  check('!row: the same line in another row still hits', oneOut.code === 1 && new RegExp(`^message-text\\s+src/row\\.js\\s+\\d+\\s+from messages#${TWICE_B}$`, 'm').test(oneOut.out) && /; 1 row\(s\) opted out$/m.test(oneOut.out), oneOut);
  fs.writeFileSync(words, `${PRIVATE}\n!row:messages#${TWICE_A}\n!row:messages#${TWICE_B}\n`);
  const bothOut = withDb();
  check('!row: both rows out, no hit, and it says how many', bothOut.code === 0 && /; 2 row\(s\) opted out$/m.test(bothOut.out), bothOut);
  commit({ 'src/row.js': null }, 'gone');
  fs.writeFileSync(words, `${PRIVATE}\n`);
  fs.writeFileSync(words, `${PRIVATE}\n!oswinelda\n`);
  commit({ 'src/x.js': 'hello oswinelda' }, 'x');
  check('"!word" works on a database name too', withDb().code === 0, withDb());
  fs.writeFileSync(words, `${PRIVATE}\n`);
  commit({ 'src/x.js': null }, 'gone');

  check('the database file is untouched', before.equals(fs.readFileSync(dbFile)));
  const noDb = scan(['HEAD', '--db', path.join(ROOT, 'data', 'no-such-file.db')]);
  check('no such database is exit 2', noDb.code === 2 && !fs.existsSync(path.join(ROOT, 'data', 'no-such-file.db')), noDb);
  const notOurs = path.join(dir, 'other.db');
  const { default: Database } = await import('better-sqlite3');
  const other = new Database(notOurs);
  other.exec('CREATE TABLE people (jid TEXT)');
  other.close();
  check('another database is exit 2', scan(['HEAD', '--db', notOurs]).code === 2);
  const emptyDb = path.join(ROOT, 'data', `test-public-scan-${process.pid}-empty.db`);
  const e = new Database(emptyDb);
  e.exec('CREATE TABLE people (jid TEXT, phone TEXT, push_name TEXT, real_name TEXT); CREATE TABLE person_identities (jid TEXT, person_jid TEXT); CREATE TABLE groups (jid TEXT, name TEXT); CREATE TABLE messages (sender_name TEXT, sender_jid TEXT, group_jid TEXT, content TEXT, quoted_content TEXT);');
  e.close();
  check('--strict: a database with nothing in it is exit 2', scan(['HEAD', '--strict', '--db', emptyDb]).code === 2);
  check('without --strict it says so in its counts', /^db: 0 contacts/m.test(scan(['HEAD', '--db', emptyDb]).out));
  for (const f of [dbFile, emptyDb]) for (const x of ['', '-shm', '-wal']) fs.rmSync(`${f}${x}`, { force: true });
}

console.log('what it can\'t check is an error');
{
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const noSources = scan(['HEAD'], { src: empty, wordsFile: path.join(dir, 'nope.txt') });
  check('no sources: a note, and shapes still run', noSources.code === 0 && /note: no persona, world, arcs/.test(noSources.out), noSources);
  check('--strict: no sources is exit 2', scan(['HEAD', '--strict'], { src: empty }).code === 2);
  check('a bad ref is exit 2', scan(['no-such-ref']).code === 2);
  check('an unknown flag is exit 2', scan(['--nope']).code === 2);
  fs.writeFileSync(path.join(sources, 'world.json'), `{ "name": "${PERSON}", broken`);
  const broken = scan(['HEAD']);
  check('an unreadable source is exit 2', broken.code === 2, broken);
  check('and doesn\'t quote it', leaks(broken.out).length === 0, leaks(broken.out));
}

console.log('the pre-push hook, on a real push');
{
  const hookRepo = path.join(dir, 'hook-repo');
  const bare = path.join(dir, 'remote.git');
  const g = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', hookRepo, ...args], { encoding: 'utf-8' });
  fs.mkdirSync(path.join(hookRepo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(hookRepo, 'src/personality'), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', bare]);
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(hookRepo, '.gitignore'), 'scripts/public-scan.js\nsrc/personality/\ndata/\n');
  fs.copyFileSync(SCAN, path.join(hookRepo, 'scripts/public-scan.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts/hooks/pre-push'), path.join(hookRepo, '.git/hooks/pre-push'));
  fs.chmodSync(path.join(hookRepo, '.git/hooks/pre-push'), 0o755);
  fs.writeFileSync(path.join(hookRepo, 'a.js'), 'plain');
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  const noSources = g('push', '-q', 'origin', 'main');
  check('no persona, world or arcs here: the push stops', noSources.status !== 0, noSources.stderr);
  for (const f of ['persona.json', 'arcs.json']) fs.copyFileSync(path.join(sources, f), path.join(hookRepo, 'src/personality', f));
  fs.writeFileSync(path.join(hookRepo, 'src/personality/world.json'), JSON.stringify({ places: [{ name: `${PLACE} Cafe`, lat: 48.1234, lon: 11.9876 }] }));
  const clean = g('push', '-q', 'origin', 'main');
  check('a clean push goes through', clean.status === 0, clean.stderr + clean.stdout);
  fs.writeFileSync(path.join(hookRepo, 'b.js'), `hello ${PERSON}`);
  g('add', '-A');
  g('commit', '-q', '-m', 'a name');
  const hit = g('push', '-q', 'origin', 'main');
  const out = `${hit.stdout}${hit.stderr}`;
  check('a hit stops the push', hit.status !== 0 && /^name\s+b\.js/m.test(out), out);
  check('and doesn\'t print it', !out.includes(PERSON), out);
  const remoteHas = spawnSync('git', ['-C', bare, 'log', '--oneline', 'main'], { encoding: 'utf-8' }).stdout.trim().split('\n').length;
  check('the remote never got it', remoteHas === 1, remoteHas);
  fs.rmSync(path.join(hookRepo, 'scripts/public-scan.js'));
  const noScript = g('push', '-q', 'origin', 'main');
  check('no scanner in the checkout: the push stops', noScript.status !== 0 && /nothing checked/.test(noScript.stderr), noScript.stderr);

  // A repo with no sources of its own (a clean public copy) names the install that has them.
  const home = path.join(ROOT, 'data', `test-public-scan-home-${process.pid}`);   // inside the project: --db finds better-sqlite3
  fs.mkdirSync(path.join(home, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(home, 'src/personality'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.copyFileSync(SCAN, path.join(home, 'scripts/public-scan.js'));
  for (const f of ['persona.json', 'arcs.json', 'world.json']) fs.copyFileSync(path.join(hookRepo, 'src/personality', f), path.join(home, 'src/personality', f));
  fs.writeFileSync(path.join(home, 'data/private-words.txt'), `${PRIVATE}\n`);
  const { default: HomeDb } = await import('better-sqlite3');
  const hdb = new HomeDb(path.join(home, 'data/karyasthan.db'));
  hdb.exec('CREATE TABLE people (jid TEXT, phone TEXT, push_name TEXT, real_name TEXT); CREATE TABLE person_identities (jid TEXT, person_jid TEXT); CREATE TABLE groups (jid TEXT, name TEXT); CREATE TABLE messages (sender_name TEXT, sender_jid TEXT, group_jid TEXT, content TEXT, quoted_content TEXT);');
  const HOME_CONTACT = 'Marzipella';
  const HOME_LINE = 'only the database of the install knows this line';
  hdb.prepare('INSERT INTO people VALUES (?, ?, ?, ?)').run('x@lid', null, HOME_CONTACT, null);
  hdb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(HOME_CONTACT, 'x@lid', 'x@lid', HOME_LINE, null);
  hdb.close();

  const clean2 = path.join(dir, 'clean-copy');
  const bare2 = path.join(dir, 'remote2.git');
  const c = (env, ...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', clean2, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } });
  fs.mkdirSync(clean2);
  spawnSync('git', ['init', '-q', '--bare', bare2]);
  c({}, 'init', '-q', '-b', 'main');
  c({}, 'remote', 'add', 'origin', bare2);
  fs.mkdirSync(path.join(clean2, '.git/hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/hooks/pre-push'), path.join(clean2, '.git/hooks/pre-push'));
  fs.chmodSync(path.join(clean2, '.git/hooks/pre-push'), 0o755);
  let nth = 0;
  const change = (text) => { nth += 1; fs.writeFileSync(path.join(clean2, `f${nth}.js`), text); c({}, 'add', '-A'); c({}, 'commit', '-q', '-m', 'a change'); };
  const push = (env = {}) => c(env, 'push', '-q', 'origin', 'main');
  const reset = () => c({}, 'reset', '-q', '--hard', 'HEAD~1');

  change('plain');
  check('a copy with no sources and no home: the push stops', push().status !== 0);
  check('a home that isn\'t there: the push stops', push({ PUBLIC_SCAN_HOME: path.join(dir, 'nowhere') }).status !== 0);
  const viaEnv = push({ PUBLIC_SCAN_HOME: home });
  check('PUBLIC_SCAN_HOME: a clean push goes through', viaEnv.status === 0, viaEnv.stderr + viaEnv.stdout);
  c({}, 'config', 'publicScan.home', home);
  change('still plain');
  const viaConfig = push();
  check('git config publicScan.home: a clean push goes through', viaConfig.status === 0, viaConfig.stderr + viaConfig.stdout);
  for (const [label, text, want] of [
    ['a word from the install\'s persona', `hello ${PERSON}`, 'name'],
    ['a private word', `the ${PRIVATE} thing`, 'private-word'],
    ['a contact from its database', `hello ${HOME_CONTACT}`, 'contact-name'],
    ['a message line from its database', HOME_LINE, 'message-text'],
  ]) {
    change(text);
    const r = push();
    const out2 = `${r.stdout}${r.stderr}`;
    check(`${label}: the push stops`, r.status !== 0 && new RegExp(`^${want}\\s`, 'm').test(out2), out2);
    check(`${label}: not printed`, ![PERSON, PRIVATE, HOME_CONTACT, HOME_LINE].some(s => out2.includes(s)), out2);
    reset();
  }
  change('plain again');
  const envWins = push({ PUBLIC_SCAN_HOME: path.join(dir, 'nowhere') });
  check('PUBLIC_SCAN_HOME wins over the config', envWins.status !== 0 && /nothing checked/.test(envWins.stderr), envWins.stderr);
  for (const [label, rel] of [['its database', 'data/karyasthan.db'], ['its private words', 'data/private-words.txt'], ['its world', 'src/personality/world.json'], ['its scanner', 'scripts/public-scan.js']]) {
    const f = path.join(home, rel);
    fs.renameSync(f, `${f}.away`);
    const r = push();
    check(`${label} missing from the home: the push stops`, r.status !== 0, r.stdout);
    fs.renameSync(`${f}.away`, f);
  }
  check('all back: the push goes through', push().status === 0);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('this repo');
{
  const isRepo = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).status === 0;
  if (isRepo) {
    const empty = path.join(dir, 'empty');
    const r = spawnSync(process.execPath, [SCAN, '--repo', ROOT, '--sources', empty, '--words', path.join(dir, 'nope.txt'), 'HEAD'], { encoding: 'utf-8' });
    check('HEAD has no key, address, email, phone or home path shape', r.status === 0, r.stdout);
  } else console.log('  (not a git checkout: skipped)');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll public-scan checks passed');
process.exit(failures ? 1 : 0);
