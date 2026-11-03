// Plan 020 F2: the thought stream on the real engine. It changes nothing in his life (the same run with and
// without it writes the same log), keeps to its rate, sleeps when he sleeps; a rewind or a revert sweeps
// what rested on the undone events with no duplicates after; downtime gives at most one; a restart
// gives none twice; a chat's thought goes when its message does; retention; midnight; the routes.
// Example world, fake clock, stubbed models, no network.
import { section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, fakeCallRole, HOUR, DAY } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { appendEvent, listEvents, lastEventId } from '../../src/life/eventLog.js';
import { isExcludedId } from '../../src/life/projector.js';
import { dateKey, dayStart, addDays, zonedToUnix, resolveTimezone, localParts } from '../../src/life/clock.js';
import * as story from '../../src/life/story/index.js';
import * as facade from '../../src/life/index.js';
import { insertThought, deleteFromChat, pruneThoughts, recentThoughts } from '../../src/life/thoughtStore.js';
import { getDb } from '../../src/memory/db.js';
import { openIntentions } from '../../src/mind/index.js';
import * as mindStore from '../../src/mind/store.js';
import { config } from '../../src/utils/config.js';

const JID = '15550000099@s.whatsapp.net';
const GROUP = '120363000000000099@g.us';

async function boot(opts = {}) {
  await setupScratchDb();
  const b = await bootLife({ callRole: fakeCallRole({}), ...opts });
  story.__setDepsForTest({ getUsageByCaller: () => [], knownNames: () => [] });
  config.arcs.scenesEnabled = false;
  config.arcs.phoneOrganicPerDay = 0;
  return b;
}
const rows = () => getDb().prepare('SELECT * FROM story_thoughts ORDER BY at, id').all();
const logHash = () => createHash('sha256').update(JSON.stringify(getDb().prepare('SELECT type, at, actor, cause_id, payload_json FROM world_events ORDER BY id').all())).digest('hex');

section('thoughts change nothing: the same run, with and without, writes the same log');
{
  facade.__setThoughtsForTest(false);
  const a = await boot();
  await simulateDays(3);
  const without = logHash();
  const nA = rows().length;
  await stopLife();
  facade.__setThoughtsForTest(true);
  facade.__resetThoughtsForTest();
  const b = await boot();
  await simulateDays(3);
  const withThem = logHash();
  const nB = rows().length;
  await stopLife();
  void a; void b;
  eq('none were written with the seam off', nA, 0);
  check('plenty with it on', nB > 60, String(nB));
  eq('the log is byte for byte the same', withThem, without);
}

facade.__resetThoughtsForTest();
const { world, clock, life } = await boot();
const S = () => facade.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const at = (d0, h, m = 0) => { const [y, mo, d] = dateKey(d0 + 12 * HOUR, tz).split('-').map(Number); return zonedToUnix(y, mo, d, h, m, tz); };
const stepTo = async (t) => { const h = (t - clock.now()) / HOUR; if (h > 0) await simulateHours(h, { stepMinutes: 15 }); };

section('a week of them');
{
  const start = clock.now();
  const sleepSpans = [];
  await simulateDays(7);
  for (const e of listEvents({ types: ['sleep.started'], from: start, limit: 200 })) {
    const w = listEvents({ types: ['woke'], from: e.at, limit: 1 })[0];
    if (w) sleepSpans.push([e.at, w.at]);
  }
  const all = rows().filter(r => r.at >= start);
  check('about 2–6 an hour awake', (() => { const hrs = (clock.now() - start) / HOUR * (16 / 24); const per = all.length / hrs; return per >= 2 && per <= 6; })(), String(all.length));
  check('never more than six in any hour', all.every((r) => all.filter(x => x.at > r.at - HOUR && x.at <= r.at).length <= 6));
  eq('nothing while he sleeps', all.filter(r => sleepSpans.some(([a, b]) => r.at > a + 60 && r.at < b - 60)).length, 0);
  const byText = new Map();
  for (const r of all) byText.set(r.text, (byText.get(r.text) ?? 0) + 1);
  const most = Math.max(...byText.values());
  check('no thought more than three times in a week', most <= 3, String(most));
  const fams = new Set(all.map(r => r.family));
  check('it has range', fams.has('reaction') && fams.has('body') && fams.has('wordless') && fams.has('putting_off'), [...fams].join(','));
  check('no two on top of each other', all.every((r, i) => i === 0 || r.at - all[i - 1].at >= 200), '');
  eq('every row has its log head', all.filter(r => !Number.isSafeInteger(r.as_of_event_id)).length, 0);
  check('all at or before now', all.every(r => r.at <= clock.now()));
}

