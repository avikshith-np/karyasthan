// Plan 020 H4 follow-up: an invitation isn't lost to how the clerk wrote down a time it clearly stated, and whatever is refused says why. Ambiguous stays refused: a wrong plan is worse than none.
// Pure table first, then through the whole chain.
import {
  setupScratchDb, bootInfluence, say, idle, inviteJev, inviteClerk, inviteExtraction, inviteDecisions,
  section, check, eq, report,
} from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence({ jev: inviteJev(), areas: { invites: true, mood: false, sleep: false, work: false } });
const { normalizeInviteExtraction: norm, clockOf } = await import('../../src/life/story/inviteDrift.js');
const { validateExtraction } = await import('../../src/life/story/schema.js');
const store = await import('../../src/life/influence/store.js');
const { resolveAudience } = await import('../../src/memory/recall.js');
const { dateKey, localParts, zonedToUnix, resolveTimezone } = await import('../../src/life/clock.js');
const { resolveSpan } = await import('../../src/life/story/reconciler.js');
const tz = resolveTimezone(t.world?.timezone ?? t.config.timezone);
const BOT = '10000000000@s.whatsapp.net';

const base = { type: 'plan', kind: 'coffee', when: { date: null, relative: 'tonight', time: null, part: null }, minutes: null, place: null, people: [], summary: 'coffee', confidence: 0.9 };
// A Wednesday evening, 18:40 local.
const WED = zonedToUnix(2026, 11, 4, 18, 40, tz);
const run = (o, at = WED) => {
  const r = norm(typeof o === 'string' ? o : JSON.stringify(o), { createdAt: at, tz });
  if (!r.ok) return { refused: r.error };
  const v = validateExtraction(r.text);
  return v.ok ? v.value : { refused: v.error };
};
const when = (w, at) => run({ ...base, when: { date: null, relative: null, time: null, part: null, ...w } }, at);

section('format drift, every row of the table: a stated time is read');
{
  eq('a clean one is left as it was', when({ relative: 'tonight', time: '21:00' }).when, { date: null, relative: 'tonight', time: '21:00', part: null });
  eq('this_evening', when({ relative: 'this_evening' }).when, { date: null, relative: 'today', time: null, part: 'evening' });
  eq('"this evening"', when({ relative: 'this evening' }).when, { date: null, relative: 'today', time: null, part: 'evening' });
  eq('this_afternoon', when({ relative: 'this_afternoon' }).when, { date: null, relative: 'today', time: null, part: 'afternoon' });
  eq('saturday', when({ relative: 'saturday' }).when.relative, 'next_saturday');
  eq('this saturday', when({ relative: 'this saturday' }).when.relative, 'next_saturday');
  eq('next_saturday stays', when({ relative: 'next_saturday' }).when.relative, 'next_saturday');
  eq('time 8pm', when({ relative: 'tonight', time: '8pm' }).when.time, '20:00');
  eq('time 20:00:00', when({ relative: 'tonight', time: '20:00:00' }).when.time, '20:00');
  eq('date "tomorrow"', when({ date: 'tomorrow' }).when, { date: null, relative: 'tomorrow', time: null, part: null });
  eq('a real date stays', when({ date: '2026-11-07' }).when.date, '2026-11-07');
  eq('part "night"', when({ part: 'night' }).when.part, 'night');
  eq('when as a word', run({ ...base, when: 'tonight' }).when.relative, 'tonight');
}

section('clock times');
{
  for (const [input, want] of [['8pm', '20:00'], ['8 pm', '20:00'], ['8:30pm', '20:30'], ['8.30 pm', '20:30'], ['8 p.m.', '20:00'], ['8am', '08:00'], ['12am', '00:00'], ['12pm', '12:00'], ['12:30am', '00:30'], ['12:30pm', '12:30'],
    ['9:05', '09:05'], ['20:00', '20:00'], ['20:00:30', '20:00'], ['noon', '12:00'], ['midnight', '00:00'], ['8', null], ['20', null], ['25:00', null], ['8:75', null], ['13pm', null], ['0am', null], ['soon', null], ['evening', null], ['', null], [20, null]]) {
    eq(`${JSON.stringify(input)}`, clockOf(input), want);
  }
}

