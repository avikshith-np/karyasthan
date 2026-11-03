// T019 — inner state (src/life/innerState.js): the time line, the inner-state
// line (situation + feeling, ≤ 240 chars across 500 random states), ≤ 3 cast
// cards only on relevance, sanitization of world strings, the audience filter
// (a chat-origin fact only where 006's rule — here the same-chat fallback or an
// injected canUseIn — allows it; subject facts only where the person is; the
// dashboard sees all), tone-only modes (embargo; over the self-mention budget:
// no places, cast, plans or decisions; cards only for cast someone else named),
// the catch-up note and the call state note. Scratch DB (real events, so the
// default origin lookup is exercised), fake clock, example world; no network,
// no LLM.
import { setupScratchDb, fakeClock, section, check, eq, report } from './_helpers.js';
import { setClock, atLocal, hhmm } from '../../src/life/clock.js';
import { setRngSeed, rngFor } from '../../src/life/rng.js';
import { appendEvent } from '../../src/life/eventLog.js';
import { loadWorld, EXAMPLE_PATH } from '../../src/life/world.js';
import { createInitialState, applyAppended } from '../../src/life/projector.js';
import { noteSelfMention, resetClaimCounters } from '../../src/life/claims.js';
import { EMBARGO_TONE } from '../../src/life/embargo.js';
import { config } from '../../src/utils/config.js';
import {
  INNER_MAX, CARD_MAX, CARDS_MAX, SITUATION_NOTE, timeLine, innerStateLine, castCards, castCard, castTerms,
  catchUpNote, callStateNote, lifeLines, lineMode, setCanUseIn, setOriginLookup, fallbackCanUseIn,
  factAllowed, eventAllowed, feelingFragments,
} from '../../src/life/innerState.js';

await setupScratchDb();
setRngSeed(7);
const world = loadWorld({ path: '/nonexistent/world.json', examplePath: EXAMPLE_PATH, force: true });
const TZ = createInitialState(world).world.timezone;
const T0 = atLocal(Date.UTC(2026, 9, 28, 6, 0) / 1000, '09:00', TZ); // Wed 28 Oct, 09:00 local
const clock = fakeClock(T0);
setClock(clock.fn);
const MIN = 60;
const H = 3600;
const GROUP_X = '120363000000000001@g.us';
const GROUP_Y = '120363000000000002@g.us';
const ALICE = '15550000001@s.whatsapp.net';
const BOB = '15550000002@s.whatsapp.net';
const audX = { chatJid: GROUP_X, kind: 'group', members: new Set([ALICE]) };
const audY = { chatJid: GROUP_Y, kind: 'group', members: new Set([BOB]) };
const dash = { kind: 'dashboard' };

let live = createInitialState(world);
const add = (spec) => {
  const ev = appendEvent(spec);
  live = applyAppended(live, ev, { world });
  return ev;
};
const at = (min) => T0 + min * MIN;
const placeNames = world.places.map(p => p.name);
const castNames = world.cast.map(c => c.name);
const hasAny = (s, words) => words.some(w => s.toLowerCase().includes(w.toLowerCase()));
const has = (s, w) => s.toLowerCase().includes(w.toLowerCase());

