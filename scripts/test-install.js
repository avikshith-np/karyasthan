// The installer and the setup wizard, offline: pure helpers, install.sh with stubbed
// git and npm, and setup.js in a real terminal (`script`) on scratch copies of the
// project. Nothing here reads this install's .env, data or character.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseEnv, quoteEnvValue, applyEnvUpdates, normalizePhone, parseAge, looksLikeSecret, checkAliases,
  renderIdentity, routingFor, featuresToSwitchOff, validateHeadless, credsAreLinked, whatsLeft, validTimeZone,
  parseNumberList, mask, TEMPLATE_IDS,
} from './setup/lib.js';
import {
  JOBS, jobById, suggest, suggestBackup, jobUpdates, currentChoice, modelFitsProvider, parsePrice, priceKnown, smallDecisions,
} from './setup/suggestions.js';
import { classifyFailure, testModel, isInconclusive } from './setup/keys.js';
import { HELP } from './setup/help.js';
import { textHasName } from '../src/utils/nameMatch.js';
import { bootVerdict } from '../src/utils/bootCheck.js';
import { takeLock, lockHolder, releaseLock, lockPath } from '../src/utils/instanceLock.js';
import { nextAfterClose, ownerMessage, MAX_CODES } from './setup/link.js';
import { renderUserUnit, renderSystemUnit } from './setup/service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'karyasthan-install-'));
let passed = 0; let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).slice(0, 600)}` : ''}`); }
}
const section = (s) => console.log(`\n── ${s}`);

