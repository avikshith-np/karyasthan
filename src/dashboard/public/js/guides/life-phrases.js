// Guide: Life · Phrases (pages/life-phrases.js). Plain data, see components/guide.js.
export default {
  title: 'Phrases',
  intro: [
    'His thoughts, the running line while he is out with someone, and half-remembered dreams are written by code from fixed lines, with no model call. This page shows those lines as they are today, beside the same lines in his own voice from a bank written once, offline.',
    'Nothing changes until you turn the switch on. Read a good stretch of each bank first. With the switch off, or for any line the bank has nothing for, he uses the line as it is today.',
  ],
  sections: [
    {
      id: 'reading',
      title: 'Reading the page',
      where: 'each pair of lines',
      items: [
        ['TODAY', 'The line the code uses now. It stays the meaning, and what he remembers having thought, whichever words come out.'],
        ['HIS VOICE', 'How the bank would say it. Several versions are normal. A small word next to one (low, night, commute) means it only comes up then.'],
        ['stays as it is', 'The bank has nothing usable for this line, so it stays as it is today.'],
        ['READS AS', 'A rough read of the language mix: mixed, nearly all English, or hardly any English. Only you can say if that is how he talks.'],
        ['MOST USED', 'The words the bank leans on most. If one of them is a word he goes on about, run it again with that word banned.'],
        ['DROPPED', 'Lines the checks refused: too long, a name, an identifier, something sexual or graphic, a word used too often. A slot that loses all its lines stays as it is today.'],
      ],
    },
    {
      id: 'making',
      title: 'Making a bank',
      where: 'on the server',
      text: ['The bank is a file on the server, written by a script you run yourself. It never runs on its own, and running him costs nothing extra afterwards.'],
      items: [
        ['See the cost', 'node scripts/gen-phrases.js shows what a run would do and cost, with no model call.'],
        ['Write it', 'node scripts/gen-phrases.js --write, with --ban word,word for words he must not lean on. It shows up here at once, beside today\'s lines, and a restart puts it into use.'],
        ['RUNNING / ON DISK', 'RUNNING is the bank he speaks from, loaded when he started. ON DISK is the file these lines come from. Opening this page never changes what he says.'],
        ['Switch on', 'Settings, life.phraseBanks. The switch takes effect at once for the running bank and can be turned off the same way. Thoughts already written keep their words.'],
      ],
    },
  ],
};
