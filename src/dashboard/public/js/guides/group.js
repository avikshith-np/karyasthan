// Guide: Group (pages/group.js). Plain data, see components/guide.js.
export default {
  title: 'Group',
  intro: [
    'Everything about one WhatsApp group: what he knows about it, who is in it, its recent messages, and the controls to steer him there (vibe, language, mute, imitate a member, force a reply, sticker, GIF or voice note).',
    'The header shows ACTIVE or MUTED, and IMITATING with the member\'s name while he is playing a member.',
    'Every control here is a write. With the dashboard read-only (DASHBOARD_READONLY=true, the default) the buttons answer with an error and nothing changes. Every write is recorded on the Audit page.',
  ],
  sections: [
    {
      id: 'focus',
      title: 'What he knows about the group',
      where: 'ABOUT THIS GROUP panel, top',
      items: [
        ['VIBE', 'The group\'s mood in a few words. It goes into his prompt for this group, so it shapes his tone here. "learned" means his batch learning (every 100 messages) wrote it and may write a new one; "set by owner" means you saved it here, and learning leaves it alone until you hand it back.'],
        ['LANG', 'The group\'s main language. When it is not English (en) his prompt says "Mostly <language>. Match this." Learning never sets it, so it is either "default" (en) or "set by owner" (the LANGUAGE box under CONTROLS).'],
        ['MEMBERS', 'Members found by the last membership sync (on every connect and every 3 hours).'],
        ['SYNCED_AT', 'When the member list was last synced. "fresh" means it is recent enough (7 hours) for things learned here to be used in other chats whose members are all in this group. "stale" or "never": everything learned here stays in this chat only, until a sync succeeds.'],
        ['AVG_MSG_HR · LAST_ACTIVE · JOINED', 'How busy the group is, when it last had activity, and when he joined it.'],
      ],
    },
    {
      id: 'slang',
      title: 'Slang and nicknames',
      where: 'ABOUT THIS GROUP panel',
      items: [
        ['SLANG', 'Words and phrases he picked up, with how often they were used. Hover to see where it was heard and what it means. A ★ marks a term heard in another chat that he treats as having one general meaning.'],
        ['NICKNAMES · LEARNED HERE', 'Nicknames for members learned in this group, shown as nickname → name. Hover to see how it was learned.'],
      ],
      tips: ['These are read-only here. To correct a person, use their person page (owner profile) or the Memories page.'],
    },
    {
      id: 'vibe',
      title: 'Vibe and language',
      where: 'CONTROLS panel, at the top',
      text: [
        'Type a short description and press SAVE VIBE. It takes effect on his next reply in this group and is marked SET BY OWNER: his batch learning no longer replaces it. HAND BACK TO LEARNING drops that mark; your text stays until the next batch-learning pass writes its own. Saving an empty box clears the vibe and hands it back.',
        'SAVE LANGUAGE works the same way for the group\'s main language (a word like English or Hindi; en is the default and adds nothing to his prompt). RESET TO DEFAULT, or saving an empty box, puts it back to en.',
        'A vibe or language you saved before these marks existed is marked at the bot\'s next start, from the audit log, if it is still the value you saved (not if you handed it back or learning has replaced it since).',
      ],
      items: [
        ['SET BY OWNER', 'You saved it on this page. Learning leaves it alone.'],
        ['LEARNED · DEFAULT', 'Learning wrote the vibe (or nobody has yet); the language is the default.'],
      ],
    },
    {
      id: 'mute',
      title: 'Mute and unmute',
      where: 'CONTROLS panel, at the top',
      text: [
        'MUTE stops him from answering in this group at all: no replies, reactions, catch-up replies or opener messages from the mind. He still reads the group and keeps learning from it. With the life simulation on, the messages are marked read at his next phone check.',
        'Type a number of minutes for a timed mute, or leave the box blank to mute until you press UNMUTE. Zero or a negative number is refused. A timed mute ends on its own. Mutes survive a restart.',
      ],
      tips: ['FORCE REPLY, SEND STICKER, SEND GIF and SEND VOICE below still work in a muted group: they skip mute, warmup and the rate limits.'],
    },
    {
      id: 'imitate',
      title: 'Imitate a member',
      where: 'CONTROLS panel, at the top',
      text: [
        'Pick a current member and press IMITATE. While it lasts he writes in that member\'s style in this group (their words, message length, emoji and casing habits, catchphrases, language mix), built from their own past messages in this group. His identity files are never changed. He also answers to that member\'s names, uses their favourite emojis for reactions and (with enough history) follows their active hours.',
        'Minutes: blank means the maximum (IMITATE_MAX_MINUTES). Every imitation ends on its own; there is no "forever". STOP IMITATING ends it at once.',
      ],
      items: [
        ['Refused when', 'the person is not a current member of this group, or they have fewer than IMITATE_MIN_MESSAGES (default 40) messages in this group.'],
        ['Ends on its own when', 'the time runs out, or the person leaves the group.'],
        ['Master switch', 'The imitate skill on the Skills page. If it is off, a set imitation does nothing (he answers as himself) until you turn the skill back on. After a restart the skill goes back to IMITATE_MODE_ENABLED; unexpired imitations are kept.'],
        ['Warmup', 'On a new install warmup holds back text replies, so imitation has no visible effect until warmup allows text. The page says so when that is the case.'],
        ['Disclosure', 'With IMITATE_ANNOUNCE=true he posts a one-time note in the group that he is channelling that person.'],
      ],
      tips: [
        'Guardrails in code: never in DMs, no asking for money, OTPs or passwords, nothing that damages the person\'s reputation. If the imitated person talks to him, he plays their double.',
        'Imitated replies are left out of his quality learning, so they never change how he writes as himself.',
      ],
    },
    {
      id: 'imitate-voice',
      title: 'Their voice (cloned voice notes)',
      where: 'CONTROLS panel, at the top',
      text: [
        'Tick THEIR VOICE before IMITATE (or press USE THEIR VOICE afterwards) to make his voice notes in this group use that member\'s cloned voice while the imitation lasts.',
        'This only works if the member enrolled their own voice: by DMing the bot "voice enroll", or with their two recordings uploaded on their person page. Without one the tick is ignored, and USE THEIR VOICE is refused with a hint.',
      ],
      items: [
        ['CLONED VOICE ON / OFF · n/max notes', 'Whether cloned voice notes are on, and how many were sent in this imitation against IMITATE_VOICE_MAX_PER_SESSION (∞ = no per-session cap). A new imitation starts the count again.'],
        ['imitate-voice skill is OFF', 'The global switch on the Skills page is off, so no cloned voice is used even with the box on.'],
      ],
      tips: ['Every cloned-voice note passes a strict quality check first; if the check fails or errors, nothing is sent. Singing is never done in a cloned voice. With IMITATE_ANNOUNCE=true turning the voice on posts a note in the group.'],
    },
    {
      id: 'force',
      title: 'Force a reply, sticker, GIF or voice note',
      where: 'CONTROLS panel, at the top',
      text: ['One-off sends to this group, answering its latest message. They skip mute, warmup, rate limits and his decision to stay quiet. DRY_RUN is still honoured (nothing is really sent).'],
      items: [
        ['FORCE REPLY', 'With the box empty he writes a reply to the latest message (plain text, no web lookups). With text in the box, that exact text is sent. A forced reply is always in his own voice, even while imitating.'],
        ['SEND STICKER / SEND GIF', 'He picks a search phrase from the recent chat and sends a matching sticker or GIF. Needs GIPHY_API_KEY. The flash message shows the phrase used.'],
        ['SEND VOICE', 'Empty box: he writes a short voice note for the moment. With text: he speaks that text. SING makes it a short sung bit. Needs voice notes on (VOICE_NOTE_ENABLED) and a Gemini key. Can take up to 2 minutes.'],
        ['SEND VOICE while imitating', 'If this group is imitating someone with their voice on, the note is written as them and spoken in their cloned voice, after the strict check (blocked → nothing sent). SING is refused then.'],
      ],
      tips: ['The bot must be connected to WhatsApp, and the group must have at least one message.'],
    },
    {
      id: 'calls',
      title: 'Phone calls with the group\'s context',
      where: 'ABOUT THIS GROUP panel · PHONE CALL, and CALL HISTORY',
      text: [
        'CALL next to a member rings that person; on the call he talks with this group\'s context. It is refused when the person is not a current member of this group or the member list is not freshly synced (call them from their person page instead). Calls need the calls skill on.',
        'A live call shows here with its transcript and a HANG UP button. CALL HISTORY lists past group-context calls; click a row for the summary and transcript.',
      ],
    },
    {
      id: 'messages',
      title: 'Last messages',
      where: 'LAST MESSAGES panel',
      text: ['The 12 newest messages stored for this group, his own in red. Media shows as [type].'],
    },
    {
      id: 'members',
      title: 'Members',
      where: 'MEMBERS panel',
      text: ['Members from the last sync with their role and the short profile he learned about them in this group only. Click a name for the person page. CALL rings them with this group\'s context (see Phone calls).'],
    },
    {
      id: 'memories',
      title: 'Group memories',
      where: 'GROUP MEMORIES · LEARNED HERE panel',
      text: [
        'Up to 20 things he remembers from this group: category, content, who may hear it (the audience) and importance (0 to 1).',
        'The audience column says where the memory can come up: this group, plus DMs and smaller groups of its members who were already in this group when it was learned. With a stale member list it stays in this group only.',
      ],
      tips: ['Edit or delete memories on the Memories page.'],
    },
  ],
};
