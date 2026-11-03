// Life dry run (spec 009): simulate N days of his life on a throwaway scratch
// DB with a fake clock and a mocked Jev, and print a readable day log — for the
// owner to review before LIFE_ENABLED is turned on. Offline: no WhatsApp, no
// LLM, no network (fetch is disabled for the run), and the scratch DB under
// data/ is deleted on exit. Never opens the live database or writes world.json.
//
// Usage:
//   node scripts/life-dryrun.js                      3 days from today, example world
//   node scripts/life-dryrun.js --days 7 --start 2026-11-02
//   node scripts/life-dryrun.js --world src/personality/world.json   review the live seed (read only)
//   node scripts/life-dryrun.js --jev go|stay|costs  how the mocked Jev leans (default: costs → softmax of utility)
//   node scripts/life-dryrun.js --seed 7 --verbose --causes
//
// --world: the file is validated exactly like the engine does, except the
// "no real people's names" check, which needs the live DB (not opened here).
// An invalid file falls back to the example and the header says so.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_REL = `./data/life-dryrun-${process.pid}.db`;
const DB_ABS = path.join(PROJECT_ROOT, DB_REL);

// Before anything imports config (it reads the env once).
process.env.DB_PATH = DB_REL;
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = process.env.LIFE_DRYRUN_LOG_LEVEL || 'error';

function removeDb() {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(DB_ABS + s); } catch { /* absent */ }
  }
}
process.on('exit', removeDb);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// ── Args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const days = Math.min(31, Math.max(1, parseInt(opt('days', '3'), 10) || 3));
const startArg = opt('start', null);
const worldArg = opt('world', null);
const jevPolicy = opt('jev', 'costs');
const seedArg = opt('seed', null);
const verbose = flag('verbose');
const showCauses = flag('causes');
if (startArg && !/^\d{4}-\d{2}-\d{2}$/.test(startArg)) { console.error('--start must be YYYY-MM-DD'); process.exit(2); }
if (!['go', 'stay', 'costs'].includes(jevPolicy)) { console.error('--jev must be go, stay or costs'); process.exit(2); }

// No network for the whole run (the engine never needs it; this proves it).
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('network is disabled in the life dry run'); };

// ── Engine ────────────────────────────────────────────────────────────────

const { runMigrations, closeDb } = await import('../src/memory/db.js');
const clockMod = await import('../src/life/clock.js');
const { loadWorld, EXAMPLE_PATH } = await import('../src/life/world.js');
const { eventsAfter } = await import('../src/life/eventLog.js');
const { setJev, softmax } = await import('../src/life/decisions.js');
const { weatherPhrase } = await import('../src/life/weather.js');
const life = await import('../src/life/index.js');

const { setClock, zonedToUnix, dateKey, hhmm, dayLabel } = clockMod;

removeDb();
runMigrations(); // the 006 ladder includes the 009 life steps (v8, v9)

const worldPath = worldArg ? path.resolve(process.cwd(), worldArg) : '/nonexistent/world.json';
const world = loadWorld({ path: worldPath, examplePath: EXAMPLE_PATH, knownNames: [], force: true });
const tz = world.timezone;

const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const [y, m, d] = (startArg || today).split('-').map(Number);
const T0 = zonedToUnix(y, m, d, 5, 0, tz); // 05:00 local: he starts the run asleep
const END = T0 + days * 86400;
let t = T0;
setClock(() => t);

let jevCalls = 0;
setJev(async ({ state, questions }) => {
  jevCalls++;
  const ids = Object.keys(questions?.pick?.criteria || {});
  const us = {};
  for (const o of state?.options || []) if (ids.includes(o.id)) us[o.id] = Number(o.utility) || 0;
  let probs;
  if (jevPolicy === 'costs') probs = softmax(us);
  else {
    const want = jevPolicy === 'go' ? ids.find(i => /^go$/.test(i)) ?? ids[0] : ids.find(i => /stay|rest|skip/.test(i)) ?? ids[ids.length - 1];
    probs = Object.fromEntries(ids.map(i => [i, i === want ? 0.85 : 0.15 / Math.max(1, ids.length - 1)]));
  }
  const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { model: 'dry-run-mock', answers: { pick: { choice, confidence: probs[choice] ?? 0, probabilities: probs } }, usage: {}, ms: 0 };
});

await life.startLife({
  world, timers: false, isEnabled: () => true, getSock: () => null,
  seed: seedArg ?? undefined,
});
while (t < END) {
  t += 15 * 60;
  await life.tick();
}

// ── Day log ───────────────────────────────────────────────────────────────

const events = eventsAfter(0, 50000);
const byId = new Map(events.map(e => [e.id, e]));
const placeName = (id) => world.places.find(p => p.id === id)?.name ?? id ?? '?';
const castName = (id) => world.cast.find(c => c.id === id)?.name ?? id;
const at = (u) => (Number.isFinite(u) ? hhmm(u, tz) : '--:--');
const n1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '?');

const SKIP = new Set(['place.created', 'cast.created', ...(verbose ? [] : ['activity.ended', 'money.spent'])]);

