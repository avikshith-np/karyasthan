// 012 guards (static + catalogue): the influence layer sits behind the life
// facade, sends nothing, writes no config, keeps its tables to its store, logs
// codes only; the chat-forbidden families are unchanged and actor `chat` still
// writes only inert pointers.
import { setupScratchDb, PROJECT_ROOT, section, check, eq, report, throws } from './_helpers.js';
import fs from 'fs';
import path from 'path';

await setupScratchDb();
const eventLog = await import('../../src/life/eventLog.js');
const life = await import('../../src/life/index.js');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(PROJECT_ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
const src = walk(path.join(PROJECT_ROOT, 'src'));
const read = (f) => fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf-8');
const influenceFiles = src.filter(f => f.startsWith('src/life/influence/'));

section('placement');
check('the influence layer exists (non-vacuous)', influenceFiles.length >= 6, influenceFiles);
const importsFacade = src.filter(f => !f.startsWith('src/life/influence/') && /from\s+['"][^'"]*influence\/index\.js['"]/.test(read(f)));
eq('only src/life/index.js imports influence/index.js', importsFacade, ['src/life/index.js']);
const importsInternals = src.filter(f => !f.startsWith('src/life/influence/')
  && /from\s+['"][^'"]*\/influence\/(?!index\.js)[a-zA-Z]+\.js['"]/.test(read(f)));
eq('…and nothing outside imports its internals but the projector\'s pure mood math', importsInternals, ['src/life/projector.js']);
check('the projector imports only influence/mood.js', /from '\.\/influence\/mood\.js'/.test(read('src/life/projector.js'))
  && !/influence\/(?!mood\.js)/.test(read('src/life/projector.js').replace(/\/\/.*$/gm, '')));
check('the dashboard route reaches it only through the life facade', !/influence\//.test(read('src/dashboard/routes/influence.js').replace(/\/\/.*$/gm, '').replace(/'\/api\/influence[^']*'/g, '')));
const storyImports = influenceFiles.filter(f => /from\s+['"][^'"]*story\//.test(read(f)));
eq('nothing under influence/ imports a story module (controls come through the facade)', storyImports, []);

section('authority');
const FORBIDDEN = ['sendText', 'sendMessage', 'updateConfig', 'persistEnvDiff', 'writeEnvVars', 'setSkillEnabled', 'updateLlmKeys',
  'muteGroup', 'unmuteGroup', 'auditWrite('];
const hits = [];
for (const f of influenceFiles) {
  const code = read(f).replace(/\/\/.*$/gm, '');
  for (const n of FORBIDDEN) if (code.includes(n) && !(n === 'auditWrite(' && f.endsWith('hooks.js'))) hits.push(`${f}:${n}`);
  if (/whatsapp\/actions\.js|dashboard\/routes\//.test(code)) hits.push(`${f}:imports actions/routes`);
}
eq('no sends, config/env/skill writers or route imports under influence/ (hooks may audit)', hits, []);
check('the mind lever allow-list does not know chat influence', !/chatInfluence/.test(read('src/mind/levers.js')));

section('tables');
const SQL = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(chat_influence_\w+)/i;
const sqlFiles = src.filter(f => SQL.test(read(f)));
eq('v12 SQL only in the influence store and the migration', sqlFiles.sort(),
  ['src/life/influence/store.js', 'src/memory/migrations/012-chat-influence.js']);

section('logging (codes and ids only)');
const leaks = [];
for (const f of influenceFiles) {
  const code = read(f);
  const re = /logger\.(?:info|warn|debug|error)\(([\s\S]*?)\);/g;
  for (let m; (m = re.exec(code));) {
    if (/\b(content|text|excerpt|earlier|row\.|msg\.|answers)\b/.test(m[1])) leaks.push(`${f}: ${m[1].slice(0, 80)}`);
  }
}
eq('no logger call carries content/text/excerpts', leaks, []);

section('processTurn: the perception starts at the gate\'s verdict');
{
  const idx = read('src/index.js');
  const gateFn = idx.slice(idx.indexOf('async function applyLifeGate('), idx.indexOf('\n}\n', idx.indexOf('async function applyLifeGate(')));
  check('perceiveChat is called with influence:false (009 matcher only)', /perceiveChat\(msg, context\.audience, \{ \.\.\.perceiveCtx, influence: false \}\)/.test(idx));
  check('…and perceiveInfluence only from applyLifeGate\'s verdict hook', (idx.match(/perceiveInfluence\(/g) || []).length === 1
    && /applyLifeGate\(sock, msg, context, turn, turnStale,\s*\(verdict\) => lifeSafe\(\(\) => perceiveInfluence\(msg, context\.audience, perceiveCtx, verdict\)/.test(idx));
  const tellAt = gateFn.indexOf('tell(gate.outcome)');
  const firstAwait = gateFn.search(/^(?!\s*\/\/).*\bawait\b/m);
  check('…told synchronously: before the gate\'s first await, and on a failed gate (error)', tellAt > 0 && firstAwait > tellAt
    && /const failOpen = [^\n]*\n[^\n]*\n\s*tell\('error'\);/.test(gateFn));
}

section('catalogue');
const NEW = ['chat.perceived', 'mood.chat', 'sleep.delayed', 'work.behind', 'invite.answered', 'invite.followed_up', 'chat.load'];
eq('the 012 types, exactly', [...eventLog.INFLUENCE_EVENT_TYPES].sort(), [...NEW].sort());
check('…all in the catalogue', NEW.every(t => eventLog.EVENT_TYPES.has(t)));
check('…none of them chat-forbidden', NEW.every(t => !eventLog.CHAT_FORBIDDEN_TYPES.has(t)));
// 011 (story prompt) adds its own list (STEER_EVENT_TYPES) and the one prefix 'goal.'.
const STEER = eventLog.STEER_EVENT_TYPES;
// 014 geo adds its own list (GEO_EVENT_TYPES) and the one prefix 'route.'; 014 sched its two
// schedule overrides (prefix 'schedule.'); 015 (Director as god) GOD_EVENT_TYPES, every one chat-forbidden.
const GEO = eventLog.GEO_EVENT_TYPES;
const SCHED = eventLog.SCHEDULE_EVENT_TYPES;
const GOD = eventLog.GOD_EVENT_TYPES;
// 016 (scene play-outs) SCENE_EVENT_TYPES: exactly scene.followup / scene.followup_lapsed are chat-forbidden.
const SCENE = eventLog.SCENE_EVENT_TYPES;
// Wake him: its owner wake.set, chat-forbidden (an exact entry).
const WAKE = eventLog.WAKE_EVENT_TYPES;
// 018: the wallet's cut-over, chat-forbidden (an exact entry).
const WALLET = eventLog.WALLET_EVENT_TYPES;
const PRE_012 = [...eventLog.EVENT_TYPES].filter(t => !eventLog.INFLUENCE_EVENT_TYPES.has(t) && !STEER.has(t) && !GEO.has(t) && !SCHED.has(t) && !GOD.has(t) && !SCENE.has(t) && !WAKE.has(t) && !WALLET.has(t));
const PREFIXES = ['career.', 'family.', 'heavy.', 'arc.', 'story.', 'cast.', 'place.', 'sick.'];
const EXACT = ['relationship.changed', 'vitals.nudged', 'money.salary'];
eq('CHAT_FORBIDDEN_TYPES is the pre-012 set + the 011 goal.* types + route.* + schedule.* + every 015 type + the 016 follow-ups + wake.set + 018 wallet.started + the 019 phone types', [...eventLog.CHAT_FORBIDDEN_TYPES].sort(),
  [...PRE_012.filter(t => EXACT.includes(t) || PREFIXES.some(p => t.startsWith(p))), ...[...STEER].filter(t => t.startsWith('goal.')),
    ...[...GEO].filter(t => t.startsWith('route.')), ...[...SCHED].filter(t => t.startsWith('schedule.')), ...GOD,
    'scene.followup', 'scene.followup_lapsed', ...WAKE, ...WALLET, ...eventLog.PHONE_EVENT_TYPES].sort());
eq('…CHAT_FORBIDDEN_TYPES ∩ GOD = GOD (every god type is chat-forbidden)', [...GOD].filter(t => eventLog.CHAT_FORBIDDEN_TYPES.has(t)).sort(), [...GOD].sort());
eq('…of the 011 list exactly goal.* is chat-forbidden', [...STEER].filter(t => eventLog.CHAT_FORBIDDEN_TYPES.has(t)).sort(),
  [...STEER].filter(t => t.startsWith('goal.')).sort());
check('…which still holds the families chats must never reach', ['sick.started', 'heavy.started', 'money.salary', 'career.job_changed',
  'cast.created', 'place.created', 'relationship.changed', 'vitals.nudged'].every(t => eventLog.CHAT_FORBIDDEN_TYPES.has(t)));
eq('selfEventTypes leaves the influence types out', life.selfEventTypes().filter(t => NEW.includes(t)), []);
check('…the revertible ones are revertible', NEW.filter(t => t !== 'invite.followed_up').every(t => life.REVERTIBLE_TYPES.has(t)));
check('…a follow-up record is not (it records a sent message)', !life.REVERTIBLE_TYPES.has('invite.followed_up'));

section('actor chat writes only pointers');
const G = '120363000000770001@g.us';
const g = eventLog.appendEvent({ type: 'genesis', at: 1793000000, actor: 'engine', payload: {} });
void g;
for (const type of ['mood.chat', 'sleep.delayed', 'work.behind', 'invite.answered', 'invite.followed_up']) {
  throws(`actor chat cannot append ${type}`, () => eventLog.appendEvent({ type, at: 1793000100, actor: 'chat', originKind: 'group', originJid: G, payload: {} }), /actor chat cannot/);
}
const ptr = eventLog.appendEvent({ type: 'chat.perceived', at: 1793000100, actor: 'chat', originKind: 'group', originJid: G, payload: { kind: 'affect' } });
check('a chat.perceived pointer with the chat origin is accepted', ptr?.actor === 'chat' && ptr.originJid === G);
throws('…but never with a self origin', () => eventLog.appendEvent({ type: 'chat.perceived', at: 1793000100, actor: 'chat', payload: {} }), /chat origin/);
const mood = eventLog.appendEvent({ type: 'mood.chat', at: 1793000100, actor: 'engine', causeId: ptr.id, payload: {} });
eq('an engine consequence inherits the chat origin', [mood.originKind, mood.originJid], ['group', G]);
throws('…and cannot launder it into self', () => eventLog.appendEvent({ type: 'mood.chat', at: 1793000100, actor: 'engine', causeId: ptr.id,
  originKind: 'self', originJid: 'self', payload: {} }), /does not match/);

report();
