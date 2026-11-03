// T006 — world clock (src/life/clock.js) and seeded RNG (src/life/rng.js).
// Pure: no DB, no network.

import { OFFSET_ZONE } from '../test-zone.js';
import { fakeClock, section, check, eq, near, throws, report } from './_helpers.js';

const clock = await import('../../src/life/clock.js');
const rng = await import('../../src/life/rng.js');

const {
  now, setClock, localParts, tzOffsetMinutes, zonedToUnix, dayStart, addDays, weekday, isWeekend,
  dateKey, hhmm, minuteOfDay, hourOfDay, dayLabel, parseHhmm, atLocal, ageOn, isValidTimezone, resolveTimezone,
} = clock;
const { mulberry32, hashString, rngFor, setRngSeed, getRngSeed } = rng;

const ZONE = OFFSET_ZONE; // fixed +05:45, no DST
const NY = 'America/New_York'; // has DST — the helpers must not assume a fixed offset
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

section('now / setClock');
{
  const real = now();
  check('real clock is unix seconds', Math.abs(real - Date.now() / 1000) < 5 && Number.isInteger(real));
  const fc = fakeClock(U(2026, 10, 27, 3, 30));
  setClock(fc.fn);
  eq('fake clock read through now()', now(), U(2026, 10, 27, 3, 30));
  fc.advance({ minutes: 15 });
  eq('advancing the fake clock moves now()', now(), U(2026, 10, 27, 3, 45));
  setClock(() => 1000.9);
  eq('fractional clock floored', now(), 1000);
  setClock(null);
  check('setClock(null) restores real time', Math.abs(now() - Date.now() / 1000) < 5);
  throws('setClock rejects non-functions', () => setClock(42), /function/);
}

section('timezone parts (ZONE)');
{
  const t = U(2026, 10, 27, 19, 45); // 2026-10-28 01:30 ZONE, a Wednesday
  const p = localParts(t, ZONE);
  eq('local date rolls past UTC midnight', [p.year, p.month, p.day, p.hour, p.minute], [2026, 10, 28, 1, 30]);
  eq('weekday Wed = 3', weekday(t, ZONE), 3);
  eq('hhmm', hhmm(t, ZONE), '01:30');
  eq('minuteOfDay', minuteOfDay(t, ZONE), 90);
  near('hourOfDay', hourOfDay(t, ZONE), 1.5);
  eq('dateKey', dateKey(t, ZONE), '2026-10-28');
  eq('dayLabel', dayLabel(t, ZONE), 'Wed 28 Oct');
  eq('the offset', tzOffsetMinutes(t, ZONE), 345);
  eq('dayStart = local midnight', dayStart(t, ZONE), U(2026, 10, 27, 18, 15));
  eq('dayStart of midnight is itself', dayStart(U(2026, 10, 27, 18, 15), ZONE), U(2026, 10, 27, 18, 15));
  eq('one second before midnight is the previous day', dateKey(U(2026, 10, 27, 18, 14) + 59, ZONE), '2026-10-27');
  eq('hour 0 never prints as 24', hhmm(U(2026, 10, 27, 18, 15), ZONE), '00:00');
  eq('weekdays Sun..Sat = 0..6', [0, 1, 2, 3, 4, 5, 6].map(i => weekday(U(2026, 10, 25, 5, 45) + i * 86400, ZONE)), [0, 1, 2, 3, 4, 5, 6]);
  eq('isWeekend Sun', isWeekend(U(2026, 10, 25, 5, 45), ZONE), true);
  eq('isWeekend Wed', isWeekend(U(2026, 10, 28, 5, 45), ZONE), false);
  eq('isWeekend with a custom weekend (Fri/Sat)', isWeekend(U(2026, 10, 30, 5, 45), ZONE, [5, 6]), true);
}

