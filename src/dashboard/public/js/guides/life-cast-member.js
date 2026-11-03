// Guide: Life · People, one person (pages/life-cast-member.js). Plain data, see components/guide.js.
export default {
  title: 'Cast member',
  intro: [
    'One person from his simulated life: who they are to him, how the relationship stands now, what they have shared, and every event about them. These are fictional people, never someone from his chats.',
    'On a phone it leads with how things stand, their texts and your time together; WHO, OVER TIME, HISTORY and EVENTS fold away, and remember if you open them. The page refreshes every 30 seconds. It only reads, except NARRATE, which asks a model for a short explanation. To change this person, use the Director (EDIT CAST, NUMBERS, CAST.BEAT, CAST.HISTORY, or a pin).',
  ],
  sections: [
    {
      id: 'header',
      title: 'Name, ID, pinned',
      items: [
        ['ID', 'The person\'s internal id (cast:…). The Director\'s forms and pins use it.'],
        ['PINNED', 'YES when a pin on the Director freezes this person: no news, no closeness drift and no arc steps about them until you unpin.'],
      ],
    },
    {
      id: 'who',
      title: 'Who they are',
      where: 'WHO panel',
      text: [
        'Their relation to him (flatmate, coworker, manager, family:<role>, friend…), the label he uses for them (from the dating stage on, a partner label such as Dating or Partner), their age, pronouns, job and employer, their current status line, when they are usually free, their personality, how they text, their birthday and, for someone added later, who he met them through (MET VIA). Empty fields are left out.',
        'An AWAY chip shows while they are on a trip, with its reason when the trip has one (a heavy stretch names its theme) and the return time; trips last a few days and end on their own.',
      ],
      tips: ['These are fictional people from his world. Job, employer, pronouns, personality, speech, availability, status and birthday can be changed with EDIT CAST on the Director; the change shows here at the next refresh.'],
    },
    {
      id: 'now',
      title: 'The relationship now',
      where: 'NOW panel',
      text: [
        'Closeness, trust and tension, each from 0 to 1. The Cast page guide explains what moves each one and what it changes in his behaviour. In short: time together raises closeness, long silence slowly lowers it; trust grows when plans with them actually happen and drops when he backs out; tension eases on its own and rises when plans with them get changed or family duties get skipped.',
        'If this person is his current romantic partner, the panel head adds the romance stage and I / P / C (intimacy, passion, commitment) with the hours they have spent together.',
      ],
    },
    {
      id: 'over-time',
      title: 'Over time',
      where: 'OVER TIME panel',
      text: [
        'A chart of closeness (green), trust (cyan) and tension (red) over time, worked back from today\'s values through the person\'s relationship events: one point per day (its value at the end of that day), up to about 120 points. Reverted or rewound changes are left out, as they are in his world. It needs at least two points; until then it says NOT ENOUGH HISTORY YET.',
        'Under it, TRUST MOVED shows how far trust changed over the last 7 and 30 days (— when the chart has no point that far back). Trust is earned: kept plans raise it; backing out of plans, saying no after leaning towards going (a plain no costs nothing), skipped family occasions, breakups and lasting tension lower it (the Cast page guide has the numbers). Each change shows in EVENTS with its reasons.',
      ],
      tips: ['The chart only reaches back over his most recent relationship events (a few thousand across the whole cast), so for an old world its left edge is not the day they met. The EVENTS table still lists every relationship change.'],
    },
    {
      id: 'events',
      title: 'Events about them',
      where: 'EVENTS panel',
      text: [
        'Every world event about this person, newest first, 50 at a time (OLDER loads more): relationship changes, news in their life (beats), new shared history, edits, birthdays, family calls, and when they entered his world. Reverted or rewound events stay listed, dimmed with a REVERTED chip: they are no longer part of his world.',
      ],
      items: [
        ['#', 'The event number in his world log (the Timeline and the Director use the same numbers).'],
        ['WHAT', 'The event type, e.g. relationship.changed or a beat with its kind. A relationship change lists what moved and why, e.g. "trust −0.04 · backed out" or "closeness +0.02 · trust +0.02 · shared time · kept plan" ("owner" for the Director\'s NUMBERS).'],
        ['BY', 'Who caused it: engine (the simulation itself), jev (a quick model decision), mind (his nightly thinking), chat (something he said in a chat), or owner (you, via the Director).'],
        ['ORIGIN', 'Where the fact comes from: self (his own life), owner, or a chat kind. A dm or call origin is highlighted: that fact came from a private chat and only that chat\'s audience may hear about it.'],
        ['WHY', 'Shows the cause chain in the WHY panel: which earlier events led to this one.'],
        ['NARRATE', 'Asks a model for a short plain-language explanation of what happened and why (see Why / narration).'],
      ],
    },
    {
      id: 'history',
      title: 'Shared history',
      where: 'HISTORY panel',
      text: [
        'Their shared past: memories from his world seed, and things added later, such as an outing they went on together (one entry per outing, at most two a day; everyday things like work or meals never count) or a CAST.HISTORY scene from the Director. Outings that came from something he said in a chat are not added here.',
      ],
    },
    {
      id: 'scenes',
      title: 'History with him (scenes)',
      where: 'HISTORY WITH HIM panel; READ THE SCENE opens HOW IT WENT in a sheet',
      text: [
        'Every outing they had together that got a scene, newest first: when and where, a FIRST MEETING mark, the highlight, how it ended and the chemistry. A reverted scene stays listed, marked REVERTED. READ THE SCENE opens it in HOW IT WENT: the narration, what each of them thought (first meetings), what they talked about, the highlight and the awkward moment, the ending and what it changed between them.',
        'In write mode HOW IT WENT can REGENERATE the scene (a new version; it keeps the outcome unless you give a tone hint with its outcome; the old one and its effects are reverted — a reverted scene can be rewritten too), EDIT TEXT (the narration only; the effects stay) or REVERT THIS CHANGE (the scene and its effects; a plan or a romance it started that already happened is kept). The same panel opens from Life · Day.',
      ],
    },
    {
      id: 'standing',
      title: 'How things stand',
      where: 'HOW THINGS STAND panel',
      text: [
        'A short note on where things are between him and this person, up to 600 characters, written at night only when something has happened between them (a scene, a plan, a beat, a real move in how they stand, two or more texts). The writer of his texts and the writer of their scenes read it instead of the beats it covers (the shared history stays); the writer of their texts doesn\'t, since it\'s his view of things and they wouldn\'t know it. It\'s dated: anything newer still reaches them as it happens, and what\'s on the fact sheet wins over the note.',
        'It reads only his own life: their plans, the words of their scenes and texts, beats, relationship changes. Never a chat, a real person or anything near a hard stretch. Explicit words never reach the writer of the note.',
        'A new version closes the old one; an old one is never edited. If what a version rested on leaves his life (a revert, a rewind) it\'s marked UNDONE, with everything built on it, and rebuilt the next night; until then the writers go without it. At most ARCS_STANDING_MAX_PER_NIGHT people a night (the rest wait their turn) under ARCS_STANDING_BUDGET_USD a month; a budget stop or a bad answer leaves the old version standing.',
      ],
    },
    {
      id: 'texts',
      title: 'Texts',
      where: 'TEXTS panel',
      text: [
        'The last few texts between him and this person (his on the right, theirs on the left), newest at the bottom. OPEN THE CHAT goes to Life · Phone for the whole thread, where you can edit, rewrite or revert a message and send a new text. Only people in his world have chats; real people never do.',
      ],
    },
    {
      id: 'why',
      title: 'Why / narration',
      where: 'WHY and NARRATE on an event, in a sheet',
      text: [
        'WHY lists the chain of events that caused the selected one, oldest first, with who caused each step and its origin. A REVERTED chip marks a step that was undone.',
        'NARRATE writes a short first-person explanation built only from those events (at most the 12 closest to it). Facts from a different chat than the event\'s own are replaced by "(something from another chat)". The chips under it list the origins it used. A narration is stored, so asking again shows the same text (CACHED) and costs nothing.',
        'Narrations are for you only. They are never put into any of his prompts and never reach a chat.',
      ],
      tips: [
        'NARRATE is disabled while the dashboard is read-only (DASHBOARD_READONLY=true). It allows 2 per minute, and ARCS_NARRATE_MAX_PER_HOUR (20) / ARCS_NARRATE_MAX_PER_DAY (100) in total. Over those caps, or over the model budget, it shows an error instead of text.',
      ],
    },
  ],
};