section('anything ambiguous stays refused, with its own code');
{
  eq('bare 8', when({ relative: 'tonight', time: '8' }).refused, 'bad_time');
  eq('25:00', when({ relative: 'tonight', time: '25:00' }).refused, 'bad_time');
  eq('soon', when({ relative: 'soon' }).refused, 'bad_relative');
  eq('later', when({ relative: 'later' }).refused, 'bad_relative');
  eq('next_week, no day', when({ relative: 'next_week' }).refused, 'bad_relative');
  eq('sometime', when({ relative: 'sometime' }).refused, 'bad_relative');
  eq('a date in another format', when({ date: '11/07' }).refused, 'bad_date');
  eq('part "late night"', when({ part: 'late night' }).refused, 'bad_part');
  eq('a date that disagrees with its relative', when({ relative: 'today', date: 'tomorrow' }).refused, 'bad_date');
  eq('this_evening with part morning', when({ relative: 'this_evening', part: 'morning' }).refused, 'bad_part');
  eq('wednesday, said on a wednesday: today or next week?', when({ relative: 'wednesday' }).refused, 'bad_relative');
  eq('…next_wednesday as the clerk wrote it, though, is what it says', when({ relative: 'next_wednesday' }).when.relative, 'next_wednesday');
}

section('batch 3 review 36, 38, 40: what could be read two ways, or could not be real');
{
  for (const t of ['10.30', '8.30', '12.30', '08.30']) eq(`dotted ${t}, no am/pm`, when({ relative: 'tomorrow', time: t }).refused, 'bad_time');
  eq('dotted 20.30 can only be evening', when({ relative: 'tonight', time: '20.30' }).when.time, '20:30');
  eq('8.30pm says which', when({ relative: 'tonight', time: '8.30pm' }).when.time, '20:30');
  eq('tomorrow_morning at 8pm', when({ relative: 'tomorrow_morning', time: '8pm' }).refused, 'bad_part');
  eq('this_evening at 8:30', when({ relative: 'this_evening', time: '8:30' }).refused, 'bad_part');
  eq('this_evening at 20:30 agrees', when({ relative: 'this_evening', time: '20:30' }).when.time, '20:30');
  eq('tomorrow_morning at 9am agrees', when({ relative: 'tomorrow_morning', time: '9am' }).when.part, 'morning');
  eq('tomorrow_night at 1am: the night after, no word for it', when({ relative: 'tomorrow_night', time: '1am' }).refused, 'bad_time');
  eq('tomorrow_night at 12am', when({ relative: 'tomorrow_night', time: '12am' }).refused, 'bad_time');
  eq('the schema form says the same', when({ relative: 'tomorrow', part: 'night', time: '01:00' }).refused, 'bad_time');
  eq('tomorrow_night at 10pm is fine', when({ relative: 'tomorrow_night', time: '10pm' }).when.time, '22:00');
  eq('tonight at 1am still shifts', typeof when({ relative: 'tonight', time: '1am' }).when, 'object');
  eq('an impossible date has its own code', when({ date: '2026-02-30', time: '21:00' }).refused, 'bad_date');
  eq('a real one passes', when({ date: '2028-02-29', time: '21:00' }).when.date, '2028-02-29');
}

section('no time at all is its own thing, and stays dropped (C goes to the owner)');
{
  eq('all four null', when({}).refused, 'no_when');
  eq('when: null', run({ ...base, when: null }).refused, 'no_when');
  const { when: _w, ...noWhen } = base;
  eq('when missing', run(noWhen).refused, 'no_when');
  eq('empty strings', when({ relative: '', time: '', date: '', part: '' }).refused, 'no_when');
  eq('when of the wrong shape', run({ ...base, when: 5 }).refused, 'bad_when');
}

section('a bad optional field becomes nothing; confidence is required');
{
  eq('minutes as a number string', run({ ...base, minutes: '60' }).minutes, 60);
  eq('minutes as words', run({ ...base, minutes: 'an hour' }).minutes, null);
  eq('place not a string', run({ ...base, place: 5 }).place, null);
  eq('people as one string', run({ ...base, people: 'Asha' }).people, ['Asha']);
  eq('people as a number refuses', run({ ...base, people: 5 }).refused, 'bad_people');
  eq('people as an object refuses: dropped, it would open one-to-one', run({ ...base, people: { names: ['Rowan'] } }).refused, 'bad_people');
  eq('people null is nobody', run({ ...base, people: null }).people, []);
  eq('people missing is nobody', (() => { const { people: _p, ...r } = base; return run(r).people; })(), []);
  eq('kind not a string', run({ ...base, kind: 5 }).kind, null);
  eq('confidence as a number string', run({ ...base, confidence: '0.9' }).confidence, 0.9);
  eq('confidence missing', (() => { const { confidence: _c, ...r } = base; return run(r).refused; })(), 'bad_confidence');
  eq('confidence "high"', run({ ...base, confidence: 'high' }).refused, 'bad_confidence');
  eq('type "invite"', run({ ...base, type: 'invite' }).refused, 'bad_type');
  eq('fenced json still reads', run(`\`\`\`json\n${JSON.stringify(base)}\n\`\`\``).kind, 'coffee');
  eq('prose before it still reads', run(`Here it is: ${JSON.stringify(base)}`).kind, 'coffee');
  eq('empty', run('').refused, 'empty');
  eq('truncated', run(JSON.stringify(base).slice(0, 60)).refused, 'no_object');
}

