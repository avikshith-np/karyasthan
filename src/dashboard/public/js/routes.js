// The route registry (spec 007 R11, FR-043; regrouped by plan 020 I1): one list drives the
// router, the sidebar and the tab strips. Every route keeps its hash; moving a page in the nav
// never changes its address.
//
//   hash     id (also the nav key)          re       hash pattern; groups → params
//   title    nav label / document title     section  nav section
//   nav      a link in the sidebar          navKey   which nav link lights up
//   tabs     tab strip this route sits in
//   module   page module under js/ (lazy)   load     its dynamic import

export const SECTIONS = ['Life', 'Chats', 'Control'];

const page = (name) => () => import(`./pages/${name}.js`);

export const ROUTES = [
  // ── Life ──
  { hash: 'life', re: /^#?$|^#life$/, title: 'Now', section: 'Life', nav: true, module: 'pages/life-now.js', load: page('life-now') },
  { hash: 'life/day', re: /^#life\/day(?:\/(\d{4}-\d{2}-\d{2}))?$/, title: 'Day', section: 'Life', nav: true, navKey: 'life/day', tabs: 'day', module: 'pages/life-day.js', load: page('life-day') },
  { hash: 'life/timeline', re: /^#life\/timeline$/, title: 'Timeline', section: 'Life', navKey: 'life/day', tabs: 'day', module: 'pages/life-timeline.js', load: page('life-timeline') },
  // His cast. #people is the real contacts, under Chats. (spec 010)
  { hash: 'life/cast', re: /^#life\/cast$/, title: 'People', section: 'Life', nav: true, module: 'pages/life-cast.js', load: page('life-cast') },
  { hash: 'life/cast/member', re: /^#life\/cast\/([^/]+)$/, title: 'Cast member', section: 'Life', navKey: 'life/cast', module: 'pages/life-cast-member.js', load: page('life-cast-member') },
  // spec 019: his texts with his cast (#life/phone/<castId> → that thread; the id may arrive encoded)
  { hash: 'life/phone', re: /^#life\/phone(?:\/([^/]+))?$/, title: 'Phone', section: 'Life', nav: true, navKey: 'life/phone', module: 'pages/life-phone.js', load: page('life-phone') },
  { hash: 'mind', re: /^#mind$/, title: 'Mind', section: 'Life', nav: true, module: 'pages/mind.js', load: page('mind') },
  // 020 H2: his voice for the code-written lines, beside today's words
  { hash: 'life/phrases', re: /^#life\/phrases$/, title: 'Phrases', section: 'Life', navKey: 'mind', module: 'pages/life-phrases.js', load: page('life-phrases') },
  // spec 010: polling pages, no SSE topic
  { hash: 'life/story', re: /^#life\/story$/, title: 'Story', section: 'Life', nav: true, navKey: 'life/story', tabs: 'story', module: 'pages/life-story.js', load: page('life-story') },
  { hash: 'life/director', re: /^#life\/director(?:\/([a-z]+))?$/, title: 'Director', section: 'Life', navKey: 'life/story', tabs: 'story', module: 'pages/life-director.js', load: page('life-director') },
  { hash: 'life/pending', re: /^#life\/pending$/, title: 'Pending', section: 'Life', navKey: 'life/story', tabs: 'story', module: 'pages/life-pending.js', load: page('life-pending') },
  { hash: 'life/journal', re: /^#life\/journal$/, title: 'Journal', section: 'Life', navKey: 'life/story', tabs: 'story', module: 'pages/life-journal.js', load: page('life-journal') },
  // spec 018: his money (#life/wallet/<YYYY-MM> → that month)
  { hash: 'life/wallet', re: /^#life\/wallet(?:\/(\d{4}-(?:0[1-9]|1[0-2])))?$/, title: 'Wallet', section: 'Life', nav: true, navKey: 'life/wallet', module: 'pages/life-wallet.js', load: page('life-wallet') },
  { hash: 'life/map', re: /^#life\/map$/, title: 'Map', section: 'Life', nav: true, module: 'pages/life-map.js', load: page('life-map') },

  // ── Chats: the real people and what he has from them ──
  { hash: 'groups', re: /^#groups$/, title: 'Groups', section: 'Chats', nav: true, module: 'pages/groups.js', load: page('groups') },
  { hash: 'group', re: /^#group\/(.+)$/, title: 'Group', section: 'Chats', navKey: 'groups', module: 'pages/group.js', load: page('group') },
  { hash: 'people', re: /^#people$/, title: 'Contacts', section: 'Chats', nav: true, module: 'pages/people.js', load: page('people') },
  { hash: 'person', re: /^#person\/(.+)$/, title: 'Contact', section: 'Chats', navKey: 'people', module: 'pages/person.js', load: page('person') },
  { hash: 'messages', re: /^#messages$/, title: 'Search', section: 'Chats', nav: true, module: 'pages/messages.js', load: page('messages') },
  { hash: 'memories', re: /^#memories$/, title: 'Memories', section: 'Chats', nav: true, module: 'pages/memories.js', load: page('memories') },
  { hash: 'decisions', re: /^#decisions$/, title: 'Decisions', section: 'Chats', nav: true, module: 'pages/decisions.js', load: page('decisions') },
  { hash: 'bills', re: /^#bills$/, title: 'Bills', section: 'Chats', nav: true, module: 'pages/bills.js', load: page('bills') },
  { hash: 'instagram', re: /^#instagram$/, title: 'Instagram', section: 'Chats', nav: true, module: 'pages/instagram.js', load: page('instagram') },

  // ── Control ──
  { hash: 'status', re: /^#status$/, title: 'Status', section: 'Control', nav: true, module: 'pages/status.js', load: page('status') },
  { hash: 'settings', re: /^#settings$/, title: 'Settings', section: 'Control', nav: true, module: 'pages/settings.js', load: page('settings') },
  { hash: 'identity', re: /^#identity$/, title: 'Identity', section: 'Control', nav: true, module: 'pages/identity.js', load: page('identity') },
  { hash: 'skills', re: /^#skills$/, title: 'Skills', section: 'Control', nav: true, module: 'pages/skills.js', load: page('skills') },
  { hash: 'usage', re: /^#usage$/, title: 'Usage', section: 'Control', nav: true, module: 'pages/usage.js', load: page('usage') },
  // plan 020 E3: what the writers said against the sheets they wrote from
  { hash: 'claim-check', re: /^#claim-check$/, title: 'Claim check', section: 'Control', nav: true, module: 'pages/claim-check.js', load: page('claim-check') },
  { hash: 'logs', re: /^#logs$/, title: 'Live Logs', section: 'Control', nav: true, module: 'pages/logs.js', load: page('logs') },
  { hash: 'public', re: /^#public$/, title: 'Public site', section: 'Control', nav: true, module: 'pages/public.js', load: page('public') },
  { hash: 'review', re: /^#review$/, title: 'Review', section: 'Control', nav: true, module: 'pages/review.js', load: page('review') },
  { hash: 'audit', re: /^#audit$/, title: 'Audit', section: 'Control', nav: true, module: 'pages/audit.js', load: page('audit') },
  // The shared pieces with example data; by address only.
  { hash: 'kit', re: /^#kit$/, title: 'Kit', section: 'Control', navKey: 'status', module: 'pages/kit.js', load: page('kit') },
];

/** Nav sections in order, each with its visible routes; empty sections dropped. */
export function navSections(routes = ROUTES) {
  return SECTIONS
    .map((name) => ({ name, routes: routes.filter((r) => r.nav && r.section === name) }))
    .filter((s) => s.routes.length);
}

/** The routes sharing a tab strip with `route`, in registry order; [] when it has none. */
export function tabsOf(route, routes = ROUTES) {
  return route?.tabs ? routes.filter((r) => r.tabs === route.tabs) : [];
}
