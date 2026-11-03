// The words of the live line (plan 020 C2): a phrase table, code only, read by liveSession.js.
//
// Every phrase is a plain, everyday observation of two people out together. Nothing here is
// sexual or suggestive, at any heat, for anyone: the explicit register keeps its own one scene at
// the end and never touches this file. No persona, no place name, no real name: {she's}, {she},
// {her}, {name} are filled per session from the cast member (or "they" for two or more).
//
// Tokens: {she's} she's|he's|they're, {she} she|he|they, {her} her|his|their (possessive),
// {them} her|him|them (object), {name} the first name, or "the two of them".

export const TOPIC_WORDS = Object.freeze({
  job: ['{her} work', "what's going on at {her} job", '{her} work lately'],
  'beat:hobby': ['{her} new hobby', '{her} latest obsession', '{her} spare time, such as it is'],
  'beat:status': ['how things are going for {name}', "where {she's} at these days", 'how {her} month has been'],
  'beat:news': ['{her} news', 'what just happened to {name}', 'the latest with {name}'],
  'beat:milestone': ['{her} big news', 'what {she} just pulled off', 'how {she} managed it'],
  history: ['an old story of theirs', 'the old days', 'that one time, again', 'how they met'],
  hometown: ['where {she} grew up', '{her} home town', 'going back home someday'],
  his_work: ['his work', 'his week at work', 'a thing his manager said'],   // only while he has a job
  week: ['the week', 'how the week went', 'the week so far'],
  plans: ['what to do next weekend', 'making vague plans', 'somewhere they should go'],
  people: ['people they both know', 'someone they used to know', 'who is doing what these days'],
  food: ['where to eat next time', 'food, as usual', 'the best thing either of them has eaten lately'],
  money: ['how expensive everything is', 'rent', 'what things cost now'],
  shows: ['something {she} watched', 'a show he should start', 'a film neither of them finished'],
  city: ['how the city has changed', 'the traffic', 'a place that closed down'],
  travel: ['a trip they keep talking about', 'somewhere {she} went once', 'going away for a few days'],
  nothing: ['nothing in particular', 'nothing important', 'whatever comes to mind'],
});

// How a topic is introduced. `{t}` is the topic's words.
export const TOPIC_NEW = Object.freeze(['talking about {t}', 'on to {t}', 'got onto {t}', 'somehow onto {t}', '{t}, mostly']);
// Only for what is hers to tell: he can ask about her job, not about the traffic.
export const TOPIC_NEW_HERS = Object.freeze(['he asked about {t}', '{she} brought up {t}', '{she} told him about {t}']);
export const HER_TOPICS = Object.freeze(new Set(['job', 'beat:hobby', 'beat:status', 'beat:news', 'beat:milestone', 'hometown']));
export const TOPIC_STILL = Object.freeze(['still on {t}', 'still talking about {t}', '{t}, still']);
export const TOPIC_BACK = Object.freeze(['back to {t}', 'back on {t} again', 'circling back to {t}']);

// ── what's happening, by phase and how it's going ───────────────────────────
// Keys: `<phase>` or `<phase>.<mood>` where mood is high | ok | low (how she is doing).
export const GENERAL = Object.freeze({
  arriving: ['just got here', 'the hellos', 'getting started'],
  'arriving.high': ["{she's} already smiling", '{she} hugged him hello', 'a big hello', '{she} waved him over'],
  'arriving.low': ['a quick hello', 'a slightly stiff hello', 'not much of a hello'],
  settling: ['the small talk', 'warming up', 'easing into it'],
  'settling.high': ['already laughing about something', 'straight into it', 'straight into a story'],
  'settling.low': ['polite so far', 'a bit careful with each other', 'small talk, and not much of it'],
  'main.high': ["{she's} laughing", '{she} laughed so hard {she} had to stop', "{she's} telling it with {her} hands", 'he made {them} laugh', 'neither of them has looked at the time', 'talking over each other', '{she} remembered something and lit up', "{she's} doing an impression of someone", 'the good kind of argument', "{she's} on a roll", 'he keeps asking questions', '{she} leaned in for that one', 'they keep finishing each other\'s sentences'],
  'main.ok': ['easy conversation', "he's mostly listening", 'trading stories', 'nothing dramatic, just talking', "{she's} explaining something", 'he told {them} about his week', '{she} asked what he thinks', 'an easy back and forth', '{she} corrected him on a detail', 'a small disagreement, nothing serious', "{she's} thinking about it", 'comparing notes'],
  'main.low': ['{she} went a bit quiet', 'the talk keeps stalling', 'a bit stiff', '{she} checked the time', "he's trying", 'one-word answers', "{she's} not really in it", 'something he said landed badly', 'a pause that went on too long', "{she's} looking past him", 'they\'re both being polite about it', 'he changed the subject, twice'],
  lull: ['a quiet stretch', "nobody's said anything for a bit", 'a comfortable silence', 'both looking at nothing', 'a lull', 'the conversation drew breath', 'quiet for a minute'],
  'lull.low': ['an awkward quiet', 'neither of them has much to say', 'he looked at his hands', 'the silence is getting long'],
  winding: ['starting to wrap up', '{she} looked at the time', 'one more story, then home', 'talk of tomorrow', 'the end of it is in sight', 'slowing down now', 'that was the last of it, nearly'],
  'winding.high': ['neither of them wants to go yet', '"we should do this more"', 'five more minutes, again', 'still going, somehow'],
  'winding.low': ['somewhere to be, apparently', 'a polite wrapping up', 'neither of them is pretending now'],
  leaving: ['saying goodbye', 'see you soon', 'the last few words', 'the long goodbye'],
  'leaving.high': ['still talking on the way out', '{she} said to text when he gets home', 'a proper goodbye'],
  'leaving.low': ['a quick goodbye', 'a short goodbye, no plans made', 'done for today'],
});

