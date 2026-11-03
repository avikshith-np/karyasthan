// 018 His wallet (plan §A, §B): the wallet's cut-over (wallet.started, then no
// hourly baseline drain), itemized spends — rent / bills / the weekly basket at
// wake, a meal away from home and an outing caused by their activity.started (a
// revert of the activity takes its spend; a chat-caused one keeps the chat's
// origin) —, the salary catch-up (paid on or after the payday, never for a month
// before genesis: payday 1 with genesis on 27 Oct → nothing for October, paid at
// the 1 Nov wake), a reverted recurring spend stays undone for its period, and
// walletView's shape (castNames, contiguous daily, signed adjustment, the
// owner's label). Example world (payday 1, salary 60000, baseline 35000), fake
// clock, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, simulateHours, HOUR,
} from '../arcs-tests/_helpers.js';
import { getEvent, listEvents, appendEvent, cascadeIds } from '../../src/life/eventLog.js';
import { dateKey, zonedToUnix } from '../../src/life/clock.js';
import * as spending from '../../src/life/spending.js';
import * as director from '../../src/life/story/director.js';
import { buildWalletView, labelOf, moneyOf, WalletError } from '../../src/life/wallet.js';

await setupScratchDb();
const { world, clock, life } = await bootLife();
const tz = world.timezone;
const S = () => life.getState();
const money = (types = ['money.salary', 'money.spent', 'money.adjusted', 'wallet.started']) => listEvents({ types, limit: 2000 });
const startMoney = S().vitals.money;

section('units: the salary / monthly rule');
{
  const Z = (y, m, d, h = 7) => zonedToUnix(y, m, d, h, 0, tz);
  const st = (genesisAt, last = null) => ({ genesisAt, money: { lastSalaryAt: last } });
  const w = { money: { payday: 1, salary: 100 } };
  eq('payday 1, genesis 29 Oct: no back-pay for October (30 Oct wake)', spending.salaryDue(st(Z(2026, 10, 29, 3)), Z(2026, 10, 30), w, tz), null);
  eq('…paid at the 1 Nov wake', spending.salaryDue(st(Z(2026, 10, 29, 3)), Z(2026, 11, 1), w, tz), '2026-11');
  eq('…and at the 3 Nov wake when the 1st was missed (downtime)', spending.salaryDue(st(Z(2026, 10, 29, 3)), Z(2026, 11, 3), w, tz), '2026-11');
  eq('…not again once paid this month', spending.salaryDue(st(Z(2026, 10, 29, 3), Z(2026, 11, 1)), Z(2026, 11, 3), w, tz), null);
  eq('…not when the owner reverted it (stays undone)', spending.salaryDue(st(Z(2026, 10, 29, 3)), Z(2026, 11, 2), w, tz, (k) => k === 'salary:2026-11'), null);
  const w28 = { money: { payday: 28, salary: 100 } };
  eq('payday 28, genesis 29 Oct 03:12: October is before his story', spending.salaryDue(st(Z(2026, 10, 29, 3)), Z(2026, 10, 30), w28, tz), null);
  eq('payday 28: genesis on the payday before its wake → the exact-day wake pays', spending.salaryDue(st(Z(2026, 10, 28, 2)), Z(2026, 10, 28), w28, tz), '2026-10');
  eq('payday 31 in February clamps to the 28th', spending.monthlyDue(31, Z(2027, 2, 28), tz, Z(2027, 1, 1), null), '2027-02');
  eq('no salary configured → nothing', spending.salaryDue(st(0), Z(2026, 11, 1), { money: { payday: 1, salary: 0 } }, tz), null);
}