section('the bot\'s timezone, also around midnight: what the days resolve to');
{
  const dayOf = (w, at = WED) => dateKey(resolveSpan({ type: 'plan', when: when(w, at).when }, at, tz).start, tz);
  const timeOf = (w, at = WED) => { const p = localParts(resolveSpan({ type: 'plan', when: when(w, at).when }, at, tz).start, tz); return `${p.hour}:${String(p.minute).padStart(2, '0')}`; };
  eq('tomorrow from wednesday', dayOf({ date: 'tomorrow' }), '2026-11-05');
  eq('saturday from wednesday', dayOf({ relative: 'saturday' }), '2026-11-07');
  const late = zonedToUnix(2026, 11, 4, 23, 50, tz);
  const small = zonedToUnix(2026, 11, 5, 0, 10, tz);
  eq('tomorrow, ten to midnight', dayOf({ date: 'tomorrow' }, late), '2026-11-05');
  eq('tomorrow, ten past midnight: the next local day', dayOf({ date: 'tomorrow' }, small), '2026-11-06');
  eq('tonight at 12am from the evening: the coming midnight', [dayOf({ relative: 'tonight', time: '12am' }), timeOf({ relative: 'tonight', time: '12am' })], ['2026-11-05', '0:00']);
  eq('tonight at 1am at ten to midnight: the coming small hours', dayOf({ relative: 'tonight', time: '1am' }, late), '2026-11-05');
  eq('tonight at 1am, already in the small hours: that night', dayOf({ relative: 'tonight', time: '1am' }, small), '2026-11-05');
  eq('12pm today is noon', timeOf({ relative: 'today', time: '12pm' }), '12:00');
}

section('a day said out loud that has gone stays in the past; a bare clock time is the next occurrence');
{
  const span = (w, at = WED) => resolveSpan({ type: 'plan', when: when(w, at).when }, at, tz).start;
  check('this_evening, when evening has passed', span({ relative: 'this_evening' }, zonedToUnix(2026, 11, 4, 22, 0, tz)) < zonedToUnix(2026, 11, 4, 22, 0, tz) - 3600);
  check('this_morning at 18:40', span({ relative: 'this_morning' }) < WED - 3600);
  check('8am today at 18:40', span({ relative: 'today', time: '8am' }) < WED - 3600);
  eq('8am at 18:40, no day word: none added', when({ time: '8am' }).when.relative, null);
  eq('8am at 18:40: tomorrow', dateKey(span({ time: '8am' }), tz), '2026-11-05');
  eq('08:00 at 18:40: the same moment', span({ time: '08:00' }), span({ time: '8am' }));
  eq('8 a.m. too', span({ time: '8 a.m.' }), span({ time: '8am' }));
  eq('8pm at 18:40, still ahead: today', dateKey(span({ time: '8pm' }), tz), '2026-11-04');
}

// ── the whole chain ──
let n = 0;
t.config.chatInfluence.perSenderPerHour = 60;
t.config.chatInfluence.perChatPerHour = 120;
t.config.chatInfluence.clerkMaxPerDay = 100;
t.config.chatInfluence.invitesMaxPerDay = 100;
t.clock.advance({ minutes: 60 });
await t.life.tick();
const day = () => dateKey(t.clock.now(), tz);
const reasons = () => store.outcomesFor(day()).reasons;
async function invite(clerkOut) {
  await inviteClerk(() => clerkOut);
  const before = inviteDecisions(t)[0]?.id ?? 0;
  const id = `D${++n}`;
  await say(t, { chat: t.GROUP, sender: t.A, text: 'cinema tonight?', id, verdict: null, mentioned: [BOT] });
  t.life.gateOutcome(t.GROUP, id, 'now');
  await t.life.inviteNote(t.GROUP, id, resolveAudience({ chatJid: t.GROUP }), { startedAt: Date.now() });
  await idle(t);
  const d = inviteDecisions(t)[0];
  const opened = d && d.id > before ? d : null;
  if (opened) {
    for (const r of t.db.prepare("SELECT pointer_event_id AS id FROM chat_influence_items WHERE kind = 'invite' AND pointer_event_id IS NOT NULL").all()) { try { t.life.revertEvent(r.id, { reason: 'test', by: 'test' }); } catch { /* */ } }
    t.db.prepare("DELETE FROM chat_influence_items WHERE kind = 'invite'").run();
  }
  return opened;
}
const out = (w, extra = {}) => inviteExtraction({ when: { date: null, relative: null, time: null, part: null, ...w }, ...extra });

