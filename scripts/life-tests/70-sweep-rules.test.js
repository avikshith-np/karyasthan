// Plan 020 §E1: the nightly sweep's rules, on fixtures in the real event shapes (pulse, phone
// worker, scene worker, decisions). Each rule fires on the case a human once caught and stays
// quiet on the case that looks like it but is fine. Also merge / dismiss / stored-value rules.
// Pure: no DB, no clock, no network.
import { section, check, eq, report } from './_helpers.js';
import {
  runRules, mergeFindings, cleanStored, nightDue, windowOf, fingerprint, buildSpans, RULES, FINDINGS_MAX, RETAIN_SEC, WINDOW_MAX_SEC,
} from '../../src/life/sweep.js';
import { zonedToUnix, dateKey } from '../../src/life/clock.js';

const tz = 'UTC';
const T = (d, h, m = 0) => zonedToUnix(2026, 11, d, h, m, tz);
const NOW = T(10, 23);

function world() {
  let id = 100;
  const events = [];
  const out = new Set();
  const add = (type, at, payload = {}, extra = {}) => {
    const e = { id: id++, type, at, actor: 'engine', causeId: null, payload, originKind: 'self', originJid: null, subjectJid: null, heavy: false, redacted: false, ...extra };
    events.push(e);
    return e;
  };
  const run = (over = {}) => runRules({
    from: T(9, 0), to: NOW, tz,
    read: (a, b, types) => events.filter(e => e.at >= a && e.at <= b && types.includes(e.type)).sort((x, y) => x.at - y.at || x.id - y.id),
    getEvent: (i) => events.find(e => e.id === i) ?? null,
    isOut: (i) => out.has(i),
    causeChain: (i) => { const c = []; for (let e = events.find(x => x.id === i); e; e = events.find(x => x.id === e.causeId)) c.unshift(e); return c; },
    placeWord: (p) => String(p).replace('place:', ''), castWord: (c) => String(c).replace('cast:', ''), kindWord: (k) => k,
    ...over,
  });
  return { events, out, add, run };
}
const rules = (r) => r.findings.map(f => f.rule);
const only = (r, rule) => r.findings.filter(f => f.rule === rule);

// A real outing: a plan with a block naming its decision → the trip → the activity → its spend.
function outing(w, { at = T(10, 15), mins = 120, placeId = 'place:cafe', kind = 'hangout', castIds = ['cast:ana'], plan = null, travel = true } = {}) {
  const started = travel ? w.add('travel.started', at - 1200, { from: 'place:home', to: placeId, mode: 'walk', minutes: 20 }, plan ? { causeId: plan.id } : {}) : null;
  if (started) w.add('travel.arrived', at, { to: placeId }, { causeId: started.id });
  const a = w.add('activity.started', at, { kind, placeId, end: at + mins * 60, withCast: castIds }, plan ? { causeId: plan.id } : {});
  const spend = w.add('money.spent', at, { amount: 600, for: 'outing', kind, placeId, castIds }, { causeId: a.id });
  const end = w.add('activity.ended', at + mins * 60, { kind, placeId }, { causeId: a.id });
  return { a, spend, end };
}