try {
  const genesis = add({ type: 'genesis', at: T0 - H, actor: 'engine',
    payload: { worldHash: world.hash, source: world.source, timezone: world.timezone, self: world.self } });
  for (const p of world.places) add({ type: 'place.created', at: T0 - H, actor: 'engine', causeId: genesis.id, payload: p });
  for (const c of world.cast) add({ type: 'cast.created', at: T0 - H, actor: 'engine', causeId: genesis.id, payload: c });

  section('time line');
  check('"Now: Wed 28 Oct, 09:00."', /^Now: Wed 28 Oct, 09:00\.$/.test(timeLine(live, T0)), timeLine(live, T0));
  eq('uses the world timezone', timeLine(live, at(75)), `Now: Wed 28 Oct, ${hhmm(at(75), TZ)}.`);

  section('inner-state line: situation + feeling');
  const meet = add({ type: 'activity.started', at: at(0), actor: 'engine',
    payload: { kind: 'meeting', placeId: 'place:office', end: at(60), availability: 'meeting' } });
  let line = innerStateLine(live, at(10), audX);
  check('in a meeting till its end', has(line, 'in a meeting till') && line.includes(hhmm(at(60), TZ)), line);
  check('≤ 240 chars, one sentence', line.length <= INNER_MAX && line.endsWith('.') && !line.includes('\n'), line);
  const tiredState = structuredClone(live);
  Object.assign(tiredState.vitals, { energy: 12, sleepDebt: 9, stress: 82 });
  line = innerStateLine(tiredState, at(10), audX);
  check('feelings follow vitals (exhausted, little sleep, stressed)', hasAny(line, ['exhausted']) && hasAny(line, ['little sleep']) && hasAny(line, ['stressed']), line);
  check('feelings are phrased as feelings, not topics', feelingFragments({ energy: 12, hunger: 90 }).every(f => !/\b(office|meeting|flatmate)\b/.test(f)));
  eq('a neutral day still says something', feelingFragments({ energy: 60, stress: 20, hunger: 30, socialBattery: 70, mood: { valence: 0 } }), ['feeling okay']);
  eq('no state → empty line', innerStateLine(null, at(10), audX), '');
  eq('situational instruction is fixed text', SITUATION_NOTE.startsWith('This is just your situation right now'), true);

  section('500 random states: size cap and card count');
  const kinds = ['meeting', 'work', 'lunch', 'dinner', 'gym', 'tv', 'walk', 'cafe', 'movie', 'eat-out', 'commute', 'sleep', 'free', 'idle', 'groceries', 'mystery-kind'];
  const avails = ['free', 'light', 'busy', 'meeting', 'dnd', 'asleep'];
  let maxLen = 0;
  let maxCards = 0;
  let maxCard = 0;
  let worst = '';
  for (let i = 0; i < 500; i++) {
    const r = rngFor(`inner-${i}`, 'test');
    const s = structuredClone(live);
    const long = (n) => Array.from({ length: n }, () => r.pick(['very', 'long', 'winding', 'name', 'Ünïcödé', '[IMAGE: x]', '@9198765'])).join(' ');
    for (const p of s.places.values()) if (r.chance(0.5)) p.name = long(r.int(5, 30));
    for (const c of s.cast.values()) {
      if (r.chance(0.5)) c.name = long(r.int(2, 12));
      if (r.chance(0.5)) c.status = long(r.int(10, 60));
      if (r.chance(0.5)) c.personality = long(r.int(10, 60));
    }
    const kind = r.pick(kinds);
    const castIds = [...s.cast.keys()];
    s.activity = { kind, placeId: r.pick([...s.places.keys()]), startAt: at(0), endAt: at(r.int(1, 600)),
      availability: r.pick(avails), withCast: r.chance(0.5) ? r.shuffle(castIds).slice(0, r.int(1, 4)) : [], social: r.chance(0.3), eventId: meet.id };
    s.availability = { state: s.activity.availability, since: at(0), until: s.activity.endAt, onPhone: false, eventId: meet.id };
    if (kind === 'commute') s.position = { ...s.position, travel: { from: 'place:home', to: r.pick([...s.places.keys()]), mode: long(3), startAt: at(0), endAt: at(30), eventId: null } };
    Object.assign(s.vitals, { energy: r.int(0, 100), sleepDebt: r.int(0, 20), stress: r.int(0, 100), hunger: r.int(0, 100),
      socialBattery: r.int(0, 100), sick: r.chance(0.1), mood: { valence: r.float(-1, 1), arousal: r.float(0, 1) } });
    s.weather = r.chance(0.3) ? { rain: true, condition: r.pick(['light_rain', 'heavy_rain']) } : null;
    if (r.chance(0.5)) {
      s.decisions = new Map([[999, { id: 999, kind: long(4), status: 'open', decideBy: at(300), opensAt: at(0),
        options: [{ id: 'go', label: long(r.int(5, 20)) }, { id: 'skip', label: 'skip' }],
        lean: { optionId: r.pick(['go', 'skip']), p: r.float(0, 1), at: at(1) }, subject: { castIds: castIds.slice(0, 3) }, origins: [] }]]);
    }
    s.plan = { date: '2026-10-28', eventId: null, blocks: [
      { kind: 'meeting', start: at(90), end: at(120), availability: 'meeting', withCast: [] },
      { kind: 'dinner', start: at(150), end: at(200), availability: 'light', withCast: castIds.slice(0, r.int(0, 5)) },
    ] };
    if (r.chance(0.1)) s.embargo = { until: at(600), eventId: 1 };
    const tAt = at(r.int(0, 100));
    const text = innerStateLine(s, tAt, r.chance(0.2) ? dash : audX, { overBudget: r.chance(0.2) });
    const recent = r.chance(0.5) ? [`hey how is ${r.pick(castNames)}?`, { text: 'my flatmate again', fromMe: true }] : 'nothing relevant';
    const cards = castCards(s, tAt, audX, recent, r.int(0, 6), { overBudget: false });
    if (text.length > maxLen) { maxLen = text.length; worst = text; }
    maxCards = Math.max(maxCards, cards.length);
    maxCard = Math.max(maxCard, ...cards.map(c => c.length), 0);
    if (/\[IMAGE|@\d{5}/.test(text + cards.join(' '))) { check(`state ${i}: marker/mention leaked`, false, text + ' | ' + cards.join(' | ')); break; }
  }
  check(`line ≤ ${INNER_MAX} chars in 100% of states (max ${maxLen})`, maxLen <= INNER_MAX && maxLen > 0, worst);
  check(`≤ ${CARDS_MAX} cards (max ${maxCards})`, maxCards <= CARDS_MAX);
  check(`each card ≤ ${CARD_MAX} chars (max ${maxCard})`, maxCard <= CARD_MAX);

  section('cast cards on relevance');
  eq('no relevance → no cards', castCards(live, at(10), audX, 'what a match last night'), []);
  let cards = castCards(live, at(10), audX, 'how is your flatmate doing?');
  check('"flatmate" (one flatmate) → the flatmate card', cards.length === 1 && cards[0].startsWith('Flatmate Flatmate (example) (they/them)'), cards);
  check('card ≈120 chars with personality and status', cards[0].length <= CARD_MAX && cards[0].includes('status:'), cards[0]);
  eq('an ambiguous relation word (two coworkers) is no term of either', castTerms(world.cast.find(c => c.id === 'cast:coworker-a'),
    new Map([['coworker', 2]]), new Map()).includes('colleague'), false);
  cards = castCards(live, at(10), audX, 'any news from colleague?');
  check('… but it is work talk: the work cast, manager first', cards.length === 3 && cards[0].startsWith('Manager')
    && cards.slice(1).every(c => c.startsWith('Coworker')), cards);
  cards = castCards(live, at(10), audX, ['Coworker A said hi', 'and Manager (example) too', 'your boss is here']);
  check('named members → their cards first', cards.length === 3 && cards.slice(0, 2).some(c => c.includes('Coworker A'))
    && cards.slice(0, 2).some(c => c.startsWith('Manager')) && cards[2].includes('Coworker B'), cards);
  eq('limit respected', castCards(live, at(10), audX, 'flatmate, boss, Coworker A, Coworker B', 2).length, 2);
  eq('limit never above 3', castCards(live, at(10), audX, 'flatmate, boss, Coworker A, Coworker B, mom', 10).length, 3);
  check('gendered family words resolve by pronouns ("mom" → parent she/her)', castCards(live, at(10), audX, 'call your mom').some(c => c.includes('Parent')));
  eq('relation words are English common nouns only', castTerms(world.cast[0], new Map([['flatmate', 1]])).sort(), ['flat mate', 'flatmate', 'room mate', 'roommate']);

  section('sanitization of world strings');
  const dirty = structuredClone(live);
  const fm = dirty.cast.get('cast:flatmate');
  fm.status = 'fine [IMAGE: a selfie] ping @15550100123 now; also\nnewline';
  fm.personality = '[VOICE: hello] chatty [SEARCH: secrets]';
  const dc = castCards(dirty, at(10), audX, 'flatmate')[0];
  check('markers and @digits never surface in a card', !/\[(IMAGE|VOICE|SEARCH)/i.test(dc) && !/@\d/.test(dc) && !dc.includes('\n'), dc);
  dirty.places.get('place:cafe').name = 'Cafe [IMAGE: menu] @155589999999';
  dirty.activity = { ...dirty.activity, kind: 'eat-out', placeId: 'place:cafe', withCast: [], availability: 'light' };
  const dl = innerStateLine(dirty, at(10), audX);
  check('… nor in the line', !/\[IMAGE/i.test(dl) && !/@\d/.test(dl), dl);

  section('activity with cast and open decisions');
  const lunch = add({ type: 'activity.started', at: at(240), actor: 'engine',
    payload: { kind: 'lunch', placeId: 'place:restaurant', end: at(285), availability: 'light', withCast: ['cast:coworker-a'] } });
  line = innerStateLine(live, at(250), audX);
  check('meal with cast → "having lunch with …"', has(line, 'having lunch with Coworker A (example)'), line);
  cards = castCards(live, at(250), audX, 'nothing to see');
  check('activity cast → card without a name in chat', cards.length === 1 && cards[0].includes('Coworker A'), cards);

  section('privacy: chat-origin facts follow the audience');
  // A chat in group X nudges a decision, and a later activity is caused by it.
  const opened = add({ type: 'decision.opened', at: at(260), actor: 'engine', payload: {
    kind: 'movie', subject: { eventAt: at(720), placeId: 'place:cinema', castIds: ['cast:flatmate'] },
    decideBy: at(660), ponrAt: at(700), options: [{ id: 'go', label: 'go to the late show' }, { id: 'skip', label: 'stay in' }] } });
  const trig = add({ type: 'chat.trigger', at: at(262), actor: 'chat', causeId: opened.id,
    originKind: 'group', originJid: GROUP_X, payload: { decisionId: opened.id, toward: 'go' } });
  add({ type: 'decision.lean', at: at(263), actor: 'jev', causeId: trig.id, payload: { decisionId: opened.id, optionId: 'go', p: 0.65 } });
  const outing = add({ type: 'activity.started', at: at(300), actor: 'engine', causeId: trig.id,
    payload: { kind: 'walk', placeId: 'place:park', end: at(340), availability: 'free', withCast: ['cast:flatmate'] } });
  eq('the caused activity carries group X\'s origin', [outing.originKind, outing.originJid], ['group', GROUP_X]);
  const lineX = innerStateLine(live, at(310), audX);
  const lineY = innerStateLine(live, at(310), audY);
  const lineD = innerStateLine(live, at(310), dash);
  check('in X: the walk and the lean are visible', has(lineX, 'out for a walk') && lineX.includes('go to the late show'), lineX);
  check('in Y: neither the walk nor the lean (fallback: same chat only)', !lineY.includes('walk') && !lineY.includes('late show') && !lineY.toLowerCase().includes('flatmate'), lineY);
  check('in Y: the line still has his availability tone', lineY.startsWith('Free right now'), lineY);
  check('dashboard sees all', has(lineD, 'out for a walk') && lineD.includes('late show'), lineD);
  check('cards: X gets the flatmate (activity + decision), Y none', castCards(live, at(310), audX, '').some(c => c.includes('Flatmate')) && castCards(live, at(310), audY, '').length === 0);
  check('… unless someone in Y names them', castCards(live, at(310), audY, 'how is the flatmate').length === 1);
  check('call note in Y hides the walk', !callStateNote(live, at(310), audY).includes('walk') && callStateNote(live, at(310), audX).includes('walk'));
  check('a DM is not group X either', !innerStateLine(live, at(310), { chatJid: ALICE, kind: 'dm', members: new Set([ALICE]) }).includes('walk'));
  setCanUseIn((item, aud) => item.originJid === GROUP_X && aud.chatJid === GROUP_Y);
  check('injected canUseIn is honoured (X → Y allowed)', has(innerStateLine(live, at(310), audY), 'out for a walk'));
  setCanUseIn(() => { throw new Error('boom'); });
  check('a throwing canUseIn fails closed', !innerStateLine(live, at(310), audY).includes('walk'));
  setCanUseIn(null);
  check('fallback restored', !innerStateLine(live, at(310), audY).includes('walk') && fallbackCanUseIn({ originJid: GROUP_X }, audX));
  setOriginLookup(() => null);
  check('unknown origin (event not found) → excluded', !innerStateLine(live, at(310), audX).includes('walk'));
  setOriginLookup(() => { throw new Error('db gone'); });
  check('lookup error → excluded', !innerStateLine(live, at(310), audX).includes('walk'));
  setOriginLookup(null);
  check('self facts usable anywhere', eventAllowed(meet.id, audY) && eventAllowed(null, audY));
  check('subject facts only where the person is', !factAllowed({ originJid: 'self', subjectJid: ALICE }, audY)
    && factAllowed({ originJid: 'self', subjectJid: ALICE }, audX)
    && factAllowed({ originJid: 'self', subjectJid: ALICE }, { chatJid: ALICE, kind: 'dm' }));
  const subj = add({ type: 'activity.started', at: at(350), actor: 'engine', subjectJid: ALICE,
    payload: { kind: 'cafe', placeId: 'place:cafe', end: at(400), availability: 'light' } });
  check('activity with a real-person subject: hidden in Y, shown in X', !innerStateLine(live, at(360), audY).includes('café')
    && innerStateLine(live, at(360), audX).includes('café'), [subj.subjectJid, innerStateLine(live, at(360), audX)]);
  add({ type: 'activity.started', at: at(410), actor: 'engine', payload: { kind: 'work', placeId: 'place:office', end: at(540), availability: 'light' } });

  section('tone only over the self-mention budget');
  resetClaimCounters();
  eq('fresh chat → full mode', lineMode(live, at(420), GROUP_X), 'full');
  const budget = config.life.selfMentionBudget;
  for (let i = 0; i <= budget; i++) noteSelfMention(GROUP_X, at(415));
  eq(`> ${budget} self-mentions → tone mode`, lineMode(live, at(420), GROUP_X), 'tone');
  const toneLine = innerStateLine(live, at(420), audX);
  const nouns = [...placeNames, ...castNames, 'office', 'meeting', 'desk', 'late show', 'movie', 'flatmate', 'lunch', 'home', 'dinner', 'plans'];
  check('no places, cast, plans or decisions in the line', !hasAny(toneLine, nouns) && toneLine.length > 0, toneLine);
  check('still says how he is', /^(Free right now|A bit busy|Busy|Tied up right now)/.test(toneLine), toneLine);
  eq('no cards from his own activity/decisions', castCards(live, at(420), audX, ''), []);
  eq('no card when only he named them', castCards(live, at(420), audX, [{ text: 'my flatmate is wild', fromMe: true }]), []);
  eq('a card when someone else named them', castCards(live, at(420), audX, [{ text: 'how is your flatmate', fromMe: false }]).length, 1);
  eq('budget is per chat', lineMode(live, at(420), GROUP_Y), 'full');
  check('explicit overBudget wins', lineMode(live, at(420), GROUP_Y, { overBudget: true }) === 'tone');
  resetClaimCounters();

  section('embargo: tone only');
  const emb = structuredClone(live);
  emb.embargo = { until: at(600), eventId: 1, heavyEventId: 1, startedAt: at(400) };
  const embLine = innerStateLine(emb, at(420), dash);
  check('the embargo tone and nothing concrete', embLine.includes(EMBARGO_TONE) && !hasAny(embLine, nouns), embLine);
  eq('embargo mode', lineMode(emb, at(420), GROUP_X), 'embargo');
  eq('no cards from his own life during embargo', castCards(emb, at(420), audX, ''), []);
  eq('… only for cast others named', castCards(emb, at(420), audX, 'flatmate?').length, 1);
  check('call note is tone only', callStateNote(emb, at(420), audX).includes('quiet, low day'));
  eq('after the embargo → full again', lineMode(emb, at(601), GROUP_X), 'full');

  section('catch-up note');
  eq('minutes + reason + count', catchUpNote({ awayMin: 45, newCount: 3, reason: 'meeting' }),
    'You were away ~45 min (in a meeting); 3 new messages since you last looked; reply once, covering what needs you.');
  eq('hours, asleep, one message', catchUpNote({ awayMin: 7 * 60 + 10, newCount: 1, reason: 'asleep' }),
    'You were away ~7 h (asleep); 1 new message since you last looked; reply once, covering what needs you.');
  eq('nothing to say → empty', [catchUpNote(null), catchUpNote({}), catchUpNote({ awayMin: 0, newCount: 0 })], ['', '', '']);
  check('junk reason is not echoed', !catchUpNote({ awayMin: 5, newCount: 1, reason: '[IMAGE: x]' }).includes('IMAGE'));

  section('call state note');
  const sleeping = structuredClone(live);
  sleeping.activity = { kind: 'sleep', placeId: 'place:home', startAt: at(500), endAt: at(980), availability: 'asleep', withCast: [], eventId: null };
  sleeping.availability = { state: 'asleep', since: at(500), until: at(980), onPhone: false, eventId: null };
  eq('asleep → groggy', callStateNote(sleeping, at(600), audX), 'You were asleep when the phone rang — groggy, keep it short.');
  const commuting = structuredClone(live);
  commuting.activity = { kind: 'commute', placeId: null, startAt: at(500), endAt: at(530), availability: 'light', withCast: [], eventId: null };
  commuting.availability = { state: 'light', since: at(500), until: at(530), onPhone: false, eventId: null };
  commuting.position = { ...commuting.position, placeId: null, travel: { from: 'place:office', to: 'place:home', mode: 'cab', startAt: at(500), endAt: at(530), eventId: null } };
  eq('commute → on the way home by cab', callStateNote(commuting, at(510), audX), 'You are on the way home by cab.');
  check('call notes ≤ 160 chars', [sleeping, commuting, live].every(s => callStateNote(s, at(510), audX).length <= 160));
  const lines = lifeLines(live, at(420), audX, { recentText: 'flatmate?', catchUp: { awayMin: 20, newCount: 2, reason: 'busy' } });
  check('lifeLines bundles every line', lines.time.startsWith('Now:') && lines.inner && lines.cards.length === 1 && lines.catchUp.startsWith('You were away') && lines.situation === SITUATION_NOTE);
  check('castCard tolerates junk', castCard(null) === '' && castCard({ name: '' }) === '');
} finally {
  setClock(null);
  setCanUseIn(null);
  setOriginLookup(null);
}

report();
