// Guide: Status (pages/status.js). Plain data, see components/guide.js.
export default {
  title: 'Status',
  intro: [
    'Status is the at-a-glance health page: is he connected to WhatsApp, how long has the process been up, is he still warming up, is any group throttled, which models answer for him and which safety switches are on.',
    'Everything here is read-only. The page reloads itself every 30 seconds. To change a value, use Settings (live config), Skills (feature switches) or .env (then restart).',
  ],
  sections: [
    {
      id: 'kpis',
      title: 'Top tiles',
      where: 'CONNECTION · UPTIME · MEMORY · WARMUP',
      items: [
        ['PERSONA / SOCKET', 'The name he goes by (from his persona file) and whether the WhatsApp socket is OPEN or CLOSED.'],
        ['CONNECTION', 'ONLINE when the WhatsApp Web session is paired and connected, with the account name. OFFLINE means he hears nothing and sends nothing until it reconnects or you re-pair (Settings has a re-pair flow).'],
        ['UPTIME', 'Time since the bot process started. A recent restart also means in-memory state was reset: burst cooldowns, live config changes you did not persist, and skill toggles back to their boot defaults.'],
        ['MEMORY · RSS', 'How much RAM the process uses. A number that only ever grows over days is worth a restart and a look at the logs.'],
        ['WARMUP', 'On a new number he ramps up slowly so WhatsApp does not flag him. Days are counted in his timezone from the first start. Days 1–3: at most 5 sends a day and reactions only (a planned text reply becomes a reaction). Days 4–7: 15 a day, text allowed. Days 8–14: 30. Days 15–21: 50. From day 22 it shows COMPLETE and nothing is throttled. When the daily limit is reached he stays silent for the rest of the day. WARMUP_ENABLED=false in .env turns it off.'],
      ],
      tips: ['TIER on the warmup tile is the current step of the schedule above (1 to 4, out of 4); the daily limit is the number after the slash.'],
    },
    {
      id: 'volume',
      title: 'Volume · 30 days',
      where: 'VOLUME · 30D panel',
      text: [
        'Messages per day over the last 30 days, across every chat: RECEIVED (grey) is what people sent, SENT (red) is what he sent. The totals for the window are in the panel head.',
        'Days are calendar days in his timezone (TIMEZONE), the same days as the daily counters.',
      ],
      tips: ['Both lines share one scale (the axis numbers), so their heights compare directly.'],
    },
    {
      id: 'cooldowns',
      title: 'Cooldowns',
      where: 'COOLDOWNS panel',
      text: [
        'A burst guard: when he has sent 3 messages in the same group within 90 seconds and wants to reply again, that group gets a 30-second cooldown. During it he skips everything in that group except direct @-mentions. Each row shows the group and the seconds left.',
        'Cooldowns live in memory only and vanish on restart. A THROTTLE pill appears in the head while any is active.',
      ],
    },
    {
      id: 'sleep',
      title: 'Sleep window',
      where: 'SLEEP WINDOW row',
      text: [
        'His configured night (SLEEP_START_HOUR to SLEEP_END_HOUR, in his timezone). With the life simulation off, this is when he is asleep.',
        'With the life skill on, his simulated day decides when he sleeps and when he looks at his phone; the Life pages show that instead.',
      ],
    },
    {
      id: 'routing',
      title: 'LLM routing',
      where: 'LLM · ROUTING panel',
      text: ['Which models answer for him right now.'],
      items: [
        ['PROVIDER / MODEL', 'The "mouth" role: the model that writes his chat replies.'],
        ['TEMP', 'Sampling temperature (LLM_TEMPERATURE). Higher = more varied wording.'],
        ['MAX_TOK', 'The longest reply the mouth may write, in tokens.'],
        ['FALLBACK', 'The mouth role\'s fallback provider/model, tried when the primary fails or is over budget; "none" when it has none. Other roles\' fallbacks are on the Settings page.'],
        ['RATE', 'The hourly caps: replies per group per hour (MAX_PER_GROUP_HOUR, direct mentions exempt) and replies across all groups per hour (MAX_GLOBAL_HOUR, mentions included). DMs never count. 0 means no cap. When a cap blocks a reply he would have sent, he may send one catch-up reply once the cap frees.'],
        ['ROLES', 'One row per model role (mouth writes replies, clerk does background summaries and learning, mind thinks, fun is shadow-only, gate checks reply quality, jev makes quick typed decisions), with its provider/model and this month\'s spend against its budget. The pill: ok (under budget), over (budget reached), no cap (budget 0), disabled (no model set), shadow (never used for real sends).'],
      ],
      tips: ['A role that is "over" changes behaviour: the mouth falls back to its fallback model and still answers; most other roles skip their work until the next month. Details on the Usage page.'],
    },
    {
      id: 'flags',
      title: 'Flags',
      where: 'FLAGS panel',
      items: [
        ['DRY_RUN', 'ON: he decides and writes replies but only logs them, nothing is sent to WhatsApp.'],
        ['READ_ONLY', 'ON: the dashboard refuses every change (DASHBOARD_READONLY). Turn it off in .env to edit things here.'],
        ['WARMUP', 'Whether the warmup schedule above applies.'],
        ['QUALITY_GATE', 'Whether each reply is scored by a second model before sending, and blocked if it reads off.'],
        ['IMAGE_GEN / VOICE_NOTE', 'Whether he may send generated images and voice notes.'],
        ['TZ', 'The timezone every time on the dashboard and his daily counters use (TIMEZONE in .env).'],
      ],
      tips: ['ON is shown in amber on purpose: most of these switches change what he sends.'],
    },
    {
      id: 'daily',
      title: 'Daily sends · last 7',
      where: 'DAILY · LAST 7 panel',
      text: [
        'How many messages he sent per day (in his timezone), from the warmup counter. Only the last 7 days are kept. Today is highlighted, with the warmup limit next to it while warmup is running.',
      ],
    },
  ],
};