const PRIVATE = /^(persona\.json|identity\.md|world\.json|arcs\.json|taste\.json|phrases\.json)/;
function project(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), {
    recursive: true,
    filter: (p) => !PRIVATE.test(path.basename(p)) && !p.includes(`${path.sep}public${path.sep}js${path.sep}.hallmark`),
  });
  fs.cpSync(path.join(ROOT, 'scripts/setup'), path.join(dir, 'scripts/setup'), { recursive: true });
  for (const f of ['scripts/setup.js', 'scripts/doctor.js', 'scripts/pair.js', 'scripts/first-check.js', '.env.example', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  // Nothing answers here, whatever runs on this machine.
  const example = path.join(dir, '.env.example');
  fs.writeFileSync(example, fs.readFileSync(example, 'utf-8').replace(/^SEARXNG_URL=.*$/m, 'SEARXNG_URL=http://127.0.0.1:9'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
const cleanEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: SCRATCH, TERM: 'xterm', LANG: 'C.UTF-8', TZ: 'Africa/Lagos', ...extra });
const plain = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Runs setup.js in a real terminal; each step waits for text, then types. One key at a time, like a person. */
function terminal(dir, steps, { env = {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('script', ['-qfec', 'node scripts/setup.js', '/dev/null'], { cwd: dir, env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let at = 0; let i = 0; let typing = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    const step = async () => {
      if (typing || i >= steps.length) return;
      const [wait, send] = steps[i];
      const idx = plain(out).indexOf(wait, at);
      if (idx < 0) return;
      at = idx + wait.length;
      i++; typing = true;
      await new Promise((r) => setTimeout(r, 120));
      for (const c of send) {
        try { child.stdin.write(c); } catch { /* gone */ }
        await new Promise((r) => setTimeout(r, 12));
      }
      typing = false;
      step();
    };
    const onData = (d) => { out += d.toString('utf8'); step(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: plain(out), answered: i, total: steps.length }); });
  });
}
const readEnv = (dir) => parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf-8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

// ── Pure helpers ──────────────────────────────────────────────────────────────
section('helpers');
check('an inline comment is dropped, a quoted # kept', parseEnv('A=1 # c\nB="x # y"\nC=\nD=a#b').A === '1' && parseEnv('B="x # y"').B === 'x # y' && parseEnv('C=  # note').C === '' && parseEnv('D=a#b').D === 'a#b');
check('a value with a # or a space is quoted', quoteEnvValue('a #b') === '"a #b"' && quoteEnvValue('plain') === 'plain');
check('a bcrypt hash stays as it is', quoteEnvValue('$2b$10$abc') === '$2b$10$abc');
let threw = false; try { quoteEnvValue('a\nB=1'); } catch { threw = true; }
check('a line break can\'t smuggle in a setting', threw);
const body = applyEnvUpdates('# top\nA=1 # keep\nB=2\n', { B: 'x y', C: '3' });
check('updates in place and appends, comments stay', body.includes('# top') && body.includes('A=1 # keep') && body.includes('B="x y"') && body.includes('C=3') && parseEnv(body).B === 'x y');
check('spaces, dashes and + are fine', normalizePhone('+1 (555) 010-0123').digits === '15550100123');
check('00 counts as an international prefix', normalizePhone('0044 7700 900123').digits === '447700900123');
check('10 digits with no code is caught', normalizePhone('7700 900123').why === 'no_country_code');
check('10 digits with + is fine', normalizePhone('+49 1500000078').ok && normalizePhone('+1234567890').ok);
check('not a phone', normalizePhone('not-a-phone').why === 'digits');
check('blank age is fine', parseAge('').ok && parseAge('').age === null);
check('18 is the youngest', !parseAge('17').ok && parseAge('18').age === 18);
check('words and silly numbers are refused', !parseAge('abc').ok && !parseAge('101').ok && !parseAge('-5').ok);
check('key shapes are spotted', looksLikeSecret(`AIza${'x'.repeat(30)}`) && looksLikeSecret(`sk-${'a1'.repeat(20)}`) && looksLikeSecret('ab12'.repeat(10)));
check('ordinary text isn\'t', !looksLikeSecret('Sam') && !looksLikeSecret('warm, witty, a real friend not an assistant') && !looksLikeSecret('a young adult from Lagos speaking casually to friends'));
const ca = checkAliases(['Sam', 'a', 'ok', 'sammy', 'SAM', ' ']);
check('short and common names are refused, repeats dropped', ca.keep.join() === 'sam,sammy' && ca.refused.join() === 'a,ok');
check('a 3-letter name carries a warning', ca.warn.join() === 'sam');
const TPL = fs.readFileSync(path.join(ROOT, 'src/personality/identity.template.md'), 'utf-8');
const base = { name: 'Sam', language: 'English', vibe: 'dry' };
const none = renderIdentity(TPL, { ...base, age: null, region: '' });
check('blank age and region leave no hole', !none.includes('years old') && !none.includes(', from') && !none.includes('{{') && !/^- *$/m.test(none));
check('age alone reads right', renderIdentity(TPL, { ...base, age: 30, region: '' }).includes('- 30 years old.\n'));
check('region alone reads right', renderIdentity(TPL, { ...base, age: null, region: 'Lagos' }).includes('- from Lagos.\n'));
check('both read right', renderIdentity(TPL, { ...base, age: 30, region: 'Lagos' }).includes('- 30 years old, from Lagos.\n'));
check('$ in a name isn\'t a pattern', renderIdentity('You are {{NAME}}.', { ...base, name: '$&x' }) === 'You are $&x.');
const r = routingFor('anthropic', 'claude-haiku-5-5');
check('the gate follows the reply model, no phantom fallback', r.QUALITY_GATE_PROVIDER === 'anthropic' && r.QUALITY_GATE_MODEL === 'claude-haiku-5-5' && r.LLM_FALLBACK_PROVIDER === 'none');
check('OpenRouter alone gets voice messages through OpenRouter', routingFor('openrouter', 'm', { hasOpenrouter: true }).TRANSCRIPTION_MODEL.startsWith('google/') && !routingFor('gemini', 'm', { hasGemini: true }).TRANSCRIPTION_MODEL);
const offAll = featuresToSwitchOff({}).map((f) => f.key).join();
check('nothing there: everything that can\'t work goes off', offAll === 'JEV_PREFILTER_ENABLED,IMAGE_GEN_ENABLED,VOICE_NOTE_ENABLED,WEB_SEARCH_ENABLED,WEB_BROWSE_ENABLED', offAll);
check('all there: nothing goes off', featuresToSwitchOff({ hasGemini: true, hasOpenrouter: true, ffmpeg: true, searxng: true, chromium: true }).length === 0);
check('no ffmpeg: only voice notes', featuresToSwitchOff({ hasGemini: true, hasOpenrouter: true, searxng: true, chromium: true }).map((f) => f.key).join() === 'VOICE_NOTE_ENABLED');
const bad = validateHeadless({ LLM_PROVIDER: 'nonsense', WA_PHONE_NUMBER: 'x', TIMEZONE: 'Mars/Base', KARYASTHAN_AGE: '12', KARYASTHAN_NAME: 'Sam' }).map((e) => e[0]).join();
check('headless lists every bad value', bad === 'LLM_PROVIDER,WA_PHONE_NUMBER,TIMEZONE,KARYASTHAN_AGE', bad);
check('headless needs a name, on a new install only', validateHeadless({}).some((e) => e[0] === 'KARYASTHAN_NAME') && validateHeadless({}, { personaExists: true }).length === 0);
check('headless: a provider with no suggestion needs a model', validateHeadless({ LLM_PROVIDER: 'openai', KARYASTHAN_NAME: 'Sam' }).some((e) => e[0] === 'LLM_MODEL'));
check('time zones', validTimeZone('Africa/Lagos') && !validTimeZone('Mars/Base') && !validTimeZone(''));
check('linked session', credsAreLinked('{"registered":true}') && credsAreLinked('{"me":{"id":"1"}}') && !credsAreLinked('{"registered":false}') && !credsAreLinked('junk'));
const left = whatsLeft({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'm' }).map((l) => l.what).join('|');
check('what\'s left names key, number and link', left.includes('Gemini key') && left.includes('number') && left.includes('Link'), left);
check('nothing left when all is there', whatsLeft({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'm', WA_PHONE_NUMBER: '1' }, { linked: true }).length === 0);

section('suggestions');
const J = (id) => jobById(id);
const have = (...p) => new Set(p);
check('Gemini + Anthropic: flash for replies, Opus for deep thinking', suggest(J('replies'), have('gemini', 'anthropic')).model === 'gemini-3.8-flash' && suggest(J('deep'), have('gemini', 'anthropic')).model === 'claude-opus-5-5');
check('OpenRouter alone covers every job through itself', ['replies', 'background', 'check', 'deep', 'fictional'].every((j) => suggest(J(j), have('openrouter')).provider === 'openrouter'));
check('Anthropic alone: cheap Claude for replies', suggest(J('replies'), have('anthropic')).model === 'claude-haiku-5-5');
check('Gemini alone: deep thinking suggests gemini-2.5-pro', suggest(J('deep'), have('gemini')).model === 'gemini-2.5-pro');
check('OpenAI alone: asks for an id, no invented model', suggest(J('replies'), have('openai')).provider === 'openai' && suggest(J('replies'), have('openai')).model === '');
check('A local model alone can\'t do deep thinking', suggest(J('deep'), have('ollama')).provider === '');
check('xAI serves the fictional job directly', suggest(J('fictional'), have('xai')).provider === 'xai');
check('No key for fictional texts: off', suggest(J('fictional'), have('gemini')).provider === '');
check('A backup is another provider held', suggestBackup(J('replies'), { provider: 'gemini' }, have('gemini', 'anthropic')).provider === 'anthropic' && suggestBackup(J('replies'), { provider: 'gemini' }, have('gemini')) === null);
check('Fictional texts never get a backup', suggestBackup(J('fictional'), { provider: 'openrouter' }, have('openrouter', 'xai')) === null);
const off = jobUpdates(J('fictional'), { provider: '', model: '' });
check('Off is written as none, so a key elsewhere can\'t revive it', off.LLM_DESIRE_PROVIDER === 'none' && off.LLM_DESIRE_MODEL === '');
check('Reads back what\'s set; empty background follows replies', currentChoice(J('background'), { LLM_PROVIDER: 'gemini', LLM_MODEL: 'm' }).model === 'm' && currentChoice(J('fictional'), { LLM_DESIRE_PROVIDER: 'none' }).provider === '');
check('A job not in .env reads as the role\'s built-in default, as the bot does', currentChoice(J('deep'), {}).model === 'claude-opus-5-5' && currentChoice(J('check'), {}).provider === 'gemini');
check('Provider and model that can\'t belong together are caught', modelFitsProvider('anthropic', 'gemini-3.8-flash') && modelFitsProvider('openrouter', 'gemini-3.8-flash') && modelFitsProvider('gemini', 'x/y') && !modelFitsProvider('gemini', 'gemini-9') && !modelFitsProvider('openai', 'whatever') && !modelFitsProvider('openrouter', 'mistralai/some'));
check('Prices read as typed', parsePrice('0.20 0.80').join() === '0.2,0.8' && parsePrice('$1, $2').join() === '1,2' && parsePrice('cheap') === null);
for (const j of JOBS) for (const [p, tier] of j.order) {
  const m = suggest(j, new Set([p])).model;
  check(`${j.label} on ${p} (${tier}): the suggestion has a known price`, priceKnown(ROOT, p, m), `${p}/${m}`);
}
check('Jev: fixed with OpenRouter, code otherwise', smallDecisions(have('openrouter')).model.startsWith('typesafe/') && smallDecisions(have('gemini')).model === 'code decides');
check('Numbers list', parseNumberList('1, 3', 3).join() === '1,3' && parseNumberList('', 3).length === 0 && parseNumberList('4', 3) === null && parseNumberList('x', 3) === null);
check('Mask hides all but the end', mask('15550100123') === '••••••••23' && mask('abc') === '•••');

section('testing a key');
check('Each failure has its own meaning', classifyFailure(401) === 'bad_key' && classifyFailure(402) === 'no_credit' && classifyFailure(404) === 'no_model' && classifyFailure(429) === 'rate' && classifyFailure(500) === 'server' && classifyFailure(400, 'API_KEY_INVALID') === 'bad_key' && classifyFailure(400, 'model not found') === 'no_model');
check('A network problem isn\'t a verdict on the key', isInconclusive('network') && isInconclusive('rate') && !isInconclusive('bad_key'));
let sent = null;
const stubFetch = async (url, init) => { sent = { url, init }; return { ok: true }; };
await testModel({ provider: 'anthropic', model: 'claude-haiku-5-5', key: 'KEY1', fetchFn: stubFetch });
check('An Anthropic key goes only to Anthropic, in its own header', sent.url.startsWith('https://api.anthropic.com/') && sent.init.headers['x-api-key'] === 'KEY1');
await testModel({ provider: 'gemini', model: 'm', key: 'KEY2', fetchFn: stubFetch });
check('A Gemini key goes only to Google', sent.url.startsWith('https://generativelanguage.googleapis.com/') && sent.init.headers.Authorization === 'Bearer KEY2');
await testModel({ provider: 'xai', model: 'grok', key: 'KEY3', fetchFn: stubFetch });
check('An xAI key goes only to xAI', sent.url.startsWith('https://api.x.ai/'));
const net = await testModel({ provider: 'openai', model: 'm', key: 'k', fetchFn: async () => { throw new Error('down'); } });
check('No network: network, not a bad key', net.ok === false && net.why === 'network');

section('names in a message');
check('"sam" isn\'t in "same"', !textHasName('the same thing', 'sam') && !textHasName('sample', 'sam'));
check('"sam" alone, in any case or next to punctuation', textHasName('hey Sam!', 'sam') && textHasName('sam?', 'sam') && textHasName('@sam ok', 'sam'));
check('A longer name may carry an ending', textHasName('eda karyasthaa', 'karyastha') && textHasName('samuelinte', 'samuel'));
check('A longer name doesn\'t match inside a word', !textHasName('asamuel', 'samuel'));
check('Non-Latin names work', textHasName('നമസ്കാരം സാം', 'സാം') && !textHasName('സാംബാർ കഴിച്ചു', 'സാം'));
check('A name with a dot isn\'t a pattern', !textHasName('axb', 'a.b') && textHasName('a.b', 'a.b'));

section('templates and instructions');
const templates = TEMPLATE_IDS.map((id) => JSON.parse(fs.readFileSync(path.join(ROOT, `src/personality/templates/${id}.json`), 'utf-8')));
check('Five templates, each complete', templates.length === 5 && templates.every((t) => t.label && t.blurb && t.sample && t.vibe && t.voice && t.job && t.talk?.length && t.cares?.length));
check('Every template is an adult', templates.every((t) => t.age >= 18));
check('Every template is in plain English, with no language assumed', templates.every((t) => /^[\x20-\x7e]+$/.test(JSON.stringify(t))));
const withT = renderIdentity(TPL, { ...base, age: 29, region: '', vibe: templates[0].vibe }, templates[0]);
check('A template\'s lines reach identity.md', withT.includes(templates[0].talk[0]) && withT.includes(`You work as ${templates[0].job}`) && withT.includes(templates[0].cares[0]));
check('A blank start adds none', !renderIdentity(TPL, { ...base, age: 29, region: '' }).includes('You work as'));
const docs = fs.readFileSync(path.join(ROOT, 'docs/install.md'), 'utf-8');
for (const [k, text] of Object.entries(HELP)) {
  const first = text.split('\n')[0];
  check(`docs/install.md carries the help for "${k}"`, docs.includes(first), first);
}
check('docs/install.md names every template', templates.every((t) => docs.includes(t.label)));

section('one copy, boot check');
const lockDir = fs.mkdtempSync(path.join(SCRATCH, 'lock-'));
check('A free lock is taken, private', takeLock(lockDir, 'bot') === null && mode(lockPath(lockDir)) === '600');
check('Our own lock isn\'t a holder', lockHolder(lockDir) === null);
releaseLock(lockDir);
check('Released', !fs.existsSync(lockPath(lockDir)));
fs.writeFileSync(lockPath(lockDir), '999999 bot\n');
check('A dead pid is stale and replaced', takeLock(lockDir, 'bot') === null && fs.readFileSync(lockPath(lockDir), 'utf-8').startsWith(`${process.pid} `));
fs.writeFileSync(lockPath(lockDir), `${process.ppid} bot\n`);
check('A pid that\'s something else now is stale', lockHolder(lockDir) === null || process.platform !== 'linux');
// A stand-in for the bot: node running a file at the bot's path.
const standIn = path.join(SCRATCH, 'stand-in/src/index.js');
fs.mkdirSync(path.dirname(standIn), { recursive: true });
fs.writeFileSync(standIn, 'setTimeout(()=>{},60000)');
const otherApp = path.join(SCRATCH, 'other-app/index.js');
fs.mkdirSync(path.dirname(otherApp), { recursive: true });
fs.writeFileSync(otherApp, 'setTimeout(()=>{},60000)');
const other = spawn(process.execPath, [otherApp], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 300));
fs.writeFileSync(lockPath(lockDir), `${other.pid} bot\n`);
check('Another app\'s index.js holding that pid now isn\'t a copy', lockHolder(lockDir) === null || process.platform !== 'linux');
other.kill('SIGKILL');
const sleeper = spawn(process.execPath, [standIn], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 300));
fs.writeFileSync(lockPath(lockDir), `${sleeper.pid} bot\n`);
const held = lockHolder(lockDir);
check('A live copy holds it', held?.pid === sleeper.pid, JSON.stringify(held));
check('A second copy is told who', takeLock(lockDir, 'bot')?.pid === sleeper.pid);
check('The dashboard\'s pairing job gets through under its parent', takeLock(lockDir, 'pair', { allow: (h) => h.pid === sleeper.pid }) === null && fs.readFileSync(lockPath(lockDir), 'utf-8').startsWith(`${sleeper.pid} `));
sleeper.kill('SIGKILL');
const B = { linked: true, tty: false, phone: '1', keyMissing: '', dashboard: false };
check('Linked with a key: starts', !bootVerdict(B).stop && !bootVerdict(B).noWhatsApp);
check('No key, no dashboard: stops', bootVerdict({ ...B, keyMissing: 'gemini' }).stop?.[0].includes('gemini'));
check('No key, dashboard on: starts, a key can be added there', !bootVerdict({ ...B, keyMissing: 'gemini', dashboard: true }).stop);
check('Unlinked under a service: stops, no codes in a log', bootVerdict({ ...B, linked: false }).stop?.join(' ').includes('npm run setup'));
check('Unlinked under a service with a dashboard: up, no WhatsApp', bootVerdict({ ...B, linked: false, dashboard: true }).noWhatsApp === true);
check('Unlinked in a terminal with a number: goes on to show a code', !bootVerdict({ ...B, linked: false, tty: true }).stop);
check('Unlinked in a terminal, no number: says so', bootVerdict({ ...B, linked: false, tty: true, phone: '' }).stop?.[0].includes('number'));