// ── one spend per outing ────────────────────────────────────────────────────
section('spend_once: the café double charge (2026-11-01 live)');
{
  const w = world();
  const first = w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  const fs = w.add('money.spent', T(10, 15), { amount: 600, for: 'outing', kind: 'hangout' }, { causeId: first.id });
  const resume = w.add('activity.started', T(10, 16, 36), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  const rs = w.add('money.spent', T(10, 16, 36), { amount: 600, for: 'outing', kind: 'hangout' }, { causeId: resume.id });
  const r = only(w.run(), 'spend_once');
  eq('the live shape: one finding', r.length, 1);
  eq('…high, naming both starts and both charges', [r[0].severity, r[0].eventIds], ['high', [first.id, fs.id, resume.id, rs.id]]);
  check('…in plain words', /paid for twice/.test(r[0].text), r[0].text);

  w.out.add(first.id);
  w.out.add(fs.id);
  eq('the first start rewound away: the second charge is legitimate', only(w.run(), 'spend_once').length, 0);
}
{
  const w = world();
  outing(w, { at: T(10, 10), mins: 60, travel: false });
  outing(w, { at: T(10, 18), mins: 60, travel: false });
  eq('the same café twice in a day, hours apart: fine', only(w.run(), 'spend_once').length, 0);
}
{
  const w = world();
  outing(w, { at: T(10, 15), castIds: ['cast:ana'], travel: false });
  outing(w, { at: T(10, 15, 30), castIds: ['cast:bo'], travel: false });
  eq('with someone else: not the same outing', only(w.run(), 'spend_once').length, 0);
}
{
  const w = world();
  const { a } = outing(w, { travel: false });
  w.add('money.spent', T(10, 15), { amount: 600, for: 'outing' }, { causeId: a.id });
  const r = only(w.run(), 'spend_once');
  check('one start with two charges fires', r.length === 1 && /charged 2 times/.test(r[0].text), JSON.stringify(r));
}
{
  const w = world();
  const a = w.add('activity.started', T(9, 23, 30), { kind: 'hangout', placeId: 'place:bar', end: T(10, 2), withCast: ['cast:ana'] });
  const s1 = w.add('money.spent', T(9, 23, 30), { amount: 600, for: 'outing' }, { causeId: a.id });
  w.add('activity.ended', T(10, 2), {}, { causeId: a.id });
  void s1;
  eq('an overnight outing paid once: fine, whichever night reads it', only(w.run({ from: T(9, 0) }), 'spend_once').length, 0);
  const b = w.add('activity.started', T(10, 0, 30), { kind: 'hangout', placeId: 'place:bar', end: T(10, 2), withCast: ['cast:ana'] });
  w.add('money.spent', T(10, 0, 30), { amount: 600, for: 'outing' }, { causeId: b.id });
  const night1 = only(w.run({ from: T(9, 0), to: T(10, 3) }), 'spend_once');
  const night2 = only(w.run({ from: T(10, 0), to: T(11, 3) }), 'spend_once');
  eq('…a double charge across midnight is one finding on both nights', [night1.length, night2.length, night1[0]?.fp === night2[0]?.fp], [1, 1, true]);
}

// ── money per period ────────────────────────────────────────────────────────
section('salary_once, recurring_once');
{
  const w = world();
  const a = w.add('money.salary', T(1, 7), { amount: 100, month: '2026-11' });
  const b = w.add('money.salary', T(9, 7), { amount: 100, month: '2026-11' });
  const r = only(w.run(), 'salary_once');
  eq('two salaries in a month, nine days apart, seen by a one-night window', [r.length, r[0]?.eventIds], [1, [a.id, b.id]]);
  w.out.add(a.id);
  eq('a reverted payment: one salary stands, no finding', only(w.run(), 'salary_once').length, 0);
}
{
  const w = world();
  w.add('money.salary', T(1, 7), { amount: 100, month: '2026-11' });
  w.add('money.salary', zonedToUnix(2026, 10, 1, 7, 0, tz), { amount: 100, month: '2026-10' });
  eq('one a month each: fine', only(w.run(), 'salary_once').length, 0);
}
{
  const w = world();
  const a = w.add('money.spent', T(1, 7), { amount: 900, for: 'rent', period: '2026-11' });
  const b = w.add('money.spent', T(3, 7), { amount: 900, for: 'rent', period: '2026-11' });
  w.add('money.spent', T(10, 7), { amount: 300, for: 'bills', period: '2026-11' });
  const r = only(w.run(), 'recurring_once');
  check('rent twice in its period fires; bills once does not', r.length === 1 && /rent was charged 2 times for 2026-11/.test(r[0].text), JSON.stringify(r));
  w.out.add(b.id);
  void a;
  eq('…the second one reverted: fine', only(w.run(), 'recurring_once').length, 0);
}
{
  const w = world();
  w.add('money.spent', T(9, 12), { amount: 90, for: 'groceries' });
  w.add('money.spent', T(9, 18), { amount: 90, for: 'groceries' });
  eq('two grocery top-ups (no period): not recurring', only(w.run(), 'recurring_once').length, 0);
}

// ── wallet ≡ money ──────────────────────────────────────────────────────────
section('wallet_money');
{
  const moneyDeps = (w, { before, now, start = 50 }) => ({
    walletStartId: () => start,
    moneyBefore: () => before,
    moneyNow: () => now,
    moneySince: (id) => w.events.filter(e => e.id >= id && ['money.salary', 'money.spent', 'money.adjusted'].includes(e.type)).sort((a, b) => a.id - b.id),
  });
  const w = world();
  w.add('money.spent', T(10, 9), { amount: 100, for: 'food' });
  w.add('money.salary', T(10, 10), { amount: 1000 });
  eq('the items add up', only(w.run(moneyDeps(w, { before: 500, now: 1400 })), 'wallet_money').length, 0);
  const r = only(w.run(moneyDeps(w, { before: 500, now: 1300 })), 'wallet_money');
  check('100 short: fires, with both numbers', r.length === 1 && r[0].severity === 'high' && /disagree by -100/.test(r[0].text), JSON.stringify(r));
  const again = only(w.run(moneyDeps(w, { before: 500, now: 1300 })), 'wallet_money');
  eq('…same gap on the next night, same finding', again[0].fp, r[0].fp);
  eq('a rounding gap of ≤ 1 is no gap', only(w.run(moneyDeps(w, { before: 500, now: 1400.5 })), 'wallet_money').length, 0);
}
{
  const w = world();
  const deps = { walletStartId: () => 50, moneyBefore: () => 500, moneyNow: () => 2000,
    moneySince: () => w.events.filter(e => e.type.startsWith('money.')) };
  w.add('money.spent', T(10, 9), { amount: 100, for: 'food' });
  w.add('money.adjusted', T(10, 10), { mode: 'set', amount: 2000 }, { actor: 'owner', originKind: 'owner' });
  eq('an owner "set" is absolute', only(w.run(deps), 'wallet_money').length, 0);
  const none = world();
  none.add('money.spent', T(10, 9), { amount: 100, for: 'food' });
  eq('before the wallet\'s cut-over (no wallet.started): not checked', only(none.run({ walletStartId: () => null, moneyBefore: () => 0, moneyNow: () => 7 }), 'wallet_money').length, 0);
  const off = world();
  eq('no money event in the window: nothing to check', only(off.run({ walletStartId: () => 50, moneyBefore: () => 0, moneyNow: () => 7 }), 'wallet_money').length, 0);
}

// ── a scene's decision ──────────────────────────────────────────────────────
section('scene_own_decision: the café scene took the visit\'s tone (2026-11-01 live)');
{
  const w = world();
  const cafeD = w.add('decision.opened', T(10, 9), { kind: 'hangout', subject: { eventAt: T(10, 15), placeId: 'place:cafe', castIds: ['cast:ana'] }, options: [{ id: 'go', go: true, label: 'Coffee' }] });
  const visitD = w.add('decision.opened', T(10, 9, 30), { kind: 'visit', subject: { eventAt: T(10, 20), placeId: 'place:home', castIds: ['cast:ana'] }, options: [{ id: 'go', go: true, label: 'Visit' }] });
  const plan = w.add('plan.made', T(10, 9, 40), { amendedFor: visitD.id, blocks: [{ kind: 'hangout', start: T(10, 15), end: T(10, 17), decisionId: cafeD.id, placeId: 'place:cafe' }] });
  const { a } = outing(w, { plan, travel: false });
  const bad = w.add('scene.played', T(10, 17), { activityEventId: a.id, decisionId: visitD.id, placeId: 'place:cafe', kind: 'hangout', endedAt: T(10, 17) }, { causeId: a.id });
  const r = only(w.run(), 'scene_own_decision');
  check('the visit\'s decision on the café\'s scene fires', r.length === 1 && r[0].eventIds.includes(bad.id) && r[0].text.includes(`#${cafeD.id}`), JSON.stringify(r));
  w.out.add(bad.id);
  w.add('scene.played', T(10, 17, 5), { activityEventId: a.id, decisionId: cafeD.id, placeId: 'place:cafe', kind: 'hangout', endedAt: T(10, 17) }, { causeId: a.id });
  eq('the scene regenerated on its own decision: fine', only(w.run(), 'scene_own_decision').length, 0);
}
{
  const w = world();
  const home = w.add('decision.opened', T(10, 9), { kind: 'visit', subject: { eventAt: T(10, 20), placeId: 'place:home' }, options: [{ id: 'go', go: true }] });
  const { a } = outing(w, { travel: false });
  w.add('scene.played', T(10, 17), { activityEventId: a.id, decisionId: home.id, placeId: 'place:cafe', kind: 'hangout' }, { causeId: a.id });
  eq('a decision for another place fires even with no plan block', only(w.run(), 'scene_own_decision').length, 1);
  const w2 = world();
  const o = outing(w2, { travel: false });
  w2.add('scene.played', T(10, 17), { activityEventId: o.a.id, decisionId: null, placeId: 'place:cafe', kind: 'hangout' }, { causeId: o.a.id });
  eq('a routine outing with no decision at all: fine', only(w2.run(), 'scene_own_decision').length, 0);
}

// ── plans agreed in texts ───────────────────────────────────────────────────
section('text_plan: the reliable half, and the info-level cue');
{
  const w = world();
  const turn = w.add('phone.message', T(10, 9), { castId: 'cast:ana', dir: 'in', trigger: 'reply' });
  const d = w.add('decision.opened', T(10, 9), { kind: 'visit', subject: { eventAt: T(10, 19), placeId: 'place:home', castIds: ['cast:ana'] }, options: [{ id: 'go', go: true }] }, { causeId: turn.id });
  w.add('decision.committed', T(10, 9), { decisionId: d.id, optionId: 'go', by: 'text' }, { causeId: d.id });
  eq('a text plan hanging off its text: fine', only(w.run(), 'text_plan').length, 0);
  w.out.add(turn.id);
  const r = only(w.run(), 'text_plan');
  check('…the text gone but the plan standing fires', r.length === 1 && r[0].severity === 'warn', JSON.stringify(r));
}
{
  const w = world();
  const t = w.add('phone.message', T(10, 9), { castId: 'cast:ana', dir: 'out', trigger: 'reply' });
  const cue = { strongCues: (ids) => ids.includes(t.id) ? [{ eventId: t.id, cue: 'on my way' }] : [] };
  const r = only(w.run(cue), 'text_plan');
  check('"on my way" with no plan and no meeting: info, and says it may be a refusal', r.length === 1 && r[0].severity === 'info' && /refusal/.test(r[0].text) && r[0].text.includes('on my way'), JSON.stringify(r));
  const d = w.add('decision.opened', T(10, 9, 1), { kind: 'visit', subject: { eventAt: T(10, 19), placeId: 'place:home', castIds: ['cast:ana'] }, options: [{ id: 'go', go: true }] });
  w.add('decision.committed', T(10, 9, 1), { decisionId: d.id, optionId: 'go', by: 'sample' }, { causeId: d.id });
  eq('…a committed plan with them nearby: fine', only(w.run(cue), 'text_plan').length, 0);
}
{
  const w = world();
  const t = w.add('phone.message', T(10, 15), { castId: 'cast:ana', dir: 'out', trigger: 'reply' });
  outing(w, { at: T(10, 16), castIds: ['cast:ana'], travel: false });
  eq('a meeting with them an hour on: fine', only(w.run({ strongCues: () => [{ eventId: t.id, cue: 'on my way' }] }), 'text_plan').length, 0);
}
{
  const w = world();
  const t = w.add('phone.message', T(10, 15), { castId: 'cast:ana', dir: 'out', trigger: 'reply' });
  const r = only(w.run({ strongCues: () => [] }), 'text_plan');
  void t;
  eq('small talk: nothing', r.length, 0);
}

section('text_plan: the plan step\'s ring makes it exact');
{
  const setup = () => {
    const w = world();
    const t = w.add('phone.message', T(10, 9), { castId: 'cast:ana', dir: 'out', trigger: 'reply' });
    return { w, t, cue: { strongCues: (ids) => ids.includes(t.id) ? [{ eventId: t.id, cue: 'on my way' }] : [] } };
  };
  const with_ = (w, cue, ring) => only(w.run({ ...cue, planOutcomes: () => ring }), 'text_plan');
  {
    const { w, t, cue } = setup();
    eq('a logged refusal (a clash): an answer, no finding', with_(w, cue, { since: T(1, 0), entries: [{ id: t.id, o: 'refused', c: 'clash_plan', at: t.at }] }).length, 0);
    eq('…"nothing was agreed": an answer too', with_(w, cue, { since: T(1, 0), entries: [{ id: t.id, o: 'nothing', c: 'not_agreed', at: t.at }] }).length, 0);
    eq('…applied, and the plan since undone by the owner: not a hole', with_(w, cue, { since: T(1, 0), entries: [{ id: t.id, o: 'applied', c: 'outing', at: t.at }] }).length, 0);
    const failed = with_(w, cue, { since: T(1, 0), entries: [{ id: t.id, o: 'nothing', c: 'model_failed', at: t.at }] });
    check('the step couldn\'t decide: info, with its code', failed.length === 1 && failed[0].severity === 'info' && /couldn't decide \(model_failed\)/.test(failed[0].text), JSON.stringify(failed));
    const never = with_(w, cue, { since: T(1, 0), entries: [] });
    check('never looked at: a hole, at warn', never.length === 1 && never[0].severity === 'warn' && /never looked/.test(never[0].text), JSON.stringify(never));
    const old = with_(w, cue, { since: T(10, 12), entries: [] });
    check('older than the ring: it can\'t tell, info as before', old.length === 1 && old[0].severity === 'info' && /refusal/.test(old[0].text), JSON.stringify(old));
    const none = with_(w, cue, null);
    check('no ring at all: the same', none.length === 1 && none[0].severity === 'info' && /refusal/.test(none[0].text));
    const bad = only(w.run({ ...cue, planOutcomes: () => { throw new Error('boom'); } }), 'text_plan');
    check('a ring that throws: the same, and the rule still runs', bad.length === 1 && /refusal/.test(bad[0].text));
  }
  {
    const { w, t, cue } = setup();
    const later = w.add('phone.message', T(10, 9, 5), { castId: 'cast:ana', dir: 'in', trigger: 'reply' });
    eq('a newer turn in the thread took it over', with_(w, cue, { since: T(1, 0), entries: [{ id: later.id, o: 'nothing', c: 'not_agreed', at: later.at }] }).length, 0);
    const other = w.add('phone.message', T(10, 9, 6), { castId: 'cast:bo', dir: 'in', trigger: 'reply' });
    check('…someone else\'s thread doesn\'t', with_(w, cue, { since: T(1, 0), entries: [{ id: other.id, o: 'nothing', c: 'not_agreed', at: other.at }] })[0]?.severity === 'warn');
    void t;
  }
}

// ── two places ──────────────────────────────────────────────────────────────
section('two_places');
{
  const w = world();
  const trip = w.add('travel.started', T(10, 14, 30), { from: 'place:home', to: 'place:cafe', minutes: 60 });
  const act = w.add('activity.started', T(10, 15), { kind: 'gym', placeId: 'place:gym', end: T(10, 16), withCast: [] });
  w.add('travel.arrived', T(10, 15, 30), { to: 'place:cafe' }, { causeId: trip.id });
  const r = only(w.run(), 'two_places').filter(f => f.severity === 'warn');
  check('a trip and an activity elsewhere at once fires', r.length >= 1 && r[0].eventIds.includes(trip.id) && r[0].eventIds.includes(act.id), JSON.stringify(r));
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 15), { kind: 'gym', placeId: 'place:gym', end: T(10, 16) });
  const b = w.add('activity.started', T(10, 15, 10), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 16) });
  w.add('activity.ended', T(10, 16), {}, { causeId: a.id });
  w.add('activity.ended', T(10, 16), {}, { causeId: b.id });
  const r = only(w.run(), 'two_places').filter(f => f.severity === 'warn');
  check('two activities elsewhere, each ended later: fires', r.length === 1 && /at the same time/.test(r[0].text), JSON.stringify(r));
}
{
  const w = world();
  const s = w.add('sleep.started', T(9, 23), { until: T(10, 7) });
  const a = w.add('activity.started', T(10, 1), { kind: 'hangout', placeId: 'place:home', end: T(10, 2) });
  w.add('activity.ended', T(10, 2), {}, { causeId: a.id });
  w.add('woke', T(10, 7), {});
  void s;
  eq('asleep and up at once fires', only(w.run(), 'two_places').filter(f => /asleep/.test(f.text)).length, 1);
}
{
  const w = world();
  w.add('sleep.started', T(9, 23), { until: T(10, 7) });
  w.add('woke', T(10, 1, 15), { interrupted: true });
  const a = w.add('activity.started', T(10, 1, 30), { kind: 'hangout', placeId: 'place:home', end: T(10, 2), withCast: [] });
  w.add('activity.ended', T(10, 2), {}, { causeId: a.id });
  w.add('sleep.started', T(10, 2), { until: T(10, 8) });
  w.add('woke', T(10, 8), {});
  eq('a broken night (wake him, up, back to sleep): fine', only(w.run(), 'two_places').length, 0);
}
{
  const w = world();
  outing(w, { at: T(10, 12), mins: 60 });
  const home = w.add('travel.started', T(10, 13), { from: 'place:cafe', to: 'place:home', minutes: 20 });
  w.add('travel.arrived', T(10, 13, 20), { to: 'place:home' }, { causeId: home.id });
  const a = w.add('activity.started', T(10, 13, 20), { kind: 'free', placeId: 'place:home', end: T(10, 18) });
  w.add('activity.ended', T(10, 18), {}, { causeId: a.id });
  eq('a normal afternoon: fine', only(w.run(), 'two_places').length, 0);
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 12), { kind: 'gym', placeId: 'place:gym', end: T(10, 13) });
  w.add('activity.ended', T(10, 13), {}, { causeId: a.id });
  const b = w.add('activity.started', T(10, 13), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 14) });
  const r = only(w.run(), 'two_places');
  check('somewhere new with no trip: info', r.length === 1 && r[0].severity === 'info' && r[0].eventIds.includes(b.id) && /no trip between/.test(r[0].text), JSON.stringify(r));
  w.add('activity.ended', T(10, 14), {}, { causeId: b.id });
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 12), { kind: 'free', placeId: 'place:home', end: T(10, 13) });
  w.add('activity.ended', T(10, 13), {}, { causeId: a.id });
  w.add('self.moved', T(10, 13), { placeId: 'place:home-2' }, { actor: 'owner', originKind: 'owner' });
  w.add('activity.started', T(10, 13, 30), { kind: 'free', placeId: 'place:home-2', end: T(10, 15) });
  eq('a moved-home day: his new flat is no teleport', only(w.run(), 'two_places').length, 0);
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 12), { kind: 'gym', placeId: 'place:gym', end: T(10, 18) });
  w.add('world.reanchored', T(10, 14), { gapHours: 30 });
  w.add('activity.started', T(10, 14), { kind: 'free', placeId: 'place:home', end: T(10, 15) });
  void a;
  eq('downtime: a re-anchor closes what was open and starts his position over', only(w.run(), 'two_places').length, 0);
}
{
  const w = world();
  const trip = w.add('travel.started', T(10, 14, 56), { from: 'place:home', to: 'place:cafe', minutes: 5 });
  w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 16) });
  w.add('travel.arrived', T(10, 15, 1), { to: 'place:cafe' }, { causeId: trip.id });
  eq('a trip that lands a minute late: under the tolerance', only(w.run(), 'two_places').filter(f => f.severity === 'warn').length, 0);
}

