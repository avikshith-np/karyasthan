# The claim check (plan 020 E3)

What a writer said, against the sheet it wrote from. Research: judging a whole story fails; splitting it into atomic claims and checking each against a grounding doc works (about 0.7–0.8 balanced accuracy); self-critique without the reference doesn't. Keep this file current when the feature changes.

## Where things live

- `src/life/story/check/`, imported only by `story/index.js`. The writers get `checkWorker.seam` through `configure()` and never import it.
  - `timeWords.js`, pure: the code pass.
  - `grounding.js`, pure: a sheet → numbered true lines + dated rows.
  - `charter.js`: the clerk's prompt, the user message, `validateClaims`, the rewrite note.
  - `worker.js`: mode, gates, `enforce`, `submit`, `processPending`, `sweep`, `view`.
  - `store.js`: the only SQL on `story_check_runs` / `story_check_claims` (migration v20).
- Hooks: `scenes/worker.js runScene`, `phone/worker.js runTurn` + `regenerate` (`submitCheck`), `journal.js runJournal`.
- `story.claimChecksView` → `GET /api/arcs/claim-checks?days=` → `#claim-check` under Control.

## What it does

1. **Code first.** `timeWordFindings`: a time word (last night, tonight, yesterday, this morning / afternoon / evening) maps to the `relWhen` heads inside its interval, so "tonight" means what the sheet's own lines would call tonight. A verdict needs all of: one time word in the sentence, past tense (never a question, a suggestion or a negation), something near it the sheet has dated (a meal, coffee, a film, drinks, a walk, the gym, or a person just seen), a past row about that thing, and no row about it, a plan to come included, in the interval. Generic food words match any meal; two named meals (lunch, dinner) that differ don't match. A daypart's edge is about an hour wide (17:30 may be "this afternoon"). Company the sheet doesn't list (the team, the office, everyone) gets no verdict, nor a she or he whose only shared word is a bare "with" or "they" ("the coffee she had"), unless it's with someone the sheet names. A solo sentence says nothing (the sheet lists time with people, not his meals alone), nor someone else's evening. In the small hours today's evening also counts as "last night" and "yesterday". `leftFindings`: "they left together" when the sheet's afterwards says on his own; not a ride to somewhere, things he took home, a wish, what he could have done or another night.
2. **One clerk call.** Role `clerk`, caller `life.check.claims`, temperature 0, ≤ 500 tokens, 30 s: the numbered sheet and the output, both fenced, the output cut at 2400 characters. ≤ 8 claims about who / where / when / left / money / plan, each supported / contradicted / unknown against the sheet only. A contradiction must cite a line number; without a real one it is stored as unknown (`uncited`). Anything off the shape is dropped; nothing usable → `junk`, no verdict.
3. **Store.** Run + verdicts. The sheet lines are stored only until the check has run, then NULLed. A claim whose words carry an identifier, a real name or anything explicit keeps its verdict with no words; names unreadable → no words.

## Modes

- **Off** `ARCS_CLAIM_CHECK_ENABLED=false`.
- **Shadow** (the default): after commit, on its own chain (`checkChain`) so a call never holds up a text or a scene. It changes nothing, appends no world event, costs at most one small call per output.
- **Enforce** `ARCS_CLAIM_CHECK_ENFORCE=true`: the writer checks before commit (that verdict is what gets stored: no second call). A contradiction → one rewrite naming it, on the same tier and caller, → checked again (so up to two checks) → still contradicted: the writer's own fallback. Scene: next tier, then the code one-liner; a failed regenerate keeps the old version. Text: no message (`contradicted`). Journal: the part is dropped, the night partial. A check that couldn't run lets the output through.
  - **Precondition on plans**: under enforce a plan verdict is acted on only when the cited sheet line names a plan at a time (`worker.enforceActsOn`: `his plans: … HH:MM`, `planned next with them: …`, a journal's `planned:` / `promised:` bullet), never on `his plans: none set`. The clerk can't see the thread, and at enforce time a plan this very text agrees to isn't on the sheet yet (`planFromTexts` needs the committed row), so "no plan" proves nothing. The verdict is still stored, so the panel keeps measuring it. Shadow's `submitCheck` reads his plans after the plan step, enforce's before: don't read shadow's plan rate as enforce's. Check this before flipping the flag.

## Gates (fail closed: no call, no verdict, the output goes on)

`ARCS_CLAIM_CHECK_MAX_PER_DAY` (150; 0 = code only) and `ARCS_CLAIM_CHECK_BUDGET_USD` (0.5, month to date), both over `life.check.claims` by a strict ledger read, never under `life.scene.`, `life.phone.` or `life.arcs.`. Unreadable ledger → `ledger`. The clerk role's own budget stop → `budget`. **Unpriced closes the gate** (`unpriced`, `worker.realPricing`): 007 counts an unpriced call as $0, so the $ cap would do nothing. That's when the clerk's route has no price (OpenRouter reports its own; anything else needs a table row), or a call this month came back with none and the table still has no row. A local provider (`local`, `ollama`) is excepted: no bill to cap, the day cap holds, and the panel says LOCAL MODEL; unpriced reads NO PRICE. The code pass runs regardless, past the age limit too. Reasons show on the page: `no_sheet`, `cap`, `budget`, `ledger`, `call_failed`, `junk`, `too_long` (over 20 000 characters: nothing runs), `too_old` (queued over 6 h, downtime isn't caught up on).