section('linking');
const R = { loggedOut: 401, restartRequired: 515 };
check('Logged out before any code: its own exit', nextAfterClose(401, { codesShown: 0, ...R }).exit === 3);
check('A refused number stops, no retry loop', nextAfterClose(403, { codesShown: 1, ...R }).exit === 5 && nextAfterClose(405, { codesShown: 1, ...R }).exit === 5);
check('A restart after linking is quick', nextAfterClose(515, { codesShown: 1, ...R }).delayMs === 500);
check('A code running out earns a new one', nextAfterClose(408, { codesShown: 1, ...R }).newCode === true);
check('Codes stop at the cap', nextAfterClose(408, { codesShown: MAX_CODES, ...R }).exit === 4);
check('Anything else waits and retries', nextAfterClose(428, { codesShown: 1, ...R }).delayMs === 10000);
check('pair.js prints the label the dashboard reads', fs.readFileSync(path.join(ROOT, 'scripts/pair.js'), 'utf-8').includes('PAIRING CODE: ${code}') && fs.readFileSync(path.join(ROOT, 'src/dashboard/routes/pair.js'), 'utf-8').includes('PAIRING CODE:'));
const dm = (remoteJid, text, extra = {}) => ({ key: { remoteJid, ...extra }, message: { conversation: text } });
check('The owner\'s DM counts', ownerMessage(dm('15550100456@s.whatsapp.net', 'hi'), '15550100456')?.confirmed === true);
check('Through its phone beside a LID too', ownerMessage(dm('123@lid', 'hi', { remoteJidAlt: '15550100456@s.whatsapp.net' }), '15550100456')?.confirmed === true);
check('A LID with nothing beside it asks first', ownerMessage(dm('123@lid', 'hi'), '15550100456')?.confirmed === false);
check('Someone else\'s message is ignored', ownerMessage(dm('15550100999@s.whatsapp.net', 'secret'), '15550100456') === null);
check('A group never counts', ownerMessage(dm('1@g.us', 'hi', { participant: '15550100456@s.whatsapp.net' }), '15550100456') === null);
check('Its own message never counts', ownerMessage(dm('15550100456@s.whatsapp.net', 'hi', { fromMe: true }), '15550100456') === null);
check('No owner number: asks who, with the number', ownerMessage(dm('15550100456@s.whatsapp.net', 'hi'), '')?.from === '15550100456');
const fc = fs.readFileSync(path.join(ROOT, 'scripts/first-check.js'), 'utf-8');
check('The first check can\'t send or mark read', !/sendMessage|readMessages|sendReceipt|sendPresenceUpdate/.test(fc) && /markOnlineOnConnect: false/.test(fc));

