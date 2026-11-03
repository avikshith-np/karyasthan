// His phone: news on the sheet (live 2026-11-02). A beat "planning a dinner with her friends",
// from just before that very evening, sat undated under "lately" for ten days, and two days later he
// asked if she was still on for it. News carries its day, and only what's new since they last met counts.
import { section, check, eq, report, setupScratchDb, bootLife, simulateHours } from './_helpers.js';
import { appendEvent, listEvents } from '../../src/life/eventLog.js';
import { beatsOf } from '../../src/life/story/phone/worker.js';
import { HIS_CHARTER, CAST_CHARTER } from '../../src/life/story/phone/charter.js';
import { resolveTimezone } from '../../src/life/clock.js';
import * as facade from '../../src/life/index.js';

await setupScratchDb();
await bootLife();
await simulateHours(1);
const s = facade.getState();
const tz = resolveTimezone(s);
const castId = [...s.cast.keys()][0];
const t = listEvents({ order: 'desc', limit: 1 })[0].at;
const beat = (at, text, extra = {}) => appendEvent({ type: 'cast.beat', at, actor: 'owner', payload: { castId, kind: 'news', text, ...extra } });
const met = (at, who = castId) => appendEvent({ type: 'activity.started', at, actor: 'engine', payload: { kind: 'hangout', placeId: 'place:cafe', withCast: [who], end: at + 3600, social: true } });
const H = 3600;
const lines = (at) => beatsOf(facade.getState(), castId, at, tz);

section('news before they last met is over');
{
  const at = t + 60 * H;
  beat(t - 3 * H, 'planning a late evening with her friends');
  check('with no meeting yet, the news shows', lines(at).some(l => l.includes('planning a late evening')));
  check('…with its day in front', /^\w{3} .*\d\d:\d\d: planning/.test(lines(at).find(l => l.includes('planning')) ?? ''), lines(at));
  met(t - 2 * H);
  eq('they met after it: gone', lines(at).filter(l => l.includes('planning')), []);
  met(t - 90 * H, [...s.cast.keys()][1] ?? 'cast:other');
  eq('someone else\'s outing changes nothing', lines(at).filter(l => l.includes('planning')), []);
}

section('news after they met stays, dated, newest first');
{
  const at = t + 60 * H;
  beat(t + 2 * H, 'got back from a work trip');
  beat(t + 3 * H, 'started a new class');
  const l = lines(at);
  eq('both', l.length, 2);
  check('newest first', l[0].includes('new class') && l[1].includes('work trip'), l);
  check('every line has a day', l.every(x => /: /.test(x)), l);
  beat(t + 4 * H, 'a'); beat(t + 5 * H, 'b'); beat(t + 6 * H, 'c');
  eq('≤ 3', lines(at).length, 3);
}

section('the writers are told');
for (const [name, ch] of [['his side', HIS_CHARTER], ['her side', CAST_CHARTER]]) {
  check(`${name}: a plan only from "his plans" or the thread`, /A plan exists only if it is in "his plans" or the two of you agreed it in the thread/.test(ch));
  check(`${name}: "lately" isn't a plan`, /"lately" is dated news, not a plan/.test(ch));
}
section('D2: what a note leaves to "lately" keeps the rule');
{
  const at = t + 200 * H;
  const noteId = listEvents({ order: 'desc', limit: 1 })[0].id;
  beat(t + 100 * H, 'after the note, before they met');
  met(t + 101 * H);
  beat(t + 102 * H, 'after the note and after they met');
  const after = beatsOf(facade.getState(), castId, at, tz, noteId);
  eq('older than their last meeting: never, even if newer than the note', after.filter(l => l.includes('before they met')), []);
  check('newer than both: shows, with its day', after.some(l => /\d\d:\d\d: after the note and after they met/.test(l)), after);
  eq('…not what the note already covers', beatsOf(facade.getState(), castId, at, tz, listEvents({ order: 'desc', limit: 1 })[0].id), []);
}

report();
process.exit(0);
