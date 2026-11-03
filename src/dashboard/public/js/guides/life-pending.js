// Guide: Life · Pending (pages/life-pending.js). Plain data, see components/guide.js.
export default {
  title: 'Pending',
  intro: [
    'Pending holds the "Ask me" cards: decisions in his life that wait for you before they are made, and veto cards for hard stretches that are about to start. If you do nothing, his life goes on without you: a decision follows his lean at the deadline, and a heavy stretch starts at its onset.',
    'The page refreshes every 15 seconds and the countdowns tick every second on his life clock.',
    'Claims he made in chats that could not be placed (the claim tray) are not here: they are on the Director page.',
  ],
  sections: [
    {
      id: 'basics',
      title: 'Before you start',
      items: [
        ['OPEN', 'Decision cards still waiting for you.'],
        ['VETO', 'Heavy stretches that can still be vetoed.'],
        ['SHOW CLOSED', 'Also show cards closed in the last 3 days, with how each one ended.'],
        ['READ-ONLY', 'While DASHBOARD_READONLY=true every pick and veto button is disabled. Both also need the life simulation and the arcs skill on.'],
      ],
      tips: ['A pick or a veto is applied at once, after a confirmation, with no Director preview: each is one event with a fixed effect.'],
    },
    {
      id: 'when',
      title: 'Which decisions ask you',
      text: [
        'Most small decisions (go out tonight or not, how to spend an evening) are made by the simulation on its own. A decision becomes a card when:',
      ],
      items: [
        ['BIG', 'It is a big step: a job offer, a breakup, a major family occasion or family decision, or a big romance step (committing to a partner, getting engaged, getting married). Big decisions open at least ARCS_BIG_LEAD_HOURS (24 by default) before their deadline so you have time to see them.'],
        ['GUIDED', 'Its category\'s fate is GUIDED on the Director, so every arc decision there asks you.'],
        ['DOWNGRADED', 'A big decision that came up too close to its deadline for a card. It runs as a normal decision instead, and the chip says why.'],
      ],
    },
    {
      id: 'cards',
      title: 'Decision cards',
      text: ['Each card shows the category and kind, the question, the deadline and the options.'],
      items: [
        ['DECIDE BY', 'The deadline, with a live countdown. "no return after" is the point of no return: after it an option like going somewhere is gone because he could no longer get there in time.'],
        ['Lean', 'The option he currently leans towards, with its probability p and who formed the lean: JEV (a quick model judgement) or ENGINE (code). A FALLBACK chip means the code made the lean because the model was not available or over its cap. The small chart is how the lean moved over time.'],
        ['Options', 'Click one to pick it. The lines under an option are what it costs him: energy, money, social energy, stress and travel minutes. The option he leans towards is highlighted. An option shows "until" and a countdown when it closes before the deadline; EXPIRED options can no longer be picked.'],
        ['Silence', 'If nobody picks, at the deadline he takes the option he leans towards most. An "Ask me" card never commits early on its own.'],
      ],
      tips: [
        'Your pick is final: it commits the decision at once and he will not change his mind on it later, unlike his own decisions.',
        'A pick can be refused when the decision was already made or closed, or the option expired meanwhile. The page then reloads with the current state.',
      ],
    },
    {
      id: 'invites',
      title: 'Invitations from chats',
      text: [
        'With the chat-influence skill on (and its INVITES area), when someone in a chat invites him to something ("cinema at 8?") and the invitation can be placed in his world (today or tomorrow, a place he knows or the usual place for that kind of outing, no clash with work or sleep), it opens a small go / join later / stay in decision. He answers it in his reply: yes and no commit it, maybe leaves it open to lean like any other decision until a later yes or no from him settles it. An invitation he never answers expires at its deadline. This table lists the recent ones; it never shows the message itself.',
      ],
      items: [
        ['INVITATION', 'What it is about, built from the kind of outing and the place (never the chat\'s words), and when. ASK ME: the social category is GUIDED on the Director, so it is also a card above.'],
        ['HIS ANSWER', 'How his reply answered it: said yes, will come later, said no or said maybe. Empty while he has not answered.'],
        ['STATE', 'WAITING FOR HIS ANSWER, OPEN · LEANING (after a maybe), COMMITTED · GOING / GOING LATE / STAYING IN, or how it closed (EXPIRED when nobody answered, CANCELLED when the inviter called it off or it was withdrawn).'],
        ['FOLLOW-UP', 'After a maybe that he later decided (or when he changed his mind), he gets back to them once at his next phone check, through the normal reply path (mute, warm-up, rate limits and DRY_RUN apply). sent, skipped (the turn ran but nothing went out) or dropped (the chat moved on, he already said it — also a yes or no he wrote after his maybe —, the inviter cancelled, the inviter of a DM no longer shares a group with him, too late).'],
        ['DECISION', 'The decision\'s id; find it on the Timeline, where it (and everything it caused) can be reverted.'],
      ],
      tips: ['A forgotten, deleted or edited invitation message withdraws the decision and everything that followed from it. The same goes for the inviter\'s "can\'t make it" message: undoing it undoes the push towards staying in (and a commit that came from it); its follow-up stays dropped.'],
    },
    {
      id: 'closed',
      title: 'How a card ended',
      text: ['Closed cards (with SHOW CLOSED) show the chosen option and how it was chosen:'],
      items: [
        ['you picked', 'You chose it on this page.'],
        ['silence → the lean', 'Nobody picked, so his lean won at the deadline.'],
        ['sampled', 'An ordinary decision settled by chance weighted by his lean.'],
        ['committed early', 'He was sure enough to decide before the deadline (only for decisions that were not "Ask me").'],
        ['adopted from a chat', 'It came from something he said in a chat.'],
        ['his answer in a chat', 'An invitation from a chat that he answered yes or no in his reply.'],
      ],
    },
    {
      id: 'veto',
      title: 'Heavy veto cards',
      text: [
        'A heavy stretch is something hard in his life: an illness in the family, a breakup, a friend moving away, a pet loss, a minor accident or a money setback. It is announced ahead: the onset is ARCS_BIG_LEAD_HOURS (24 h by default) plus up to 12 h after it was rolled. The card shows the kind, a short label and the onset with a countdown.',
        'During a heavy stretch his mood and energy are lower, he talks about it only in private chats (DMs and calls), and he does not joke about it in that time.',
      ],
      items: [
        ['VETO', 'It never happens. Only possible before the onset.'],
        ['Do nothing', 'It starts at the onset, unless it can no longer apply then (for example the story is paused or the situation it needed has changed), in which case it lapses and nothing happens.'],
      ],
      tips: [
        'Heavy stretches are rare (about one every two years at the default sliders) and at least 90 days apart. A vetoed one still counts for that gap. To make them rarer or stop them, use the HEAVYLIKELIHOOD slider or freeze the heavy category on the Director.',
      ],
    },
  ],
};
