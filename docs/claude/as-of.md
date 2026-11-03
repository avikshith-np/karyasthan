# As of (plan 020 D1)

Every writer's fact sheet reads the world as of one moment. Facts read at the wrong time or from the wrong source are this project's plot-hole class.

## The reader

`projector.asOf(key, {world, maxEvents})` → `{state, at, upto, targetExcluded}` | `null`.

- `{eventId}`: what the world held when that event was appended (ids below it). For facts tied to a moment in the log. `stateBeforeEvent(id)` is this read's state.
- `{at}`: what had happened by that time (events dated ≤ at, in id order). `at` is not monotone in id: catch-up, phone and chat events write past times, so later-dated rows are skipped and the base snapshot must predate the first of them.
- Both are that moment's facts as known **now**: today's reverts, rewinds and redactions apply, so a later revert counts.
- `state` is a fold, not a view. Numbers at a clock time come from `vitalsAt(state, t, world)`. For "now", the live projection plus `vitalsAt` is the same read and needs no fold.
- The caller owns its copy (a clone). Eight states are cached; a new revert or rewind, a purge's redaction (`eventLog.redactionGeneration`) or another DB drops all of them at once, so a purged person's rows don't linger in memory. An `at` key also carries the newest id dated by then, so a back-dated row misses.
- `null` means no such world: a bad key, before genesis, or no base within `maxEvents` (a very old id whose snapshots were pruned). It never silently means "now"; each caller chooses its fallback.
- Fold with the base world (`deps.world`), not an overlay: the fold applies the overlay itself.

Cost on a real 45-day log (2,501 events, arcs on, state 19 KB): cold from a snapshot ~4 ms (max 9), by time ~5 ms, warm ~1 ms, no snapshot at all 212 ms.

## Each sheet, and the moment each field reads

**Keep this table true when you add a field to a sheet.** "Fixed" rows have a replay in `arcs-tests/99-as-of-sheets` (mind: `mind-tests/21-digest-as-of`).

### Phone (`phone/facts.js`, `worker.write`): as of the turn, `at`

| Field | Read before | Should be | Verdict |
|---|---|---|---|
| him: energy, stress, mood | the last folded event (hours ago on a quiet night) | `at` | **Fixed** (`vitalsAt`, no overlay, as ever on this sheet) |
| him: job | title in the career slice, kept after a fire / quit | as of `at` | **Fixed** (`jobWordsOf`: "between jobs") |
| why: on my way | the first committed plan at that place, an older one included | this trip's plan | **Fixed** (the trigger scan's own rule, this member first) |
| now (what he's doing) | the projection, at most a tick behind | `at` | Right enough (the pulse owns the world's time) |
| them: card, metrics, romance | now | now | Right |
| lately, last seen, recent days, plans | log windows ending at `at` | `at` | Right |
| thread, register, urge | now | now | Right |
| hisViews | now | now | Right |

A REWRITE reads now on purpose: the rewrite is a new text dated now.

### Scene (`scenes/worker.contextFor`, `facts.js`): as of the outing's start

| Field | Read before | Should be | Verdict |
|---|---|---|---|
| him: energy, stress, mood, battery; the code outcome's weights | a zero-width `vitalsSeries`, which only sampled a start on the half hour; any other start read the state at write time | the start | **Fixed.** Changes the outcome roll's weights for such outings (below) |
| people, firstMeet, history, previous scene, job, the date check, on a resumed outing | before the resumption, so it held the outing's own first part | before its first part | **Fixed** (`session.startEventId` = the trace's anchor) |
| chat mood and dream overlays on that state | on at a half-hour start, then every start once the read above was fixed | off | **Fixed** (`{chatMood:false}`, like every story reader: a real chat's mood must not move the sheet or the roll, whose effects carry no chat origin. The dream nudge goes with it, as on the phone's sheet; a dream no longer colours a scene that morning) |
| weather | the state at write time: anything but the current block fell back to climatology, losing an owner's rain | the start | **Fixed** |
| planned next | the state at write time: a rewrite listed plans made since | the outing's end | **Fixed** (`stateAtEnd`; a session still going on reads now) |
| job | as phone | the start | **Fixed** |
| people, firstMeet, history, previous scene, job, date check, ordinary outing | the start | the start | Right (016) |
| owner intent, tone, outcome word | now | now | Keep: the owner's word stands at writing |
| place words, negative moment at a venue | now | now | Keep: a later negative moment must still hide a venue's name |
| effects, controls, heavy gates | now | now | Keep: they act now |
| afterwards | the log after the end, as far as now | now | Keep: the sweep checks it (`afterwardsCheck`) |
| his phone during it, texting, last saw, together before | log windows on the session | the session | Right |
| hisViews | now | now | Accepted: on a rewrite days later it reads today's view |