// Only somewhere you sit down and talk (not at a film, a walk, a shop or a game).
export const SITTING = Object.freeze({
  arriving: ['sorting out where to sit', 'still finding their feet here'],
  settling: ['settling in'],
  leaving: ['getting up to go', 'nearly out the door'],
});

// Only with someone he already knows.
export const KNOWN = Object.freeze({
  arriving: ["how've you been"],
  settling: ['catching up', 'the usual how-is-everything'],
});

// Only while he has a job, or only at the right time of day.
export const EMPLOYED = Object.freeze({ main: ['he told the one about the office'], 'main.ok': ['he complained about work, briefly'] });
export const EVENING = Object.freeze({
  winding: ['the end of the evening is in sight'],
  outdoor: ['the light is going'],
});

// By the kind of place or outing. Keys as above.
export const PLACES = Object.freeze({
  cafe: {
    settling: ['ordering at the counter', 'waiting on the coffee', 'a table by the window', 'coffee on the way'],
    early: ['first sips', 'the coffee arrived', 'sharing a slice of something'],
    main: ['second coffee', "{she's} stirring {her} cup", 'someone at the next table keeps looking over', 'sharing a slice of something', 'the cafe has filled up around them'],
    late: ["the coffee's gone cold", 'a third coffee, at this point', 'they have outlasted the table next to them', 'the staff have stopped asking'],
    lull: ['watching people go by', 'he finished his coffee', 'stirring an empty cup'],
    winding: ['the cups are empty', 'the staff have started wiping tables'],
  },
  food: {
    settling: ['looking at the menu', 'ordering', 'arguing about what to share', 'waiting for the food'],
    // A meal has an order: nobody shares food that hasn't come, or finishes it twice.
    early: ['still waiting on the food', 'the food arrived', 'the first plates are here'],
    main: ['trying each other\'s food', 'halfway through the plates', "{she's} stealing from his plate", 'too full, still eating', 'just eating for a while'],
    late: ['the plates are long gone', 'the waiter came by again', 'still at the table, nothing left on it', 'one more coffee, to justify the table'],
    lull: ['the waiter came by again', 'looking at the dessert menu'],
    winding: ['the bill is on the table', 'arguing about the bill', 'dessert, or not'],
    leaving: ['settling up', 'splitting the bill'],
  },
  bar: {
    settling: ['first round', 'finding a corner', 'getting drinks in'],
    main: ['another round', 'the music got louder', 'talking over the noise', 'the place is filling up', "it's getting loud in here", 'someone bought a round'],
    lull: ['watching the room', 'nursing a drink'],
    winding: ['last round', 'one for the road, maybe', 'the crowd is thinning'],
  },
  watch: {
    arriving: ['finding their seats', 'getting snacks first', 'in the queue'],
    settling: ['the trailers', 'lights going down'],
    main: ["it's started", 'no talking now', 'still watching', '{she} whispered something', 'a good bit', 'the slow part', 'sharing the snacks', 'nobody is checking their phone', 'a laugh from the row behind', 'he has lost track of who is who', 'a twist, of sorts'],
    middle: ['about halfway through'],
    winding: ['nearly over', 'the ending', 'people are starting to leave'],
    leaving: ['talking about it on the way out', 'the credits', 'arguing about the ending'],
  },
  outdoor: {
    arriving: ['met at the gate', 'starting off'],
    main: ['walking, slowly', 'found a bench', 'taking the long way round', 'stopped to look at something', 'a dog ran past', 'walking and talking', 'one more loop'],
    lull: ['just walking', 'sitting on a bench for a bit'],
    winding: ['heading back', 'turning back now'],
    leaving: ['parting at the gate', 'going their own ways from here'],
  },
  home: {
    arriving: ['{she} just got in', 'shoes off at the door', 'making tea first', 'the door was open'],
    settling: ['on the sofa', 'something on in the background', 'getting comfortable'],
    main: ['tea, again', 'the TV is on, nobody is watching', 'in the kitchen, still talking', 'looking through old photos', 'he made something to eat', 'music on, low', 'feet up'],
    lull: ['a quiet stretch on the sofa', 'the TV has taken over'],
    winding: ['{she} found {her} keys', '{she} said it was time to go, again', 'washing up the cups'],
    leaving: ['walking {them} to the door', 'at the door, still talking'],
  },
  shop: {
    arriving: ['just wandered in'],
    settling: ['having a look around'],
    main: ['browsing', 'comparing two of the same thing', '{she} found something', 'in the queue', 'he held the bags', 'not buying anything, probably'],
    lull: ['wandering down another aisle'],
    winding: ['paying', 'one last look'],
  },
  event: {
    arriving: ['in the queue', 'finding a good spot'],
    settling: ['waiting for it to start', "it's about to start"],
    main: ["it's loud", 'a good crowd', 'caught up in it', 'the best bit so far', 'shouting to be heard'],
    lull: ['a break between things', 'getting a drink in the break'],
    winding: ['the last bit', 'people are drifting out'],
    leaving: ['ears ringing', 'going over the best bits'],
  },
  active: {
    arriving: ['warming up', 'getting set up'],
    settling: ['warming up, trash talk first'],
    main: ["he's losing", "{she's} winning, loudly", 'one more game', 'close game', 'catching his breath', 'best of three, now'],
    lull: ['a water break', 'a breather'],
    winding: ['last game', 'calling it soon'],
  },
});

