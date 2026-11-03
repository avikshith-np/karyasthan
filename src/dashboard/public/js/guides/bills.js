// Guide: Bills (pages/bills.js). Plain data, see components/guide.js.
export default {
  title: 'Bills',
  intro: [
    'The bills he has read and split in groups (the newest 100). He fills it by himself: when someone shares a photo of a receipt he reads it quietly in the background, and when someone asks him (by mention or name) to split a bill he walks the group through who had what. This page shows them; the one control is EXPIRE on an open bill (see Focus).',
    'The top row counts OPEN bills (PARSED or ACTIVE), COMPLETED ones and VOID ones (CANCELLED or EXPIRED).',
    'Amounts have no currency symbol: the receipt reading stores plain numbers. A bill that names its currency shows it.',
  ],
  sections: [
    {
      id: 'states',
      title: 'Bill states',
      items: [
        ['PARSED', 'A receipt photo he read on his own, without saying anything. Nobody has asked him to split it yet. If someone asks soon after, he starts from this reading.'],
        ['ACTIVE', 'A split in progress in the group: he is collecting who had which items.'],
        ['COMPLETED', 'The split is done and he posted everyone\'s share.'],
        ['CANCELLED', 'Someone told him to stop mid-split ("cancel", "never mind", "leave it").'],
        ['EXPIRED', 'A split that sat idle for 2 hours, or one that was open when the bot restarted. The bills maintenance button on the Settings page runs the same 2-hour cleanup on demand.'],
      ],
    },
    {
      id: 'kpis',
      title: 'Totals',
      where: 'Top row of cards',
      items: [
        ['OUTSTANDING', 'The sum of the open bills (PARSED and ACTIVE), with their number under it. Cancelled and expired bills are not counted. A PARSED bill is one nobody asked him to split yet, so this is "open with him", not necessarily money owed.'],
        ['TOTAL · ALL', 'The sum of every bill listed, and how many are done.'],
        ['AVG PARTICIPANTS', 'People per bill, on average.'],
        ['STALE > 7D', 'Open bills (PARSED or ACTIVE) whose last change is more than 7 days old. Usually PARSED readings nobody followed up on; EXPIRE clears one.'],
      ],
    },
    {
      id: 'ledger',
      title: 'Bills',
      where: 'BILLS panel',
      text: ['Newest first: number, place on the receipt, state, the end of the group id, how many people, and when it last changed. Click a row (or press Enter on it) to see it in the Focus panel.'],
    },
    {
      id: 'focus',
      title: 'One bill',
      where: 'THE BILL panel',
      text: [
        'The receipt as he read it: each item with quantity and price, then subtotal, tax, service charge, discount and total when the receipt had them.',
        'SPLIT shows each person\'s share, worked out by dividing each item\'s price between the people who had it. Tax and service charge are not spread over people here, so the shares can add up to less than the total. SETTLED means the bill was completed; PENDING that it was not.',
        'EXPIRE (open bills only) marks the bill EXPIRED at once, after a confirm, so it stops catching messages in that chat. A bill that was completed, cancelled or expired meanwhile (an old page) is refused and keeps its state. It needs the dashboard to be writable and is recorded on the Audit page.',
      ],
    },
  ],
};