// ── texting while with someone ──────────────────────────────────────────────
section('phone_with_someone');
{
  const w = world();
  const a = w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  w.add('activity.ended', T(10, 17), {}, { causeId: a.id });
  const m = w.add('phone.message', T(10, 16), { castId: 'cast:bo', dir: 'out', trigger: 'organic' });
  const r = only(w.run(), 'phone_with_someone');
  check('his organic text to someone else while with her fires', r.length === 1 && r[0].eventIds.includes(m.id) && /with ana/.test(r[0].text), JSON.stringify(r));
  w.out.add(a.id);
  eq('…the outing reverted: he wasn\'t with her, fine', only(w.run(), 'phone_with_someone').length, 0);
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  w.add('activity.ended', T(10, 17), {}, { causeId: a.id });
  const set = w.add('phone.text_set', T(10, 16), { castId: 'cast:bo', gist: 'hello', at: T(10, 16) }, { actor: 'owner', originKind: 'owner' });
  const own = w.add('phone.message', T(10, 16), { castId: 'cast:bo', dir: 'out', trigger: 'owner' }, { causeId: set.id });
  const back = w.add('phone.message', T(10, 16, 2), { castId: 'cast:bo', dir: 'in', trigger: 'reply' }, { causeId: own.id });
  w.add('phone.message', T(10, 16, 3), { castId: 'cast:bo', dir: 'out', trigger: 'reply' }, { causeId: back.id });
  eq('an owner-started chat while with someone: a deliberate interruption, no finding', only(w.run(), 'phone_with_someone').length, 0);
  // A later turn of that thread with no chain back to the ask, inside the owner's session.
  w.add('phone.message', T(10, 16, 40), { castId: 'cast:bo', dir: 'out', trigger: 'organic' });
  eq('…a turn of that thread inside the session: still the owner\'s', only(w.run(), 'phone_with_someone').length, 0);
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  w.add('activity.ended', T(10, 17), {}, { causeId: a.id });
  w.add('phone.message', T(10, 16), { castId: 'cast:bo', dir: 'in', trigger: 'organic' });
  eq('someone else texting him while he\'s with her: their text still arrives, fine', only(w.run(), 'phone_with_someone').length, 0);
  w.add('phone.message', T(10, 16, 30), { castId: 'cast:ana', dir: 'in', trigger: 'organic' });
  eq('…she texts him while they are together: fires', only(w.run(), 'phone_with_someone').length, 1);
}
{
  const w = world();
  const m = w.add('phone.message', T(10, 15, 5), { castId: 'cast:bo', dir: 'out', trigger: 'organic' });
  const a = w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:cafe', end: T(10, 17), withCast: ['cast:ana'] });
  w.add('activity.ended', T(10, 17), {}, { causeId: a.id });
  void m;
  eq('tick lag: the text went out before the engine knew the outing had started', only(w.run(), 'phone_with_someone').length, 0);
}
{
  const w = world();
  const a = w.add('activity.started', T(10, 15), { kind: 'free', placeId: 'place:home', end: T(10, 17), withCast: [] });
  w.add('activity.ended', T(10, 17), {}, { causeId: a.id });
  w.add('phone.message', T(10, 16), { castId: 'cast:bo', dir: 'out', trigger: 'organic' });
  eq('alone at home: fine', only(w.run(), 'phone_with_someone').length, 0);
}

