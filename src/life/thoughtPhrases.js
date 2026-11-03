// The words of the thought stream (plan 020 F2): clipped, lower case, like real inner speech. Code only.
// Nothing here is sexual or suggestive, at any heat, for anyone. No persona, no place, no real name:
// {name} is a fictional cast member's first name, {plan} a code-built word for a plan, {she}/{her}/{them}
// their pronouns, {she's} she's|he's|they're.

// ── reactions: to what just happened ────────────────────────────────────────
export const REACTIONS = Object.freeze({
  rain_start: ['ugh, rain', 'of course it\'s raining', 'rain. great', 'there it goes', 'should\'ve brought something', 'and now it rains', 'smell of rain', 'that came out of nowhere'],
  rain_stop: ['finally stopped', 'dry at last', 'that\'s over then'],
  soaked: ['soaked', 'completely soaked', 'socks. wet. great', 'why did I walk', 'dripping', 'next time, a cab'],
  plan_off: ['so much for that', 'oh well', 'fine then', 'didn\'t want to anyway. did I?', 'that\'s that', 'well', 'never mind then', 'one less thing'],
  missed: ['missed it', 'too late now', 'should\'ve left earlier', 'ugh, missed it', 'that\'s on me'],
  scene_well: ['that was good', 'that was actually really good', 'needed that', 'good evening, that', 'should do that more', 'still smiling, stupidly', 'huh. nice'],
  scene_fine: ['that was fine', 'nice enough', 'good to get out', 'not bad'],
  scene_flat: ['could\'ve stayed home', 'meh', 'that was a lot of effort for that', 'not sure what that was', 'oh well'],
  scene_badly: ['well. that happened', 'why did I say that', 'that went badly', 'going over it again', 'should\'ve kept quiet', 'not thinking about it. thinking about it', 'ugh'],
  salary: ['salary\'s in', 'money, briefly', 'rich for a week', 'finally', 'and most of it is gone already'],
  rent: ['there goes the rent', 'rent. already?', 'gone, just like that'],
  big_spend: ['that cost more than I thought', 'ouch', 'shouldn\'t have', 'worth it. probably', 'there goes that'],
  low_money: ['need to watch the money', 'careful now', 'how is it gone already', 'no more eating out'],
  work_late: ['still here', 'everyone else has gone', 'one more thing, then out', 'why am I still here'],
  crunch: ['deadline', 'too much, too little time', 'how is this due already', 'not going to make it. going to make it'],
  sick_start: ['something\'s coming on', 'head\'s heavy', 'not now', 'great, sick', 'throat\'s going'],
  sick_end: ['feeling human again', 'finally better', 'back, more or less'],
  woke: ['already?', 'five more minutes', 'what day is it', 'too early', 'okay. up', 'coffee first', 'that alarm', 'where\'s my phone', 'didn\'t sleep enough'],
  woke_late: ['slept in', 'how is it this late', 'oh no. oh, it\'s fine', 'that felt good'],
  woken: ['why am I awake', 'can\'t sleep', 'what time is it', 'staring at the ceiling', 'brain, please'],
  job_gone: ['what now', 'so that\'s that', 'need to tell someone. who', 'okay. okay', 'breathe'],
  job_new: ['new job. huh', 'don\'t mess this up', 'okay, a fresh start', 'first day nerves already'],
  moved: ['still don\'t know where anything is', 'new place, strange sounds', 'home, apparently'],
  birthday: ['another year', 'older. wiser? no', 'nobody needs to make a fuss. a little fuss'],
  // Ambient, by what he's doing.
  work: ['this could have been an email', 'what was I doing', 'still hours to go', 'where did that file go', 'need a coffee', 'why is this so slow', 'okay, focus', 'one thing at a time', 'nobody reads these', 'that\'s not my job. is it', 'look busy', 'that tab again', 'who wrote this', 'nearly done. not nearly done', 'quiet in here today', 'this again', 'back to it', 'that actually worked', 'huh, that was easy'],
  meeting: ['is this still going', 'what was the question', 'nod. keep nodding', 'he said that last week', 'could leave now', 'don\'t look at the clock', 'say something useful', 'we\'ve been over this', 'whose turn is it', 'five minutes left. sure', 'am I on mute', 'what are we deciding'],
  commute: ['why is everyone so slow', 'nearly there', 'wrong lane', 'that song again', 'should\'ve left earlier', 'same road, every day', 'look at that sky', 'stuck', 'moving, finally', 'who drives like that', 'getting there', 'long way today', 'nice out, actually'],
  meal: ['this is good', 'needed that', 'could use more salt', 'not bad', 'what\'s for later', 'eating too fast'],
  gym: ['last set', 'why do I do this', 'legs', 'okay, one more', 'tomorrow is going to hurt', 'feels good, actually', 'nobody\'s looking. everyone\'s looking'],
  home: ['quiet in here', 'should tidy up', 'where did I put that', 'nothing in the fridge', 'nice to be home', 'what was I doing', 'that tap again', 'whose turn to clean', 'might read something', 'the neighbours again', 'good light in here right now'],
  tv: ['one more episode', 'seen this one', 'who is that again', 'what am I watching', 'this is terrible. keep going', 'how is it that late', 'nothing on', 'I\'ve seen this ending coming for ages'],
  errand: ['what was I here for', 'should\'ve made a list', 'long queue', 'forgot the one thing', 'nearly done', 'how much?', 'in and out, that\'s all'],
  outside: ['nice out', 'should do this more', 'good air', 'keep walking', 'where was I going', 'that\'s new, was that always there'],
  wait: ['come on', 'still early', 'what do I do with my hands', 'should\'ve brought something to read'],
});

