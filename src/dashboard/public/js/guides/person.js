// Guide: Person (pages/person.js). Plain data, see components/guide.js.
export default {
  title: 'Person',
  intro: [
    'Everything he knows about one person, and where he learned each piece. You see all of it here. He does not: in a chat he only uses what that chat is allowed to see. Something learned in a DM stays in that DM; something learned in a group can reach a smaller chat only if everyone there was already in that group when it was learned.',
    'The edit form, merges, purge, calls and the cloned voice are writes. With the dashboard read-only (DASHBOARD_READONLY=true, the default) they answer with an error and nothing changes. Every write is recorded on the Audit page.',
  ],
  sections: [
    {
      id: 'dossier',
      title: 'Profile',
      where: 'PROFILE panel, top',
      items: [
        ['REAL_NAME', 'A name you set. He uses it in chats only when the person has no WhatsApp display name.'],
        ['OWNER SUMMARY · TRAITS · INTERESTS · VISIBILITY', 'Your own notes about the person (the owner profile, see below) and who may hear them.'],
        ['NICKS', 'Nicknames, each with where it was learned (hover for the chat).'],
        ['IDENTITIES', 'The WhatsApp ids that belong to this person. WhatsApp can show one person under a phone-number id and a private id; these are tied together here.'],
        ['MESSAGES', 'How many messages they have sent.'],
      ],
    },
    {
      id: 'owner',
      title: 'Owner profile (your notes) and who may hear it',
      where: 'PROFILE panel · EDIT',
      text: [
        'Summary, traits and interests in this form are YOUR profile of the person, kept apart from what he learned in chats. Traits and interests are comma separated. SAVE OWNER PROFILE sends only the fields you changed. He can use your notes in his replies, but only where the visibility allows:',
      ],
      items: [
        ['their DM only (default)', 'Only in his 1:1 chat or a call with this person.'],
        ['their DM + outsider-free groups they\'re in', 'Also in groups this person is in, if every member of the group is known and the member list is freshly synced.'],
        ['everywhere', 'In any chat, including ones this person is not in. Think before choosing this.'],
      ],
      tips: [
        'Widening the visibility asks you to confirm. The audit log records which fields changed and the visibility change, never the text.',
        'Learned profiles (one per chat, in PROFILE BY ORIGIN) can\'t be edited here. To add a single fact as an owner note, or to fix or delete a memory, use the Memories page.',
      ],
    },
    {
      id: 'merges',
      title: 'Identity merges: pending and rejected',
      where: 'PROFILE panel · IDENTITY MERGES',
      text: [
        'Sometimes WhatsApp shows the same person under two ids. When either side has private data (DM messages, things learned in a DM or call, or your notes), he does not merge them on his own, because a recycled phone number can belong to a stranger. The merge waits here: keep X · merge in Y, with the reason.',
      ],
      items: [
        ['APPROVE', 'Merges the two into one person: their DM histories, memories and profiles become one. This can\'t be undone. Asks to confirm.'],
        ['REJECT', 'Keeps them as two people. The pair moves to IDENTITY MERGES · REJECTED and is not asked about again, whichever way WhatsApp reports the pairing (a message, the membership sync or a lid-mapping all count as the same fact). Only evidence of another kind brings it back to the pending list: a reason that starts differently, e.g. conflict:… after you rejected dm_data:….'],
        ['REJECTED', 'Pairs you rejected that involve this person, with the reason they were queued and when you rejected them.'],
      ],
      tips: ['Limited to 10 decisions a minute.'],
    },
    {
      id: 'purge',
      title: 'Purge person',
      where: 'PROFILE panel · FORGET',
      text: [
        'Deletes everything remembered about this person: memories about them or learned in their DM and calls, all profile facets, nicknames, relationships, style cards built from their messages, call summaries and transcripts, the text of relays they asked for, any imitation of them, and their identity links. Traces of them in his mind and in the life simulation are removed too. The chat messages themselves stay.',
        'This can\'t be undone. It asks to confirm, is limited to 10 a minute, and is audited with a count only. If the person is no longer in any of his groups, their record goes too and this page then shows "not found".',
      ],
      tips: ['A cloned voice goes too: purge revokes it at once (never used again) and deletes it at the voice provider. If the provider can\'t be reached the voice stays revoked, marked "Google delete pending", and maintenance retries every 6 hours until the delete goes through.'],
    },
    {
      id: 'calls',
      title: 'Phone calls (1:1)',
      where: 'PROFILE panel · PHONE CALL, and CALL HISTORY panel',
      text: ['CALL rings this person; on the call he uses your 1:1 chat with them as context. It is offered only when a callable number is known. A live call shows its transcript and HANG UP. CALL HISTORY lists their 1:1 and inbound calls; click a row for the summary and transcript. Calls need the calls skill on.'],
    },
    {
      id: 'voice',
      title: 'Cloned voice',
      where: 'PROFILE panel · CLONED VOICE',
      text: [
        'A cloned voice lets him send voice notes in this person\'s voice, and only while he is imitating them in a group where "use their voice" is on (see the group page). Enrolling it is consent: it needs their own recordings.',
      ],
      items: [
        ['ENROLLED', 'Shows how it was enrolled, when, and when it expires.'],
        ['DELETE VOICE', 'Revokes it and deletes it at the voice provider. Always allowed. It is revoked at once even if the provider can\'t be reached; then it shows "Google delete pending" and maintenance retries the delete every 6 hours.'],
        ['Enroll here', 'Upload two recordings made by the person: 1) 10 to 30 seconds of them talking naturally, 2) them reading the consent sentence shown, in the chosen language (it starts on the one that matches his persona\'s language, else English). Tick the confirmation and press ENROLL VOICE. The provider checks that both are the same speaker, and refuses otherwise. Enrolling again replaces their voice: the old one is deleted at the provider first, and if that delete fails the enrollment is refused (the current voice, or its pending delete, stays as it was) — try again later.'],
        ['Or by DM', 'The person can DM the bot "voice enroll" and follow the steps.'],
      ],
      tips: ['The recordings are not kept; only the voice id is stored. Voices of people who left every group are deleted by maintenance.'],
    },
    {
      id: 'public',
      title: 'Public site',
      where: 'PROFILE panel · PUBLIC SITE',
      text: [
        'Whether this person may appear by name on the public site (spec 013). It is off for everyone until you switch it on here. While it is off, any plan or outing they share with him shows on the site as "out with a friend" and nothing else about them.',
      ],
      items: [
        ['SHOW ON PUBLIC SITE', 'On: the site shows the display name below wherever they are part of his day, and lists them under his friends. Never a surname, photo, number, chat or what was said.'],
        ['DISPLAY NAME', 'The name the site uses, up to 40 letters. Defaults to their first name. It is checked like everything else on the site.'],
        ['Turning it off', 'The name is gone from the next export (a few minutes), on every page of the site: the site only ever shows the latest snapshot. Purging the person removes the setting too.'],
      ],
    },
    {
      id: 'facets',
      title: 'Profile by origin',
      where: 'PROFILE BY ORIGIN panel',
      text: [
        'One row per place he built a profile of them: your owner profile first (with its visibility), then one per chat it was learned in. The ORIGIN chip says the kind (dm and call in amber, since those stay private) and the chat. In a chat he combines only the rows that chat is allowed to see.',
      ],
    },
    {
      id: 'memories',
      title: 'Memories',
      where: 'MEMORIES panel',
      text: [
        'Up to 50 things he remembers about them: category (temporary ones in amber, they expire), content, where it was learned, who may hear it (the audience) and importance (0 to 1).',
      ],
      tips: ['Edit, delete or add owner notes on the Memories page.'],
    },
    {
      id: 'relationships',
      title: 'Relationships',
      where: 'RELATIONSHIPS panel',
      text: ['How this person relates to others he knows (relationship, dynamic), where that was learned and a strength from 0 to 1. The same privacy rule applies when he uses them.'],
    },
    {
      id: 'recent',
      title: 'Recent messages',
      where: 'RECENT MESSAGES panel',
      text: ['The 15 newest messages they sent, from any chat and any of their ids.'],
    },
  ],
};