section('the read: one local day, oldest first, no origin');
{
  const v = facade.thoughtsView({});
  eq('today', v.date, dateKey(clock.now(), tz));
  check('in order', v.thoughts.every((t, i) => i === 0 || t.at >= v.thoughts[i - 1].at));
  check('its fields', v.thoughts.length === 0 || Object.keys(v.thoughts[0]).sort().join() === 'at,cause,family,fromChat,id,kind,text', JSON.stringify(v.thoughts[0]));
  eq('the newest few', facade.thoughtsView({ limit: 2 }).thoughts.length, Math.min(2, v.count));
  let code = null;
  try { facade.thoughtsView({ date: '2026-13-40' }); } catch (e) { code = e.code; }
  eq('a bad date', code, 'bad_date');
  const y = addDays(dayStart(clock.now(), tz), -1, tz);
  const prev = facade.thoughtsView({ date: dateKey(y, tz) });
  check('a day holds only that local day', prev.thoughts.every(t => dateKey(t.at, tz) === prev.date));
}

section('across midnight');
{
  const d = dayStart(clock.now(), tz);
  const key = dateKey(d, tz);
  const before = d - 300;
  const after = d + 300;
  insertThought({ at: before, family: 'wordless', text: 'before midnight', dedupeKey: 'test:before' }, before);
  insertThought({ at: after, family: 'wordless', text: 'after midnight', dedupeKey: 'test:after' }, after);
  const yesterday = facade.thoughtsView({ date: dateKey(d - 3600, tz) });
  const today = facade.thoughtsView({ date: key });
  check('five to twelve: the old day', yesterday.thoughts.some(t => t.text === 'before midnight') && !today.thoughts.some(t => t.text === 'before midnight'));
  check('five past: the new one', today.thoughts.some(t => t.text === 'after midnight') && !yesterday.thoughts.some(t => t.text === 'after midnight'));
  getDb().prepare("DELETE FROM story_thoughts WHERE dedupe_key LIKE 'test:%'").run();
}

section('a revert: the thought goes with its evidence, at once');
{
  const e = appendEvent({ type: 'commute.soaked', at: clock.now(), actor: 'engine', causeId: listEvents({ types: ['travel.started'], order: 'desc', limit: 1 })[0].id, payload: { mode: 'walk' } });
  const m = appendEvent({ type: 'meal', at: clock.now(), actor: 'engine', payload: { kind: 'snack' } });
  insertThought({ at: clock.now(), family: 'reaction', text: 'rests on a meal', evidence: [m.id], asOf: lastEventId(), dedupeKey: 'test:meal' }, clock.now());
  check('there', facade.thoughtsView({}).thoughts.some(t => t.text === 'rests on a meal'));
  facade.revertEvent(m.id, { reason: 't', by: 'tester' });
  check('reverted: gone from the read before any tick', !facade.thoughtsView({}).thoughts.some(t => t.text === 'rests on a meal'));
  check('…still in the table', rows().some(r => r.text === 'rests on a meal'));
  await simulateHours(0.25);
  check('swept at the next tick', !rows().some(r => r.text === 'rests on a meal'));
  void e;
}

section('a rewind: swept, no duplicates after the replay');
{
  const t0 = clock.now();
  await simulateHours(6);
  const inRange = rows().filter(r => r.at > t0);
  check('thoughts in the stretch', inRange.length > 0);
  const p = await story.director.preview({ kind: 'rewind', at: t0, reason: 'undo' });
  const r = await story.director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('rewound', r?.ok === true, JSON.stringify(r));
  check('gone from the read at once', !facade.thoughtsView({}).thoughts.some(t => inRange.some(x => x.id === t.id)));
  await simulateHours(0.25);
  const after = rows();
  eq('swept', after.filter(x => inRange.some(y => y.id === x.id)).length, 0);
  await simulateHours(6);
  const keys = rows().map(x => x.dedupe_key).filter(Boolean);
  eq('no dedupe key twice', keys.length, new Set(keys).size);
  const evid = rows().flatMap(x => JSON.parse(x.evidence_event_ids));
  check('nothing rests on a rewound event', evid.every(id => !isExcludedId(S(), id)));
}

