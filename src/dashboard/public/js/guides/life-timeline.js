// Guide: Life · Timeline (pages/life-timeline.js). Plain data, see components/guide.js.
export default {
  title: 'Life · Timeline',
  intro: [
    'On a phone the 24 h chart scrolls sideways and starts at the latest hours, with the lane names staying at the left edge; the legend folds, and a tapped event opens its cause chain in a sheet.',
    'The Timeline shows 24 hours of his simulated life: what was planned against what actually happened, his decisions, and every event in his world log. Click anything to see why it happened, and undo it if it can be undone.',
    'Everything in his life is an event in an append-only log. Nothing is ever deleted: an undo is a new "reverted" event that tells the simulation to leave the original out.',
  ],
  sections: [
    {
      id: 'window',
      title: 'Moving through time',
      where: 'top right',
      items: [
        ['◀ 24 H', 'One day further back.'],
        ['24 H ▶', 'One day forward, never past now.'],
        ['NOW', 'Back to the last 24 hours. Only this view refreshes on its own (every 30 seconds).'],
        ['WINDOW', 'The exact span shown, in his timezone.'],
      ],
    },
    {
      id: 'ribbon',
      title: 'Last 24 h',
      where: 'LAST 24 H panel',
      text: ['Four lanes on one time axis, with a NOW line when the window includes the present. Hover for details, click to see the cause chain.'],
      items: [
        ['PLANNED', 'The day\'s plan as last made, coloured by the availability each block puts him in (free, light, busy, meeting, dnd, asleep). Clicking it selects the plan event.'],
        ['ACTUAL', 'What he really did: activities, trips and sleep, coloured by kind. Where it differs from PLANNED, something changed the day (a decision, a late night at work, a scene you added).'],
        ['DECISIONS', 'Each decision from when it opened to when it closed (or its deadline). A dot marks the moment he committed; a short vertical bar is the point of no return, after which he can no longer make it in time.'],
        ['EVENTS', 'One tick per event, coloured by who caused it: engine (the simulation\'s own rules), jev (the small decision model choosing a lean), chat (something said in a chat), owner (you, from the dashboard). Routine vitals checkpoints are left off the ribbon, and phone checks are left out of the ribbon and the event list (the header counts how many were hidden; Life · Day shows them).'],
      ],
      tips: [
        'A dashed tick was reverted. A ringed tick is orphaned: it was kept, but the event that caused it was undone.',
        'When you select an event, arrows on the EVENTS lane show its cause chain.',
      ],
    },
    {
      id: 'events',
      title: 'Events in window',
      where: 'EVENTS IN WINDOW panel',
      text: ['The same events as a list, newest first (the first 120): time, event number, type and who caused it. Reverted events stay in the list with a REVERTED chip. Click a row (or press Enter on it) to open its cause chain.'],
    },
    {
      id: 'why',
      title: 'Why · cause chain',
      where: 'WHY · CAUSE CHAIN panel',
      text: [
        'The chain of events that led to the selected one, root first and the selected event last. For each: number, type, time, who caused it, and its origin (self, owner, or the kind of chat it came from), followed by a short summary of its data.',
        'The origin matters for privacy: something that started in a chat keeps that chat\'s origin, and he only mentions it where that chat\'s content may be used.',
      ],
      items: [
        ['REVERTED', 'This event has been undone.'],
        ['REDACTED', 'Its content was wiped when a person\'s data was purged. The event stays so the chain keeps its shape.'],
        ['HEAVY', 'A heavy life event (it can start a quiet-day embargo).'],
      ],
    },
    {
      id: 'revert',
      title: 'Revert',
      where: 'below the cause chain',
      text: [
        'When the selected event can be undone, a REVERT form appears. The reason is optional (up to 200 characters) and only goes into the log. Reverting removes the event and everything the simulation itself derived from it (engine and decision-model consequences); the state is rebuilt at once. Things caused by a chat or by you are kept and show as orphaned.',
        'An activity, a late night at work or an invitation that you revert is remembered as undone, so the simulation doesn\'t simply recreate it on the next tick.',
      ],
      items: [
        ['Can be reverted', 'Activities, meals, spending and salary, staying late, work crunches, getting sick, birthdays, decisions opening, leans and changes of mind, chat triggers, flagged claims, answered calls, alerts, embargoes, a plan rewritten for an outing, and (with arcs) story events like cast beats, relationship changes, family calls, adopted claims and heavy proposals, a goal you set (its planned outing and progress go with it) and a weather window you set that has not started yet (end a started one on the Director instead).'],
        ['Cannot be reverted', 'The scaffolding the simulation would just rebuild: the morning plan, waking up, sleep, trips (getting caught in the rain on one included: it already moved his arrival), the engine\'s weather, phone checks, places and people. A commitment on its own cannot be reverted either (it would be redrawn at the deadline): revert the invitation or the lean instead. Some can be reverted only for a while: a schedule override before it takes effect, a scheduled career, home, mood or sick change while it is still pending, a goal before its outing begins, a place change while he is not using that place. The panel says when an event is not revertible (now).'],
      ],
      tips: [
        'Disabled while the dashboard is read-only (DASHBOARD_READONLY=true). Refused while life is not running. At most 10 per minute. Every revert is recorded in the audit log.',
        'Replies he already sent can\'t be unsent. To take back a whole stretch of time, use REWIND on the Director page.',
      ],
    },
  ],
};
