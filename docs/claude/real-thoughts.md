# Real thoughts (plan 020 F3)

A few times a day, at a moment that matters, one small model call says what he told himself about it. Beside it, in code, is what actually drove it. Keep this file current when the feature changes.

## The two columns

- **What he told himself.** The model reads a code fact sheet: what he did, how he is, what he's doing. It's asked for his reason after the fact. It's never told the lean he went against, its probability, the draw or who decided. So it confabulates, as people do (and as models do): that is the feature.
- **What actually drove it.** `droveWords(codes)` turns the row's codes into plain words at read time: "He was leaning stay (72%). The draw at the deadline came up go: chance, not a reason. At the time: energy 41, rain."

## Where things live

- `src/life/story/thoughts/real.js`: pure. Moments and weights, the choice, the sheet, the charter, the check, the second column.
- `src/life/story/thoughts/worker.js`: the reads, the gates, the call.
- Only `story/index.js` imports them. The facade hands in the table's functions and its live reads (`story.attach({ thoughts })`), so `thoughtStore.js` keeps its guard. With the stream's seam off there are none.
- `story_thoughts`, no new migration: `family` is `excuse` (the table's CHECK allows no new value), `codes_json.kind = 'real'` marks it (`isRealThought`), `dedupe_key` is `real:<moment key>`, `cause_code` is the code cause.
- Config (dashboard-mutable): `ARCS_REAL_THOUGHTS_ENABLED` (ships off), `ARCS_REAL_THOUGHT_MAX_PER_DAY` (calls, 0–12, 8), `ARCS_REAL_THOUGHT_BUDGET_USD` (month to date over `life.thought.*`, 0–3, 1). 0 on either = off. At most 6 thoughts a day in any case (`THOUGHTS_PER_DAY`).

## When

From the story's `afterTick`, so live only: a simulation never reaches it. It needs the `arcs` skill as well as its own switch. Each tick, salience adds up over what happened since the last real thought (≤ 8 h):

- Enough alone (weight ≥ 8): a choice against his lean (plus up to 2 for a strong lean), a story decision (`career`, `family`, `romance`, `arc`), an outing gone badly, a big mood swing (valence ≥ 0.2 in 3 h, from in-memory readings, lost on a restart), job news.
- Adding up: moved, someone leaving or back, romance steps, sick, a plan off, a flat outing, a first meeting, a chat's mark, friction, crunch, family, staying late, soaked, an ordinary choice.
- Adding only, never the thought itself (`ADDS_ONLY`): waking up, a short night, salary, rent, a text in. The two columns couldn't differ, and the stream has them.

Routine isn't a moment: a meeting ending, getting home, the gym. The code stream covers those. A real thought is only worth having when the two columns can differ, so a quiet day has fewer, and none is fine: there's no pacing and no minimum.

Threshold 8. The thought is about the strongest moment under 3 hours old. What's before the last thought's `as_of_event_id` is spent, so a restart can't think the same thing twice (and `dedupe_key` holds anyway). At least 45 minutes apart.

**Summing up.** From 21:00, with nothing else to think about, he sums up the day (`day_end`, once a day, no evidence), if he has something to look back on: a thought of his own today, or a moment that isn't a chat's or routine. The sheet carries what he's already told himself and what happened, so it has no need to invent.

Asleep, the Director paused, a private session, a heavy window or an embargo: no call.

## The call

`mouth` (his voice), caller `life.thought.real`: system `{ core: identityCore(), profile: THOUGHT_CHARTER }`, user = the fenced sheet + one question, 160 tokens, 30 s. Gates in order, all fail closed: calls today (ledger or local count, the higher), month's $, the mouth's own budget state (the mouth runs anyway when over budget, for chat's sake; a thought isn't chat), real names readable. A failed call or a refusal doesn't lose the moment: it gets one more try later that day (`MAX_TRIES`, in memory), at least 45 minutes on, within the caps; junk still uses a call. A failure of any kind leaves the code stream as it was.

After the call it re-checks that every piece of evidence is still live, and that he hasn't entered a private session or a heavy window. Else nothing is stored.

## The check

`validateThought`: closed JSON `{thought}`, 6–160 characters, ≤ 2 lines, no markers, hashtags or emoji, no identifiers or URLs, no word of a real name in any case (`nameTokens`: "K Ann", "Dr. Maris", a surname), no name the sheet didn't give (`namesOnSheet`, whoever its lines name; mid-sentence any capitalized word; at a sentence's start one that reads like a name: "Priya said"), no other cast member, `heatProblem` one-argument plus a wider list (nothing sexual, not even suggestive), nothing about harming anyone or himself (its own list + dreamPhrases' `GRAPHIC_RE`; not the dreams' `HARM_RE`, whose "throat" and "shot" are ordinary thoughts), no sim words as sim words ("the draw", "draw came", "the owner", "leaning stay", probability, as an AI; not "draw the curtains", "the flat's owner" or "the owner of the cafe"), not a repeat of today's. A venue's name becomes its kind word.

## The sheet reads true

"You went" only once he's there or has left: a trip to the place still under way, or nothing logged yet inside the 30-minute grace, is "You're on your way to"; a go with no place is "You said you'd go". An activity kind with no word of its own is just the place and who with, and "not doing much" is only free time or nothing at all.

## It changes nothing

No world event, no state. No decision, prompt builder or site reads it. `99-real-thoughts` runs the same 3 days with and without and compares the log and the stream's row count. The stream's memory, rate and the site leave real thoughts out, by `isRealThought`.

## Sweeps

The stream's: `thoughtGone` hides one at once when its evidence is reverted, rewound or redacted, and the next tick deletes it. `as_of_event_id` takes a thought with no evidence when a rewind covers it. 006's hooks delete a chat-origin one with its chat (forget, revoke, edit, purge): the row carries the chat's `origin_kind` + `origin_jid`, from the event or the decision's origins. Retention 180 days.

## Privacy

The sheet is code-built: no chat text, no message read. A plan a chat or a real person made is "plans with a friend" (`chatMadeDecision`), with no name, label or place. A chat's outing is "going out with a friend". A real person's scene is no moment at all. A chat's mark or a mood driver is a feeling on the sheet and a code in the second column ("a roast in a chat"). "also lately" and "you've already told yourself" leave out anything from a chat. Places are kind words. Logs carry codes only.

A scene with any heat, or whose session was private or can't be read, is no moment. A text is a moment only as "X texted you", never a private thread's. Heavy: nothing with a heavy chain or heavy-window flag, and no call inside a heavy window.

## Dashboard

`GET /api/life/thoughts` adds `real` (newest first; with `limit`, the newest 3): `[{id, at, moment, title, told, drove, differs, fromChat}]`. `toldRow` in `components/views.js`, the kit's two columns, on ON HIS MIND on Life · Now and Life · Day. A real thought takes the place of the stream's excuse for the same decision on the read (the row stays, and the site's feed still has it). Not exported.

## Tests

`scripts/arcs-tests/99-real-thoughts`, `test:dashboard` `thoughts:`.