// Details that hold regardless of the phase, when the state says so.
export const DETAILS = Object.freeze({
  first: ['the first few careful minutes', 'still working each other out', 'finding out what they have in common', 'first impressions, going fine', 'telling the short version of his life'],
  late: ['he got here late, apologising', '{she} had been waiting a while', 'he owes {them} one for the wait'],
  rain: ['rain on the window', "it's pouring outside, nobody is in a hurry", 'waiting out the rain'],
  rainOut: ['caught in the rain', 'sheltering under something', 'getting wet, laughing about it'],
  late_night: ["it's getting late", 'one of the last still up', 'past when either of them meant to be out', 'the streets have gone quiet'],
  morning: ['still waking up', 'the day has barely started', 'a slow start to the day'],
  tired: ['he stifled a yawn', "he's fading a bit", 'his energy is going', 'he could sleep right here', 'running on not much sleep'],
  fresh: ['he has energy for once', "he's in a good mood today"],
  low_mood: ["he's not quite himself", "his mind's somewhere else", "he's quieter than usual"],
  high_mood: ["he's in a good mood", "he's enjoying this", "he's glad he came"],
  sick: ['he is not feeling great', 'he is trying not to cough', "he probably shouldn't have come out"],
  group: ['they are ganging up on him', "he can't get a word in", 'three conversations at once', 'someone has gone to get more'],
  close: ["they've done this a hundred times", 'the old jokes', 'they don\'t need to explain much to each other'],
  tense: ['something between them is still not said', 'careful around one subject', 'a bit of an edge to it'],
});

// His phone. Who it was comes from the log; whether he answers is the phone's, never decided here.
export const PHONE = Object.freeze({
  buzz: ['his phone buzzed, he put it face down', 'his phone lit up, he ignored it', 'a text came in, he left it', 'his phone buzzed in his pocket', 'he glanced at his phone and put it away', 'his phone went, he let it go'],
  buzzSeen: ['his phone buzzed, {she} saw him look', '{she} noticed his phone light up', 'his phone buzzed and {she} stopped mid-sentence'],
  named: ['a text from {who}, he left it for now', '{who} texted, he put it away', '{who} again, not now'],
  answered: ['he answered {who}, quickly', 'he texted {who} back', 'he took a second to answer {who}'],
  answeredSeen: ['he answered {who}, {she} noticed', 'he was on his phone to {who} for a bit, {she} went quiet', '{she} waited while he texted {who}'],
  many: ['his phone keeps going', 'his phone keeps buzzing, he turned it over', 'a run of messages, he silenced it', 'his phone will not stop'],
  chats: ['his group chats are busy', 'a group is buzzing on his phone', 'messages piling up on his phone'],
  chatsSent: ['he typed something into a group', 'he answered a chat, quickly', 'he was on his phone for a minute'],
  after: ['back to the conversation', '{she} let it go', 'he said sorry about that'],
});

// The one neutral form for a private (explicit-register) session: the code line and nothing else.
export const PRIVATE = Object.freeze(['a quiet time in', 'just the two of them', 'no plans to go anywhere', 'phone on silent']);