The start now means just before the outing's `activity.started`. The old read, on the half hour, sampled after that event and anything else at the same second, so even those outings can differ slightly in bands and outcome weights.

### Journal (`journal.js`): the night

| Field | Read before | Should be | Verdict |
|---|---|---|---|
| "with X", beats, birthdays | the cast now: someone who left since dropped from the bullet | the night | **Fixed** (`story.departed` too) |
| is this a chat's plan (self part) | the projection, which prunes closed decisions after 3 days; a night rebuilt or regenerated later read a chat's plan as his own | the night | **Fixed** (`nightDecisions`: `asOf({at})` on a miss; no answer there → the log as written, `decisionLog.chatMade`; a row it can't read counts as made in a chat) |
| chat part's went / couldn't | same: a pruned decision read "went" | the night | **Fixed** |
| bullets | the log window | the night | Right |
| option labels | the projection, else the opened event | the night | Right (already falls back to the log) |
| place words | now | now | Keep: as scenes |
| embargo | now | now | Keep: the strictest read |

"Night of …" on the prompt states its moment.

### Narration (`narrate.thoughtInputs`): now

| Field | Read before | Should be | Verdict |
|---|---|---|---|
| "feeling" | the last folded event | now | **Fixed** |
| lines | reverted events included (`excluded: () => false`) | what still stands | **Fixed** |

### Director catalogue (`prompt.buildCatalogue`), story read: now, stated

Right already. `model.now` states the moment; the live state is the world now; money is exact since the wallet; `me` uses the employed flag. The story read re-plans at `previewAt` and refuses `stale` before any spend. A retcon reads its rewound base.

### Weekly pass (`weekly.js`): now

| Field | Read before | Should be | Verdict |
|---|---|---|---|
| you.job.title | title kept after a fire | now | **Fixed** (`jobWordsOf`) |

### Mind

| Input | Reads | Verdict |
|---|---|---|
| think: a chat's digest (≤ 48 h) | its own time, unstated | **Fixed**: each section states its age |
| think: `Cn.today` | a digest from yesterday offered as today, pickable onto his self-state | **Fixed**: only the digest's local date or under 6 h old (`digestIsToday`) |
| think / glance: life view | `viewNow` and `nowSec`, the same moment | Right |
| sleep: episodes | the night's key | Right |
| sleep: "your own life today" | the last 24 h from the run, event types only, reverted rows included | Left: no fact a writer can contradict; a catch-up sleep may read part of the next day |
| self-model, glance counters, stance evidence | counts and ids, as of now, exclusions applied | Right |

### Other reads looked at and left

- **A decision's option costs vs its weights.** Costs and the trip are a quote frozen when it opens; weights read at each lean. Intended: deadlines are frozen with them, the real trip is planned at the fit, Jev sees numbers, no sheet states them. Repricing would change every lean and the goldens.
- **A deferred message** is answered with the state at the catch-up. Right: he reads it then.
- **A held chat perception** re-reads the message (same sha256) when applied. Right.
- **Dreams**: built at the wake from the pulse's state, the plan stored. Right.
- **Plans from texts**: re-reads the state under the lock. Right.

## The "as of" lines

`as of: <day> <time>` on a text's facts, `as of (people, his state, the weather): …` on a scene's (`sheet.asOf`, also stored). Neither goes on an explicit sheet, which stays as it was. A scene that reused v1's stored sheet (the world before it unreadable) states none.

## Tests

`life-tests/76-as-of` (replay equality across snapshot boundaries and back-dated rows, edges, undo, copies, LRU, cost), `arcs-tests/99-as-of-sheets`, `mind-tests/21-digest-as-of`.
