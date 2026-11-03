// Plan 020 F2: the thought stream's rules, on fixtures in the real event shapes. Each family, the competition,
// the rate and the memory; what a heavy stretch, a sick day, a private session and a chat may and may not
// produce; every phrase for every pronoun, and what the bank must never say. Pure: no DB, no clock, no network.
import { section, check, eq, report } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { tickThoughts, contextOf, streamKind, FAMILIES, MAX_PER_HOUR, EVIDENCE_WINDOW_SEC } from '../../src/life/thoughts.js';
import * as P from '../../src/life/thoughtPhrases.js';
import { pronounsOf } from '../../src/life/liveSession.js';
import { rngFor } from '../../src/life/rng.js';

const AT = 1793300000;
const MIN = 60;
const HOUR = 3600;
const JID = '15550000075@s.whatsapp.net';
const GROUP = '120363000000000075@g.us';
const ana = { id: 'cast:ana', name: 'Ana Reed', pronouns: 'she/her', metrics: { closeness: 0.7 } };
const bo = { id: 'cast:bo', name: 'Bo', pronouns: 'he/him', metrics: { closeness: 0.3 } };
const state = (o = {}) => ({
  genesisAt: 1, at: AT, activity: { kind: 'free', placeId: 'place:home', startAt: AT - HOUR, withCast: [] }, position: { placeId: 'place:home' },
  self: { homePlaceId: 'place:home' }, vitals: { energy: 60, hunger: 30, stress: 20, socialBattery: 60, sleepDebt: 0, workPressure: 30, mood: { valence: 0 } },
  decisions: new Map(), cast: new Map([[ana.id, ana], [bo.id, bo]]), story: {}, ...o,
});
let nextId = 1000;
const ev = (type, payload = {}, o = {}) => ({ id: ++nextId, type, at: AT - 5 * MIN, actor: 'engine', payload, originKind: 'self', originJid: null, subjectJid: null, ...o });
const NAME = (id) => ({ 'cast:ana': 'Ana', 'cast:bo': 'Bo' }[id] ?? null);
const run = (o = {}) => tickThoughts({
  s: state(o.state), at: AT, tickSec: 900, steps: 1, rng: (k) => rngFor('2026-11-05', `t:${o.seed ?? ''}:${k}`), hourOf: () => o.hour ?? 15,
  events: [], live: { active: false }, recent: [], memberOf: (id) => state().cast.get(id), nameOf: NAME, anyName: (id) => NAME(id) ?? (id === 'cast:gone' ? 'Cy' : null), asOf: 500, ...o,
});
// The same tick over many seeds: what can surface here, and how often.
const many = (o = {}, n = 60) => { const out = []; for (let i = 0; i < n; i++) out.push(...run({ ...o, seed: i })); return out; };
const texts = (rows) => rows.map(r => r.text).join(' | ');

section('asleep, and a world not yet begun');
{
  eq('asleep: nothing', many({ state: { activity: { kind: 'sleep', startAt: AT - HOUR } } }).length, 0);
  eq('no world yet: nothing', run({ state: { genesisAt: null } }).length, 0);
}

