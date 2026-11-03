# Prompt caching (plan 020 H3)

What caches on which provider, what was measured, and what to change if the routing changes. Keep this file current when providers or prompts change.

## How each provider caches

- **Gemini 3.8 Flash** (`gemini` adapter; chat uses the OpenAI-compatible endpoint `/v1beta/chat/completions`): implicit prefix caching, automatic. Google lists a minimum of **4,096 input tokens** for this model (2.5 models: 2,048). Native `generateContent` reports `usageMetadata.cachedContentTokenCount` (`src/brain/geminiMedia.js` reads it). What the compat endpoint reports is **not documented**; a forum report says `cached_tokens` is missing there.
- **OpenRouter**: `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`, documented; `usage.cost` is what the ledger uses and is already net of the discount. The adapter sends a plain system string, so an Anthropic model reached through OpenRouter gets no explicit breakpoint.
- **xAI direct** (`xai` adapter): `usage.prompt_tokens_details.cached_tokens` is a part of `prompt_tokens`; a read costs a quarter of input on grok-4.7, no write charge is listed, and `usage.cost_in_usd_ticks` is what the ledger uses. xAI's troubleshooting note asks for `x-grok-conv-id` or `prompt_cache_key` when `cached_tokens` stays 0; the adapter sends neither. Not tried against the real API yet.
- **Anthropic** (`anthropic` adapter): every system block carries a 5-minute marker. Opus 5.5 minimum 512 tokens; a read costs 0.05× input, a 5-minute write 1.25×, a 1-hour write 2×.

## What was measured (2026-11-02, a copy of the real data)

- **The mouth is under Gemini's minimum:** core ≈ 1,790 + profile ≈ 221 ≈ 2,011 tokens on the busiest group. Clerk and gate prompts are far smaller. So the empty `cache_read_tokens` on the 401 Gemini rows needs no recording fix to explain it, and about $1–2 a month is all that was ever at stake. Whether the compat endpoint would report a hit is still unverified; it only matters if the prefix grows past the minimum.
- **Director wishes are mostly isolated:** the 12 most recent span 3 days, with two short clusters.

## What the code does

- `system` is `{ core, profile }`: core (identity, self-model, capability manuals) first, byte-stable across turns, the same in DMs and groups. Per-turn text (recall, life lines, transcript) is the user message.
- **Imitating**: per-turn exemplars sit at the head of the prefix, so nothing can be read back; `buildSystemParts` adds `volatile: true` and the Anthropic adapter sends no marker. A normal turn's core is untouched.
- **Recording**: `cacheRead` NULL = the provider didn't report it, 0 = it reported none. `output` adds any `total_tokens` above prompt + completion (reasoning billed as output).

## If the routing changes

Tried and removed on 2026-11-02 (owner's rule: no feature gets worse for no gain). Do these if the case changes:

- **If the mouth moves to Anthropic: fix the group profile's order first.** `getActivePeopleInGroup` is `ORDER BY last_seen DESC`, so the people block reorders whenever someone else speaks; nickname (`use_count`) and slang (`use_count`) order can move too. On Anthropic each of those is a 1.25× write of the profile block, every turn. Keep who is listed, write them in a fixed order (jid, or `first_seen` so the order still means something). It changes what the model reads (active people are no longer first), so it needs the owner's review.
- **If Director wishes start clustering 5–60 minutes apart: a 1-hour TTL on the charter.** Charter ≈ 3,200 tokens: a 5-minute marker costs about $0.016 per write, a 1-hour one about $0.026 for the first write and $0.0006 per read. It wins from two wishes in an hour and loses about $0.01 on an isolated wish. Needs `ttl: '1h'` on every block (a 1-hour entry may not follow a 5-minute one) and pricing `usage.cache_creation.ephemeral_1h_input_tokens` at 2× input.
- **If the mouth's prefix passes 4,096 tokens on Gemini:** check what the compat endpoint reports, with a repeated long prefix against native `generateContent` as the control. If it hides the count, the ledger overstates Gemini spend and chat needs a native adapter, run side by side first.

## Not done, on purpose

- **The Director's catalogue is not cached:** its stable part needs a breakpoint inside the user message and is worth under a cent a call by estimate, and its cast block changes with what gets applied between wishes.
- **No padding to reach Gemini's minimum, no explicit `cachedContents`** (same minimum, plus a storage fee).
- **Batch API for the nightly jobs:** at most about $1.20 a month by estimate, for a persisted job queue, a late-result path and a privacy re-check of everything deleted while waiting. Revisit above about $10 a month of nightly spend.

## Tests

`test:roles`, section H3: a refusal fallback inside the call is priced at the served model; a chain fallback writes one row per link, same bytes, no marker; a skipped or under-minimum write is 0 written at plain input price; an unpriced model keeps tokens, cost NULL, $0 against budgets; a role switched at runtime sends the volatile system as one plain message; budgets count cached tokens at the read rate.
