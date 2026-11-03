// Guide: Life · Journal (pages/life-journal.js). Plain data, see components/guide.js.
export default {
  title: 'Journal',
  intro: [
    'His journal: a few private diary lines for each night of his simulated life, written in his own words while he sleeps. It is for you only. The journal is never put into any of his prompts, so nothing written here can reach a chat or change what he says.',
    'The page refreshes every 60 seconds. It needs the life simulation and the arcs skill on; ARCS_JOURNAL_ENABLED switches the nightly writing on or off.',
  ],
  sections: [
    {
      id: 'header',
      title: 'Night and status',
      items: [
        ['NIGHT', 'The date of the day the entry is about (the night after that day). The latest night is shown unless you pick another one.'],
        ['STATUS', 'How writing that night went, with a reason when there is one (see Nights).'],
      ],
    },
    {
      id: 'night',
      title: 'The night',
      where: 'THE NIGHT panel',
      text: [
        'An entry is written once he has been asleep for at least 30 minutes. It has up to six parts: one about his own day, and one for each chat (at most five) where something he said became part of that day, such as a plan he mentioned that was adopted into his life. Each part carries an origin badge: self for his own day, or the kind of chat it came from.',
        'The parts are written by a model from short facts the code builds (what happened, places, first names of his cast). No chat text and no real names are given to it, and a part that invents a name is thrown away.',
      ],
      items: [
        ['active', 'A normal part.'],
        ['UNDONE', 'Something it described was reverted or rewound since. A night up to 7 days old is rewritten once from what is left.'],
        ['FENCED', 'The chat it came from had messages forgotten, deleted or edited, or a person in it was purged. The text is erased and is never rebuilt.'],
      ],
      tips: [
        'PUBLISH (public site, spec 013) puts this night\'s self part on the public site: the text is frozen as it is now, every real venue\'s name is replaced by its kind ("a cafe", "a restaurant" — again at every export), it is checked for names and numbers, and shown on the site\'s Journal page from the next export. Chat parts are never published. A published night shows PUBLIC in Nights; UNPUBLISH takes it off at the next export. Regenerating a published night does not change the published copy; unpublish and publish again to update it.',
        'REGENERATE THIS NIGHT rewrites every part of the shown night except fenced ones. It asks to confirm and allows 2 per hour. If the rewrite fails, the old entry\'s status is kept. Disabled while the dashboard is read-only (DASHBOARD_READONLY=true).',
      ],
    },
    {
      id: 'nights',
      title: 'Nights',
      where: 'NIGHTS panel',
      text: ['The last 60 nights. Click a date to show it. The count is how many active parts it has.'],
      items: [
        ['DONE', 'Written.'],
        ['PARTIAL', 'Some parts were written, others failed, were rejected, or were dropped because a cap or the budget ran out.'],
        ['FAILED', 'The model calls failed. It is retried once more.'],
        ['SKIPPED', 'Nothing was written: nothing happened worth writing (NOTHING), the model budget for it was used up (BUDGET), or the daily cap ARCS_CLERK_MAX_PER_DAY, shared with claim extraction, was reached (CAP). Not retried.'],
        ['MISSED', 'The bot was not running that night (DOWNTIME). Missed nights are not written later on their own (REGENERATE can still try one).'],
        ['RUNNING', 'Being written right now.'],
      ],
      tips: ['ARCS_JOURNAL_MAX_CALLS caps the model calls per night and ARCS_JOURNAL_MAX_CHARS the total length; when the room runs out, chat parts are dropped first.'],
    },
    {
      id: 'thought',
      title: 'What\'s on his mind',
      where: 'WHAT\'S ON HIS MIND panel',
      text: [
        'NARRATE asks a model for a short first-person line about what he is thinking right now, built only from his own life: what he is doing and feeling, and what happened to him in the last 6 hours. Nothing from chats is used.',
        'The answer is stored for an hour, so pressing again within that time shows the same text (CACHED) and costs nothing. Like the journal, it is for you only and never reaches a prompt or a chat.',
      ],
      tips: ['Disabled while read-only. It allows 2 per minute and ARCS_NARRATE_MAX_PER_HOUR (20) / ARCS_NARRATE_MAX_PER_DAY (100) in total; over a cap or the budget it shows an error instead.'],
    },
  ],
};
