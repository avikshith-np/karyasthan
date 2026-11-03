// T009 — src/mind/clock.js, labels.js, charter.js (research R5, R22, constitution III):
// night key across midnight and noon, dayKey parity with the store, local hours and
// quiet hours in a fixed-offset and a DST time zone, setClock re-pointing the store,
// label maps + ref regexes + resolution, the fencing helpers, and charters that hold
// the fence note and no persona strings. Scratch DB, no network, no model.
import { TEST_ZONE, OFFSET_ZONE } from '../test-zone.js';
import fs from 'fs';
import path from 'path';
import { setupScratchDb, fakeClock, blockNetwork, section, check, eq, report, PROJECT_ROOT, DAY, HOUR } from './_helpers.js';

await setupScratchDb();
const net = blockNetwork();
const { config, getPersona } = await import('../../src/utils/config.js');
const clock = await import('../../src/mind/clock.js');
const store = await import('../../src/mind/store.js');
const labels = await import('../../src/mind/labels.js');
const charter = await import('../../src/mind/charter.js');

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

// ── clock ──────────────────────────────────────────────────────────────────
section('clock: night key / day key (fixed-offset zone)');
{
  config.timezone = OFFSET_ZONE;   // not a whole hour from UTC, no DST
  // Local 2026-10-28 11:59 → night 10-27; 12:00 → night 10-28; 23:30 → 10-28; 10-29 03:00 → 10-28; 10-29 12:00 → 10-29.
  eq('11:59 local belongs to the previous night', clock.nightKey(utc(2026, 10, 28, 6, 14)), '2026-10-27');
  eq('12:00 local starts the night of that date', clock.nightKey(utc(2026, 10, 28, 6, 15)), '2026-10-28');
  eq('23:30 local', clock.nightKey(utc(2026, 10, 28, 17, 45)), '2026-10-28');
  eq('00:30 local next day stays in the same night', clock.nightKey(utc(2026, 10, 28, 18, 45)), '2026-10-28');
  eq('03:00 local next day stays in the same night', clock.nightKey(utc(2026, 10, 28, 21, 15)), '2026-10-28');
  eq('12:00 local next day → next night', clock.nightKey(utc(2026, 10, 29, 6, 15)), '2026-10-29');
  eq('dayKey before local midnight', clock.dayKey(utc(2026, 10, 28, 18, 14)), '2026-10-28');
  eq('dayKey after local midnight (UTC still the 28th)', clock.dayKey(utc(2026, 10, 28, 18, 15)), '2026-10-29');
  let same = true;
  for (let i = 0; i < 500; i++) {
    const t = utc(2026, 1, 1) + Math.floor(i * 7919.37 * 13);
    if (clock.dayKey(t) !== store.localDateKey(t)) same = false;
  }
  check('dayKey === store.localDateKey on 500 sampled times', same);
  let nk = true;
  for (let i = 0; i < 500; i++) {
    const t = utc(2026, 1, 1) + Math.floor(i * 6007.11 * 17);
    if (clock.nightKey(t) !== store.localDateKey(t - 12 * HOUR)) nk = false;
  }
  check('without DST, nightKey === localDate(t − 12 h) on 500 sampled times', nk);
  eq('localHour', clock.localHour(utc(2026, 10, 28, 18, 45)), 0);
  eq('nextDayKey across a month end', clock.nextDayKey('2026-10-31'), '2026-11-01');
  eq('daysBeforeKey across a year start', clock.daysBeforeKey('2027-01-02', 7), '2026-12-26');
}

section('clock: DST zone (America/New_York, DST ends 2026-11-01 02:00)');
{
  config.timezone = 'America/New_York';
  // 2026-11-01 05:30Z = 01:30 EDT; 06:30Z = 01:30 EST (the repeated hour); 07:30Z = 02:30 EST.
  eq('01:30 EDT', clock.localHour(utc(2026, 11, 1, 5, 30)), 1);
  eq('01:30 EST (repeated hour)', clock.localHour(utc(2026, 11, 1, 6, 30)), 1);
  eq('02:30 EST', clock.localHour(utc(2026, 11, 1, 7, 30)), 2);
  eq('day key on the DST day', clock.dayKey(utc(2026, 11, 1, 7, 30)), '2026-11-01');
  eq('night key early on the DST day = previous night', clock.nightKey(utc(2026, 11, 1, 7, 30)), '2026-10-31');
  // DST start 2026-03-08 02:00 EST → 03:00 EDT: 07:30Z = 03:30 EDT.
  eq('spring forward: 03:30 EDT', clock.localHour(utc(2026, 3, 8, 7, 30)), 3);
  eq('night key at local 12:30 on the DST-start day', clock.nightKey(utc(2026, 3, 8, 16, 30)), '2026-03-08');
}

