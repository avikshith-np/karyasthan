// Guide: Life · Phone (pages/life-phone.js). Plain data, see components/guide.js.
export default {
  title: 'Phone',
  intro: [
    'His texts with the people in his world: one chat per person in his cast, his messages on the right and theirs on the left. He texts on his own (after an outing, on a birthday, when someone has news, while a romance warms up, before a plan), they reply when they would plausibly be on their phone, and sometimes text him first. You can also tell him to text someone.',
    'Only the people of his simulated life have chats here. Real chats, real groups and real people never appear on this page, and never on the public site. The page refreshes every 30 seconds and needs the life simulation and the arcs skill on.',
  ],
  sections: [
    {
      id: 'threads',
      title: 'Chats',
      where: 'CHATS list and a chat',
      items: [
        ['The list', 'Everyone he has a chat with, the most recent first: their name, the last message ("him:" when it was his) and when. LEFT marks someone who has left his life; their chat stays readable but he can\'t text them.'],
        ['Opening a chat', 'It opens at the newest message and stays there as new texts come in. Read further up and it leaves you where you are: ↓ NEW takes you back down.'],
        ['A chat', 'The messages oldest to newest, with a line for each day. EDITED marks a message you changed; REVERTED marks one taken out of his world (it stays visible here, faded). LOAD OLDER fetches earlier messages. On a phone the list and the chat are two screens: ‹ ALL CHATS goes back.'],
        ['Tap a message', 'Shows EDIT (change its words, at most 300 characters; what it caused stays), REWRITE (the model writes that one message again) and REVERT (it leaves his world, with anything it caused, like any revert on the Timeline). They need write mode (DASHBOARD_READONLY=false).'],
        ['Plans made in texts', 'When he and someone agree in texts to meet — they come over, he goes to theirs, or they meet at a cafe, a restaurant, a bar — it becomes a real plan in his day (Life · Day reads it "agreed in texts"), fitted like a plan you made. It is only made when his day can hold it: a clash with work, another plan or a schedule edit, a place his world doesn\'t have, or the story paused / frozen / pinned for them means no plan. REVERT on the agreeing message takes the plan out with it.'],
        ['SEND A TEXT', 'Under the chat. Say what he texts them about (and a tone if you like); what you type stays until it is sent, even if you cancel. It opens the Director preview like any other change: nothing is written until you APPLY. He writes it in his own words at his next chance to look at his phone, and they reply later.'],
      ],
      tips: [
        'These conversations are public: the public site\'s phone page shows every chat here as soon as it is written. A chat from a hard stretch in his life is never published.',
        'He remembers his texts: what he and someone texted about can come up when he talks in your real chats, under the same privacy rules as the rest of his life.',
      ],
    },
  ],
};
