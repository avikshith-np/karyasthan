// Guide: Live Logs (pages/logs.js). Plain data, see components/guide.js.
export default {
  title: 'Live Logs',
  intro: [
    'A live feed of what the bot is doing, as it happens: every reply, reaction, skip and block with the reason behind it, plus warnings and errors. Watching only; nothing on this page changes his behaviour.',
    'When you open the page it first shows up to the last 200 lines, then new ones as they arrive. The bot keeps only its last 500 lines in memory, and that history is lost on restart. For older history use the server\'s log files or the Decisions page.',
  ],
  sections: [
    {
      id: 'reading',
      title: 'Reading a line',
      text: [
        'Each line has the time (in the bot\'s timezone), a category tag and the message. Under it, a context line pulls out what matters: the group (by name when known), the sender, the score, the decision factors that moved it, the reason, which provider and model answered, how long it took, and any error. Click a line (or press Enter on it) to show the full raw record.',
      ],
      items: [
        ['REPLY', 'He sent (or, with dry run on, would have sent) a text reply.'],
        ['REACT', 'He reacted with an emoji instead of writing.'],
        ['SKIP', 'He chose silence: the message didn\'t clear his reply chance, the pre-filter or the model declined, or (with life on) he was away and will answer at his next phone check or leave it unread.'],
        ['BLOCK', 'Something stopped him: the quality gate rejected his reply, an hourly cap or burst cooldown, warmup, a muted group, or a reply that went stale before sending.'],
        ['ISSUE · WARN', 'Something went wrong or was bypassed: an error, a provider failing over, a budget limit, a safety check failing open.'],
        ['WEB', 'A web search or page browse: the query, cache hits, results, the browser starting or closing.'],
        ['AUDIO', 'Voice in and out: a voice message downloaded and transcribed, a voice note generated (and on which model and voice), a cloned voice enrolled or deleted. Warnings and errors from these keep their WARN / ISSUE tag.'],
        ['INFO · DEBUG', 'Everything else. The page shows what the bot logs at its LOG_LEVEL; DEBUG lines appear only when it runs at debug.'],
      ],
      examples: [
        'mention×3 · question×2 → 0.42 (rolled 0.17): his reply chance was 0.42 after the factors, and the roll of 0.17 was under it, so he replied.',
        'score 0.18 (rolled 0.44): the roll was over his chance, so he skipped.',
      ],
    },
    {
      id: 'controls',
      title: 'Toolbar',
      items: [
        ['⏸ PAUSE / ▶ RESUME', 'Freezes the view so you can read. New lines are still collected in the background and appear when you resume.'],
        ['↓ FOLLOW', 'While lit, the view keeps scrolling to the newest line. Turn it off to scroll back without being pulled down.'],
        ['⌫ CLEAR', 'Empties this page\'s view only. The bot\'s own log is untouched.'],
        ['LEVEL', 'Show only lines at or above a level (error+, warn+, info+, debug+).'],
        ['EVENTS', 'DECISIONS (reply, react, skip, block), ISSUES (issues and warnings), WEB (web search and browsing) or AUDIO (transcription, voice notes, cloned voices). WEB and AUDIO include that module\'s warnings and errors too.'],
        ['FILTER LINES', 'Show only lines containing this text (case-insensitive).'],
        ['↧ EXPORT', 'Downloads the lines this page has collected (up to 500) as a text file, regardless of the filters.'],
      ],
      tips: [
        'STREAM in the header shows the connection: OPEN, RECONNECTING or CONNECTING. After a reconnect only missed lines are added, never duplicates. BUFFER shows how many lines the page holds (max 500).',
        'Key-like fields are redacted before a line reaches this page. Lines can still contain group names and people\'s display names, so treat an export as private.',
      ],
    },
  ],
};