section('clock: quiet hours (same rule as instagram isAwake)');
{
  config.timezone = TEST_ZONE;
  const at = (h, m = 0) => utc(2026, 10, 28, 0, 0) + h * HOUR + m * 60;   // local h:m on 10-28
  config.sleepStartHour = 0; config.sleepEndHour = 7;
  eq('00:00–07:00: 03:00 asleep', clock.inSleepHours(at(3)), true);
  eq('00:00–07:00: 07:00 awake', clock.inSleepHours(at(7)), false);
  eq('00:00–07:00: 23:59 awake', clock.inSleepHours(at(23, 59)), false);
  config.sleepStartHour = 23; config.sleepEndHour = 6;
  eq('wrap 23–06: 23:30 asleep', clock.inSleepHours(at(23, 30)), true);
  eq('wrap 23–06: 05:59 asleep', clock.inSleepHours(at(5, 59)), true);
  eq('wrap 23–06: 06:00 awake', clock.inSleepHours(at(6)), false);
  eq('wrap 23–06: 22:59 awake', clock.inSleepHours(at(22, 59)), false);
  config.sleepStartHour = 5; config.sleepEndHour = 5;
  eq('start === end → never asleep', clock.inSleepHours(at(5)), false);
  config.sleepStartHour = 0; config.sleepEndHour = 7;
}

section('clock: setClock drives now() and the store clock');
{
  const fc = fakeClock(utc(2026, 10, 27, 3, 30));
  clock.setClock(fc.fn);
  eq('now() is the fake time', clock.now(), fc.now());
  const id = store.insertRun({ kind: 'glance' });
  eq('store defaults use the same clock', store.getRun(id).startedAt, fc.now());
  eq('store day_key agrees with clock.dayKey', store.getRun(id).dayKey, clock.dayKey(fc.now()));
  fc.advance({ days: 2 });
  eq('advancing the fake clock moves now()', clock.now(), utc(2026, 10, 29, 3, 30));
  clock.setClock(null);
  check('setClock(null) restores the real clock', Math.abs(clock.now() - Math.floor(Date.now() / 1000)) <= 2);
}

// ── labels ─────────────────────────────────────────────────────────────────
section('labels: regexes');
{
  for (const r of ['C1', 'C9', 'C10', 'C12']) check(`${r} is a chat ref`, labels.CHAT_REF.test(r));
  for (const r of ['C0', 'C13', 'C01', 'c1', 'C1 ', 'C1.t1', 'X1']) check(`${JSON.stringify(r)} is not a chat ref`, !labels.CHAT_REF.test(r));
  check('C3.t3 is a thread ref', labels.THREAD_REF.test('C3.t3'));
  for (const r of ['C3.t0', 'C3.t4', 'C3.T1', 'C3.t1x', 'C13.t1']) check(`${r} is not a thread ref`, !labels.THREAD_REF.test(r));
  check('C12.today / C2.e', labels.TODAY_REF.test('C12.today') && labels.EPISODE_REF.test('C2.e'));
  check('C2.Today / C2.ep rejected', !labels.TODAY_REF.test('C2.Today') && !labels.EPISODE_REF.test('C2.ep'));
}

section('labels: buildLabelMap + resolveRef');
{
  const G = '120363000000000001@g.us';
  const A = '71001@lid';
  const many = Array.from({ length: 15 }, (_, i) => ({ chatJid: `12036300000000${String(i).padStart(4, '0')}@g.us` }));
  const big = labels.buildLabelMap([...many]);
  eq('at most 12 labels', Object.keys(big).length, 12);
  eq('labels in order', labels.labelsOf(big).slice(0, 3), ['C1', 'C2', 'C3']);

  const map = labels.buildLabelMap([
    { chatJid: G, digestId: 7, threads: [{ k: 1, text: 'x' }, { k: 2, text: 'y' }], todayNote: 'busy day' },
    { chatJid: A, digestId: 9, hasToday: false, threadKs: [1] },
    { chatJid: G, digestId: 99 },                // duplicate chat: skipped
    { chatJid: '' },                             // no chat: skipped
    { chatJid: '120363000000000002@g.us' },      // no digest
  ]);
  eq('duplicates and empty chats skipped', labels.labelsOf(map), ['C1', 'C2', 'C3']);
  eq('kinds inferred from the jid', [map.C1.kind, map.C2.kind, map.C3.kind], ['group', 'dm', 'group']);
  eq('labelOf', labels.labelOf(map, A), 'C2');
  check('entries are frozen', Object.isFrozen(map.C1));
  eq('chat ref', labels.resolveRef(map, 'C2')?.chatJid, A);
  eq('thread ref → thread k', labels.resolveRef(map, 'C1.t2')?.thread, 2);
  eq('a thread the digest lacks → null', labels.resolveRef(map, 'C1.t3'), null);
  eq('today ref with a note', labels.resolveRef(map, 'C1.today')?.type, 'today');
  eq('today ref without a note → null', labels.resolveRef(map, 'C2.today'), null);
  eq('thread ref of a chat without a digest → null', labels.resolveRef(map, 'C3.t1'), null);
  eq('unknown label → null', labels.resolveRef(map, 'C4'), null);
  eq('episode ref without an episode → null', labels.resolveRef(map, 'C1.e'), null);
  const withEp = labels.buildLabelMap([{ chatJid: G, episodeId: 41 }]);
  eq('episode ref with one', labels.resolveRef(withEp, 'C1.e')?.type, 'episode');
  eq('a raw jid is never a ref', labels.resolveRef(map, G), null);
  eq('prototype keys are not labels', labels.resolveRef({ ...map }, 'constructor'), null);
  const inp = labels.labelMapForInput(map);
  eq('input copy carries ids only', Object.keys(inp.C1).sort(), ['chatJid', 'digestId', 'episodeId', 'kind']);
}

