# Contributing to Karyasthan

Thanks for your interest! This is a personal/research project — contributions that improve the engine (decision-making, memory, skills, providers, dashboard) are welcome. Persona content is per-user and not something to contribute.

## Dev setup

```bash
git clone https://github.com/avikshith-np/karyasthan.git
cd karyasthan
npm install
```

Then create a persona so the app can boot. Either run the wizard:

```bash
npm run setup
```

…or set it up by hand:

```bash
cp src/personality/persona.example.json src/personality/persona.json
cp src/personality/identity.example.md   src/personality/identity.md
cp .env.example .env        # then fill in an LLM key
```

Run it locally with pretty logs:

```bash
npm run dev
```

Set `DRY_RUN=true` in `.env` to log responses instead of sending them to WhatsApp while developing.

## Useful scripts

```bash
npm run test:llm        # smoke-test the configured LLM connection
npm run test:decision   # exercise the decision engine on mock messages
npm run inspect         # introspect the memory DB (stats/people/groups/slang)
node scripts/smoke-dashboard.js   # boot the dashboard API without Baileys (port 7071)
```

## Code style

- ESM only (`"type": "module"`) — use `import`/`export`.
- Match the surrounding style; keep modules small and focused.
- Don't hardcode persona details (name, language, region). Read them from `getPersona()` in `src/utils/config.js` so every install stays configurable.
- Avoid adding dependencies unless there's a clear reason — the setup wizard, for instance, uses only Node built-ins.

## Pull requests

- Keep PRs focused; describe what changed and why.
- Make sure `npm run test:decision` and the relevant smoke scripts still pass.
- Note any new `.env` variables in `.env.example` and any architectural change in `CLAUDE.md`.

## Never commit

`.env`, `.env.bak*`, the `data/` directory (WhatsApp credentials + chat history), `src/personality/identity.md`, `src/personality/persona.json`, or anything containing real API keys or personal chat data. These are gitignored — keep it that way. If you leak a key, rotate it.
