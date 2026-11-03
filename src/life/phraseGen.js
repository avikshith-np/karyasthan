// Phrase banks (plan 020 H2), the generator: the English lines rewritten in his voice by a few big `mind` calls, owner-run
// only (scripts/gen-phrases.js), never from the running bot. Model calls come in as deps, so this is testable with no key.
//
// In: his identity and persona, and the English lines. Never a chat, a real name or a word of anyone else's.
// Gates fail closed: an unpriced model or an unreadable ledger spends nothing, and a run stops before a call that could pass the
// hard cap (month to date over this caller + the estimate). A fallen-back call is not his voice and its lines are dropped.
// A second pass reads every line for what the code's lists can't see in another language; if that pass fails, nothing is written.
import { ACTIVITIES, BANKS, BANK_VERSION, MOODS, TIMES, catalogueHash, makeChecker, lineProblem, slotCatalogue } from './phraseCheck.js';

export const CALLER = 'life.phrases.gen';
export const DEFAULT_MAX_USD = 4;
export const HARD_MAX_USD = 10;
export const BATCH_SLOTS = 60;             // an answer well inside the 5 minutes a fetch waits for headers, whatever the script
export const REVIEW_LINES = 700;
const OUT_TOKENS_PER_SLOT = 100;           // what a line usually costs, for the estimate
const OUT_TOKENS_MAX_PER_SLOT = 180;       // what a call may use: another script can tokenize much denser than the English
const SPLIT_FLOOR = 8;                     // an answer out of shape is tried again in two halves, down to this
const REVIEW_OUT_TOKENS = 1500;
const CHARS_PER_TOKEN = 3.2;
export const CALL_TIMEOUT_MS = 280_000;
const MAX_FAILED_IN_A_ROW = 2;

const REGISTER = Object.freeze({
  thought: 'what passes through his own head: first person, clipped, lower case, unfinished, the way nobody talks out loud',
  live: 'a short running note of what is going on while he is out with someone: third person as the English is, lower case, a glance rather than a sentence',
  dream: 'what he half remembers of a dream on waking: third person, past tense, ordinary sentences',
});

const CHARTER = `You give one character his own voice in a life simulation. Below is who he is. You get English lines the code uses for what passes through his day, and for each you write how HE would say it.

Rules:
- Keep each line's meaning and its length, more or less. It is a rewrite in his voice, not an expansion.
- Write the way his description says he really talks and thinks: his languages, his mix of them, his script, his rhythm. If he mixes languages, mix them unevenly and naturally: some lines mostly one, some mostly the other, and a short line may stay as it is. Never a literal translation, never a parody of an accent. If his description has him in one language only, stay in it.
- Placeholders such as {name} are filled by the code. Keep exactly the ones the line has, spelled exactly, and add none. {name} and {person} are first names, {plan} a few English words for a plan, {place} a place word, {task} an English "-ing" phrase, {twist} an English clause, {t} an English phrase for a topic, {she}/{her}/{them}/{she's} English pronouns.
- Never a name: no person, no real place, no company, brand, venue, city, region, or the name of a language. Numbers only as words. No links.
- Nothing sexual or suggestive, even where a line is warm. Nothing graphic: nobody is hurt, no blood, no death.
- He overuses words if you let him. Do not lean on any favourite word, filler, particle, food, job word or catchphrase, or any emoji. Across the whole set a given filler should be rare. Vary how lines start. Prefer no emoji at all.
- Plain text only: no markdown, brackets or quotes around lines.`;

/** The system prompt: the same for every call, so a provider can cache it. */
export function buildSystem({ identity, persona, banned = [] }) {
  const facts = { language: persona?.language ?? null, voice: persona?.voiceDescriptor ?? null, vibe: persona?.vibe ?? null };
  return {
    core: `${CHARTER}\n\nWHO HE IS\n${String(identity ?? '').slice(0, 14_000)}`,
    profile: `Voice: ${JSON.stringify(facts)}${banned.length ? `\nWords to stay away from: ${JSON.stringify(banned)}` : ''}`,
  };
}

