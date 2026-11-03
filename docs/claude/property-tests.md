# Property tests (plan 020 §E5)

Seeded random sequences against the real engine, checked after every step. Scripts only
(`scripts/property-tests/`); no source code is touched and nothing is installed.

- **`ops.js`** — a mulberry32 PRNG and the operation generator. An operation list is plain data:
  `pass {h}`, `outing {place, inMin, minutes, cast}` (a Director outing), `schedule {day, activity,
  from, to, place?}`, `text {cast}` (SEND A TEXT), `money {mode, amount}`, `wake`, `revert {pick}`
  (REVERT THIS CHANGE of an applied change), `reapply` (the last reverted change again), `rewind
  {back}` (to an event that far back through the run's own log). Every list ends with a day passing.
- **`child.js`** — one run: a fresh scratch DB (`life-tests/_helpers.js`), `bootLife` (example world,
  fake clock, stubbed scene / phone writers, fake Jev, network blocked), 4 h of warm-up, then the
  operations. A refused action or revert (an error with a `code`) is the engine saying no, never a
  failure. Checks:
  - no operation and no tick throws; no engine error is logged (`logger.error`, or a warn carrying a
    TypeError / ReferenceError / RangeError);
  - two ticks at one moment: the second appends nothing (the log stops growing when nothing's due);
  - every 4 operations and at the end: a full replay (`projector.rebuild({useSnapshot:false})`) ≡ the
    live projection (story, self less age, cast, places, every decision, embargo, plan, lastEventId;
    **vitals left out**: live integrates them between events on each tick, by design) and ≡ a snapshot
    rebuild (`storyEquivalent`); the same right after every `reapply` (revert + re-apply stays consistent);
  - the whole log: ids increasing, every cause exists, was appended earlier and is not dated after its
    effect (1 s slack); a created cast / place / schedule override / goal id is never minted twice;
  - at the end, `life.runSweepNow()`: a `high` finding fails, `warn` / `info` are listed.
  Prints one JSON line `{ ok, failures, notes, stats }` and stops at the first failure.
- **`run.js`** — seeds → children one at a time (the scratch DB is one file) → on a failure, shrink
  (drop halves down to single operations, then halve the waits; ≤ 25 tries, 60 with `--long`) and print
  the seed and a replay command. The default run starts with a **self-test**: a planted fault (an event
  dated two hours before its cause) must be caught and shrink to it, or the harness counts as failed.

```
npm test -- property                               # self-test + 4 seeds × 18 ops, ~35 s (nice -n 10)
node scripts/property-tests/run.js --long          # 40 seeds × 40 ops, ~15 min
node scripts/property-tests/run.js --seeds 7,9 --ops-per-run 30
node scripts/property-tests/run.js --seed 7 --ops '<json>'   # replay a printed sequence
node scripts/property-tests/run.js --self-test
```

Triage tools: `--notes` prints every sweep warn / info with its seed and events; `trace.js <seed> <id>` dumps a
decision's (or any event's) own events, what the log holds around its time and every revert / rewind.
`cases.json` = the incident list: each shrunk failing sequence (and each seed whose warn a fix removed,
`noNotes`) is replayed in every default run.

Found and fixed (2026-11-02):
- seed 20261117 — after a rewind a `work.late` was dated before the `plan.made` causing it (pulse: a plan made
  after the work block's normal end appends none);
- seeds 20261102 / 20261103 — a committed outing kept by a rewind's target but its evening rewound away stayed
  "go" forever (rewind step 4 expires a committed outing whose window has passed, `rewound`, closed at once; window still open: the pulse decides; a start the target keeps: it resumes);
- `phone_with_someone` — a turn checked against a projection behind the clock (an outing starting at that tick)
  went out mid-outing (phone commit re-checks the together rule, the turn waits);
- seeds 31000012 / 31000015 — an outing brought back by undoing, hours or days after its time, the change that
  displaced it stayed "go" (pulse: a locked outing over ≤ 7 days ago that never started expires `could_not_go`
  now; the start check reads the log from the decision on and keeps a "yes" until the undone set changes).
Left as accurate info: `two_places` "left X while the log has him at Y" after the owner reverts a lived outing
(its trips go, later trips of other plans keep their `from`). REVERT THIS CHANGE's preview now says so first:
`continuity.warnings` (outside the fingerprint, never a refusal) gets `later_trips_from` from
`story/continuity.js laterTripsFrom` via the story facade's `revertTripsWarnings`; the PLAY GOD confirm shows
it. Test: `arcs-tests/101-revert-trips`.
