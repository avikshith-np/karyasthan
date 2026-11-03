// Sleep: the nightly consolidation (spec 008, research R5, R7, R8, R9;
// contracts/mind-output.md §2, §3, §6).
//
//   runSleep(nightKey, trigger)   one consolidation per night (mind_nights PK). Steps:
//     1. writeEpisodes   ONE clerk call PER CHAT (caller 'mind.episode', ≤ 12 chats):
//                        that chat's digests since its episode cursor + its eligible lines
//                        not covered by a surviving digest (≤ 200 read by the clerk),
//                        fenced. addMemory({category:'episode', attribute:'day:<NK>',
//                        origin = the chat, subject NULL}) with evidence = the union of the
//                        input digests' item_evidence + EVERY raw line read (uncapped by
//                        the 200-line read cap). Every chat-night gets a mind_episode_log
//                        row (written|null|tombstoned|fenced|capped); the cursor plus
//                        episodeExists make the step idempotent.
//        rebuildMissing  only log rows with rebuild_requested = 1 (revoke/edit) from the
//                        last 7 nights, ≤ 4 per sleep, from the remaining eligible lines of
//                        that night's recorded rowid range. Forgotten (fenced), null,
//                        capped, tombstoned and purge-deleted nights are never rebuilt.
//     2. compressWeekly  at most every 7 days, ≤ 10 chats: the oldest closed 7-night window
//                        with ≥ 2 current dailies → one clerk call over ONLY those dailies
//                        (caller 'mind.weekly') → addMemory(week:<first NK>, replaces the
//                        dailies, evidence = their union, expires in 365 d).
//     3. reflection      callRole('mind', SLEEP_CHARTER, …, {caller:'mind.sleep'}) over the
//                        night's episodes (Cn.e) + the latest digests' threads (Cn.tk) +
//                        self-origin life event types + enum state → validateSleep (no
//                        self_model, no reach_out) → staged morning mood / intentions
//                        (selfState) and nudges (levers). Over budget / no key → skipped,
//                        night done with `partial`; a fell-back run still sets mood and
//                        intentions but every nudge is refused (partial 'fell_back').
//     2c. how things stand (plan 020 D2): life.storyStandingPass, one clerk call per fictional member who
//        changed (caller 'mind.standing'); the story layer owns it, the mind only runs it. Never changes the night's status.
//     4. selfModel.runSelfModel(NK) when the budget allows (it decides due-ness itself).
//   Steps 1–2 are clerk work (the mind's daily clerk cap, digest.clerkBudgetLeft: each
//   episode/weekly call is a mind_runs row of kind 'digest'), so they run even when the
//   mind role is over budget. A failed or invalid reflection marks the night `failed`;
//   a later tick retries (≤ 3 attempts) and step 1 repeats no work.
//
// Episode text is written by the clerk per chat by construction (FR-009); the Opus
// reflection only points at labels. Chat ids come from code (activity rows, the label
// map), never from model output. Nothing here logs chat- or model-derived text.

import * as store from './store.js';
import { now as clockNow, dayKey, nightKey as clockNightKey, daysBeforeKey, nextDayKey } from './clock.js';
import { EPISODE_PROMPT, WEEKLY_PROMPT, SLEEP_CHARTER, cleanChatText, fenceBlock } from './charter.js';
import { validateEpisode, validateWeekly, validateSleep } from './schema.js';
import { buildLabelMap, labelsOf, labelMapForInput } from './labels.js';
import { clerkBudgetLeft } from './digest.js';
import { applyNudges } from './levers.js';
import { callRole } from '../brain/llm.js';
import { budgetState } from '../brain/usage.js';
import { addMemory } from '../memory/relationshipStore.js';
import * as mindReads from '../memory/mindReads.js';
import { isSelfJid, resolvePerson, bareJid } from '../memory/identity.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const DAY = 86400;
export const MAX_EPISODE_CHATS = 12;
export const EPISODE_MAX_LINES = 200;
export const READ_MAX_LINES = 500;
export const REBUILD_MAX = 4;
export const REBUILD_NIGHTS = 7;
export const WEEKLY_MAX_CHATS = 10;
export const WEEKLY_EVERY_SEC = 7 * DAY;
export const MAX_ATTEMPTS = 3;
export const RUNNING_STALE_SEC = 3600;   // a night left 'running' this long (a crash) is retryable
const LINE_CAP = 300;

// ── deps (test seam) ─────────────────────────────────────────────────────────

async function defaultBudgetOk(kind) {
  // T019's think.js owns mindBudgetOk; until it exists (or if it fails), the documented
  // sleep/self-model rule: the mind role's own budget plus < 90% global headroom.
  try {
    const think = await import('./think.js');
    if (typeof think.mindBudgetOk === 'function') {
      const r = await think.mindBudgetOk(kind);
      if (typeof r === 'boolean') return { ok: r, reason: r ? null : 'budget' };
      if (r && typeof r === 'object') return { ok: r.ok === true || r.allowed === true, reason: r.reason ?? null };
    }
  } catch { /* not there yet */ }
  try {
    const s = budgetState('mind');
    if (!s.allowed) return { ok: false, reason: s.reason === 'global' ? 'global_cap' : 'budget' };
    if (s.globalBudgetUsd > 0 && s.globalSpentUsd >= 0.9 * s.globalBudgetUsd) return { ok: false, reason: 'global_cap' };
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'budget' };   // fail closed
  }
}

