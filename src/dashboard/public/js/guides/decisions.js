// Guide: Decisions (pages/decisions.js). Plain data, see components/guide.js.
export default {
  title: 'Decisions',
  intro: [
    'Every time a message reaches him, he decides whether to answer: skip, text, a reaction, or both. This page shows the last 200 of those decisions and why, live as they happen.',
    'In groups the decision is a probability. He starts from his base response rate (RESPONSE_RATE, default 0.15, which the mind may nudge) and multiplies it by a set of factors, each above 1 (more likely) or below 1 (less likely). The result is capped at 0.95 and a dice roll decides. If he does answer, a second roll picks the type: by default about 70% text, 20% reaction, 10% both. Even on a failed roll there is a small chance (about 5%) he just reacts.',
    'Some cases skip the dice: DMs always get an answer (0.95), an open flow such as a bill split always continues, and a direct @-mention, his name or a reply to one of his messages is answered unless a guard stops it.',
    'Messages that never reach the decision do not appear here: muted groups, and (with the life simulation on) messages that waited until he picked up his phone, until that later turn.',
  ],
  sections: [
    {
      id: 'kpis',
      title: 'Header and tiles',
      items: [
        ['SAMPLES / DECISIONS', 'How many decisions are loaded (up to 200, newest first).'],
        ['FIRED', 'How many of them were anything but a skip. TEXT and REACT counts below it (a "both" counts in each). MEDIA counts gifs, stickers, voice notes and images sent from the dashboard\'s force buttons, which are logged here too.'],
        ['RATE', 'Fired as a share of the loaded decisions. DMs count as fires, so a DM-heavy day looks chattier than his group behaviour is.'],
        ['QUALITY · GATED', 'Replies the quality gate blocked after they were written, over the last 7 days (not the 200-row window).'],
        ['BS DETECTED', 'Loaded decisions where the bullshit-detection factor fired (a value above 1: 3.5 for chain forwards, 2.5 for humblebrags), the messages he likes to call out.'],
      ],
    },
    {
      id: 'feed',
      title: 'Live feed',
      where: 'LIVE panel',
      text: [
        'The 60 newest decisions: time, outcome, score in brackets, sender and the first 100 characters of the message. New ones arrive at the top as they happen.',
        'The score in brackets is the probability the dice were rolled against: for a SKIP the computed score that lost the roll (0.00 only for a hard skip that never got scored, such as his own message or a reaction), for a FIRE the score that won (0.95 for DMs, mentions and flows).',
        '"[message gone]" means the message is no longer stored (deleted, expired or purged).',
      ],
      items: [
        ['FIRE · TEXT / REACT / TEXT+REACT', 'What he chose to send.'],
        ['FIRE · VOICE / SING / GIF / STICKER / IMAGE', 'A force-send from the dashboard.'],
        ['SKIP', 'He stayed quiet. Common reasons: the roll failed, a burst cooldown or hourly cap blocked it, his own message, a reaction, or an empty message. The reason is stored with the decision but not shown in this feed; the Logs page prints it.'],
      ],
      tips: [
        'FIRE means he decided to answer, not that something was sent. Warmup, the pre-filter, the model choosing to skip, or the quality gate can still stop it afterwards. The Logs page shows what happened next, and the real score of a skip.',
        'An explicit image request aimed at him ("send me a picture of a cat") can override a failed roll and get an image anyway. Such a row says FIRE · TEXT with an IMAGE ASK tag, and keeps the score that lost the roll.',
      ],
    },
    {
      id: 'factors',
      title: 'Factor breakdown',
      where: 'FACTORS panel',
      text: [
        'The eight factors of the latest decision that fired (or the latest one if none fired), with the person\'s name and score in the head. Each number on the right is the multiplier (×1.00 = no effect); each bar is drawn against that factor\'s own maximum (for example MENTION out of ×6, BS-DETECT out of ×3.5), so a full bar means the strongest push that factor can give.',
        'A DM or a flow has no factors, so the bars show dashes.',
      ],
      items: [
        ['MENTION', '6.0 when someone tags him or uses his name or an alias, 5.0 when they reply to one of his messages (both bypass the dice), 1.5 when they address everyone ("anyone?", "guys"), else 1.0.'],
        ['QUESTION', '2.0 for a question mark, 2.5 for "what do you think"-style asks, else 1.0.'],
        ['COMMAND', 'Up to 3.0 when someone asks him to do something (sing, draw, …), else 1.0.'],
        ['HUMOR', '1.5 to 1.8 for an opening to joke (self-deprecation, exaggeration, all caps), else 1.0.'],
        ['MOMENTUM', 'How busy the group is in the last 5 minutes: 1.3 when it is quiet but alive, 1.0 normal, 0.6 busy, 0.4 very busy, 0.8 when nobody has spoken.'],
        ['RECENCY', 'How long since he last spoke there: 0.1 under a minute, 0.3 under 3 minutes, 0.7 under 10, else 1.0. Softer (0.6 / 0.8) when someone answered him since.'],
        ['BS-DETECT', '2.5 to 3.5 for forwards ("forward this to 10 people") and humblebrags, which he likes to call out; else 1.0.'],
        ['CONVO', 'Two other people in a back-and-forth: 0.2 to 0.4 (he stays out of it); 1.2 when the back-and-forth is between him and one person; else 1.0.'],
        ['SCORE', 'The final probability for this message, after every factor (0 to 0.95).'],
      ],
      tips: ['Logged but not drawn here: the mind\'s per-group multiplier, an imitated person\'s active hours while imitating, and his availability while the life simulation is on (busy lowers it, it never raises it).'],
    },
    {
      id: 'hourly',
      title: 'Decisions per hour',
      where: 'DECISIONS PER HOUR row',
      text: ['How many of the loaded decisions fell in each hour of the day, in his timezone. The 200 rows can span several days, so this shows the shape of a typical day rather than the last 24 hours.'],
    },
    {
      id: 'tuning',
      title: 'Changing how often he answers',
      items: [
        ['Base rate', 'responseRate on the Settings page (RESPONSE_RATE in .env). The mind may nudge it within the bands you set on the Mind page; your own change ends those nudges.'],
        ['Hourly caps', 'MAX_PER_GROUP_HOUR and MAX_GLOBAL_HOUR (see the Status page).'],
        ['One group', 'Mute it on its group page: he reads but never answers there.'],
      ],
    },
  ],
};
