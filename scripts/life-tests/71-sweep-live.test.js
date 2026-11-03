// Plan 020 §E1: the sweep on the real engine. When it runs (once a night, one catch-up run after
// downtime, never in a simulation), that it writes nothing to the log, the café double charge
// replayed and cleared by a real revert and a real rewind, a dismissed finding staying dismissed,
// a sick day and a moved home staying clean, an empty install, a corrupt stored value never
// crashing the tick. Example world, fake clock, stubbed models, no network.
import {
  section, check, eq, report, setupScratchDb, bootLife, stopLife, simulateDays, simulateHours, HOUR,
} from '../arcs-tests/_helpers.js';
import { appendEvent, listEvents, lastEventId } from '../../src/life/eventLog.js';
import { getDb } from '../../src/memory/db.js';
import { isExcludedId } from '../../src/life/projector.js';
import * as director from '../../src/life/story/director.js';
import { dateKey, dayStart, zonedToUnix, resolveTimezone, localParts } from '../../src/life/clock.js';
import { config } from '../../src/utils/config.js';
import * as lifeFacade from '../../src/life/index.js';

section('an empty new install, before anything is running');
{
  const off = lifeFacade.alertsView();
  eq('alerts: an off shape', [off.running, off.count, off.findings], [false, 0, []]);
  eq('the badge count', lifeFacade.alertsCount(), 0);
  eq('dismiss', lifeFacade.dismissAlert('a'.repeat(32)), { ok: false, code: 'not_running' });
  eq('run', lifeFacade.runSweepNow(), { ok: false, code: 'not_running' });
  eq('thought vs deed', lifeFacade.thoughtDeed({ date: '2026-11-01' }).rows, []);
}

const { db } = await setupScratchDb();
const { world, clock, life } = await bootLife();
const S = () => life.getState();
const tz = resolveTimezone(world.timezone ?? config.timezone);
const raw = (key) => db.prepare('SELECT value_json FROM story_state WHERE key = ?').pluck().get(key);
const stored = () => JSON.parse(raw('sweep_findings') ?? 'null');
const eventsTotal = () => db.prepare('SELECT COUNT(*) AS n FROM world_events').get().n;
const local = (day0, h, m = 0) => {
  const [y, mo, d] = dateKey(day0 + 12 * HOUR, tz).split('-').map(Number);
  return zonedToUnix(y, mo, d, h, m, tz);
};
const hoursUntil = (t) => Math.max(0, (t - clock.now()) / HOUR);

section('a fresh world');
{
  await simulateHours(0.25);
  const a = life.alertsView();
  eq('no findings', a.count, 0);
  check('its first tick ran one catch-up sweep', Number.isFinite(a.lastRunAt));
  eq('…and it is clean', [a.corrupt, a.ruleErrors], [false, []]);
}

section('once a night: when he falls asleep, or the first tick after midnight');
{
  const runs = [];
  let last = stored()?.lastRunAt ?? null;
  await simulateDays(4, {
    onStep: () => {
      const r = stored()?.lastRunAt ?? null;
      if (r !== last) { runs.push({ at: r, night: stored().lastNight, asleep: S().activity?.kind === 'sleep' }); last = r; }
    },
  });
  eq('four days, four runs', runs.length, 4);
  eq('…each for its own night', new Set(runs.map(r => r.night)).size, 4);
  check('…each with him asleep in the evening or just past midnight', runs.every((r) => {
    const h = localParts(r.at, tz).hour;
    return (r.asleep && h >= 18) || h === 0;
  }), JSON.stringify(runs));
  eq('the sim is clean', life.alertsView().count, 0);
}

section('the sweep appends nothing, and a simulation never runs it');
{
  const before = eventsTotal();
  const lastId = lastEventId();
  life.runSweepNow();
  eq('no world event from a run', eventsTotal(), before);
  eq('…no alert.raised either', listEvents({ types: ['alert.raised'], limit: 10 }).length, 0);
  const ran = stored().lastRunAt;
  await life.dayView({});       // a projection: N simulated pulses through tomorrow
  eq('a Day projection: no run', stored().lastRunAt, ran);
  eq('…no event', lastEventId(), lastId);
}

