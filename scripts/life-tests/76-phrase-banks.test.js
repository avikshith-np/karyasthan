// Plan 020 H2: the phrase banks. The switch off changes nothing; on, only the words change: the same lines drawn, the
// same repeat memory, the same random stream. The checks on a line and on a whole bank (placeholders, length at its worst,
// names, identifiers, sexual and graphic words, fixation), the loader's fallbacks (missing, corrupted, wrong shape, partial, a
// slot with no entries, English changed since), the generator's gates (a hard cap, unpriced, ledger, a fallen-back call, a failed
// checking pass), and that the site's filter still lets his lines through. A stub model only; no key, no network.
import { section, check, eq, report, setupScratchDb, PROJECT_ROOT, SCRATCH_DB_REL } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { config, getPersona } from '../../src/utils/config.js';
import { BANKS, SURFACE_CAP, WIDTHS, MAX_VARIANTS, bankContext, capFixation, catalogueHash, chooseVariant, englishBank, healthOf, lineProblem, makeChecker, slotCatalogue, timeOfDay, validateBank } from '../../src/life/phraseCheck.js';
import { __setBankForTest, bankStatus, bankVersion, loadPhraseBank, phraseBankView, voiceLine, EXAMPLE_PATH, PHRASES_PATH } from '../../src/life/phraseBank.js';
import { HARD_MAX_USD, buildSystem, dropBadLines, estimateRun, generateBank, parseBatch, planBatches, reviewBank, stubCallModel } from '../../src/life/phraseGen.js';
import { tickThoughts } from '../../src/life/thoughts.js';
import { buildBase, walkSession, lineParts } from '../../src/life/liveSession.js';
import { rngFor } from '../../src/life/rng.js';
import { dreamWordWidths, fragmentOf } from '../../src/life/story/dreams/plan.js';
import { WORDLESS } from '../../src/life/thoughtPhrases.js';
import { PRIVATE, TOPIC_WORDS } from '../../src/life/livePhrases.js';
import { makeScrubber } from '../../src/public/scrub.js';
import { contentProblem } from '../../src/life/story/desire.js';