section('UTC and a DST zone');
{
  eq('UTC dayStart', dayStart(U(2026, 3, 8, 15, 7), 'UTC'), U(2026, 3, 8));
  // 2026-03-08 is the US spring-forward day (02:00 → 03:00 EST→EDT)
  const spring = U(2026, 3, 8, 18); // 14:00 EDT
  eq('NY spring-forward dayStart (EST midnight)', dayStart(spring, NY), U(2026, 3, 8, 5));
  eq('NY 09:00 after spring-forward', atLocal(spring, '09:00', NY), U(2026, 3, 8, 13));
  eq('NY 01:00 before the jump', atLocal(spring, '01:00', NY), U(2026, 3, 8, 6));
  eq('NY 02:30 (in the gap) lands after it', hhmm(atLocal(spring, '02:30', NY), NY), '03:30');
  eq('NY next dayStart is 23 h later', addDays(spring, 1, NY) - dayStart(spring, NY), 23 * 3600);
  // 2026-11-01 fall-back: 01:30 happens twice; first occurrence is EDT
  eq('NY 01:30 on fall-back = first occurrence', zonedToUnix(2026, 11, 1, 1, 30, NY), U(2026, 11, 1, 5, 30));
  eq('NY fall-back day is 25 h', addDays(U(2026, 11, 1, 12), 1, NY) - dayStart(U(2026, 11, 1, 12), NY), 25 * 3600);
  eq('addDays across a month end', dateKey(addDays(U(2026, 10, 31, 5, 45), 1, ZONE), ZONE), '2026-11-01');
  eq('addDays negative', dateKey(addDays(U(2026, 1, 1, 5, 45), -1, ZONE), ZONE), '2025-12-31');
}

section('hh:mm parsing and atLocal');
{
  eq('parseHhmm 07:30', parseHhmm('07:30'), 450);
  eq('parseHhmm 7:05', parseHhmm('7:05'), 425);
  eq('parseHhmm 24:00', parseHhmm('24:00'), 1440);
  throws('parseHhmm rejects 24:30', () => parseHhmm('24:30'), /hh:mm/);
  throws('parseHhmm rejects 25:00', () => parseHhmm('25:00'), /hh:mm/);
  throws('parseHhmm rejects junk', () => parseHhmm('7.30pm'), /hh:mm/);
  throws('parseHhmm rejects non-strings', () => parseHhmm(null), /hh:mm/);
  const day = U(2026, 10, 28, 2, 45); // Wed 08:30 ZONE
  eq('atLocal 09:30 ZONE', atLocal(day, '09:30', ZONE), U(2026, 10, 28, 3, 45));
  eq('atLocal minutes form', atLocal(day, 570, ZONE), U(2026, 10, 28, 3, 45));
  eq('atLocal 24:00 = next midnight', atLocal(day, '24:00', ZONE), addDays(day, 1, ZONE));
  eq('atLocal 1530 min = 01:30 next day', atLocal(day, 1530, ZONE), U(2026, 10, 28, 19, 45));
}

section('derived age');
{
  eq('day before birthday', ageOn('1999-04-12', U(2026, 4, 11, 11, 45), ZONE), 26);
  eq('on birthday', ageOn('1999-04-12', U(2026, 4, 11, 23, 45), ZONE), 27);
  eq('birthday by local (not UTC) date', ageOn('1999-04-12', U(2026, 4, 11, 18, 45), ZONE), 27); // 00:30 ZONE Apr 12
  eq('Feb 29 in a non-leap year counts from Mar 1', [ageOn('2000-02-29', U(2027, 2, 28, 11, 45), ZONE), ageOn('2000-02-29', U(2027, 3, 1, 11, 45), ZONE)], [26, 27]);
  eq('bad birthdate → null', ageOn('12/04/1999', U(2026, 1, 0, 23, 45), ZONE), null);
  eq('nonsense month → null', ageOn('1999-13-01', U(2026, 1, 0, 23, 45), ZONE), null);
}