section('the café double charge, replayed');
let fp;
let resume;
{
  // A real outing, then the pre-fix shape: the same block started again and charged again.
  const today = dayStart(clock.now(), tz);
  const startAt = local(today + 86400 * (localParts(clock.now(), tz).hour >= 13 ? 1 : 0), 15, 0);
  const p = await director.preview({ kind: 'scene', shape: 'outing', placeId: 'place:cafe', startAt, minutes: 120, castIds: ['cast:flatmate'], label: 'coffee catch-up' }, { relax: true });
  const r = await director.apply(p.previewId, p.fingerprint);
  check('the café date is applied', r?.ok === true, JSON.stringify(r));
  await simulateHours(hoursUntil(startAt + 30 * 60));
  const first = listEvents({ types: ['activity.started'], from: startAt - HOUR, limit: 20 }).find(e => e.payload?.placeId === 'place:cafe' && e.payload?.kind === 'hangout');
  check('he is at the café', !!first, JSON.stringify(S().activity));
  const spent = listEvents({ types: ['money.spent'], from: startAt - HOUR, limit: 50 }).find(e => e.causeId === first.id);
  check('…and paid', !!spent);
  eq('the sweep is happy', life.runSweepNow().findings.filter(f => f.rule === 'spend_once').length, 0);

  resume = appendEvent({ type: 'activity.started', at: clock.now(), actor: 'engine', causeId: first.causeId, payload: first.payload });
  appendEvent({ type: 'money.spent', at: clock.now(), actor: 'engine', causeId: resume.id, payload: spent.payload });
  const a = life.runSweepNow();
  const f = a.findings.find(x => x.rule === 'spend_once');
  check('the second charge is found', !!f && f.severity === 'high' && /paid for twice/.test(f.text), JSON.stringify(a.findings));
  fp = f?.fp;
  eq('the badge counts it', life.alertsCount(), a.count);
  check('no JID, no raw code in the words', a.findings.every(x => !/@|undefined|null/.test(x.text)), JSON.stringify(a.findings));
}

section('dismiss: it does not come back while the hole stands');
{
  eq('an unknown finding', life.dismissAlert('f'.repeat(32)), { ok: false, code: 'not_found' });
  const d = life.dismissAlert(fp, { by: 'tester' });
  eq('dismissed', d, { ok: true, rule: 'spend_once' });
  check('gone', !life.alertsView().findings.some(f => f.fp === fp));
  const again = life.runSweepNow();
  check('a full re-run does not bring it back', !again.findings.some(f => f.fp === fp));
  eq('…the list remembers who', JSON.parse(raw('sweep_dismissed')).map(x => x.by), ['tester']);
}

section('a revert clears it, and the dismissal stays on record');
{
  // The next run folds the fixture in: reverting the resume also clears the wallet's gap.
  const out = life.revertEvent(resume.id, { reason: 'test', by: 'tester' });
  check('the resume is reverted', out?.ok !== false && isExcludedId(S(), resume.id), JSON.stringify(out));
  const a = life.runSweepNow();
  eq('nothing left', a.findings.filter(f => f.rule === 'spend_once').length, 0);
  check('the balance agrees again', !a.findings.some(f => f.rule === 'wallet_money'), JSON.stringify(a.findings));
  check('the dismissed fp is still on record', JSON.parse(raw('sweep_dismissed')).some(x => x.fp === fp));
}