section('downtime: at most one, no flood');
{
  const before = rows().length;
  clock.advance({ days: 3 });
  await facade.tick();
  const n = rows().length - before;
  check('at most one for three days away', n <= 1, String(n));
}

section('a restart: nothing twice');
{
  await simulateHours(3);
  const n = rows().length;
  const t = clock.now();
  await stopLife();
  facade.__resetThoughtsForTest();
  await bootLife({ world, clock, callRole: fakeCallRole({}), intentions: (a) => openIntentions(a) });
  story.__setDepsForTest({ getUsageByCaller: () => [], knownNames: () => [] });
  eq('the clock didn\'t move', clock.now(), t);
  eq('booting at the same moment: no new thoughts', rows().length, n);
  await facade.tick();
  eq('…nor the same tick again', rows().length, n);
  await simulateHours(1);
  const keys = rows().map(x => x.dedupe_key).filter(Boolean);
  eq('…and going on: no key twice', keys.length, new Set(keys).size);
}

section('the mind\'s intentions, through its facade');
{
  const t = clock.now();
  const id = mindStore.insertElement({ kind: 'intention', intentionKind: 'check_in', createdAt: t - 5 * HOUR, expiresAt: t + 48 * HOUR, origins: [] });
  const fromChat = mindStore.insertElement({ kind: 'intention', intentionKind: 'follow_up', createdAt: t - 5 * HOUR, expiresAt: t + 48 * HOUR, origins: [{ originJid: GROUP, originKind: 'group', minLearnedAt: t - 6 * HOUR }] });
  const open = openIntentions(t);
  const own = open.find(i => i.id === id);
  eq('codes only: kind, when, origin', Object.keys(own).sort(), ['createdAt', 'id', 'kind', 'origin']);
  eq('…its own', [own.kind, own.createdAt, own.origin], ['check_in', t - 5 * HOUR, null]);
  const ch = open.find(i => i.id === fromChat);
  eq('…from a chat', ch.origin, { kind: 'group', jid: GROUP });
  // Over the next waking day, the stream gets to them.
  let own2 = null;
  let chat2 = null;
  for (let i = 0; i < 40 * 4 && !(own2 && chat2); i++) {
    await simulateHours(0.25);
    own2 = rows().find(r => r.cause_code === 'intention:check_in') ?? null;
    chat2 = rows().find(r => r.cause_code === 'intention:follow_up') ?? null;
  }
  check('he thinks of it', own2?.family === 'want_should', JSON.stringify(own2));
  eq('…his own: self origin', own2?.origin_kind, 'self');
  eq('…a chat\'s: its origin on its columns', [chat2?.origin_kind, chat2?.origin_jid], ['group', GROUP]);
  check('…the same plain words, no target', /get back|got back|follow|thing I said/.test(chat2?.text ?? ''), chat2?.text);
  check('…one thought per intention', rows().filter(r => r.cause_code === 'intention:check_in').length === 1);
}