// ── committed go ────────────────────────────────────────────────────────────
function go(w, { kind = 'hangout', at = T(10, 15), by = 'sample', placeId = 'place:cafe', optionId = 'go', extra = {} } = {}) {
  const d = w.add('decision.opened', at - 7200, {
    kind, subject: { eventAt: at, placeId, castIds: ['cast:ana'], endAt: at + 7200 }, ponrAt: at - 1200,
    options: [{ id: 'go', go: true, label: 'Coffee with Ana', minutes: 120 }, { id: 'late', go: 'late', label: 'Join late' }, { id: 'stay', label: 'Stay in' }],
  }, extra);
  const c = w.add('decision.committed', at - 3600, { decisionId: d.id, optionId, by }, { causeId: d.id, ...extra });
  return { d, c };
}
section('go_happened + interview_attended: a committed go has an activity or an expiry');
{
  const w = world();
  const { d } = go(w);
  const r = only(w.run(), 'go_happened');
  check('a committed go past its time with nothing logged fires', r.length === 1 && r[0].eventIds.includes(d.id) && /Coffee with Ana/.test(r[0].text), JSON.stringify(r));
  eq('…but not while it is still ahead', only(w.run({ to: T(10, 15, 10) }), 'go_happened').length, 0);
}
{
  const w = world();
  go(w);
  outing(w);
  eq('it happened (place and time): fine', only(w.run(), 'go_happened').length, 0);
}
{
  const w = world();
  const { d } = go(w);
  const plan = w.add('plan.made', T(10, 14), { blocks: [{ kind: 'hangout', start: T(10, 15), end: T(10, 17), decisionId: d.id, placeId: 'place:other' }] });
  w.add('activity.started', T(10, 15), { kind: 'hangout', placeId: 'place:other', end: T(10, 17) }, { causeId: plan.id });
  eq('it happened (the plan block names it, wherever it ended up): fine', only(w.run(), 'go_happened').length, 0);
}
{
  const w = world();
  const { d } = go(w);
  w.add('decision.expired', T(10, 14), { decisionId: d.id, reason: 'could_not_go' }, { causeId: d.id });
  eq('expired could_not_go: fine', only(w.run(), 'go_happened').length, 0);
}
{
  const w = world();
  const { d } = go(w);
  w.add('decision.reversed', T(10, 12), { decisionId: d.id, from: 'go', to: 'stay', p: 0.8 }, { causeId: d.id });
  eq('he changed his mind to stay: nothing to attend', only(w.run(), 'go_happened').length, 0);
  w.add('decision.reversed', T(10, 12, 30), { decisionId: d.id, from: 'stay', to: 'go', p: 0.8 }, { causeId: d.id });
  eq('…and back to go, with nothing logged: fires', only(w.run(), 'go_happened').length, 1);
}
{
  const w = world();
  const { d, c } = go(w);
  w.out.add(c.id);
  eq('the commit reverted: fine', only(w.run(), 'go_happened').length, 0);
  w.out.delete(c.id);
  w.out.add(d.id);
  eq('the decision reverted: fine', only(w.run(), 'go_happened').length, 0);
}
{
  const w = world();
  const { d } = go(w, { optionId: 'late' });
  eq('joining late: not due until the midpoint', only(w.run({ to: T(10, 15, 45) }), 'go_happened').length, 0);
  check('…then fires', only(w.run({ to: T(10, 16, 45) }), 'go_happened').some(f => f.eventIds.includes(d.id)));
}
{
  const w = world();
  go(w, { at: T(9, 23, 30), placeId: 'place:bar' });
  w.add('activity.started', T(9, 23, 40), { kind: 'hangout', placeId: 'place:bar', end: T(10, 1, 30) });
  eq('an outing across midnight: fine on both nights', [only(w.run({ from: T(9, 0), to: T(10, 2) }), 'go_happened').length, only(w.run({ from: T(9, 20), to: T(11, 2) }), 'go_happened').length], [0, 0]);
}
{
  const w = world();
  const jid = '15550000031@s.whatsapp.net';
  go(w, { by: 'adopted', extra: { originKind: 'dm', originJid: jid } });
  const r = only(w.run(), 'go_happened');
  check('a chat\'s plan: only "a plan from a chat", never its label or a JID', r.length === 1 && /a plan from a chat/.test(r[0].text) && !/Coffee/.test(r[0].text) && !JSON.stringify(r).includes(jid), JSON.stringify(r));
}
{
  const w = world();
  const { d } = go(w, { kind: 'career:interview', placeId: 'place:hq' });
  const r = w.run();
  eq('an interview nobody went to: its own rule', [only(r, 'interview_attended').length, only(r, 'go_happened').length], [1, 0]);
  check('…in plain words', /committed to/.test(only(r, 'interview_attended')[0].text));
  w.add('activity.started', T(10, 15), { kind: 'meeting', placeId: 'place:hq', end: T(10, 16), decisionId: d.id });
  eq('…fitted into his day (feat/one-being): fine', only(w.run(), 'interview_attended').length, 0);
}
{
  const w = world();
  const { d } = go(w, { kind: 'career:interview', placeId: 'place:hq' });
  w.add('decision.expired', T(10, 14), { decisionId: d.id, reason: 'could_not_go' }, { causeId: d.id });
  eq('an interview that expired: fine', only(w.run(), 'interview_attended').length, 0);
}
{
  const w = world();
  go(w, { placeId: null });
  eq('a go with no place: nothing could move him, so nothing to flag', only(w.run(), 'go_happened').length, 0);
}
{
  const w = world();
  const { d } = go(w);
  w.add('decision.expired', T(10, 14), { decisionId: d.id, reason: 'sick' }, { causeId: d.id });
  eq('a sick day: its outing expired, fine', w.run().findings.length, 0);
}