section('a real rewind: findings on the rewound events are gone at once, then at the next run');
{
  const t = clock.now();
  const a1 = appendEvent({ type: 'money.salary', at: t, actor: 'engine', payload: { amount: 1, month: '2099-01' } });
  const a2 = appendEvent({ type: 'money.salary', at: t, actor: 'engine', payload: { amount: 1, month: '2099-01' } });
  const seen = life.runSweepNow().findings.filter(f => f.rule === 'salary_once');
  eq('two salaries in one month found', seen.length, 1);
  await simulateHours(0.5);
  const p = await director.preview({ kind: 'rewind', at: t - 60, reason: 'undo' });
  const r = await director.apply(p.previewId, p.fingerprint, { by: 'tester' });
  check('the rewind is applied', r?.ok === true, JSON.stringify(r));
  check('both are out of the projection', isExcludedId(S(), a1.id) && isExcludedId(S(), a2.id));
  eq('the read hides it before any run', life.alertsView().findings.filter(f => f.rule === 'salary_once').length, 0);
  eq('the next run drops it', life.runSweepNow().findings.filter(f => f.rule === 'salary_once').length, 0);
  check('…from the stored list too', !stored().findings.some(f => f.rule === 'salary_once'));
}

section('redaction: a purged person\'s events drop out');
{
  const jid = '15550000071@s.whatsapp.net';
  const t = clock.now();
  appendEvent({ type: 'money.salary', at: t, actor: 'engine', subjectJid: jid, payload: { amount: 1, month: '2099-02' } });
  appendEvent({ type: 'money.salary', at: t, actor: 'engine', subjectJid: jid, payload: { amount: 1, month: '2099-02' } });
  const seen = life.runSweepNow().findings.filter(f => f.rule === 'salary_once');
  eq('found', seen.length, 1);
  check('no JID in what is stored', !raw('sweep_findings').includes(jid));
  life.redactPerson(jid);
  eq('gone at the next run', life.runSweepNow().findings.filter(f => f.rule === 'salary_once').length, 0);
}

section('downtime: several missed nights, one catch-up run');
{
  let writes = 0;
  const before = stored().lastRunAt;
  clock.advance({ days: 5 });
  await life.tick();
  if (stored().lastRunAt !== before) writes++;
  const after = stored().lastRunAt;
  await simulateHours(3);
  check('a run after the gap', writes === 1);
  const quiet = localParts(clock.now(), tz).hour >= 18 && S().activity?.kind === 'sleep';
  if (!quiet) eq('…and no more through the next hours', stored().lastRunAt, after);
  check('…no spam of findings', life.alertsView().findings.length <= 2, JSON.stringify(life.alertsView().findings));
}

section('a sick day and a moved home stay clean');
{
  const apply = async (action) => {
    const p = await director.preview(action, { relax: true });
    const r = await director.apply(p.previewId, p.fingerprint);
    check(`${action.kind} applied`, r?.ok === true, JSON.stringify(r));
  };
  const open = new Set(life.runSweepNow().findings.map(f => f.fp));
  await apply({ kind: 'health', change: 'sick', days: 1 });
  await simulateDays(1.5);
  await apply({ kind: 'home', near: 'place:cafe' });
  await simulateDays(1.5);
  const fresh = life.runSweepNow().findings.filter(f => !open.has(f.fp));
  eq('nothing new', fresh.map(f => `${f.rule}: ${f.text}`), []);
}

section('a committed interview: fires today, quiet once it has an activity or an expiry');
{
  const at = clock.now();
  const openIt = (eventAt) => {
    const d = appendEvent({
      type: 'decision.opened', at, actor: 'engine',
      payload: {
        kind: 'career:interview', category: 'career', subject: { eventAt, placeId: 'place:interview-hq', castIds: [] }, opensAt: at, decideBy: eventAt - 3600, ponrAt: eventAt - 1800,
        options: [{ id: 'go', label: 'Go to the interview', go: true, kind: 'meeting', minutes: 60 }, { id: 'skip', label: 'Skip it', kind: 'rest', minutes: 0 }],
      },
    });
    const c = appendEvent({ type: 'decision.committed', at, actor: 'engine', causeId: d.id, payload: { decisionId: d.id, optionId: 'go', p: 0.9, sampled: true, by: 'sample' } });
    return { d, c };
  };
  // Inside the window, past its time, at a place nothing else ever takes him to.
  const fixture = openIt(at - 90 * 60);
  const f = life.runSweepNow().findings.filter(x => x.rule === 'interview_attended' && x.eventIds.includes(fixture.d.id));
  eq('nobody took him there: it fires', f.length, 1);
  check('…in plain words', /Go to the interview/.test(f[0]?.text ?? ''), JSON.stringify(f));
  const fitted = openIt(at - 80 * 60);
  appendEvent({ type: 'activity.started', at: at - 80 * 60, actor: 'engine', payload: { kind: 'meeting', placeId: 'place:interview-hq', end: at - 20 * 60, decisionId: fitted.d.id, withCast: [] } });
  eq('…one fitted into his day is quiet (feat/one-being)', life.runSweepNow().findings.filter(x => x.rule === 'interview_attended' && x.eventIds.includes(fitted.d.id)).length, 0);
  const ex = appendEvent({ type: 'decision.expired', at, actor: 'engine', causeId: fixture.d.id, payload: { decisionId: fixture.d.id, reason: 'could_not_go' } });
  check('expired', !!ex);
  eq('…an expiry settles it', life.runSweepNow().findings.filter(x => x.rule === 'interview_attended' && x.eventIds.includes(fixture.d.id)).length, 0);
}

