# A changing mind (plan 020 B)

His interests and opinions: what he likes and what he thinks of things in his life, moving slowly from what he lived. Inert until the owner approves a starting set.

## Where things live

- `src/mind/stanceRules.js`: pure. Evidence from events, one night's step, the fold, the words.
- `src/mind/stance.js`: the flow. Seed, owner actions, nightly update, undo, what reaches him.
- `src/mind/store.js`: the SQL (`self_stance`, `self_stance_evidence`, `self_stance_history`, migration v17).
- `src/life/stanceSeam.js`: the one door into his life. Life can't import the mind, so `src/index.js` passes `stanceProvider` from the mind facade to `startLife({ stances })`. With no provider, or nothing active, readers get nothing, weights stay the same array, and no draw moves (012 goldens stay byte-equal).
- Life facade `stance*`: read-only helpers for the flow.
- Dashboard: `routes/mind.js` (`/api/mind/stances…`), Mind page panel 8, `stanceRow`.

## Topics

A string key with a namespace: `kind:<activity kind>`, a place id (`place:…`), a cast id (`cast:…`), `fixed:<work|city|food|money|weather|people>`. No home of any kind, the office, shops, groceries or errands. Interests (`kind:`, `place:`) run 0..1, opinions (`cast:`, `fixed:`) −1..1. A later `free:<slug>` fits with no migration; free topics aren't built.

## The starting set

One `mind` call, caller `mind.stance.seed`, gated by `mindBudgetOk('think')`, input identity + catalogue only. Code keeps catalogue topics only, clamps values, drops a why that names a real person or an identifier. Rows are `proposed` and nothing reads them. A budget stop writes nothing.

## The night's update

In `runSleep`, after the weekly step and before reflection (a failed reflection can't stop it, and it never changes the night's status). Code only.

- **Cursor by event id.** Everything since the last update goes under this night, so missed nights fold into one bounded step. `stance_last_night` makes a re-run a no-op.
- **A value is `base_value` folded over the evidence still attached** (`replay`), so undoing evidence recomputes it exactly: same inputs, same value, no random draws.
- **One night:** the sum of its evidence, chats capped per chat and in all, gives at most one step (0.07 interest, 0.09 opinion, × uptake; owner 2026-11-02: a great date or a bad night should show within a couple of weeks), halved when it pulls both ways, plus a small pull to the anchor. Only a strong outcome reaches a full step: exposure and chats stay small. A step away from the anchor shrinks with the room left (`REACH`: 0.3 interest, 0.5 opinion), so he changes but stays himself.
- **No evidence:** nothing for 7 nights, then only toward the anchor; an interest unused for 14 nights fades to at most 0.1 below it. It never moves away from the anchor without evidence, other than that fade.
- **Habit:** time spent on 5 of the last 7 nights counts for a quarter.
- **Evidence** is world events only, never a stance, a thought, an episode or a model's words, so a reflection can't cite a reflection. Sources: how an outing went (`scene.played`, this sets the direction), time and money (small: being there keeps it alive), going tired, choosing not to go, work (`work.late`, `work.crunch`, appraisal), weather, meals, and chat codes (`chat.perceived` affect, `invite.answered`).
- **Heavy:** an event flagged heavy, one with heavy in its cause chain, a heavy-window scene, or anything during a heavy stretch or embargo teaches nothing.
- **Window:** evidence older than 60 nights folds into the base. What it did stays; what caused it is let go, and it can't be undone after that.
- **Pinned:** no evidence collected, value held exactly. Unpinning picks up from there.
- **Someone who left, a place gone:** `archived`, not rendered, not moving. Back in his life: `active`, from where it was.
- **New topics** from experience are created by code at neutral, so they say and do nothing at first. A kind outside the catalogue comes only from his own days, since a chat can name a slug.

## Undo

- Revert or rewind: `sweep()` on the mind's pulse, when `stanceExclusionSig` changes. Also while paused. Not while the mind skill is off; it runs on the next pulse after.
- Forget, revoke, edit, owner delete: `removeEvidenceFor` in `hooks.js`, inside 006's transaction. A chat's evidence from that time on goes (fails toward removing too much); an owner delete takes a free topic's citation only through the memory it names.
- Purge: by origin and by subject. Errors propagate and roll the purge back.
- A merge rekeys evidence; a reassign deletes that DM's evidence and recomputes.
- With a pin, the evidence row goes but the value holds: the owner held it.

## What it drives

Only with the mind on, not paused and not degraded (like the knobs), and only for `active` rows.

