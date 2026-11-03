// Guide: Kit (pages/kit.js). Plain data, see components/guide.js.
export default {
  title: 'Kit',
  intro: [
    'Every shared piece of the dashboard with example data, ordinary and worst case. It reads and writes nothing, and it is not in the nav: open it by its address.',
    'Nothing here is his real data. The names and numbers are invented.',
  ],
  sections: [
    {
      id: 'what',
      title: 'Why it exists',
      items: [
        ['Checking', 'The phone-width checks cover this page, so a piece that breaks at 320 px shows up here first.'],
        ['Building', 'A new view can use these pieces before its own page exists. They live in components/views.js and css/views.css.'],
      ],
    },
  ],
};