section('a corrupt stored value: fail closed, the tick lives');
{
  const set = (key, text) => db.prepare(`INSERT INTO story_state (key, value_json, updated_at) VALUES (?, ?, 0)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(key, text);
  const dismissedBefore = JSON.parse(raw('sweep_dismissed'));

  set('sweep_findings', '{not json');
  const view = life.alertsView();
  eq('it reads as corrupt, no crash', [view.corrupt, view.count, view.lastNight], [true, 0, null]);
  lifeFacade.__resetSweepForTest();
  await simulateHours(0.25);
  const healed = life.alertsView();
  eq('the next tick rebuilds it', [healed.corrupt, typeof stored().lastRunAt], [false, 'number']);
  eq('the dismissed list survives', JSON.parse(raw('sweep_dismissed')), dismissedBefore);

  for (const [name, text] of [['an array', '[1,2,3]'], ['a string', '"hello"'], ['a number', '7'], ['bad rows', '{"findings":[{"fp":"x"},null]}'], ['findings not a list', '{"findings":"x","lastNight":12}']]) {
    set('sweep_findings', text);
    let threw = null;
    try { lifeFacade.__resetSweepForTest(); await simulateHours(0.25); } catch (err) { threw = err; }
    eq(`${name}: no throw from the tick`, threw, null);
    check(`${name}: the next read is clean`, life.alertsView().corrupt === false, raw('sweep_findings').slice(0, 80));
  }

  set('sweep_dismissed', '{broken');
  eq('a corrupt dismissed list reads as corrupt', life.alertsView().corrupt, true);
  life.runSweepNow();
  eq('…a run repairs it', [life.alertsView().corrupt, JSON.parse(raw('sweep_dismissed'))], [false, []]);
}

section('a failing store: the tick lives, and the same night is not retried on every tick');
{
  // Every write of the key aborts: a full disk, a locked file.
  db.exec(`CREATE TRIGGER sweep_block_i BEFORE INSERT ON story_state WHEN NEW.key = 'sweep_findings' BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    CREATE TRIGGER sweep_block_u BEFORE UPDATE ON story_state WHEN NEW.key = 'sweep_findings' BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
  db.prepare("DELETE FROM story_state WHERE key = 'sweep_findings'").run();   // due now
  lifeFacade.__resetSweepForTest();
  let threw = null;
  try { await simulateHours(2); } catch (err) { threw = err; }
  eq('eight ticks, no throw', threw, null);
  eq('…one attempt, not eight', lifeFacade.__sweepAttemptsForTest(), 1);
  eq('…nothing stored', raw('sweep_findings') ?? null, null);
  eq('…the read still answers', life.alertsView().count, 0);
  db.exec('DROP TRIGGER sweep_block_i; DROP TRIGGER sweep_block_u;');
  await simulateDays(1);
  check('the next night runs again and stores', Number.isFinite(stored()?.lastRunAt));
}

await stopLife();
report();
