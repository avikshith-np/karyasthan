// Guide: Search (pages/messages.js). Plain data, see components/guide.js.
export default {
  title: 'Search',
  intro: [
    'Full-text search over every message he has stored, from all groups and DMs, his own included. It only reads: nothing here changes him.',
    'This also finds messages he is not allowed to use in replies (for example lines someone asked him to forget), as long as they are still stored. Disappearing messages are deleted when their timer runs out, so they stop showing up here too.',
  ],
  sections: [
    {
      id: 'query',
      title: 'Writing a query',
      where: 'Search box',
      text: ['Results update as you type (after a short pause), or press Enter or SEARCH. Press / anywhere on the page to jump to the box. HITS and TOOK (MS) at the top show how many results came back and how long it took.'],
      items: [
        ['word', 'Messages containing that word.'],
        ['two words', 'Messages containing both.'],
        ['"exact phrase"', 'Double quotes match the words in that order.'],
        ['OR · NOT', 'cake OR pizza; party NOT office. Write AND, OR and NOT in capitals.'],
        ['prefix*', 'A trailing * matches word beginnings: birth* finds birthday and birthdays.'],
      ],
      tips: ['A query the search engine can\'t parse (an unclosed quote, a stray operator) answers "invalid search query". Fix the query and try again.'],
    },
    {
      id: 'hits',
      title: 'Hits',
      where: 'HITS panel',
      text: ['Up to 100 matches, newest first: time, the end of the chat id, sender and the message with your words highlighted. His own messages are tinted and show his name. Media without text shows as [type].'],
    },
    {
      id: 'facets',
      title: 'Filters',
      where: 'FILTERS panel',
      text: [
        'Counts over the hits that came back: the top chats (by the end of their id), the top senders, and how many hits are from the last 24 hours, 7 days and 30 days. Click a chip to refine; the active chip is highlighted and clicking it again clears it. HITS then shows shown/loaded.',
      ],
      items: [
        ['BY GROUP', 'Runs the same query again inside that one chat, so you get up to 100 hits from it (not just the ones that were in the first 100). Clears a sender or date refinement; it stays on for new queries until you click the chip again.'],
        ['BY SENDER · BY DATE', 'Filter the hits already loaded, in the page: only that sender\'s hits, or only the last 24 h / 7 d / 30 d. They can be combined with each other and with a group. Changing the query clears them.'],
      ],
    },
  ],
};