section('service files');
const FAKE_HOME = ['', 'home', 'sam'].join('/');   // built, so the repo's path check stays strict
const user = renderUserUnit({ root: `${FAKE_HOME}/karyasthan`, node: '/opt/node/bin/node' });
check('A user unit has the real paths and doesn\'t restart on 78', user.includes(`ExecStart=/opt/node/bin/node ${FAKE_HOME}/karyasthan/src/index.js`) && user.includes(`WorkingDirectory=${FAKE_HOME}/karyasthan`) && user.includes('RestartPreventExitStatus=78'));
const sys = (root) => renderSystemUnit({ root, node: '/usr/bin/node', user: 'sam' });
check('A system unit under /home doesn\'t block itself', sys(`${FAKE_HOME}/k`).includes('ProtectHome=false') && sys('/opt/k').includes('ProtectHome=true') && sys('/opt/k').includes('User=sam'));
check('The committed unit doesn\'t restart on 78', fs.readFileSync(path.join(ROOT, 'karyasthan.service'), 'utf-8').includes('RestartPreventExitStatus=78'));

// ── setup.js ──────────────────────────────────────────────────────────────────
const hasScript = spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
section('setup.js in a real terminal');
if (!hasScript) {
  console.log('  skip  no `script` command here');
} else {
  const a = project('fresh');
  const r1 = await terminal(a, [
    ['Type numbers', '?\r'],
    ['New to this', ''],
    ['Type numbers', '2\r'],
    ['key, hidden', 'SECRETKEY-AAAA\r'],
    ['Enter to accept', '1\r'],
    ['Choose', '2\r'],
    ['Choose', '4\r'],
    ['Model id', 'gemini-3.8-flash\r'],
    ['isn\'t a Claude model', ''],
    ['Choose', '1\r'],
    ['Enter to accept', '\r'],
    ['Choose', '1\r'],
    ['Use it?', 'y\r'],
    ['Name', `AIza${'y'.repeat(30)}\r`],
    ['Not saved', ''],
    ['Name', 'Sam\r'],
    ['answers to', 'a, sammy\r'],
    ['Age', '17\r'],
    ['adult', ''],
    ['Age', '\r'],
    ['From', '\r'],
    ['Language', '\r'],
    ['mix languages', '\r'],
    ['sounds', '\r'],
    ['personality', '\r'],
    ['Its number', '7700 900123\r'],
    ['No country code', ''],
    ['Its number', '+1 555 010 0123\r'],
    ['Your own number', '+1 555 010 0123\r'],
    ['same as its number', ''],
    ['use my own', '2\r'],
    ['new on WhatsApp', 'n\r'],
    ['Right?', 'y\r'],
    ['Type numbers to switch', '4,5\r'],
    ['Monthly budget', '20\r'],
    ['dashboard?', 'y\r'],
    ['Username', '\r'],
    ['hidden', 'SECRETSHORT\r'],
    ['Again', 'SECRETSHORX\r'],
    ['don\'t match', ''],
    ['hidden', 'SECRETPASS-BBBB\r'],
    ['Again', 'SECRETPASS-BBBB\r'],
    ['go on', '\r'],
    ['Link it now?', 'n\r'],
  ], { env: { KARYASTHAN_TEST_PROBE: 'ok' } });
  check('it asked everything', r1.answered === r1.total, `${r1.answered}/${r1.total}\n${r1.out.slice(-700)}`);
  check('exits 0', r1.code === 0, r1.code);
  check('? explains the question, then asks it again', r1.out.includes('New to this? Start with Gemini'));
  check('a job table with a reason per job', r1.out.includes('Deep thinking') && r1.out.includes('claude-opus-5-5') && r1.out.includes('Small decisions') && r1.out.includes('code decides'));
  check('a template shows how it talks', r1.out.includes("i'm taking notes"));
  check('a typed key doesn\'t appear', !r1.out.includes('SECRET') && !/S\*E\*C/.test(r1.out));
  check('stars do', r1.out.includes('*'.repeat('SECRETKEY-AAAA'.length)));
  check('answers after a hidden prompt echo once', !/Username \[admin\]: *\n+admin/.test(r1.out) && !r1.out.includes('n\nn\n'));
  check('no log output reaches the screen', !r1.out.includes('"level"') && !r1.out.includes('dotenv@'));
  check('says it\'s not ready, and why', r1.out.includes('Not ready yet') && r1.out.includes('Link WhatsApp') && !r1.out.includes('All set'));
  const e1 = readEnv(a);
  check('the changed job is saved, the others keep their suggestions', e1.LLM_PROVIDER === 'anthropic' && e1.LLM_MODEL === 'claude-haiku-5-5' && e1.LLM_MIND_MODEL === 'claude-opus-5-5' && e1.LLM_DESIRE_PROVIDER === 'none');
  check('the gate follows its suggestion, no phantom fallback', e1.QUALITY_GATE_PROVIDER === 'anthropic' && e1.LLM_FALLBACK_PROVIDER === 'none');
  check('the key and the numbers are saved', e1.ANTHROPIC_API_KEY === 'SECRETKEY-AAAA' && e1.WA_PHONE_NUMBER === '15550100123' && e1.OWNER_JIDS === '15550100123');
  check('warmup follows the answer', e1.WARMUP_ENABLED === 'false');
  check('the time zone is detected', e1.TIMEZONE === 'Africa/Lagos', e1.TIMEZONE);
  check('life and the mind are on, with everything life needs', e1.LIFE_ENABLED === 'true' && e1.ARCS_ENABLED === 'true' && e1.CHAT_INFLUENCE_ENABLED === 'true' && e1.MIND_ENABLED === 'true');
  check('editing is on because life is', e1.DASHBOARD_READONLY === 'false');
  check('the budget is saved', e1.LLM_MONTHLY_BUDGET_USD === '20');
  check('what can\'t work is off', e1.JEV_PREFILTER_ENABLED === 'false' && e1.IMAGE_GEN_ENABLED === 'false' && e1.WEB_SEARCH_ENABLED === 'false');
  check('the dashboard password is stored only as a hash', e1.DASHBOARD_PASS_HASH.startsWith('$2') && !fs.readFileSync(path.join(a, '.env'), 'utf-8').includes('SECRETPASS'));
  const persona = JSON.parse(fs.readFileSync(path.join(a, 'src/personality/persona.json'), 'utf-8'));
  check('the character is saved, without the pasted key or the bad nickname', persona.name === 'Sam' && persona.aliases.join() === 'sam,sammy' && persona.age === 29 && persona.template === 'dry-friend' && persona.vibe.startsWith('sarcastic'));
  const id = fs.readFileSync(path.join(a, 'src/personality/identity.md'), 'utf-8');
  check('identity.md has the template and no hole', id.includes('Few words.') && !id.includes('{{') && id.includes('- 29 years old.'));
  check('.env is private', mode(path.join(a, '.env')) === '600');
  check('the data folder and database are private', mode(path.join(a, 'data')) === '700' && mode(path.join(a, 'data/karyasthan.db')) === '600');

  const cfg = spawnSync('node', ['--input-type=module', '-e', `process.env.DOTENV_CONFIG_QUIET='true';const {config}=await import('./src/utils/config.js');const {resolveRole}=await import('./src/brain/roles.js');const r=n=>resolveRole(n,config);console.log(JSON.stringify({m:r('mouth').chain,g:r('gate').chain,c:r('clerk').chain,d:r('mind').chain,f:r('desire').disabled}))`], { cwd: a, env: cleanEnv(), encoding: 'utf-8' });
  let roles = {}; try { roles = JSON.parse(cfg.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
  check('the bot reads these as its roles', roles.m?.[0]?.model === 'claude-haiku-5-5' && roles.m?.length === 1 && roles.g?.[0]?.provider === 'anthropic' && roles.c?.[0]?.model === 'claude-haiku-5-5' && roles.d?.[0]?.model === 'claude-opus-5-5' && roles.f === true, cfg.stdout + cfg.stderr);

  // Linked now: the last steps run. Stubs stand in for the service managers and the check.
  const bin = path.join(SCRATCH, 'svc-bin'); fs.mkdirSync(bin, { recursive: true });
  const svcLog = path.join(SCRATCH, 'svc.log');
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\necho "pm2 $*" >> "${svcLog}"\n[ "$1" = "--version" ] && echo 5\n[ "$1" = "pid" ] && echo 0\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${svcLog}"\nexit 0\n`, { mode: 0o755 });
  const c2 = project('run-steps');
  fs.mkdirSync(path.join(c2, 'data/auth_info_baileys'), { recursive: true });
  fs.writeFileSync(path.join(c2, 'data/auth_info_baileys/creds.json'), '{"registered":true}');
  fs.writeFileSync(path.join(c2, '.env'), 'LLM_PROVIDER=ollama\nLLM_MODEL=m\nWA_PHONE_NUMBER=15550100123\nTIMEZONE=UTC\n');
  fs.writeFileSync(path.join(c2, 'src/personality/persona.json'), JSON.stringify({ name: 'Sam' }));
  fs.writeFileSync(path.join(c2, 'src/personality/identity.md'), 'x');
  const svc = await terminal(c2, [['Choose', '8\r'], ['Choose', '1\r'], ['Choose', '9\r']], { env: { PATH: `${bin}:${process.env.PATH}` } });
  const calls = fs.existsSync(svcLog) ? fs.readFileSync(svcLog, 'utf-8') : '';
  check('pm2: starts under its name, won\'t restart on 78, saved', calls.includes('pm2 start src/index.js --name karyasthan') && calls.includes('--stop-exit-codes 78') && calls.includes('pm2 save'), calls + svc.out.slice(-300));
  check('pm2: sudo is printed, never run', svc.out.includes('needs sudo') && svc.out.includes('pm2 startup') && !calls.includes('startup'), svc.out.slice(-300));
  fs.rmSync(svcLog, { force: true });
  const c3home = path.join(SCRATCH, 'svc-home'); fs.mkdirSync(c3home, { recursive: true });
  const svc2 = await terminal(c2, [['Choose', '8\r'], ['Choose', '2\r'], ['Choose', '9\r']], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: c3home } });
  const unit = path.join(c3home, '.config/systemd/user/karyasthan.service');
  check('systemd: writes a user unit with real paths and starts it', fs.existsSync(unit) && fs.readFileSync(unit, 'utf-8').includes(c2) && fs.readFileSync(svcLog, 'utf-8').includes('enable --now karyasthan'), svc2.out.slice(-300));
  check('systemd: the linger line is printed, never run', svc2.out.includes('enable-linger'));
  const lockd = project('locked');
  fs.mkdirSync(path.join(lockd, 'data'), { recursive: true, mode: 0o700 });
  const copy = spawn(process.execPath, [standIn], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(lockd, 'data/.instance-lock'), `${copy.pid} bot\n`);
  const pr = spawnSync('node', ['scripts/pair.js', '15550100123'], { cwd: lockd, env: cleanEnv(), encoding: 'utf-8', timeout: 20000 });
  check('pair.js won\'t run beside a live copy: exit 78, says so', pr.status === 78 && pr.stderr.includes('already running'), `${pr.status} ${pr.stderr}`);
  const fcr = spawnSync('node', ['scripts/first-check.js'], { cwd: lockd, env: cleanEnv(), encoding: 'utf-8', timeout: 20000 });
  check('first-check won\'t run beside a live copy', fcr.status === 78, `${fcr.status} ${fcr.stderr}`);
  copy.kill('SIGKILL');
  const boots = project('boot');
  fs.writeFileSync(path.join(boots, '.env'), 'LLM_PROVIDER=ollama\nLLM_MODEL=m\nWA_PHONE_NUMBER=15550100123\nDASHBOARD_ENABLED=false\n');
  const bo = spawnSync('node', ['src/index.js'], { cwd: boots, env: cleanEnv(), encoding: 'utf-8', timeout: 30000 });
  check('The bot unlinked with no terminal: exit 78, no WhatsApp, no database', bo.status === 78 && bo.stderr.includes('Not linked') && !fs.existsSync(path.join(boots, 'data/auth_info_baileys')) && !fs.existsSync(path.join(boots, 'data/karyasthan.db')), `${bo.status} ${bo.stderr.slice(-300)}`);

  const again = await terminal(a, [['Choose', '\r']]);
  const unchanged = readEnv(a);
  check('running it again opens a menu and changes nothing', again.code === 0 && again.out.includes('Change a key or model') && unchanged.ANTHROPIC_API_KEY === 'SECRETKEY-AAAA' && unchanged.LLM_PROVIDER === 'anthropic' && !again.out.includes('Which do you have'), again.out.slice(-400));
  const change = await terminal(a, [
    ['Choose', '4\r'],
    ['Type numbers to switch', '5\r'],
    ['Monthly budget', '\r'],
    ['Choose', '\r'],
  ]);
  check('the menu changes one thing: the mind goes off', change.code === 0 && readEnv(a).MIND_ENABLED === 'false' && readEnv(a).LIFE_ENABLED === 'true', change.out.slice(-300));
  check('a change on an existing install backs up .env first', fs.readdirSync(a).some((f) => f.startsWith('.env.bak.')));
  const doc = spawnSync('node', ['scripts/doctor.js', '--offline'], { cwd: a, env: cleanEnv(), encoding: 'utf-8' });
  check('doctor: not linked is a failure, exit 1', doc.status === 1 && doc.stdout.includes('Not linked'), doc.stdout + doc.stderr);
  check('doctor: masks keys and numbers', !doc.stdout.includes('SECRETKEY') && !doc.stdout.includes('15550100123') && doc.stdout.includes('safe to paste'), doc.stdout);
  check('doctor: a key is reported, not shown', /Replies: anthropic\/claude-haiku-5-5, key •+AA/.test(doc.stdout), doc.stdout);
  fs.mkdirSync(path.join(a, 'data/auth_info_baileys'), { recursive: true });
  fs.writeFileSync(path.join(a, 'data/auth_info_baileys/creds.json'), '{"registered":true}');
  const doc2 = spawnSync('node', ['scripts/doctor.js', '--offline', '--json'], { cwd: a, env: cleanEnv(), encoding: 'utf-8' });
  let dj = {}; try { dj = JSON.parse(doc2.stdout); } catch { /* reported */ }
  check('doctor: all there, exit 0, --json works', doc2.status === 0 && dj.ok === true, doc2.stdout + doc2.stderr);

  const b = project('stopped');
  const stop = await terminal(b, [
    ['Type numbers', '1\r'],
    ['key, hidden', '\u0003'],
  ]);
  check('Ctrl-C at a hidden prompt: one line, no stack trace, exit 130', stop.code === 130 && stop.out.includes('Stopped.') && !stop.out.includes('    at '), `${stop.code} ${stop.out.slice(-300)}`);
  fs.writeFileSync(path.join(b, 'data/setup-state.json'), JSON.stringify({ fresh: true, done: ['keys', 'jobs', 'features'] }));
  const resume = await terminal(b, [
    ['Choose', '\r'],
    ['Use it?', 'y\r'],
    ['Name', '\u0004'],
  ]);
  check('the next run carries on, models aren\'t asked again', resume.out.includes('Carrying on') && !resume.out.includes('Which do you have'), resume.out.slice(0, 400));
  check('Ctrl-D at a prompt: one line, no stack trace', resume.code === 130 && !resume.out.includes('    at '), resume.code);

  const c = project('existing');
  fs.writeFileSync(path.join(c, '.env'), 'LLM_PROVIDER=gemini\nLLM_MODEL=m\nGEMINI_API_KEY=k\nWA_PHONE_NUMBER=15550100123\nTIMEZONE=UTC\nMY_NOTE=keep # mine\n', { mode: 0o644 });
  fs.writeFileSync(path.join(c, 'src/personality/persona.json'), JSON.stringify({ name: 'Old' }));
  fs.writeFileSync(path.join(c, 'src/personality/identity.md'), 'mine');
  fs.writeFileSync(path.join(c, 'src/personality/world.json'), '{}');
  const ex = await terminal(c, [['Choose', '2\r'], ['persona.json already exists', 'n\r'], ['Choose', '\r']]);
  check('an existing install opens a menu, not the first-run questions', ex.code === 0 && !ex.out.includes('Which do you have') && ex.out.includes('Change a key or model'), ex.out.slice(-300));
  check('it warns that a world can\'t be rewritten', ex.out.includes('already has a world'));
  check('its character and settings stay', fs.readFileSync(path.join(c, 'src/personality/identity.md'), 'utf-8') === 'mine' && readEnv(c).MY_NOTE === 'keep');
  check('its features aren\'t switched off', !readEnv(c).WEB_SEARCH_ENABLED);
  check('its .env becomes private', mode(path.join(c, '.env')) === '600');

  const bad1 = project('bad-key');
  const bk = await terminal(bad1, [
    ['Type numbers', '1\r'],
    ['key, hidden', 'WRONGKEY\r'],
    ['refused this key', ''],
    ['key, hidden', 'RIGHTKEY-CCCC\r'],
    ['Works', ''],
    ['Enter to accept', '\u0003'],
  ], { env: { KARYASTHAN_TEST_PROBE: 'bad_key,ok' } });
  check('a wrong key: says so, asks again, saves only the right one', bk.answered === bk.total && readEnv(bad1).GEMINI_API_KEY === 'RIGHTKEY-CCCC' && !fs.readFileSync(path.join(bad1, '.env'), 'utf-8').includes('WRONGKEY'), bk.out.slice(-300));
  const net1 = project('offline-key');
  const nk = await terminal(net1, [
    ['Type numbers', '1\r'],
    ['key, hidden', 'GOODKEY-DDDD\r'],
    ['isn\'t proven bad', ''],
    ['Enter to accept', '\u0003'],
  ], { env: { KARYASTHAN_TEST_PROBE: 'network' } });
  check('no network: the key is kept, marked not tested', nk.answered === nk.total && readEnv(net1).GEMINI_API_KEY === 'GOODKEY-DDDD' && nk.out.includes('not tested'), nk.out.slice(-300));
}