/** Chats with human activity since the last sleep (≤ 14 days), busiest first. */
function defaultCandidateChats(nk, t) {
  const st = store.getState();
  const from = Math.max(t - 14 * DAY, (Number.isFinite(st.lastSleepAt) ? st.lastSleepAt : t - 2 * DAY) - DAY);
  return chatsByActivity(dayKey(from), true);
}

/** Chats with any activity in the last 14 days (activity retention), most active first. */
function defaultChatsWithEpisodes(t) {
  return chatsByActivity(dayKey(t - 14 * DAY), false);
}

function chatsByActivity(sinceDay, humanOnly) {
  const by = new Map();
  for (const r of store.activityFor(sinceDay)) {
    const human = Number(r.humanMsgs) || 0;
    if (humanOnly && human <= 0) continue;
    const cur = by.get(r.chatJid) || { chatJid: r.chatJid, human: 0, last: 0 };
    cur.human += human;
    cur.last = Math.max(cur.last, Number(r.lastHumanAt) || 0, Number(r.lastBotAt) || 0);
    by.set(r.chatJid, cur);
  }
  return [...by.values()].sort((a, b) => b.human - a.human || b.last - a.last).map(c => c.chatJid);
}

const DEFAULT_DEPS = {
  now: () => clockNow(),
  isMindOn: () => isSkillEnabled('mind'),
  stanceUpdate: async (nk) => (await import('./stance.js')).nightlyUpdate(nk),
  stanceFree: async (nk, entries) => (await import('./stance.js')).freeTopicsNight(nk, entries),
  callRole: (role, system, user, opts) => callRole(role, system, user, opts),
  eligibleLines: (chatJid, opts) => mindReads.eligibleLines(chatJid, opts),
  episodesFor: (chatJid, opts) => mindReads.episodesFor(chatJid, opts),
  episodeExists: (chatJid, attribute) => mindReads.episodeExists(chatJid, attribute),
  addMemory: (item) => addMemory(item),
  clerkBudgetLeft: () => clerkBudgetLeft(),
  budgetOk: (kind) => defaultBudgetOk(kind),
  candidateChats: (nk, t) => defaultCandidateChats(nk, t),
  chatsWithEpisodes: (t) => defaultChatsWithEpisodes(t),
  applyNudges: (nudges, runId, labelMap, opts) => applyNudges(nudges, runId, labelMap, opts),
  selfState: async () => import('./selfState.js'),
  selfModel: async () => import('./selfModel.js'),
  life: async () => import('../life/index.js'),
  getPerson: (jid) => getPerson(jid),
  getGroup: (jid) => getGroup(jid),
  getPersona: () => getPersona(),
  logger,
};
let deps = { ...DEFAULT_DEPS };

/**
 * Test seam: { now, isMindOn, callRole, eligibleLines, episodesFor, episodeExists, addMemory,
 * clerkBudgetLeft, budgetOk, candidateChats, chatsWithEpisodes, applyNudges, selfState,
 * selfModel, life, getPerson, getGroup, getPersona, logger }. null resets.
 */
