// T023 — the prompt seams in src/personality/systemPrompt.js (quickstart §2 row 12;
// FR-014, FR-019, FR-036, SC-007): the reviewed self-model in the cached core
// (byte-stable until a new version), the self-state line + replyLength line only in
// the per-turn tail and outside life's block (also on the opener and force-respond
// paths), "Recently:" ≤ 2 × 240 chars, nothing while imitating, and the golden rule:
// with the mind skill off, mind data present changes nothing at all.
// Real skill registry, real facade, scratch DB, no network, no model.
import {
  setupScratchDb, blockNetwork, seedPerson, seedGroup, seedMessage, setBot,
  section, check, eq, throws, report, DAY, HOUR,
} from './_helpers.js';

const { db } = await setupScratchDb();
blockNetwork();
const skills = await import('../../src/skills/skillRunner.js');
const store = await import('../../src/mind/store.js');
const knobsMod = await import('../../src/mind/knobs.js');
const ss = await import('../../src/mind/selfState.js');
const { BLOCK_HEAD } = await import('../../src/mind/selfModel.js');
const mind = await import('../../src/mind/index.js');
const sp = await import('../../src/personality/systemPrompt.js');
const relationshipStore = await import('../../src/memory/relationshipStore.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
await import('../../src/life/index.js');
await new Promise(r => setImmediate(r));          // selfState's lazy life import settles

await skills.loadSkills();
skills.setSkillEnabled('mind', false);
await setBot();

const NOW = Math.floor(Date.now() / 1000);
const longAgo = NOW - 100 * DAY;
const A = await seedPerson({ jid: '83001@lid', name: 'Avery' });
const B = await seedPerson({ jid: '83002@lid', name: 'Blake' });
const C = await seedPerson({ jid: '83003@lid', name: 'Casey' });
const G = await seedGroup({ jid: '120363000000083001@g.us', name: 'Trail club',
  members: [{ jid: A, joinedAt: longAgo }, { jid: B, joinedAt: longAgo }], at: longAgo });

const gLines = [];
for (const [i, [sender, text]] of [[A, 'anyone up for the hike on saturday'], [B, 'only if we start late'],
  [A, 'nine is late enough'], [B, 'fine, nine it is']].entries()) {
  gLines.push(await seedMessage({ chat: G, sender, text, ts: NOW - 3 * HOUR + i * 120 }));
}
await seedMessage({ chat: A, sender: A, text: 'are you coming saturday?', ts: NOW - 2 * HOUR });
await seedMessage({ chat: C, sender: C, text: 'hey, long time', ts: NOW - 2 * HOUR });
// Evidence for A's DM episode (newer than the G episodes, so it ranks first in A's DM).
const dmEv = await seedMessage({ chat: A, sender: A, text: 'got the offer letter today', ts: NOW - 90 * 60 });

const audG = () => resolveAudience({ chatJid: G, kind: 'group' });
const audA = () => resolveAudience({ chatJid: A, kind: 'dm' });
const audC = () => resolveAudience({ chatJid: C, kind: 'dm' });

/** Everything a reply turn sends for this chat: core, profile and the user message. */
function render(chatJid, { audience = null, imitation = null, opts = {} } = {}) {
  const isGroup = chatJid.endsWith('@g.us');
  const aud = audience || resolveAudience({ chatJid, kind: isGroup ? 'group' : 'dm' });
  const parts = sp.buildSystemParts(chatJid, isGroup, imitation, { audience: aud, track: false });
  const ctx = sp.buildConversationContext(chatJid, null, isGroup, { audience: aud, imitation, track: false, ...opts });
  return { core: parts.core, profile: parts.profile, user: ctx.text };
}
const all = (r) => `${r.core}\n${r.profile}\n${r.user}`;
const MIND_STRINGS = [BLOCK_HEAD, ss.SELF_NOTE, 'How you are today', '## Recently:', 'Keep replies brief', 'You are texting first'];
const hasMind = (s) => MIND_STRINGS.filter(m => s.includes(m));
const tailOf = (user) => user.split('===END OF CONVERSATION===')[1] || '';
const headOf = (user) => user.split('===CONVERSATION===')[0];

// ── golden: before any mind data ───────────────────────────────────────────
section('golden: mind skill off');
const LIFE_OPT = { life: { lines: { inner: 'tired after work' } } };
const before = { g: render(G), a: render(A), c: render(C), call: sp.buildSystemPrompt(A, false, null, audA(), { track: false }),
  life: render(G, { opts: LIFE_OPT }) };
eq('no mind strings anywhere before mind data', [all(before.g), all(before.a), all(before.c), before.call].flatMap(hasMind), []);

// Mind data: a self-model version, a base mood, a today note from G, three G
// episodes (one too long), a DM episode for A, a replyLength nudge.
await mind.owner.editSelfModel('Keeps it short and dry; teases rather than lectures.', 'owner:test');
ss.applyBaseMood({ word: 'calm', intensity: 0.5 }, { runId: null });
const dG = store.insertDigest({ chatJid: G, originKind: 'group', fromRowid: 0, toRowid: gLines.at(-1).rowid,
  periodStart: NOW - 3 * HOUR, periodEnd: NOW - 2 * HOUR, summary: 'a summary', todayNote: 'settled the hike start time',
  tone: 'warm', threads: [], evidence: gLines.map(m => ({ msgId: m.id, ts: m.ts })) });
ss.applyToday([{ digestId: dG, chatJid: G }]);
const ep = (content, attribute, originKind = 'group', originJid = G, ev = gLines[0]) => relationshipStore.addMemory({
  category: 'episode', subjectJid: null, source: 'mind', importance: 0.5, originKind, originJid, attribute, content,
  evidence: [{ msgId: ev.id, ts: ev.ts }] }).id;
ep('The group argued about the hike start and landed on nine.', 'day:a');
ep(`A long night of plans: ${'they went back and forth about the route and snacks and who drives '.repeat(6)}`, 'day:b');
ep('A third, older group night that should not show.', 'day:c');
ep('He and Avery talked about a job offer.', 'day:dm', 'dm', A, dmEv);
store.insertNudge({ knob: 'replyLength', scope: 'global', prevValue: 'normal', value: 'shorter', requested: 'shorter',
  band: { allowed: ['shorter', 'normal'] }, reason: 'test', status: 'active', expiresAt: NOW + DAY });
knobsMod.reload();

const off = { g: render(G), a: render(A), c: render(C), call: sp.buildSystemPrompt(A, false, null, audA(), { track: false }) };
eq('skill off with mind data present → group prompt byte-identical', off.g, before.g);
eq('…DM prompt byte-identical', off.a, before.a);
eq('…non-member DM prompt byte-identical', off.c, before.c);
eq('…call prompt (buildSystemPrompt) byte-identical', off.call, before.call);
eq('…reply-path render with a life option byte-identical', render(G, { opts: LIFE_OPT }), before.life);

// ── mind on ────────────────────────────────────────────────────────────────
section('mind on: self-model in core, byte-stable');
skills.setSkillEnabled('mind', true);
const on1 = render(G);
const on2 = render(G);
check('core carries the self-model block', on1.core.includes(BLOCK_HEAD) && on1.core.includes('teases rather than lectures'));
eq('core byte-identical across two turns', on1.core, on2.core);
eq('core = the pre-008 core with the block between identity and manuals',
  on1.core.replace(`\n\n${BLOCK_HEAD}\nKeeps it short and dry; teases rather than lectures.`, ''), before.g.core);
eq('profile unchanged', on1.profile, before.g.profile);
check('no self-state or episode text in core/profile',
  !/How you are today|Recently:|Keep replies brief|hike/.test(on1.core + on1.profile));
eq('the DM core gets the same block', render(A).core, on1.core.replace(before.g.core, before.a.core));
await mind.owner.editSelfModel('Keeps it short and dry; asks one good question.', 'owner:test');
const on3 = render(G);
check('a new active version changes the core', on3.core !== on1.core && on3.core.includes('asks one good question'));
eq('…and is stable again', render(G).core, on3.core);

section('mind on: self-state line and replyLength only in the per-turn tail');
{
  const tail = tailOf(on1.user);
  const want = `${ss.SELF_NOTE}\nHow you are today: calm; settled the hike start time.\nKeep replies brief.`;
  check('tail carries note → line → replyLength', tail.includes(want), tail.slice(-700));
  check('the line sits before the output-discipline rule', tail.indexOf('How you are today') < tail.indexOf('Output ONLY the final message'));
  check('…and not in the recall head or transcript', !headOf(on1.user).includes('How you are today')
    && !on1.user.split('===END OF CONVERSATION===')[0].includes('How you are today'));
  const lineLen = (tail.match(/How you are today:[^\n]*/) || [''])[0].length;
  check('line ≤ 160 chars', lineLen > 0 && lineLen <= 160, lineLen);
  // Audience: G's today note never reaches a non-member's DM.
  const cTail = tailOf(render(C).user);
  check('non-member DM: the G today note is filtered out', !cTail.includes('hike') && cTail.includes('How you are today: calm.'), cTail.slice(-300));
  // Life block emitted its situation note → no SELF_NOTE; the line still follows, outside life's block.
  const withLife = tailOf(render(G, { opts: LIFE_OPT }).user);
  const iLife = withLife.indexOf('tired after work');
  const iLine = withLife.indexOf('How you are today');
  check('with life lines: the mind line comes right after life\'s block', iLife >= 0 && iLine > iLife, [iLife, iLine]);
  check('…and SELF_NOTE is not repeated', !withLife.includes(ss.SELF_NOTE));
}

section('mind on: Recently: in the recall head');
{
  const head = headOf(on1.user);
  const block = head.slice(head.indexOf('## Recently:'));
  const items = block.split('\n').filter(l => l.startsWith('- '));
  check('Recently: present in the group head', head.includes('## Recently:'));
  check('≤ 2 episodes', items.length === 2, items);
  check('each ≤ 240 chars', items.every(l => l.length - 2 <= 240), items.map(l => l.length));
  check('the DM episode never reaches the group', !head.includes('job offer'));
  check('A\'s DM sees its own episode', headOf(render(A).user).includes('job offer'));
  check('C\'s DM (not in G) sees no G episode', !headOf(render(C).user).includes('## Recently:'));
}

section('mind on: opener and force-respond paths (triggerMsg null, no life option)');
{
  const op = render(G, { opts: { opener: { kind: 'share', intent: 'ask how the\nhike went' } } });
  const tail = tailOf(op.user);
  check('opener instruction replaces the reply instruction', tail.includes(mind.openerText('ask how the hike went'))
    && !tail.includes('Reply as ') && !tail.includes('>>>'), tail.slice(0, 400));
  check('opener carries the self-state line', tail.includes('How you are today'));
  check('opener keeps the transcript and recall head', op.user.includes('nine it is') && op.user.includes('## Recently:'));
  eq('opener core = reply core', op.core, render(G).core);
  check('DM opener', tailOf(render(A, { opts: { opener: { kind: 'check_in', intent: 'check in' } } }).user).includes('in this DM'));
  throws('an opener without an intent throws (the draft is dropped)', () => render(G, { opts: { opener: { kind: 'x', intent: '  ' } } }), /intent/);
  const force = tailOf(render(G).user);
  check('force-respond path (no life opt) carries the line', force.includes('How you are today'));
}

section('mind on: imitating → no block, no line, no replyLength, no Recently:');
{
  const imitation = { targetJid: A, label: 'Avery', aliases: [], styleCard: null, exemplars: [], enabledAt: NOW - HOUR };
  const im = render(G, { imitation });
  eq('no mind strings while imitating', hasMind(all(im)), []);
}

section('mind off again → back to the golden');
{
  skills.setSkillEnabled('mind', false);
  eq('group prompt identical to the pre-mind golden', render(G), before.g);
  eq('DM prompt identical to the pre-mind golden', render(A), before.a);
}

report();