section('setup.js with no terminal');
const noTty = (dir, env) => spawnSync('node', ['scripts/setup.js'], { cwd: dir, env: cleanEnv(env), encoding: 'utf-8', input: '', detached: true });
const d = project('headless-bad');
const hb = noTty(d, { KARYASTHAN_NONINTERACTIVE: '1', LLM_PROVIDER: 'nonsense', WA_PHONE_NUMBER: 'not-a-phone' });
check('bad values: exit 2, each one named', hb.status === 2 && hb.stderr.includes('LLM_PROVIDER') && hb.stderr.includes('WA_PHONE_NUMBER') && hb.stderr.includes('KARYASTHAN_NAME'), hb.stderr);
check('bad values: nothing written', !fs.existsSync(path.join(d, '.env')) && !fs.existsSync(path.join(d, 'src/personality/persona.json')) && !fs.existsSync(path.join(d, 'data')));
const e = project('headless-good');
const hg = noTty(e, { KARYASTHAN_NONINTERACTIVE: '1', KARYASTHAN_NAME: 'Sam', LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', WA_PHONE_NUMBER: '+1 555 010 0123', TIMEZONE: 'Africa/Lagos' });
const he = hg.status === 0 ? readEnv(e) : {};
check('good values: exit 0, all saved', hg.status === 0 && he.LLM_MODEL === 'google/gemini-3.8-flash' && he.WA_PHONE_NUMBER === '15550100123' && he.TIMEZONE === 'Africa/Lagos' && he.TRANSCRIPTION_MODEL?.startsWith('google/'), hg.stderr || hg.stdout);
const g2 = project('headless-template');
const ht = noTty(g2, { KARYASTHAN_NONINTERACTIVE: '1', KARYASTHAN_NAME: 'Sam', KARYASTHAN_TEMPLATE: 'organiser', KARYASTHAN_ENABLE: 'life', LLM_MIND_MODEL: 'custom-model', GEMINI_API_KEY: 'k' });
const hte = ht.status === 0 ? readEnv(g2) : {};
check('headless: template, abilities and a job\'s own model', ht.status === 0 && hte.LIFE_ENABLED === 'true' && hte.ARCS_ENABLED === 'true' && hte.LLM_MIND_MODEL === 'custom-model' && JSON.parse(fs.readFileSync(path.join(g2, 'src/personality/persona.json'), 'utf-8')).template === 'organiser', ht.stderr || ht.stdout);
const g3 = project('headless-badtpl');
const bt = noTty(g3, { KARYASTHAN_NONINTERACTIVE: '1', KARYASTHAN_NAME: 'Sam', KARYASTHAN_TEMPLATE: 'nope' });
check('headless: an unknown template is refused', bt.status === 2 && bt.stderr.includes('KARYASTHAN_TEMPLATE'));
check('good values: still says linking is left', hg.stdout.includes('Not ready yet') && hg.stdout.includes('Link WhatsApp'));
const f = project('no-tty');
const nt = spawnSync('setsid', ['-w', 'node', 'scripts/setup.js'], { cwd: f, env: cleanEnv(), encoding: 'utf-8', input: '' });
check('no terminal, no headless: exit 2, says how', nt.status === 2 && nt.stderr.includes('npm run setup') && !fs.existsSync(path.join(f, '.env')), `${nt.status} ${nt.stderr}`);

// ── install.sh ────────────────────────────────────────────────────────────────
section('install.sh with stubbed tools');
const BASIC = ['bash', 'sh', 'env', 'sed', 'awk', 'grep', 'df', 'uname', 'id', 'ls', 'mkdir', 'rm', 'mv', 'rmdir', 'cat', 'tail', 'dirname', 'touch'];
function toolbox(name, { git = true, npm = 'ok', node = 'real' } = {}) {
  const bin = path.join(SCRATCH, name, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const t of BASIC) {
    const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim();
    if (p) fs.symlinkSync(p, path.join(bin, t));
  }
  const log = path.join(SCRATCH, name, 'calls.log');
  const stub = (tool, sh) => fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "${log}"\n${sh}\n`, { mode: 0o755 });
  if (git) stub('git', 'if [ "$1" = clone ]; then for a; do t=$a; done; mkdir -p "$t"; printf \'{"name": "karyasthan"}\' > "$t/package.json"; fi');
  if (npm === 'ok') stub('npm', 'exit 0');
  else if (npm === 'gyp') stub('npm', 'if [ "$1" = ci ]; then echo "gyp ERR! build error"; [ -f "$(dirname "$0")/npm-fixed" ] && exit 0; exit 1; fi; exit 0');
  if (node === 'real') fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  else if (node) stub('node', `[ "$1" = "-v" ] && { echo ${node}; exit 0; }; exit 1`);
  return { bin, log, cwd: path.join(SCRATCH, name) };
}
const INSTALL = path.join(ROOT, 'install.sh');
function runInstall(box, env = {}, script = INSTALL) {
  // setsid: no controlling terminal, as under cron or CI.
  return spawnSync(SETSID_PATH, ['-w', 'bash', script], {
    cwd: box.cwd, encoding: 'utf-8', input: '',
    env: { PATH: box.bin, HOME: path.join(box.cwd, 'home'), KARYASTHAN_ALLOW_ROOT: '1', ...env },
  });
}
const SETSID_PATH = spawnSync('bash', ['-c', 'command -v setsid'], { encoding: 'utf-8' }).stdout.trim();
const SETSID = Boolean(SETSID_PATH);
if (!SETSID) {
  console.log('  skip  no `setsid` command here');
} else {
  const callsOf = (b) => (fs.existsSync(b.log) ? fs.readFileSync(b.log, 'utf-8') : '');
  const t1 = toolbox('missing', { git: false, npm: false, node: false });
  const m = runInstall(t1);
  const mout = m.stdout + m.stderr;
  check('everything missing is listed at once, exit 3', m.status === 3 && mout.includes('git is missing') && mout.includes('Node.js is missing') && mout.includes('npm is missing'), mout);

  const t2 = toolbox('old-node', { node: 'v18.19.0' });
  const o = runInstall(t2);
  check('old Node: says how to fix it, exit 3', o.status === 3 && (o.stdout + o.stderr).includes('nvm install 22'), o.stdout + o.stderr);

  const t3 = toolbox('node21', { node: 'v21.7.0' });
  const n21 = runInstall(t3, { KARYASTHAN_NONINTERACTIVE: '1' });
  check('Node 21: warns it has to compile, carries on', n21.stdout.includes('no ready-made build') && n21.status === 0, n21.stdout + n21.stderr);

  const t4 = toolbox('retry', { npm: 'gyp' });
  const first = runInstall(t4, { KARYASTHAN_NONINTERACTIVE: '1' });
  const fo = first.stdout + first.stderr;
  check('no compiler doesn\'t stop it before trying', callsOf(t4).includes('npm ci'), callsOf(t4));
  check('a build failure: one cause, exit 1', first.status === 1 && fo.includes('couldn\'t be compiled') && fo.includes('Then run this again'), fo);
  check('the full log is kept', fs.readFileSync(path.join(t4.cwd, 'karyasthan/logs/install.log'), 'utf-8').includes('gyp ERR'));
  fs.writeFileSync(path.join(t4.bin, 'npm-fixed'), '');
  const second = runInstall(t4, { KARYASTHAN_NONINTERACTIVE: '1' });
  check('running it again carries on, no second clone', second.status === 0 && second.stdout.includes('Found your earlier attempt') && callsOf(t4).split('git clone').length === 2, second.stdout + second.stderr);
  check('...and reaches setup', callsOf(t4).includes('npm run --silent setup'));

  const t5 = toolbox('taken');
  fs.mkdirSync(path.join(t5.cwd, 'karyasthan'), { recursive: true });
  fs.writeFileSync(path.join(t5.cwd, 'karyasthan/notes.txt'), 'mine');
  const tk = runInstall(t5);
  check('a folder that isn\'t ours: exit 3, untouched', tk.status === 3 && fs.readdirSync(path.join(t5.cwd, 'karyasthan')).join() === 'notes.txt', tk.stdout + tk.stderr);

  const t6 = toolbox('empty');
  fs.mkdirSync(path.join(t6.cwd, 'karyasthan'), { recursive: true });
  const em = runInstall(t6, { KARYASTHAN_NONINTERACTIVE: '1' });
  check('an empty folder is simply used', em.status === 0 && fs.existsSync(path.join(t6.cwd, 'karyasthan/package.json')), em.stdout + em.stderr);

  const t7 = toolbox('no-terminal');
  const nx = runInstall(t7);
  check('no terminal: code and packages done, exit 2, says how to finish', nx.status === 2 && nx.stdout.includes('cd "karyasthan" && npm run setup'), nx.stdout + nx.stderr);

  const t8 = toolbox('working');
  const live = path.join(t8.cwd, 'karyasthan');
  fs.mkdirSync(path.join(live, 'node_modules/@whiskeysockets/baileys'), { recursive: true });
  fs.mkdirSync(path.join(live, 'node_modules/better-sqlite3'), { recursive: true });
  fs.writeFileSync(path.join(live, 'package.json'), '{"name": "karyasthan"}');
  fs.writeFileSync(path.join(live, 'node_modules/better-sqlite3/index.js'), 'module.exports = () => ({ close() {} });');
  const wk = runInstall(t8, { KARYASTHAN_NONINTERACTIVE: '1' });
  check('working packages are left alone: no npm ci under a running bot', wk.status === 0 && !callsOf(t8).includes('npm ci') && wk.stdout.includes('already installed'), wk.stdout + callsOf(t8));

  const t9 = toolbox('cut');
  const src = fs.readFileSync(INSTALL, 'utf-8');
  const cutPath = path.join(t9.cwd, 'cut.sh');
  let ranAny = false;
  for (const frac of [0.25, 0.5, 0.75, 0.95]) {
    fs.writeFileSync(cutPath, src.slice(0, Math.floor(src.length * frac)));
    const cut = runInstall(t9, {}, cutPath);
    if (cut.stdout.includes('Karyasthan installer') || fs.existsSync(t9.log)) ranAny = true;
  }
  check('a cut-off download runs nothing', !ranAny);
}

try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
