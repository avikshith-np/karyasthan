// Explicit relays (spec 006, R10 / FR-012): "tell the group I'll be late" in a DM.
//
// The only way DM words reach a group. Everything that decides it runs in code
// before generation:
//   1. prefilter (regex) over every buffered message of the DM flush — most turns stop here;
//   2. Jev (src/brain/jev.js): is it a relay request? does it expose someone else or
//      cause harm? Any Jev error → no relay (fail closed);
//   3. code decision: the source is the requester's own words (not forwarded, not
//      quoted); the target is a GROUP (never a DM) the requester is a fresh current
//      member of, named unambiguously; the group isn't muted; per-requester cap.
// A passing request becomes a `relays` row ('pending') and a prompt note for the DM
// reply; the reply confirms by carrying [RELAY_OK] (stripped in contextBuilder).
// confirm() then moves it to 'confirmed' and dispatch() posts it in the target from
// the relay text + persona + the target group's name only (no recall, no DM
// context), inside the target's chat lock, through the gate, honouring DRY_RUN,
// mute, warmup and rate caps. States: pending → confirmed → sent | failed;
// pending → declined | expired (10 min).
//
// Logs carry ids and reasons only, never the relay text.

import { askJev as realAskJev, noul } from './jev.js';
import { callLlm as realCallLlm } from './llm.js';
import { postProcess } from './postProcess.js';
import { evaluateResponse as realEvaluate } from './qualityGate.js';
import { sanitizeWebContent } from './webSearch.js';
import { getDb } from '../memory/db.js';
import { getPerson } from '../memory/peopleStore.js';
import { getGroup } from '../memory/groupStore.js';
import { resolvePerson, isSelfJid } from '../memory/identity.js';
import { groupsOf, isFresh, isCurrentMember, getMembership } from '../memory/membership.js';
import { resolveAudience, recallNicknames } from '../memory/recall.js';
import { countSelfMessagesInWindow, getRecentMessagesForPrompt } from '../memory/messageStore.js';
import { getIdentityText } from '../personality/systemPrompt.js';
import { checkWarmup, recordSent } from '../behavior/warmup.js';
import { checkRateLimit } from '../behavior/rateLimiter.js';
import { isGroupMuted } from '../dashboard/state.js';
import { sendText as realSendText } from '../whatsapp/actions.js';
import { withChatLock as realWithChatLock } from '../whatsapp/events.js';
import { flattenContent } from '../utils/transcript.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export const RELAY_OK = '[RELAY_OK]';
export const RELAY_OK_RE = /\s*\[\s*RELAY_OK\s*\]\s*/gi;
export const RELAY_TTL_SEC = 10 * 60;
const MAX_PER_REQUESTER_HOUR = 5;
const CONTENT_MAX = 500;
const INTENT_MIN = 0.6;
const SENSITIVE_MAX = 0.5;
const HARM_MAX = 0.5;
const JEV_TIMEOUT_MS = 10_000;

let deps = {
  askJev: realAskJev,
  callLlm: realCallLlm,
  evaluateResponse: realEvaluate,
  sendText: realSendText,
  withChatLock: realWithChatLock,
};

