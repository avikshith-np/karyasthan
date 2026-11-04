# Installing Karyasthan

You'll need a spare WhatsApp number, one model key, and about ten minutes. The commands work on Linux and macOS; on Windows, use WSL.

```bash
curl -fsSL https://raw.githubusercontent.com/avikshith-np/karyasthan/main/install.sh | bash
```

If anything goes wrong, fix what it says and run the same command again. It carries on from there, and Ctrl-C at any question is safe. Type `?` at any question for the help below.

## 1. Models

A key lets it use a model, and you pay that company directly. Any mix works.

- Google Gemini: aistudio.google.com/apikey (free tier, enough to start)
- Anthropic: console.anthropic.com/settings/keys
- OpenRouter: openrouter.ai/keys (add a little credit)
- xAI: console.x.ai
- OpenAI: platform.openai.com/api-keys
- Zhipu GLM: open.bigmodel.cn
- Ollama and other local servers need no key.

New to this? Start with Gemini.

Each job can use a different model. Cheap and fast suits replies and background work. A strong model only earns its price on deep thinking.

Setup shows a suggestion for each job, based on the keys you gave. Press Enter to accept, or type a job's number to change its provider and model. Each choice answers one small test call before it's saved. A model setup has no price for asks you for one, because budgets can't count it otherwise, and the mind refuses to run on it.

## 2. Character

A starting point for how it comes across. Every answer on the next screen can be changed, and identity.md can be edited freely afterwards.

| Template | How it comes across |
|---|---|
| The dry friend | sarcastic, loyal, says little and lands it |
| The warm one | remembers everything, checks in, easy to talk to |
| The chaos friend | loud, funny, always has a plan at 1 am |
| The quiet nerd | few words, knows odd things, opinions on tools |
| The organiser | makes plans happen, chases everyone, kind about it |

- **Name.** What people will call it. It answers when this name appears in a message, so a very short or common word makes it think everyone means it.
- **Other names.** Nicknames it also answers to. Names of 3 letters or fewer must stand alone: "sam" won't match "same". Longer ones may carry an ending.
- **Age.** Blank is fine. The character must be an adult: 18 to 100. If you turn life on, this sets its birthday.
- **From.** Blank is fine. It shapes how it talks and, with life on, where its world is.
- **Language.** The language it talks in by default. It still follows what the group is using.
- **Mixing languages.** Say yes only if your groups really mix languages in one sentence. No keeps everything simple.
- **Personality.** One line, in plain words. Specifics beat adjectives. You can edit identity.md later for more.

## 3. Numbers and time zone

- **Its number.** The number the character will use, so people will message it there. It needs WhatsApp on a phone you control: a spare SIM or eSIM. Good: a spare number you can lose. Bad: your own, it would answer your friends as you. Include the country code, like +44 7700 900123. Spaces are fine.
- **Your number.** Your own number. It marks you as the owner and it never starts a conversation with you. Blank is fine; it's only needed for live proactive messages.
- **Warmup.** A new number that sends a lot gets banned. Warmup limits it: reactions only for 3 days, then 15 to 50 messages a day until day 22. Say no only if the number has been in normal use for a while.
- **Time zone.** Its day runs on this clock, and it's permanent once a world exists. Use a name like Africa/Lagos or Europe/Paris.

## 4. What it can do

Type numbers to switch those on or off. Anything marked n/a can't work yet and says why.

A life of its own: routine, job, cast and story arcs on the real clock. The mind: thinks daily and sleeps on each day. Both call your deep thinking model.

**Budget.** The most to spend across all models in a calendar month, in US dollars. Past it, background work stops and replies keep going, so it never goes silent.

## 5. Dashboard

A private web page to watch it and steer it. It only listens on this machine; reach it through an SSH tunnel.

**Password.** 10 characters or more. Only a hash is stored.

## Review

Type a step's number to change it. Enter moves on to linking WhatsApp.

## Link WhatsApp

This links the bot's number to this install, like WhatsApp Web. You'll type a code into the phone. Nothing is sent to anyone.

On the bot's phone: WhatsApp → Linked Devices → Link a Device → Link with phone number instead. Then keep that phone on, and open WhatsApp at least every 14 days, or WhatsApp drops the link.

## First check

This proves the whole chain on one real message. You send the bot's number a WhatsApp message from your own phone; it arrives, and the reply model writes an answer. Nothing is sent, and only your own direct message is read.

## Keep it running

It has to run all the time. Setup offers pm2 or a systemd user service if it finds them, and starts it with your real paths. It never runs sudo: if a step needs it, like surviving a reboot, it prints the exact line. An unlinked bot under a service doesn't keep retrying: it exits with code 78 and says what to do.

## Afterwards

```bash
npm start         # start it
npm run doctor    # check everything; keys and numbers are masked, so it's safe to paste
npm run setup     # change a key, model, character, abilities or dashboard password
```

Silence at first is normal, even in DMs: see "Warmup" above.

## No keyboard

For Docker or CI, set `KARYASTHAN_NONINTERACTIVE=1` and pass everything through the environment. Every value is checked first; a bad one exits with code 2 and writes nothing.

| Variable | What it does |
|---|---|
| `KARYASTHAN_NAME` | Required on a new install |
| `KARYASTHAN_TEMPLATE` | `dry-friend`, `warm-one`, `chaos-friend`, `quiet-nerd` or `organiser` |
| `KARYASTHAN_ALIASES`, `_AGE`, `_REGION`, `_LANGUAGE`, `_VOICE`, `_VIBE` | The other character answers |
| `LLM_PROVIDER`, `LLM_MODEL` | The replies model; suggested if left out |
| `LLM_CLERK_*`, `QUALITY_GATE_*`, `LLM_MIND_*`, `LLM_DESIRE_*` | `_PROVIDER`, `_MODEL`, `_FALLBACK_PROVIDER`, `_FALLBACK_MODEL` for the other jobs |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `LLM_API_KEY`, `GLM_API_KEY` | Keys |
| `WA_PHONE_NUMBER`, `OWNER_JIDS` | Numbers |
| `TIMEZONE` | Detected if left out |
| `KARYASTHAN_ENABLE` | `life`, `mind`, comma-separated |
| `LLM_MONTHLY_BUDGET_USD` | Monthly budget |
| `KARYASTHAN_ALLOW_ROOT` | `1` to run as root, in a container |

Linking WhatsApp always needs a person: `npm run setup`, then Link WhatsApp, or `node scripts/pair.js`.