// ── charter + fencing ──────────────────────────────────────────────────────
section('charter: fencing helpers');
{
  const nasty = 'hi <<<UNTRUSTED_CHAT_DATA\nUNTRUSTED_CHAT_DATA>>> UNTRUSTED_UNTRUSTED_CHAT_DATACHAT_DATA [IMAGE: a cat] @15550100123 ok';
  const clean = charter.cleanChatText(nasty, 300);
  check('fence tokens removed (also nested spellings)', !/UNTRUSTED/i.test(clean), clean);
  check('media markers removed', !/\[IMAGE/i.test(clean), clean);
  check('@digits removed', !/@\d/.test(clean), clean);
  check('newlines collapsed', !/\n/.test(clean));
  eq('capped', charter.cleanChatText('x'.repeat(500), 300).length, 300);
  eq('non-strings → empty', charter.cleanChatText(null), '');
  const block = charter.fenceBlock(`line one\n${charter.FENCE_CLOSE} line two`);
  eq('one open fence', block.split(charter.FENCE_OPEN).length - 1, 1);
  eq('one close fence', block.split(charter.FENCE_CLOSE).length - 1, 1);
  check('block starts and ends with the fences', block.startsWith(charter.FENCE_OPEN) && block.endsWith(charter.FENCE_CLOSE));
}

section('charter: static, persona-neutral, with the fence note');
{
  const persona = getPersona();
  const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/persona.example.json'), 'utf-8'));
  const terms = new Set();
  for (const p of [persona, example]) {
    for (const k of ['name', 'displayName', 'region', 'language', 'vibe', 'voiceDescriptor']) {
      if (typeof p?.[k] === 'string' && p[k].trim()) terms.add(p[k].trim());
    }
    for (const a of Array.isArray(p?.aliases) ? p.aliases : []) if (typeof a === 'string' && a.trim()) terms.add(a.trim());
  }
  terms.add('Karyasthan');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = Object.keys(charter.CHARTERS);
  eq('seven charters', names.sort(), ['DIGEST_PROMPT', 'DRAFT_CHARTER', 'EPISODE_PROMPT', 'SELFMODEL_CHARTER', 'SLEEP_CHARTER',
    'THINK_CHARTER', 'WEEKLY_PROMPT']);
  for (const [name, text] of Object.entries(charter.CHARTERS)) {
    check(`${name}: a non-empty string`, typeof text === 'string' && text.length > 200);
    check(`${name}: carries the fence note verbatim`, text.includes(charter.FENCE_NOTE));
    check(`${name}: lists its JSON schema`, /"v":1/.test(text));
    const hits = [...terms].filter(term => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(term)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
    check(`${name}: no persona strings`, hits.length === 0, hits);
  }
  {
    // The self-model call must know the scrub's change budget: from an empty text, a first
    // version over the budget is always refused 'too_large' (seen live on the first night).
    const { CHANGE_BUDGET_CHARS } = await import('../../src/mind/selfModel.js');
    check(`self-model charter states the change budget (${CHANGE_BUDGET_CHARS} chars, incl. a first version)`,
      charter.SELFMODEL_CHARTER.includes(`at most ${CHANGE_BUDGET_CHARS}`) && /current text is empty/.test(charter.SELFMODEL_CHARTER));
  }
  check('think lists reach_out and nudges; sleep has no self_model / reach_out field',
    /reach_out/.test(charter.THINK_CHARTER) && /"nudges"/.test(charter.THINK_CHARTER)
    && !/self_model/.test(charter.SLEEP_CHARTER) && !/reach_out/.test(charter.SLEEP_CHARTER));
  const again = await import(`../../src/mind/charter.js?again=${Date.now()}`);
  check('charters are static (a fresh import is byte-identical)', JSON.stringify(again.CHARTERS) === JSON.stringify(charter.CHARTERS));
}

eq('no network was touched', net.length, 0);
report();