section('units: activity prices');
{
  const places = new Map([['place:home', { id: 'place:home', kind: 'home' }], ['place:office', { id: 'place:office', kind: 'office' }],
    ['place:cafe', { id: 'place:cafe', kind: 'cafe' }], ['place:park', { id: 'place:park', kind: 'park' }],
    ['place:friend', { id: 'place:friend', kind: 'home' }]]);
  const state = { self: { homePlaceId: 'place:home', officePlaceId: 'place:office' }, decisions: new Map() };
  const ev = (kind, placeId) => ({ id: 1, payload: { kind, placeId, withCast: ['cast:a'] } });
  const sp = (kind, placeId) => spending.activitySpend({ state, block: {}, ev: ev(kind, placeId), places, world, date: '2026-11-02' });
  eq('a meal at home costs nothing', sp('dinner', 'place:home'), null);
  eq('lunch at the office: the canteen (food)', sp('lunch', 'place:office')?.for, 'food');
  eq('coffee at a cafe: food', sp('cafe', 'place:cafe')?.for, 'food');
  eq('a hangout at a cafe: an outing with who he was with', [sp('hangout', 'place:cafe')?.for, sp('hangout', 'place:cafe')?.castIds], ['outing', ['cast:a']]);
  eq('a walk in the park is free', sp('walk', 'place:park'), null);
  eq('a visit at a cast member\'s home is free', sp('visit', 'place:friend'), null);
  eq('work at the office is free', sp('work', 'place:office'), null);
  const d = { id: 7, status: 'committed', committed: { optionId: 'go' }, options: [{ id: 'go', spend: 432 }] };
  const own = spending.activitySpend({ state: { ...state, decisions: new Map([[7, d]]) }, block: { decisionId: 7 }, ev: ev('movie', 'place:cafe'), places, world, date: '2026-11-02' });
  eq('a committed option\'s own spend wins', [own?.amount, own?.decisionId], [430, 7]);
  spending.__setWalletForTest(false);
  eq('the seam off: no spend', sp('hangout', 'place:cafe'), null);
  spending.__setWalletForTest(true);
}

section('the cut-over and October');
await simulateHours(18);   // 27 Oct 06:00 → 28 Oct 00:00
{
  const ws = money(['wallet.started']);
  eq('one wallet.started, engine, self', [ws.length, ws[0]?.actor, ws[0]?.originKind], [1, 'engine', 'self']);
  check('the projection carries the cut-over', S().money?.walletSince === ws[0]?.at);
}
await simulateHours(5 * 24 + 6);   // → 2 Nov 06:00
{
  const evs = money();
  const oct = evs.filter(e => dateKey(e.at, tz) < '2026-11-01');
  eq('no salary, rent or bills in October (genesis after the 1st)', oct.filter(e => e.type === 'money.salary' || ['rent', 'bills'].includes(e.payload?.for)).length, 0);
  const sal = evs.filter(e => e.type === 'money.salary');
  eq('salary on 1 Nov at his wake', [sal.length, sal[0] && dateKey(sal[0].at, tz), sal[0]?.payload?.month, sal[0]?.payload?.amount], [1, '2026-11-01', '2026-11', 60000]);
  const rent = evs.filter(e => e.payload?.for === 'rent');
  eq('rent on 1 Nov, its period', [rent.length, rent[0] && dateKey(rent[0].at, tz), rent[0]?.payload?.period], [1, '2026-11-01', '2026-11']);
  check('rent = 40 % of the baseline', rent[0]?.payload?.amount === Math.round(35000 * spending.RENT_SHARE / 10) * 10);
  const basket = evs.filter(e => e.payload?.for === 'groceries' && e.payload?.period);
  check('the weekly basket on Sunday 1 Nov (no catch-up before the first Sunday)', basket.length === 1 && basket[0].payload.period === '2026-11-01');
  const food = evs.filter(e => e.payload?.for === 'food');
  check('meals away from home are spends', food.length > 0);
  check('…each caused by its activity.started, at a place that is not his home', food.every(e => getEvent(e.causeId)?.type === 'activity.started'
    && e.payload.placeId && e.payload.placeId !== S().self.homePlaceId));
  const net = evs.reduce((a, e) => a + (e.type === 'money.salary' ? e.payload.amount : e.type === 'money.spent' ? -e.payload.amount : 0), 0);
  check('no hourly drain any more: balance = start + salary − spends', Math.abs(S().vitals.money - (startMoney + net)) < 0.01,
    { now: S().vitals.money, expected: startMoney + net });
}

section('revert: an activity takes its spend; a reverted rent stays undone');
{
  const sp = money(['money.spent']).find(e => e.payload?.for === 'food');
  check('the activity\'s revert cascade holds its spend', cascadeIds(sp.causeId).includes(sp.id));
  const rent = money(['money.spent']).find(e => e.payload?.for === 'rent');
  life.revertEvent(rent.id, { reason: 'test' });
  const before = S().vitals.money;
  await simulateHours(24);   // the 3 Nov wake
  eq('no second rent for November', money(['money.spent']).filter(e => e.payload?.for === 'rent' && e.payload?.period === '2026-11').length, 1);
  check('its money is back', S().vitals.money > before - 5000);
}

