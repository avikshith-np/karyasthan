// Guide: Audit (pages/audit.js). Plain data, see components/guide.js.
export default {
  title: 'Audit',
  intro: [
    'Every change made through the dashboard is written to an audit table: settings, keys, identity edits, skill toggles, mutes, imitation, memory edits, mind, life and Director actions, pairing and maintenance runs. This page shows the most recent ones, newest first. It is read-only, and nothing on the dashboard can edit or delete an entry.',
    'Requests refused because the dashboard is read-only never reach the point where they would be recorded, so they don\'t appear here.',
  ],
  sections: [
    {
      id: 'ledger',
      title: 'Latest writes',
      where: 'LATEST WRITES panel',
      items: [
        ['#', 'The entry\'s number.'],
        ['WHEN', 'How long ago; hover for the exact time.'],
        ['WHO', 'The dashboard user who made the change.'],
        ['ACTION', 'What was done, e.g. config.patch, config.persist, llm.keys.set, llm.test, identity.put, skill.toggle, pair.start, maintenance.memory, imitate.on, mind.*, life.*, arcs.*, director.*.'],
        ['TARGET', 'What it was done to (a group, a person, a skill, a backup file…), when there is one.'],
        ['PAYLOAD', 'The details, cut to the first 80 characters. A config.patch lists both the applied and the rejected keys. Key values are never stored: a key change records only which key field it was.'],
      ],
      tips: ['WRITES in the header counts the entries loaded on this page (the latest 200), not every change ever made. BY names who made them (the first two, then how many more).'],
    },
    {
      id: 'filter',
      title: 'Filter and export',
      items: [
        ['FILTER', 'Shows only entries whose action, actor, target or payload contains the text.'],
        ['ACTIONS', 'Shows only one kind of action.'],
        ['↧ EXPORT JSONL', 'Downloads the loaded entries (all 200, ignoring the filters) as one JSON record per line, with full payloads.'],
      ],
      tips: ['Both filters only search the latest 200 entries. Reload the page to pick up new ones.'],
    },
  ],
};