/** Test hook: override any of { askJev, callLlm, evaluateResponse, sendText, withChatLock }; null restores. */
export function __setRelayDepsForTest(over) {
  deps = over
    ? { ...deps, ...over }
    : { askJev: realAskJev, callLlm: realCallLlm, evaluateResponse: realEvaluate, sendText: realSendText, withChatLock: realWithChatLock };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Prefilter ────────────────────────────────────────────────────────────────

// A relay verb ("tell", "let … know", "pass it on", Manglish "parayu"/"ariyikku")…
const RELAY_VERB_RE = /\b(?:tell|let\s+(?:them|everyone|every1|all|the\s+(?:group|gang|guys)|\w+)\s+know|inform|pass\s+(?:it|this|that|the\s+message|my\s+message)?\s*(?:on|along)|say\s+(?:to|in)|post\s+(?:in|on|to)|announce|message\s+the|parayu|paranj?ek+u|paranjo|parayane|ariyik+u|ariyich+ek+u|ariyikane)\b/i;
// …aimed at a group-ish target (a group's name is matched separately).
const GROUP_WORD_RE = /\b(?:group|grp|gang|everyone|every1|everybody|all\s+of\s+(?:them|you)|the\s+guys|the\s+boys|the\s+girls|them\s+all|ellarod(?:um|e)?|ellarum|ellarem|groupil|groupile)\b/i;

const normName = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const NAME_STOP = new Set(['group', 'grp', 'gang', 'the', 'team', 'chat', 'club', 'official', 'family', 'friends', 'and', 'with']);

function msgText(m) {
  if (!m || m.isFromSelf) return '';
  if (m.messageType !== 'text' && m.messageType !== 'audio') return '';
  return typeof m.content === 'string' ? m.content : '';
}

/** Cheap code check: could any of these texts be a relay request? */
export function looksLikeRelay(text, groupNames = []) {
  if (!text || text.length > 600 || !RELAY_VERB_RE.test(text)) return false;
  if (GROUP_WORD_RE.test(text)) return true;
  const t = ` ${normName(text)} `;
  return groupNames.some(n => { const g = normName(n); return g && t.includes(` ${g} `); });
}

// ── Target resolution (code) ─────────────────────────────────────────────────

/**
 * Resolve the target among the requester's eligible groups ({ jid, name }).
 * Full-name match, else a distinctive name word unique to one group, else a
 * generic "the group" when the requester has exactly one. Returns
 * { group } | { ambiguous: true } | { none: true }.
 */
export function resolveTarget(text, groups) {
  const t = ` ${normName(text)} `;
  const full = groups.filter(g => { const n = normName(g.name); return n && t.includes(` ${n} `); });
  if (full.length === 1) return { group: full[0] };
  if (full.length > 1) return { ambiguous: true };
  const wordHits = new Set();
  const counts = new Map();
  const words = groups.map(g => [...new Set(normName(g.name).split(' ').filter(w => w.length >= 4 && !NAME_STOP.has(w)))]);
  for (const ws of words) for (const w of ws) counts.set(w, (counts.get(w) || 0) + 1);
  groups.forEach((g, i) => { if (words[i].some(w => counts.get(w) === 1 && t.includes(` ${w} `))) wordHits.add(g); });
  if (wordHits.size === 1) return { group: [...wordHits][0] };
  if (wordHits.size > 1) return { ambiguous: true };
  if (GROUP_WORD_RE.test(text)) return groups.length === 1 ? { group: groups[0] } : (groups.length ? { ambiguous: true } : { none: true });
  return { none: true };
}

function eligibleGroups(requester) {
  return groupsOf(requester)
    .map(({ groupJid }) => groupJid)
    .filter(jid => jid?.endsWith('@g.us') && isFresh(jid) && isCurrentMember(jid, requester))
    .map(jid => ({ jid, name: getGroup(jid)?.name || null }))
    .filter(g => g.name);
}

// The name a relay is credited to: the owner-set real name before the push name
// (which the sender picks themselves).
function displayName(personJid) {
  const p = getPerson(personJid);
  const name = (p?.real_name || p?.push_name || '').trim();
  return sanitizeWebContent(name).replace(RELAY_OK_RE, ' ').slice(0, 40) || 'a friend';
}

// Would crediting the requester by name read as someone else in the target group?
// Their credit name (or its first word) matching another current member's push
// name, real name or a nickname usable there → yes. A push name is self-chosen, so
// without this a member could post "<someone else> says …" in the group. Fails
// closed (two members who really share a name can't relay to that group).
function nameCollides(requester, groupJid) {
  const mine = normName(displayName(requester));
  const forms = new Set([mine, mine.split(' ')[0]].filter(n => n.length >= 2));
  if (!forms.size) return false;
  const members = [...getMembership(groupJid).members.keys()].filter(p => p !== requester && !isSelfJid(p));
  const nicks = recallNicknames(resolveAudience({ chatJid: groupJid }), members);
  for (const p of members) {
    const person = getPerson(p);
    const names = [person?.push_name, person?.real_name, ...(nicks.get(p) || []).map(n => n.nickname)];
    if (names.some(raw => forms.has(normName(raw)))) return true;
  }
  return false;
}

/** Relay text as it may appear in a prompt: markers stripped, quotes flattened, capped. */
function cleanRelayText(text) {
  return sanitizeWebContent(text).replace(RELAY_OK_RE, ' ').replace(/"{3,}/g, '"').replace(/\s+/g, ' ').trim().slice(0, CONTENT_MAX);
}

// Other known people named in the text: the members of the requester's groups by
// name, first name and the nicknames usable in that group.
function namesOtherPeople(text, groups, requester) {
  const t = ` ${normName(text)} `;
  const selfNames = new Set((getPersona().aliases || []).map(normName).concat(normName(getPersona().name)));
  for (const g of groups) {
    const members = [...getMembership(g.jid).members.keys()].filter(p => p !== requester && !isSelfJid(p));
    const nicks = recallNicknames(resolveAudience({ chatJid: g.jid }), members);
    for (const p of members) {
      const person = getPerson(p);
      const names = [person?.push_name, person?.real_name, ...(nicks.get(p) || []).map(n => n.nickname)];
      for (const raw of names) {
        const full = normName(raw);
        if (!full) continue;
        const candidates = [full, full.split(' ')[0]].filter(n => n.length >= 3 && !selfNames.has(n));
        if (candidates.some(n => t.includes(` ${n} `))) return true;
      }
    }
  }
  return false;
}

// ── State ────────────────────────────────────────────────────────────────────

function setState(id, state, extra = {}) {
  const cols = ['state = ?'];
  const vals = [state];
  for (const [k, v] of Object.entries(extra)) {
    if (!['confirmed_at', 'sent_at', 'error'].includes(k)) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  return getDb().prepare(`UPDATE relays SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id).changes;
}

/** Pending relays older than the TTL → expired. Returns the count. */
export function expireStaleRelays(now = nowSec()) {
  try {
    return getDb().prepare(`UPDATE relays SET state = 'expired', error = 'ttl' WHERE state IN ('pending', 'confirmed')
      AND created_at < ?`).run(now - RELAY_TTL_SEC).changes;
  } catch (err) {
    logger.debug({ err: err.message }, 'Relay expiry sweep failed');
    return 0;
  }
}

export function getRelay(id) {
  return getDb().prepare('SELECT * FROM relays WHERE id = ?').get(id) || null;
}

// ── Notes for the DM reply ───────────────────────────────────────────────────

function declineNote(reason) {
  return `RELAY REQUEST — you can NOT pass this on: ${reason}. Tell them briefly, in your own voice. Do not say or imply you will pass it on, and do not write ${RELAY_OK}.`;
}

function pendingNote(requesterName, groupName, content) {
  return `RELAY REQUEST — ${requesterName} asked you to pass this on to the group "${groupName}": "${content}". `
    + `If you're fine passing it on, confirm briefly in your own voice and end your reply with the exact token ${RELAY_OK} `
    + '(it is removed before sending; only then is it passed on). If it is insulting, harmful, or shares something private '
    + `about someone else, do not write the token and tell them you won't pass it on.`;
}

// ── prepare (before generation) ──────────────────────────────────────────────

/**
 * Inspect a DM flush for a relay request. Returns null (nothing relay-like), or
 * { relayId: number|null, promptNotes: string[] } — relayId set only for a pending
 * relay; a declined request still gets a note so the reply doesn't promise it.
 * Never throws.
 * @param {{ sock?: object, chatJid: string, messages: object[] }} args
 */
export async function prepare({ chatJid, messages } = {}) {
  try {
    if (!chatJid || chatJid.endsWith('@g.us') || !Array.isArray(messages) || !messages.length) return null;
    const human = messages.filter(m => msgText(m));
    if (!human.length) return null;
    const requester = resolvePerson(human[human.length - 1].senderJid || chatJid);
    if (!requester || isSelfJid(requester)) return null;
    // Only the requester's own messages in their own DM count.
    const own = human.filter(m => resolvePerson(m.senderJid) === requester);
    if (!own.some(m => RELAY_VERB_RE.test(msgText(m)))) return null;   // the common case: no DB work
    const groups = eligibleGroups(requester);
    const candidate = [...own].reverse().find(m => looksLikeRelay(msgText(m), groups.map(g => g.name)));
    if (!candidate) return null;

    expireStaleRelays();
    const text = msgText(candidate);
    if (candidate.isForwarded || candidate.quotedId) {
      return { relayId: null, promptNotes: [declineNote('you only pass on things people type to you themselves, not forwarded or quoted messages')] };
    }

    // Jev: intent + exposure + harm in one call. Any error → fail closed.
    let answers;
    try {
      const res = await deps.askJev({
        state: { message: cleanRelayText(text) },
        questions: {
          intent: noul('`message` asks the assistant to pass on a message from its sender to a group chat (for example "tell the group I will be late").'),
          sensitive: noul('`message` reveals a private or sensitive fact about a person other than its sender (health, money, relationships, a secret, something said in private).'),
          harm: noul('`message` insults, accuses or mocks someone, asks anyone for money, OTPs, passwords or personal details, or could damage someone\'s reputation.'),
        },
        timeoutMs: JEV_TIMEOUT_MS,
        caller: 'relay.intent',   // `jev` role: metered + budget-checked (spec 007)
      });
      answers = res?.answers || {};
    } catch (err) {
      logger.warn({ err: err.message, chatJid }, 'relay_jev_failed — declining');
      return { relayId: null, promptNotes: [declineNote('passing messages on is unavailable right now')] };
    }
    const p = (k) => (Number.isFinite(answers[k]?.noul) ? answers[k].noul : null);
    const intent = p('intent');
    if (intent == null || intent < INTENT_MIN) return null;   // not a relay — an ordinary DM turn
    const sensitive = p('sensitive');
    const harm = p('harm');
    if (harm == null || harm >= HARM_MAX) {
      logger.info({ evt: 'relay', outcome: 'declined', reason: 'harm', chatJid }, 'Relay declined');
      return { relayId: null, promptNotes: [declineNote("it could hurt or embarrass someone, so you won't")] };
    }

    // Code decision: target group.
    if (!groups.length) {
      return { relayId: null, promptNotes: [declineNote("you can only pass things on to a group you're both in, and right now there isn't one you can post to")] };
    }
    const resolved = resolveTarget(text, groups);
    if (!resolved.group) {
      const names = groups.map(g => `"${cleanRelayText(g.name).slice(0, 40)}"`).join(', ');
      return { relayId: null, promptNotes: [declineNote(resolved.ambiguous
        ? `it's not clear which group they mean — ask which one (${names})`
        : `it's not clear which group they mean — ask them (their groups: ${names})`)] };
    }
    const target = resolved.group;
    if (isGroupMuted(target.jid)) {
      return { relayId: null, promptNotes: [declineNote(`you're not posting in "${cleanRelayText(target.name)}" right now`)] };
    }
    if (nameCollides(requester, target.jid)) {
      logger.info({ evt: 'relay', outcome: 'declined', reason: 'name_collision', chatJid }, 'Relay declined');
      return { relayId: null, promptNotes: [declineNote(`someone else in "${cleanRelayText(target.name)}" goes by the same name, so the group couldn't tell it's from them`)] };
    }
    if ((sensitive == null || sensitive >= SENSITIVE_MAX) && namesOtherPeople(text, groups, requester)) {
      logger.info({ evt: 'relay', outcome: 'declined', reason: 'sensitive_third_party', chatJid }, 'Relay declined');
      return { relayId: null, promptNotes: [declineNote("it shares something private about someone else, so you won't")] };
    }

    const db = getDb();
    const recent = db.prepare(`SELECT COUNT(*) FROM relays WHERE requester_jid = ? AND created_at > ?
      AND state IN ('pending', 'confirmed', 'sent')`).pluck().get(requester, nowSec() - 3600);
    if (recent >= MAX_PER_REQUESTER_HOUR) {
      return { relayId: null, promptNotes: [declineNote("they've asked for a lot of these this hour — maybe later")] };
    }
    // One pending relay per requester: a newer request replaces an unconfirmed one.
    db.prepare(`UPDATE relays SET state = 'declined', error = 'superseded' WHERE requester_jid = ? AND state = 'pending'`).run(requester);
    const content = cleanRelayText(text);
    const id = Number(db.prepare(`INSERT INTO relays (requester_jid, source_dm_jid, target_jid, content, source_msg_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(requester, chatJid, target.jid, content, candidate.id || null, nowSec()).lastInsertRowid);
    logger.info({ evt: 'relay', outcome: 'pending', relayId: id, chatJid, target: target.jid }, 'Relay pending confirmation');
    return { relayId: id, promptNotes: [pendingNote(displayName(requester), cleanRelayText(target.name), content)] };
  } catch (err) {
    logger.warn({ err: err.message, chatJid }, 'Relay prepare failed — no relay');
    return null;
  }
}

// ── confirm (after the DM reply) ─────────────────────────────────────────────

/**
 * Settle a pending relay after the DM turn. Confirmed only when the reply carried
 * [RELAY_OK], was actually sent (sentMessageId, or DRY_RUN) and the turn wasn't
 * stale; otherwise declined. A confirmed relay is dispatched in the background.
 * Returns true when confirmed. Never throws.
 */
export function confirm(relayId, { relayOk = false, sentMessageId = null, stale = false, sock = null } = {}) {
  try {
    const row = relayId ? getRelay(relayId) : null;
    if (!row || row.state !== 'pending') return false;
    if (nowSec() - row.created_at > RELAY_TTL_SEC) { setState(row.id, 'expired', { error: 'ttl' }); return false; }
    const sent = !!sentMessageId || config.dryRun;
    if (!relayOk || !sent || stale) {
      const reason = stale ? 'turn_stale' : !relayOk ? 'not_confirmed' : 'reply_not_sent';
      setState(row.id, 'declined', { error: reason });
      logger.info({ evt: 'relay', outcome: 'declined', reason, relayId: row.id }, 'Relay declined');
      return false;
    }
    setState(row.id, 'confirmed', { confirmed_at: nowSec() });
    logger.info({ evt: 'relay', outcome: 'confirmed', relayId: row.id }, 'Relay confirmed');
    dispatch(row.id, sock).catch(err => logger.warn({ err: err.message, relayId: row.id }, 'Relay dispatch failed'));
    return true;
  } catch (err) {
    logger.warn({ err: err.message, relayId }, 'Relay confirm failed');
    return false;
  }
}

// ── dispatch (in the target chat) ────────────────────────────────────────────

const FAIL_TEXT = {
  muted: "I'm not posting in that group right now, so I didn't pass it on.",
  not_member: "Couldn't pass that on — I can only post it to a group you're in.",
  warmup: "Couldn't pass that on right now — try again a bit later.",
  rate_limited: "That group's been busy with my messages — I didn't pass it on, try again later.",
  declined: "On second thought I didn't pass that one on.",
  gate: "On second thought I didn't pass that one on.",
  error: "Something went wrong and I couldn't pass that on.",
  expired: 'That took too long, so I didn\'t pass it on — ask me again?',
};

async function fail(sock, row, reason, state = 'failed') {
  setState(row.id, state, { error: reason });
  logger.info({ evt: 'relay', outcome: state, reason, relayId: row.id }, 'Relay not sent');
  if (sock && row.source_dm_jid) {
    await deps.sendText(sock, row.source_dm_jid, FAIL_TEXT[reason] || FAIL_TEXT.error).catch(() => {});
  }
  return false;
}

function relayPrompts(row, groupName, requesterName) {
  const group = getGroup(row.target_jid);
  const system = [
    getIdentityText(),
    `\n## Current Group: ${cleanRelayText(groupName)}`,
    group?.language && group.language !== 'en' ? `Language: Mostly ${group.language}. Match this.` : null,
    '\nWrite ONE short WhatsApp message to this group. Plain chat text: no markdown, no quotes around it, no markers.',
  ].filter(Boolean).join('\n');
  const user = `${requesterName} asked you in a private chat to pass this on to the group:\n"${row.content}"\n\n`
    + `Write one short message to the group, in your own voice, that passes it on and credits ${requesterName} by name. `
    + 'Pass on only what they said — add nothing else about them or anyone else, and nothing from any other chat. '
    + 'If passing it on would insult, accuse or expose someone, or ask anyone for money, OTPs, passwords or personal details, reply exactly [SKIP].';
  return { system, user };
}

/**
 * Post a confirmed relay in its target group, inside the target's chat lock.
 * Resolves true when sent (or dry-run logged). Never throws.
 */
export function dispatch(relayId, sock) {
  const row0 = getRelay(relayId);
  if (!row0?.target_jid) return Promise.resolve(false);
  return deps.withChatLock(row0.target_jid, async () => {
    const row = getRelay(relayId);
    if (!row || row.state !== 'confirmed') return false;
    try {
      const target = row.target_jid;
      if (nowSec() - row.created_at > RELAY_TTL_SEC) return fail(sock, row, 'expired', 'expired');
      if (isGroupMuted(target)) return fail(sock, row, 'muted');
      if (!target.endsWith('@g.us') || !isFresh(target) || !isCurrentMember(target, row.requester_jid)) {
        return fail(sock, row, 'not_member');
      }
      const warm = checkWarmup('text');
      if (!warm.allowed || warm.responseType === 'reaction') return fail(sock, row, 'warmup');
      const rl = checkRateLimit(target);
      if (!rl.allowed || countSelfMessagesInWindow(target, nowSec() - 3600) >= config.maxPerGroupHour) {
        return fail(sock, row, 'rate_limited');
      }

      if (nameCollides(row.requester_jid, target)) return fail(sock, row, 'declined');
      const groupName = getGroup(target)?.name || 'the group';
      const requesterName = displayName(row.requester_jid);
      const { system, user } = relayPrompts(row, groupName, requesterName);
      // `mouth` role (spec 007): the text is sent to the target group.
      const raw = await deps.callLlm(system, user, {
        role: 'mouth', caller: 'relay', send: true, msgId: `relay_${row.id}`, groupJid: target,
      });
      const trimmed = (raw || '').trim();
      if (!trimmed || /^\[?SKIP\]?$/i.test(trimmed)) return fail(sock, row, 'declined');
      const processed = postProcess(sanitizeWebContent(trimmed).replace(RELAY_OK_RE, ' '), [], { isGroup: true });
      const text = processed?.text?.trim();
      if (!text) return fail(sock, row, 'declined');

      // Gate with a relay harm note; fails closed on any non-verdict except a
      // deliberately disabled gate.
      const snippet = getRecentMessagesForPrompt(target, 5).filter(m => !m.is_from_self).slice(-5)
        .map(m => `[${m.sender_name || 'Unknown'}]: ${flattenContent(m.content, m.message_type)}`).join('\n');
      const gate = await deps.evaluateResponse(text, snippet, {
        isMention: true,
        relay: true,
        caller: 'relay.gate',     // `gate` role (spec 007)
        harmNote: `This message passes on, in the group, something ${requesterName} asked the bot to tell the group. Score 0.0 if it insults, accuses or exposes anyone, reveals private details, or asks for money, OTPs, passwords or personal details.`,
      });
      const noVerdict = gate?.score == null && gate?.reason !== 'gate_disabled';
      if (!gate?.pass || noVerdict) return fail(sock, row, 'gate');

      const sent = await deps.sendText(sock, target, text);   // DRY_RUN: logged, not sent
      recordSent();
      setState(row.id, 'sent', { sent_at: nowSec(), error: config.dryRun ? 'dry_run' : null });
      logger.info({ evt: 'relay', outcome: 'sent', relayId: row.id, target, msgId: sent?.key?.id || null, dryRun: config.dryRun }, 'Relay sent');
      return true;
    } catch (err) {
      logger.warn({ err: err.message, relayId: row.id }, 'Relay dispatch error');
      return fail(sock, row, 'error');
    }
  }).catch((err) => {
    logger.warn({ err: err.message, relayId }, 'Relay dispatch lock failed');
    return false;
  });
}
