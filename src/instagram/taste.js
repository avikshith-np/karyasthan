import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { callLlm } from '../brain/llm.js';
import { getIdentityText } from '../personality/systemPrompt.js';

// The persona's taste in reels — what Jev judges every reel against. Per install and
// gitignored like persona.json (src/personality/taste.json); generated once from the
// identity by the LLM, editable on the dashboard. Falls back to the committed example.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../personality');
const TASTE_PATH = path.join(DIR, 'taste.json');
const EXAMPLE_PATH = path.join(DIR, 'taste.example.json');

let cached = null;

export function validateTaste(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('taste card must be an object');
  const list = (v, name) => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${name} must be a list of strings`);
    return v.map(x => x.trim()).filter(Boolean).slice(0, 30);
  };
  const out = {
    likes: list(t.likes, 'likes'),
    humour: typeof t.humour === 'string' ? t.humour.trim().slice(0, 300) : '',
    languages: list(t.languages || [], 'languages'),
    hard_no: list(t.hard_no || [], 'hard_no'),
    notes: typeof t.notes === 'string' ? t.notes.trim().slice(0, 1000) : '',
  };
  if (!out.likes.length) throw new Error('likes cannot be empty');
  if (JSON.stringify(out).length > 8000) throw new Error('taste card too large');
  return out;
}

export function getTaste() {
  if (cached) return cached;
  for (const file of [TASTE_PATH, EXAMPLE_PATH]) {
    try {
      cached = { ...validateTaste(JSON.parse(fs.readFileSync(file, 'utf-8'))), source: file === TASTE_PATH ? 'taste.json' : 'example' };
      return cached;
    } catch (err) {
      if (file === TASTE_PATH && err.code !== 'ENOENT') logger.warn({ err: err.message }, 'taste.json unreadable, using example');
    }
  }
  throw new Error('no taste card (taste.example.json missing)');
}

export function writeTaste(t) {
  const clean = validateTaste(t);
  fs.writeFileSync(TASTE_PATH, `${JSON.stringify(clean, null, 2)}\n`, 'utf-8');
  cached = null;
  return getTaste();
}

/** The card as Jev sees it (no bookkeeping fields). */
export function tasteForJudge() {
  const { source, ...t } = getTaste();
  if (!t.notes) delete t.notes;
  return t;
}

const GEN_PROMPT = `You write a "taste card" describing what Instagram reels a person enjoys, from their character description.
Return ONLY JSON: {"likes": [6-10 short topics/genres], "humour": "one sentence on their sense of humour", "languages": ["languages of reels they enjoy"], "hard_no": [4-8 kinds of reels they would never share with friends], "notes": ""}.
Keep it broad and varied: do not fixate on one hobby, food, job or place even if the description mentions it a lot. Always include politics and religion in hard_no. Never put sexual or thirst-trap content in likes: these reels get shared into a friends' group chat.`;

/** Build taste.json from identity + persona with the LLM (only if it doesn't exist yet). */
export async function ensureTasteCard() {
  if (fs.existsSync(TASTE_PATH)) return getTaste();
  const p = getPersona();
  const user = `Persona: ${JSON.stringify({ name: p.name, age: p.age, region: p.region, language: p.language, vibe: p.vibe })}\n\nCharacter description:\n${getIdentityText().slice(0, 12_000)}`;
  const raw = await callLlm(GEN_PROMPT, user, { role: 'clerk', caller: 'ig.taste', temperature: 0.4, maxTokens: 1024, timeoutMs: 60_000 });
  const json = raw?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('LLM returned no taste card');
  const card = writeTaste(JSON.parse(json));
  logger.info({ likes: card.likes.length }, 'taste card generated from identity');
  return card;
}