export function __setDepsForTest(d = null) {
  deps = d ? { ...deps, ...d } : { ...DEFAULT_DEPS };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const nowSec = () => Math.floor(deps.now());
const isGroupJid = (j) => typeof j === 'string' && j.endsWith('@g.us');
const isNightKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
const isBotLine = (l) => !!l?.isFromSelf || isSelfJid(l?.senderJid);
const personOf = (jid) => (typeof jid === 'string' ? resolvePerson(jid) || bareJid(jid) : null);
const errCode = (err) => String(err?.code || err?.name || 'error').slice(0, 60);
const TRIGGERS = new Set(['night', 'catchup', 'owner', 'tick', 'scheduled']);

function warn(where, err, extra = {}) {
  try { deps.logger.warn({ evt: 'issue', where: `mind.sleep.${where}`, code: errCode(err), ...extra }, 'mind sleep step failed'); } catch { /* */ }
}

function usageOf(res) {
  return { model: res?.model ?? null, tokensIn: res?.usage?.input ?? null, tokensOut: res?.usage?.output ?? null,
    cacheRead: res?.usage?.cacheRead ?? null, costUsd: fin(res?.costUsd) ? res.costUsd : null, fellBack: !!res?.fellBack };
}

const SKIP_REASON = { budget: 'budget', global_cap: 'global_cap', unpriced: 'unpriced', no_key: 'no_key',
  disabled: 'disabled', shadow_only: 'disabled' };
// mind_nights.partial has budget|no_key|global_cap|fell_back (data-model): a disabled
// role behaves like a missing key, an unpriced model like an exhausted budget.
const PARTIAL_OF = { budget: 'budget', global_cap: 'global_cap', unpriced: 'budget', no_key: 'no_key', disabled: 'no_key' };

function chatName(chatJid) {
  try {
    if (isGroupJid(chatJid)) return cleanChatText(deps.getGroup(chatJid)?.name || '', 60) || 'a group';
    const p = deps.getPerson(chatJid);
    return cleanChatText(p?.real_name || p?.push_name || '', 40) || 'a friend';
  } catch { return isGroupJid(chatJid) ? 'a group' : 'a friend'; }
}

function personName(jid) {
  try {
    const p = deps.getPerson(jid);
    return cleanChatText(p?.real_name || p?.push_name || '', 40) || 'unknown';
  } catch { return 'unknown'; }
}

function youLine() {
  const persona = deps.getPersona() || {};
  const you = cleanChatText(persona.name || 'the character', 60);
  const vibe = persona.vibe ? cleanChatText(persona.vibe, 160) : '';
  return `You are ${you}${vibe ? ` (${vibe})` : ''}.`;
}

/** The newest eligible rowid of a chat after `after` (for moving a cursor past a skipped night). */
async function newestRowid(chatJid, after) {
  try {
    const r = await deps.eligibleLines(chatJid, { afterRowid: after, limit: 1, contextLines: 0 });
    return fin(Number(r?.maxRowid)) ? Number(r.maxRowid) : after;
  } catch { return after; }
}

async function skipNightCursor(chatJid, nk) {
  const cur = store.getEpisodeCursor(chatJid);
  if (cur?.lastNightKey === nk) return;
  const from = Number(cur?.lastRowid) || 0;
  store.setEpisodeCursor(chatJid, { lastRowid: await newestRowid(chatJid, from), lastNightKey: nk });
}

/**
 * One chat's episode input: header, roster, the digests (summary + threads) and the
 * raw lines, all cleaned and inside ONE fence. → { user, humanLines }
 */
function buildEpisodeUser(chatJid, digests, lines) {
  const roster = new Map();
  const who = (l) => {
    if (isBotLine(l)) return '(you)';
    const p = personOf(l.senderJid);
    if (!p) return 'someone';
    if (!roster.has(p)) roster.set(p, { label: `P${roster.size + 1}`, name: personName(p) });
    return roster.get(p).label;
  };
  const lineOut = lines.map((l, i) => `[L${i + 1}] ${who(l)}: ${cleanChatText(l.text, LINE_CAP)}`);
  const digestOut = digests.map((d, i) => {
    const out = [`[D${i + 1}] ${cleanChatText(d.summary, 400)}`];
    for (const th of Array.isArray(d.threads) ? d.threads : []) {
      if (typeof th?.text === 'string') out.push(`  open: ${cleanChatText(th.text, 100)}`);
    }
    return out.join('\n');
  });
  const header = isGroupJid(chatJid) ? `This is a group chat named "${chatName(chatJid)}".`
    : 'This is a private one-to-one chat between you and P1. Everything here is private to this chat.';
  const body = [header, 'People:', ...[...roster.values()].map(v => `${v.label}: ${v.name}`), '',
    digests.length ? 'Digests of the day:' : '', ...digestOut, '', lines.length ? 'Lines not in a digest:' : '', ...lineOut]
    .filter((s, i, a) => s !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
  const user = `${youLine()} Your own lines are marked (you).

${fenceBlock(body)}

Return only the JSON object described in the instructions.`;
  return { user };
}

/** Run one clerk call as a mind_runs row of kind 'digest' (the mind's clerk-call counter). */
async function clerkCall(caller, system, user, { nk, ref, input }) {
  const runRow = store.insertRun({ kind: 'digest', trigger: 'night', triggerRef: ref, nightKey: nk, input });
  const res = await deps.callRole('clerk', system, user, { caller, maxTokens: 1500 });
  const usage = usageOf(res);
  if (!res || res.skipped || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
    const skipped = !!res?.skipped;
    store.finishRun(runRow, { status: skipped ? 'skipped' : 'failed', skipReason: skipped ? (SKIP_REASON[res.skipped] || 'error') : null,
      error: skipped ? null : String(res?.status || 'no_text').slice(0, 60), ...usage });
    return { ok: false, runRow, status: skipped ? 'skipped' : 'failed' };
  }
  return { ok: true, runRow, text: res.text, usage };
}

function episodeOutcome(r) {
  if (r?.id != null && !r.refused) return 'written';
  if (r?.refused === 'tombstoned') return 'tombstoned';
  if (r?.refused === 'fenced') return 'fenced';
  return 'null';
}

/**
 * Read one chat-night's input (digests overlapping (from, to], eligible lines in it not
 * covered by a surviving digest). `to` null = everything after `from`.
 */
async function readNight(chatJid, from, to = null) {
  const digests = store.digestsFor(chatJid).filter(d => d.toRowid > from && (to == null || d.toRowid <= to));
  const read = await deps.eligibleLines(chatJid, { afterRowid: from, limit: READ_MAX_LINES, contextLines: 0 });
  const got = (read?.lines || []).filter(l => Number(l.rowid) > from);
  const all = to == null ? got : got.filter(l => Number(l.rowid) <= to);
  // A full page whose oldest line is already past `to` cannot show the range (newest-first read).
  const truncated = to != null && got.length >= READ_MAX_LINES && got.length && Number(got[0].rowid) > to;
  const covered = (rowid) => digests.some(d => rowid > d.fromRowid && rowid <= d.toRowid);
  const raw = all.filter(l => !covered(Number(l.rowid))).slice(-EPISODE_MAX_LINES);
  const maxRowid = Math.max(from, ...all.map(l => Number(l.rowid)), ...digests.map(d => d.toRowid),
    to == null && fin(Number(read?.maxRowid)) ? Number(read.maxRowid) : from);
  return { digests, all, raw, truncated, toRowid: to == null ? maxRowid : to };
}

/** Write (or rewrite) the episode of one chat-night from what readNight returned. → { outcome, memoryId? } */
async function episodeFromInput(chatJid, nk, runId, input, { from, purpose }) {
  const { digests, all, raw } = input;
  if (!digests.length && !raw.some(l => !isBotLine(l))) return { outcome: 'nothing_new' };
  if (!deps.clerkBudgetLeft()) return { outcome: 'capped' };
  const { user } = buildEpisodeUser(chatJid, digests, raw);
  const call = await clerkCall('mind.episode', EPISODE_PROMPT, user, { nk, ref: `${purpose}:run:${runId ?? '-'}`,
    input: { chatJid, purpose, digests: digests.map(d => d.id), lines: raw.length, read: all.length, fromRowid: from,
      toRowid: input.toRowid } });
  if (!call.ok) return { outcome: call.status };
  const v = validateEpisode(call.text);
  if (!v.ok) {
    store.finishRun(call.runRow, { status: 'invalid', error: v.error, dropped: v.dropped, ...call.usage });
    return { outcome: 'invalid' };
  }
  if (v.value.episode === null) {
    store.finishRun(call.runRow, { status: 'ok', output: { episode: null }, dropped: v.dropped, ...call.usage });
    return { outcome: 'null' };
  }
  // Evidence: every digest's own evidence (L and C lines) + every raw line read (research R7).
  const evidence = new Map();
  for (const d of digests) for (const e of store.digestEvidence(d.id)) evidence.set(e.msgId, { msgId: e.msgId, ts: e.ts });
  for (const l of all) evidence.set(l.id, { msgId: l.id, ts: fin(Number(l.ts)) ? Math.floor(Number(l.ts)) : null });
  let r;
  try {
    r = deps.addMemory({ category: 'episode', attribute: `day:${nk}`, originKind: isGroupJid(chatJid) ? 'group' : 'dm',
      originJid: chatJid, subjectJid: null, content: v.value.episode, importance: 0.4, source: 'mind.sleep',
      evidence: [...evidence.values()] });
  } catch (err) {
    store.finishRun(call.runRow, { status: 'failed', error: errCode(err), ...call.usage });
    return { outcome: 'failed' };
  }
  const outcome = episodeOutcome(r);
  store.finishRun(call.runRow, { status: 'ok', output: { outcome, memoryId: r?.id ?? null, evidence: evidence.size },
    dropped: v.dropped, ...call.usage });
  return { outcome, memoryId: outcome === 'written' ? r.id : null };
}

const LOGGED = new Set(['written', 'null', 'tombstoned', 'fenced', 'capped']);

function logOutcome(chatJid, nk, outcome, memoryId = null) {
  const fields = outcome === 'fenced' ? { outcome: 'fenced', cause: 'forget' } : { outcome };
  if (memoryId != null) fields.memoryId = memoryId;
  store.logEpisodeNight(chatJid, nk, fields);
}

// ── step 1: episodes ─────────────────────────────────────────────────────────

/**
 * One episode per chat for night `nk` (≤ 12 chats with something new; the rest fold into
 * the next night: no log row, cursor kept). `ranges` (chat → [from, to]) is filled with
 * the rowid range of every episode written, for a later rebuild.
 * → { written, results: [{ chatJid, outcome }] }
 */
export async function writeEpisodes(nk, runId = null, { ranges = {} } = {}) {
  const t = nowSec();
  const results = [];
  let written = 0;
  let worked = 0;
  let chats = [];
  try { chats = [...new Set((await deps.candidateChats(nk, t)) || [])].filter(c => typeof c === 'string' && c); }
  catch (err) { warn('candidates', err); chats = []; }
  for (const chatJid of chats) {
    try {
      const attr = `day:${nk}`;
      const logged = store.episodeNight(chatJid, nk);
      if (logged) {
        // Already decided for this night. A fenced / tombstoned / null / written night
        // moves the cursor past its lines (a forgotten night is never built later either);
        // capped folds into the next night; deleted is rebuildMissing's.
        if (['fenced', 'tombstoned', 'null', 'written'].includes(logged.outcome)) await skipNightCursor(chatJid, nk);
        results.push({ chatJid, outcome: `logged_${logged.outcome}` });
        continue;
      }
      if (deps.episodeExists(chatJid, attr)) {
        const ex = (deps.episodesFor(chatJid, { attributes: [attr], current: false }) || [])[0];
        logOutcome(chatJid, nk, 'written', ex?.id ?? null);
        await skipNightCursor(chatJid, nk);
        results.push({ chatJid, outcome: 'exists' });
        continue;
      }
      const cur = store.getEpisodeCursor(chatJid);
      const from = Number(cur?.lastRowid) || 0;
      const input = await readNight(chatJid, from, null);
      if (!input.digests.length && !input.raw.some(l => !isBotLine(l))) { results.push({ chatJid, outcome: 'nothing_new' }); continue; }
      if (worked >= MAX_EPISODE_CHATS) { results.push({ chatJid, outcome: 'over_limit' }); continue; }
      worked++;
      const r = await episodeFromInput(chatJid, nk, runId, input, { from, purpose: 'episode' });
      if (LOGGED.has(r.outcome)) {
        logOutcome(chatJid, nk, r.outcome, r.memoryId ?? null);
        if (r.outcome !== 'capped') {
          store.setEpisodeCursor(chatJid, { lastRowid: input.toRowid, lastNightKey: nk });
        }
        if (r.outcome === 'written') {
          written++;
          ranges[chatJid] = [from, input.toRowid];
        }
      }
      results.push({ chatJid, outcome: r.outcome });
    } catch (err) {
      warn('episode', err);
      results.push({ chatJid, outcome: 'failed' });
    }
  }
  return { written, results };
}

// ── step 1b: rebuild revoked/edited nights ───────────────────────────────────

function rangeFor(chatJid, nk) {
  try {
    const night = store.getNight(nk);
    const run = night?.runId ? store.getRun(night.runId) : null;
    const r = run?.input?.ranges?.[chatJid];
    if (Array.isArray(r) && r.length === 2 && fin(r[0]) && fin(r[1]) && r[1] >= r[0]) return { from: r[0], to: r[1] };
  } catch { /* fall through */ }
  return null;
}

/**
 * Rebuild chat-nights whose episode a revoke or edit deleted (rebuild_requested = 1),
 * from the last 7 nights, ≤ 4 per sleep, from the eligible lines that remain in the
 * night's recorded rowid range (revoked lines are gone; no_learn lines are never read).
 * A night whose range is unknown or unreadable is closed as `capped` (never retried).
 * → { rebuilt, results: [{ chatJid, nightKey, outcome }] }
 */
export async function rebuildMissing(nk, runId = null) {
  const results = [];
  let rebuilt = 0;
  let rows = [];
  try { rows = store.nightsToRebuild(daysBeforeKey(nk, REBUILD_NIGHTS), REBUILD_MAX); } catch (err) { warn('rebuild_list', err); }
  for (const row of rows.slice(0, REBUILD_MAX)) {
    const { chatJid, nightKey: rk } = row;
    try {
      const range = rangeFor(chatJid, rk);
      if (!range) { store.logEpisodeNight(chatJid, rk, { outcome: 'capped' }); results.push({ chatJid, nightKey: rk, outcome: 'no_range' }); continue; }
      const input = await readNight(chatJid, range.from, range.to);
      if (input.truncated) { store.logEpisodeNight(chatJid, rk, { outcome: 'capped' }); results.push({ chatJid, nightKey: rk, outcome: 'unreadable' }); continue; }
      if (!input.digests.length && !input.raw.some(l => !isBotLine(l))) {
        store.logEpisodeNight(chatJid, rk, { outcome: 'null' });
        results.push({ chatJid, nightKey: rk, outcome: 'null' });
        continue;
      }
      if (!deps.clerkBudgetLeft()) { results.push({ chatJid, nightKey: rk, outcome: 'cap_wait' }); break; }
      const r = await episodeFromInput(chatJid, rk, runId, input, { from: range.from, purpose: 'rebuild' });
      if (LOGGED.has(r.outcome) && r.outcome !== 'capped') {
        logOutcome(chatJid, rk, r.outcome, r.memoryId ?? null);
        if (r.outcome === 'written') rebuilt++;
      }
      results.push({ chatJid, nightKey: rk, outcome: r.outcome });
    } catch (err) {
      warn('rebuild', err);
      results.push({ chatJid, nightKey: rk, outcome: 'failed' });
    }
  }
  return { rebuilt, results };
}

// ── step 2: weekly compression ───────────────────────────────────────────────

const DAY_ATTR = /^day:(\d{4}-\d{2}-\d{2})$/;
const keyLe = (a, b) => a <= b;   // YYYY-MM-DD compares lexically

/**
 * The oldest closed 7-night window of this chat's current dailies that holds ≥ 2 of
 * them and has no current weekly: [start, start+6] with start+6 ≤ nk − 1. → { start, dailies } | null
 */
export function pickWindow(episodes, nk) {
  const lastClosed = daysBeforeKey(nk, 1);
  const dailies = episodes.map(e => ({ ...e, nk: (String(e.attribute || '').match(DAY_ATTR) || [])[1] }))
    .filter(e => e.nk).sort((a, b) => (a.nk < b.nk ? -1 : a.nk > b.nk ? 1 : a.id - b.id));
  const weeks = new Set(episodes.map(e => String(e.attribute || '')).filter(a => a.startsWith('week:')));
  let i = 0;
  while (i < dailies.length) {
    const start = dailies[i].nk;
    const end = daysBeforeKey(start, -6);
    if (!keyLe(end, lastClosed)) return null;
    const inWin = dailies.filter(d => d.nk >= start && d.nk <= end);
    if (inWin.length >= 2 && !weeks.has(`week:${start}`)) return { start, end, dailies: inWin };
    const next = nextDayKey(end);
    while (i < dailies.length && dailies[i].nk < next) i++;
  }
  return null;
}

/**
 * Weekly compression for ≤ 10 chats (one window each). → { weeklies, results }
 * Sets mind_state.last_weekly_at when it ran.
 */
export async function compressWeekly(nk, runId = null) {
  const t = nowSec();
  const results = [];
  let weeklies = 0;
  let chats = [];
  try { chats = [...new Set((await deps.chatsWithEpisodes(t)) || [])].filter(c => typeof c === 'string' && c).slice(0, WEEKLY_MAX_CHATS); }
  catch (err) { warn('weekly_chats', err); }
  for (const chatJid of chats) {
    try {
      const win = pickWindow(deps.episodesFor(chatJid, { current: true }) || [], nk);
      if (!win) { results.push({ chatJid, outcome: 'none' }); continue; }
      if (!deps.clerkBudgetLeft()) { results.push({ chatJid, outcome: 'capped' }); break; }
      const body = win.dailies.map(d => `night ${d.nk}: ${cleanChatText(d.content, 600)}`).join('\n');
      const user = `${youLine()}\n\n${fenceBlock(body)}\n\nReturn only the JSON object described in the instructions.`;
      const call = await clerkCall('mind.weekly', WEEKLY_PROMPT, user, { nk, ref: `weekly:run:${runId ?? '-'}`,
        input: { chatJid, purpose: 'weekly', start: win.start, dailies: win.dailies.map(d => d.id) } });
      if (!call.ok) { results.push({ chatJid, outcome: call.status }); continue; }
      const v = validateWeekly(call.text);
      if (!v.ok) {
        store.finishRun(call.runRow, { status: 'invalid', error: v.error, dropped: v.dropped, ...call.usage });
        results.push({ chatJid, outcome: 'invalid' });
        continue;
      }
      const evidence = new Map();
      for (const d of win.dailies) for (const id of d.evidence || []) if (typeof id === 'string') evidence.set(id, { msgId: id, ts: null });
      const learned = win.dailies.map(d => Number(d.learnedAt)).filter(fin);
      let r;
      try {
        r = deps.addMemory({ category: 'episode', attribute: `week:${win.start}`, originKind: isGroupJid(chatJid) ? 'group' : 'dm',
          originJid: chatJid, subjectJid: null, content: v.value.episode, importance: 0.5, source: 'mind.weekly',
          expiresInDays: 365, replaces: win.dailies.map(d => d.id), evidence: [...evidence.values()],
          ...(learned.length ? { learnedAt: Math.min(...learned) } : {}) });
      } catch (err) {
        store.finishRun(call.runRow, { status: 'failed', error: errCode(err), ...call.usage });
        results.push({ chatJid, outcome: 'failed' });
        continue;
      }
      const ok = r?.id != null && !r.refused;
      store.finishRun(call.runRow, { status: 'ok', output: { weeklyId: ok ? r.id : null, refused: r?.refused ?? null,
        dailies: win.dailies.length, evidence: evidence.size }, dropped: v.dropped, ...call.usage });
      if (ok) weeklies++;
      results.push({ chatJid, outcome: ok ? 'written' : `refused_${r?.refused || 'unknown'}`, start: win.start });
    } catch (err) {
      warn('weekly', err);
      results.push({ chatJid, outcome: 'failed' });
    }
  }
  store.patchState({ lastWeeklyAt: t });
  return { weeklies, results };
}

// ── step 2c: how things stand ────────────────────────────────────────────────

/** One clerk call for the story's note on a fictional member, counted under the mind's clerk cap. Fictional lines only, never a chat. */
async function standingCall(system, user, nk, runId, meta = {}) {
  const call = await clerkCall('mind.standing', system, user, { nk, ref: `standing:run:${runId ?? '-'}`,
    input: { purpose: 'standing', castId: meta.castId ?? null, attempt: meta.attempt ?? 0 } });
  if (!call.ok) return { ok: false, skipped: call.status === 'skipped' };
  store.finishRun(call.runRow, { status: 'ok', ...call.usage });
  return { ok: true, text: call.text, model: call.usage.model, fellBack: call.usage.fellBack };
}

// ── step 3: reflection ───────────────────────────────────────────────────────

const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,40}$/;

async function selfLifeEvents(t) {
  try {
    const life = await deps.life();
    if (!life || typeof life.listEvents !== 'function') return [];
    if (typeof life.isLifeOn === 'function' && !life.isLifeOn()) return [];
    // 010: only 009 types, so a busy story day (daily pass, drift, beats) can't crowd them out of the 50.
    const types = typeof life.selfEventTypes === 'function' ? life.selfEventTypes() : null;
    const list = life.listEvents({ from: t - DAY, to: t, order: 'asc', limit: 50, ...(Array.isArray(types) && types.length ? { types } : {}) }) || [];
    return list.filter(e => e && e.originKind === 'self' && (!fin(e.at) || (e.at >= t - DAY && e.at <= t))
      && typeof e.type === 'string' && EVENT_TYPE_RE.test(e.type)).map(e => e.type).slice(0, 30);
  } catch { return []; }
}

/** The night's reflection input entries: one per chat with a current day:<nk> episode. */
function reflectionEntries(chats, nk) {
  const out = [];
  for (const chatJid of chats) {
    if (out.length >= MAX_EPISODE_CHATS) break;
    const ep = (deps.episodesFor(chatJid, { attributes: [`day:${nk}`], current: true }) || [])[0];
    if (!ep) continue;
    const d = store.latestDigest(chatJid);
    const floor = [Number(ep.learnedAt), fin(d?.periodStart) ? d.periodStart : NaN].filter(fin);
    out.push({ chatJid, kind: isGroupJid(chatJid) ? 'group' : 'dm', episodeId: ep.id, episode: ep.content,
      digestId: d?.id ?? null, threads: Array.isArray(d?.threads) ? d.threads : [], name: chatName(chatJid),
      minLearnedAt: floor.length ? Math.min(...floor) : 0 });
  }
  return out;
}

function stateSummary(t) {
  const out = [];
  try {
    const els = store.activeElements(t);
    const mood = els.find(e => e.kind === 'mood' && !(e.basis || []).some(b => b?.stage)) || els.find(e => e.kind === 'base_mood');
    if (mood?.word) out.push(`mood now: ${mood.word}`);
    const ints = els.filter(e => e.kind === 'intention').map(e => e.intentionKind).filter(Boolean);
    if (ints.length) out.push(`intentions: ${[...new Set(ints)].join(', ')}`);
  } catch { /* */ }
  try {
    const counts = {};
    for (const n of store.listNudges({ limit: 50 })) {
      if (!fin(n.createdAt) || n.createdAt < t - 2 * DAY) continue;
      const k = `${n.knob} ${n.status}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    const s = Object.entries(counts).map(([k, n]) => `${k} ×${n}`);
    if (s.length) out.push(`recent nudges: ${s.join('; ')}`);
  } catch { /* */ }
  return out;
}

function reflectionUser(labelMap, entries, events, t) {
  const sections = labelsOf(labelMap).map((label) => {
    const e = entries.find(x => x.chatJid === labelMap[label].chatJid);
    const lines = [`${label} (${e.kind === 'group' ? 'group' : 'one-to-one'}) "${cleanChatText(e.name, 60)}"`,
      `${label}.e: ${cleanChatText(e.episode, 600)}`];
    for (const th of e.threads) {
      const k = Number(th?.k);
      if (Number.isInteger(k) && k >= 1 && k <= 3 && typeof th.text === 'string') lines.push(`${label}.t${k}: ${cleanChatText(th.text, 100)}`);
    }
    return lines.join('\n');
  });
  const own = [events.length ? `Your own life today (event types): ${events.join(', ')}` : 'Your own life today: nothing recorded.',
    ...stateSummary(t)];
  return `${youLine()}

${sections.length ? fenceBlock(sections.join('\n\n')) : 'No chat left a memory today.'}

${own.join('\n')}

Return only the JSON object described in the instructions.`;
}

/**
 * The reflection for night nk. → { status: 'ok'|'skipped'|'nothing_new'|'failed'|'invalid',
 *   partial?, skipReason?, usage?, output?, dropped?, selfModelAllowed }
 */
export async function reflect(nk, runId, { chats = [] } = {}) {
  const t = nowSec();
  const entries = reflectionEntries(chats, nk);
  const labelMap = buildLabelMap(entries.map(e => ({ chatJid: e.chatJid, kind: e.kind, digestId: e.digestId,
    threads: e.threads, episodeId: e.episodeId, name: e.name })));
  const events = await selfLifeEvents(t);
  const inputInfo = { labels: labelMapForInput(labelMap), events: events.length };
  if (!entries.length && !events.length) return { status: 'nothing_new', selfModelAllowed: true, input: inputInfo };

  const budget = await deps.budgetOk('sleep');
  if (!budget?.ok) {
    const reason = SKIP_REASON[budget?.reason] || 'budget';
    return { status: 'skipped', skipReason: reason, partial: PARTIAL_OF[reason] || 'budget', selfModelAllowed: false, input: inputInfo };
  }
  const effort = typeof config.mind?.sleepEffort === 'string' && config.mind.sleepEffort ? config.mind.sleepEffort : null;
  const res = await deps.callRole('mind', SLEEP_CHARTER, reflectionUser(labelMap, entries, events, t),
    { caller: 'mind.sleep', maxTokens: 8000, ...(effort ? { effort } : {}) });
  const usage = usageOf(res);
  if (res?.skipped) {
    const reason = SKIP_REASON[res.skipped] || 'error';
    return { status: 'skipped', skipReason: reason, partial: PARTIAL_OF[reason] || 'no_key', usage, selfModelAllowed: false,
      input: inputInfo };
  }
  if (!res || res.status !== 'ok' || typeof res.text !== 'string' || !res.text) {
    return { status: 'failed', error: String(res?.status || 'no_text').slice(0, 60), usage, selfModelAllowed: false, input: inputInfo };
  }
  const ss = await deps.selfState();
  const v = validateSleep(res.text, { labelMap, basisAllowed: ss?.basisAllowed });
  if (!v.ok) return { status: 'invalid', error: v.error, dropped: v.dropped, usage, selfModelAllowed: false, input: inputInfo };

  const fellBack = usage.fellBack;
  const output = { morningMood: null, intentions: [], nudges: [], nextThinkInMinutes: v.value.nextThinkInMinutes,
    note: v.value.note, fellBack };
  if (v.value.morningMood && ss?.applyMood) {
    // Origins = every chat in the input, each floored at its episode's / digest's earliest evidence.
    const origins = entries.map(e => ({ originJid: e.chatJid, originKind: e.kind, minLearnedAt: e.minLearnedAt }));
    output.morningMood = ss.applyMood(v.value.morningMood, { labelMap: null, origins, runId, at: t, morning: true });
  }
  if (v.value.intentions.length && ss?.applyIntentions) {
    const r = ss.applyIntentions(v.value.intentions, { runId, at: t, morning: true });
    output.intentions = r?.applied || [];
    if (r?.dropped?.length) v.dropped.push(...r.dropped.map(d => ({ path: `intentions[${d.index}]`, reason: d.reason })));
  }
  if (v.value.nudges.length) {
    const r = deps.applyNudges(v.value.nudges, runId, labelMap, { fellBack });
    output.nudges = (r?.results || []).map(x => ({ knob: x.knob, status: x.status, refuseReason: x.refuseReason ?? null, id: x.id ?? null }));
  }
  if (fin(v.value.nextThinkInMinutes)) {
    const m = Math.min(1440, Math.max(60, v.value.nextThinkInMinutes));
    store.patchState({ nextThinkAt: t + m * 60 });
  }
  return { status: 'ok', partial: fellBack ? 'fell_back' : null, usage, output, dropped: v.dropped, selfModelAllowed: true,
    input: inputInfo };
}

// ── runSleep ─────────────────────────────────────────────────────────────────

/**
 * One consolidation for night `nightKey` (default: the night of now). trigger:
 * 'night'|'catchup'|'owner'. Guard: the night must be absent, `failed` with < 3
 * attempts, or left `running` for over an hour (a crash). Never throws.
 * → { status: 'done'|'partial'|'failed'|'already'|'busy'|'exhausted'|'skipped', nightKey, runId?, … }
 */
export async function runSleep(nightKey = null, trigger = 'night') {
  const t = nowSec();
  const nk = isNightKey(nightKey) ? nightKey : clockNightKey(t);
  let runId = null;
  try {
    if (!deps.isMindOn()) return { status: 'skipped', reason: 'disabled', nightKey: nk };
    const night = store.getNight(nk);
    if (night) {
      if (night.status === 'done' || night.status === 'missed') return { status: 'already', nightKey: nk };
      if ((Number(night.attempts) || 0) >= MAX_ATTEMPTS) return { status: 'exhausted', nightKey: nk };
      if (night.status === 'running' && fin(night.startedAt) && t - night.startedAt < RUNNING_STALE_SEC) {
        return { status: 'busy', nightKey: nk };
      }
    }
    let prevRanges = {};
    try {
      const prev = night?.runId ? store.getRun(night.runId) : null;
      if (prev?.input?.ranges && typeof prev.input.ranges === 'object') prevRanges = { ...prev.input.ranges };
    } catch { prevRanges = {}; }
    const trig = TRIGGERS.has(trigger) ? trigger : 'night';
    runId = store.insertRun({ kind: 'sleep', trigger: trig, nightKey: nk, input: { nightKey: nk, attempt: (night?.attempts || 0) + 1 } });
    store.upsertNight(nk, { status: 'running', startedAt: t, runId, incAttempts: true, finishedAt: null });

    // 1. episodes (+ rebuilds)
    const ranges = prevRanges;
    let chats = [];
    try { chats = [...new Set((await deps.candidateChats(nk, t)) || [])]; } catch { chats = []; }
    const ep = await writeEpisodes(nk, runId, { ranges });
    const rb = await rebuildMissing(nk, runId);
    const persistInput = (extra = {}) => store.finishRun(runId, { input: { nightKey: nk, ranges,
      episodes: ep.written, rebuilt: rb.rebuilt, ...extra } });
    persistInput();

    // 2. weekly
    let wk = null;
    const st = store.getState();
    if (!fin(st.lastWeeklyAt) || t - st.lastWeeklyAt >= WEEKLY_EVERY_SEC) wk = await compressWeekly(nk, runId);

    // 2b. his interests and opinions (plan 020 B): code only, before anything below can stop the night;
    // it never changes the night's status.
    try { await deps.stanceUpdate(nk); } catch (err) { warn('stance', err); }
    // 2c. what he's come across: one bounded call with the sleep budget, proposals wait for the owner.
    try { await deps.stanceFree(nk, reflectionEntries(chats, nk)); } catch (err) { warn('stance_free', err); }

    // 2c. how things stand (plan 020 D2): clerk work, before anything below can stop the night, and it never changes its status.
    try {
      const life = await deps.life();
      if (typeof life?.storyStandingPass === 'function') {
        await life.storyStandingPass({ nightKey: nk, budgetOk: await deps.budgetOk('sleep'), clerkLeft: () => deps.clerkBudgetLeft(),
          call: (system, user, meta) => standingCall(system, user, nk, runId, meta) });
      }
    } catch (err) { warn('standing', err); }

    // 3. reflection
    const refl = await reflect(nk, runId, { chats });
    if (refl.input) persistInput({ labels: refl.input.labels, events: refl.input.events });
    const episodes = (Number(night?.episodes) || 0) + ep.written + rb.rebuilt;
    const summary = { episodes: ep.written, rebuilt: rb.rebuilt, weeklies: wk?.weeklies ?? null,
      outcomes: ep.results.map(r => r.outcome).slice(0, 40) };
    if (refl.status === 'failed' || refl.status === 'invalid') {
      store.upsertNight(nk, { status: 'failed', finishedAt: nowSec(), episodes });
      store.finishRun(runId, { status: refl.status, error: refl.error ?? null, dropped: refl.dropped ?? [], output: summary,
        ...(refl.usage || {}) });
      return { status: 'failed', nightKey: nk, runId, reflection: refl.status, ...summary };
    }

    // 4. self-model (its own due/unchanged/fell-back rules)
    let selfmodelRunId = null;
    let selfModelStatus = null;
    if (refl.selfModelAllowed) {
      try {
        const sm = await deps.selfModel();
        if (sm && typeof sm.runSelfModel === 'function') {
          const smBudget = (await deps.budgetOk('selfmodel'))?.ok === true;
          const r = await sm.runSelfModel(nk, { trigger: trig === 'owner' ? 'owner' : 'night', budgetOk: smBudget });
          selfmodelRunId = r?.runId ?? null;
          selfModelStatus = r?.status ?? null;
        }
      } catch (err) { warn('selfmodel', err); }
    }

    // 4b. the weekly arc pass (spec 010 R15, story-api §3.8): feature-detected,
    // gated by its own rules (budgetOk is mindBudgetOk('sleep')'s object); it never
    // changes the night's status.
    try {
      const life = await deps.life();
      if (typeof life?.storyWeeklyPass === 'function') {
        await life.storyWeeklyPass({ nightKey: nk, trigger: trig, budgetOk: await deps.budgetOk('sleep') });
      }
    } catch (err) { warn('arcs_weekly', err); }

    // 5. done
    const partial = refl.partial ?? null;
    store.upsertNight(nk, { status: 'done', finishedAt: nowSec(), partial, episodes, ...(selfmodelRunId != null ? { selfmodelRunId } : {}) });
    store.patchState({ lastSleepAt: t });
    const status = partial ? 'partial' : 'ok';
    store.finishRun(runId, { status, skipReason: refl.status === 'skipped' ? refl.skipReason : null,
      output: { ...summary, reflection: refl.status, selfModel: selfModelStatus, ...(refl.output || {}) },
      dropped: refl.dropped ?? [], ...(refl.usage || {}) });
    return { status: partial ? 'partial' : 'done', partial, nightKey: nk, runId, reflection: refl.status, selfModel: selfModelStatus,
      selfmodelRunId, ...summary };
  } catch (err) {
    warn('run', err);
    try { store.upsertNight(nk, { status: 'failed', finishedAt: nowSec() }); } catch { /* */ }
    try { if (runId != null) store.finishRun(runId, { status: 'failed', error: errCode(err) }); } catch { /* */ }
    return { status: 'failed', nightKey: nk, runId };
  }
}