section('a chat\'s thought goes when its message does');
{
  const p = appendEvent({ type: 'chat.perceived', at: clock.now(), actor: 'chat', originKind: 'group', originJid: GROUP, payload: { kind: 'affect', affect: 'roast', intensity: 'high', p: 0.9, msgId: 'M1' } });
  insertThought({ at: clock.now(), family: 'wordless', text: '(that stung, a bit)', originKind: 'group', originJid: GROUP, evidence: [p.id], asOf: lastEventId(), dedupeKey: 'test:chat', cause: 'chat:roast' }, clock.now());
  const v = facade.thoughtsView({}).thoughts.find(t => t.cause === 'chat:roast');
  eq('marked from a chat, no origin in the read', [v?.fromChat, v?.originJid, v?.originKind], [true, undefined, undefined]);
  check('…no JID anywhere in the read', !JSON.stringify(facade.thoughtsView({})).includes(GROUP));
  facade.revertEvent(p.id, { reason: 'revoked', by: 'tester' });
  check('its pointer undone (forget, revoke, edit): gone at once', !facade.thoughtsView({}).thoughts.some(t => t.cause === 'chat:roast'));
  await simulateHours(0.25);
  check('…and swept', !rows().some(r => r.cause_code === 'chat:roast'));

  const t = clock.now();
  insertThought({ at: t, family: 'want_should', text: 'said I\'d get back to them… didn\'t', originKind: 'group', originJid: GROUP, dedupeKey: 'test:intent' }, t);
  insertThought({ at: t - 6 * HOUR, family: 'wordless', text: '(older)', originKind: 'group', originJid: GROUP, dedupeKey: 'test:older' }, t);
  deleteFromChat([GROUP], t - 300);
  check('a thought with no event to rest on: the deletion hook takes it', !rows().some(r => r.dedupe_key === 'test:intent'));
  check('…only from that moment on', rows().some(r => r.dedupe_key === 'test:older'));
  deleteFromChat([GROUP], 0);
  check('a purge: all of them', !rows().some(r => r.origin_jid === GROUP));
}

section('redaction');
{
  const m = appendEvent({ type: 'money.spent', at: clock.now(), actor: 'engine', subjectJid: JID, payload: { amount: 5, for: 'food' } });
  insertThought({ at: clock.now(), family: 'reaction', text: 'rests on a purged event', evidence: [m.id], dedupeKey: 'test:purge' }, clock.now());
  facade.redactPerson(JID);
  check('swept with the purge', !rows().some(r => r.dedupe_key === 'test:purge'));
}

section('retention');
{
  const t = clock.now();
  insertThought({ at: t - 181 * DAY, family: 'wordless', text: 'old', dedupeKey: 'test:old' }, t);
  insertThought({ at: t - 179 * DAY, family: 'wordless', text: 'not so old', dedupeKey: 'test:notold' }, t);
  eq('pruned past 180 days', pruneThoughts(t), 1);
  check('…only those', rows().some(r => r.dedupe_key === 'test:notold') && !rows().some(r => r.dedupe_key === 'test:old'));
  getDb().prepare("DELETE FROM story_thoughts WHERE dedupe_key LIKE 'test:%'").run();
  check('the repeat memory reads a week, not everything', recentThoughts(t - 7 * DAY).every(r => r.at >= t - 7 * DAY));
}

section('the only door to the table');
{
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const files = walk('src');
  // The weekly review (plan 020 E4) samples them for the owner: a read for the dashboard, no decision or prompt.
  eq('SQL on story_thoughts: its store, its migration and the review\'s sampling only',
    files.filter(f => /story_thoughts/.test(fs.readFileSync(f, 'utf8'))).map(f => f.replace(/\\/g, '/')).sort(),
    ['src/life/thoughtStore.js', 'src/memory/migrations/016-thoughts.js', 'src/memory/reviewStore.js']);
  // phraseCheck reads the phrase table only, as the phrase banks' list of lines (plan 020 H2).
  eq('the store and the rules: the life facade only',
    files.filter(f => !f.includes('migrations') && /['"][^'"]*\/?thought(Store|s|Phrases)\.js['"]/.test(fs.readFileSync(f, 'utf8'))).map(f => f.replace(/\\/g, '/')).sort(),
    ['src/life/index.js', 'src/life/phraseCheck.js', 'src/life/thoughts.js']);
  const prompts = ['src/personality/systemPrompt.js', 'src/brain/contextBuilder.js', 'src/life/innerState.js'];
  check('no prompt builder reads thoughts', prompts.every(f => !/thoughtsView|thoughtStore|recentThoughts/.test(fs.readFileSync(f, 'utf8'))));
  const decisions = fs.readFileSync('src/life/decisions.js', 'utf8') + fs.readFileSync('src/life/pulse.js', 'utf8');
  check('no decision reads thoughts', !/\bthought/i.test(decisions.replace(/thoughtDeed/g, '')));
}

await stopLife();
report();