section('walletView: shape, daily, labels');
{
  const p = await director.preview({ kind: 'money', mode: 'income', amount: 5000, label: 'Broke his FD' }, { relax: true });
  await director.apply(p.previewId, p.fingerprint);
  const q = await director.preview({ kind: 'money', mode: 'set', amount: 1000 }, { relax: true });
  const balBefore = S().vitals.money;
  await director.apply(q.previewId, q.fingerprint);
  const v = life.walletView({ month: '2026-11' });
  eq('the plan §B keys', Object.keys(v).sort(), ['balance', 'baseline', 'currencyHint', 'daily', 'entries', 'month', 'months', 'running', 'salary', 'totals'].sort());
  eq('entry keys', Object.keys(v.entries[0]).sort(), ['actor', 'amount', 'at', 'castIds', 'castNames', 'category', 'dir', 'fromChat', 'id', 'label', 'origin', 'placeId', 'placeName', 'revertible'].sort());
  eq('months from genesis, newest first', v.months, ['2026-11', '2026-10']);
  eq('daily: 1 Nov to today, every day', v.daily.map(d => d.date), ['2026-11-01', '2026-11-02', '2026-11-03']);
  check('every amount > 0 and a dir', v.entries.every(e => e.amount > 0 && (e.dir === 'in' || e.dir === 'out')));
  check('newest first', v.entries.every((e, i) => i === 0 || v.entries[i - 1].at >= e.at));
  check('castNames line up with castIds (fictional names)', v.entries.every(e => e.castNames.length === e.castIds.length
    && e.castIds.every((id, i) => e.castNames[i] === (S().cast.get(id)?.name ?? 'someone'))));
  const inc = v.entries.find(e => e.category === 'income');
  eq('the owner\'s income shows its own label', [inc?.label, inc?.dir, inc?.amount, inc?.origin], ['Broke his FD', 'in', 5000, 'owner']);
  const set = v.entries.find(e => e.category === 'adjustment');
  const moved = Math.round((balBefore - 1000) * 100) / 100;
  eq('a "set" is the signed move', [set?.dir, set?.amount, v.totals.byCategory.adjustment], ['out', moved, -moved]);
  eq('balance now', v.balance, Math.round(S().vitals.money));
  eq('salary', [v.salary.amount, v.salary.payday, dateKey(v.salary.nextAt, tz)], [60000, 1, '2026-12-01']);
  eq('totals add up', Math.round(v.totals.net), Math.round(v.totals.in - v.totals.out));
  check('the reverted rent is gone; the basket is revertible as a money.spent', !v.entries.some(e => e.category === 'rent')
    && v.entries.find(e => e.category === 'groceries')?.revertible === true);
  let code = null;
  try { life.walletView({ month: '2026-13' }); } catch (e) { code = e.code; }
  eq('bad month', code, 'bad_month');
  code = null;
  try { life.walletView({ month: '2026-09' }); } catch (e) { code = e.code; }
  eq('before genesis', code, 'out_of_range');
  const oct = life.walletView({ month: '2026-10' });
  eq('October: from the genesis day', oct.daily[0].date, '2026-10-27');
  check('October\'s daily balances are read', oct.daily.every(d => Number.isFinite(d.balance)));
}

section('a chat-caused spend keeps the chat\'s origin');
{
  const at = clock.now();
  const trig = appendEvent({ type: 'chat.trigger', at, actor: 'chat', originKind: 'group', originJid: '1203630@g.us', payload: { kind: 'test' } });
  const act = appendEvent({ type: 'activity.recorded', at, actor: 'engine', causeId: trig.id, payload: { kind: 'hangout' } });
  const sp = appendEvent({ type: 'money.spent', at, actor: 'engine', causeId: act.id, payload: { amount: 300, for: 'outing', kind: 'hangout' } });
  eq('origin inherited through the cause chain', [sp.originKind, sp.originJid], ['group', '1203630@g.us']);
  const v = life.walletView();
  const e = v.entries.find(x => x.id === sp.id);
  eq('walletView: a chat entry', [e?.origin, e?.fromChat], ['chat', true]);
}

section('labels (public words: never a name)');
{
  eq('travel by mode', labelOf({ type: 'money.spent', payload: { for: 'travel' } }, { travelMode: 'auto' }), 'Auto fare');
  eq('owner income keeps the code word in labelOf', labelOf({ type: 'money.adjusted', payload: { mode: 'income', label: 'Broke his FD' } }), 'Income');
  eq('an unknown set is skipped', moneyOf({ type: 'money.adjusted', payload: { mode: 'set', amount: 5 } }), null);
  check('WalletError has a code', new WalletError('bad_month').code === 'bad_month');
  const v = buildWalletView({ state: null, at: clock.now(), tz, events: () => [] });
  eq('not running', [v.running, v.entries.length], [false, 0]);
}

await life.stopLife?.();
report();
