# Phrase banks (plan 020 H2)

Thoughts, live lines and dream fragments are written by code from fixed English lines. A bank says how HE would say each one, in his persona's voice and language mix, with no model call at run time. It is written offline, on the owner's command, and does nothing until the switch is on.

## Files

- `src/life/phraseCheck.js` — pure: the slots, every check on a line and on a bank, choosing a variant.
- `src/life/phraseBank.js` — run time: `loadPhraseBank`, `voiceLine`, `phraseBankView`.
- `src/life/phraseGen.js` — the generator's logic, model calls injected. `scripts/gen-phrases.js` is the command.
- `src/life/dreamPhrases.js` — the dream fragments and refusal lists (moved from `story/dreams/plan.js` so non-story code can read them).
- `src/personality/phrases.json` — the bank: gitignored, per install. `phrases.example.json` — committed, today's English; a test pins it to the code (`node scripts/gen-phrases.js --example` after changing a line).
- Switch: `life.phraseBanks` (`LIFE_PHRASE_BANKS`, default false), dashboard-mutable, takes effect at once.
- Dashboard: `#life/phrases` (page `life-phrases.js`), `GET /api/life/phrases?bank=&q=&only=&offset=&limit=`. Read only.

## How a line gets its words

The caller draws and remembers the English line exactly as before; `voiceLine(bank, english, state, seed)` swaps the words on the way out.

- **Off or nothing for that line → the English.** Byte for byte: the goldens never see a bank.
- **The repeat memory stays keyed on the English.** `story_thoughts.phrase_key`, the live session's `memory`, `story_dreams.phrase_key` (`tone:i`) don't change, so turning the switch on or off, or writing a new bank, neither resets what he has said lately nor lets a line come back early.
- **No random draw is spent.** A variant is chosen by its own hash of a seed (tick + line; session + step + line), so what he thinks and when is the same with a bank or without. A live line re-reads the same at a given moment.
- **State:** a variant may carry `mood` (low/ok/high), `time` (morning/day/evening/night) and `activity` (`contextOf` for thoughts, `placeClass` for live; dreams none). A tag that doesn't fit rules it out; one that fits weighs for it. So the family × activity × mood × time grid is written only where it means something, not as a cross product of 30,000 slots.
- **The running bank loads at boot only.** Nothing is voiced until life's boot has loaded it against today's names, and a new file reaches him at the next restart. Real names or venue names that can't be read at boot mean no bank at all: English lines, an `evt:'issue'` naming the read, and the next restart retries. `#life/phrases` / `GET /api/life/phrases` read and check the file on disk to show it side by side, and never change what he says: the view reports `running` and `disk` apart, plus `restartNeeded`. The switch itself takes effect at once, on the running bank.
- A thought's `codes.bank` records the version it came from. Stored thoughts and dreams keep their words when the switch goes off.

Stay English, never banked: a private session's words, a heavy stretch (`WORDLESS.heavy`, and `tickThoughts` asks no bank while heavy), "plans with a friend", and the topic words (`TOPIC_WORDS`, read by the scene's fact sheet; the form around them is voiced). The dream's `{task}` / `{twist}` are English and the prompt says so.

## The file

Closed shape: `{ v: 1, version, generatedAt, model, catalogue, partial?, banks: { thought|live|dream: { "<English line>": [ { t, mood?, time?, activity? } ] } } }`.

- Missing → the example. Corrupted, too big or a wrong shape → the example, a codes-only `evt:'issue'`, and the reason on the page.
- What the generator writes is what passed, caps included, so the file is what runs and a boot drops nothing more (unless a real name has joined since).
- A bad line loses only itself; a slot left with nothing stays English; a line the code no longer has is counted `stale`. A partial bank is fine. `catalogue` is a hash of the English: a difference only warns.

## Checks on a line (`lineProblem`)

At generation and again at every boot, so a hand edit or a real name that has joined since is caught. The English line itself always passes.

Placeholders exactly the English line's (unknown, lost, added, stray brace); no markup, markers or speech tags (a dream fragment reaches prompts); no digits or `@`; the site's scrubber (JIDs, phones, URLs, real names); desire's `contentProblem` and the dream's sexual and graphic lists (a word the English itself uses plainly, "throat", is allowed, that word only, not the rest of its list); real names (every word of the name, `nameTokens`, so "K Ann", "Dr. Maris" and a surname count), cast names, his own names, venue names, region and language words whole and in any case, since these lines are lower case; capitalized words the English doesn't have (`invented_name`; a dream's sentence may start with a capital).

**Length is measured at its worst**, because the site drops a string over its cap rather than cutting it: placeholders are counted at the longest fill (`WIDTHS`), the line must fit `SURFACE_CAP` (thought 80; live part 62, so place word + two parts ≤ 160; dream 160) or be no longer than today's English needs. Also no more than about twice the English (inner speech stays clipped) and no run over 24 characters (it could not wrap at 320 px).

Code lists can't read another language, so the generator adds a **checking pass**: a second model read of every line for what's sexual, graphic, a name, or not a line at all. If it fails in any way, nothing is written. Region words are refused because the site's filter would silently drop the row.

## The fixation guard (`capFixation`)

The owner's rule: he overuses words. Across a bank (not per slot: "rain" in every rain line is right), no word above a share of the bank's entries: ≤ 2 letters 8 %, 3–4 letters 6 %, 5 letters 3 %, longer 1.5 % (short words are grammar in any language; long ones are what he goes on about). A word the English lines lean on keeps its share. One emoji ≤ 3 in a bank, all emoji ≤ 1 %. The same words for more than 3 different lines: no. Entries go from the fullest slots first, so a slot empties last. `--ban a,b` refuses those words outright; `selfOverusedWords` (long words in ≥ 3 % of his last 400 messages, read inside `src/memory`) get a much lower cap. Those are real-chat words: they stay in code and never go to the model. `postProcess`'s fixated-word stripping is per chat at reply time and doesn't see these lines, so this is the guard here.

A bank that reads as one language (`one_language_english`, `one_language_other`) gets a warning, never a refusal: only the owner knows if that is how he talks. `topWords` lists what it leans on.

## Running it

```bash
node scripts/gen-phrases.js                        # dry: no model call, the cost estimate
node scripts/gen-phrases.js --write --max-usd 4    # about 16 mind calls + a checking pass, about $2.50, writes the file (inert)
node scripts/gen-phrases.js --compare --bank thought --limit 40    # or #life/phrases
# Then restart, and Settings → life.phraseBanks. Refresh monthly; a line changed in code stays English until then.
```

Role `mind`, caller `life.phrases.gen`, no fallback (a fallen-back call isn't his voice: its lines are dropped), `--effort` default medium. A cut-off answer is asked again in two halves, once. Hard cap: month to date over `life.phrases.*` + the next call at the most it can use (`maxTokens`, thinking included), default $4, never over $10; another script tokenizes denser than the English, so a run may cost more than the estimate and stop partial, which is safe (the rest stays English; `--only` or another run fills it); an unpriced model or an unreadable ledger spends nothing. The mind role's own budget applies too and this spend counts towards it, so a run late in a tight month can stop the mind's think early. `--only thought,live,dream` keeps the other banks of the current file; a failed checking pass keeps `data/phrases/draft.json` and `--from-draft` resumes without paying for the lines again. `--stub --out <path>` runs it all with a stand-in model (no key, no ledger).

In: identity + persona + the English lines. Never a chat, a real name or anyone else's word.

## Tests

`scripts/life-tests/76-phrase-banks.test.js` (no key, no network): `test:dashboard` `phrases:` block for the route and the page.