function summary(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'genesis': return `world begins (${p.source ?? 'world'} world, ${world.places.length} places, ${world.cast.length} people)`;
    case 'woke': return p.firstNight
      ? 'woke (first morning)'      // genesis starts him asleep: no real night behind it
      : `woke${p.lateBy ? ` — ${p.lateBy} min late (sleep debt ${n1(p.debt)} h)` : ''}, slept ${n1((p.sleptMin ?? p.durationMin ?? 0) / 60)} h`;
    case 'plan.made':
      return p.amendedFor
        ? `evening rewritten for decision #${p.amendedFor}: now sleeping at ${at(p.sleepAt)}`
        : `plan (${p.dayType}): ${p.blocks?.length ?? 0} blocks, bed at ${at(p.sleepAt)}${p.workLate ? `, work runs ${p.workLate.minutes} min late (p ${p.workLate.p})` : ''}${p.skipped?.length ? `, skipped ${p.skipped.join('/')}` : ''}${p.gear?.umbrella ? ', umbrella packed' : ''}`;
    case 'activity.started': {
      const who = (p.withCast || []).map(castName);
      return `${p.kind} at ${placeName(p.placeId)} until ${at(p.end)} [${p.availability}]${who.length ? ` with ${who.join(', ')}` : ''}`;
    }
    case 'activity.ended': return `end ${p.kind}`;
    case 'travel.started': return `→ ${placeName(p.to)} by ${p.mode}, ${p.minutes} min (${n1(p.km)} km${p.cost ? `, cost ${n1(p.cost)}` : ''}) [${p.availability}]`;
    case 'travel.arrived': return `arrived at ${placeName(p.to)}`;
    case 'meal': return `ate ${p.kind}${p.good ? ' (in company)' : ''}`;
    case 'sleep.started': return `asleep${byId.get(e.causeId)?.type === 'work.late' ? ' (late: work ran over)' : ''}`;
    case 'work.late': return `work runs late: +${p.extraMin} min, until ${at(p.until)}`;
    case 'work.crunch': return `deadline crunch: work pressure +${p.amount ?? 20}`;
    case 'weather.changed': return `weather: ${weatherPhrase(p)}`;
    case 'sick.started': return `fell sick for ${p.days} day(s)`;
    case 'sick.ended': return 'feeling better';
    case 'money.salary': return `salary +${p.amount}`;
    case 'money.spent': return `spent ${n1(p.amount)} (${p.for ?? 'misc'})`;
    case 'birthday': return p.castId ? `${castName(p.castId)}'s birthday` : 'his birthday';
    case 'vitals.checkpoint': {
      const v = p.vitals || {};
      return `vitals: energy ${v.energy}, stress ${v.stress}, sleep debt ${v.sleepDebt} h, hunger ${v.hunger}, social ${v.socialBattery}, work pressure ${v.workPressure}, money ${v.money}`;
    }
    case 'decision.opened': {
      const s = p.subject || {};
      return `invitation (#${e.id}): ${p.kind} at ${placeName(s.placeId)} ${at(s.eventAt)}${(s.castIds || []).length ? ` with ${s.castIds.map(castName).join(', ')}` : ''} — decide by ${at(p.decideBy)}, leave by ${at(p.ponrAt)}; options ${(p.options || []).map(o => o.id).join('/')}`;
    }
    case 'decision.lean': return `leans ${p.optionId} (p ${p.p}) on ${p.trigger}${p.fallback ? `, fallback ${p.fallback}` : ''} [${e.actor}]`;
    case 'decision.committed': return `decided: ${p.optionId}${p.sampled ? ' (at the deadline)' : ' (early)'}${p.wanted ? '' : ' — not what he wanted most'}`;
    case 'decision.reversed': return `changed his mind: ${p.from} → ${p.to}`;
    case 'decision.expired': return `decision lapsed (${p.reason})`;
    case 'world.reanchored': return `re-anchored after ${p.gapHours} h`;
    case 'embargo.started': return `embargo until ${at(p.until)}`;
    case 'embargo.ended': return 'embargo over';
    case 'commute.soaked': return `caught in the rain on the way (${p.intensity})${p.changeClothes ? `, changed clothes: ${p.lateMin} min late` : ''}`;
    default: return e.type;
  }
}

const lines = [];
const out = (s = '') => lines.push(s);
out(`Life dry run — ${days} day(s) from ${dateKey(T0, tz)} (${tz}), world: ${world.source}${worldArg ? ` (${worldArg})` : ''}, Jev mock: ${jevPolicy}`);
if (worldArg && world.source === 'example') out(`  ! ${worldArg} did not validate — showing the example world instead (see the log line above).`);
// Shown in time order (a deadline commit is dated at its deadline, a few minutes
// before the tick that noticed it); ids keep the append order for --causes.
const shown = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
let lastDay = null;
for (const e of shown) {
  if (SKIP.has(e.type)) continue;
  const dk = dateKey(e.at, tz);
  if (dk !== lastDay) {
    out();
    out(`── ${dayLabel(e.at, tz)} ${dk.slice(0, 4)} ${'─'.repeat(40)}`);
    lastDay = dk;
  }
  const cause = showCauses ? `  #${e.id}${e.causeId ? ` ← #${e.causeId} ${byId.get(e.causeId)?.type ?? ''}` : ''}` : '';
  out(`  ${at(e.at)}  ${summary(e)}${cause}`);
}

const count = (type) => events.filter(e => e.type === type).length;
const wokes = events.filter(e => e.type === 'woke');
const avgLate = wokes.length ? Math.round(wokes.reduce((s, e) => s + (e.payload.lateBy || 0), 0) / wokes.length) : 0;
out();
out('── Summary ' + '─'.repeat(44));
out(`  events ${events.length}; days planned ${events.filter(e => e.type === 'plan.made' && !e.payload.amendedFor).length}; deadline crunches ${count('work.crunch')}; work ran late ${count('work.late')}×; average wake delay ${avgLate} min`);
out(`  decisions opened ${count('decision.opened')}, committed ${count('decision.committed')}, reversed ${count('decision.reversed')}, lapsed ${count('decision.expired')}; mocked Jev calls ${jevCalls}`);
out(`  sick days started ${count('sick.started')}; trips ${count('travel.started')}; network calls ${fetches}`);
console.log(lines.join('\n'));

await life.stopLife();
closeDb();
removeDb();