## Privacy and the explicit register

- The clerk sees a code-built sheet and an output that was already written from it. **Never the thread**: "against the fact sheet only", and a thread may hold explicit lines. So something agreed earlier in a chat reads as unknown.
- **Explicit outputs never reach the clerk**: `register === 'explicit'` skips at every writer, `submit` refuses `contentProblem(text)` and tone `naughty`, grounding drops a line `contentProblem` flags. `desire.js` is imported read-only; The desire role's path is unchanged.
- An output from a chat's plan (a scene not in `full` mode, a journal chat part) keeps verdicts and codes; `claim` and `evidence` are NULL, and the panel shows no excerpt. So a purge has nothing to find in a closed run; a run still queued holds the part's code-built bullets (labels, no chat words) until the next sweep, at most an hour, also with the check off.
- Not checked: the owner's own words, `gistFallback`'s code line, code one-liners, a real person's scene (no model wrote them).

## Sweep

`sweep()`: a run whose output left the log (scene not live or its event gone, text not live, part not active) or whose words changed (sha mismatch: an owner edit, a rewrite, a rebuilt journal part) is deleted with its verdicts. A pass reads the newest 1000 runs and the next 1000 of a walk through the older ones, so every run within retention (90 days) is reached in a few passes. It runs through `sweepChecksIfChanged` (the facade's memo: the projection's exclusions changed, an owner edit, or an hour since), from the job and from a panel read; with the check off the job still sweeps. The panel read itself never sweeps a full table on every poll: `view()` doesn't sweep, and it leaves out of the last contradictions any whose output has gone or changed, so counts can lag by up to an hour, the list can't.

## What it can't do

- **The clerk's judgement can't be tested offline.** The offline test proves the pipeline and the code pass; `node scripts/arcs-tests/99-claim-check.test.js --live` runs the replay set on the real clerk (paid; needs a key) and prints both directions.
- **His mixed speech**: the code pass knows English time words only (no persona's language is written into the code), so a line in another language gets no code verdict. That's a miss, not a false alarm, and the clerk reads it. Whether the clerk calls his speech wrong is what shadow is for: Texts · his is its own row.
- **Plans** are the likeliest false alarm: the clerk can't see the thread, so "see you at 8" after an agreement it can't see could read as a plan out of nowhere. `submitCheck` runs after `planFromTexts` with his plans as they stand, so a plan this text agreed is on the sheet.
- **Scene sheets** say nothing of what's new in the scene; the charter says that's unknown. Money is on journal bullets only.

## Tests

`scripts/arcs-tests/99-claim-check.test.js` (replay set from live incidents + should-pass cases, each edge case in the brief, through the real scene, text and journal paths), `21-guards` (imports, SQL, logging), `test:dashboard` `claim:`.

## The real clerk (measured 2026-11-02, `-- --live`, gemini-3.8-flash, 37 replay cases)

First run with the network truly open (`blockNetwork` used to stop `--live`, so every answer read `junk`): caught 6 of 7, 11 false alarms of 30. After the charter's "same event" rule and its examples: caught 7 of 7, 5 false alarms of 30, balanced accuracy 0.92. So about one clean output in six still gets a contradiction: shadow numbers run high, and enforce stays off until the live panel says otherwise. One of the five (`see you at 7`, plan at 20:00) reads as a true catch and a loose fixture. Each run is about 37 clerk calls, a few cents.