// ── afterwards ──────────────────────────────────────────────────────────────
section('scene_afterwards');
{
  const w = world();
  const { a } = outing(w, { travel: false });
  const sc = w.add('scene.played', T(10, 17), { activityEventId: a.id, decisionId: null, placeId: 'place:cafe', kind: 'hangout', endedAt: T(10, 17) }, { causeId: a.id });
  const r = only(w.run({ sceneAfterwards: () => [{ eventId: sc.id, stale: 1 }] }), 'scene_afterwards');
  check('a stale line: info, a count, never the line', r.length === 1 && r[0].severity === 'info' && /1 line/.test(r[0].text), JSON.stringify(r));
  eq('nothing stale: fine', only(w.run({ sceneAfterwards: () => [{ eventId: sc.id, stale: 0 }] }), 'scene_afterwards').length, 0);
}

// ── excluded, redacted, a failing rule ──────────────────────────────────────
section('reverted, rewound, redacted events never count');
{
  const w = world();
  const a = w.add('money.salary', T(1, 7), { amount: 100, month: '2026-11' });
  const b = w.add('money.salary', T(2, 7), { amount: 100, month: '2026-11' });
  void a;
  eq('both stand: fires', only(w.run(), 'salary_once').length, 1);
  b.redacted = true;
  eq('one redacted (a purge): fine', only(w.run(), 'salary_once').length, 0);
}
{
  const w = world();
  w.add('money.salary', T(1, 7), { amount: 100, month: '2026-11' });
  w.add('money.salary', T(2, 7), { amount: 100, month: '2026-11' });
  const r = w.run({ walletStartId: () => { throw new Error('boom'); } });
  eq('a rule that throws is named and the rest still run', [r.ruleErrors, only(r, 'salary_once').length], [['wallet_money'], 1]);
}
{
  const r = world().run();
  eq('an empty log: nothing, no error', [r.findings.length, r.ruleErrors], [0, []]);
}

