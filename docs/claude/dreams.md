# Dreams (plan 020 G)

What he remembers of a night, about one to three times a week. Most nights he remembers nothing, and then nothing is written.

## Where things live

- `src/life/story/dreams/plan.js`: pure. REM periods, recall, tone, residue, the plan, phrase tables, the template, the word check, the charter.
- `dreams/worker.js`: the wake (`atDream`), the words (`processWords`), the reads (`dreamLine`, `dreamsView`).
- `dreams/store.js`: `story_dreams` (migration v18). Only `story/index.js` imports the dreams.
- The pulse calls `deps.atDream` in `wakeUp` and `nightWake`, with the sleep read from before the `woke`. Only the live attach passes it, so a sim has no dreams.

## The wake

In order, any of these means no dream: switched off, no sleep (or the first night), under 90 minutes (a doze), a sleep that started in the daytime (a nap), a wake more than 2 hours old (downtime replayed: nothing back-dated), one already within 12 hours (a broken night gets one), a sleep a chat shaped, a heavy stretch, embargo or heavy window.

Then: residue of the 36 hours before sleep, a tone (nightmares rise with stress, 2 to 15%), REM periods (cycles of 80 to 110 min, REM growing toward morning, more after 4 h of sleep debt), recall (`vivid` only when he woke inside REM, a fragment less often, rarely away from it; a nightmare stays with him more). Probabilities are tuned on a 30-night run.

Remembered: a plan of 2 or 3 scenes. Scene one is the day's strongest thing, so it's grounded in that day. Then sometimes something from 5 to 7 days back or further, whoever the day moved, the rest of the day. Each scene has a place word, maybe a first name, one twist. No one twice, not all in one room, and the last 7 dreams' places and people are avoided when there's a choice. Then `dream.had`, caused by the night's `sleep.started` (or by the owner's wake that broke the night, so undoing that wake undoes the dream), engine, codes only.

## Words

- A fragment comes from a phrase table per tone, with no recently used phrase.
- A vivid one gets a template at once, then one `clerk` call, caller `life.dream`, from `dreamsJob` after a tick: at most one a night, under `ARCS_DREAM_BUDGET_USD` (month to date), ledger unreadable fails closed. Any failure keeps the template.
- `wordsProblem` refuses: anything sexual or suggestive and anyone hurt (`SEXUAL_RE`, `HARM_RE`, dream-only, on top of the desire check `contentProblem`; desire.js is untouched), identifiers, a real person's name, a name it wasn't given, also at the start of a sentence. The explicit register has no path here. A nightmare is fear and no way out, never harm.
- Place words are kind words, never a venue's name. Names are fictional first names of people still in his life.

## Privacy

Only live events of his own or the owner's origin, with no real person, no heavy flag or heavy cause, and none from around a heavy stretch. No chat and no message reads in the module. So there's no origin to keep. It stays out of groups for how it would read, not for privacy. In a heavy window he remembers none, and a dream from just before a stretch stays out of his replies once it starts.

## What it does

- **Mood:** a nightmare −0.05 valence and +3 stress, a bad dream −0.02 and +1, a good one +0.03, a neutral one nothing, as a view overlay (`dreamOverlay` in `projector.js`) fading to zero at midday, or two hours after a late wake. Nothing of it integrates into his vitals. Story-family decisions leave it out, as they do chat mood.
- **Overnight softening is dropped.** There's no single "sting" value to soften without inventing one, and a nudge to relationship metrics would be a lasting world change from something he half remembers.
- **Echoes:** a row on Life · Day at his wake, a line in the journal, a per-turn line in replies until about 14:00, in DMs only, the first turn or two of each, until he has mentioned a dream once that day, never in a group; `dreamt` on his side of the phone sheet for a close, spark or romance bond in a warm or neutral dream, his first text of that thread that day (8 hours, never on an explicit sheet); Mind page panel 9.

## Undo

`dream.had` is not on the revertible list: a dream is what he remembers of a night, not something he did. It goes with a revert of its `sleep.started` or a rewind; the fold and the sweep already handle an exclusion, so adding it would be one line and a test.

A revert or a rewind excludes the event: the fold forgets `story.dream` (mood and line go), and the sweep in `dreamsJob` NULLs the words and plan. Rows are pruned after 180 days.

## Tests

`scripts/arcs-tests/99-dreams` (rules, the wake's stops, owner wake, words and budget, mood, echoes, heavy, rewind, downtime, departed, sim, guards, 30 nights).
