// Guide: Memories (pages/memories.js). Plain data, see components/guide.js.
export default {
  title: 'Memories',
  intro: [
    'Memories are the facts he has learned about people and chats ("she just started a new job", "the group\'s running joke about the trip"), plus notes you add yourself. They are what he remembers when he replies.',
    'Every memory carries where it was learned (its origin) and so who may hear it. That privacy rule is enforced when he builds a reply: something learned in a DM stays in that DM, something learned in a group only reaches chats whose members were all in that group when it was learned. This page shows you everything, unfiltered.',
    'Changes need the dashboard to be writable (DASHBOARD_READONLY=false). Every create, edit and delete is recorded on the Audit page.',
  ],
  sections: [
    {
      id: 'filters',
      title: 'Filters and counts',
      where: 'Header, filter bar and tiles',
      text: [
        'The page loads the newest 300 current memories. Expired ones are hidden, and so are superseded ones (an older version of a fact that a newer one replaced) unless you tick SUPERSEDED, which shows them faded with the id that replaced them.',
        'The text box, category and origin filters work on those loaded rows only. Every count in the header and the tiles is over the loaded rows too, not the whole database.',
      ],
      items: [
        ['LOADED / FACT / TEMP / INTEREST', 'Loaded rows, and how many of them are in each category.'],
        ['MEMORIES · LOADED', 'The number of loaded rows (same as LOADED).'],
        ['RECALLS · LOADED', 'How many times the loaded memories were pulled into a reply, summed.'],
        ['EXPIRING · 24H', 'Memories with an expiry in the next 24 hours (mostly "temporary" ones, like "he is travelling this week"). They disappear on their own.'],
        ['LOW-CONFIDENCE', 'Memories with importance under 0.30. Low importance means they are less likely to be picked for a reply; worth a glance to delete junk.'],
      ],
      tips: ['Categories: fact, event, temporary, interest, lore (group in-jokes and history), preference. Daily and weekly episodes written by the mind show up here with category "episode" (filterable; you cannot create one by hand).'],
    },
    {
      id: 'add',
      title: 'Add an owner note',
      where: '+ ADD NOTE',
      text: [
        'Tell him something yourself. A note\'s origin is always "owner"; you cannot make a note look as if it came from a chat.',
      ],
      items: [
        ['CATEGORY', 'What kind of memory it is (see Filters).'],
        ['SUBJECT_JID', 'The WhatsApp id of the person it is about (shown on their person page, opened from the People page). Required unless the note is for everywhere. An unknown id is refused.'],
        ['WHO HEARS IT', '"Their DM only" (the default): he only uses it when talking to that person directly. "DM + outsider-free groups they\'re in": also in groups that person is in, as long as everyone in the group is a known member. "Everywhere": any chat. A note without a subject must be "everywhere".'],
        ['CONTENT', 'The fact itself, up to 1000 characters.'],
        ['IMPORTANCE', '0 to 1 (default 0.5). Higher makes it more likely to be picked for a reply.'],
        ['EXPIRES_IN_DAYS', 'Optional. After that many days the note expires and is no longer used.'],
      ],
      tips: [
        'Something a person asked him to forget cannot be added back: the note is refused.',
        'If an equal note already exists it is merged into it instead of duplicated.',
      ],
    },
    {
      id: 'ledger',
      title: 'All memories',
      where: 'ALL MEMORIES panel',
      text: ['Newest first. One row per memory.'],
      items: [
        ['CAT', 'Category. Temporary ones are highlighted.'],
        ['SUBJECT', 'The person it is about, if any.'],
        ['ORIGIN', 'Where it was learned: group (name of the group), dm (DM with someone), call (a call with someone, which counts as their DM), ig (the Instagram group), owner (your note), self (about himself). DM and call origins are highlighted because they are the most private.'],
        ['CONTENT', 'The memory text.'],
        ['AUDIENCE', 'A plain reading of who may hear it, for example "DM with X only", or a group plus the DMs of its members who joined before it was learned. "Membership not synced" means he has no fresh member list for that group, so it stays in that group only. A memory derived from several chats is only usable where every one of them allows it.'],
        ['IMP', 'Importance, 0 to 1.'],
        ['RECALL', 'How often it was used in a reply, and when last.'],
        ['LEARNED', 'When the evidence for it was said (hover for the creation time and source).'],
        ['EXPIRES', 'When it expires, if ever.'],
      ],
    },
    {
      id: 'edit',
      title: 'Visibility and delete',
      where: 'Row controls',
      items: [
        ['VISIBILITY (owner notes only)', 'A dropdown in the AUDIENCE column of your own notes. Widening it beyond "their DM only" asks you to confirm. Learned memories have no dropdown: they always follow the chat they came from.'],
        ['DEL', 'Deletes the memory and its evidence links at once, after a confirm, the same way "forget that" does: a learned memory is tombstoned, so the next learning pass cannot write the same claim from that chat again, and the mind reacts (a deleted episode\'s night is never rebuilt; drafts made since the memory existed are dropped). Owner notes are deleted without a tombstone. Audited with the id only.'],
      ],
      tips: ['The tombstone matches the same wording from the same chat. A differently worded version of the claim can still be learned later; for a person who wants something gone from a DM, "forget that" also fences their last messages.'],
    },
    {
      id: 'relays',
      title: 'Relays · DM to group',
      where: 'RELAYS panel',
      text: [
        'A relay is the one way words from a DM can reach a group: someone DMs him "tell the group I\'m running late", he checks that they are a current member of that group, asks them to confirm, and then posts it in the group in his own words. This list is read-only and shows every request and what happened to it. Use the state filter to narrow it.',
      ],
      items: [
        ['PENDING', 'Waiting for the person to confirm in the DM. Expires after 10 minutes.'],
        ['CONFIRMED', 'Confirmed; being posted.'],
        ['SENT', 'Posted in the group (or logged only, under DRY_RUN).'],
        ['DECLINED', 'Not confirmed in his reply (not_confirmed), his reply was never sent (reply_not_sent or turn_stale), or replaced by a newer request from the same person (superseded). The reason shows after the content.'],
        ['EXPIRED', 'More than 10 minutes passed before it was confirmed or posted.'],
        ['FAILED', 'Confirmed but not posted: the group is muted, the person is no longer a member, warmup or the rate limit blocked it, the quality gate refused the text, he decided not to write it, or sending failed. The reason shows after the content, and he tells the person in the DM.'],
      ],
      tips: ['Requests he refuses up front (it would expose someone else, the group is unclear, too many requests this hour) never become a row: he just says no in the DM.'],
    },
  ],
};
