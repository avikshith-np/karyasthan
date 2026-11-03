// The claim check's replay set (plan 020 E3): live incidents, plus cases that must pass. Measure both ways.
// Every name is invented. `build(at)` turns the helper's clock into a sheet; `expect` is the verdict the whole check should reach
// (the code pass only claims the cases marked code:true); `oracle` is what a clerk that reads it right would answer, for the
// offline pipeline. `-- --live` runs the same cases on the real clerk.
const HOUR = 3600;

const him = { name: 'Kiran', job: 'project manager' };
const them = { name: 'Asha', relation: 'friend' };
const phoneSheet = ({ recent = [], plans = [], lastSeen = null, why = "answering Asha's last text", day = 'Sun 1 Nov', time = '13:05', daypart = 'afternoon' } = {}) => ({
  side: 'his', him, them: { ...them, lastSeen, lately: [] }, now: 'at home', time: { day, at: time, daypart }, why, recent, plans, thread: [{ who: 'Asha', when: 'now', text: 'NOT-ON-THE-SHEET' }],
});
const sceneSheet = ({ afterwards = [], together = [], plansAfter = [], activity = 'coffee', place = 'cafe' } = {}) => ({
  mode: 'full', activity, place: { words: place }, time: { day: 'Sat 31 Oct', from: '15:00', to: '16:30', daypart: 'afternoon', minutes: 90 }, outcome: 'well',
  people: [{ label: 'P1', name: 'Asha', relation: 'friend', firstMeet: false, history: [] }], afterwards, together, plansAfter,
});

