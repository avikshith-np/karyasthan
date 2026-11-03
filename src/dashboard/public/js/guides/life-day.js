// Guide: Life · Day (pages/life-day.js). Plain data, see components/guide.js.
export default {
  title: 'Life · Day',
  intro: [
    'On a phone VITALS, ON HIS MIND, THOUGHT VS DEED and the map fold away, and remember if you open them. THOUGHT VS DEED shows what he leaned to and what he did side by side.',
    'His day read top to bottom like a diary: what actually happened so far (from the world log), a NOW line, and the rest of today or tomorrow as the simulation expects it (faded). Use it to see what he is doing at any moment and what he will most likely be doing next.',
    'The page only reads, with one exception: the HOW IT WENT panel of an outing\'s scene can rewrite, edit or revert that scene (write mode only). While it shows today it refreshes every 30 seconds and scrolls to the NOW line when it opens. Times are shown in his timezone.',
  ],
  sections: [
    {
      id: 'nav',
      title: 'Choosing a day',
      where: 'top right',
      items: [
        ['◀ / ▶', 'The previous or next day. You can go back to the day his world began and forward to tomorrow (tomorrow is projection only). The address changes to #life/day/YYYY-MM-DD, so a day can be bookmarked.'],
        ['NOW', 'Back to today and to the NOW line.'],
        ['TODAY / TOMORROW', 'Shown next to the date when the day is today or tomorrow.'],
      ],
    },
    {
      id: 'now',
      title: 'The NOW card',
      where: 'today only',
      items: [
        ['What he is doing', 'His current activity, where, and who he is with (people from his simulated world), or the trip he is on and when he arrives. Since / until are the block\'s times; the weather is the current sky.'],
        ['Availability chip', 'His availability state now (free, light, busy, meeting, dnd, asleep). ON PHONE while a phone check is running. QUIET DAY while a heavy event holds his tone low.'],
        ['Would he reply now?', 'The odds his reply gate uses right now for a DM, a group message that mentions him, and other group chatter: answer now, take a quick look (sneak), leave it for his next phone check (later), react, or ignore. These are the same odds the gate rolls for each message; on his phone or free he answers.'],
        ['next', 'The next block he is expected to start, and roughly when his next phone check is due.'],
        ['Bars', 'Energy, stress, social battery, mood, hunger and work pressure at this moment.'],
      ],
    },
    {
      id: 'goals',
      title: 'Goals',
      where: 'strip above the vitals (only when there are goals)',
      text: [
        'The soft goals you set on Life · Director ("see someone", "call home", "get out", "run an errand" between two days). Each one shows who and where if you gave them, its window, and where it stands: open (not tried yet today), planned at a time (it fits today; the outing is in his evening), deferred with the reason it could not fit today (tired, sick, paused, frozen, pinned, away, no place, no free slot — he tries again tomorrow), done, cancelled, or expired (the window ended and it never fitted). A closed goal stays listed for three days, so one that lapsed does so visibly.',
      ],
    },
    {
      id: 'vitals',
      title: 'Vitals sparkline',
      text: [
        'Energy, stress, social battery and mood across the day, every 30 minutes. The solid part is what happened (recomputed from the log, read only); the dashed part after the red NOW line is the projection. Mood runs from −1 to 1 and is drawn on the same 0–100 scale.',
        'A very old day may have no past series: when no saved snapshot comes before it and the log up to it is very long, recomputing it would mean replaying too much of his life, so the page leaves it out.',
      ],
    },
    {
      id: 'thoughts',
      title: 'On his mind',
      where: 'ON HIS MIND panel',
      text: [
        'What passed through his head this day, in order. Sparse on purpose: about 2–6 an hour while he is awake. Built in code, no model; nothing in his life reads them. Undoing what caused one removes it.',
        'The cards above the stream are real thoughts, a few a day at salient moments. WHAT HE TOLD HIMSELF is his own explanation, one small model call asked for a reason after the fact and not told his lean or the draw. WHAT ACTUALLY DROVE IT is the code\'s true cause. A failed call just leaves the stream. Never on the public site.',
      ],
    },
    {
      id: 'thought-deed',
      title: 'Thought vs deed',
      where: 'THOUGHT VS DEED panel',
      text: [
        'What he leaned to against what he did, one line per decision that was active this day: "leaning stay (0.72)… went anyway (deadline draw)". A decision that ran over two days shows on both, marked ACROSS DAYS.',
        'The cause in brackets is the true one, from the log: the deadline draw, an early commit, the lean at the deadline, the owner, adopted from a chat, agreed in texts, his reply to an invitation, a goal\'s outing, or why it expired. ◇ CHAT marks a plan made in a chat or a lean a chat caused: those show code labels only, never a word from a chat.',
        'Read only. Nothing is stored and no model is called.',
      ],
    },
    {
      id: 'rows',
      title: 'The day, row by row',
      items: [
        ['Blocks', 'What he did and for how long: activities (with the place and the people), trips (how, from → to, minutes) and sleep, each with the availability state he had. The block still running shows …'],
        ['A broken night', 'When the Director woke him in the night (he can\'t sleep), the night shows two sleeps with what he did in between (up at home, or an outing), and a wake row between them; his morning wake still settles the whole night\'s sleep debt.'],
        ['▣ chats', 'Under a block: what happened in the real chats meanwhile, as counts per chat — replies he sent, messages his availability made him leave for later (deferred), and deferred messages he answered at a later phone check. Chat names only, never the messages.'],
        ['Small rows', 'Waking up, meals, phone checks, weather changes, money, work pressure, being sick, decisions he made (a plan he committed to that is still ahead reads "decided: … · Tue 3 Nov 19:30 (not yet)": he has chosen, it has not happened; "(agreed in texts)" marks a plan he and someone made in his texts), moments from his story (people\'s news, arcs, family calls, birthdays), owner actions from the Director (weather windows and goals you set included), his goals being fitted, put off or done, and the mind\'s runs (glance, think, sleep; kind and status only).'],
        ['God changes', 'What you changed on Director · PLAY GOD: how an outing turned out (social), a job change and the day it took effect (work), a money change (money), a move (home), someone leaving or coming back (people), and a mood or illness you scheduled (owner, shown when it was set). Names of people who left still show on past rows.'],
        ['Caught in the rain', 'He was out on foot or on two wheels without an umbrella when it rained: how he travelled, whether he had to change clothes, and how late that made him (the next block starts that much later). His mood and energy take a small hit.'],
        ['CHAT · group / dm', 'This happened because of something said in a chat (a decision nudged by a message, a plan he made in a chat). For chat-influence rows the chip shows the chat\'s name instead. The chat\'s content is never shown here.'],
        ['Chats on his day', 'With chat influence on, its rows are labelled ◇ with the chat they came from: a message that got to him (and the feeling it was, e.g. roast or praise), being invited out, the inviter calling it off, his answer to an invitation (yes, late, no, maybe), a follow-up he sent (or that ended with nothing sent), his sleep pushed later because he kept chatting (with tonight\'s total), and falling behind at work after a lot of chatting. The mood change itself is not a separate row. If these labels cannot be loaded the rows still appear, with their plain event type.'],
        ['Folded rows', 'Three or more phone checks and mind glances in a row fold into one quiet row ("12 phone checks · 2 mind glances", with the time they span); tap it to open or close it. ALL ROWS in the panel head shows every row unfolded (remembered in this browser).'],
        ['Money', 'His salary (+), a spend (−) and what it was for (food, an outing, rent, bills, groceries, travel), or a change you made on the Director: you added / took an amount, or set his money, with your label. Every entry of the month is on Life · Wallet.'],
        ['Unknown types', 'Any other kind of world event is listed with its type, so new kinds of events appear here without changes to this page.'],
        ['Decisions', 'An invitation or choice: what, where, with whom, the deadline, his current lean and, once made, what he chose and how (sampled at the deadline, early, by you on an Ask-me card, adopted from a chat).'],
      ],
      tips: ['Click a past row to see why it happened in the WHY panel (on a phone it opens as a sheet from the bottom; CLOSE, Escape or a tap outside it puts it away). Undoing an event is done on Life · Timeline.'],
    },
    {
      id: 'projection',
      title: 'The projection (faded rows)',
      text: [
        'With the arcs skill on, the rest of the day is simulated several times on a copy of his life — no model calls, nothing written. The runs only differ in how his open decisions come out (the deadline draw); his routine, the weather and the story\'s dated rolls are the ones the live engine will use. The rows shown are the most common run; a decision lists the odds of each outcome over all runs ("not opened" when the invitation did not happen in some runs, "undecided" when it is still open at the end of tomorrow).',
        'In reality Jev, a chat message or you on the Director page can still change a decision, so treat the odds as how he leans today, not a promise. Weather rows in the future are the deterministic forecast; a weather window you set on the Director replaces it where it covers the day and is marked SET BY YOU.',
        'The head of the panel shows how many runs were done and how long they took. The projection is cached and recomputed at most once a minute when something new happened; the number of runs is cut short to keep the work under about 1.5 seconds.',
        'With the arcs skill off there is no simulation: the rest of today is his day plan, tomorrow is the plan his routine would make, and there are no odds or projected vitals.',
        'TONIGHT (CONTINUES TOMORROW): after 18:00, today\'s page ends with a strip for the hours past midnight up to when he next wakes (at least six hours) — the same projection, plus any plan set for then — so a plan at 00:15 shows on today\'s page, not only on tomorrow\'s. Its times are after midnight.',
      ],
    },
    {
      id: 'why',
      title: 'Why · cause chain',
      text: ['The event you clicked and everything that led to it, oldest first: who did it (engine, jev, chat, owner), where it came from and its data. Projected rows have no events yet, so they cannot be explained.'],
    },
    {
      id: 'scene',
      title: 'How it went (scenes)',
      where: 'HOW IT WENT panel, under WHY (on a phone, in the sheet that opens from the bottom; the ❖ chip scrolls the sheet to it)',
      text: [
        'When an outing with someone ends (a hangout, a meal out, a family visit — never the office lunch, a meeting or dinner at home), the story writes its scene once: how the time together actually went. A past block with a scene carries a ❖ HOW IT WENT chip with how it ended; click the block (or the chip) to open the scene here. A planned outing ahead shows ❖ TONE, a link to Director · PLAY GOD · OUTCOMES where you can give its scene a tone hint before it happens.',
        'The scene panel shows the narration, what each side thought (first meetings only: HE THOUGHT and what they thought of him), what they TALKED ABOUT, the HIGHLIGHT and anything AWKWARD, the CHEMISTRY (0–1), the ENDING (parted as usual, swapped numbers, plan to meet again, stayed late, left early, parted badly), WHAT CHANGED in his world because of it (small relationship moves, a romance starting, a plan to meet again — a plan he already went on or a romance that moved on is marked kept when the scene goes), and who wrote it (the mind for first meetings, dates, family occasions and scenes you steered; the clerk for the rest and for every plan made in a chat; one line from code when the daily cap or budget was reached, the model failed, the Director was paused or a hard stretch was on). TONE shows the hint it was written with and its outcome, or LET IT HAPPEN.',
        'With a real person (an invitation from a chat) the scene is written by code, never a model: a few lines about him only (where, the weather, how he felt), always fine or well, nothing said, felt or done by them, nothing changed in his world, never published, and it reaches only chats where that person is. It can only be reverted. A scene of a plan made in a chat changes nothing in his world either. A scene from around a hard stretch is only ever told in a direct chat or a call, never in a group, the journal or the site. An outing found more than a day and a half late (ARCS_SCENE_MAX_AGE_HOURS), or one from while scenes were off, gets no scene.',
      ],
      items: [
        ['REGENERATE', 'Writes a new version. It keeps how the outing went (the outcome) unless you give a tone hint with its OUTCOME (well / fine / flat / badly; a chip picks both) — the hint then sets it. The old version and its relationship moves are reverted; a plan to meet again or a romance it started stays if already lived, else goes. If the new one can\'t be written, the old one stays and the panel says so (a failed rewrite shows in the version line). A reverted scene can be rewritten too, while its outing is still in his day. Two a minute, and a daily cap.'],
        ['EDIT TEXT', 'Changes only the narration (what he remembers and what the public site shows); its effects stay as they are. Not for a real person\'s scene.'],
        ['REVERT THIS CHANGE', 'Undoes the scene and its relationship moves (the same revert as on the Timeline). Never refused: a plan to meet again or a romance it started is undone too unless it already happened or moved on — then it is kept. The panel stays, marked REVERTED.'],
      ],
      tips: ['The buttons need write mode (DASHBOARD_READONLY=false). The scene is part of his memory: he can bring up the details in a chat, but only where the outing\'s origin allows.'],
    },
    {
      id: 'map',
      title: 'Trips · map',
      where: 'TRIPS · MAP panel, under the day',
      items: [
        ['Solid lines', 'Trips he made this day, from his event log. The last few are highlighted.'],
        ['Dashed lines', 'Today only: trips still planned for the rest of the day (his day plan, not the projection runs).'],
        ['Road or straight', 'A trip follows the road when a route was fetched for its two places (Director PLACES panel, OSRM); otherwise it is a straight line between them. A past trip keeps the route it was planned with, even if a place moved since; labels always show a place\'s current name.'],
        ['Home', 'Drawn as a 400 m area rather than a pin.'],
        ['Red dot', 'Where he is now (today only).'],
      ],
      text: [
        'The map tiles are loaded by your browser from LIFE_MAP_TILE_URL (by default OpenStreetMap\'s tile server): that host sees your IP address, the dashboard\'s origin and the area you look at, never the dashboard\'s pages. Set LIFE_MAP_TILE_URL empty to turn tiles off; the map is then drawn locally on a grid, as it is when the map library fails to load. OpenStreetMap\'s tile policy asks for light use and kept attribution: the map is drawn once per visit and only its lines are updated.',
        'The head of the panel counts the trips (and how many follow a road) and says which map is drawn. If the map can\'t be read the rest of the page still works.',
      ],
    },
  ],
};