section('through the chain: drift opens an invitation, and each refusal is its own counter');
{
  const hour = localParts(t.clock.now(), tz).hour;
  check('the test runs at 19:00, so 9pm is still ahead', hour === 19, hour);
  check('time 9pm opens one', !!(await invite(out({ relative: 'tonight', time: '9pm' }))), reasons());
  check('time 21:00:00 opens one', !!(await invite(out({ relative: 'tonight', time: '21:00:00' }))), reasons());
  check('"tomorrow" as a date opens one', !!(await invite(out({ date: 'tomorrow', time: '9pm' }))), reasons());
  for (const [what, o, code] of [
    ['no time', out({}), 'invite_no_when'], ['bare 8', out({ relative: 'tonight', time: '8' }), 'invite_bad_time'], ['soon', out({ relative: 'soon' }), 'invite_bad_relative'],
    ['part', out({ part: 'late night' }), 'invite_bad_part'], ['date', out({ date: '11/07' }), 'invite_bad_date'], ['confidence', out({ relative: 'tonight', time: '21:00' }, { confidence: 7 }), 'invite_bad_confidence'], ['nonsense', 'sure, a movie!', 'invite_no_object'],
  ]) {
    const was = reasons()[`dropped:${code}`] ?? 0;
    eq(`${what}: nothing opens`, await invite(o), null);
    eq(`…counted as ${code}`, reasons()[`dropped:${code}`] ?? 0, was + 1);
  }
  // A stated day that has gone fails; a bare clock time opens for its next occurrence, whichever way it was written.
  const goneWas = reasons()['dropped:invite_out_of_window'] ?? 0;
  eq('this_morning, in the evening: nothing opens', await invite(out({ relative: 'this_morning' })), null);
  eq('…for the later check\'s reason, it doesn\'t roll', reasons()['dropped:invite_out_of_window'] ?? 0, goneWas + 1);
  eq('8am today, stated, in the evening: nothing opens', await invite(out({ relative: 'today', time: '8am' })), null);
  // this_evening is 18:30. At 19:00 it has begun: past its point of no return, so no plan can be made for it (reconciler's fit), within runInvite's one-hour check or not.
  const evWas = reasons()['dropped:invite_out_of_window'] ?? 0;
  eq('this_evening, once it has begun: nothing opens', await invite(out({ relative: 'this_evening' })), null);
  eq('…out of window', reasons()['dropped:invite_out_of_window'] ?? 0, evWas + 1);

  // A bare clock time at its next occurrence. The plan decides if he's free: a workday's 8am is refused as a conflict, on the same time either way.
  const conflictWas = reasons()['dropped:invite_conflict'] ?? 0;
  eq('8am on a workday: refused by his plan, not by the clock', await invite(out({ time: '8am' })), null);
  eq('…as a conflict', reasons()['dropped:invite_conflict'] ?? 0, conflictWas + 1);
  eq('…08:00 the same', await invite(out({ time: '08:00' })), null);
  eq('…as a conflict', reasons()['dropped:invite_conflict'] ?? 0, conflictWas + 2);
  // A free evening, then a free morning: on to the next rest day.
  for (let i = 0; i < 6 && ![5].includes(new Date(Date.UTC(...(() => { const p = localParts(t.clock.now(), tz); return [p.year, p.month - 1, p.day]; })())).getUTCDay()); i += 1) {
    for (let h = 0; h < 24 * 4; h += 1) { t.clock.advance({ minutes: 15 }); await t.life.tick(); }
  }
  await idle(t);
  const hNow = localParts(t.clock.now(), tz).hour;
  check('a friday evening', hNow === 19, hNow);
  const nextDay = dateKey(t.clock.now() + 86400, tz);
  const startOf = (d) => dateKey(d.subject.eventAt, tz);
  const a = await invite(out({ time: '11am' }));
  check('11am, no day word, in the evening: opens', !!a, reasons());
  eq('…for tomorrow', a && startOf(a), nextDay);
  const b = await invite(out({ time: '11:00' }));
  check('11:00: opens too', !!b, reasons());
  eq('…at the same moment', b?.subject?.eventAt, a?.subject?.eventAt);
  check('the old catch-all is gone', !Object.keys(reasons()).some(k => k.includes('invalid_extraction')), reasons());
}

section('the claim path is untouched');
{
  const fs = await import('fs');
  const rec = fs.readFileSync(new URL('../../src/life/story/reconciler.js', import.meta.url), 'utf8');
  check('the reconciler doesn\'t use it', !rec.includes('inviteDrift') && !rec.includes('normalizeInviteExtraction'));
  eq('the validator itself still refuses raw drift', validateExtraction(JSON.stringify({ ...base, when: { ...base.when, time: '8pm' } })).error, 'bad_when');
  const src = fs.readFileSync(new URL('../../src/life/story/inviteDrift.js', import.meta.url), 'utf8');
  check('nothing logged', !/logger|console\./.test(src));
}

report();
