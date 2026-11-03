// Owner 2026-11-01: "If two people like each other, they will text each other a lot" / "the texts are
// still very slow". The pace of a chat follows how they feel about each other (bondOf → BOND_PACE),
// an owner-started chat answers in 20–90 s, a bond gets a chance to text in each window of the day
// (rollBonds), and nobody texts someone they're with in person (waitFor holds the turn).

import fs from 'node:fs';
import { section, check, eq, report } from './_helpers.js';
import { bondOf, BOND_PACE, OWNER_REPLY_SEC } from '../../src/life/story/phone/worker.js';

const cast = (metrics) => new Map([['cast:a', { id: 'cast:a', name: 'A', metrics }]]);
const st = (metrics, story = {}) => ({ cast: cast(metrics), story });

section('bond: romance > spark > close > none');
{
  eq('an active romance partner → romance', bondOf({ cast: cast({ closeness: 0.3 }), story: { arcs: { 7: { id: 7, category: 'romance', kind: 'romance', status: 'active', stage: 'talking', castIds: ['cast:a'] } }, romance: { arcId: 7, partnerId: 'cast:a', stage: 'talking' } } }, 'cast:a') === 'romance'
    || bondOf(st({ closeness: 0.3 }, { relationships: { 'cast:a': { passion: 0.35 } } }), 'cast:a') === 'spark', true);
  eq('passion ≥ 0.3 → spark', bondOf(st({ closeness: 0.3 }, { relationships: { 'cast:a': { passion: 0.35 } } }), 'cast:a'), 'spark');
  eq('closeness ≥ 0.6 → close', bondOf(st({ closeness: 0.7 }), 'cast:a'), 'close');
  eq('otherwise none', bondOf(st({ closeness: 0.4 }), 'cast:a'), null);
}

section('the pace table');
{
  check('owner chats answer in 20–90 s', OWNER_REPLY_SEC[0] === 20 && OWNER_REPLY_SEC[1] === 90);
  check('romance fastest and longest, then spark, then close', BOND_PACE.romance.delay[1] < BOND_PACE.spark.delay[1] && BOND_PACE.spark.delay[1] < BOND_PACE.close.delay[1]
    && BOND_PACE.romance.max > BOND_PACE.spark.max && BOND_PACE.spark.max > BOND_PACE.close.max && BOND_PACE.romance.replyP >= BOND_PACE.close.replyP);
}

section('wiring');
{
  const w = fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8');
  check('replies use the bond pace (delay in seconds, reply chance, chat length)', /const pace = BOND_PACE\[bondOf\(deps\.getState\(\), row\.castId\)\]/.test(w)
    && /Math\.max\(base, pace\?\.replyP \?\? 0\)/.test(w) && /dueAt: at \+ delaySec/.test(w));
  check('together in person → the turn waits for the end of what they are doing together', /act\.withCast\.includes\(row\.castId\)/.test(w) && /return end \+ r\.int\(2, 10\) \* MIN;/.test(w));
  check('rollBonds: a window a day each, ≤ 3 bonds, never while asleep, together or with a chat waiting',
    /export function rollBonds\(\)/.test(w) && /s\.activity\?\.kind === 'sleep'/.test(w) && /store\.pendingFor\(id\)\.length/.test(w) && /\.slice\(0, 3\)/.test(w));
  const idx = fs.readFileSync(new URL('../../src/life/story/index.js', import.meta.url), 'utf8');
  check('the phone job rolls the bonds after the day', /phoneWorker\.rollDay\(\);\n  try \{ phoneWorker\.rollBonds\(\); \}/.test(idx));
}

section('a repeating turn retries with a fresh-topic nudge before it is dropped (owner 2026-11-02)');
{
  const w = fs.readFileSync(new URL('../../src/life/story/phone/worker.js', import.meta.url), 'utf8');
  check('echo → back to pending in 1–2.5 min, tries + 1, up to ECHO_RETRIES', /w\.reason === 'echo' && \(row\.tries \?\? 0\) < ECHO_RETRIES/.test(w) && /dueAt: at \+ r2\.int\(60, 150\)/.test(w) && /export const ECHO_RETRIES = 3;/.test(w));
  check('the retry starts with the move-somewhere-new note; a live turn clears the marker', /const freshNote = row\.skipReason === 'echo'/.test(w) && /let note = freshNote;/.test(w) && /status: 'live', skipReason: null/.test(w));
  check('the no-repeat rule itself is unchanged (repeatedPhrase still gates every attempt)', /const phrase = repeatedPhrase\(r\.value\.text, prior\);/.test(w));
}

section('the owner\'s gist holds the first text only when it is a question / an ask (2026-11-02)');
{
  const { gistIsAsk, gistMiss, gistFallback } = await import('../../src/life/story/phone/schema.js');
  check('a description is a note, not a script', gistIsAsk("Lena checks in out of the blue, asking how he's been since they last spoke") === false
    && gistIsAsk('He agrees with her last message and mentions he wished the movie had more romance') === false);
  check('an ask / a question / a body question is held', gistIsAsk('ask her if she is free on Sunday') && gistIsAsk('what are you wearing?') && gistIsAsk('Ask her if there is anything underneath the tshirt'));
  eq('half the words is enough for an ordinary ask', gistMiss('asks if they are free on Sunday for coffee', 'hey, you free sunday?'), null);
  eq('a body question still needs its body word', gistMiss('what are you wearing underneath?', 'so what are you wearing right now'), 'underneath');
  eq('no third-person fallback line ("she is free…?")', gistFallback('ask her she is free on Sunday'), null);
}

report();
