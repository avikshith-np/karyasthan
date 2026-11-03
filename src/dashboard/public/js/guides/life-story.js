// Guide: Life · Story (pages/life-story.js). Plain data, see components/guide.js.
export default {
  title: 'Story',
  intro: [
    'The Story page is the board of his slow story lines ("arcs"), one panel per category: romance, career, family, cast, health, social and heavy. Arcs run for days to months: a romance moving through its stages, a job hunt, a family occasion, a hard stretch.',
    'Above the board are the proposals from his weekly pass that wait for your approval, then the advice people gave him in chats; when nothing waits, those panels move under the board. A category with nothing in it is one line. The page refreshes every 30 seconds. To start, move or stop arcs yourself, use the Director.',
  ],
  sections: [
    {
      id: 'header',
      title: 'The counters on top',
      items: [
        ['ACTIVE ARCS', 'Arcs that are still running, across all categories.'],
        ['STORY', 'RUNNING, PAUSED (paused on the Director: nothing new starts, open decisions still play out) or OFF (the arcs skill or the life simulation is off).'],
        ['PROPOSALS', 'How many weekly-pass proposals are waiting for you below.'],
      ],
    },
    {
      id: 'board',
      title: 'The category panels',
      text: [
        'Each panel head shows the category and its fate, set on the Director: NATURAL (green, things happen on their own), GUIDED (amber, big decisions and the weekly proposals ask you first) or FROZEN (red, nothing new happens in this category).',
        'Inside, each arc shows its kind, its current stage, its number (#…), since when it has been in that stage, the cast members in it (click a name for their page) and its last three beats (the stage steps, the start and end, and news in its cast\'s lives while it ran; reverted or rewound ones are left out). Up to 10 arcs per category are listed, running ones first; an ended arc is dimmed with an ENDED chip, its outcome and when it ended. The ACTIVE ARCS counter only counts running ones.',
        'An amber NEXT line under an arc is that arc\'s own next open decision and its deadline (ASK ME when it waits for you). A NEXT line at the bottom of the panel is the earliest open decision of the category that no arc above already shows. Decisions that ask you first appear as cards on the Pending page.',
      ],
      items: [
        ['NO ARC', 'Nothing in this category yet.'],
        ['inert', 'The category cannot run: his arc seed has no section for it, there is no appraisal month (career), or he has no family members in his cast (family). The arc seed is generated once from his identity; Director seed overrides can fill some values.'],
      ],
      tips: ['The heavy panel lists hard stretches (a family illness, a breakup, a friend moving away…). New ones are announced ahead as veto cards on the Pending page.'],
    },
    {
      id: 'proposals',
      title: 'Proposals awaiting approval',
      where: 'PROPOSALS AWAITING APPROVAL panel',
      text: [
        'Once a week, during his night, his mind looks at his life (only the fictional cast, places and his own life, never chat content) and suggests what could happen next: a beat in someone\'s life, a new person, a new place, a new arc decision, or which kind of heavy stretch should be a little more likely. In NATURAL categories these are checked and applied on their own. In GUIDED categories they wait here for you.',
        'Each row shows the category, the kind of proposal, what it is (its details in short form) and when it was made.',
      ],
      items: [
        ['PREVIEW APPROVE', 'Opens the Director preview: the exact events it would add, warnings and anything that would be refused. Nothing changes until you press APPLY there. Applied events are marked as coming from his mind, and REVERT THIS CHANGE on the Director undoes them (the proposal is then closed). Every check is run again against his world as it is now: a member who left, a name now taken, the caps, the map area, a pin or a category frozen since then show as refusals. A beat adds the news (a status beat also updates their status), a new person or place is created, and an arc opener opens its decision (as an Ask-me card on the Pending page while the category is guided).'],
        ['REJECT ONLY', 'A heavy nomination only makes that kind of hard stretch a little more likely at the next roll; it has nothing to apply, so it can only be rejected (or left to expire after 14 days).'],
        ['REJECT', 'Drops the proposal at once, with no preview. Nothing is added to his world.'],
      ],
      tips: [
        'Both buttons are disabled while the dashboard is read-only (DASHBOARD_READONLY=true), and answer an error while the life simulation or the arcs skill is off.',
        'Proposals you leave alone expire after 14 days.',
      ],
    },
    {
      id: 'fromchats',
      title: 'From chats',
      where: 'FROM CHATS panel',
      text: [
        'Advice someone gave him in a chat about his life (career, romance, family, social or health), with the chat-influence skill (its ADVICE area) and the arcs skill on. It changes nothing on its own: it waits here and on the Director for you.',
        'Each row shows the category, which chat it came from, the message itself (read live, so it is gone once the message is forgotten, revoked, edited or expires) and how long it stays (14 days by default).',
      ],
      items: [
        ['APPROVE', 'Opens the Director with its SCENE form set to an ARC.START in that category. Nothing happens until you preview and apply a scene there.'],
        ['REJECT', 'Drops it at once. Nothing is added to his world.'],
      ],
      tips: ['A frozen category or a paused story gets no suggestions; at most 3 wait per category, one per person and category.'],
    },
  ],
};
