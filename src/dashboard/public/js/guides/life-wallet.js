// Guide: Life · Wallet (pages/life-wallet.js). Plain data, see components/guide.js.
export default {
  title: 'Wallet',
  intro: [
    'His money, one month at a time: what he has now, when his salary comes, what came in and went out, and a log of every payment. Everything here comes from his simulated life; no real money is involved.',
    'Amounts are plain numbers in the currency of his world (no symbol is assumed). The page refreshes every 30 seconds and needs the life simulation on. Pick another month with the month list.',
  ],
  sections: [
    {
      id: 'month',
      title: 'This month',
      where: 'THIS MONTH panel',
      items: [
        ['BALANCE NOW', 'What he has right now. Red when he is below zero.'],
        ['IN / OUT / NET', 'Money that came in (salary, extra income you gave him) and went out during the month, and the difference.'],
        ['SALARY', 'His monthly pay and the day of the month it arrives, with the next payday. "Not paid yet" means no salary has arrived since his life started. No job means no salary.'],
        ['Usual month\'s spending', 'What a normal month costs him in his world (rent, bills, food and the rest). His regular payments are spread over the month from it.'],
      ],
    },
    {
      id: 'categories',
      title: 'By category',
      where: 'BY CATEGORY panel',
      text: ['Where the month\'s money went (red) or came from (green), biggest first.'],
      items: [
        ['Salary / Income', 'His pay, and income you gave him from the Director.'],
        ['Rent / Bills / Groceries', 'His regular costs, paid on fixed days.'],
        ['Food / Outings / Travel', 'Meals away from home, going out (a cafe, a movie, a hangout) and fares.'],
        ['Setback', 'A cost from a hard stretch in his life.'],
        ['Adjustment / Other', 'A balance you set from the Director, or an expense you gave him.'],
      ],
    },
    {
      id: 'balance',
      title: 'Balance',
      where: 'BALANCE panel',
      text: ['His balance at the end of each day of the month, up to today. A dashed line marks zero when he went below it.'],
    },
    {
      id: 'log',
      title: 'The log',
      where: 'THE LOG panel (on a phone each payment is one compact row: what and how much, then when, where and with whom; REVERT asks first)',
      text: [
        'Every payment of the month, newest first: when, what for, where, with whom (fictional names) and the amount (+ in, − out).',
        'This page is your view, so it lists everything, including spends from plans made in a chat. Those are marked ◇ CHAT. OWNER marks something you did from the Director.',
      ],
      items: [
        ['REVERT', 'Takes the payment back, along with anything it caused, and asks you for an optional reason. It shows only where the engine allows it; a payment that is part of an outing usually goes when you revert the outing itself. Needs a writable dashboard and is recorded in the audit log.'],
      ],
    },
  ],
};