// The persona's words, from the files (ARCS_GUARD_PERSONA_FILE for a real install's), never listed here. "English" is what the English lines are.
function personaTerms() {
  const personas = [getPersona(), JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/persona.example.json'), 'utf-8'))];
  if (process.env.ARCS_GUARD_PERSONA_FILE) personas.push(JSON.parse(fs.readFileSync(process.env.ARCS_GUARD_PERSONA_FILE, 'utf-8')));
  const out = new Set();
  for (const p of personas) {
    for (const v of [p.name, p.displayName, ...(p.aliases ?? [])]) if (typeof v === 'string' && v.trim().length >= 3) out.add(v.trim());
    for (const v of [p.region, p.city, p.language, p.voiceDescriptor]) if (typeof v === 'string') for (const part of v.split(/[,/;|()+&]+/)) if (part.trim().length >= 3) out.add(part.trim());
  }
  out.delete('English');
  return [...out];
}
const wordIn = (src, term) => new RegExp(`(^|[^\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'iu').test(src);

const SCRATCH = path.join(PROJECT_ROOT, 'data', `phrases-test-${process.pid}`);
fs.mkdirSync(SCRATCH, { recursive: true });
const FILE = path.join(SCRATCH, 'phrases.json');
const write = (doc) => fs.writeFileSync(FILE, typeof doc === 'string' ? doc : JSON.stringify(doc));
const doc = (banks, extra = {}) => ({ v: 1, version: 'gen-1', generatedAt: 1, model: 'stub', catalogue: catalogueHash(), banks, ...extra });
const on = (v = true) => { config.life.phraseBanks = v; };
const checker = makeChecker({ contentProblem, realNames: ['Rhea Stone'], castNames: ['Ana Reed'], personaNames: ['Zedkay'], personaWords: ['Eastern Shore'], venueNames: ['Blue Door Cafe'], properNouns: ['Faraway'], banned: ['biscuits'] });

section('the catalogue: every line once, what stays out stays out');
{
  const c = slotCatalogue();
  check('thoughts, live lines and dream fragments all have slots', c.thought.size > 400 && c.live.size > 250 && c.dream.size >= 20, { t: c.thought.size, l: c.live.size, d: c.dream.size });
  for (const w of [...WORDLESS.private, ...WORDLESS.heavy]) check(`a private or heavy line stays out: ${w}`, !c.thought.has(w) || Object.entries(WORDLESS).some(([k, v]) => !['private', 'heavy'].includes(k) && v.includes(w)));
  for (const w of PRIVATE) check(`a private live line stays out: ${w}`, !c.live.has(w));
  check('the topic words stay out: the scene sheet reads them', !Object.values(TOPIC_WORDS).flat().some(w => c.live.has(w)));
  const widths = dreamWordWidths();
  check('the dream widths cover the longest task and twist', widths.task <= WIDTHS.dream.task && widths.twist <= WIDTHS.dream.twist, widths);
}

section('the committed example is today\'s English, and passes');
{
  const onDisk = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8'));
  eq('phrases.example.json matches the code (npm: node scripts/gen-phrases.js --example)', onDisk.banks, englishBank().banks);
  const v = validateBank(onDisk);
  check('it validates, nothing dropped', v.ok && !Object.keys(v.rejected).length, v.rejected);
  eq('it voices nothing', BANKS.map(b => v.coverage[b].voiced), [0, 0, 0]);
  eq('and warns of nothing', v.warnings, []);
}

section('one line: what may not pass');
{
  const p = (t, source = 'ugh, rain', bank = 'thought') => lineProblem(t, bank, source, checker);
  eq('a line in another voice passes', p('ayyo, maku pinneyum'), null);
  eq('the English itself always passes', p('ugh, rain'), null);
  eq('empty', p('  '), 'empty');
  eq('an unknown placeholder', p('{nmae} again', '{name} again'), 'unknown_placeholder');
  eq('a placeholder lost', p('again and again', '{name} again'), 'placeholder_mismatch');
  eq('a placeholder added', p('{name} again, {plan}', '{name} again'), 'placeholder_mismatch');
  eq('a placeholder from another bank', p('{place} again', '{name} again'), 'unknown_placeholder');
  eq('a stray brace', p('{name again', 'name again'), 'bad_brace');
  eq('a marker', p('[IMAGE: rain]'), 'markup');
  eq('a speech tag', p('<laugh> rain'), 'markup');
  eq('a phone number', p('call 98470 12345'), 'identifier');
  eq('digits', p('room 404'), 'identifier');
  eq('a link', p('see rain.com'), 'identifier');
  eq('an @', p('@rain'), 'identifier');
  eq('a real full name', p('Rhea Stone again'), 'real_name');
  eq('a real first name in lower case', p('rhea again'), 'real_name');
  eq('a cast name, spelled out', p('ana again'), 'name');
  eq('his own name', p('zedkay, maku'), 'name');
  eq('a venue name', p('blue door cafe again'), 'venue');
  eq('the region', p('eastern shore rain'), 'persona_word');
  eq('a proper noun from his identity', p('rain in faraway'), 'name');
  eq('a word the owner banned', p('rain and biscuits'), 'fixated');
  eq('an invented name', p('rain and Marcus'), 'invented_name');
  eq('nothing sexual', p('naked in the rain'), 'sexual');
  eq('nothing graphic', p('blood in the rain'), 'graphic');
  eq('the desire module\'s check is asked', lineProblem('maku kesu', 'thought', 'ugh, rain', makeChecker({ contentProblem: () => 'explicit' })), 'sexual');
  eq('a word the English has is no new risk', lineProblem('throat again going', 'thought', "throat's going", checker), null);
  eq('a name in the English line stays allowed', lineProblem('Marcus maku', 'thought', 'Marcus rain', checker), null);
  eq('a dream sentence may start with a capital', lineProblem('Oruz {place} ayrun. Pinzel {twist}.', 'dream', 'Something about {place}, {twist}. It made sense at the time.', checker), null);
  eq('but a name inside a dream sentence is refused', lineProblem('oruz {place} and Marcus {twist}.', 'dream', 'Something about {place}, {twist}. It made sense at the time.', checker), 'invented_name');
  eq('a word nobody can wrap at 320 px', lineProblem('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rain', 'thought', 'should have brought an umbrella', checker), 'long_word');
  eq('a clipped line stays clipped', p('ugh it is raining again and I did not bring anything for it at all today'), 'too_long');
  eq('another script is fine', p('ωχ βροχη'), null);
  eq('a zero-width joiner inside a word of another script is fine', p('βρο\u200dχη'), null);
  eq('a bidi control is not', p('rain\u202emaku'), 'control');
}

section('a word the English has is that word, not its whole list (batch 3, 29)');
{
  const throat = "throat's going";
  for (const line of ['bleeding from the throat, drowning', 'choked and strangled', 'throat going, wounded', 'somebody died, throat']) {
    eq(`refused on a throat line: ${line}`, lineProblem(line, 'thought', throat, checker), 'graphic');
    eq(`…and on any other: ${line}`, lineProblem(line, 'thought', 'ugh, rain, again and again, ugh', checker), 'graphic');
  }
  eq('the word itself still passes', lineProblem('throat again, ayzo', 'thought', throat, checker), null);
  eq('in any case', lineProblem('THROAT again, ayzo', 'thought', throat, makeChecker({})), null);
  eq('the other graphic list', lineProblem('blood test, then murder', 'thought', 'blood test today', checker), 'graphic');
  eq('…its word alone passes', lineProblem('blood test aayzo', 'thought', 'blood test today', checker), null);
  eq('the sexual list', lineProblem('a kiss, then naked', 'thought', 'a kiss on the cheek', checker), 'sexual');
  eq('…its word alone passes', lineProblem('oru kiss, zuvo', 'thought', 'a kiss on the cheek', checker), null);
}

section('every word of a real name, in any case (batch 3, 30)');
{
  const names = makeChecker({ realNames: ['K Ann', 'Dr. Maris', 'Rahul Varnell', 'Brin🌸', 'Zoë Müller', 'K มานี'] });
  const say = (t, source = 'should have brought an umbrella') => lineProblem(t, 'thought', source, names);
  for (const line of ['ann would say so', 'maris would say so', 'varnell would say so', 'rahul would say so', 'brin would say so', 'muller would say so', 'Varnell would say so', 'มานี would say so']) {
    eq(line, say(line), 'real_name');
  }
  eq('a one-letter or two-letter token is no name to refuse', [say('k would say so'), say('dr would say so')], [null, null]);
  eq('a word that only contains a name is fine', say('manuscript would say so'), null);
  eq('a word the English line has stays allowed', say('varnell again', 'varnell said it'), null);
  const bank = validateBank(doc({ thought: { 'ugh, rain': [{ t: 'ann again, ugh' }, { t: 'zuvo maku' }] } }), { realNames: ['K Ann'] });
  eq('a bank loses that line and keeps the rest', [bank.rejected.real_name, bank.lines.thought.get('ugh, rain').map(e => e.t)], [1, ['zuvo maku']]);
}

section('length: measured with the longest fill, so the site never drops his line');
{
  const scr = makeScrubber({});
  const fillWorst = (t, b) => t.replace(/\{([^{}]+)\}/g, (_, k) => 'x'.repeat(WIDTHS[b][k]));
  const passes = [
    ['thought', '{plan} with a very tired man', 'oh {plan} again'],
    ['live', '{she} looked at the time', '{she} clock lumo, entra cheyo inzel paru nel inzel'],
  ];
  for (const [b, s, t] of passes) {
    const problem = lineProblem(t, b, s, checker);
    if (problem === null) check(`a ${b} line that passes fits its surface at its worst`, fillWorst(t, b).length <= SURFACE_CAP[b]);
  }
  const big = '{plan} '.repeat(3).trim();
  eq('a thought too long once its plan is filled', lineProblem(big, 'thought', '{plan}', checker) !== null, true);
  // The whole composed line: place word, a topic and a detail, or the detail and the phone.
  check('two live parts and the place word stay under the site\'s 160', 20 + 3 + SURFACE_CAP.live + 3 + SURFACE_CAP.live <= 160);
  check('a thought at its cap fits the site\'s 80', SURFACE_CAP.thought <= 80);
  check('a dream at its cap fits the site\'s fragment', SURFACE_CAP.dream <= 160);
  check('a composed line stays clean for the scrubber', !scr.check('cafe · talking about work · maku kesu'));
}

section('the fixation guard: no word or emoji over its cap, whatever the slots');
{
  const sources = Array.from({ length: 300 }, (_, i) => `line ${i} here`);
  const lines = new Map(sources.map((s, i) => [s, [{ t: `lumbo vaakk${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + (i >> 5) % 26)}` }, { t: `verzo${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + (i >> 5) % 26)}` }]]));
  const removed = capFixation(lines, sources);
  const count = (w) => [...lines.values()].flat().filter(e => e.t.split(/\s+/).includes(w)).length;
  check('a word in every line is capped', count('lumbo') < 30 && removed.word_cap > 0, { n: count('lumbo'), removed });
  eq('a slot keeps its other line: it is emptied last', lines.size, sources.length);

  const sources2 = Array.from({ length: 200 }, (_, i) => `row ${i}`);
  const emoji = new Map(sources2.map((s, i) => [s, [{ t: `patzo${i} 😂` }, { t: `ketzo${i}` }]]));
  capFixation(emoji, sources2);
  eq('one emoji at most three times in a bank', [...emoji.values()].flat().filter(e => e.t.includes('😂')).length, 3);

  const sources3 = Array.from({ length: 200 }, (_, i) => `the row ${i}`);
  const theirs = new Map(sources3.map((s, i) => [s, [{ t: `the varia${i}` }]]));
  capFixation(theirs, sources3);
  eq('a word the English itself leans on keeps its share', [...theirs.values()].flat().filter(e => e.t.startsWith('the ')).length, 200);

  const sources4 = Array.from({ length: 200 }, (_, i) => `rowan ${i}`);
  const pet = new Map(sources4.map((s, i) => [s, [{ t: i < 40 ? `zelkova kazvo${i}` : `onzo${i}` }]]));
  capFixation(pet, sources4, { strict: ['zelkova'] });
  check('a word he overuses in real life gets a much lower cap', [...pet.values()].flat().filter(e => e.t.includes('zelkova')).length <= 2);

  const sources5 = Array.from({ length: 50 }, (_, i) => `same ${i}`);
  const dup = new Map(sources5.map((s) => [s, [{ t: 'ithzu thanzel' }]]));
  capFixation(dup, sources5);
  check('the same words can\'t stand in for every line', lines.size > 0 && [...dup.values()].flat().length <= 3);
}

section('the loader: fallbacks, never an exception');
{
  fs.rmSync(FILE, { force: true });
  let st = loadPhraseBank({ file: FILE });
  eq('missing → the example', [st.source, st.issue], ['example', 'missing']);
  on();
  eq('…and English', voiceLine('thought', 'ugh, rain', {}, 'x'), 'ugh, rain');
  check('no version recorded on a thought', bankVersion() === null);

  write('{ this is not json');
  st = loadPhraseBank({ file: FILE });
  eq('corrupted → the example, says why', [st.source, st.issue], ['example', 'corrupt']);
  eq('…and English', voiceLine('thought', 'ugh, rain', {}, 'x'), 'ugh, rain');

  for (const [why, bad, code] of [
    ['a wrong version', { ...doc({}), v: 2 }, 'invalid:bad_version'],
    ['an unknown key', { ...doc({}), extra: 1 }, 'invalid:bad_shape'],
    ['an unknown bank', doc({ other: {} }), 'invalid:bad_shape'],
    ['a list at the top', [1, 2], 'invalid:bad_shape'],
    ['no version', { v: 1, banks: {} }, 'invalid:bad_shape'],
    ['banks not an object', { v: 1, version: 'a', banks: [] }, 'invalid:bad_shape'],
  ]) {
    write(bad);
    st = loadPhraseBank({ file: FILE });
    eq(`${why} → refused`, [st.source, st.issue], ['example', code]);
  }
  write('x'.repeat(2_000_100));
  eq('too big → refused unread', loadPhraseBank({ file: FILE }).issue, 'too_big');
  const noExample = loadPhraseBank({ file: FILE, examplePath: path.join(SCRATCH, 'gone.json') });
  eq('no example either → still English', [noExample.source, voiceLine('thought', 'ugh, rain', {}, 'x')], ['none', 'ugh, rain']);

  // Partial: one slot voiced, a slot empty, an unknown placeholder, a line the code no longer has.
  write(doc({
    thought: { 'ugh, rain': [{ t: 'zuvo maku' }, { t: 'maku pinzel {nope}' }], 'rain. great': [], 'of course it\'s raining': [{ t: 'pinzel maku', foo: 1 }], 'a line long gone': [{ t: 'vere' }] },
  }, { partial: true }));
  st = loadPhraseBank({ file: FILE });
  eq('a partial bank loads', st.source, 'phrases.json');
  eq('the voiced slot speaks', voiceLine('thought', 'ugh, rain', {}, 'x'), 'zuvo maku');
  eq('a slot with no entries is English', voiceLine('thought', 'rain. great', {}, 'x'), 'rain. great');
  eq('a slot whose one entry was refused is English', voiceLine('thought', 'of course it\'s raining', {}, 'x'), 'of course it\'s raining');
  eq('a bank not in the file is English', voiceLine('live', 'just got here', {}, 'x'), 'just got here');
  eq('bad lines are counted', [st.rejected.unknown_placeholder, st.rejected.bad_entry, st.stale], [1, 1, 1]);
  check('and it says partial', st.warnings.includes('partial'), st.warnings);
  eq('the version is recorded', [bankVersion(), bankStatus().version], ['gen-1', 'gen-1']);

  on(false);
  eq('switch off: English, even with a bank', voiceLine('thought', 'ugh, rain', {}, 'x'), 'ugh, rain');
  eq('…and no version on a thought', bankVersion(), null);
  on();
  write({ ...doc({ thought: { 'ugh, rain': [{ t: 'zuvo maku' }] } }), catalogue: 'old' });
  check('written from older English: says so, still works', loadPhraseBank({ file: FILE }).warnings.includes('english_changed_since') && voiceLine('thought', 'ugh, rain', {}, 'x') === 'zuvo maku');
  write(doc({ thought: { 'ugh, rain': Array.from({ length: 9 }, (_, i) => ({ t: `maku${'a'.repeat(i)}` })) } }));
  eq('at most so many variants', loadPhraseBank({ file: FILE }).coverage.thought.entries, MAX_VARIANTS);
  // Real names known today, not when it was written.
  write(doc({ thought: { 'ugh, rain': [{ t: 'zuvo nadia' }] } }));
  st = loadPhraseBank({ file: FILE, ctx: bankContext({ realNames: ['Nadia'] }) });
  eq('a real name that has since joined is dropped at boot', [voiceLine('thought', 'ugh, rain', {}, 'x'), st.rejected.real_name], ['ugh, rain', 1]);
  on(false);
}

section('one language: told, never refused');
{
  const voiced = (fn) => Object.fromEntries([...slotCatalogue().thought.keys()].slice(0, 200).map((s, i) => [s, [{ t: fn(s, i) }]]));
  const english = validateBank(doc({ thought: voiced((s) => `${s} again`) }));
  check('nearly all English says so, and loads', english.ok && english.warnings.includes('one_language_english:thought'), english.warnings);
  const other = validateBank(doc({ thought: voiced((s, i) => { const ph = [...s.matchAll(/\{[^{}]+\}/g)].map(m => m[0]).join(' '); const letter = (n) => String.fromCharCode(0x03b1 + n % 24);
    return `${letter(i)}${letter(i >> 4)}${letter(i >> 2)}${letter(i >> 3)} ${ph}`.trim(); }) }));
  check('all in another script says so, and loads', other.ok && other.warnings.includes('one_language_other:thought') && other.coverage.thought.voiced > 150, other.warnings);
  check('non-Latin is measured', other.health.thought.nonLatinPct > 90);
  const mix = validateBank(doc({ thought: voiced((s, i) => (i % 2 ? `${s} kesu${i}` : `onzo ${s} parzel${i}`).slice(0, 70)) }));
  eq('a real mix is quiet', mix.warnings.filter(w => w.startsWith('one_language')), []);
  check('the most used words are there to read', healthOf('thought', new Map([['ugh, rain', [{ t: 'maku maku' }]]])).topWords[0].word === 'maku');
  on();
  write(doc({ thought: { 'ugh, rain': [{ t: 'βροχη ξανα' }] } }));
  loadPhraseBank({ file: FILE });
  eq('a one-language bank still speaks', voiceLine('thought', 'ugh, rain', {}, 'x'), 'βροχη ξανα');
  on(false);
}

section('choosing: by state, with its own hash');
{
  on();
  __setBankForTest(null);
  eq('nothing loaded means nothing checked: English', voiceLine('thought', 'ugh, rain', {}, 'x'), 'ugh, rain');
  on(false);
  const list = [{ t: 'plain' }, { t: 'sad', mood: 'low' }, { t: 'late', time: 'night' }];
  eq('a tag that doesn\'t fit rules a line out', chooseVariant([{ t: 'sad', mood: 'low' }], { mood: 'high' }, 's'), null);
  on();
  __setBankForTest({ thought: { 'ugh, rain': [{ t: 'sad', mood: 'low' }] } });
  eq('…and with only those, English', voiceLine('thought', 'ugh, rain', { mood: 'high' }, 's'), 'ugh, rain');
  on(false);
  const seen = new Set(Array.from({ length: 60 }, (_, i) => chooseVariant(list, { mood: 'low', time: 'night' }, `seed${i}`)));
  eq('all that fit come up', [...seen].sort(), ['late', 'plain', 'sad']);
  eq('the same seed, the same line', chooseVariant(list, { mood: 'low' }, 'a'), chooseVariant(list, { mood: 'low' }, 'a'));
  check('at night only what fits night', !Array.from({ length: 40 }, (_, i) => chooseVariant(list, { mood: 'ok', time: 'day' }, `s${i}`)).some(t => t === 'sad' || t === 'late'));
  eq('time of day', [6, 12, 18, 23, 2].map(timeOfDay), ['morning', 'day', 'evening', 'night', 'night']);
}

// A bank for the whole of a pool: every line it could say, in another voice.
const VOICE = (s) => `${s} (v)`.replace(' (v)', ' kesu');
const wholeBank = (b) => Object.fromEntries([...slotCatalogue()[b].keys()].map(s => [s, [{ t: VOICE(s) }]]));

section('thoughts: the same thoughts, in his words; the memory keys stay English');
{
  const T = 1793300000;
  const base = {
    s: { genesisAt: 1, vitals: { energy: 15, hunger: 90, stress: 75, mood: { valence: -0.4 } }, activity: { kind: 'free', placeId: 'place:home', startAt: T - 7200 }, self: { homePlaceId: 'place:home' }, position: { placeId: 'place:home' }, decisions: new Map() },
    at: T, tickSec: 900, steps: 1, hourOf: () => 21, events: [{ id: 5, at: T - 60, type: 'commute.soaked', payload: {} }], live: null, deeds: [], intentions: [], unanswered: [], recent: [],
    memberOf: () => null, nameOf: () => null, anyName: () => null, departed: [], closest: [], wokeAt: T - 36000, employed: true, goalsOpen: 0, moneyRef: 1000, heavy: false, asOf: 9, firstMeet: false,
  };
  const runAt = (at, o = {}) => tickThoughts({ ...base, at, rng: (key) => rngFor('2026-11-05', `t:${key}`), ...o });
  const ats = Array.from({ length: 12 }, (_, i) => T + i * 900);
  on(false);
  __setBankForTest(null);
  const english = ats.flatMap(a => runAt(a));
  check('the fixture thinks', english.length > 2, english.length);
  on();
  __setBankForTest({ thought: wholeBank('thought') }, { version: 'gen-7' });
  const voiced = ats.flatMap(a => runAt(a));
  eq('the same number of thoughts', voiced.length, english.length);
  eq('the same times, families, causes and origins', voiced.map(r => [r.at, r.family, r.cause, r.originKind, r.dedupeKey]), english.map(r => [r.at, r.family, r.cause, r.originKind, r.dedupeKey]));
  eq('the repeat memory keeps the English key', voiced.map(r => r.phraseKey), english.map(r => r.phraseKey));
  check('the words are his', voiced.every((r, i) => r.text !== english[i].text && r.text.endsWith('kesu')), voiced.map(r => r.text));
  check('each carries the bank\'s version', voiced.every(r => r.codes.bank === 'gen-7'));
  // A memory written in English blocks a phrase with the bank on, and the other way about.
  const k = english[0].phraseKey;
  const blocked = runAt(T, { recent: [{ phraseKey: k, at: T - 3600, family: 'wordless', codes: {} }] });
  check('a phrase he had in English is still blocked with the bank on', !blocked.some(r => r.phraseKey === k));
  const heavy = runAt(T, { heavy: true });
  check('a heavy stretch keeps the plain words', heavy.every(r => !r.text.endsWith('kesu') && !r.codes.bank));
  const priv = runAt(T, { live: { active: true, private: true } });
  check('a private session keeps its neutral words', priv.every(r => WORDLESS.private.includes(r.text)), priv.map(r => r.text));
  on(false);
  __setBankForTest({ thought: wholeBank('thought') });
  eq('switch off with a bank loaded: byte for byte', ats.flatMap(a => runAt(a)), english);
  __setBankForTest(null);
}

section('live lines: the same session, the same replay');
{
  const T0 = 1793300000;
  const hourOf = (t) => new Date(t * 1000).getUTCHours();
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const facts = { activityId: 100, startAt: T0, endAt: T0 + 240 * 60, kind: 'hangout', placeKind: 'cafe', placeWord: 'cafe', cast: [{ id: 'cast:ana', name: 'Ana Reed', pronouns: 'she/her' }], closeness: 0.5, tension: 0.1, firstMeet: false, employed: true, outcome: 'well', register: 'normal', lateMin: 15 };
  const walk = () => {
    const b = buildBase(facts, { rngFor, date: '2026-11-05', hhmm, hourOf });
    b.facts.nameOf = (id) => id.split(':')[1];
    const inputs = { moodlets: [{ at: T0 + 3000, kind: 'text', who: 'bo', fade: 900 }], vitalsAt: () => ({ energy: 60, mood: { valence: 0.1 } }), texts: [], events: [{ id: 1, at: T0 + 3000, type: 'phone.message', payload: { castId: 'cast:bo', dir: 'in' } }] };
    return walkSession(b, inputs, b.endAt).map(s => ({ t: s.t, st: s.st.phase, parts: s.parts, line: lineParts(b, s) }));
  };
  on(false);
  __setBankForTest(null);
  const english = walk();
  on();
  __setBankForTest({ live: wholeBank('live') });
  const voiced = walk();
  const again = walk();
  eq('every read of a moment says the same', voiced, again);
  eq('the same steps and phases', voiced.map(x => [x.t, x.st]), english.map(x => [x.t, x.st]));
  const shape = (rows) => rows.map(x => [!!x.parts.topic, !!x.parts.vibe, !!x.parts.phone]);
  eq('a part is said at the same moments', shape(voiced), shape(english));
  const said = voiced.flatMap(x => [x.parts.vibe, x.parts.topic, x.parts.phone]).filter(Boolean);
  check('the session says things', said.length > 10);
  check('in his words', said.every(x => /kesu/.test(x)), said.filter(x => !/kesu/.test(x)).slice(0, 5));
  check('a placeholder never reaches the line', !said.some(x => /[{}]/.test(x)));
  // Strip the voice: what's left is the English drawn, so the draws and the memory were not touched.
  const strip = (x) => x?.replaceAll(' kesu', '');
  eq('the same lines were drawn', voiced.map(x => [strip(x.parts.vibe), strip(x.parts.topic), strip(x.parts.phone)]), english.map(x => [x.parts.vibe, x.parts.topic, x.parts.phone]));
  on(false);
  __setBankForTest({ live: wholeBank('live') });
  eq('switch off with a bank loaded: byte for byte', walk(), english);
  // A private session never asks the bank.
  on();
  const b = buildBase({ ...facts, register: 'private' }, { rngFor, date: '2026-11-05', hhmm, hourOf });
  b.facts.nameOf = (id) => id;
  const priv = walkSession(b, { moodlets: [], vitalsAt: () => ({ energy: 60, mood: { valence: 0 } }), events: [] }, b.endAt).flatMap(s => [s.parts.vibe]).filter(Boolean);
  check('a private session keeps its plain words', priv.every(x => PRIVATE.includes(x)), priv);
  on(false);
  __setBankForTest(null);
}

section('dreams: same key, his words');
{
  const plan = { scenes: [{ place: 'the cafe', person: 'Ana', twist: 'the stairs kept going down', kind: 'odd' }], task: 'looking for his wallet', ending: 'cut_off', castIds: ['cast:ana'], placeIds: ['place:cafe'] };
  const rngOf = () => rngFor('2026-11-05', 'd');
  on(false);
  __setBankForTest(null);
  const english = fragmentOf(plan, 'flat', rngOf(), []);
  on();
  __setBankForTest({ dream: wholeBank('dream') });
  const voiced = fragmentOf(plan, 'flat', rngOf(), []);
  eq('the same key: a fragment used lately is still known', voiced.key, english.key);
  check('his words, filled', voiced.text.endsWith('kesu') && !/[{}]/.test(voiced.text), voiced.text);
  check('a fragment needing a person stays out without one, with the bank too', (() => {
    const noOne = { ...plan, scenes: [{ place: 'the cafe', person: null, twist: 'x', kind: 'odd' }] };
    return Array.from({ length: 20 }, (_, i) => fragmentOf(noOne, 'good', rngFor('2026-11-05', `n${i}`), []).text).every(t => !/undefined|null/.test(t));
  })());
  on(false);
  eq('switch off: byte for byte', fragmentOf(plan, 'flat', rngOf(), []), english);
  __setBankForTest(null);
}

section('the side by side');
{
  write(doc({ thought: { 'ugh, rain': [{ t: 'zuvo maku', mood: 'low' }, { t: 'ugh, rain' }] } }));
  loadPhraseBank({ file: FILE });
  const v = phraseBankView({ bank: 'thought', q: 'maku' });
  eq('finds a line by the bank\'s words', v.rows.map(r => [r.source, r.variants]), [['ugh, rain', [{ t: 'zuvo maku', mood: 'low' }]]]);
  check('tells what the switch and the file say', v.on === false && v.disk.version === 'gen-1' && v.running.version === 'gen-1' && v.restartNeeded === false);
  const all = phraseBankView({ bank: 'thought', limit: 5, offset: 5 });
  eq('pages', [all.rows.length, all.offset, all.total], [5, 5, slotCatalogue().thought.size]);
  check('english only leaves the voiced line out', !phraseBankView({ bank: 'thought', only: 'english', limit: 2000 }).rows.some(r => r.source === 'ugh, rain'));
  write(doc({ thought: { 'ugh, rain': [{ t: 'novel maku' }] } }));
  fs.utimesSync(FILE, new Date(), new Date(Date.now() + 5000));
  eq('a bank written while he runs shows at once', phraseBankView({ bank: 'thought', q: 'novel' }).rows.length, 1);
}

section('a GET never changes what he says: the running bank loads at boot only');
{
  const stamp = (n) => fs.utimesSync(FILE, new Date(), new Date(Date.now() + n * 1000));
  on();
  write(doc({ thought: { 'ugh, rain': [{ t: 'ayzo running' }] } }, { version: 'gen-running' }));
  loadPhraseBank({ file: FILE });
  const say = () => voiceLine('thought', 'ugh, rain', {}, 'x');
  eq('boot loads it', [say(), bankVersion()], ['ayzo running', 'gen-running']);
  write(doc({ thought: { 'ugh, rain': [{ t: 'ayzo fresh' }] } }, { version: 'gen-fresh' }));
  stamp(10);
  const view = phraseBankView({ bank: 'thought', q: 'ayzo' });
  eq('the page shows the file on disk', view.rows.map(r => r.variants[0].t), ['ayzo fresh']);
  eq('running and on-disk versions are told apart', [view.running.version, view.disk.version, view.restartNeeded], ['gen-running', 'gen-fresh', true]);
  eq('opening the page leaves his words alone', [say(), bankVersion(), bankStatus().version], ['ayzo running', 'gen-running', 'gen-running']);
  phraseBankView({ bank: 'live' });
  phraseBankView({ bank: 'thought', only: 'voiced' });
  eq('…however often', say(), 'ayzo running');
  write('{ corrupted now');
  stamp(20);
  const broken = phraseBankView({ bank: 'thought' });
  eq('a file gone bad is reported, and he speaks on', [broken.disk.issue, broken.running.version, broken.restartNeeded, say()], ['corrupt', 'gen-running', true, 'ayzo running']);
  fs.rmSync(FILE);
  const gone = phraseBankView({ bank: 'thought' });
  eq('a file gone is reported, and he speaks on', [gone.disk.issue, gone.disk.source, gone.restartNeeded, say()], ['missing', 'example', true, 'ayzo running']);
  write(doc({ thought: { 'ugh, rain': [{ t: 'ayzo fresh' }] } }, { version: 'gen-fresh' }));
  stamp(30);
  loadPhraseBank({ file: FILE });
  eq('a restart (a fresh load) picks it up', [say(), bankVersion()], ['ayzo fresh', 'gen-fresh']);
  eq('…and then they agree', phraseBankView({ bank: 'thought' }).restartNeeded, false);

  // Nothing booted: a read loads nothing, so an unchecked bank can't speak.
  __setBankForTest(null);
  const unbooted = phraseBankView({ bank: 'thought' });
  eq('before boot the page reads the file and activates nothing', [unbooted.running.source, unbooted.restartNeeded, say(), bankVersion()], [null, false, 'ugh, rain', null]);
  on(false);
  __setBankForTest(null);
}

section('the generator, with a stub model');
{
  const system = buildSystem({ identity: 'He is someone.', persona: { language: 'some mix', voiceDescriptor: 'dry', vibe: 'calm' }, banned: ['biscuits'] });
  check('the system prompt carries his identity and the bans', system.core.includes('He is someone.') && system.profile.includes('biscuits'));
  check('the charter says nothing about any one person', !personaTerms().some(t => wordIn(system.core.replace('He is someone.', ''), t)), personaTerms().filter(t => wordIn(system.core, t)));
  const now = () => 1793300000;
  const deps = (o = {}) => ({ callModel: stubCallModel, monthSpentUsd: () => 0, estimateUsd: () => 0.01, now, ...o });
  const batches = planBatches();
  eq('every line is asked for once', batches.reduce((a, b) => a + b.slots.length, 0), BANKS.reduce((a, b) => a + slotCatalogue()[b].size, 0));
  check('each call is one a fetch can wait for', batches.every(b => b.slots.length <= 60));
  const est = estimateRun({ system, deps: deps({ estimateUsd: ({ input, output }) => (input * 4 + output * 20) / 1e6 }) });
  check('the estimate is under the default cap', est.usd > 0.5 && est.usd < 4, est);

  let calls = 0;
  const counting = async (...a) => { calls += 1; return stubCallModel(...a); };
  const r = await generateBank({ system, deps: deps({ callModel: counting }) });
  check('a full run', r.ok && calls === batches.length && !r.doc.partial, r.stats);
  const dropped = dropBadLines(r.doc, bankContext({ persona: { name: 'Zedkay' } }));
  const rv = await reviewBank(r.doc, { deps: deps() });
  check('the checking pass answers', rv.ok, rv);
  const v = validateBank(r.doc);
  check('what it wrote validates and covers nearly every line', v.ok && v.coverage.thought.voiced > 500 && v.coverage.live.voiced > 300, { c: v.coverage, dropped, rejected: v.rejected });

  // Gates.
  const spend = async (over) => generateBank({ system, maxUsd: over.maxUsd ?? 4, deps: deps(over.deps ?? {}) });
  eq('an unreadable ledger spends nothing', (await spend({ deps: { monthSpentUsd: () => { throw new Error('x'); }, callModel: () => { throw new Error('no call'); } } })).code, 'ledger_unreadable');
  eq('an unpriced model spends nothing', (await spend({ deps: { estimateUsd: () => null, callModel: () => { throw new Error('no call'); } } })).code, 'unpriced');
  const atCap = await spend({ maxUsd: 1, deps: { monthSpentUsd: () => 1, callModel: () => { throw new Error('no call'); } } });
  check('this month\'s spend already at the cap: no call', !atCap.ok && atCap.stats.calls === 0 && atCap.code === 'cap', atCap);
  let c2 = 0;
  const stopped = await spend({ maxUsd: 0.05, deps: { estimateUsd: () => 0.02, callModel: async (...a) => { c2 += 1; return { ...(await stubCallModel(...a)), costUsd: 0.02 }; } } });
  check('the cap stops a run part way, and it says partial', stopped.ok && c2 === 2 && stopped.doc.partial === true && stopped.stats.stoppedBy === 'cap', stopped.stats);
  const huge = await spend({ maxUsd: 1000, deps: { monthSpentUsd: () => HARD_MAX_USD, callModel: () => { throw new Error('no call'); } } });
  check('no flag goes past the hard cap', !huge.ok && huge.code === 'cap');
  const fb = await spend({ deps: { callModel: async (...a) => ({ ...(await stubCallModel(...a)), fellBack: true }) } });
  check('fallen-back calls: not his voice, nothing kept', !fb.ok && fb.stats.fellBack === 2 && fb.stats.stoppedBy === 'failing', fb.stats);
  const junk = await spend({ deps: { callModel: async () => ({ text: 'sorry, no', costUsd: 0.01, status: 'ok' }) } });
  check('answers out of shape stop after a split and two tries', !junk.ok && junk.stats.calls === 3 && junk.stats.stoppedBy === 'failing', junk.stats);
  const budget = await spend({ deps: { callModel: async () => ({ text: null, skipped: 'budget', costUsd: null }) } });
  check('over the mind\'s budget: stops', !budget.ok && budget.code === 'skipped:budget', budget);

  // A cut-off answer: the same lines again in two halves, once, without stopping the run.
  let firstCut = true;
  const asked = [];
  const cut = await spend({ deps: { callModel: async (sys, user, o) => {
    asked.push((user.match(/^L\d+ \|/gm) ?? []).length);
    if (firstCut) { firstCut = false; return { text: '{"L1":[{"t":"cut of', costUsd: 0.01 }; }
    return stubCallModel(sys, user, o);
  } } });
  check('a cut-off answer is split and asked again', cut.ok && !cut.doc.partial && cut.stats.split === 1 && asked[1] + asked[2] === asked[0] && cut.stats.failed === 0, { asked: asked.slice(0, 4), stats: cut.stats });
  const always = await spend({ deps: { callModel: async () => ({ text: 'not json', costUsd: 0.01 }) } });
  check('…once: halves out of shape count as failures', !always.ok && always.stats.split === 1 && always.stats.failed === 2 && always.stats.calls === 3, always.stats);
  let worst = 0;
  await spend({ maxUsd: 100, deps: { estimateUsd: ({ output }) => { worst = Math.max(worst, output); return 0; } } });
  check('the hard cap counts a call at the most it can use', worst >= 60 * 180, worst);
  let told = null;
  await spend({ deps: { callModel: async (sys, user, o) => { told = told ?? o; return stubCallModel(sys, user, o); } } });
  check('…and the call is told the same limit', told.maxTokens >= 60 * 180 && told.maxTokens <= 16000, told);

  eq('a wrong id goes nowhere', parseBatch('{"L1":[{"t":"a"}],"L999":[{"t":"b"}],"x":[]}', { slots: [{ source: 's' }] }), { lines: { s: [{ t: 'a' }] }, unknownIds: 2 });
  eq('not JSON', parseBatch('nope', { slots: [] }), null);

  // The checking pass.
  const small = () => ({ banks: { thought: { 'ugh, rain': [{ t: 'one' }, { t: 'two' }], 'rain. great': [{ t: 'three' }] } } });
  const d1 = small();
  const fl = await reviewBank(d1, { deps: deps({ callModel: async () => ({ text: '{"flag":["r1","r3","r99","bad"]}', costUsd: 0.01 }) }) });
  check('flagged lines go, a slot left empty goes', fl.ok && fl.flagged === 2 && JSON.stringify(d1.banks.thought) === JSON.stringify({ 'ugh, rain': [{ t: 'two' }] }), d1.banks);
  for (const [why, callModel, code] of [
    ['out of shape', async () => ({ text: 'looks fine to me', costUsd: 0 }), 'bad_answer'],
    ['fallen back', async () => ({ text: '{"flag":[]}', fellBack: true, costUsd: 0 }), 'fell_back'],
    ['over budget', async () => ({ skipped: 'budget', text: null }), 'skipped:budget'],
  ]) eq(`a checking pass ${why} writes nothing`, (await reviewBank(small(), { deps: deps({ callModel }) })).code, code);
  eq('and one over the cap never calls', (await reviewBank(small(), { maxUsd: 0.005, deps: deps({ callModel: () => { throw new Error('no call'); } }) })).code, 'cap');

  // Code checks before anyone pays to read the lines.
  const d2 = { banks: { thought: { 'ugh, rain': [{ t: 'rhea maku' }, { t: 'maku kesu' }, 'not an object'], gone: [{ t: 'x' }] } } };
  eq('code checks drop what they can', dropBadLines(d2, bankContext({ realNames: ['Rhea'] })), { real_name: 1, bad_entry: 1 });
  eq('…and leave the rest', d2.banks.thought, { 'ugh, rain': [{ t: 'maku kesu' }] });
}

section('the script: dry by default, no key needed');
{
  const { db, cleanup } = await setupScratchDb();
  const run = (...a) => spawnSync(process.execPath, ['scripts/gen-phrases.js', ...a], { cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, DB_PATH: SCRATCH_DB_REL, LOG_LEVEL: 'error' } });
  const out = path.join(SCRATCH, 'stub.json');
  const before = fs.existsSync(PHRASES_PATH) ? fs.statSync(PHRASES_PATH).mtimeMs : null;
  const dry = run();
  check('dry: says it calls nothing', dry.status === 0 && /no model call, nothing written/.test(dry.stdout), dry.stderr);
  check('a stub without --out is refused', run('--stub').status === 1);
  check('a silly cap is refused', run('--write', '--max-usd', '500').status === 1);
  const st = run('--stub', '--out', out);
  check('the stub run writes where it was told', st.status === 0 && fs.existsSync(out), st.stderr);
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf-8'));
  check('with a version, a model and the catalogue', onDisk.version.startsWith('gen-') && onDisk.model === 'stub' && onDisk.catalogue === catalogueHash());
  eq('the real file was never touched', fs.existsSync(PHRASES_PATH) ? fs.statSync(PHRASES_PATH).mtimeMs : null, before);
  const cmp = run('--compare', '--file', out, '--bank', 'dream', '--limit', '2');
  check('--compare shows today beside the bank', cmp.status === 0 && /NOW {3}/.test(cmp.stdout) && / {2}-> {2}/.test(cmp.stdout), cmp.stdout.slice(0, 200));
  // The file is what passed: his over-used words stay down at every boot, and nothing more falls off when it's read.
  const reread = validateBank(onDisk);
  check('the written file re-validates with nothing to cap', reread.ok && !reread.rejected.word_cap && !reread.rejected.emoji_cap && !reread.rejected.dup_line, reread.rejected);
  // A real word over its cap at --write, and the file shows it gone (a line for every slot of the dream bank, all with one word).
  const capped = path.join(SCRATCH, 'capped.json');
  const pet = Object.fromEntries([...slotCatalogue().thought.keys()].filter(k => !/[{}]/.test(k)).slice(0, 120).map((k, i) => [k, [{ t: `zelkova zo${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + (i >> 5) % 26)}` }]]));
  const capDraft = path.join(SCRATCH, 'cap-draft.json');
  fs.writeFileSync(capDraft, JSON.stringify(doc({ thought: pet })));
  const cres = run('--stub', '--from-draft', capDraft, '--out', capped);
  const cfile = JSON.parse(fs.readFileSync(capped, 'utf-8'));
  check('a word over its cap is gone from the file, not only from the report', cres.status === 0 && Object.values(cfile.banks.thought).flat().filter(e => e.t.includes('zelkova')).length <= 5, cres.stderr);
  // The real ledger: what this caller spent this month counts against the cap, and a run that can't afford a call makes none.
  const mtime = fs.statSync(out).mtimeMs;
  check('a cap too small for one call: no call, nothing written, any keys', (() => {
    const r = run('--write', '--max-usd', '0.001', '--out', out);
    return r.status === 1 && /Nothing written: cap/.test(r.stderr) && fs.statSync(out).mtimeMs === mtime;
  })());
  db.prepare("INSERT INTO llm_usage (ts, role, provider, model, caller, input_tokens, output_tokens, cost_usd, cost_source, status) VALUES (unixepoch(), 'mind', 'anthropic', 'x', 'life.phrases.gen', 1, 1, 3.5, 'table', 'ok')").run();
  check('the dry run reads this month\'s spend from the ledger', /spent so far: \$3\.50/.test(run().stdout));
  const atCap = run('--write', '--max-usd', '3', '--out', out);
  check('already over the month\'s cap: nothing written', atCap.status === 1 && /Nothing written: cap/.test(atCap.stderr) && fs.statSync(out).mtimeMs === mtime);
  // A draft the checking pass never finished: re-checked and written, no lines paid for again.
  const draft = path.join(SCRATCH, 'draft.json');
  fs.writeFileSync(draft, JSON.stringify(doc({ thought: { 'ugh, rain': [{ t: 'zuvo maku' }, { t: 'rhea {x}' }] } })));
  const res = run('--stub', '--from-draft', draft, '--out', path.join(SCRATCH, 'from-draft.json'));
  const written = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'from-draft.json'), 'utf-8'));
  eq('--from-draft keeps what passes', [res.status, written.banks.thought['ugh, rain']], [0, [{ t: 'zuvo maku' }]]);
  // --only keeps the other banks of the file.
  const onlyOut = path.join(SCRATCH, 'only.json');
  fs.writeFileSync(onlyOut, JSON.stringify(doc({ live: { 'just got here': [{ t: 'ipzo ethel' }] } })));
  const only = run('--stub', '--only', 'dream', '--out', onlyOut);
  const merged = JSON.parse(fs.readFileSync(onlyOut, 'utf-8'));
  check('--only writes that bank and keeps the others', only.status === 0 && merged.banks.live['just got here'][0].t === 'ipzo ethel' && Object.keys(merged.banks.dream).length > 10 && fs.existsSync(`${onlyOut}.bak`), only.stderr);
  cleanup();
}

section('no persona, region or language literal in what\'s committed');
{
  const files = ['src/life/phraseCheck.js', 'src/life/phraseBank.js', 'src/life/phraseGen.js', 'src/life/dreamPhrases.js', 'scripts/gen-phrases.js', 'src/personality/phrases.example.json',
    'src/dashboard/public/js/pages/life-phrases.js', 'src/dashboard/public/js/guides/life-phrases.js', 'docs/claude/phrase-banks.md', 'scripts/life-tests/76-phrase-banks.test.js'];
  const terms = personaTerms();
  check('the guard has real terms', terms.length >= 3, terms.length);
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf-8');
    eq(`${f} is clean`, terms.filter(t => wordIn(src, t)).map(t => terms.indexOf(t)), []);
  }
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
report();