// ── merge ───────────────────────────────────────────────────────────────────
section('mergeFindings: a new night over the stored list');
const f = (rule, at, ids, extra = {}) => ({ fp: fingerprint(rule, ids), rule, severity: 'warn', at, eventIds: ids, text: 'x', firstSeenAt: at, lastSeenAt: at, ...extra });
{
  const old = f('two_places', T(10, 12), [1, 2]);
  const again = { ...old, firstSeenAt: undefined, lastSeenAt: undefined };
  const m = mergeFindings([old], [again], { from: T(9, 0), at: T(11, 0) });
  eq('seen again: one row, first seen kept', [m.length, m[0].firstSeenAt, m[0].lastSeenAt], [1, T(10, 12), T(11, 0)]);
  eq('in the window and not seen: the hole is gone', mergeFindings([old], [], { from: T(9, 0), at: T(11, 0) }).length, 0);
  eq('…unless its rule failed this run', mergeFindings([old], [], { from: T(9, 0), at: T(11, 0), ruleErrors: ['two_places'] }).length, 1);
  eq('older than the window: kept', mergeFindings([old], [], { from: T(10, 20), at: T(11, 0) }).length, 1);
  eq('…unless one of its events left his life (a revert, a rewind, a purge)', mergeFindings([old], [], { from: T(10, 20), at: T(11, 0), isGone: (id) => id === 2 }).length, 0);
  eq('…or it aged out', mergeFindings([old], [], { from: T(10, 20), at: T(10, 12) + RETAIN_SEC + 1 }).length, 0);
  const gone = new Set([old.fp]);
  eq('dismissed: never comes back, stored or detected', mergeFindings([old], [again], { from: T(9, 0), at: T(11, 0), dismissed: gone }).length, 0);
}
{
  const many = [];
  for (let i = 0; i < FINDINGS_MAX + 20; i++) many.push(f('two_places', T(10, 0) + i, [1000 + i]));
  many.push({ ...f('salary_once', T(1, 0), [5]), severity: 'high' });
  const m = mergeFindings([], many, { from: T(1, 0), at: T(11, 0) });
  eq('capped', m.length, FINDINGS_MAX);
  eq('…high first, whatever its age', m[0].rule, 'salary_once');
  check('…the rest newest first', m[1].at > m[2].at);
  check('the full list fits its 64 KB key', JSON.stringify({ findings: m }).length < 65536, String(JSON.stringify({ findings: m }).length));
}

