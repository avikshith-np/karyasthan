// Guide: Claim check (pages/claim-check.js). Plain data, see components/guide.js.
export default {
  title: 'Claim check',
  intro: [
    'After a scene, a text or a journal part is written, it is checked against the fact sheet it was written from. Code reads its time words first ("tonight", "last night", "yesterday", "this morning"). Then one small clerk call lists its factual claims (who, where, when, how he left, money, plans) and labels each one against the sheet and nothing else.',
    'In SHADOW mode this page is all that happens: verdicts are stored and no output changes. ENFORCE (ARCS_CLAIM_CHECK_ENFORCE, off) gives a contradicted output one rewrite that names the problem, then that writer\'s usual fallback. It acts on a plan verdict only when the sheet names a plan at some other time, never on "no plan set". Read the contradictions here for false alarms, on his mixed-language speech above all, before turning it on.',
    'Never checked: explicit outputs (they are never sent to the clerk), the owner\'s own words, code one-liners and a real person\'s scene. An output that is reverted, rewritten or edited loses its verdicts.',
  ],
  sections: [
    {
      id: 'voices',
      title: 'By voice',
      where: 'BY VOICE panel',
      items: [
        ['VOICE', 'Who wrote it. Texts · his is his own speech, where a language mix would show up as false alarms; Texts · theirs is the cast.'],
        ['READ / CODE ONLY', 'READ: the clerk answered. CODE ONLY: only the code ran. The header says why: day cap, budget, no price for the clerk model, usage log unreadable, a failed call or an unusable answer. None of those blocks anything: no verdict is just no verdict.'],
        ['MONTH', 'Spend against the cap. NO PRICE: the clerk model has no entry in the price table, so its calls would count as $0 and the cap would do nothing; calls stop until it has one. LOCAL MODEL: there is no bill to cap, only the day cap applies.'],
        ['SUPPORTED', 'A line on the sheet says so.'],
        ['UNKNOWN', 'The sheet is silent. Most small details are not on it, so this is normal and fine.'],
        ['CONTRADICTED', 'A line says otherwise. The clerk has to cite the line; without one its answer counts as unknown. OF WHICH CODE: found by the code checks.'],
        ['RATE', 'Contradicted out of everything labelled for that voice.'],
      ],
    },
    {
      id: 'contradictions',
      title: 'Last contradictions',
      where: 'LAST CONTRADICTIONS panel',
      text: ['The newest first, with the sheet line and the start of what was written. A link opens the day, the thread or the journal it came from. Marking a verdict right or wrong comes with the weekly review.'],
      items: [
        ['CODE / CLERK', 'What found it. Code looks only at time words and at leaving together when the sheet says he left alone, and only says something when a past-tense sentence plainly ties them to something dated on the sheet. So a line in another language rarely gets a code verdict: that gap is the clerk\'s.'],
        ['from a chat\'s plan', 'An output from a plan made in a chat keeps its verdict and code, with no words stored.'],
      ],
    },
  ],
};
