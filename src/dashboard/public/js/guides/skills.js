// Guide: Skills (pages/skills.js). Plain data, see components/guide.js.
export default {
  title: 'Skills',
  intro: [
    'Skills are his optional abilities. Each row is one loaded skill with its state and a description; ENABLE / DISABLE switches it for the running bot at once.',
    'A toggle is in memory only. After a restart every skill is back at its boot default, which for most of them is an .env setting (WEB_SEARCH_ENABLED, LIFE_ENABLED, MIND_ENABLED and so on). To keep one off for good, set its .env value to false.',
    'Toggling needs a writable dashboard (DASHBOARD_READONLY=false) and is audited as skill.toggle.',
  ],
  sections: [
    {
      id: 'table',
      title: 'The table',
      items: [
        ['# · NAME', 'Load order and the skill\'s name. The numbering follows the files on disk and is not a priority.'],
        ['STATE', 'ENABLED or DISABLED right now. The header counts loaded, enabled and disabled skills.'],
        ['DESCRIPTION', 'What the skill does, as written by the skill itself (some also say what they are set to at boot).'],
        ['ENABLE / DISABLE', 'Flips it now. A few have an immediate side effect when switched off, listed below.'],
      ],
    },
    {
      id: 'list',
      title: 'What each skill does',
      text: ['Almost all of these are master switches: they don\'t handle messages themselves, the feature checks them on every use. Bill-split is the only one that takes over messages.'],
      items: [
        ['arcs', 'A story layer on top of the life simulation: the cast\'s own lives and relationships, slow arcs (romance, career, family, rare heavy stretches), plans he mentions in chats becoming part of his world, Ask-me cards, the nightly journal and the Director page. Needs life on too. Off at boot unless ARCS_ENABLED=true.'],
        ['bill-split', 'Splits a bill in a chat: picks up a receipt photo with a bill-like caption, a reply to an image asking to split it, a mention or DM asking about the bill, or an ongoing split, then walks the group through who owes what. Always on at boot; no .env switch.'],
        ['chat-influence', 'Lets what people say in chats touch his simulated day a little: a small, fading mood shift from a roast, praise, an argument or news (the reason is only mentioned in that chat), his sleep pushed up to 2 hours while a chat is really going, a bit of work pressure when he chats through a work hour, and invitations ("cinema at 8?") he can answer yes, no or maybe — a maybe gets one follow-up once he decides (listed on Life · Pending) — and advice about his life, which only waits for you on the Story and Director pages (needs arcs on too). Never sickness, money, job or relationships. Needs life on too. Area switches are CHAT_INFLUENCE_* settings; the panel is on Life · Now. Off at boot unless CHAT_INFLUENCE_ENABLED=true.'],
        ['calls', 'Lets him answer and place phone calls on the gateway phone. Off: incoming calls get "busy" and the dashboard can\'t place calls. Boot default CALLS_ENABLED.'],
        ['imitate', 'Global kill switch for imitate mode (he writes like a chosen group member). Targets are set per group on the group page; they survive a restart, but stay inert until this is on again. Boot default IMITATE_MODE_ENABLED.'],
        ['imitate-voice', 'While imitating someone who enrolled their own voice (with a consent recording) and whose group allows it, his voice notes use that cloned voice. Also gates DM voice enrolment. Needs imitate on. Boot default IMITATE_VOICE_ENABLED.'],
        ['instagram-chat', 'He reads the Instagram group chat while awake, watches reels members send, and replies or hearts on his own (a mention always gets a reply). The "check chat now" button works regardless. Boot default IG_CHAT_ENABLED.'],
        ['instagram-reels', 'Automatic Reels browsing sessions on the Instagram phone a few times a day: he watches, likes what fits, and queues the best to share. Off stops a running session; the manual Browse button and queue approvals still work. Boot default IG_ENABLED.'],
        ['jev-prefilter', 'Jev guesses "would he reply?" on ordinary group turns. In shadow mode it only logs; in enforce mode it skips writing a reply when he would clearly stay silent. Mode and threshold are on Settings. Boot default JEV_PREFILTER_ENABLED.'],
        ['life', 'His simulated day on the real clock: routine, commute, meals, sleep, moods, small decisions, and answering when he would actually be on his phone. Off: he answers the messages waiting for him once, then behaves as without it (sleep hours, normal read receipts). Boot default LIFE_ENABLED.'],
        ['mind', 'A slow inner loop over his chats: glances, a few thinks a day, a nightly sleep that writes per-chat episodes, a self-state line, small nudges to his settings, and (shadow by default) messages he would start himself. Off cancels queued proactive sends. Pause and the rest are on the Mind page. Boot default MIND_ENABLED.'],
        ['web-search', 'Lets him search the web and open pages in the middle of a reply. Off: he stops using or offering it at once and the headless browser is closed. Tuning is on Settings. Boot default WEB_SEARCH_ENABLED.'],
      ],
      tips: ['Turning life or arcs off doesn\'t erase the simulated world; it keeps its history and picks up again when switched back on.', 'Turning chat-influence off removes any mood shift from chats at once; a sleep push already made tonight stays (revert it on Life · Now).'],
    },
  ],
};