export const CASES = [
  // ── live incidents ────────────────────────────────────────────────────────
  {
    name: 'incident: "left together" when he walked home alone', writer: 'scene', speaker: 'narrator', expect: 'contradicted', code: true,
    text: 'They talked until the place emptied. They left the cafe together, still laughing about the landlord.',
    sheet: () => sceneSheet({ afterwards: ['16:35: he walked home on his own, there by 17:00', '17:30: Asha came over to his place'] }),
    oracle: (lines) => [{ claim: 'They left the cafe together', about: 'left', verdict: 'contradicted', line: lineOf(lines, 'on his own') }],
    anchor: 'sat-1630',
  },
  {
    name: "incident: last night's dinner called tonight", writer: 'phone', speaker: 'his', expect: 'contradicted', code: true,
    text: 'the pizza tonight was so good\nwe should go back',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00; then walked home [together]`] }),
    oracle: (lines) => [{ claim: 'They had pizza tonight', about: 'when', verdict: 'contradicted', line: lineOf(lines, 'restaurant') }],
    anchor: 'sun-1305',
  },
  {
    name: 'incident: a plan with no plan', writer: 'phone', speaker: 'his', expect: 'contradicted', code: false,
    text: 'on my way\nsee you at 8 like we said',
    sheet: () => phoneSheet({ plans: [] }),
    oracle: (lines) => [{ claim: 'They agreed to meet at 8', about: 'plan', verdict: 'contradicted', line: lineOf(lines, 'his plans: none') }],
    anchor: 'sun-1305',
  },
  {
    name: 'she moves a coffee from this morning to yesterday', writer: 'phone', speaker: 'cast', expect: 'contradicted', code: true,
    text: 'we had coffee yesterday and I still feel it',
    sheet: ({ relWhen, sunCoffee, at }) => phoneSheet({ recent: [`${relWhen(sunCoffee, at)}: coffee at the cafe with Asha, 09:30–10:30 [together]`] }),
    oracle: (lines) => [{ claim: 'They had coffee yesterday', about: 'when', verdict: 'contradicted', line: lineOf(lines, 'coffee') }],
    anchor: 'sun-1305',
  },
  {
    name: "yesterday's coffee called this morning", writer: 'phone', speaker: 'his', expect: 'contradicted', code: true,
    text: 'we had coffee this morning, remember',
    sheet: ({ relWhen, satCoffee, at }) => phoneSheet({ recent: [`${relWhen(satCoffee, at)}: coffee at the cafe with Asha, 15:00–16:30 [together]`] }),
    oracle: (lines) => [{ claim: 'They had coffee this morning', about: 'when', verdict: 'contradicted', line: lineOf(lines, 'coffee') }],
    anchor: 'sun-1305',
  },
  {
    name: 'he says he saw her last night; they last met days ago', writer: 'phone', speaker: 'his', expect: 'contradicted', code: true,
    text: 'I saw Asha last night and she looked tired',
    sheet: ({ relWhen, thuNight, at }) => phoneSheet({ lastSeen: `${relWhen(thuNight, at)}: hangout` }),
    oracle: (lines) => [{ claim: 'He saw Asha last night', about: 'when', verdict: 'contradicted', line: lineOf(lines, 'last saw') }],
    anchor: 'sun-1305',
  },
  {
    name: 'who: the wrong person at dinner', writer: 'scene', speaker: 'narrator', expect: 'contradicted', code: false,
    text: 'Asha and her brother Rohan sat across from him, and Rohan ordered for everyone.',
    sheet: () => sceneSheet({ activity: 'dinner', place: 'restaurant' }),
    oracle: () => [{ claim: "Asha's brother Rohan was there", about: 'who', verdict: 'unknown', line: null }],
    anchor: 'sat-1630',
    expectOffline: 'pass',   // the clerk may fairly say unknown: only a line saying otherwise contradicts
  },
  // ── should pass ───────────────────────────────────────────────────────────
  {
    name: 'pass: a new suggestion is no claim', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'dinner tonight?\nsame place as last night?',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
    oracle: () => [],
    anchor: 'sun-1305',
  },
  {
    name: "pass: last night's dinner called last night", writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'we had dinner last night and I keep thinking about it',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
    oracle: (lines) => [{ claim: 'They had dinner last night', about: 'when', verdict: 'supported', line: lineOf(lines, 'restaurant') }],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: at 2:45 am, that dinner is either tonight or last night', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'dinner last night was the best part of my week',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`], time: '02:45', daypart: 'late night' }),
    oracle: (lines) => [{ claim: 'They had dinner last night', about: 'when', verdict: 'supported', line: lineOf(lines, 'restaurant') }],
    anchor: 'sun-0245',
  },
  {
    name: 'pass: dinner alone at home is not on the sheet', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'I had dinner tonight, nothing special',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
    oracle: () => [{ claim: 'He had dinner tonight', about: 'when', verdict: 'unknown', line: null }],
    anchor: 'sun-1305',
  },
  {
    name: "pass: someone else's evening", writer: 'phone', speaker: 'cast', expect: 'pass',
    text: 'my sister made dinner last night, it was a disaster',
    sheet: ({ relWhen, satCoffee, at }) => phoneSheet({ recent: [`${relWhen(satCoffee, at)}: eat out at the restaurant with Asha, 13:00–14:00 [together]`] }),
    oracle: () => [{ claim: "Asha's sister made dinner last night", about: 'who', verdict: 'unknown', line: null }],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: mixed-language speech', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'dinner tonight mast tha yaar\nkal phir chalein?',
    sheet: ({ relWhen, sunEvening, at }) => phoneSheet({ recent: [`${relWhen(sunEvening, at)}: eat out at the restaurant with Asha, 20:00–21:00 [together]`], time: '21:30', daypart: 'night' }),
    oracle: (lines) => [{ claim: 'They had dinner tonight', about: 'when', verdict: 'supported', line: lineOf(lines, 'restaurant') }],
    anchor: 'sun-2130',
  },
  {
    name: 'pass: mixed language, wrong day, code stays out of it', writer: 'phone', speaker: 'his', expect: 'pass', codeMiss: true,
    text: 'tonight ka dinner mast tha yaar',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
    oracle: () => [{ claim: 'They had dinner', about: 'when', verdict: 'unknown', line: null }],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: "thanks for last night" names nothing', writer: 'phone', speaker: 'cast', expect: 'pass',
    text: 'thanks for last night',
    sheet: ({ relWhen, thuNight, at }) => phoneSheet({ recent: [`${relWhen(thuNight, at)}: hangout with Asha [together]`] }),
    oracle: () => [],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: dinner with someone the sheet doesn\'t list', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'we went for dinner with Priya last night',
    sheet: ({ relWhen, satCoffee, at }) => phoneSheet({ recent: [`${relWhen(satCoffee, at)}: eat out at the restaurant with Asha, 13:00–14:00 [together]`] }),
    oracle: () => [{ claim: 'They had dinner with Priya last night', about: 'who', verdict: 'unknown', line: null }],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: the scene\'s own evening is tonight', writer: 'scene', speaker: 'narrator', expect: 'pass',
    text: 'They had dinner tonight at a table by the window and stayed until the staff stacked the chairs.',
    sheet: () => sceneSheet({ activity: 'dinner', place: 'restaurant' }),
    oracle: (lines) => [{ claim: 'They had dinner', about: 'where', verdict: 'supported', line: lineOf(lines, 'activity') }],
    anchor: 'sat-2200', session: 'sat-dinner',
  },
  {
    name: 'pass: walked together to the corner, then home alone', writer: 'scene', speaker: 'narrator', expect: 'pass',
    text: 'They walked together as far as the corner. Then he walked home alone, the street quiet around him.',
    sheet: () => sceneSheet({ afterwards: ['16:35: he walked home on his own, there by 17:00'] }),
    oracle: (lines) => [{ claim: 'He walked home alone', about: 'left', verdict: 'supported', line: lineOf(lines, 'on his own') }],
    anchor: 'sat-1630',
  },
  {
    name: 'pass: a plan on the sheet, said plainly', writer: 'phone', speaker: 'his', expect: 'pass',
    text: 'see you at 7 at the cafe',
    sheet: ({ relWhen, sunEvening, at }) => phoneSheet({ plans: [`${relWhen(sunEvening, at)}–21:00: Coffee with Asha (at the cafe) with Asha [with them — you both know about it]`] }),
    oracle: (lines) => [{ claim: 'They meet at the cafe', about: 'plan', verdict: 'supported', line: lineOf(lines, 'Coffee with Asha') }],
    anchor: 'sun-1305',
  },
  {
    name: 'pass: a scene ending in a new plan isn\'t contradicted by "none planned"', writer: 'scene', speaker: 'narrator', expect: 'pass',
    text: 'At the door they said they would do it again next week.',
    sheet: () => sceneSheet({}),
    oracle: () => [{ claim: 'They said they would meet next week', about: 'plan', verdict: 'unknown', line: null }],
    anchor: 'sat-1630',
  },
  // ── should pass: false alarms found in review (batch 3, 14–16) ─────────────
  ...[
    ['pass: a table booked for the dinner on the sheet', 'his', 'We got a table for dinner tonight'],
    ['pass: checking the plan on the sheet', 'his', 'We were going for dinner tonight right'],
    ['pass: a past-tense word about the plan on the sheet', 'his', 'dinner tonight was your idea'],
    ['pass: her suggestion, the plan on the sheet', 'cast', 'Was thinking we get dinner tonight'],
  ].map(([name, speaker, text]) => ({
    name, writer: 'phone', speaker, expect: 'pass', text, anchor: 'sun-1305', oracle: () => [],
    sheet: ({ relWhen, satDinner, sunEvening, at }) => phoneSheet({
      recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`],
      plans: [`${relWhen(sunEvening, at)}–21:00: Dinner (at the restaurant) with Asha [with them — you both know about it]`],
    }),
  })),
  {
    name: 'pass: a suggestion with no plan on the sheet', writer: 'phone', speaker: 'cast', expect: 'pass', anchor: 'sun-1305', oracle: () => [],
    text: 'Was thinking dinner tonight',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
  },
  {
    name: 'pass: a table booked, no plan on the sheet yet', writer: 'phone', speaker: 'his', expect: 'pass', anchor: 'sun-1305', oracle: () => [],
    text: 'We got a table for dinner tonight',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
  },
  {
    name: 'pass: lunch with the team is not on the sheet', writer: 'phone', speaker: 'his', expect: 'pass', anchor: 'sun-1305', oracle: () => [],
    text: 'We had lunch this afternoon at the office, the whole team went',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: eat out at the restaurant with Asha, 20:00–22:00 [together]`] }),
  },
  {
    name: 'pass: coffee with her office is not on the sheet', writer: 'phone', speaker: 'cast', expect: 'pass', anchor: 'sun-1305', oracle: () => [],
    text: 'We went for coffee this morning, the whole office',
    sheet: ({ relWhen, satCoffee, at }) => phoneSheet({ recent: [`${relWhen(satCoffee, at)}: coffee at the cafe with Asha, 15:00–16:30 [together]`] }),
  },
  {
    name: 'pass: lunch today is not the named dinner on the sheet', writer: 'phone', speaker: 'his', expect: 'pass', anchor: 'sun-1305', oracle: () => [],
    text: 'We had lunch this afternoon',
    sheet: ({ relWhen, satDinner, at }) => phoneSheet({ recent: [`${relWhen(satDinner, at)}: Dinner at the restaurant with Asha, 20:00–22:00 [together]`] }),
  },
  {
    name: 'pass: the coffee she had', writer: 'scene', speaker: 'narrator', expect: 'pass', anchor: 'sat-1630', oracle: () => [],
    text: 'They talked about the coffee she had this morning.',
    sheet: () => sceneSheet({}),
  },
  {
    name: 'pass: her walk with her dog', writer: 'scene', speaker: 'narrator', expect: 'pass', anchor: 'sat-1630', oracle: () => [],
    text: 'Over dinner she told him she walked in the park with her dog this morning.',
    sheet: ({ relWhen, thuNight }) => sceneSheet({ activity: 'dinner', place: 'restaurant', together: [`${relWhen(thuNight, thuNight + 86400)}: walk at the park with Asha [together]`] }),
  },
  {
    name: 'pass: 17:00 is still this afternoon', writer: 'scene', speaker: 'narrator', expect: 'pass', anchor: 'sat-1800', session: 'sat-1700', oracle: () => [],
    text: 'They had coffee this afternoon.',
    sheet: () => sceneSheet({}),
  },
  ...[
    'They shared an auto to the restaurant.',
    'She packed the leftovers and he took them home.',
    'He remembered the night he walked her home from college.',
    'He wished he had walked her home.',
    'He could have dropped her home but she had her scooter.',
  ].map((text) => ({
    name: `pass, not how he left: ${text}`, writer: 'scene', speaker: 'narrator', expect: 'pass', anchor: 'sat-1630', oracle: () => [], text,
    sheet: () => sceneSheet({ afterwards: ['16:35: he walked home on his own, there by 17:00'] }),
  })),
];

const lineOf = (lines, needle) => lines.findIndex(l => l.includes(needle)) + 1;
export { HOUR };
