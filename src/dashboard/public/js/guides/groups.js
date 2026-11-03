// Guide: Groups (pages/groups.js). Plain data, see components/guide.js.
export default {
  title: 'Groups',
  intro: [
    'Every WhatsApp group he is in, one row each. This page only shows things: nothing here changes him. Click a group\'s name to open its page, where the controls are (mute, imitate, vibe, force a reply).',
    'The counters at the top: TOTAL groups, ACTIVE (not muted) and MUTED.',
  ],
  sections: [
    {
      id: 'registry',
      title: 'The table',
      where: 'ALL GROUPS panel',
      text: ['Sorted by the group\'s last activity, newest first.'],
      items: [
        ['NAME', 'The group\'s WhatsApp name. Click it to open the group page.'],
        ['JID', 'The end of the group\'s WhatsApp id (the full id is on the group page).'],
        ['VIBE', 'A short description of the group\'s mood that he learned from its chat (or that you typed on the group page). It goes into his prompt for that group as "Vibe: …", so it shapes how he talks there.'],
        ['MEMBERS', 'How many members the last membership sync found.'],
        ['MSG·30D', 'Messages stored for this group over the last 30 days (his own included).'],
        ['LAST', 'How long ago the group was last active.'],
        ['STATE', 'MUTED: he reads and keeps learning but never answers there. ACTIVE: normal.'],
      ],
    },
    {
      id: 'filter',
      title: 'Filters',
      where: 'Above the table',
      text: [
        'The search box matches a group\'s name, id or vibe. The ALL VIBES list offers the short vibe words found across groups (only for vibes written as a list of short words, like "chill, sarcastic"). Both filter what you see; nothing is saved.',
      ],
    },
  ],
};