// ── want vs should ──────────────────────────────────────────────────────────
export const WANT_SHOULD = Object.freeze({
  committed_dont_feel: ['said I\'d go… don\'t feel like it', 'why did I say yes', '{plan}… do I have to', 'could cancel. can\'t cancel', 'said yes. why', 'it\'ll be fine once I\'m there', 'too late to back out now', 'maybe it gets cancelled'],
  committed_tired: ['{plan}, and I\'m wrecked', 'said I\'d go… so tired', 'how do I have the energy for {plan}', 'just go', 'an hour. then home'],
  committed_people: ['can\'t do people tonight', 'said yes… no more people though', '{plan}… be nice', 'just nod and smile'],
  open_should_go: ['should go, really', 'should say yes', 'it\'d be good for me', 'been ages. should go'],
  open_want_go: ['want to go', 'would be nice, {plan}', 'probably should stay in… don\'t want to', 'go on then. maybe'],
  should_work: ['should be working', 'that thing is due', 'I could do it now. could', 'not thinking about work. thinking about work'],
  should_move: ['should get out', 'haven\'t moved all day', 'should go for a walk', 'gym tomorrow. definitely'],
  should_eat: ['should eat something real', 'should eat. later', 'that wasn\'t a meal'],
  should_sleep: ['should sleep', 'should be asleep by now', 'tomorrow me will hate this'],
  should_call_home: ['should call home', 'been a while since I called', 'said I\'d call home… didn\'t', 'call home. this week'],
  intention: {
    follow_up: ['said I\'d get back to them… didn\'t', 'meant to follow that up', 'that thing I said I\'d do', 'still haven\'t got back to them'],
    check_in: ['should check in on them', 'meant to ask how they are', 'said I\'d check in… haven\'t'],
    share: ['meant to tell them about that', 'should tell them', 'keep forgetting to mention that'],
    wind_down: ['said I\'d take it easy', 'slow down, you said', 'supposed to be resting'],
    be_present: ['stop looking at the phone', 'be here, you said', 'put it away'],
    keep_quiet: ['say less', 'stay out of it', 'not my business, you said'],
    catch_up: ['so far behind on everything', 'need to catch up', 'all those messages'],
  },
});

// ── putting things off ──────────────────────────────────────────────────────
export const PUTTING_OFF = Object.freeze({
  decide_later: ['decide later', 'don\'t have to decide yet', 'think about it tomorrow', '{plan}… later', 'still time'],
  reply_later: ['should reply to {name}', 'I\'ll reply later', 'later, {name}', 'need to answer {name}', '{name}\'s still waiting. I know', 'in a minute, {name}'],
  bedtime: ['one more, then bed', 'five more minutes', 'not tired. very tired', 'bed soon', 'why am I still up', 'just this one thing', 'it\'s not that late. it is', 'tomorrow is a problem for tomorrow'],
  morning: ['five more minutes', 'do I have to', 'just a bit longer', 'I can skip breakfast', 'can\'t I just not'],
  chores: ['the dishes can wait', 'laundry, tomorrow', 'I\'ll sort that out at the weekend', 'that can wait', 'not today', 'later', 'I\'ll deal with it', 'it\'s been there this long', 'next week', 'I\'ll get to it', 'that form. tomorrow', 'should really fix that'],
  work: ['after this', 'I\'ll do that after lunch', 'tomorrow, first thing', 'just check one thing first', 'that one can wait', 'once this is done', 'I\'ll start in a minute', 'not before coffee', 'I\'ll look at it later'],
  goal: ['still haven\'t done that', 'been meaning to', 'this week, definitely', 'when I get a free evening'],
});