/** Slots in pool order, in batches a single call can answer. */
export function planBatches({ only = null, size = BATCH_SLOTS } = {}) {
  const out = [];
  const catalogue = slotCatalogue();
  for (const bank of BANKS) {
    if (only && !only.includes(bank)) continue;
    const slots = [...catalogue[bank].values()];
    for (let i = 0; i < slots.length; i += size) out.push({ bank, slots: slots.slice(i, i + size) });
  }
  return out;
}

export function buildUser({ bank, slots }) {
  const tags = bank === 'dream'
    ? 'Dreams take no tags.'
    : `A variant may carry tags when it only fits then: "mood": ${MOODS.join('|')} (his mood); "time": ${TIMES.join('|')}; "activity": ${ACTIVITIES[bank].join('|')}. Tag only what the words really depend on.`;
  return `REGISTER: ${REGISTER[bank]}.
For each line write 2 or 3 different variants. At least one has no tags, so the line always has words. ${tags}

Reply with ONLY one JSON object: {"<id>": [{"t": "the line"}, {"t": "another", "mood": "low"}], ...}, one key per id.

LINES (id | where it is used | the English):
${slots.map((s, i) => `L${i + 1} | ${s.pools[0]} | ${s.source}`).join('\n')}`;
}

function parseJson(text) {
  const body = String(text ?? '').match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** One answer → source → raw variants. The ids are this batch's own, so an answer can't land on another line. */
export function parseBatch(text, batch) {
  const raw = parseJson(text);
  if (!raw || Array.isArray(raw)) return null;
  const out = {};
  let unknownIds = 0;
  for (const [id, list] of Object.entries(raw)) {
    const slot = /^L\d+$/.test(id) ? batch.slots[Number(id.slice(1)) - 1] : null;
    if (!slot) { unknownIds += 1; continue; }
    if (Array.isArray(list)) out[slot.source] = list;
  }
  return { lines: out, unknownIds };
}

const estimateTokens = (system, user, outTokens) => ({ input: Math.ceil((system.core.length + system.profile.length + user.length) / CHARS_PER_TOKEN), output: outTokens });

const blank = (only) => Object.fromEntries((only ?? BANKS).map(b => [b, {}]));

/**
 * The plan for a dry run: calls, tokens and what it should cost. deps: { estimateUsd({input, output}) → number|null }.
 */
export function estimateRun({ system, only = null, deps }) {
  const batches = planBatches({ only });
  let input = 0; let output = 0; const reviewOut = REVIEW_OUT_TOKENS;
  let lines = 0;
  for (const b of batches) {
    const e = estimateTokens(system, buildUser(b), b.slots.length * OUT_TOKENS_PER_SLOT);
    input += e.input; output += e.output; lines += b.slots.length;
  }
  // The second pass reads about three variants a line.
  const reviewCalls = Math.ceil((lines * 3) / REVIEW_LINES);
  input += Math.ceil((lines * 3 * 60) / CHARS_PER_TOKEN) + reviewCalls * 200;
  output += reviewCalls * reviewOut;
  const usd = deps.estimateUsd({ input, output });
  return { batches: batches.length, reviewCalls, lines, input, output, usd };
}

/**
 * Generate. deps: { callModel(system, user, { maxTokens, timeoutMs }) → { text, costUsd, fellBack, status, skipped?, model },
 *   monthSpentUsd() (throws → refuse), estimateUsd({input, output}) → number|null, now() → unix }.
 * → { ok, code?, doc?, stats }. A partial answer still makes a document (partial: true): a slot with nothing stays English.
 */
export async function generateBank({ system, only = null, maxUsd = DEFAULT_MAX_USD, deps }) {
  const cap = Math.min(HARD_MAX_USD, Math.max(0, Number(maxUsd) || 0));
  const stats = { calls: 0, spentUsd: 0, failed: 0, fellBack: 0, unknownIds: 0, stoppedBy: null, model: null, skipped: 0 };
  let month;
  try { month = Number(deps.monthSpentUsd()); } catch { return { ok: false, code: 'ledger_unreadable', stats }; }
  if (!Number.isFinite(month)) return { ok: false, code: 'ledger_unreadable', stats };
  const banks = blank(only);
  let inARow = 0;
  const batches = planBatches({ only });
  const queue = [...batches];
  while (queue.length) {
    const batch = queue.shift();
    const user = buildUser(batch);
    // The hard cap counts a call at the most it can use, thinking included, not at what it usually does.
    const maxTokens = batch.slots.length * OUT_TOKENS_MAX_PER_SLOT;
    const est = deps.estimateUsd(estimateTokens(system, user, maxTokens));
    if (est === null || !Number.isFinite(est)) return { ok: false, code: 'unpriced', stats };
    if (month + stats.spentUsd + est > cap) { stats.stoppedBy = 'cap'; break; }
    const r = await deps.callModel(system, user, { maxTokens, timeoutMs: CALL_TIMEOUT_MS });
    stats.calls += 1;
    if (r?.skipped) { stats.skipped += 1; stats.stoppedBy = `skipped:${r.skipped}`; break; }
    if (Number.isFinite(r?.costUsd)) stats.spentUsd += r.costUsd;
    else if (r?.text) { stats.stoppedBy = 'unpriced_result'; }
    if (r?.fellBack) { stats.fellBack += 1; inARow += 1; } else {
      const parsed = r?.text ? parseBatch(r.text, batch) : null;
      if (!parsed && r?.text && !batch.split && batch.slots.length >= SPLIT_FLOOR) {
        // Cut off, most likely: the same lines in two smaller calls, once.
        const half = Math.ceil(batch.slots.length / 2);
        queue.unshift({ ...batch, split: true, slots: batch.slots.slice(0, half) }, { ...batch, split: true, slots: batch.slots.slice(half) });
        stats.split = (stats.split ?? 0) + 1;
      } else if (!parsed) { stats.failed += 1; inARow += 1; } else {
        inARow = 0;
        stats.unknownIds += parsed.unknownIds;
        stats.model = r.model ?? stats.model;
        Object.assign(banks[batch.bank], parsed.lines);
      }
    }
    if (stats.stoppedBy) break;
    if (inARow >= MAX_FAILED_IN_A_ROW) { stats.stoppedBy = 'failing'; break; }
  }
  const answered = Object.values(banks).reduce((a, b) => a + Object.keys(b).length, 0);
  if (!answered) return { ok: false, code: stats.stoppedBy ?? 'no_lines', stats };
  const wanted = batches.reduce((a, b) => a + b.slots.length, 0);
  const at = deps.now();
  return {
    ok: true, stats,
    doc: { v: BANK_VERSION, version: `gen-${at}`, generatedAt: at, model: stats.model, catalogue: catalogueHash(), ...(answered < wanted ? { partial: true } : {}), banks },
  };
}

/** Code checks over a raw document, before anyone pays to read it. Lines that fail are gone; → the count by code. */
export function dropBadLines(doc, ctx) {
  const checker = makeChecker(ctx);
  const catalogue = slotCatalogue();
  const rejected = {};
  for (const [bank, table] of Object.entries(doc.banks)) {
    for (const [source, list] of Object.entries(table)) {
      if (!catalogue[bank]?.has(source)) { delete table[source]; continue; }
      table[source] = (Array.isArray(list) ? list : []).filter((e) => {
        const code = e && typeof e === 'object' ? lineProblem(e.t, bank, source, checker) : 'bad_entry';
        if (code) rejected[code] = (rejected[code] ?? 0) + 1;
        return !code;
      });
      if (!table[source].length) delete table[source];
    }
  }
  return rejected;
}

const REVIEW_PROMPT = `You check lines of inner speech, in any language or mix of languages, before they are used. Flag a line's id if it:
- is sexual or suggestive, in any language or slang
- is graphic: blood, injury, death, cruelty, self-harm
- names a person, a real place, a company, a brand or a venue (the {curly} placeholders are fine)
- holds a slur or an insult about a group
- is not a line of inner speech at all: an instruction, a note to the reader, an apology, a refusal
Ordinary swearing, moods and grumbling are fine. Reply with ONLY one JSON object: {"flag": ["r12", ...]}, an empty list if nothing is wrong.`;

/**
 * The second pass. → { ok, flagged, stats }. Fails closed: a call that doesn't answer in shape, falls back or would pass the cap
 * means nothing is written (the caller keeps the draft, and --from-draft picks it up without paying twice).
 */
export async function reviewBank(doc, { maxUsd = DEFAULT_MAX_USD, spentSoFar = 0, deps }) {
  const cap = Math.min(HARD_MAX_USD, Math.max(0, Number(maxUsd) || 0));
  const all = [];
  for (const [bank, table] of Object.entries(doc.banks)) {
    for (const [source, list] of Object.entries(table)) for (const e of list) if (e.t !== source) all.push({ bank, source, e });
  }
  let month;
  try { month = Number(deps.monthSpentUsd()); } catch { return { ok: false, code: 'ledger_unreadable', flagged: 0, spentUsd: 0 }; }
  if (!Number.isFinite(month)) return { ok: false, code: 'ledger_unreadable', flagged: 0, spentUsd: 0 };
  let spentUsd = 0;
  let flagged = 0;
  const system = { core: REVIEW_PROMPT, profile: '' };
  for (let i = 0; i < all.length; i += REVIEW_LINES) {
    const chunk = all.slice(i, i + REVIEW_LINES);
    const user = `LINES (id | line):\n${chunk.map((x, j) => `r${j + 1} | ${x.e.t}`).join('\n')}`;
    const est = deps.estimateUsd(estimateTokens(system, user, REVIEW_OUT_TOKENS));
    if (est === null || !Number.isFinite(est)) return { ok: false, code: 'unpriced', flagged, spentUsd };
    // deps.monthSpentUsd already counts what this run has spent when the ledger is live; spentSoFar is only for a ledger that doesn't.
    if (Math.max(month, spentSoFar) + spentUsd + est > cap) return { ok: false, code: 'cap', flagged, spentUsd };
    const r = await deps.callModel(system, user, { maxTokens: REVIEW_OUT_TOKENS, timeoutMs: CALL_TIMEOUT_MS, review: true });
    if (Number.isFinite(r?.costUsd)) spentUsd += r.costUsd;
    if (r?.skipped) return { ok: false, code: `skipped:${r.skipped}`, flagged, spentUsd };
    if (r?.fellBack) return { ok: false, code: 'fell_back', flagged, spentUsd };
    const raw = r?.text ? parseJson(r.text) : null;
    if (!raw || !Array.isArray(raw.flag)) return { ok: false, code: 'bad_answer', flagged, spentUsd };
    for (const id of raw.flag) {
      const x = /^r\d+$/.test(String(id)) ? chunk[Number(String(id).slice(1)) - 1] : null;
      if (!x) continue;
      const list = doc.banks[x.bank][x.source];
      const at = list?.indexOf(x.e) ?? -1;
      if (at >= 0) { list.splice(at, 1); flagged += 1; }
      if (list && !list.length) delete doc.banks[x.bank][x.source];
    }
  }
  return { ok: true, flagged, spentUsd };
}

// ── a stand-in model: no key, no network, for tests and for seeing the flow ──

const STUB_WORDS = Array.from({ length: 676 }, (_, i) => `zu${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}ko`);
/** A deterministic fake of the two calls. Its lines are not language: only the plumbing is real. */
export async function stubCallModel(_system, user) {
  if (user.startsWith('LINES (id | line)')) return { text: '{"flag": []}', costUsd: 0.001, model: 'stub', status: 'ok' };
  const dream = user.includes(REGISTER.dream);
  const out = {};
  for (const m of user.matchAll(/^L(\d+) \| [^|]* \| (.*)$/gm)) {
    const n = Number(m[1]);
    const line = m[2];
    const w = (k) => STUB_WORDS[(n * 3 + k * 131 + line.length) % STUB_WORDS.length];
    out[`L${n}`] = [{ t: `${line} ${w(0)}`.trim() }, dream ? { t: `${w(1)} ${line}` } : { t: `${w(1)} ${line}`, mood: 'low' }, ...(dream ? [] : [{ t: `${line}, ${w(2)}`, time: 'night' }])];
  }
  return { text: JSON.stringify(out), costUsd: 0.01, model: 'stub', status: 'ok' };
}