section('a totally empty day');
{
  const bare = many({ state: { activity: null, position: null, self: {}, vitals: {}, decisions: new Map(), cast: new Map(), weather: null } }, 100);
  check('nothing to go on: no throw, a mind that wanders', bare.length > 0 && bare.some(r => r.family === 'wordless'), texts(bare));
  check('…and no name in it', !/\{|undefined|null/.test(texts(bare)), texts(bare));
}

section('the rate: sparse, with silence');
{
  const per = (o) => many(o, 120).length / 120 * 4;
  const home = per({});
  check('at home: about 2–6 an hour', home >= 2 && home <= 6, String(home));
  const work = per({ state: { activity: { kind: 'work', placeId: 'place:office', startAt: AT - HOUR, withCast: [] } } });
  check('at work: fewer than at home', work < home && work >= 1, `${work} vs ${home}`);
  check('some ticks are silent', Array.from({ length: 60 }, (_, i) => run({ seed: i }).length).some(n => n === 0));
  const full = Array.from({ length: MAX_PER_HOUR }, (_, i) => ({ at: AT - i * 5 * MIN, family: 'wordless', phraseKey: `x${i}` }));
  eq('six in the last hour: no seventh, whatever happened', many({ recent: full, events: [ev('sick.started')] }).length, 0);
  check('a tick gives at most two', Array.from({ length: 60 }, (_, i) => run({ seed: i, events: [ev('sick.started'), ev('commute.soaked'), ev('work.crunch')] }).length).every(n => n <= 2));
  const lots = [ev('weather.changed', { rain: true }), ev('work.late'), ev('work.crunch'), ev('money.salary'), ev('commute.soaked'), ev('phone.message', { castId: 'cast:ana', dir: 'in' })];
  const busy = many({ events: lots }, 30);
  check('a very busy moment still competes: no flood', busy.length / 30 <= 2, String(busy.length / 30));
  const two = many({ events: lots }, 60);
  check('…and two in one tick come from two families', Array.from({ length: 60 }, (_, i) => run({ seed: i, events: lots })).every(r => r.length < 2 || r[0].family !== r[1].family));
  check('…at least 4 minutes apart', Array.from({ length: 60 }, (_, i) => run({ seed: i, events: lots })).every(r => r.length < 2 || r[1].at - r[0].at >= 240));
  void two;
  const quiet = run({ recent: [{ at: AT - 60, family: 'wordless', phraseKey: 'x' }] });
  eq('a minute after the last one: silence', quiet.length, 0);
}

section('reactions');
{
  check('rain', /rain|came out of nowhere|there it goes|brought something/.test(texts(many({ events: [ev('weather.changed', { rain: true })] }))), texts(many({ events: [ev('weather.changed', { rain: true })] })));
  const row = many({ events: [ev('commute.soaked')] }).find(r => r.cause === 'soaked');
  check('soaked: salient, with its evidence', !!row && row.evidence.length === 1 && row.family === 'reaction');
  const off = ev('decision.expired', { decisionId: 5, reason: 'fell_through' });
  check('a plan cancelled', many({ events: [off] }).some(r => r.cause === 'expired:fell_through'));
  const miss = ev('decision.expired', { decisionId: 5, reason: 'could_not_go' });
  check('couldn\'t go', many({ events: [miss] }).some(r => r.cause === 'expired:could_not_go' && P.REACTIONS.missed.includes(r.text)));
  for (const o of ['well', 'flat', 'badly']) check(`a scene that went ${o}`, many({ events: [ev('scene.played', { outcome: o, mode: 'full' })] }).some(r => r.cause === `scene:${o}`));
  check('a real person\'s scene: nothing', !many({ events: [ev('scene.played', { outcome: 'well', mode: 'self_only' }, { subjectJid: JID })] }).some(r => r.cause?.startsWith('scene:')));
  check('old news is gone: the facade reads only the window', EVIDENCE_WINDOW_SEC === 45 * MIN);
  const stale = many({ events: [ev('weather.changed', { rain: true }, { at: AT - 44 * MIN })] }).filter(r => r.cause === 'rain').length;
  const fresh = many({ events: [ev('weather.changed', { rain: true }, { at: AT - 2 * MIN })] }).filter(r => r.cause === 'rain').length;
  check('news decays: fresh rain beats stale rain', fresh > stale, `${fresh} vs ${stale}`);
  const r0 = many({ events: [ev('woke', {}, { at: AT - 5 * MIN })], hour: 7 }).find(r => r.cause === 'woke');
  check('waking', P.REACTIONS.woke.includes(r0?.phraseKey), JSON.stringify(r0));
}

section('want vs should');
{
  const d = { id: 7, kind: 'eat-out', status: 'committed', committed: { optionId: 'go', eventId: 8 }, lean: { optionId: 'stay', eventId: 9, at: AT - HOUR }, subject: { eventAt: AT + HOUR, castIds: ['cast:ana'] }, origins: [] };
  const rows = many({ state: { decisions: new Map([[7, d]]) } }).filter(r => r.family === 'want_should');
  check('a lean against a commitment', rows.some(r => r.cause === 'lean_vs_commit'), texts(rows));
  const tired = many({ state: { decisions: new Map([[7, d]]), vitals: { ...state().vitals, energy: 25 } } }).filter(r => r.cause === 'committed_tired');
  check('…wrecked before it', tired.length > 0);
  const said = tired.find(r => /dinner out with Ana/.test(r.text)) ?? many({ state: { decisions: new Map([[7, d]]), vitals: { ...state().vitals, energy: 25 } } }, 200).find(r => /dinner out with Ana/.test(r.text));
  check('…naming the plan, in code words', !!said, texts(tired));
  const chat = { ...d, adopted: true, subjectJid: JID, origins: [{ kind: 'dm', jid: JID }] };
  const cr = many({ state: { decisions: new Map([[7, chat]]), vitals: { ...state().vitals, energy: 25 } } }, 200);
  check('a real person\'s plan: "plans with a friend"', cr.some(r => /plans with a friend/.test(r.text)), texts(cr.filter(r => r.family === 'want_should')));
  check('…no name, no JID in any field of any row', !JSON.stringify(cr.map(r => ({ ...r, originJid: null }))).includes(JID) && !/Ana/.test(cr.filter(r => r.family === 'want_should').map(r => r.text).join()));
  const c1 = cr.find(r => r.family === 'want_should');
  eq('…its origin kept for the sweep, on its own columns', [c1?.originKind, c1?.originJid], ['dm', JID]);
  const far = { ...d, subject: { eventAt: AT + 12 * HOUR, castIds: [] } };
  check('a plan far off: not on his mind yet', !many({ state: { decisions: new Map([[7, far]]) } }).some(r => r.cause === 'lean_vs_commit'));
  const iOld = [{ id: 3, kind: 'check_in', createdAt: AT - 5 * HOUR, origin: null }];
  check('a mind intention, a while ago', many({ intentions: iOld }, 200).some(r => r.cause === 'intention:check_in' && P.WANT_SHOULD.intention.check_in.includes(r.text)));
  check('…not one from a moment ago', !many({ intentions: [{ ...iOld[0], createdAt: AT - 30 * MIN }] }, 100).some(r => r.cause === 'intention:check_in'));
  const iChat = [{ id: 4, kind: 'follow_up', createdAt: AT - 5 * HOUR, origin: { kind: 'group', jid: GROUP } }];
  const ic = many({ intentions: iChat }, 200).find(r => r.cause === 'intention:follow_up');
  eq('…from a chat: its origin on its columns, the same plain words', [ic?.originKind, ic?.originJid, P.WANT_SHOULD.intention.follow_up.includes(ic?.text)], ['group', GROUP, true]);
  check('an intention kind he doesn\'t know: nothing, no throw', run({ intentions: [{ id: 5, kind: 'nope', createdAt: 0 }] }) !== undefined);
  check('out of work: no "should be working"', !many({ employed: false, hour: 20, state: { vitals: { ...state().vitals, workPressure: 90 } } }, 200).some(r => r.cause === 'should_work'));
  check('…with a job, in the evening: yes', many({ employed: true, hour: 20, state: { vitals: { ...state().vitals, workPressure: 90 } } }, 200).some(r => r.cause === 'should_work'));
  check('…not at 7 in the morning', !many({ employed: true, hour: 7, state: { vitals: { ...state().vitals, workPressure: 90 } } }, 200).some(r => r.cause === 'should_work'));
}

section('putting things off');
{
  const d = { id: 7, kind: 'drinks', status: 'open', lean: { optionId: 'go', eventId: 9 }, subject: { eventAt: AT + 2 * HOUR, castIds: [] }, opensAt: AT - HOUR };
  check('an open decision', many({ state: { decisions: new Map([[7, d]]) } }, 200).some(r => r.cause === 'decide_later'));
  const un = ev('phone.message', { castId: 'cast:ana', dir: 'in' }, { at: AT - 2 * HOUR });
  const row = many({ unanswered: [un] }, 200).find(r => r.cause === 'reply_later');
  check('someone waiting on an answer, by name', /Ana|should answer|later/.test(row?.text ?? ''), JSON.stringify(row));
  check('late, still up', many({ hour: 23 }, 200).some(r => r.cause === 'bedtime'));
  check('…not in the afternoon', !many({ hour: 15 }, 200).some(r => r.cause === 'bedtime'));
}

section('his body');
{
  const v = (o) => ({ state: { vitals: { ...state().vitals, ...o } } });
  const c = (o, cause, n = 200) => many(v(o), n).filter(r => r.cause === cause);
  check('starving', c({ hunger: 90 }, 'hunger').some(r => P.BODY.starving.includes(r.text)));
  check('wrecked', c({ energy: 10 }, 'energy').some(r => P.BODY.wrecked.includes(r.text)));
  check('not hungry: not a word', !many(v({ hunger: 10 }), 200).some(r => r.cause === 'hunger'));
  eq('body rows read as body in the stream', [streamKind('body'), streamKind('wordless'), streamKind('reaction')], ['body', 'feeling', 'thought']);
  const sick = many({ state: { vitals: { ...state().vitals, sick: true }, activity: { kind: 'sick', placeId: 'place:home', startAt: AT - HOUR } } }, 200);
  check('sick: he reads sick', sick.some(r => P.BODY.sick.includes(r.text)), texts(sick));
  eq('sick: its own rate', contextOf(state({ vitals: { sick: true } }), null), 'sick');
}

section('people');
{
  const inn = ev('phone.message', { castId: 'cast:ana', dir: 'in' });
  check('a text from someone', many({ events: [inn] }).some(r => r.cause === 'text' && /Ana|should answer/.test(r.text)));
  const rel = ev('relationship.changed', { castId: 'cast:ana', delta: { closeness: 0.03 } });
  check('a bond that moved', many({ events: [rel] }, 200).some(r => r.cause === 'closer'));
  const ten = ev('relationship.changed', { castId: 'cast:ana', delta: { tension: 0.05 } });
  check('…the other way', many({ events: [ten] }, 200).some(r => r.cause === 'tension'));
  check('a real person\'s relationship row: nothing', !many({ events: [ev('relationship.changed', { castId: 'cast:ana', delta: { closeness: 0.5 } }, { subjectJid: JID })] }, 100).some(r => r.cause === 'closer'));
  check('someone close, now and then', many({ closest: [{ name: 'Ana', partner: false }] }, 300).some(r => r.cause === 'ambient' && /Ana/.test(r.text)));
  check('a romance has its own words', many({ closest: [{ name: 'Ana', partner: true }] }, 300).some(r => r.cause === 'romance' && P.PEOPLE.romance_ambient.map(x => x.replaceAll('{name}', 'Ana')).includes(r.text)));
  const home = { activity: { kind: 'dinner', placeId: 'place:home', startAt: AT - 10 * MIN, withCast: ['cast:bo'] } };
  check('someone in the room at dinner', many({ state: home }, 200).some(r => r.cause === 'with_home' && /Bo/.test(r.text)));
}

section('a departed cast member');
{
  const gone = ev('cast.departed', { castId: 'cast:gone' });
  const r = many({ events: [gone] }).find(x => x.cause === 'departed');
  check('the news of it', /Cy/.test(r?.text ?? ''), JSON.stringify(r));
  const old = many({ departed: ['Cy'] }, 800).filter(x => x.cause === 'departed');
  check('…later, now and then', old.length > 0 && old.length < 60, String(old.length));
  check('…in the past, never as if here', old.every(x => P.PEOPLE.departed.map(p => p.replaceAll('{name}', 'Cy')).includes(x.text)), texts(old));
  const txt = ev('phone.message', { castId: 'cast:gone', dir: 'in' });
  check('a text naming someone not in his world: nothing', !many({ events: [txt] }).some(x => x.cause === 'text'));
}

section('the excuse after a choice against his lean');
{
  const row = { id: 7, against: true, lastLean: { optionId: 'stay', p: 0.72, eventId: 9 }, deed: { status: 'committed', at: AT - 20 * MIN, optionId: 'go', cause: 'draw' } };
  const r = many({ deeds: [row] }, 100).find(x => x.family === 'excuse');
  check('he went anyway: a reason, not the cause', P.EXCUSES.went.includes(r?.text), JSON.stringify(r));
  eq('…the true cause in its own column', r?.cause, 'against_lean:draw');
  eq('…what he leaned to, in codes', [r?.codes.lean, r?.codes.did, r?.codes.p], ['stay', 'go', 0.72]);
  eq('…resting on the decision and the lean', r?.evidence, [7, 9]);
  const st = { ...row, lastLean: { optionId: 'go', p: 0.6, eventId: 9 }, deed: { ...row.deed, optionId: 'stay' } };
  check('he stayed: its own excuses', P.EXCUSES.stayed.includes(many({ deeds: [st] }, 100).find(x => x.family === 'excuse')?.text));
  check('with his lean: none', !many({ deeds: [{ ...row, against: false }] }, 100).some(x => x.family === 'excuse'));
  check('expired: none', !many({ deeds: [{ ...row, deed: { ...row.deed, status: 'expired' } }] }, 100).some(x => x.family === 'excuse'));
  check('hours later: none', !many({ deeds: [{ ...row, deed: { ...row.deed, at: AT - 3 * HOUR } }] }, 100).some(x => x.family === 'excuse'));
}

section('from a chat: a feeling and its origin, nothing else');
{
  const WORDS = 'meet-me-at-the-secret-bar';
  const p = ev('chat.perceived', { kind: 'affect', affect: 'roast', intensity: 'high', p: 0.9, msgId: WORDS, text: WORDS }, { originKind: 'group', originJid: GROUP, actor: 'chat' });
  const r = many({ events: [p] }, 200).find(x => x.cause?.startsWith('chat:'));
  check('a roast stings', P.WORDLESS.chat_sting.includes(r?.text), JSON.stringify(r));
  eq('…its origin', [r?.originKind, r?.originJid, r?.family], ['group', GROUP, 'wordless']);
  check('…no field holds a word of it', !JSON.stringify(r).includes(WORDS));
  eq('…resting on the pointer: revoked, it goes', r?.evidence, [p.id]);
  const w = ev('chat.perceived', { kind: 'affect', affect: 'praise' }, { originKind: 'dm', originJid: JID, actor: 'chat' });
  check('praise warms', many({ events: [w] }, 200).some(x => P.WORDLESS.chat_warm.includes(x.text)));
  const i = ev('chat.perceived', { kind: 'invite' }, { originKind: 'dm', originJid: JID, actor: 'chat' });
  check('an invitation: not a feeling', !many({ events: [i] }, 200).some(x => x.cause?.startsWith('chat:')));
  const notChat = ev('chat.perceived', { kind: 'affect', affect: 'roast' });
  check('no chat origin: not read as one', !many({ events: [notChat] }, 100).some(x => x.cause?.startsWith('chat:')));
}

section('on an outing: it fits the phase and who is there');
{
  const live = (o) => ({ active: true, mode: 'full', phase: 'main', them: [{ castId: 'cast:ana', mood: 'high' }], ...o });
  const onOut = { kind: 'hangout', placeId: 'place:cafe', startAt: AT - HOUR, withCast: ['cast:ana'] };
  const go = (o, extra = {}) => many({ live: live(o), state: { activity: onOut }, ...extra }, 200);
  eq('its context', contextOf(state(), live({})), 'outing');
  const high = go({});
  check('going well: warm words', high.some(r => r.cause === 'out:main' && P.PEOPLE.out_main_high.map(x => x.replaceAll("{she's}", "she's").replaceAll('{she}', 'she').replaceAll('{them}', 'her')).includes(r.text)), texts(high));
  const low = go({ them: [{ castId: 'cast:ana', mood: 'low' }] });
  check('going badly: not', low.some(r => P.PEOPLE.out_main_low.map(x => x.replaceAll("{she's}", "she's").replaceAll('{she}', 'she')).includes(r.text)) && !low.some(r => /this is nice|I missed this/.test(r.text)), texts(low));
  check('leaving', go({ phase: 'leaving' }).some(r => r.cause === 'out:leaving'));
  check('a first meeting has its own nerves', many({ live: live({ phase: 'arriving' }), firstMeet: true, state: { activity: onOut } }, 200).some(r => P.PEOPLE.out_arriving_first.includes(r.text)));
  const all = texts(high);
  check('no chores, no work, no bed while he is out', !/laundry|dishes|that tab|one more, then bed|should be working/.test(all), all);
  const buzz = ev('phone.message', { castId: 'cast:bo', dir: 'in' });
  check('a text from someone else: leave it', go({}, { events: [buzz] }).some(r => P.PEOPLE.text_in_with.includes(r.text)));
  const fromHer = ev('phone.message', { castId: 'cast:ana', dir: 'in' });
  check('from the person he\'s with: no such thought', !go({}, { events: [fromHer] }).some(r => r.cause === 'text'));
  const minimal = many({ live: { active: true, mode: 'minimal', reason: 'real_person' }, state: { activity: { kind: 'hangout', placeId: 'place:cafe', startAt: AT - HOUR, withCast: [] } }, closest: [{ name: 'Ana', partner: true }] }, 200);
  check('a real person\'s outing: plain words, no names', minimal.length > 0 && minimal.every(r => !/Ana|Bo/.test(r.text)), texts(minimal));
  const two = many({ live: live({ them: [{ castId: 'cast:ana', mood: 'ok' }, { castId: 'cast:bo', mood: 'ok' }] }), state: { activity: { ...onOut, withCast: ['cast:ana', 'cast:bo'] } } }, 200);
  check('two people: never "she"', !/\bshe\b|\bher\b/.test(texts(two)), texts(two));
}

section('a private session: neutral words only');
{
  const rows = many({ live: { active: true, mode: 'full', private: true, phase: 'main', them: [{ castId: 'cast:ana', mood: 'high' }] }, state: { activity: { kind: 'visit', placeId: 'place:home', startAt: AT - HOUR, withCast: ['cast:ana'], }, vitals: { ...state().vitals, hunger: 90, energy: 10 } }, closest: [{ name: 'Ana', partner: true }], events: [ev('phone.message', { castId: 'cast:bo', dir: 'in' })] }, 200);
  check('only its few words', rows.length > 0 && rows.every(r => P.WORDLESS.private.includes(r.text)), texts(rows));
}

section('a heavy stretch: quiet, and nothing dark is invented');
{
  const rows = many({ heavy: true, events: [ev('weather.changed', { rain: true }), ev('work.crunch')], closest: [{ name: 'Ana', partner: false }] }, 400);
  check('much quieter', rows.length / 400 * 4 <= 1.6, String(rows.length / 400 * 4));
  check('only his body and the plain words', rows.every(r => r.family === 'wordless' ? P.WORDLESS.heavy.includes(r.text) : r.family === 'body'), texts(rows));
  const tired = many({ heavy: true, state: { vitals: { ...state().vitals, energy: 10, stress: 90 } } }, 300);
  check('his body may still say tired', tired.some(r => P.BODY.wrecked.includes(r.text)));
  check('…but stress has no lines here', !tired.some(r => r.cause === 'stress'));
  const DARK = /\b(die|dead|death|kill|suicide|funeral|hopeless|worthless|hate myself|end it|grief|cancer)\b/i;
  const flat = [];
  const walk = (v) => { if (typeof v === 'string') flat.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const t of [P.REACTIONS, P.WANT_SHOULD, P.PUTTING_OFF, P.BODY, P.PEOPLE, P.WORDLESS, P.EXCUSES]) walk(t);
  eq('no dark line anywhere in the bank', flat.filter(s => DARK.test(s)), []);
}

section('downtime, a restart');
{
  const old = ev('weather.changed', { rain: true });
  const up = Array.from({ length: 40 }, (_, i) => run({ seed: i, steps: 90, reanchored: true, events: [old, ev('work.crunch'), ev('sick.started')] }));
  check('a catch-up tick: at most one', up.every(r => r.length <= 1));
  eq('…none right after a recent one', many({ steps: 90, recent: [{ at: AT - 2 * MIN, family: 'wordless' }] }, 40).length, 0);
  const first = run({ seed: 'x' });
  const rerun = run({ seed: 'x', recent: first.map(r => ({ ...r })) });
  check('a tick run again: nothing new', first.length === 0 || rerun.length === 0, texts(rerun));
  const r1 = run({ seed: 7 }); const r2 = run({ seed: 7 });
  eq('the same tick reads the same', JSON.stringify(r1), JSON.stringify(r2));
}

section('the memory');
{
  const e = ev('commute.soaked');
  const r = many({ events: [e] }, 50).find(x => x.cause === 'soaked');
  eq('a thought from evidence has a key of it', r.dedupeKey, `reaction:e${e.id}`);
  check('…so it isn\'t thought twice', !many({ events: [e], recent: [{ at: AT - HOUR, family: 'reaction', dedupeKey: r.dedupeKey }] }, 100).some(x => x.cause === 'soaked'));
  const ambient = many({}, 50)[0];
  check('an ambient one has its tick\'s slot', /^slot:/.test(ambient.dedupeKey), ambient.dedupeKey);
  const allNeutral = P.WORDLESS.neutral.map((t, i) => ({ at: AT - 3 * HOUR - i * 300, family: 'wordless', phraseKey: t }));
  check('every phrase said lately: that pool goes quiet', !many({ recent: allNeutral }, 200).some(x => P.WORDLESS.neutral.includes(x.text)));
  const usedOld = P.WORDLESS.neutral.map((t, i) => ({ at: AT - 4 * 86400 - i * 300, family: 'wordless', phraseKey: t }));
  check('…days later, it may speak again', many({ recent: usedOld }, 200).some(x => P.WORDLESS.neutral.includes(x.text)));
  const oneLeft = P.REACTIONS.home.slice(1).map((t, i) => ({ at: AT - 5 * 86400 - i * 300, family: 'reaction', phraseKey: t }));
  const pick = many({ recent: oneLeft }, 200).filter(x => x.cause === 'home');
  check('the least used goes first', pick.length > 0 && pick.every(x => x.text === P.REACTIONS.home[0]), texts(pick));
}

section('every phrase, every pronoun');
{
  const flat = [];
  const walk = (v) => { if (typeof v === 'string') flat.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const t of [P.REACTIONS, P.WANT_SHOULD, P.PUTTING_OFF, P.BODY, P.PEOPLE, P.WORDLESS, P.EXCUSES]) walk(t);
  check('a real variety of them', flat.length >= 350, String(flat.length));
  const sets = [ana, bo, { pronouns: 'they/them' }].map(x => pronounsOf([x]));
  const fill = (s, p) => s.replaceAll("{she's}", p["she's"]).replaceAll('{she}', p.she).replaceAll('{her}', p.her).replaceAll('{them}', p.them).replaceAll('{name}', 'Ana').replaceAll('{plan}', 'coffee');
  const bad = [];
  for (const s of flat) for (const p of sets) {
    const out = fill(s, p);
    if (/[{}]/.test(out)) bad.push(`token: ${out}`);
    if (/they're (?:been|got|gone|had|done|left|come|seen|taken)\b|\bthey (?:has|is|was|wants|does|goes|says)\b|\b(?:she|he) (?:have|are|want|go)\b/.test(out)) bad.push(`verb: ${out}`);
  }
  eq('every phrase reads right for she, he and they', bad, []);
  const NEVER = /\b(sex|sexy|naked|nude|undress|strip|kiss(ed|ing)?|bed with|moan|horny|aroused|lust|breast|thigh|lips|skin|tongue|orgasm|condom|fuck|shag|turned on)\b/i;
  eq('no phrase is sexual or suggestive', flat.filter(s => NEVER.test(s)), []);
  check('clipped: none runs long', flat.every(s => s.length <= 62), flat.filter(s => s.length > 62).join(' | '));
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = fs.readFileSync(path.join(here, '../../src/life/thoughtPhrases.js'), 'utf8');
  check('the bank reads nothing: no import, no state', !/\bimport\b/.test(src) && !/getPersona|config\./.test(src));
  const persona = JSON.parse(fs.readFileSync(path.join(here, '../../src/personality/persona.example.json'), 'utf8'));
  const terms = [persona.name, persona.displayName, ...(persona.aliases ?? [])].filter(Boolean).map(s => s.toLowerCase());
  eq('no persona name', flat.filter(s => terms.some(t => new RegExp(`\\b${t}\\b`).test(s.toLowerCase()))), []);
  eq('no region, no timezone', flat.filter(s => /Asia\/|Europe\/|America\/|India|Malayalam|Manglish|rupee/i.test(s)), []);
  eq('every family is one the table allows', FAMILIES.length, 7);
}

report();
