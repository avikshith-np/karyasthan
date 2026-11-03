// Guide: Control · Review (pages/review.js). Plain data, see components/guide.js.
export default {
  title: 'Review',
  intro: [
    'Each week a sample of what his writers wrote lands here: up to 25 each of scenes, phone texts, thoughts and dreams, spread over the week\'s days. You mark them one at a time. It is the measure of whether the writing is any good, and what fails feeds the checks and the incident tests.',
    'Picking the sample is code; nothing here calls a model. Nothing about a real person is ever sampled.',
  ],
  sections: [
    {
      id: 'how',
      title: 'Marking a card',
      items: [
        ['PASS', 'It reads right. On to the next.'],
        ['FAIL', 'Then pick what was wrong, or FAIL, NO NOTE. The note is a fixed code, so it can be counted.'],
        ['SKIP', 'Puts it at the back, unmarked.'],
        ['UNDO LAST', 'Takes back your last mark and shows that card again. To change a mark, undo it first.'],
        ['PRIVATE', 'A text or scene the log doesn\'t call tame. The words stay hidden until you tap, it can\'t be marked before you read it, and HIDE AGAIN puts them away.'],
      ],
      tips: [
        'If the connection drops you can keep going through the cards already here. Your marks wait in this browser and go when it\'s back.',
        'If an output is undone (a revert or a rewind) it leaves the queue. A mark you already gave it stays counted.',
      ],
    },
    {
      id: 'results',
      title: 'Results',
      text: ['Pass rate by surface, then by week: how many were sampled, passed, failed and are left, and UNDONE for outputs that left the queue unmarked. SAMPLE THIS WEEK SO FAR adds this week\'s writing now, instead of waiting for it to end; the finished week tops it up.'],
    },
    {
      id: 'export',
      title: 'Failures as stubs',
      text: ['DOWNLOAD gives every failure as a JSON stub for the incident tests: the words, the scene\'s fact sheet, and your note. A private output comes without its words, and one undone since says so. The stubs hold your world\'s names, so rename them before one goes into the repository.'],
    },
  ],
};