section('timezone validation');
{
  check('valid zone', isValidTimezone(ZONE));
  check('invalid zone', !isValidTimezone('Mars/Olympus'));
  check('non-string zone', !isValidTimezone({}));
  check('invalid zone resolves to a real one', isValidTimezone(resolveTimezone('Mars/Olympus')));
  check('invalid zone does not throw', typeof dateKey(U(2026, 1, 1), 'Mars/Olympus') === 'string');
}

section('mulberry32 / hashString');
{
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 5 }, a);
  eq('same seed → same sequence', Array.from({ length: 5 }, b), seqA);
  check('outputs in [0, 1)', seqA.every(x => x >= 0 && x < 1));
  check('different seed → different sequence', mulberry32(43)() !== seqA[0]);
  eq('hashString deterministic', hashString('weather:block:1'), hashString('weather:block:1'));
  check('hashString spreads near keys', hashString('weather:block:1') !== hashString('weather:block:2'));
  check('hashString is uint32', Number.isInteger(hashString('x')) && hashString('x') >= 0 && hashString('x') < 2 ** 32);
}

section('rngFor / setRngSeed');
{
  setRngSeed(12345);
  eq('numeric seed stored', getRngSeed(), 12345);
  const s1 = Array.from({ length: 4 }, rngFor('2026-10-28', 'wake'));
  const s2 = Array.from({ length: 4 }, rngFor('2026-10-28', 'wake'));
  eq('fresh generator per call: same key → same sequence', s2, s1);
  // asking for other rolls in between must not disturb this one
  rngFor('2026-10-28', 'phone.gap')(); rngFor('2026-10-29', 'wake')();
  eq('call order independent', Array.from({ length: 4 }, rngFor('2026-10-28', 'wake')), s1);
  check('different purpose → different', rngFor('2026-10-28', 'sick')() !== s1[0]);
  check('different day → different', rngFor('2026-10-29', 'wake')() !== s1[0]);
  setRngSeed(999);
  check('setRngSeed changes the stream', rngFor('2026-10-28', 'wake')() !== s1[0]);
  setRngSeed('world-hash-abc');
  check('string seed hashed to uint32', Number.isInteger(getRngSeed()) && getRngSeed() >= 0);
  setRngSeed(12345);
  eq('restoring the seed restores the stream', Array.from({ length: 4 }, rngFor('2026-10-28', 'wake')), s1);
}

section('generator helpers');
{
  setRngSeed(7);
  const r = rngFor('2026-10-28', 'helpers');
  const N = 20000;
  let sum = 0;
  const ints = new Map();
  let chances = 0;
  for (let i = 0; i < N; i++) {
    sum += r();
    const k = r.int(1, 3);
    ints.set(k, (ints.get(k) || 0) + 1);
    if (r.chance(0.25)) chances++;
  }
  near('mean ≈ 0.5', sum / N, 0.5, 0.02);
  eq('int(1,3) inclusive, nothing else', [...ints.keys()].sort(), [1, 2, 3]);
  check('int(1,3) roughly uniform', [...ints.values()].every(c => Math.abs(c / N - 1 / 3) < 0.02), [...ints.values()]);
  near('chance(0.25) ≈ 0.25', chances / N, 0.25, 0.02);
  check('chance(0) never, chance(1) always', !r.chance(0) && r.chance(1));
  check('float(5, 6) in range', Array.from({ length: 200 }, () => r.float(5, 6)).every(x => x >= 5 && x < 6));
  check('next() is the same source', typeof r.next() === 'number');
  eq('pick on empty → undefined', r.pick([]), undefined);
  check('pick returns a member', ['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])));
  const w = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 6000; i++) w[r.weighted([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'c', weight: 0 }]).id]++;
  check('weighted follows weights, zero weight never picked', w.c === 0 && Math.abs(w.b / (w.a + w.b) - 0.75) < 0.03, w);
  const sh = r.shuffle([1, 2, 3, 4, 5]);
  eq('shuffle is a permutation', [...sh].sort(), [1, 2, 3, 4, 5]);
}

report();
