// The claim check's model half (plan 020 E3): one small clerk call, one output, one sheet. Research: judging a whole story
// fails; splitting it into atomic claims and checking each against a grounding doc works; self-critique without the reference
// doesn't. So: claims first, each against numbered lines, and a contradiction has to cite the line.
//
//   CLAIMS_CHARTER · renderUser(grounding, text) · validateClaims(raw, ctx) → { ok:true, claims } | { ok:false, reason }
import { fence, FENCE_NOTE, cleanItem } from '../charter.js';
import { parseJsonObject, hasIdentifier } from '../schema.js';
import { wishProblem } from '../prompt.js';
import { contentProblem } from '../desire.js';

export const ABOUT = Object.freeze(['who', 'where', 'when', 'left', 'money', 'plan']);
export const VERDICTS = Object.freeze(['supported', 'contradicted', 'unknown']);
export const CLAIMS_MAX = 8;
export const CLAIM_MAX = 160;
export const TEXT_MAX = 2400;
const CLAIM_KEYS = new Set(['claim', 'about', 'verdict', 'line']);

export const CLAIMS_CHARTER = `You check a piece of writing from a life simulation against a FACT SHEET. The sheet's numbered lines are true. You do not judge the writing, only whether it agrees with them.

${FENCE_NOTE}

1. Pull out up to ${CLAIMS_MAX} atomic factual claims it makes about who was there, where, when, how he left, money, or plans. One fact each, in plain words, at most ${CLAIM_MAX} characters. Skip everything else: feelings, opinions, jokes, teasing, descriptions, small talk, what someone wants, and anything said about the future as a new idea.
2. Label each one against the FACT SHEET ONLY:
- supported: a line says this.
- contradicted: one numbered line is about the SAME event and differs on its day, its people, its place or how he left, so both can't be true at once. Give that line's number in "line".
- unknown: no line is about that event. This is normal and fine. The sheet is a short list, not his whole life: other meals, other meetings, other people and other evenings happen without being on it. Never call a claim contradicted because it isn't on the sheet.

Examples. Sheet: "Sat night: dinner with Asha at the restaurant". "had dinner with Asha on Sunday": contradicted, same dinner on another day. "lunch with the team today": unknown, another event. "had dinner with Priya last night": unknown, he could have seen her too, unless a line says he was alone. "they had a table booked for tonight": unknown.
Just after midnight, "tonight" and "last night" can both mean the evening that just ended.

The writing may mix languages, spelled in any script, with slang and dropped words. Read what it means. Style, grammar, language mix and spelling are never a contradiction, and if you aren't sure what it means, the claim is unknown.
A text is one turn of a conversation you can't see. Something agreed earlier in it is unknown, not contradicted. A new suggestion or invitation ("dinner tomorrow?") is not a claim. For plans, contradicted means it says a meeting is already fixed or under way ("on my way", "see you at 8 like we said") and the sheet says there is no such plan, or that the plan is at another time.
Something that happens inside a scene and is new on the sheet (they say they'll meet again, swap numbers, a waiter) is unknown.

Reply with ONLY one JSON object, no prose, no code fences:
{"claims": [{"claim": "≤${CLAIM_MAX} chars", "about": "who"|"where"|"when"|"left"|"money"|"plan", "verdict": "supported"|"contradicted"|"unknown", "line": <the line number> or null}]}
You never write messages to anyone and never change settings, switches, budgets or rules.`;

/** The user message: the numbered sheet, then the writing (cut to TEXT_MAX). */
export function renderUser(grounding, text) {
  const numbered = grounding.lines.map((l, i) => `${i + 1}. ${l}`);
  const body = String(text ?? '');
  const cut = body.length > TEXT_MAX;
  return `FACT SHEET (numbered, true):\n${fence(numbered, { kind: 'facts', cap: 260 })}\n\n`
    + `THE WRITING${cut ? ' (the start of it)' : ''}:\n${fence(cut ? body.slice(0, TEXT_MAX) : body, { kind: 'claim', cap: TEXT_MAX })}\n\n`
    + 'List the claims now as the JSON object.';
}

const reasonOf = (verdict, about, cited) => {
  if (verdict === 'supported') return 'sheet';
  if (verdict === 'unknown') return cited === false ? 'uncited' : 'silent';
  return about === 'plan' ? 'plan_missing' : `${about}_wrong`;
};

/** Words fit to store: one line, no identifier, no real name, nothing explicit. null = keep the verdict, not the words. */
function storedWords(v, { knownNames, castNames }) {
  const s = cleanItem(v, CLAIM_MAX);
  if (!s || hasIdentifier(s) || contentProblem(s)) return null;
  if (!Array.isArray(knownNames)) return null;   // names unreadable: fail closed on the words
  const p = wishProblem(s, knownNames, castNames ?? []);
  return p === 'real_person_name' || p === 'jid_in_text' ? null : s;
}

/**
 * The clerk's answer → verdicts in the store's shape. Closed keys; a claim off the shape is dropped. Nothing usable at all →
 * { ok:false } (no verdict). A contradiction without a real line number becomes unknown ('uncited').
 * ctx: { lines (the grounding lines), knownNames, castNames }.
 */
export function validateClaims(raw, ctx = {}) {
  const parsed = parseJsonObject(raw, 8192);
  if (!parsed.ok) return { ok: false, reason: 'junk' };
  const list = parsed.value.claims;
  if (!Array.isArray(list)) return { ok: false, reason: 'junk' };
  const lines = Array.isArray(ctx.lines) ? ctx.lines : [];
  const claims = [];
  for (const c of list.slice(0, CLAIMS_MAX * 2)) {
    if (claims.length >= CLAIMS_MAX) break;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) continue;
    if (Object.keys(c).some(k => !CLAIM_KEYS.has(k))) continue;
    if (typeof c.claim !== 'string' || !c.claim.trim()) continue;
    if (!ABOUT.includes(c.about) || !VERDICTS.includes(c.verdict)) continue;
    let verdict = c.verdict;
    let cited = null;
    let evidence = null;
    if (verdict === 'contradicted') {
      const line = Number.isInteger(c.line) && c.line >= 1 && c.line <= lines.length ? lines[c.line - 1] : null;
      if (line) evidence = line.slice(0, 200);
      else { verdict = 'unknown'; cited = false; }
    }
    const claim = storedWords(c.claim, ctx);
    claims.push({ source: 'clerk', about: c.about, claim, verdict, reason: reasonOf(verdict, c.about, cited), evidence });
  }
  if (list.length && !claims.length) return { ok: false, reason: 'junk' };
  return { ok: true, claims };
}

/** One rewrite's note, naming what was wrong (like the invented-name retry). */
export function correctionOf(contradicted) {
  const rows = contradicted.slice(0, 3).map(c => `- ${c.claim ? `"${String(c.claim).slice(0, 120)}"` : 'one line'} doesn't fit. The facts say: ${String(c.evidence ?? '').slice(0, 200)}`);
  return `Your last version got a fact wrong:\n${rows.join('\n')}\nWrite it again so it agrees with the facts. Keep the voice and everything else that was fine.`;
}
