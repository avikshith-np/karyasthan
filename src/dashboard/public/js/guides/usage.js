// Guide: Usage (pages/usage.js). Plain data, see components/guide.js.
export default {
  title: 'Usage',
  intro: [
    'Usage is the bill: every model call he makes (replies, background learning, the mind, quick decisions, transcription, images, voice) is written to a log with its role, model, tokens, cost and outcome. Never the chat text. This page shows that log and where each budget stands.',
    'Budgets are per calendar month in his timezone. Each role can have its own (the *_BUDGET_USD settings, 0 = no cap), plus one global cap over everything (LLM_MONTHLY_BUDGET_USD). The page is read-only and refreshes on its own shortly after new calls are recorded; budgets are set on the Settings page or in .env.',
  ],
  sections: [
    {
      id: 'kpis',
      title: 'Header and tiles',
      items: [
        ['MONTH / SPENT · THIS MONTH', 'Total spend since the 1st of this month, against the global cap. The tile turns red when the cap is reached.'],
        ['GLOBAL CAP', 'LLM_MONTHLY_BUDGET_USD, or NONE.'],
        ['WINDOW', 'How many days the call counts and the per-day table cover (7, 30, 90 or 180). The month figures are not affected by it.'],
        ['CALLS · WINDOW', 'Calls in the window, with their cost and input/output tokens.'],
        ['FELL BACK', 'Calls answered by a role\'s fallback model, because the primary failed, refused, or was over budget. Many of these usually mean a provider outage or a missing key: his replies still come, but from a different model, which can change how he sounds.'],
        ['FAILED', 'Calls that got no answer, including calls blocked by a budget or a missing API key.'],
      ],
    },
    {
      id: 'budgets',
      title: 'Month to date · per role',
      where: 'MONTH TO DATE · PER ROLE panel',
      text: ['One row per role and metered label, biggest spender first, the global cap last.'],
      items: [
        ['mouth', 'His chat replies (also web lookups, relay text, Instagram captions and chat).'],
        ['clerk', 'Background work: learning from chats, summaries, voice descriptors for imitation.'],
        ['mind', 'The mind\'s thinking, sleeping and self-model, and the one-time world seed of the life simulation.'],
        ['fun', 'Shadow-only experiments. Never sent to a chat.'],
        ['gate', 'The quality gate that scores replies before they go out.'],
        ['jev', 'Quick typed decisions (Instagram judging, relay checks, the pre-filter, life decisions, mind glances).'],
        ['senses / image / voice / bill / probe', 'Budget-only labels: transcribing and describing media, generating images, text-to-speech, bill-split reading, and dashboard test probes.'],
        ['STATE', 'ok (under its budget), over (budget reached), no cap (budget 0). The pill only compares the role with its own budget; the global cap can still stop it.'],
      ],
      tips: ['What "over" does: mouth and senses never stop. They switch to their fallback model and, if that fails too, use the primary anyway, so chats keep getting answers. Every other role skips its work until the next month: no batch learning, no mind runs, no Jev decisions. The features that rely on them carry on without them (a skipped pre-filter check means the reply is written as usual) or stay off.'],
    },
    {
      id: 'prefilter',
      title: 'Jev pre-filter',
      where: 'JEV PRE-FILTER panel',
      text: [
        'The pre-filter is a cheap check before he writes a group reply: Jev reads the last few lines and estimates how likely he is to actually reply. It never runs for mentions, DMs, imitation, image requests, invitation follow-ups or a catch-up reply after an hourly cap. In shadow mode it only records its guess next to what the reply model really did. In enforce mode, a guess under SKIP BELOW skips writing the reply and saves the cost. Any Jev error, timeout or budget stop means the reply is written as usual.',
        'This panel compares the shadow guesses with reality over the most recent judged turns.',
      ],
      items: [
        ['ON / OFF · MODE', 'ON when the jev-prefilter skill is enabled (Skills page). Mode is shadow or enforce.'],
        ['TURNS JUDGED', 'Turns with both a guess and an outcome, out of the target sample (300 by default).'],
        ['SKIP BELOW', 'The probability under which enforce mode would skip (JEV_PREFILTER_SKIP_BELOW).'],
        ['LLM SKIPPED / CAUGHT BY JEV', 'How often the reply model chose to stay silent, and how many of those Jev predicted. Needs at least 90%.'],
        ['LLM REPLIED / FALSE SKIPS', 'How often the model did reply, and how many of those Jev would have wrongly skipped. Must stay at or below 5%.'],
        ['VERDICT', 'COLLECTING until the sample is full, then RECOMMEND ENFORCE when both thresholds are met, else NOT YET.'],
      ],
      tips: ['To switch: set prefilter.mode to enforce on the Settings page (in memory until you persist it) with the jev-prefilter skill on. Only do it after RECOMMEND ENFORCE: a false skip means he silently ignores a message he would have answered.'],
    },
    {
      id: 'unpriced',
      title: 'Unpriced models',
      where: 'UNPRICED MODELS panel',
      text: [
        'Models that ran in the window without a known price. Cost comes from the provider\'s own report when it gives one, else from the price table (data/llm-prices.json over the shipped example). With neither, tokens are counted but the cost is $0, so these calls do not count against any budget.',
      ],
      tips: ['Add a price for any model listed here, or budgets undercount. The mind refuses to run on an unpriced model.'],
    },
    {
      id: 'days',
      title: 'Per role · per day',
      where: 'PER ROLE · PER DAY panel',
      text: ['One row per day (in his timezone) and role, newest first. The log keeps 180 days.'],
      items: [
        ['CALLS / IN / OUT', 'Calls and input/output tokens.'],
        ['CACHE R / CACHE W', 'Prompt-cache tokens read and written. Reads are much cheaper than fresh input; a high read share means the stable part of his prompt is being reused.'],
        ['COST', 'Priced cost in USD.'],
        ['FELL BACK / FAILED / UNPRICED', 'As in the tiles above, per day and role.'],
      ],
    },
  ],
};