// ── his body ────────────────────────────────────────────────────────────────
export const BODY = Object.freeze({
  starving: ['starving', 'so hungry', 'need food', 'could eat anything', 'when did I last eat', 'stomach, please'],
  peckish: ['bit hungry', 'getting hungry', 'something to eat, soon', 'is there anything to snack on'],
  full: ['too full', 'ate too much', 'that was a lot', 'need to sit a minute'],
  wrecked: ['wrecked', 'so tired', 'can barely keep my eyes open', 'head on the desk, just for a second', 'done for', 'running on nothing', 'tired tired'],
  tired: ['tired', 'getting tired', 'could use a nap', 'heavy eyes', 'slowing down', 'yawn'],
  rested: ['feel good today', 'slept well for once', 'awake, properly', 'lots of energy, weirdly'],
  sleep_debt: ['haven\'t slept enough', 'need a whole weekend of sleep', 'catching up on sleep, one day', 'too many late nights'],
  stress: ['shoulders', 'jaw, unclench', 'breathe', 'too much going on', 'heart\'s going', 'calm down', 'one thing at a time'],
  people_out: ['no more people', 'need to be alone', 'peopled out', 'just want quiet', 'don\'t talk to me'],
  sick: ['head hurts', 'throat', 'everything aches', 'should be in bed', 'hot. cold. hot', 'can\'t focus', 'need to lie down', 'this is awful', 'water. then sleep'],
  hot: ['too hot', 'sweating already', 'need a fan', 'how is it this hot'],
  cold: ['cold', 'should\'ve brought a jacket', 'freezing, actually'],
  back: ['back hurts', 'need to stretch', 'this chair', 'neck'],
});

// ── people ──────────────────────────────────────────────────────────────────
export const PEOPLE = Object.freeze({
  text_in: ['{name} texted', 'oh, {name}', '{name} again', 'what does {name} want', 'nice, {name}', 'should answer that'],
  text_in_with: ['not now', 'leave it', 'it can wait', 'don\'t look', 'later', 'face down', 'who\'s that. no. later'],
  text_sent: ['sent', 'too much?', 'why did I word it like that', 'now I wait', 'don\'t check', 'should\'ve said less'],
  closer: ['{name}, huh', 'I like {name}', 'that\'s going well', 'good with {name} lately', 'easy, with {name}'],
  further: ['something off with {name}', 'what did I do', 'should sort that out with {name}', 'was I short with {name}'],
  romance: ['{name}', 'thinking about {name}', 'stop smiling', 'what is this', 'don\'t overthink it. overthinking it', '{name}, again'],
  news: ['{name}\'s got news', 'good for {name}', 'huh, {name}', 'should ask {name} about that'],
  departed: ['wonder what {name}\'s up to', 'haven\'t heard from {name}', 'miss {name}, a bit', 'strange without {name}', 'should write to {name}. wouldn\'t know what to say'],
  gone_now: ['so {name}\'s gone', 'didn\'t think {name} would actually leave', 'quiet without {name}'],
  back_now: ['{name}\'s back', 'good, {name}\'s back'],
  family: ['should call home', 'that call', 'they worry too much', 'good to hear from them'],
  // Someone close, for no reason.
  ambient: ['wonder how {name}\'s doing', 'should text {name}', '{name} would love this', 'owe {name} a call', 'haven\'t seen {name} in a while', 'must tell {name} about that', 'what would {name} say', '{name} was right, annoyingly', 'that\'s such a {name} thing', 'need to see {name} soon'],
  romance_ambient: ['{name}', 'thinking about {name}', 'should text {name}. too soon?', 'what\'s {name} doing now', 'stop checking', 'that thing {name} said', 'not thinking about {name}. thinking about {name}'],
  // At lunch or in a meeting with someone from work.
  with_work: ['{name} won\'t stop talking', 'don\'t talk shop', '{name}\'s lunch looks better', 'nod, {name}\'s still going', 'I should ask {name} about that thing'],
  // In the same room, on an ordinary evening.
  with_home: ['{name}\'s in a mood', '{name} and that song again', 'should ask {name} about the bills', 'nice, having {name} around', 'that\'s {name}\'s plate. it\'s always {name}\'s plate', '{name} never closes that door', 'should do something with {name} this weekend'],
  // While he is with them, by how it's going. {she}/{her}/{them} = who's there.
  out_arriving: ['be normal', 'don\'t be late', 'spotted {them}', 'okay. smile', 'what do I say first'],
  out_arriving_first: ['what do I even say', 'be normal', 'don\'t talk too much', 'first impressions'],
  out_settling: ['this is fine', 'relax', 'stop fidgeting', 'what do I order'],
  out_main_high: ['{she\'s} funny', 'this is nice', 'I missed this', 'don\'t check the time', 'why don\'t we do this more', 'good to see {them}', 'how does {she} remember that'],
  out_main_ok: ['nice to be out', 'what were we saying', 'okay, this is okay', 'I should say something', 'where did {she} get that', 'keep listening', 'wait, who is that'],
  out_main_low: ['what time is it', 'why did I say that', '{she\'s} not listening', 'I should go', 'say something', 'this is hard work', 'how do I get out of this', 'was that rude'],
  out_lull: ['say something', 'it\'s fine, it\'s quiet', 'what time is it', 'don\'t look at the phone', 'nice, this', 'what now'],
  out_winding: ['should go soon', 'it\'s late', 'that went quickly', 'one more, then go', 'how do I get home'],
  out_leaving: ['do I hug {them}', 'text when home?', 'that was nice', 'right. home', 'finally'],
  out_group: ['too many people talking', 'lost the thread', 'nod', 'who said that', 'I like these two'],
  out_plain: ['nice to be out', 'good to get out', 'what time is it', 'should do this more'],
});

