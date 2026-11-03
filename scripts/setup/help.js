// What typing ? at a question prints. docs/install.md carries the same text
// (test:install checks that every first line appears there).
export const HELP = {
  keys: `A key lets it use a model, and you pay that company directly. Any mix works.
Google Gemini: aistudio.google.com/apikey (free tier, enough to start)
Anthropic: console.anthropic.com/settings/keys
OpenRouter: openrouter.ai/keys (add a little credit)
xAI: console.x.ai
OpenAI: platform.openai.com/api-keys
Zhipu GLM: open.bigmodel.cn
Ollama and other local servers need no key.
New to this? Start with Gemini.`,
  jobs: `Each job can use a different model. Cheap and fast suits replies and background work. A strong model only earns its price on deep thinking.
Press Enter to accept these, or type a job's number to change its provider and model. You can change this later with npm run setup.`,
  template: `A starting point for how it comes across. Every answer on the next screen can be changed, and identity.md can be edited freely afterwards.
Choose blank to write your own.`,
  name: `What people will call it. It answers when this name appears in a message, so a very short or common word makes it think everyone means it.`,
  aliases: `Nicknames it also answers to. Names of 3 letters or fewer must stand alone: "sam" won't match "same". Longer ones may carry an ending.`,
  age: `Blank is fine. The character must be an adult: 18 to 100. If you turn life on, this sets its birthday.`,
  from: `Blank is fine. It shapes how it talks and, with life on, where its world is.`,
  language: `The language it talks in by default. It still follows what the group is using.`,
  mix: `Say yes only if your groups really mix languages in one sentence. No keeps everything simple.`,
  personality: `One line, in plain words. Specifics beat adjectives. You can edit identity.md later for more.`,
  number: `The number the character will use, so people will message it there. It needs WhatsApp on a phone you control: a spare SIM or eSIM.
Good: a spare number you can lose. Bad: your own, it would answer your friends as you.
Include the country code, like +44 7700 900123. Spaces are fine.`,
  owner: `Your own number. It marks you as the owner and it never starts a conversation with you. Blank is fine; it's only needed for live proactive messages.`,
  warmup: `A new number that sends a lot gets banned. Warmup limits it: reactions only for 3 days, then 15 to 50 messages a day until day 22. Say no only if the number has been in normal use for a while.`,
  timezone: `Its day runs on this clock, and it's permanent once a world exists. Use a name like Africa/Lagos or Europe/Paris.`,
  abilities: `Type numbers to switch those on or off. Anything marked n/a can't work yet and says why.
A life of its own: routine, job, cast and story arcs on the real clock. The mind: thinks daily and sleeps on each day. Both call your deep thinking model.`,
  budget: `The most to spend across all models in a calendar month, in US dollars. Past it, background work stops and replies keep going, so it never goes silent.`,
  dashboard: `A private web page to watch it and steer it. It only listens on this machine; reach it through an SSH tunnel.`,
  password: `10 characters or more. Only a hash is stored.`,
  review: `Type a step's number to change it. Enter moves on to linking WhatsApp.`,
  link: `This links the bot's number to this install, like WhatsApp Web. You'll type a code into the phone. Nothing is sent to anyone.`,
};