// ── stored values ───────────────────────────────────────────────────────────
section('cleanStored: a bad value never crashes, and says so');
{
  const good = f('two_places', T(10, 12), [1, 2]);
  const fine = cleanStored({ lastNight: '2026-11-09', lastRunAt: T(9, 23), findings: [good] }, [{ fp: good.fp, at: 1, by: 'x' }]);
  eq('a good value', [fine.corrupt, fine.lastNight, fine.findings.length, fine.dismissed.length], [false, '2026-11-09', 1, 1]);
  eq('absent: not corrupt, empty', [cleanStored(null, null).corrupt, cleanStored(null, null).findings.length], [false, 0]);
  for (const [name, v] of [['a string', 'junk'], ['a number', 7], ['an array', [1, 2]]]) {
    const c = cleanStored(v, null);
    eq(`findings as ${name}: corrupt, empty`, [c.corrupt, c.findings.length, c.lastNight], [true, 0, null]);
  }
  eq('findings not a list', cleanStored({ findings: 'x' }, null).corrupt, true);
  const mixed = cleanStored({ findings: [good, { fp: 'nope' }, null, { ...good, fp: 'a'.repeat(32), rule: 'made_up' }, { ...good, fp: 'b'.repeat(32), eventIds: ['x'] }] }, null);
  eq('bad rows dropped, good ones kept', [mixed.corrupt, mixed.findings.length], [true, 1]);
  const d = cleanStored(null, 'junk');
  eq('dismissed list corrupt', [d.corrupt, d.dismissed.length], [true, 0]);
  eq('a bad lastNight reads as none (one run, not a crash)', cleanStored({ lastNight: 'never', findings: [] }, null).lastNight, null);
}

