# Karyasthan

*Karyasthan* (കാര്യസ്ഥൻ) means **"caretaker"** in Malayalam — someone who looks after a household and knows everyone in it.

It's a WhatsApp group-chat agent that behaves like a real person in the conversation, not a command bot. It reads along, **responds selectively**, remembers the people in the group, forms opinions, and has a personality you define. There's no `/command` prefix and no "How can I help you?" — it just participates.

> ⚠️ **Responsible use.** Running an automated client on WhatsApp may violate WhatsApp's Terms of Service and can get a number banned. Use a number you control, make sure the people in your groups know a bot is present, and treat this as a personal/research project. You are responsible for how you deploy it.

## Features

- **Selective responding** — a multi-factor decision engine (mention, question, humor, momentum, recency…) decides *whether* to reply, so it isn't a chatbot that answers everything.
- **Memory** — long-term SQLite store of people, relationships, nicknames, group vibe, and slang it picks up.
- **Configurable persona** — name, personality, language register, and voice are yours to define (see below).
- **Skills** — e.g. an itemized **bill-split** flow from a photo of a receipt.
- **Rich media** — optional image generation, voice notes (TTS), stickers & GIFs.
- **Multi-provider LLM** — OpenRouter, Anthropic, OpenAI, Gemini, Zhipu GLM, or local Ollama as a fallback.
- **Optional dashboard** — a read-only local web UI to observe people, memories, decisions, and logs.

## Prerequisites

- **Node.js >= 20** and npm
- A **C/C++ build toolchain** + `python3` and `make` (for the native `better-sqlite3` addon — `build-essential` on Debian/Ubuntu, Xcode CLT on macOS)
- A **dedicated WhatsApp number** you can scan/pair from your phone
- At least one **LLM API key** (Google Gemini has a free tier that works well here)

## Quick install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/avikshith-np/karyasthan/main/install.sh | bash
```

The installer checks prerequisites, clones the repo, installs dependencies, and launches the setup wizard.

## Manual install

```bash
git clone https://github.com/avikshith-np/karyasthan.git
cd karyasthan
npm install
npm run setup      # interactive: .env + persona + migrations + pairing
npm start
```

`npm run setup` is idempotent — re-run it any time to change settings or rebuild the persona.

## Configuration

Runtime settings live in `.env` (copy from [`.env.example`](.env.example); the wizard does this for you). Key groups: LLM provider/keys, response behaviour, rate limits, media toggles, and the dashboard. Every variable is documented inline in `.env.example`.

### The persona

The bot's character is split in two, and **both files are gitignored** — every install owns its own:

| File | What it holds | Read by |
|------|---------------|---------|
| `src/personality/persona.json` | structured fields: `name`, `displayName`, `aliases` (names it answers to), `voiceDescriptor`, `region`, `language`, `vibe` | code, via `getPersona()` |
| `src/personality/identity.md` | free-form prose injected into the system prompt | the LLM |

`npm run setup` generates both from your answers. Committed alongside them are `persona.example.json`, `identity.example.md`, and `identity.template.md` — references the wizard renders from and the app falls back to if your files are missing. To tweak your bot later, re-run the wizard or edit `persona.json` / `identity.md` directly (the dashboard can hot-reload `identity.md`).

## Pairing WhatsApp

The wizard offers to do this; to run it standalone:

```bash
node scripts/pair.js 919876543210   # your number, country code + digits only
```

It prints a pairing code — enter it on your phone under **WhatsApp → Linked Devices → Link a Device**. Auth is stored in `data/auth_info_baileys/` (gitignored).

## Dashboard (optional)

A read-only local web UI. Enable it in `.env` (`DASHBOARD_ENABLED=true` + a user/password — the wizard can set this up) and reach it at `http://127.0.0.1:7070`. It binds to localhost only; expose it via an SSH tunnel or Tailscale, never the public internet. See `CLAUDE.md` for the full key list and routes.

## Deployment

A `systemd` unit is provided in [`karyasthan.service`](karyasthan.service). Edit the `User`, paths, and node path to match your install, then:

```bash
sudo cp karyasthan.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now karyasthan
```

## Security

**Never commit** `.env`, `.env.bak*`, the `data/` directory (it holds your WhatsApp session credentials and all chat history), or your `persona.json` / `identity.md`. These are gitignored by default. If a key ever lands in a commit or a backup file, **rotate it** — git history is forever.

## License

[Apache-2.0](LICENSE).
