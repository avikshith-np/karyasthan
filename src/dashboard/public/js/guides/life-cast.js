// Guide: Life · People (pages/life-cast.js). Plain data, see components/guide.js.
export default {
  title: 'People',
  intro: [
    'The cast are the fictional people in his simulated life: his flatmate, coworkers, his manager, family, and any friends or acquaintances added later. None of them are real people from his chats, and the page never shows anyone from WhatsApp.',
    'This page is read-only. It refreshes every 30 seconds. To change someone, use the Director (EDIT CAST, NEW_CAST, CAST.BEAT, pins). Tap a person or a dot in the web to open that person\'s page with their history.',
    'Everything here needs the life simulation and the "arcs" skill on. While either is off the page shows an ARCS IS OFF note and stays empty.',
  ],
  sections: [
    {
      id: 'header',
      title: 'The counters on top',
      items: [
        ['CAST', 'How many people are in his life right now.'],
        ['AWAY', 'How many of them are away on a trip at the moment.'],
        ['PINNED', 'How many are pinned on the Director. A pinned person\'s life and relationship with him stay frozen: no news, no drift, no arc steps about them.'],
      ],
    },
    {
      id: 'web',
      title: 'Relationship web',
      where: 'RELATIONSHIP WEB panel (folded away on a phone; tap to open, it remembers)',
      text: [
        'He is the dot in the middle (ME). Everyone else sits around him, grouped into circles: HOME (the flatmate), WORK (coworkers and the manager), FAMILY, and FRIENDS & OTHERS. Each circle has its own stretch of the ring with its name next to it, so who belongs together is shown by where they sit, not by lines between them.',
        'Each person has one line to him. Its width is how close they are (thicker = closer). It turns amber when tension with that person reaches 0.25 (strained) and red at 0.5 (tense); otherwise it is green for the flatmate and grey for everyone else.',
        'NOT MET YET: someone who was added to his world (by the Director or the weekly pass) but has had no contact with him since — no time together, no call, no plan that happened — has a dashed ring and a thin dotted line, and their name says "not met yet". Once they spend time together it becomes a normal line.',
        'A dashed line between two people (not to him) joins someone to the cast member they came into his life through ("met via"), when they were added with one.',
      ],
      tips: [
        'Hover a line to see its exact closeness and tension. Click a dot to open that person.',
      ],
    },
    {
      id: 'who',
      title: 'The people',
      where: 'WHO panel, one card per person',
      items: [
        ['The card', 'The whole card opens their page.'],
        ['Avatar', 'Initials only, coloured by relation (flatmate, coworker, manager, family, friend…).'],
        ['NAME', 'Their name, a PINNED chip when pinned on the Director, and their age when known.'],
        ['RELATION', 'How he knows them (flatmate, coworker, manager, family:<role>, friend, acquaintance, neighbour). When someone is his partner from the dating stage on, a partner label replaces the plain relation.'],
        ['METRICS', 'Three bars for closeness, trust and tension (see Metrics below). For his current romantic partner a fourth line adds the romance stage and I / P / C (see Romance).'],
        ['STATUS', 'A one-line "what\'s going on in their life", plus an AWAY chip while they are on a trip, with the reason when the trip has one (a heavy stretch names its theme) and when they are back.'],
      ],
    },
    {
      id: 'metrics',
      title: 'Metrics: closeness, trust, tension',
      text: [
        'Each runs from 0 to 1. They change only through relationship events, which you can see on the person\'s page. A single change is capped at 0.2 either way.',
      ],
      items: [
        ['CLOSE (closeness)', 'How close he is to them. Time spent together raises it (+0.01 per half hour, at most +0.05 a day). After 14 days without contact it slowly fades (−0.004 a day) down to a floor of 0.15 (0.35 for family). Going to a family occasion or calling for it adds a little. Closer people make plans with them more attractive to him, and a birthday only becomes a decision (go, call, text…) when closeness is at least 0.5.'],
        ['TRUST', 'Earned. It starts from the world seed (0.4 for someone new) and the morning pass moves it from what he actually did: a plan with them that happened +0.02 (once a day); saying no after first leaning towards going −0.01 (a plain no costs nothing); backing out of one he had said yes to, or cancelling it, −0.04; breaking a plan he agreed in texts, adopted from a chat or said yes to in a chat −0.05; skipping a family occasion −0.03; a romance with them that ended in a breakup −0.05 (fizzled −0.02); tension above 0.5 −0.005 a day; an hour or more together +0.005, but not above closeness + 0.2. Keeping a plan made in a chat earns nothing, and chat time counts for nothing; a chat merely nudging his own plan changes none of this. It moves at most 0.05 a day either way. Higher trust makes plans with them a bit more attractive to him (he follows through), below 0.3 his notes on them add "not sure you can count on them", and it counts towards who could become a romantic partner. The Director\'s NUMBERS sets it by hand.'],
        ['TENSION', 'Friction between them. It eases by 0.01 a day on its own. It rises when he changes his mind on a plan he had made with them (+0.1), a little after an intense family call while family pressure is high, or when he skips a family occasion. High tension makes plans with that person less attractive, a manager at 0.6 or more can push him to start job hunting, and with a partner at 0.7 or more a breakup can come up.'],
      ],
    },
    {
      id: 'romance',
      title: 'Romance: stage and I / P / C',
      text: [
        'Shown only for the person he is currently in a romance with. The stages run single → interested → talking → dating → committed → engaged → married, one step at a time, and each step needs enough of the three numbers plus a minimum time in the current stage. The steps to committed, engaged and married are big decisions that can ask you first (Pending page).',
      ],
      items: [
        ['I (intimacy)', 'Emotional closeness in the romance. Grows with time spent together.'],
        ['P (passion)', 'Attraction. Grows with time together; after 7 days without contact it fades a little every day. If it drops too low early on, the romance fizzles.'],
        ['C (commitment)', 'Grows with time together once they are talking, and jumps when he takes a step forward.'],
        ['h together', 'Total hours they have spent together.'],
      ],
      tips: ['To start or move a romance by hand, use the Director (ARC.START, ARC.STAGE). To stop romance happening for a while, set the romance fate to FROZEN there.'],
    },
  ],
};
