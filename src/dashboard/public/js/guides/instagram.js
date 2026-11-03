// Guide: Instagram (pages/instagram.js). Plain data, see components/guide.js.
export default {
  title: 'Instagram',
  intro: [
    'He has his own Instagram account on a dedicated Android phone and is a member of your Instagram group. A few times a day he scrolls Reels in character: a screen-watching model describes each reel, a decision model judges it against his taste card, and code decides whether to skip it, like it, or like it and keep it for the group. Strong reels are saved in Instagram, which is his share queue. He can also read and answer the group chat.',
    'The phone is driven only inside the Instagram app. If any other app or the lock screen comes to the front, he stops at once without touching it.',
    'Header: AUTO is the instagram-reels skill (automatic sessions on or off), MODE is IG_APPROVAL_MODE (approve-each or auto), GROUP is the Instagram group he shares into (IG_GROUP_NAME). A DRY RUN badge means shares and chat replies stop just before Send.',
    'Buttons here are writes. With the dashboard read-only (DASHBOARD_READONLY=true, the default) they answer with an error. Every action is recorded on the Audit page.',
  ],
  sections: [
    {
      id: 'alert',
      title: 'INSTAGRAM NEEDS YOU',
      where: 'Red banner under the header',
      text: [
        'Shown when Instagram shows a security check or block screen, the phone shows its lock screen, or another app came to the front during a session. Everything (sessions, shares, chat checks) is paused while it is up.',
        'Sort it out on the phone yourself, then press CLEAR. The banner is kept in memory only, so a restart also clears it.',
      ],
    },
    {
      id: 'kpis',
      title: 'Cards: phone, today, warmup, last 24 h',
      items: [
        ['PHONE', 'CONNECTED, LOCKED or OFFLINE, with Android version, battery level and temperature, and which app is in front. The reading can be up to 20 seconds old.'],
        ['TODAY', 'Likes and shares today against the daily caps (IG_LIKES_PER_DAY, IG_SHARES_PER_DAY), counted from midnight in his timezone.'],
        ['WARMUP', 'For the first IG_WARMUP_DAYS days after his first session he never shares into the group from a browsing session, even in auto mode or with ALLOW SHARING ticked; strong reels only go to the queue. DONE means in-session shares are allowed (auto mode, or a manual session with ALLOW SHARING). Your own APPROVE & SEND works during warmup.'],
        ['LAST 24H', 'Reels seen, liked and queued in the last day, and what the decision model cost.'],
      ],
    },
    {
      id: 'browse',
      title: 'Browse now',
      where: 'BROWSE panel',
      text: [
        'BROWSE INSTAGRAM starts a session of 5, 10 or 15 minutes right away, even outside his waking hours and even with the instagram-reels skill off. It still respects the daily like and share caps, an open alert, a session already running and a missing phone (each refused with a message). STOP asks the running session to end; he finishes the step he is on first.',
        'While a session runs the panel shows its phase, time left, counts and the reel on screen. At the end, if the instagram-chat skill is on, he also looks at the group chat.',
      ],
      items: [
        ['ALLOW SHARING THIS SESSION', 'Unticked (the normal case): strong reels are only saved to the queue for you to approve. Ticked: he sends strong reels straight into the group during this session, up to the daily share cap, but never during warmup (then they still go to the queue). Asks to confirm.'],
      ],
    },
    {
      id: 'schedule',
      title: 'Today\'s schedule',
      where: 'TODAY\'S SCHEDULE panel',
      text: [
        'The times picked for today\'s automatic sessions (IG_SESSIONS_PER_DAY, at random, at least 75 minutes apart, while he is awake). With the life simulation on, they fall in his free time and are skipped if he is asleep, in a meeting or on do-not-disturb by then. A slot shows "done" once it ran or was skipped.',
        'The plan is shown even with AUTO off, but sessions only start while the instagram-reels skill is on. Manual sessions don\'t use a slot. The plan is redrawn every day and on restart.',
      ],
    },
    {
      id: 'queue',
      title: 'Share queue',
      where: 'SHARE QUEUE panel',
      text: [
        'Strong reels waiting for you, with the scores that got them there. In approve-each mode nothing reaches the group without you, unless you tick ALLOW SHARING for a session after warmup. Every share, yours included, counts against the daily cap.',
      ],
      items: [
        ['Caption', 'Optional, up to 140 characters, plain Latin letters only (the phone can\'t type emoji or other scripts, they are dropped). Blank: he writes one himself in his voice, after a quality check; if he has nothing good to say, it goes without a caption. Once a caption is stored (yours, or his from an earlier attempt), clearing the box and approving sends the reel with no caption; the box then says "no caption (cleared)" until you type a new one.'],
        ['APPROVE & SEND', 'Asks to confirm, then opens Instagram\'s Saved list on the phone, finds the reel (the Saved grid only shows display names, so it opens items and checks the account; refused when the first saved items hold two reels by that account, since it can\'t tell them apart), shares it into the group through Instagram\'s own share sheet and un-saves it. Takes a little while. With DRY_RUN it stops before Send and the reel stays approved. Refused once today\'s shares reach IG_SHARES_PER_DAY: the reel stays in the queue with "daily share cap reached" under it, for tomorrow. Only a reel still queued, approved or failed can be approved: one vetoed or sent meanwhile (another tab) is refused and left as it is, caption included.'],
        ['VETO', 'Never share this one. It leaves the queue.'],
        ['Pills', 'queued (waiting), approved (you pressed approve, not sent yet), sending, sent, vetoed, failed. A failed share shows its error in red and can be approved again.'],
      ],
      tips: ['Approving is refused while the phone is busy with a session, a share or a chat check, or while an alert is open. Try again when it is idle.'],
    },
    {
      id: 'chat',
      title: 'Group chat',
      where: 'GROUP CHAT panel',
      text: [
        'With the instagram-chat skill on he checks every IG_CHAT_POLL_MINUTES minutes while awake (and after each session). He opens the inbox and, only if your group\'s row is unread, that one thread. No other chat is ever opened.',
        'New messages are stored and shown here (his own tinted). Reels members sent are watched and described (at most 2 per check). A mention of his name or a reply to him always gets a reply; otherwise the decision model picks reply, react (a heart) or ignore. Replies are capped at IG_CHAT_MAX_REPLIES_PER_HOUR; over the cap he reacts instead. The pill after a message shows what he did.',
      ],
      items: [
        ['CHECK CHAT NOW · MANUAL', 'A manual override, like BROWSE: it opens the group thread now, even if it isn\'t unread and even with the instagram-chat skill off, and handles anything new (including replying). The pill next to it shows the skill: SKILL ON, or SKILL OFF · MANUAL STILL RUNS (no automatic checks, but this button works). The line after it shows the last check: how many new messages, what he did, and his reply text.'],
      ],
      tips: ['In his replies he uses what he knows about members only through the member links below, and only what this group may see. Anyone in the thread he can\'t link makes him treat the chat as having outsiders, so nothing private from WhatsApp crosses over.'],
    },
    {
      id: 'members',
      title: 'Members: link to WhatsApp people',
      where: 'MEMBERS panel',
      text: [
        'The Instagram group\'s members, read from the group\'s member screen on the first chat check and then once a day. ADMIN marks group admins; LEFT marks people no longer in the group.',
        'Pick the WhatsApp person each member is. Names that share a word with the member are marked "(suggested)". The choice is saved at once; "— not linked —" removes the link.',
      ],
      items: [
        ['What a link does', 'He recognises that member in the Instagram chat as the person he knows from WhatsApp, can use what that person\'s audience allows from his WhatsApp knowledge when replying and when judging who a reel is for, and the person counts as a member of the Instagram group for the privacy rule (what is learned there can reach their WhatsApp chats under the same rule as a WhatsApp group).'],
      ],
      tips: ['Link carefully: a wrong link shares one person\'s profile with someone else.'],
    },
    {
      id: 'reels',
      title: 'Reel log',
      where: 'REEL LOG panel',
      text: [
        'Every reel he saw, newest first, 30 at a time (LOAD MORE for older). Search covers account, caption and description. The action list filters QUEUED, LIKED or SKIPPED.',
      ],
      items: [
        ['Action pill', 'QUEUED (liked and kept for the group), LIKED, SKIP; a second pill shows its share state.'],
        ['Depth', 'How closely he looked: QUICK or FIRST_LOOK (a few seconds, most reels are swiped then), FULL or FULL_LIVE (watched longer).'],
        ['HUMOUR · FIT · CONF', 'The decision model\'s scores (0 to 3): how funny, how well it fits his taste card, and how sure it is. FOR names a group member it would suit. A low confidence means skip.'],
        ['Hazard pills', 'Politics, religion, NSFW, violence, scam, cruelty or tragedy above the hazard threshold. Any hazard, or an ad, means skip.'],
        ['JEV\'S CALL: GOOD / BAD', 'Your verdict on the decision. It is only stored for tuning the thresholds and does not change him. Click again to clear.'],
      ],
      tips: ['The thresholds (IG_LIKE_HUMOUR, IG_LIKE_FIT, IG_QUEUE_HUMOUR, IG_QUEUE_FIT, IG_HAZARD_THRESHOLD, IG_MIN_CONFIDENCE) can be changed on the Settings page.'],
    },
    {
      id: 'taste',
      title: 'Taste card',
      where: 'TASTE CARD panel',
      text: [
        'What kind of reels he likes, as JSON. Every reel is judged against it: likes (topics he enjoys, required), humour (one sentence on his sense of humour), languages, hard_no (things he would never share) and notes. Each list holds up to 30 entries.',
        'SAVE TASTE CARD checks the JSON and writes it; the next reel uses it. The label shows "taste.json" for his own card, or USING THE EXAMPLE CARD if none was generated yet.',
      ],
      tips: ['Keep it broad. A card that lists one hobby over and over makes him like only that.'],
    },
    {
      id: 'sessions',
      title: 'Sessions',
      where: 'SESSIONS panel',
      text: ['The last 10 sessions: when, trigger (auto or manual), reels seen, liked, queued, shared, and why it ended (time up, stopped, another app came to the front, an error), or "running".'],
    },
    {
      id: 'devlog',
      title: 'Device log',
      where: 'DEVICE LOG panel',
      text: [
        'Every command sent to the phone, newest first: time, operation, its details, which app was in front, how long it took, and OK or REFUSED/ERR (hover for the reason). Use it to check that nothing outside Instagram was touched. Entries older than 14 days are pruned.',
      ],
    },
  ],
};