// ── when ────────────────────────────────────────────────────────────────────
section('nightDue + windowOf');
{
  const at = (d, h) => T(d, h);
  eq('fresh install: one run for last night', nightDue(null, at(10, 6), tz, false), dateKey(at(9, 6), tz));
  eq('ran for last night: the day stays quiet', nightDue('2026-11-09', at(10, 15), tz, false), null);
  eq('awake in the evening: not yet', nightDue('2026-11-09', at(10, 22), tz, false), null);
  eq('asleep in the evening: tonight', nightDue('2026-11-09', at(10, 22), tz, true), '2026-11-10');
  eq('an afternoon nap: not tonight', nightDue('2026-11-09', at(10, 15), tz, true), null);
  eq('…done for tonight: not again', nightDue('2026-11-10', at(10, 23), tz, true), null);
  eq('…nor after midnight, the same night', nightDue('2026-11-10', at(11, 0), tz, false), null);
  eq('still up past midnight: the first tick covers last night', nightDue('2026-11-09', at(11, 0), tz, false), '2026-11-10');
  eq('several nights missed: one run', nightDue('2026-11-02', at(10, 15), tz, false), '2026-11-09');
  eq('window: from the last run less a day', windowOf(T(9, 23), T(10, 23)), { from: T(8, 23), to: T(10, 23) });
  eq('…after a long gap, at most the longest look back', windowOf(T(1, 0), T(29, 0)).from, T(29, 0) - WINDOW_MAX_SEC);
  eq('…first run: the longest look back', windowOf(null, T(29, 0)).from, T(29, 0) - WINDOW_MAX_SEC);
  eq('…on demand: the longest look back', windowOf(T(28, 23), T(29, 0), { full: true }).from, T(29, 0) - WINDOW_MAX_SEC);
}
section('buildSpans');
{
  const w = world();
  const a = w.add('activity.started', T(10, 12), { kind: 'gym', placeId: 'place:gym', end: T(10, 14) });
  const b = w.add('activity.started', T(10, 13), { kind: 'free', placeId: 'place:gym', end: T(10, 20) });
  const s = buildSpans(w.events, T(10, 15));
  eq('no end event: closed by the next start, then capped at now', [s.activities[0].end, s.activities[1].end], [T(10, 13), T(10, 15)]);
  void a; void b;
  eq('every named rule has a function', RULES.length, new Set(RULES).size);
}

report();
