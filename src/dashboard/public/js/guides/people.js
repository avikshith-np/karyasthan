// Guide: People (pages/people.js). Plain data, see components/guide.js.
export default {
  title: 'Contacts',
  intro: [
    'Everyone he has seen in his chats (up to 200, most recently seen first). This page only shows things. Click a name to open the person page, where you can edit your own notes about them, approve identity merges, purge them or manage a cloned voice.',
    'TOTAL is how many are listed, RECENT how many were seen in the last 7 days, SHOWING how many match the filter.',
  ],
  sections: [
    {
      id: 'registry',
      title: 'The table',
      where: 'ALL CONTACTS panel',
      items: [
        ['NAME', 'The real name you set, else their WhatsApp display name. Click to open the person page.'],
        ['HANDLE', 'Their phone number, partly masked.'],
        ['TRAITS · INTERESTS', 'The first three, merged from everything known about them: your owner profile first, then what he learned in each chat. He himself only uses the parts the current chat is allowed to see.'],
        ['MSG', 'How many messages they have sent in his chats.'],
        ['LAST', 'How long ago they were last seen.'],
      ],
    },
    {
      id: 'filter',
      title: 'Filters',
      where: 'Above the table',
      text: ['The search box matches name, traits and interests. ALL TRAITS narrows the list to people with one exact trait. Filters change only what you see.'],
    },
  ],
};