// ── wordless: a feeling, an image, nothing in particular ────────────────────
export const WORDLESS = Object.freeze({
  neutral: ['…', '(nothing in particular)', '(staring at nothing)', '(a song stuck in his head)', '(the same four bars, again)', '(a smell he can\'t place)', '(an old street, for no reason)', '(a door he forgot about)', '(someone\'s laugh, years ago)', '(what was that word)', '(a face, no name)', '(the light on the wall)', '(a line from something)', '(counting, for no reason)', '(a place he went once)', '(nothing)', '(the sound of the fan)', '(half a thought, gone)', '(a tune with no words)'],
  warm: ['(a small good feeling, no reason)', '(light, for some reason)', '(warm, somehow)', '(everything\'s fine for a second)', '(a little lift)', '(that good kind of tired)'],
  flat: ['(flat)', '(grey, a bit)', '(something heavy, no name for it)', '(a bit far away)', '(not sad. not anything)', '(a low hum of something)'],
  uneasy: ['(something off about today)', '(a knot, somewhere)', '(forgot something. what)', '(uneasy, no reason)', '(the feeling of a thing undone)'],
  // A chat's mark on him: a feeling only, never what was said.
  chat_warm: ['(that made his day, a bit)', '(still smiling about that)', '(nice to be thought of)', '(warm, after that)'],
  chat_sting: ['(that stung, a bit)', '(still annoyed about that)', '(going over it, again)', '(should\'ve said something back)', '(a small sting)'],
  chat_flirt: ['(a bit pleased with himself)', '(smiling at his phone)'],
  chat_worry: ['(worried about that)', '(hope that\'s okay)', '(that stayed with him)'],
  chat_plain: ['(something someone said)', '(a chat, still in his head)'],
  // A private session: neutral words only.
  private: ['(quiet)', '(nothing else matters right now)', '(no phone)', '(just this)'],
  // A heavy stretch: quiet. Nothing dark is invented here.
  heavy: ['…', '(quiet)', '(not much to say)', '(one thing, then the next)', '(tired)', '(getting through it)', '(nothing, for a while)'],
});

// ── the excuse after a choice against his lean ──────────────────────────────
export const EXCUSES = Object.freeze({
  went: ['might as well', 'it\'d be rude not to', 'only for a bit', 'I said I would', 'be good for me', 'couldn\'t really say no', 'just go', 'I\'d have felt bad', 'it\'s only a couple of hours', 'wasn\'t doing anything anyway', 'fine. going', 'I wanted to, really'],
  stayed: ['was tired anyway', 'would\'ve been a late one', 'they won\'t mind', 'needed the rest', 'probably wouldn\'t have been that good', 'saved money, at least', 'next time', 'had things to do anyway', 'I did the right thing', 'it\'s fine', 'it would\'ve rained'],
  other: ['it\'s fine', 'made sense at the time', 'what else was I going to do', 'not a big deal', 'I\'d do the same again. probably'],
});

/** The plain name for a plan with someone real or from a chat. */
export const PLAN_WITH_A_FRIEND = 'plans with a friend';