- `decisions.utilities`: a capped bump (±0.6) on go / late / attend. `jevState` gains `interest` and `place_liking`, only when he has a view.
- Leisure picks (`routine.planDay`, `pulse.eveningProposal`): weights × at most 2, at least 0.25.
- Reply tail (`lifeStateLines` → `stance`): at most one line a turn, per-turn only, and only when someone else's newest lines or the trigger raise that topic (`raises`), never on his own lines, once per topic per chat per hour (a DM's @lid and @s.whatsapp.net forms are one chat: `cooldownChat`, the raw key if the resolver fails). The everyday `fixed:` topics count only with you or your on the topic (`askedAbout`: "how's your work", "do you like the weather", "are you sick of work"; not "how's work", "how is the weather in X" or a bare "sick of work"). A kind needs an entry in `KIND_TERMS`, a place a name that isn't just its kind, a cast name that is no word of any real person's name or nickname (`nameTokens`: accents, emoji and punctuation off, 3+ letters, so "K Ann" and "Dr. Maris" count; a read failure means no line). A name that is also an everyday word (`COMMON_WORDS`: Will, Mini) counts only capitalized and inside a sentence. Held to the embargo and the self-mention budget (`lineOpen`), and to `canUseIn` for every chat with evidence on the row, at that chat's own time. Never while imitating. "Lately" is only said while it's moving on recent evidence: distance from the anchor is who he's become, not news.
- Writers' sheets (`hisViews`, rendered in `scenes/charter.js` and `phone/charter.js`; a key the renderer doesn't list never reaches the writer): scenes and his side of the phone, ≤ 3 lines, about what's in the scene or thread, only rows no chat and no real person has shaped. Not on a real person's outing, and never on an explicit sheet.
- A row shaped by a real person's outing reaches a reply only where that person is (006).
- `numbers()` is held in memory until a row is written, since decisions and plans read it on every run, simulated ones too; whether the mind is active is re-read every 30 s, and at once on a pause.

A chat's mark on a value still counts for his days everywhere: only the words are held to the audience rule.

## Words and privacy

Why is code-built from codes (`whyWords`), dashboard only. Something from a chat says only that it was a chat, never what was said. Rows hold ids, codes, numbers, fictional labels. A row's label is refreshed each night (the kind word for a real venue); the dashboard reads it live. `selfOriginRows()` is for the public site's `mind` key later: no chat-shaped rows, no people.

## Free topics (the wider world)

`src/mind/stanceFree.js` (pure) + `freeTopicsNight` in `stance.js`, in the sleep step after the update. One bounded `mind` call a night, caller `mind.stance.free`, gated by `mindBudgetOk('sleep')`, only with an approved set. It reads tonight's episodes, the talking points of his outings and his texts (`stanceEncounters`: own origin, no real person, nothing heavy or near a stretch, nothing explicit), labelled E1..E12.

- **Proposals:** ≤ 2 a night, ≤ 12 live or waiting. Code decides: the label is an ordinary lower-case noun phrase, with no identifier, forbidden topic (politics, religion, anything sexual, ...), real name, venue, cast name, his own name or his region; at least one item cited; not on his list under any wording (`sameTopic`, against every row of any status, so a rejected topic isn't offered again). A start value is clamped mild. Rows are `proposed`: nothing reads them until approved.
- **Moving:** in the same call, `moved` on a live free topic, citing items, ±0.3 of evidence through the usual fold. No citation, no move; otherwise the usual decay.
- **Citations** are `source: 'cited'`, weight 0. They keep the origin (the audience rule, and the site's `mind` leaves a chat-cited topic out), so unlike other evidence they don't fold away after 60 nights: the label's words came from there.
- **Undo:** a revoke, forget or purge of a cited episode or chat, or a revert of a cited event, removes the citation. With none left the row goes, proposed, approved or rejected, words and all. On a night with chats in the batch every proposal cites all of them (the model's word for where a label came from isn't enough); lose any one and the row goes, whatever else it cites, so a forget never leaves the label behind as his own. It can come back only if he comes across it again.
- A failed or fell-back call, a budget stop, a refused reply: no rows.

## Limits

- `fixed:city` has no evidence source yet, and `fixed:money` only payday, so they rest at their anchors.
- `cast:` opinions move only from scenes.

## Tests

`scripts/mind-tests/18-stance` (seed, owner, why), `19-stance-night` (update, undo, edges), `20-stance-audience` (audience rule, sheets, public), `scripts/arcs-tests/99-stance-live` (real log: revert, rewind, seam).
